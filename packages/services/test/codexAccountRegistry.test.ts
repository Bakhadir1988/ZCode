import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexAccountAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigResolver,
  ProviderRegistry,
  parseAccountProviderConfigMap,
  parseAccountProviderModelRules,
  parseZCodeBuiltinModelConfigRules,
  resolveAccountProviderConfigs,
  type ModelSelection,
  type Provider,
} from "@zcode/provider";
import { CODEX_BASE_PROVIDER_ID, createCodexAccountProviderId } from "@zcode/shared";

const BASE_ID = CODEX_BASE_PROVIDER_ID;
const ROW_A = createCodexAccountProviderId("account-a");
const ROW_B = createCodexAccountProviderId("account-b");
const MODELS = ["gpt-6-astra", "gpt-5.6-sol"] as const;

/** 与 zcode-builtin.json 中 account:openai-codex 规则同构的最小 Built-in 家族 base 行。 */
function builtinProviders(): ProviderConfigMap {
  return new ProviderConfigMap([
    {
      providerId: BASE_ID,
      providerName: "OpenAI Codex",
      config: new ProviderConfig({
        group: "codex-family",
        logo: { type: "builtin", key: "openai" },
        access: new CodexAccountAccessConfig({ connected: false }),
        api: new ProviderApiConfig({ type: "codex-app-server", baseUrl: "app-server://codex" }),
        builtinModelIds: [],
      }),
    },
  ]);
}

function builtinModelRules() {
  return parseZCodeBuiltinModelConfigRules({
    modelRules: [
      {
        modelMatch: "gpt-.*",
        config: {
          enabled: true,
          properties: {
            requiresMfjsToolSchema: false,
            contextWindow: 400000,
            inputFormat: {
              supportsText: true,
              supportsImage: true,
              supportsVideo: false,
              supportsAudio: false,
              supportsPdf: true,
            },
            outputFormat: { supportsText: true },
            supportsToolCall: true,
            supportsJsonSchemaOutput: true,
            supportsNativeWebSearch: false,
            supportsMidConversationSystem: true,
          },
          optionSpecs: {
            reasoningLevel: { values: ["low", "medium", "high"], map: "{}" },
            maxOutputTokens: { max: 128000, map: "{}" },
          },
        },
      },
    ],
    modelApiRules: [],
    providerSiteRules: [],
    templateModelRules: [],
    builtinProviderModelRules: [],
  });
}

function accountModelRules(rows: { providerId: string; disabled: string[] }[]) {
  const rules = rows.flatMap((row) =>
    MODELS.map((modelId) => ({
      providerId: row.providerId,
      modelId,
      config: {
        enabled: !row.disabled.includes(modelId),
        optionSpecs: { reasoningLevel: { values: ["low", "high"], map: "{}" } },
      },
    })),
  );
  return { rules: parseAccountProviderModelRules(rules), data: rules };
}

/** 走完 Host 生成 → wire 校验 → Resolver 解析的完整链路（与生产同一代码路径）。 */
function resolveRegistry(rows: { providerId: string; disabled: string[] }[]) {
  const configured = new ProviderConfigMap([
    [BASE_ID, new ProviderConfig({ access: new CodexAccountAccessConfig({ connected: false }) })],
  ]);
  const accountSnapshot = resolveAccountProviderConfigs({
    configuredProviders: configured,
    previousProviders: ProviderConfigMap.empty(),
    connections: [
      {
        providerId: BASE_ID,
        status: "available",
        codexAccountRows: rows.map((row) => ({
          accountId: row.providerId.slice(BASE_ID.length + 1),
          providerId: row.providerId,
          models: MODELS,
          providerModelRules: accountModelRules(rows).data.filter(
            (rule) => rule.providerId === row.providerId,
          ),
        })),
      },
    ],
  });
  // Host → CLI 的 providerUpdateAccountConfig 投影必须先过 strict Account Schema。
  const wire = Object.fromEntries(
    [...accountSnapshot.entries()].map(([providerId, config]) => [providerId, config.toJSON()]),
  );
  const parsed = parseAccountProviderConfigMap(wire);
  const rules = accountModelRules(rows).rules;
  const resolution = new ProviderConfigResolver().resolve({
    zcodeBuiltinProviders: builtinProviders(),
    personalProviders: ProviderConfigMap.empty(),
    zcodeBuiltinModelRules: builtinModelRules(),
    personalModels: builtinModelRules(),
    accountProviders: parsed,
    accountStates: Object.fromEntries(
      rows.map((row) => [
        row.providerId,
        {
          availability: "available" as const,
          entitled: true,
          current: true,
          connectionKey: row.providerId.slice(BASE_ID.length + 1),
        },
      ]),
    ),
    accountModels: rules,
  });
  return resolution;
}

function toRegistry(resolution: ReturnType<typeof resolveRegistry>): ProviderRegistry {
  const providers: Provider[] = resolution.registryProviders.map((provider) =>
    Object.freeze({
      providerId: provider.providerId,
      providerName: provider.providerName,
      templateId: provider.templateId,
      config: provider.config,
      models: provider.models,
    }),
  );
  return new ProviderRegistry(providers);
}

test("two connected accounts resolve into executable registry rows with inherited family identity", () => {
  const resolution = resolveRegistry([
    { providerId: ROW_A, disabled: [] },
    { providerId: ROW_B, disabled: [] },
  ]);
  const codexIssues = resolution.issues.filter((issue) =>
    issue.path[1]?.startsWith("account:openai-codex"),
  );
  assert.deepEqual(codexIssues, []);

  const ids = resolution.registryProviders.map((provider) => provider.providerId);
  assert.ok(ids.includes(ROW_A), "account A row must be executable");
  assert.ok(ids.includes(ROW_B), "account B row must be executable");
  assert.ok(!ids.includes(BASE_ID), "family base row stays an aggregation row without models");

  const rowA = resolution.registryProviders.find((provider) => provider.providerId === ROW_A)!;
  // api/logo/group/providerName 从 Built-in base 行继承，而不是拷贝进 Account Overlay。
  assert.equal(rowA.providerName, "OpenAI Codex");
  assert.equal(rowA.config.api?.type, "codex-app-server");
  assert.equal(rowA.config.logo?.key, "openai");
  assert.equal(rowA.config.group, "codex-family");
  assert.equal(rowA.config.access?.type, "codex-account");
  assert.deepEqual(rowA.models.map((model) => model.modelId), [...MODELS]);
});

test("same model on two accounts stays two distinct execution targets", () => {
  const registry = toRegistry(
    resolveRegistry([
      { providerId: ROW_A, disabled: [] },
      { providerId: ROW_B, disabled: [] },
    ]),
  );
  const selection: ModelSelection = {
    providerId: ROW_A,
    modelId: "gpt-6-astra",
    options: { reasoningLevel: "high" },
  };
  assert.ok(registry.validateSelection(selection).ok, "account A target must validate");
  const selectionB: ModelSelection = { ...selection, providerId: ROW_B };
  assert.ok(registry.validateSelection(selectionB).ok, "account B target must validate");
  // accountId + modelId：同名模型在两行下是两个独立可执行事实。
  assert.notEqual(
    registry.getModel(ROW_A, "gpt-6-astra"),
    registry.getModel(ROW_B, "gpt-6-astra"),
  );
});

test("per-account model toggle hides the model only for that account", () => {
  const registry = toRegistry(
    resolveRegistry([
      { providerId: ROW_A, disabled: ["gpt-5.6-sol"] },
      { providerId: ROW_B, disabled: [] },
    ]),
  );
  assert.equal(registry.getModel(ROW_A, "gpt-5.6-sol"), undefined, "OFF model must leave the picker");
  assert.ok(registry.getModel(ROW_A, "gpt-6-astra"), "remaining enabled models stay executable");
  assert.ok(registry.getModel(ROW_B, "gpt-5.6-sol"), "other account keeps the same model ON");
});

test("stale codex row selection validates as a controlled provider-not-found", () => {
  const registry = toRegistry(resolveRegistry([{ providerId: ROW_A, disabled: [] }]));
  const stale = registry.validateSelection({
    providerId: createCodexAccountProviderId("removed-account"),
    modelId: "gpt-6-astra",
    options: { reasoningLevel: "high" },
  });
  // 失效选择映射为结构化 provider-not-found（由上层转成可恢复错误），不是 raw Zod/内部异常。
  assert.equal(stale.ok, false);
  assert.ok(!stale.ok && stale.code === "provider-not-found");
});
