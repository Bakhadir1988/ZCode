import {
  CodexAccountAccessConfig,
  ProviderConfig,
  ProviderConfigMap,
  ZhipuAccountAccessConfig,
  type ModelId,
  type ProviderConfigRule,
  type ProviderId,
} from "./config/index.js";
import type { ProviderModelConfigRuleData } from "./config/rule-data-schema.js";
import type {
  AccountProviderResolveInput,
  AccountProviderResolver,
} from "./account-provider-service.js";
import type {
  AccountProviderState,
  AccountProviderUnavailableReason,
} from "./account-provider-state.js";

export interface CodexAccountRowConfig {
  readonly accountId: string;
  readonly providerId: ProviderId;
  /** Полный runtime-список моделей строки (toggle OFF выражается правилами, не составом). */
  readonly models: readonly ModelId[];
  readonly providerModelRules: readonly ProviderModelConfigRuleData[];
}

export type AccountProviderConnectionResult = {
  /** 账号/组织身份变化后禁止沿用旧快照；仅用于本轮解析，不进入配置。 */
  readonly resetPrevious?: boolean;
  readonly current?: boolean;
  readonly connectionKey?: string;
  readonly effectiveAt?: number;
} & (
  | {
      readonly providerId: ProviderId;
      readonly status: "available" | "pending";
      readonly models?: readonly ModelId[];
      /** per-model 能力覆盖（optionSpecs），随 models 一起由 Account 层下发。 */
      readonly providerModelRules?: readonly ProviderModelConfigRuleData[];
      /** Codex 多账号展开：每个 connected 账号 —独立 provider 行。 */
      readonly codexAccountRows?: readonly CodexAccountRowConfig[];
    }
  | {
      readonly providerId: ProviderId;
      readonly status: "unavailable" | "unknown";
      /** 仅在 status === "unavailable" 时携带；unknown 表示本轮无法判定原因。 */
      readonly unavailableReason?: AccountProviderUnavailableReason;
    }
);

export interface ResolveAccountProviderConfigsInput {
  readonly configuredProviders: ProviderConfigMap;
  readonly previousProviders: ProviderConfigMap;
  readonly connections: readonly AccountProviderConnectionResult[];
}

export type AccountProviderConnectionResolver = (
  input: Omit<AccountProviderResolveInput, "previousProviders">,
) => Promise<readonly AccountProviderConnectionResult[]>;

export function createAccountProviderConfigResolver(
  resolveConnections: AccountProviderConnectionResolver,
): AccountProviderResolver {
  return async (input) => {
    const connections = await resolveConnections({
      configRevision: input.configRevision,
      configuredProviders: input.configuredProviders,
      reasons: input.reasons ?? [],
    });
    const providers = resolveAccountProviderConfigs({
      configuredProviders: input.configuredProviders,
      previousProviders: input.previousProviders,
      connections,
    });
  const providerModelRules = collectAccountProviderModelRules(connections);
  const states: Record<string, AccountProviderState> = {};
  const putState = (
    providerId: string,
    connection: AccountProviderConnectionResult,
    overrides?: {
      readonly availability?: AccountProviderState["availability"];
      readonly entitled?: boolean;
      readonly unavailableReason?: AccountProviderUnavailableReason;
      readonly current?: boolean;
      readonly connectionKey?: string;
    },
  ): void => {
    const previous = connection.resetPrevious
      ? undefined
      : input.previousStates?.[providerId];
    const access = providers.get(providerId)?.access;
    const unavailableReason =
      overrides?.unavailableReason !== undefined
        ? overrides.unavailableReason
        : connection.status === "unknown" && previous
          ? previous.unavailableReason
          : connection.status === "unavailable"
            ? connection.unavailableReason
            : undefined;
    states[providerId] = Object.freeze({
      ...(connection.status === "unknown" ? previous : {}),
      availability:
        overrides?.availability ??
        (connection.status === "unknown" && previous ? previous.availability : connection.status),
      entitled:
        overrides?.entitled ??
        (access?.type === "zhipu-account"
          ? access.entitled === true
          : access?.type === "codex-account"
            ? access.connected === true
            : false),
      ...(unavailableReason === undefined ? {} : { unavailableReason }),
      ...(connection.current === undefined && overrides?.current === undefined
        ? {}
        : { current: overrides?.current ?? connection.current }),
      connectionKey: overrides?.connectionKey ?? connection.connectionKey,
      ...(connection.effectiveAt === undefined ? {} : { effectiveAt: connection.effectiveAt }),
    });
  };
  for (const connection of connections) {
    putState(connection.providerId, connection);
    // Codex 按账号行展开为独立执行目标；各行 current=true，但 kind=ordinary
    // 不触发 effective-selection 重路由，可见性由 executable 决定。
    if (connection.status === "available" || connection.status === "pending") {
      for (const row of connection.codexAccountRows ?? []) {
        putState(row.providerId, connection, {
          availability: connection.status,
          entitled: true,
          current: true,
          connectionKey: row.accountId,
        });
      }
    }
  }
    return Object.freeze({
      providers,
      states: Object.freeze(states),
      ...(providerModelRules ? { providerModelRules } : {}),
    });
  };
}

function collectAccountProviderModelRules(
  connections: readonly AccountProviderConnectionResult[],
): readonly ProviderModelConfigRuleData[] | undefined {
  const rules = connections.flatMap((connection) => {
    if (connection.status !== "available" && connection.status !== "pending") return [];
    return [
      ...(connection.providerModelRules ?? []),
      ...(connection.codexAccountRows ?? []).flatMap((row) => row.providerModelRules),
    ];
  });
  return rules.length > 0 ? rules : undefined;
}

/** 把账号连接结果转换为 Registry 使用的第三层 Account Provider Config。 */
export function resolveAccountProviderConfigs(
  input: ResolveAccountProviderConfigsInput,
): ProviderConfigMap {
  const connectionByProviderId = indexConnections(input.configuredProviders, input.connections);
  const resolved: Array<ProviderConfigRule | readonly [ProviderId, ProviderConfig]> = [];
  for (const [providerId, configured] of input.configuredProviders.entries()) {
    const access = configured.access;
    if (access?.type === "codex-account") {
      const connection = connectionByProviderId.get(providerId) ?? {
        providerId,
        status: "unknown" as const,
      };
      // Base 行只做家族聚合（无模型、永不 executable）；执行目标按账号行展开。
      resolved.push([
        providerId,
        new ProviderConfig({
          access: new CodexAccountAccessConfig({ connected: connection.status === "available" }),
        }),
      ]);
      if (connection.status === "available" || connection.status === "pending") {
        for (const row of connection.codexAccountRows ?? []) {
          resolved.push({
            providerId: row.providerId,
            // Account Overlay 只携带本层事实：连接状态 + 模型成员。api/logo/group/providerName
            // 是家族 base 行的 Built-in 身份，由 ProviderConfigResolver 在解析期继承；
            // 拷贝进 overlay 会违反 Account Schema（wire 层整包拒绝），并绕开 Built-in 对
            // Provider 身份的唯一所有权。
            config: new ProviderConfig({
              access: new CodexAccountAccessConfig({ connected: true }),
              builtinModelIds: normalizeModelIds(row.models),
            }),
          });
        }
      }
      continue;
    }
    if (access?.type !== "zhipu-account") continue;
    const connection = connectionByProviderId.get(providerId) ?? {
      providerId,
      status: "unknown" as const,
    };

    if (connection.status === "available" || connection.status === "pending") {
      if (access.mode === "start-plan") {
        const models = normalizeModelIds(connection.models);
        resolved.push([
          providerId,
          new ProviderConfig({
            // 明确空模型是本轮权威结果，不能保留已经失效的旧白名单。
            access: new ZhipuAccountAccessConfig({ entitled: connection.status === "available" }),
            builtinModelIds: models,
          }),
        ]);
        continue;
      }
      resolved.push([
        providerId,
        new ProviderConfig({
          access: new ZhipuAccountAccessConfig({ entitled: connection.status === "available" }),
        }),
      ]);
      continue;
    }

    if (connection.status === "unavailable") {
      resolved.push([providerId, createEntitlementOverlay(false)]);
      continue;
    }

    const previous = connection.resetPrevious ? undefined : input.previousProviders.get(providerId);
    if (previous) {
      resolved.push([providerId, previous]);
    } else {
      resolved.push([providerId, createEntitlementOverlay(false)]);
    }
  }

  return new ProviderConfigMap(resolved);
}

function createEntitlementOverlay(entitled: boolean): ProviderConfig {
  return new ProviderConfig({ access: new ZhipuAccountAccessConfig({ entitled }) });
}

function indexConnections(
  configuredProviders: ProviderConfigMap,
  connections: readonly AccountProviderConnectionResult[],
): ReadonlyMap<ProviderId, AccountProviderConnectionResult> {
  const result = new Map<ProviderId, AccountProviderConnectionResult>();
  for (const connection of connections) {
    if (result.has(connection.providerId)) {
      throw new Error(`重复 Account Provider 连接结果: ${connection.providerId}`);
    }
    const configured = configuredProviders.get(connection.providerId);
    if (!configured) {
      throw new Error(`Account 连接指向未配置 Provider: ${connection.providerId}`);
    }
    if (!isAccountConstrainedProvider(configured)) {
      throw new Error(`Account 连接指向非 Account Provider: ${connection.providerId}`);
    }
    result.set(connection.providerId, connection);
  }
  return result;
}

function isAccountConstrainedProvider(config: ProviderConfig): boolean {
  return (
    config.access?.type === "zhipu-account" || config.access?.type === "codex-account"
  );
}

function normalizeModelIds(values: readonly ModelId[] | null | undefined): readonly ModelId[] {
  const result: ModelId[] = [];
  for (const value of values ?? []) {
    const modelId = value.trim();
    if (!modelId) continue;
    result.push(modelId);
  }
  return Object.freeze(result);
}
