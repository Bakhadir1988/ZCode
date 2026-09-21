import { Emitter } from "@zcode/rpc";
import type {
  CodexAccountInfo,
  CodexAccountsState,
  CodexModelDescriptor,
} from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { getDataBaseDir } from "../paths.js";
import {
  CodexAccountRegistry,
  type CodexAccountsFileData,
} from "./codexAccountRegistry.js";
import {
  createCodexAccountRuntime,
  type CodexAccountRuntime,
} from "./codexAccountRuntime.js";
import type { ICodexService } from "./codex.js";

const logger = createServiceLogger("codex-service");

interface CreateCodexServiceOptions {
  /** 官方 Codex 可执行文件路径或命令名；装配层从 ZCODE_CODEX_BIN 或缺省 "codex" 解析。 */
  readonly command?: string;
  /** 子进程参数；缺省 ["app-server"]，测试注入 fake server 时覆盖。 */
  readonly args?: readonly string[];
  /** 基础环境变量（之上叠加 per-account CODEX_HOME）；缺省继承宿主环境。 */
  readonly env?: NodeJS.ProcessEnv;
  /** App data base dir；缺省 getDataBaseDir()，测试注入临时目录。 */
  readonly dataBaseDir?: string;
  readonly requestTimeoutMs?: number;
  readonly initializeTimeoutMs?: number;
}

/**
 * ICodexService 的多账号宿主实现（编排层；per-account runtime 见 codexAccountRuntime）。
 *
 * - 账号注册表（`accounts.json`）是唯一的持久化状态，不含任何秘密；
 * - onDidChange 触发外部 registry 重算（node.ts 侧 debounce）。
 */
export function createCodexService(options: CreateCodexServiceOptions = {}): ICodexService {
  const command = options.command?.trim() || "codex";
  const dataBaseDir = options.dataBaseDir ?? getDataBaseDir();
  const registry = new CodexAccountRegistry(dataBaseDir);
  const runtimes = new Map<string, CodexAccountRuntime>();
  let disposed = false;
  const changeEmitter = new Emitter<CodexAccountsState>();
  let lastRegistry: CodexAccountsFileData | null = null;

  function handleFor(accountId: string, codexHome: string): CodexAccountRuntime {
    let handle = runtimes.get(accountId);
    if (!handle) {
      handle = createCodexAccountRuntime({
        accountId,
        codexHome,
        command,
        args: options.args,
        env: options.env,
        requestTimeoutMs: options.requestTimeoutMs,
        initializeTimeoutMs: options.initializeTimeoutMs,
        log: (level, message, error) => {
          if (level === "debug") logger.debug(undefined, message, error);
          else if (level === "warn") logger.warn(undefined, message, error);
          else logger.info(undefined, message, error);
        },
        onStateChanged: () => publish(),
      });
      runtimes.set(accountId, handle);
    }
    return handle;
  }

  function disposeHandle(accountId: string): void {
    const handle = runtimes.get(accountId);
    if (!handle) return;
    runtimes.delete(accountId);
    handle.dispose();
  }

  function publish(): void {
    const data = lastRegistry;
    if (!data) return;
    changeEmitter.fire({
      accounts: data.accounts.map((record) => {
        const snapshot = runtimes.get(record.id)?.snapshot() ?? {
          authMode: record.email !== null ? "chatgpt" : null,
          email: record.email,
          planType: record.planType,
          pendingLoginId: null,
          lastLoginError: null,
          runtime: "starting" as const,
        };
        return {
          id: record.id,
          label: record.label,
          email: snapshot.email,
          planType: snapshot.planType,
          authMode: snapshot.authMode,
          connected: snapshot.runtime === "ready" && snapshot.authMode !== null,
          disabledModels: [...record.disabledModels],
          enabled: record.enabled,
          runtime: snapshot.runtime,
          ...(snapshot.runtimeUnavailableReason
            ? { runtimeUnavailableReason: snapshot.runtimeUnavailableReason }
            : {}),
          ...(snapshot.runtimeDetail ? { runtimeDetail: snapshot.runtimeDetail } : {}),
          pendingLoginId: snapshot.pendingLoginId,
          lastLoginError: snapshot.lastLoginError,
        };
      }),
      activeAccountId: data.activeAccountId,
    });
  }

  async function refreshRegistry(): Promise<CodexAccountsFileData> {
    lastRegistry = await registry.read();
    return lastRegistry;
  }

  function findRecord(
    data: CodexAccountsFileData,
    accountId: string,
  ): CodexAccountsFileData["accounts"][number] | undefined {
    return data.accounts.find((candidate) => candidate.id === accountId);
  }

  function requireRecord(
    data: CodexAccountsFileData,
    accountId: string,
  ): CodexAccountsFileData["accounts"][number] {
    const record = findRecord(data, accountId);
    if (!record) throw new Error(`unknown codex account: ${accountId}`);
    return record;
  }

  /**
   * Есть ли у записи аккаунта известные учётные данные (без запуска runtime):
   * email появляется после первого успешного account/read, live-snapshot —
   * после логина. Используется только для выбора кандидата в default.
   */
  function hasKnownCredentials(record: CodexAccountsFileData["accounts"][number]): boolean {
    return record.email !== null || runtimes.get(record.id)?.snapshot().authMode === "chatgpt";
  }

  return {
    async getActiveAccountId(): Promise<string | null> {
      const data = await refreshRegistry();
      return data.activeAccountId;
    },

    async getState(): Promise<CodexAccountsState> {
      const data = await refreshRegistry();
      // 惰性拉起已知 runtime，保证状态是活的（与旧 getSnapshot 语义一致）。
      await Promise.all(
        data.accounts.map((record) =>
          handleFor(record.id, record.codexHome)
            .ensureClient()
            .then(() => undefined)
            .catch(() => undefined),
        ),
      );
      const fresh = await refreshRegistry();
      publish();
      const accounts: CodexAccountInfo[] = [];
      for (const record of fresh.accounts) {
        const snapshot =
          runtimes.get(record.id)?.snapshot() ??
          ({
            authMode: record.email !== null ? "chatgpt" : null,
            email: record.email,
            planType: record.planType,
            pendingLoginId: null,
            lastLoginError: null,
            runtime: "starting" as const,
          } as const);
        accounts.push({
          id: record.id,
          label: record.label,
          email: snapshot.email,
          planType: snapshot.planType,
          authMode: snapshot.authMode,
          connected: snapshot.runtime === "ready" && snapshot.authMode !== null,
          disabledModels: [...record.disabledModels],
          enabled: record.enabled,
          runtime: snapshot.runtime,
          ...(snapshot.runtimeUnavailableReason
            ? { runtimeUnavailableReason: snapshot.runtimeUnavailableReason }
            : {}),
          ...(snapshot.runtimeDetail ? { runtimeDetail: snapshot.runtimeDetail } : {}),
          pendingLoginId: snapshot.pendingLoginId,
          lastLoginError: snapshot.lastLoginError,
        });
      }
      return { accounts, activeAccountId: fresh.activeAccountId };
    },

    async refresh(accountId?: string): Promise<CodexAccountsState> {
      const data = await refreshRegistry();
      const targets =
        accountId === undefined ? data.accounts : [requireRecord(data, accountId)];
      await Promise.all(
        targets.map((record) =>
          handleFor(record.id, record.codexHome)
            .refreshAccount()
            .catch((error) => {
              logger.warn(undefined, "codex account/read failed", error);
            }),
        ),
      );
      // refreshAccount 成功会写回 email/plan，需要重读注册表再发布。
      await refreshRegistry();
      publish();
      return this.getState();
    },

    async startChatGptLogin(input?: { label?: string }) {
      const record = await registry.createAccount(input?.label?.trim() || "");
      await refreshRegistry();
      publish();
      const handle = handleFor(record.id, record.codexHome);
      try {
        const { authUrl } = await handle.startLogin();
        return { accountId: record.id, authUrl };
      } catch (error) {
        // 启动失败不应留下没有 runtime 与 loginId 的账号孤儿。
        disposeHandle(record.id);
        lastRegistry = await registry
          .mutate((data) => ({
            ...data,
            accounts: data.accounts.filter((candidate) => candidate.id !== record.id),
          }))
          .catch(() => lastRegistry);
        await registry.removeAccountHome(record.codexHome).catch(() => undefined);
        publish();
        throw error;
      }
    },

    async cancelPendingLogin(accountId: string): Promise<CodexAccountsState> {
      const data = await refreshRegistry();
      const record = requireRecord(data, accountId);
      const handle = handleFor(record.id, record.codexHome);
      const pendingId = handle.snapshot().pendingLoginId;
      if (!pendingId) return this.getState();
      await handle.cancelLogin(pendingId);
      return this.getState();
    },

    async logout(accountId: string): Promise<CodexAccountsState> {
      const data = await refreshRegistry();
      const record = requireRecord(data, accountId);
      const handle = handleFor(record.id, record.codexHome);
      try {
        await handle.logout();
      } catch (error) {
        // 登出必须完成，即使 runtime 不可用也要继续清理。
        logger.warn(undefined, "codex account/logout failed, continuing cleanup", error);
      }
      logger.info(undefined, "codex account logged out", { accountId });
      disposeHandle(accountId);
      await registry.removeAccountHome(record.codexHome).catch(() => undefined);
      lastRegistry = await registry.mutate((current) => ({
        ...current,
        accounts: current.accounts.filter((candidate) => candidate.id !== accountId),
      }));
      publish();
      return this.getState();
    },

    async setActiveAccount(accountId: string): Promise<CodexAccountsState> {
      const data = await refreshRegistry();
      requireRecord(data, accountId);
      lastRegistry = await registry.mutate((current) => ({
        ...current,
        activeAccountId: accountId,
      }));
      publish();
      return this.getState();
    },

    async setModelEnabled(
      accountId: string,
      modelId: string,
      enabled: boolean,
    ): Promise<CodexAccountsState> {
      const normalizedModelId = modelId.trim();
      if (!normalizedModelId) throw new Error("model id must not be empty");
      const data = await refreshRegistry();
      requireRecord(data, accountId);
      lastRegistry = await registry.mutate((current) => ({
        ...current,
        accounts: current.accounts.map((candidate) => {
          if (candidate.id !== accountId) return candidate;
          const disabled = new Set(candidate.disabledModels);
          if (enabled) disabled.delete(normalizedModelId);
          else disabled.add(normalizedModelId);
          return {
            ...candidate,
            disabledModels: [...disabled].sort(),
            updatedAt: Date.now(),
          };
        }),
      }));
      publish();
      return this.getState();
    },

    async setAccountEnabled(accountId: string, enabled: boolean): Promise<CodexAccountsState> {
      const data = await refreshRegistry();
      requireRecord(data, accountId);
      lastRegistry = await registry.mutate((current) => ({
        ...current,
        accounts: current.accounts.map((candidate) =>
          candidate.id === accountId
            ? { ...candidate, enabled, updatedAt: Date.now() }
            : candidate,
        ),
      }));
      if (!enabled) {
        // Выключение default → промоция первого другого доступного аккаунта
        // с учётными данными; если такого нет — default остаётся null
        // (mutate сохраняет явный null, не подставляя первый попавшийся).
        // OAuth/CODEX_HOME не трогаем: включение вернёт аккаунт без нового логина.
        const next = lastRegistry;
        if (next.activeAccountId === accountId) {
          const candidate = next.accounts.find(
            (record) => record.id !== accountId && record.enabled && hasKnownCredentials(record),
          );
          lastRegistry = await registry.mutate((current) => ({
            ...current,
            activeAccountId: candidate?.id ?? null,
          }));
        }
      }
      publish();
      return this.getState();
    },

    async listModels(accountId: string): Promise<CodexModelDescriptor[]> {
      const data = await refreshRegistry();
      const record = requireRecord(data, accountId);
      const activeClient = await handleFor(record.id, record.codexHome).ensureClient();
      const account = (await activeClient.requestAccountRead(false).catch(() => null)) as {
        account?: { type?: string } | null;
      } | null;
      if (!account?.account?.type) return [];
      const result = (await activeClient.request("model/list", {
        limit: 50,
        includeHidden: false,
      })) as {
        data?: readonly {
          id?: string;
          displayName?: string;
          defaultReasoningEffort?: string;
          supportedReasoningEfforts?: readonly { reasoningEffort?: string }[];
        }[];
      };
      return (result.data ?? []).flatMap((model) => {
        const id = model.id?.trim();
        if (!id) return [];
        return [
          {
            id,
            displayName: model.displayName ?? null,
            defaultReasoningEffort: model.defaultReasoningEffort ?? null,
            supportedReasoningEfforts: (model.supportedReasoningEfforts ?? [])
              .map((effort) => effort.reasoningEffort ?? "")
              .filter(Boolean),
          },
        ];
      });
    },

    onDidChange: changeEmitter.event,

    disposeAll(): void {
      if (disposed) return;
      disposed = true;
      for (const accountId of runtimes.keys()) disposeHandle(accountId);
      changeEmitter.dispose();
    },
  };
}
