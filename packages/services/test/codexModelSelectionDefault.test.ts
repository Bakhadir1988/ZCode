import assert from "node:assert/strict";
import test from "node:test";
import type {
  ModelSelection,
  ModelSelectionFacade,
  ModelSelectionView,
} from "@zcode/provider";
import { createCodexAccountProviderId } from "@zcode/shared";
import {
  createModelSelectionService,
} from "../src/model-provider/providerFacadeServices.js";

const ROW_A = createCodexAccountProviderId("account-a");
const ROW_B = createCodexAccountProviderId("account-b");

function codexRow(
  providerId: string,
  models: string[],
): ModelSelectionView["providers"][number] {
  return {
    providerId,
    providerName: "OpenAI Codex",
    models: models.map((modelId) => ({
      modelId,
      config: {
        enabled: true,
        properties: {},
        optionSpecs: { reasoningLevel: { values: ["low", "high"], map: "{}" } },
      },
    })),
  } as ModelSelectionView["providers"][number];
}

/**
 * 最小 ModelSelectionFacade 替身：记录每次 getView 收到的 configuredDefault。
 * createModelSelectionService 把 remap 后的 effective default 传给 facade.getView，
 * 这里用最后一次记录值断言"新会话 preferred 默认"的落点。
 */
function fakeFacade(providers: ModelSelectionView["providers"][number][]): {
  facade: ModelSelectionFacade;
  seenDefaults: readonly (ModelSelection | undefined)[];
} {
  const seenDefaults: (ModelSelection | undefined)[] = [];
  const facade = {
    getView: (configuredDefault?: ModelSelection) => {
      seenDefaults.push(configuredDefault);
      return { revision: 1, providers } as unknown as ModelSelectionView;
    },
    onDidChange: () => () => undefined,
  } as unknown as ModelSelectionFacade;
  return { facade, seenDefaults };
}

async function readEffectiveDefault(
  providers: ModelSelectionView["providers"][number][],
  configuredDefault: ModelSelection,
  resolveCodexActiveAccountId: () => Promise<string | null>,
): Promise<ModelSelection | undefined> {
  const { facade, seenDefaults } = fakeFacade(providers);
  const service = createModelSelectionService(
    facade,
    async () => {},
    { read: async () => configuredDefault },
    { resolveCodexActiveAccountId },
  );
  try {
    await service.getView();
  } finally {
    service.dispose();
  }
  return seenDefaults.at(-1);
}

test("preferred new-session default follows the switched default account", async () => {
  const providers = [codexRow(ROW_A, ["gpt-6-astra"]), codexRow(ROW_B, ["gpt-6-astra"])];
  const configuredDefault: ModelSelection = {
    providerId: ROW_A,
    modelId: "gpt-6-astra",
    options: { reasoningLevel: "low" },
  };

  // Default = A：preferred 选择保持在 A 行。
  const onA = await readEffectiveDefault(providers, configuredDefault, async () => "account-a");
  assert.deepEqual(onA, configuredDefault);

  // Default 切到 B：新会话默认落到 B 行；同名模型与档位在目标行可用则保留。
  const onB = await readEffectiveDefault(providers, configuredDefault, async () => "account-b");
  assert.deepEqual(onB, {
    providerId: ROW_B,
    modelId: "gpt-6-astra",
    options: { reasoningLevel: "low" },
  });
});

test("default remap falls back inside the target row instead of hiding the model", async () => {
  const providers = [codexRow(ROW_A, ["gpt-5.6-sol"]), codexRow(ROW_B, ["gpt-6-astra"])];
  const configuredDefault: ModelSelection = {
    providerId: ROW_A,
    modelId: "gpt-5.6-sol",
    options: { reasoningLevel: "low" },
  };
  // 目标行没有 gpt-5.6-sol：回退到该行首个模型，档位在目标行支持时保留。
  const remapped = await readEffectiveDefault(providers, configuredDefault, async () => "account-b");
  assert.deepEqual(remapped, {
    providerId: ROW_B,
    modelId: "gpt-6-astra",
    options: { reasoningLevel: "low" },
  });
});

test("non-codex defaults and missing default accounts are left untouched", async () => {
  const providers = [codexRow(ROW_A, ["gpt-6-astra"])];
  const foreign: ModelSelection = {
    providerId: "custom:other-provider",
    modelId: "some-model",
  };
  assert.deepEqual(
    await readEffectiveDefault(providers, foreign, async () => "account-a"),
    foreign,
    "non-codex default must not be rewritten",
  );

  const codexDefault: ModelSelection = { providerId: ROW_A, modelId: "gpt-6-astra" };
  assert.deepEqual(
    await readEffectiveDefault(providers, codexDefault, async () => null),
    codexDefault,
    "no default account (null) must keep the configured default",
  );
});
