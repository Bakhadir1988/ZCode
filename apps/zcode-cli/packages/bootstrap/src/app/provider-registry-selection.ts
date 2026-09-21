import { ModelErrorCode, ModelProtocolError } from "@zcode/contracts";
import {
  normalizeModelSelection,
  type ModelSelection,
  type Provider,
  type ProviderModel,
} from "@zcode/provider";
import {
  CODEX_BASE_PROVIDER_ID,
  parseCodexProviderAccountId,
  type ZCodeModelOption,
} from "@zcode/shared";
import type { ProviderRegistryModelSource } from "./provider-registry-model-runtime.js";

export interface ResolvedRegistrySelection {
  readonly provider: Provider;
  readonly model: ProviderModel;
  readonly selection: ModelSelection;
}

/**
 * Registry 是模型选择的正式候选来源。当前 Turn 临时携带的 Provider 属于执行输入，
 * 不进入模型选择列表。
 */
export function listRegistryBackedModels(
  registry: ProviderRegistryModelSource,
): ZCodeModelOption[] {
  const view = registry.getView();
  return view.providers.flatMap((provider) =>
    provider.models.map((model) => toModelOption(provider, model)),
  );
}

export function getRegistryBackedModel(
  registry: ProviderRegistryModelSource,
  selection: ModelSelection,
): ZCodeModelOption | undefined {
  const provider = registry.getProvider(selection.providerId);
  const model = registry.getModel(selection.providerId, selection.modelId);
  return provider && model ? toModelOption(provider, model) : undefined;
}

/**
 * 为连通性等辅助调用补齐最低推理档位。Factory 只接受完整执行选择，
 * 因而必须在创建 Model 之前完成，不能等 Model 创建后再 bind。
 */
export function completeAuxiliaryRegistryModelSelection(
  registry: ProviderRegistryModelSource,
  selection: ModelSelection,
): ModelSelection {
  const model = registry.getModel(selection.providerId, selection.modelId);
  const reasoningLevel = model?.config.optionSpecs.reasoningLevel.values[0];
  if (!reasoningLevel) return selection;
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    options: {
      ...selection.options,
      reasoningLevel,
    },
  };
}

export function resolveRegistryOwnedSelection(
  registry: ProviderRegistryModelSource,
  requested: string,
  configuredDefault?: ModelSelection,
  options?: { allowMissingReasoning?: boolean },
): ResolvedRegistrySelection | undefined {
  const parsed = parseRequestedModelSelection(requested, configuredDefault);
  const selection =
    parsed && requested.trim() !== "main"
      ? normalizeModelSelection(registry.getView(), parsed)
      : parsed;
  return selection ? resolveRegistryOwnedModelSelection(registry, selection, options) : undefined;
}

function parseRequestedModelSelection(
  requested: string,
  configuredDefault?: ModelSelection,
): ModelSelection | undefined {
  const normalized = requested.trim();
  if (normalized === "main") return configuredDefault;
  return parseProviderQualifiedModelSelection(normalized);
}

export function parseProviderQualifiedModelSelection(
  requested: string,
): ModelSelection | undefined {
  const normalized = requested.trim();
  const separator = normalized.indexOf("/");
  if (separator <= 0 || separator === normalized.length - 1) return undefined;
  const providerId = normalized.slice(0, separator).trim();
  const modelId = normalized.slice(separator + 1).trim();
  return providerId && modelId ? { providerId, modelId } : undefined;
}

/**
 * 解析由 Registry 已接管 Provider 的模型选择。
 *
 * 返回 undefined 表示进程 Registry 不拥有该 Provider。Registry 已拥有 Provider 时，
 * 缺失 Model 必须直接报错；调用方不能再回退 Turn Overlay 或临时 Provider 快照。
 */
export function resolveRegistryOwnedModelSelection(
  registry: ProviderRegistryModelSource,
  selection: ModelSelection,
  options?: { allowMissingReasoning?: boolean },
): ResolvedRegistrySelection | undefined {
  const validation = registry.validateSelection(selection);
  if (!validation.ok) {
    if (validation.code === "provider-not-found") return undefined;
    if (validation.code === "reasoning-level-missing" && options?.allowMissingReasoning) {
      return resolveRegistryModelSelection(registry, selection);
    }
    throw createRegistrySelectionProtocolError(validation);
  }
  const resolved = resolveRegistryModelSelection(registry, selection);
  if (!resolved) throw new Error("Registry Selection 校验与索引结果不一致");
  return resolved;
}

/** Registry 选择校验失败到稳定 Model 协议错误的唯一映射。 */
export function createRegistrySelectionProtocolError(
  validation: Exclude<ReturnType<ProviderRegistryModelSource["validateSelection"]>, { ok: true }>,
): ModelProtocolError {
  switch (validation.code) {
    case "provider-not-found":
      return new ModelProtocolError(
        ModelErrorCode.ProviderNotFound,
        `Provider Registry 中不存在 Provider: ${validation.providerId}`,
      );
    case "model-not-found":
      return new ModelProtocolError(
        ModelErrorCode.ModelNotFound,
        `Provider Registry 中不存在 Model: ${validation.providerId}/${validation.modelId}`,
      );
    case "reasoning-level-missing":
      return new ModelProtocolError(
        ModelErrorCode.InvalidModelRequest,
        `Reasoning level is required for ${validation.providerId}/${validation.modelId}`,
      );
    case "reasoning-level-not-supported":
      return new ModelProtocolError(
        ModelErrorCode.InvalidModelRequest,
        `Reasoning effort "${validation.reasoningLevel}" is not supported by ${validation.providerId}/${validation.modelId}`,
      );
  }
}

/**
 * Codex 多账号后 base 行（account:openai-codex）只是家族聚合，不再进入 Registry；
 * 旧会话保存的 base 选择必须在严格校验之前重映射到 active 账号行，否则选择永远
 * 无法绑定，执行层的 base→active 回退也永远不可达。
 *
 * modelId 在目标行缺失时取行内首个模型；reasoning 档位仅在目标行支持时保留，
 * 不支持时直接丢弃（与 providerFacadeServices 的 configured-default remap 同语义），
 * 不人为挑最高/最低档——目标行不携带模型的 defaultReasoningEffort，强制选档只会
 * 把恢复的会话悄悄绑到最贵 effort。缺档位选择走既有 reasoning-level-missing →
 * unbound 恢复路径。非 base 选择与无可用账号行时原样返回，交给既有的
 * unbound / stale-selection 流程（可恢复，不抛错）。
 */
export function remapLegacyCodexProviderSelection(
  registry: ProviderRegistryModelSource,
  selection: ModelSelection,
  activeAccountId: string | null,
): ModelSelection {
  if (selection.providerId !== CODEX_BASE_PROVIDER_ID) return selection;
  const rows = registry
    .getView()
    .providers.filter((provider) => parseCodexProviderAccountId(provider.providerId) !== null);
  const row = activeAccountId
    ? (rows.find((provider) => parseCodexProviderAccountId(provider.providerId) === activeAccountId) ??
      rows[0])
    : rows[0];
  const model = row && (row.models.find((item) => item.modelId === selection.modelId) ?? row.models[0]);
  if (!row || !model) return selection;
  const requestedLevel = selection.options?.reasoningLevel;
  const supportedLevels = model.config.optionSpecs.reasoningLevel.values;
  const keepLevel = requestedLevel !== undefined && supportedLevels.includes(requestedLevel);
  return {
    providerId: row.providerId,
    modelId: model.modelId,
    ...(keepLevel ? { options: { ...selection.options } } : {}),
  };
}

export function resolveRegistryModelSelection(
  registry: ProviderRegistryModelSource,
  selection: ModelSelection,
): ResolvedRegistrySelection | undefined {
  const provider = registry.getProvider(selection.providerId);
  const model = registry.getModel(selection.providerId, selection.modelId);
  if (!provider || !model) return undefined;
  return {
    provider,
    model,
    selection: {
      providerId: selection.providerId,
      modelId: selection.modelId,
      ...(selection.options ? { options: { ...selection.options } } : {}),
    },
  };
}

export function resolveRegistryThoughtLevel(
  selection: ResolvedRegistrySelection | undefined,
  requested?: string,
): string | undefined {
  const spec = selection?.model.config.optionSpecs.reasoningLevel;
  if (!spec) return undefined;
  return requested && spec.values.includes(requested) ? requested : undefined;
}

export function requireRegistryThoughtLevel(
  selection: ResolvedRegistrySelection,
  requested: string,
): string {
  const spec = selection.model.config.optionSpecs.reasoningLevel;
  if (!spec.values.includes(requested)) {
    throw new Error(`Unsupported reasoning effort: ${requested}`);
  }
  return requested;
}

function toModelOption(provider: Provider, model: ProviderModel): ZCodeModelOption {
  const properties = model.config.properties;
  const optionSpecs = model.config.optionSpecs;
  const reasoning = optionSpecs.reasoningLevel;
  return {
    ref: { providerId: provider.providerId, modelId: model.modelId },
    label: model.modelId,
    providerLabel: provider.providerName ?? provider.providerId,
    contextWindow: properties.contextWindow,
    maxOutputTokens: optionSpecs.maxOutputTokens.max,
    reasoning: {
      levels: reasoning.values.map((level) => ({ value: level, label: level })),
      defaultLevel: reasoning.values.at(-1),
    },
    properties: {
      inputFormat: properties.inputFormat,
      outputFormat: properties.outputFormat,
    },
  };
}
