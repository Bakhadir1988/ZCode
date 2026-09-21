import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexAccountAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderRegistry,
  type ModelSelection,
  type Provider,
} from "@zcode/provider";
import { CODEX_BASE_PROVIDER_ID, createCodexAccountProviderId } from "@zcode/shared";
import { remapLegacyCodexProviderSelection } from "../src/app/provider-registry-selection.js";

const BASE_ID = CODEX_BASE_PROVIDER_ID;
const ROW_A = createCodexAccountProviderId("account-a");
const ROW_B = createCodexAccountProviderId("account-b");

// Registry 校验只消费 optionSpecs.reasoningLevel.values / visibility / providerId；
// 这里构造最小 Provider 投影，完整 RegistryProviderConfig 由 Resolver 层测试覆盖。
function codexRow(providerId: string, models: string[]): Provider {
  return {
    providerId,
    providerName: "OpenAI Codex",
    config: new ProviderConfig({
      group: "codex-family",
      access: new CodexAccountAccessConfig({ connected: true }),
      api: new ProviderApiConfig({ type: "codex-app-server", baseUrl: "app-server://codex" }),
      builtinModelIds: models,
    }),
    models: models.map((modelId) => ({
      modelId,
      config: {
        enabled: true,
        properties: {} as never,
        optionSpecs: {
          reasoningLevel: { values: ["low", "high"], map: "{}" },
        },
      },
    })),
  } as unknown as Provider;
}

function registry(rows: Provider[]): ProviderRegistry {
  return new ProviderRegistry(rows);
}

function baseSelection(overrides?: Partial<ModelSelection>): ModelSelection {
  return {
    providerId: BASE_ID,
    modelId: "gpt-6-astra",
    options: { reasoningLevel: "high" },
    ...overrides,
  };
}

test("legacy base selection remaps to the active account row preserving model and effort", () => {
  const remapped = remapLegacyCodexProviderSelection(
    registry([codexRow(ROW_A, ["gpt-6-astra"]), codexRow(ROW_B, ["gpt-6-astra"])]),
    baseSelection(),
    "account-b",
  );
  assert.deepEqual(remapped, {
    providerId: ROW_B,
    modelId: "gpt-6-astra",
    options: { reasoningLevel: "high" },
  });
  // 重映射结果是合法执行选择：行内模型与档位保持兼容。
  assert.equal(
    registry([codexRow(ROW_B, ["gpt-6-astra"])]).validateSelection(remapped).ok,
    true,
  );
});

test("unsupported model or effort falls back inside the active account row", () => {
  const view = registry([codexRow(ROW_A, ["gpt-5.6-sol"])]);
  const remappedModel = remapLegacyCodexProviderSelection(view, baseSelection(), "account-a");
  assert.equal(remappedModel.providerId, ROW_A);
  assert.equal(remappedModel.modelId, "gpt-5.6-sol", "missing model falls back to the row's first model");
  assert.equal(
    remappedModel.options?.reasoningLevel,
    "high",
    "requested effort is kept when the fallback model supports it",
  );

  const remappedEffort = remapLegacyCodexProviderSelection(
    registry([codexRow(ROW_A, ["gpt-6-astra"])]),
    baseSelection({ options: { reasoningLevel: "medium" } }),
    "account-a",
  );
  assert.deepEqual(
    remappedEffort,
    { providerId: ROW_A, modelId: "gpt-6-astra" },
    "unsupported effort is dropped (facade-remap semantics), never replaced with an artificial tier",
  );
});

test("unsupported effort drops the option instead of forcing the highest tier", () => {
  const view = registry([codexRow(ROW_A, ["gpt-6-astra"])]);
  const remapped = remapLegacyCodexProviderSelection(
    view,
    baseSelection({ options: { reasoningLevel: "ultra" } }),
    "account-a",
  );
  // 目标行不携带 defaultReasoningEffort：不能替用户选 values.at(-1) 的最高档，
  // 否则恢复的 legacy 会话会被静默绑到最贵 effort。
  assert.deepEqual(remapped, { providerId: ROW_A, modelId: "gpt-6-astra" });
  const validation = registry([codexRow(ROW_A, ["gpt-6-astra"])]).validateSelection(remapped);
  assert.ok(
    !validation.ok && validation.code === "reasoning-level-missing",
    "dropped effort maps to the recoverable reasoning-level-missing path, not a silent re-bind",
  );
});

test("legacy selection without resolvable codex rows is left untouched", () => {
  const selection = baseSelection();
  assert.deepEqual(
    remapLegacyCodexProviderSelection(registry([]), selection, null),
    selection,
    "no rows (disconnected) must not throw or fabricate a target",
  );
});

test("non-base selections (row ids and other providers) are never rewritten", () => {
  const view = registry([codexRow(ROW_A, ["gpt-6-astra"])]);
  const rowSelection: ModelSelection = {
    providerId: ROW_A,
    modelId: "gpt-6-astra",
    options: { reasoningLevel: "low" },
  };
  assert.deepEqual(remapLegacyCodexProviderSelection(view, rowSelection, "account-a"), rowSelection);
  const otherSelection: ModelSelection = {
    providerId: "account:zai-individual-coding-plan",
    modelId: "GLM-5.3",
    options: { reasoningLevel: "high" },
  };
  assert.deepEqual(remapLegacyCodexProviderSelection(view, otherSelection, "account-a"), otherSelection);
});
