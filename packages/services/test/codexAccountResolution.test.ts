import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexAccountAccessConfig,
  ProviderConfig,
  ProviderConfigMap,
  parseAccountProviderConfigMap,
  resolveAccountProviderConfigs,
  type AccountProviderConnectionResult,
} from "@zcode/provider";
import { createCodexAccountProviderId } from "@zcode/shared";
import { createAccountProviderConnectionResolver } from "../src/model-provider/accountProviderConnectionResolver.js";

const BASE_ID = "account:openai-codex";
const ROW_A = createCodexAccountProviderId("account-a");
const ROW_B = createCodexAccountProviderId("account-b");

function configuredProviders(): ProviderConfigMap {
  return new ProviderConfigMap([
    [
      BASE_ID,
      new ProviderConfig({ access: new CodexAccountAccessConfig({ connected: false }) }),
    ],
  ]);
}

function codexConnection(
  rows: {
    accountId: string;
    models: string[];
    disabled: string[];
    efforts?: Record<string, string[]>;
  }[],
): AccountProviderConnectionResult {
  return {
    providerId: BASE_ID,
    status: "available",
    codexAccountRows: rows.map((row) => ({
      accountId: row.accountId,
      providerId: createCodexAccountProviderId(row.accountId),
      models: row.models,
      providerModelRules: row.models.map((modelId) => ({
        providerId: createCodexAccountProviderId(row.accountId),
        modelId,
        config: {
          enabled: !row.disabled.includes(modelId),
          ...((row.efforts?.[modelId]?.length ?? 0) > 0
            ? {
                optionSpecs: {
                  reasoningLevel: {
                    values: [...(row.efforts?.[modelId] ?? [])],
                    map: "{}",
                  },
                },
              }
            : {}),
        },
      })),
    })),
  };
}

test("codex connection expands to base row plus one provider row per account", () => {
  const providers = resolveAccountProviderConfigs({
    configuredProviders: configuredProviders(),
    previousProviders: ProviderConfigMap.empty(),
    connections: [
      codexConnection([
        { accountId: "account-a", models: ["m1", "m2"], disabled: [] },
        { accountId: "account-b", models: ["m1"], disabled: [] },
      ]),
    ],
  });
  const base = providers.get(BASE_ID);
  assert.ok(base, "base row must exist");
  assert.equal(base.access?.type, "codex-account");
  assert.deepEqual(base.builtinModelIds ?? [], [], "base row carries no models");

  const rowA = providers.get(ROW_A);
  assert.ok(rowA, "per-account row must exist");
  assert.deepEqual(rowA.builtinModelIds, ["m1", "m2"]);
  assert.equal(rowA.access?.type, "codex-account");
  const rowB = providers.get(ROW_B);
  assert.ok(rowB);
  assert.deepEqual(rowB.builtinModelIds, ["m1"]);
});

test("account overlay rows carry only account-layer fields", () => {
  const providers = resolveAccountProviderConfigs({
    configuredProviders: configuredProviders(),
    previousProviders: ProviderConfigMap.empty(),
    connections: [
      codexConnection([
        { accountId: "account-a", models: ["m1"], disabled: [] },
        { accountId: "account-b", models: ["m1"], disabled: [] },
      ]),
    ],
  });
  // logo/api/group 属于家族 base 行的 Built-in 身份，由 Resolver 在解析期继承；
  // 拷贝进 Account Overlay 会被 wire 层 Account Schema 整包拒绝（unrecognized_keys）。
  for (const rowId of [ROW_A, ROW_B]) {
    const row = providers.get(rowId);
    assert.ok(row, `row ${rowId} must exist`);
    const json = row.toJSON() as Record<string, unknown>;
    assert.equal("logo" in json, false, `${rowId} must not carry logo`);
    assert.equal("api" in json, false, `${rowId} must not carry api`);
    assert.equal("group" in json, false, `${rowId} must not carry group`);
  }
});

test("wire envelope with two account rows passes strict account schema", () => {
  const providers = resolveAccountProviderConfigs({
    configuredProviders: configuredProviders(),
    previousProviders: ProviderConfigMap.empty(),
    connections: [
      codexConnection([
        { accountId: "account-a", models: ["m1"], disabled: [] },
        { accountId: "account-b", models: ["m1"], disabled: ["m1"] },
      ]),
    ],
  });
  // 与 Host → CLI providerUpdateAccountConfig 相同的字典投影；曾经在这里抛出
  // unrecognized_keys: "logo", "api"，导致 Codex 从 registry/model picker 消失。
  const wire = Object.fromEntries(
    [...providers.entries()].map(([providerId, config]) => [providerId, config.toJSON()]),
  );
  const parsed = parseAccountProviderConfigMap(wire);
  assert.deepEqual([...parsed.keys()].sort(), [BASE_ID, ROW_A, ROW_B].sort());
});

test("disabled models stay listed but resolve through per-row rules", () => {
  const providers = resolveAccountProviderConfigs({
    configuredProviders: configuredProviders(),
    previousProviders: ProviderConfigMap.empty(),
    connections: [
      codexConnection([
        {
          accountId: "account-a",
          models: ["m1", "m2"],
          disabled: ["m2"],
          efforts: { m1: ["low", "high"] },
        },
      ]),
    ],
  });
  // 成员完整（含 OFF 模型），开关走规则 enabled:false。
  assert.deepEqual(providers.get(ROW_A)?.builtinModelIds, ["m1", "m2"]);
});

test("connection resolver builds row-keyed rules with toggle state", async () => {
  const resolver = createAccountProviderConnectionResolver({
    readSettings: async () => ({ providerFamilyDomain: null, selections: {} }),
    loadCodingPlanApiKey: async () => null,
    loadAccountIdentity: async () => null,
    resolveFamilyAvailability: async () => ({}),
    resolveCodexConnection: async () => ({
      accounts: [
        {
          accountId: "account-a",
          connected: true,
          models: [
            { id: "m1", defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "high"] },
            { id: "m2", defaultReasoningEffort: null, supportedReasoningEfforts: [] },
          ],
          disabledModels: ["m2"],
        },
        {
          accountId: "account-b",
          connected: false,
          models: [],
          disabledModels: [],
        },
      ],
    }),
  });
  const connections = await resolver({
    configRevision: "rev-1",
    configuredProviders: configuredProviders(),
  });
  assert.equal(connections.length, 1);
  const connection = connections[0]!;
  assert.equal(connection.providerId, BASE_ID);
  assert.equal(connection.status, "available");
  assert.ok(connection.status === "available");
  const rows = connection.codexAccountRows ?? [];
  // Only connected accounts expand; disconnected account-b has no row.
  assert.deepEqual(
    rows.map((row) => row.providerId),
    [ROW_A],
  );
  const rules = rows[0]?.providerModelRules ?? [];
  assert.equal(rules.length, 2);
  const m1 = rules.find((rule) => rule.modelId === "m1");
  const m2 = rules.find((rule) => rule.modelId === "m2");
  assert.equal(m1?.config.enabled, true);
  assert.deepEqual(
    (m1?.config.optionSpecs as { reasoningLevel?: { values?: string[] } } | undefined)?.reasoningLevel
      ?.values,
    ["low", "high"],
  );
  assert.equal(m2?.config.enabled, false);
});

test("no codex facts means unavailable base without rows", async () => {
  const resolver = createAccountProviderConnectionResolver({
    readSettings: async () => ({ providerFamilyDomain: null, selections: {} }),
    loadCodingPlanApiKey: async () => null,
    loadAccountIdentity: async () => null,
    resolveFamilyAvailability: async () => ({}),
  });
  const connections = await resolver({
    configRevision: "rev-1",
    configuredProviders: configuredProviders(),
  });
  assert.equal(connections.length, 1);
  assert.equal(connections[0]?.status, "unavailable");
  const providers = resolveAccountProviderConfigs({
    configuredProviders: configuredProviders(),
    previousProviders: ProviderConfigMap.empty(),
    connections,
  });
  assert.equal(providers.get(BASE_ID)?.access?.type, "codex-account");
});
