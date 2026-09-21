import assert from "node:assert/strict";
import test from "node:test";
import {
  createCodexAccountProviderId,
  encodeCustomModelValue,
} from "../../shared/src/index.js";
import { buildRegistryModelSelectGroups } from "../src/lib/modelSelectionGroups.js";
import type { ModelSelectionView } from "@zcode/services";

const ROW_A = createCodexAccountProviderId("account-a");
const ROW_B = createCodexAccountProviderId("account-b");

function modelConfig() {
  return {
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
      reasoningLevel: { values: ["low", "high"], map: "{}" },
      maxOutputTokens: { max: 128000, map: "{}" },
    },
  };
}

function codexRow(providerId: string, models: string[]): ModelSelectionView["providers"][number] {
  return {
    providerId,
    providerName: "OpenAI Codex",
    config: {
      group: "codex-family",
      access: { type: "codex-account", connected: true },
      api: { type: "codex-app-server", baseUrl: "app-server://codex" },
      builtinModelIds: models,
    },
    models: models.map((modelId) => ({ modelId, config: modelConfig() })),
  } as ModelSelectionView["providers"][number];
}

function view(providers: ModelSelectionView["providers"]): ModelSelectionView {
  return { revision: 1, providers } as ModelSelectionView;
}

test("two enabled accounts render one nested submenu group per account", () => {
  const groups = buildRegistryModelSelectGroups(
    "glm" as never,
    view([codexRow(ROW_A, ["gpt-6-astra", "gpt-5.6-sol"]), codexRow(ROW_B, ["gpt-6-astra"])]),
    { codexAccountLabels: { [ROW_A]: "Personal", [ROW_B]: "Account 2" } },
  );
  const codexGroups = groups.filter((group) => group.label === "OpenAI Codex");
  assert.equal(codexGroups.length, 2, "one submenu group per enabled account");
  assert.deepEqual(
    codexGroups.map((group) => group.labelBadge),
    ["Personal", "Account 2"],
  );
  // 嵌套 submenu：组不是 directItems 平铺（与 API format provider 组同构）。
  assert.ok(codexGroups.every((group) => !group.directItems));
  // 每个账号的模型落在自己的 submenu 里；同名模型在两个账号下是两个可选项。
  const personal = codexGroups[0]!;
  assert.deepEqual(
    personal.items.map((item) => item.value),
    [
      encodeCustomModelValue(ROW_A, "gpt-6-astra"),
      encodeCustomModelValue(ROW_A, "gpt-5.6-sol"),
    ],
  );
  assert.deepEqual(
    codexGroups[1]!.items.map((item) => item.value),
    [encodeCustomModelValue(ROW_B, "gpt-6-astra")],
  );
});

test("a single account keeps the nested group structure", () => {
  const groups = buildRegistryModelSelectGroups(
    "glm" as never,
    view([codexRow(ROW_A, ["gpt-6-astra", "gpt-5.6-sol"])]),
    { codexAccountLabels: { [ROW_A]: "Personal" } },
  );
  const codexGroups = groups.filter((group) => group.label === "OpenAI Codex");
  assert.equal(codexGroups.length, 1, "single account still uses the submenu structure");
  assert.equal(codexGroups[0]!.labelBadge, "Personal");
  assert.equal(codexGroups[0]!.items.length, 2);
  // 账号名挂在组 badge 上，item 不再重复账号 badge（email 永不进 picker label）。
  assert.equal(
    codexGroups[0]!.items.some((item) => item.badgeLabel !== undefined),
    false,
  );
});

test("a disabled account has no picker group while the enabled one stays", () => {
  const groups = buildRegistryModelSelectGroups(
    "glm" as never,
    view([codexRow(ROW_A, ["gpt-6-astra"]), codexRow(ROW_B, ["gpt-6-astra"])]),
    {
      codexAccountLabels: { [ROW_A]: "Personal", [ROW_B]: "Account 2" },
      codexDisabledAccountProviderIds: new Set([ROW_A]),
    },
  );
  const codexGroups = groups.filter((group) => group.label === "OpenAI Codex");
  assert.equal(codexGroups.length, 1);
  assert.equal(codexGroups[0]!.labelBadge, "Account 2");
  assert.deepEqual(
    codexGroups[0]!.items.map((item) => item.value),
    [encodeCustomModelValue(ROW_B, "gpt-6-astra")],
  );
});

test("account-scoped model toggle is reflected inside the account submenu", () => {
  // registry 行成员已排除 OFF 模型：A 只有 gpt-6-astra，B 有两个模型。
  const groups = buildRegistryModelSelectGroups(
    "glm" as never,
    view([codexRow(ROW_A, ["gpt-6-astra"]), codexRow(ROW_B, ["gpt-6-astra", "gpt-5.6-sol"])]),
    { codexAccountLabels: { [ROW_A]: "Personal", [ROW_B]: "Account 2" } },
  );
  const codexGroups = groups.filter((group) => group.label === "OpenAI Codex");
  const personal = codexGroups.find((group) => group.labelBadge === "Personal")!;
  const account2 = codexGroups.find((group) => group.labelBadge === "Account 2")!;
  assert.equal(
    personal.items.some((item) => item.value === encodeCustomModelValue(ROW_A, "gpt-5.6-sol")),
    false,
    "OFF model must be absent from its own account submenu",
  );
  assert.ok(
    account2.items.some((item) => item.value === encodeCustomModelValue(ROW_B, "gpt-5.6-sol")),
    "same model ON on another account stays in its submenu",
  );
});
