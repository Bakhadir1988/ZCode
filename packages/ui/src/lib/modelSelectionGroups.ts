import {
  isZCodeAgentProvider,
  parseCodexProviderAccountId,
  resolveModelProviderFamilySpecByProviderId,
  zcodeProviderAccountAccessSchema,
  type ZCodeProviderAccountAccess,
  type ZCodeProvider,
} from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { shouldShowModelVisionBadge } from "@/lib/modelVisionBadge.js";

export interface ModelProviderGroupLabelOptions {
  apiKeyLabel?: string;
  apiKeyBadgeLabel?: string;
  codingPlanLabel?: string;
  codingPlanBadgeLabel?: string;
  startPlanLabel?: string;
  startPlanBadgeLabel?: string;
  teamPlanBadgeLabel?: string;
  teamPlanFallbackLabel?: string;
  /** Codex 行 providerId → 账号展示 label；用作 per-account submenu 的组 badge。 */
  codexAccountLabels?: Readonly<Record<string, string>>;
  /** 已停用账号的 provider 行 id 集合；这些行不出现在 chat picker（设置页仍可见）。 */
  codexDisabledAccountProviderIds?: ReadonlySet<string>;
}

function supportsRegistryApiFormat(
  selectedProvider: ZCodeProvider,
  apiFormat: string | null | undefined,
): boolean {
  if (!apiFormat) return false;
  // 仅剩 glm（ZCode Agent）provider；三方 CLI 的 api format 差异已随 provider 下线。
  return isZCodeAgentProvider(selectedProvider);
}

export function buildRegistryModelSelectGroups(
  selectedProvider: ZCodeProvider,
  view: ModelSelectionView,
  labels: ModelProviderGroupLabelOptions = {},
): ModelSelectGroup[] {
  const codexRows = view.providers.filter(
    (provider) => parseCodexProviderAccountId(provider.providerId) !== null,
  );
  // Codex 每个账号一个 submenu 组（与 API format provider 组同构），
  // 单账号也保持同样结构；停用账号不生成组（注册表行仍保留给既有会话）。
  const codexGroups = buildCodexModelSelectGroups(codexRows, labels);
  const codexGroupByRowKey = new Map(codexGroups.map((group) => [group.key, group]));
  return view.providers.flatMap((provider) => {
    if (parseCodexProviderAccountId(provider.providerId) !== null) {
      const group = codexGroupByRowKey.get(`registry-provider:${provider.providerId}`);
      return group ? [group] : [];
    }
    if (!supportsRegistryApiFormat(selectedProvider, provider.config.api?.type)) {
      return [];
    }

      const accountAccess = zcodeProviderAccountAccessSchema.safeParse(provider.config.access);
      const accountPresentation = accountAccess.success
        ? getRegistryAccountProviderGroupPresentation(provider.providerId, accountAccess.data, labels)
        : null;

      return [
        {
          key: `registry-provider:${provider.providerId}`,
          label: accountPresentation?.label || provider.providerName?.trim() || provider.providerId,
          ...(accountPresentation?.labelBadge ? { labelBadge: accountPresentation.labelBadge } : {}),
          ...(accountPresentation ? { directItems: true } : {}),
          items: provider.models.map(({ modelId, config }) => ({
            key: `registry-provider:${provider.providerId}:${modelId}`,
            value: encodeCustomModelValue(provider.providerId, modelId),
            name: modelId,
            ...(shouldShowModelVisionBadge(
              modelId,
              config.properties?.inputFormat?.supportsImage,
              provider.config.access,
            )
              ? { supportsVisionInput: true }
              : {}),
          })),
        },
      ];
    });
}

/**
 * Codex 每个启用中的账号渲染为独立 submenu 组：组 label 是 provider 名，
 * 账号 label 挂组 badge（与 zhipu 套餐 badge 同一视觉语言）；email 不进 picker。
 * 停用账号整组隐藏；组内 per-model OFF 由 registry 行的模型成员决定。
 */
function buildCodexModelSelectGroups(
  rows: ModelSelectionView["providers"],
  labels: ModelProviderGroupLabelOptions,
): ModelSelectGroup[] {
  const disabled = labels.codexDisabledAccountProviderIds;
  const groups: ModelSelectGroup[] = [];
  for (const row of rows) {
    if (disabled?.has(row.providerId)) continue;
    if (row.models.length === 0) continue;
    const accountLabel =
      labels.codexAccountLabels?.[row.providerId]?.trim() ||
      parseCodexProviderAccountId(row.providerId) ||
      row.providerId;
    groups.push({
      key: `registry-provider:${row.providerId}`,
      label: row.providerName?.trim() || "OpenAI Codex",
      labelBadge: accountLabel,
      items: row.models.map(({ modelId, config }) => ({
        key: `registry-provider:${row.providerId}:${modelId}`,
        value: encodeCustomModelValue(row.providerId, modelId),
        name: modelId,
        ...(shouldShowModelVisionBadge(
          modelId,
          config.properties?.inputFormat?.supportsImage,
          row.config.access,
        )
          ? { supportsVisionInput: true }
          : {}),
      })),
    });
  }
  return groups;
}

function getRegistryAccountProviderGroupPresentation(
  providerId: string,
  access: ZCodeProviderAccountAccess,
  labels: ModelProviderGroupLabelOptions,
): Pick<ModelSelectGroup, "label" | "labelBadge"> {
  const familySpec = resolveModelProviderFamilySpecByProviderId(providerId);
  const label = familySpec?.label ?? providerId;
  if (access.mode === "start-plan") {
    return { label: "Start Plan", labelBadge: labels.startPlanBadgeLabel ?? "Free" };
  }
  if (access.mode === "team-coding-plan") {
    return { label, labelBadge: labels.teamPlanBadgeLabel ?? "Team" };
  }
  return { label, labelBadge: labels.codingPlanBadgeLabel ?? "Individual" };
}

export function resolveModelDisplayName(
  modelGroups: readonly ModelSelectGroup[],
  value: string,
): string | null {
  for (const group of modelGroups) {
    const matched = group.items.find((item) => item.value === value);
    if (matched) return matched.name;
  }

  return decodeCustomModelValue(value)?.modelName ?? null;
}
