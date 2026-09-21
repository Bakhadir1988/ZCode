import { useMemo, useRef, useState } from "react";
import { AlertCircleIcon, Loader2Icon, PlusIcon, RefreshCwIcon } from "lucide-react";
import type { CodexAccountInfo } from "@zcode/shared";
import { createCodexAccountProviderId } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useCodexAccounts } from "@/hooks/useCodexAccount.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { Badge } from "@/components/ui/badge.js";
import { ProviderLogo } from "@/settings/model-provider-section/ProviderLogo.js";
import { ModelInputCapabilityBadge } from "@/components/ModelInputCapabilityBadge.js";
import { logger } from "@/logger.js";

interface CodexAccountModelRow {
  modelId: string;
  enabled: boolean;
  efforts: readonly string[];
  supportsImage: boolean;
}

/**
 * OpenAI Codex provider 面板（多账号）。
 *
 * - 左侧导航只有一行聚合入口；账号列表、增删、默认账号设置全部在这里。
 * - 所有已连接账号同时可用：每张账号卡片内嵌该账号自己的模型列表
 *   （toggle 键 = accountId+modelId），卡片之间互不排斥；"默认"只是
 *   新会话/legacy base 选择偏好，不代表其他账号被关闭。
 * - Model list 数据来自 registry 的 per-account 行；toggle 经
 *   codexService.setModelEnabled 持久化到账号记录（非 personal 层）。
 * - 凭据永不进入 UI：只有 label/email/plan/efforts。
 */
export function CodexProviderPanel() {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const { state, serviceMissing, startLogin, cancelLogin, logout, setDefaultAccount, setAccountEnabled } =
    useCodexAccounts();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const accountsRef = useRef<HTMLDivElement>(null);
  const providerSettingsRead = useProviderSettingsView();
  const view =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;

  const accounts = state.accounts;
  const defaultAccountId = state.activeAccountId;

  // 所有账号的模型投影同时构建：默认账号不参与过滤，切默认不改任何列表。
  const modelsByAccountId = useMemo(() => {
    const map = new Map<string, readonly CodexAccountModelRow[]>();
    for (const account of accounts) {
      const providerId = createCodexAccountProviderId(account.id);
      const row = view?.providers.find((provider) => provider.providerId === providerId);
      map.set(
        account.id,
        row?.models.map((model) => ({
          modelId: model.modelId,
          enabled: model.effectiveConfig.enabled !== false,
          efforts: model.effectiveConfig.optionSpecs?.reasoningLevel?.values ?? [],
          supportsImage: model.effectiveConfig.properties?.inputFormat?.supportsImage === true,
        })) ?? [],
      );
    }
    return map;
  }, [accounts, view]);

  if (serviceMissing) {
    return null;
  }

  const runBusy = async (key: string, action: () => Promise<unknown>): Promise<void> => {
    setBusyKey(key);
    try {
      await action();
    } catch (error) {
      logger.warn("[CodexProviderPanel] action failed", error);
    } finally {
      setBusyKey((current) => (current === key ? null : current));
    }
  };

  const handleAddAccount = () =>
    runBusy("add", async () => {
      const started = await startLogin();
      if (started) {
        platform.openExternal(started.authUrl);
      }
    });

  const scrollToAccounts = () => {
    accountsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const anyConnected = accounts.some((account) => account.connected);

  return (
    <div className="space-y-4" data-testid="codex-provider-panel">
      <div className="flex min-w-0 items-center gap-2">
        <ProviderLogo logo={{ type: "builtin", key: "openai" }} className="size-5" />
        <h3 className="min-w-0 truncate text-ui-lg font-semibold leading-5 text-foreground">
          {intl.formatMessage({ id: "settings.modelProvider.codex.title" })}
        </h3>
        <span className="text-ui-base text-foreground-subtle">
          {anyConnected
            ? intl.formatMessage({ id: "settings.modelProvider.codex.connectedWithChatgpt" })
            : intl.formatMessage({ id: "settings.modelProvider.codex.description" })}
        </span>
      </div>

      <div ref={accountsRef} className="scroll-mt-4 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-ui-base font-semibold text-foreground">
            {intl.formatMessage({ id: "settings.modelProvider.codex.accounts" })}
          </h4>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busyKey !== null}
              onClick={handleAddAccount}
            >
              {busyKey === "add" ? (
                <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <PlusIcon className="size-4" aria-hidden="true" />
              )}
              {intl.formatMessage({ id: "settings.modelProvider.codex.addAccount" })}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={accounts.length === 0}
              onClick={scrollToAccounts}
            >
              {intl.formatMessage({ id: "settings.modelProvider.codex.manageAccounts" })}
            </Button>
          </div>
        </div>

        {accounts.length === 0 ? (
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.modelProvider.codex.emptyState" })}
          </p>
        ) : (
          <ul className="space-y-3">
            {accounts.map((account) => (
              <CodexAccountCard
                key={account.id}
                account={account}
                isDefault={account.id === defaultAccountId}
                models={modelsByAccountId.get(account.id) ?? []}
                busy={busyKey !== null}
                onSetDefault={() =>
                  runBusy(`default:${account.id}`, () => setDefaultAccount(account.id))
                }
                onCancelLogin={() => runBusy(`cancel:${account.id}`, () => cancelLogin(account.id))}
                onLogout={() => runBusy(`logout:${account.id}`, () => logout(account.id))}
                onSetEnabled={(enabled) =>
                  runBusy(`enable:${account.id}`, () => setAccountEnabled(account.id, enabled))
                }
              />
            ))}
          </ul>
        )}
      </div>

      <p className="text-ui-sm text-foreground-subtlest">
        {intl.formatMessage({ id: "settings.modelProvider.codex.defaultHint" })}
      </p>
      <p className="text-ui-sm text-foreground-subtlest">
        {intl.formatMessage({ id: "settings.modelProvider.codex.modelsFootnote" })}
      </p>
    </div>
  );
}

/**
 * 单账号卡片：默认账号显示 Default badge，关闭的账号显示 Disabled badge；
 * 其余提供 "Set as default" 动作；卡片内含 Enabled 可用性开关（只是偏好，
 * 不登出）与该账号的模型列表。卡片之间没有互斥关系。
 */
function CodexAccountCard({
  account,
  isDefault,
  models,
  busy,
  onSetDefault,
  onCancelLogin,
  onLogout,
  onSetEnabled,
}: {
  account: CodexAccountInfo;
  isDefault: boolean;
  models: readonly CodexAccountModelRow[];
  busy: boolean;
  onSetDefault: () => void;
  onCancelLogin: () => void;
  onLogout: () => void;
  onSetEnabled: (enabled: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const detail = [account.email, account.planType].filter(Boolean).join(" · ");
  const accountEnabled = account.enabled;
  return (
    <li className="min-w-0 rounded-xl border border-border bg-card">
      <div className="flex min-w-0 flex-wrap items-center gap-2 p-3 pb-1">
        <span className="min-w-0 flex-1 basis-48">
          <span className="flex items-center gap-2">
            <span className="truncate text-ui-base font-medium text-foreground">
              {account.label}
            </span>
            {isDefault ? (
              <Badge variant="secondary">
                {intl.formatMessage({ id: "settings.modelProvider.codex.defaultBadge" })}
              </Badge>
            ) : null}
            {!accountEnabled ? (
              <Badge variant="outline">
                {intl.formatMessage({ id: "settings.modelProvider.codex.disabledBadge" })}
              </Badge>
            ) : null}
          </span>
          {detail ? (
            <span className="block truncate text-ui-sm text-foreground-subtle">{detail}</span>
          ) : null}
          {account.pendingLoginId ? (
            <span className="block truncate text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "settings.modelProvider.codex.connecting" })}
            </span>
          ) : null}
          {account.lastLoginError ? (
            <span className="flex items-center gap-1 text-ui-sm text-destructive">
              <AlertCircleIcon className="size-3.5 shrink-0" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.modelProvider.codex.loginFailed" })}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {account.pendingLoginId ? (
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onCancelLogin}>
              {intl.formatMessage({ id: "settings.modelProvider.codex.cancelLogin" })}
            </Button>
          ) : (
            <>
              {!isDefault ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  aria-label={intl.formatMessage(
                    { id: "settings.modelProvider.codex.setDefaultLabel" },
                    { label: account.label },
                  )}
                  onClick={onSetDefault}
                >
                  {intl.formatMessage({ id: "settings.modelProvider.codex.setDefault" })}
                </Button>
              ) : null}
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onLogout}>
                {intl.formatMessage(
                  { id: "settings.modelProvider.codex.disconnectAccount" },
                  { label: account.label },
                )}
              </Button>
            </>
          )}
        </span>
      </div>
      {account.pendingLoginId ? null : (
        <div className="flex items-center gap-2 px-3 py-1">
          <label
            className="min-w-0 flex-1 text-ui-sm text-foreground-subtle"
            htmlFor={`codex-account-enabled-${account.id}`}
          >
            {intl.formatMessage({ id: "settings.modelProvider.codex.accountEnabled" })}
          </label>
          <Switch
            id={`codex-account-enabled-${account.id}`}
            aria-label={intl.formatMessage(
              { id: "settings.modelProvider.codex.accountEnabledLabel" },
              { label: account.label },
            )}
            checked={accountEnabled}
            disabled={busy}
            onCheckedChange={onSetEnabled}
          />
        </div>
      )}
      <CodexAccountModelList
        accountId={account.id}
        accountLabel={account.label}
        models={models}
        dimmed={!accountEnabled}
      />
    </li>
  );
}

function CodexAccountModelList({
  accountId,
  accountLabel,
  models,
  dimmed = false,
}: {
  accountId: string;
  accountLabel: string;
  models: readonly CodexAccountModelRow[];
  /** 账号关闭时轻微压暗列表；开关仍然可编辑，便于提前配置。 */
  dimmed?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const { setModelEnabled, refresh } = useCodexAccounts();
  const [busyKey, setBusyKey] = useState<string | null>(null);

  return (
    <div className={dimmed ? "space-y-2 p-3 pt-1 opacity-70" : "space-y-2 p-3 pt-1"}>
      <div className="flex items-center justify-between gap-2">
        <h5 className="text-ui-sm font-semibold text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.models" })}
        </h5>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busyKey !== null}
          onClick={() => {
            setBusyKey("refresh");
            void refresh(accountId).finally(() =>
              setBusyKey((current) => (current === "refresh" ? null : current)),
            );
          }}
        >
          <RefreshCwIcon className="size-4" aria-hidden="true" />
          {intl.formatMessage({ id: "settings.modelProvider.refresh" })}
        </Button>
      </div>
      {models.length === 0 ? (
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "common.loading" })}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {models.map((model) => (
            <li
              key={model.modelId}
              className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ui-base text-foreground">
                  {model.modelId}
                </span>
                {model.efforts.length > 0 ? (
                  <span className="block truncate text-ui-sm text-foreground-subtle">
                    {model.efforts.join(" · ")}
                  </span>
                ) : null}
              </span>
              {model.supportsImage ? <ModelInputCapabilityBadge /> : null}
              <Switch
                aria-label={intl.formatMessage(
                  { id: "settings.modelProvider.codex.modelToggle" },
                  { model: model.modelId, account: accountLabel },
                )}
                checked={model.enabled}
                disabled={busyKey !== null}
                onCheckedChange={(checked) => {
                  const key = `toggle:${model.modelId}`;
                  setBusyKey(key);
                  void setModelEnabled(accountId, model.modelId, checked).finally(() =>
                    setBusyKey((current) => (current === key ? null : current)),
                  );
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
