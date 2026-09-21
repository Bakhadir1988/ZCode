import {
  CODEX_HOME_ENV,
  CodexAppServerClient,
  type CodexAppServerClientLogger,
} from "@zcode/shared/node";
import type {
  CodexAuthMode,
  CodexRuntimeState,
  CodexRuntimeUnavailableReason,
} from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";

const logger = createServiceLogger("codex-account-runtime");

export interface CodexAccountRuntimeSnapshot {
  readonly authMode: CodexAuthMode | null;
  readonly email: string | null;
  readonly planType: string | null;
  readonly pendingLoginId: string | null;
  readonly lastLoginError: string | null;
  readonly runtime: CodexRuntimeState;
  readonly runtimeUnavailableReason?: CodexRuntimeUnavailableReason;
  readonly runtimeDetail?: string;
}

interface AccountReadResult {
  account?: {
    type?: string;
    email?: string | null;
    planType?: string | null;
  } | null;
}

interface LoginCompletedParams {
  loginId?: string | null;
  success?: boolean;
  error?: string | null;
}

export interface CodexAccountRuntimeOptions {
  readonly accountId: string;
  readonly codexHome: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly requestTimeoutMs?: number;
  readonly initializeTimeoutMs?: number;
  readonly log?: CodexAppServerClientLogger;
  /** 任意状态变化——所有者必须重发聚合态。 */
  readonly onStateChanged: () => void;
}

/**
 * 单个 Codex 账号：隔离的 CODEX_HOME + 惰性 App Server 进程。
 * 崩溃/退出只影响本账号；注册表记录由所有者持有。
 */
export interface CodexAccountRuntime {
  snapshot(): CodexAccountRuntimeSnapshot;
  ensureClient(): Promise<CodexAppServerClient>;
  refreshAccount(): Promise<void>;
  startLogin(): Promise<{ loginId: string; authUrl: string }>;
  cancelLogin(loginId: string): Promise<void>;
  logout(): Promise<void>;
  dispose(): void;
}

function toPublicMessage(error: unknown): string {
  // 消息会进入 UI 与日志；只保留错误摘要，不带协议参数内容。
  return error instanceof Error ? error.message : String(error);
}

function resolveUnavailableReason(error: unknown): CodexRuntimeUnavailableReason {
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "binary-not-found";
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("exited") || message.includes("request timeout")) return "handshake-failed";
  return "spawn-failed";
}

export function createCodexAccountRuntime(
  options: CodexAccountRuntimeOptions,
): CodexAccountRuntime {
  const { accountId } = options;
  let authMode: CodexAuthMode | null = null;
  let email: string | null = null;
  let planType: string | null = null;
  let pendingLoginId: string | null = null;
  let lastLoginError: string | null = null;
  let runtime: CodexRuntimeState = "starting";
  let runtimeUnavailableReason: CodexRuntimeUnavailableReason | undefined;
  let runtimeDetail: string | undefined;
  let client: CodexAppServerClient | null = null;
  let clientPromise: Promise<CodexAppServerClient> | null = null;
  let disposed = false;

  function snapshot(): CodexAccountRuntimeSnapshot {
    return {
      authMode,
      email,
      planType,
      pendingLoginId,
      lastLoginError,
      runtime,
      ...(runtimeUnavailableReason ? { runtimeUnavailableReason } : {}),
      ...(runtimeDetail ? { runtimeDetail } : {}),
    };
  }

  function publish(): void {
    options.onStateChanged();
  }

  function handleNotification(method: string, params: unknown): void {
    if (method === "account/login/completed") {
      const completed = (params ?? {}) as LoginCompletedParams;
      if (
        completed.loginId &&
        pendingLoginId &&
        completed.loginId !== pendingLoginId &&
        !completed.success
      ) {
        return;
      }
      if (completed.success) {
        logger.info(undefined, "codex chatgpt login completed", { accountId });
        pendingLoginId = null;
        lastLoginError = null;
        publish();
        void refreshAccountSnapshot().catch((error: unknown) => {
          logger.warn(undefined, "codex account/read after login failed", error);
        });
        return;
      }
      if (pendingLoginId === null) return;
      pendingLoginId = null;
      lastLoginError = completed.error || "codex login failed";
      publish();
      return;
    }
    if (method === "account/updated") {
      void refreshAccountSnapshot().catch((error: unknown) => {
        logger.warn(undefined, "codex account/read after account/updated failed", error);
      });
    }
  }

  async function refreshAccountSnapshot(): Promise<void> {
    if (!client?.isRunning()) return;
    await refreshAccount(client);
  }

  async function refreshAccount(activeClient: CodexAppServerClient): Promise<void> {
    const result = (await activeClient.requestAccountRead(false)) as AccountReadResult;
    const account = result.account ?? null;
    authMode = account?.type ?? null;
    email = account?.email ?? null;
    planType = account?.planType ?? null;
    publish();
  }

  async function ensureClient(): Promise<CodexAppServerClient> {
    if (disposed) return Promise.reject(new Error("codex account runtime disposed"));
    if (client?.isRunning()) return client;
    if (clientPromise) return clientPromise;
    runtime = "starting";
    clientPromise = (async () => {
      const nextClient = new CodexAppServerClient({
        command: options.command,
        args: options.args,
        env: { ...options.env, [CODEX_HOME_ENV]: options.codexHome },
        requestTimeoutMs: options.requestTimeoutMs,
        initializeTimeoutMs: options.initializeTimeoutMs,
        log: options.log,
      });
      nextClient.onNotification(({ method, params }) => handleNotification(method, params));
      nextClient.onDidExit(() => {
        if (client !== nextClient) return;
        client = null;
        clientPromise = null;
        runtime = "unavailable";
        runtimeUnavailableReason = "exited";
        pendingLoginId = null;
        publish();
      });
      try {
        await nextClient.start();
      } catch (error) {
        await nextClient.dispose().catch(() => undefined);
        throw error;
      }
      client = nextClient;
      runtime = "ready";
      runtimeUnavailableReason = undefined;
      runtimeDetail = undefined;
      await refreshAccount(nextClient);
      return nextClient;
    })();
    clientPromise = clientPromise.catch((error: unknown) => {
      clientPromise = null;
      if (client === null) {
        runtime = "unavailable";
        runtimeUnavailableReason = resolveUnavailableReason(error);
        runtimeDetail = toPublicMessage(error);
        pendingLoginId = null;
        publish();
      }
      throw error;
    });
    return clientPromise;
  }

  return {
    snapshot,
    ensureClient,
    async refreshAccount(): Promise<void> {
      const activeClient = await ensureClient();
      await refreshAccount(activeClient);
    },
    async startLogin(): Promise<{ loginId: string; authUrl: string }> {
      try {
        return await (async () => {
          const activeClient = await ensureClient();
          const result = (await activeClient.request("account/login/start", {
            type: "chatgpt",
            useHostedLoginSuccessPage: true,
            appBrand: "chatgpt",
          })) as { type?: string; loginId?: string; authUrl?: string };
          if (!result?.authUrl || !result.loginId) {
            throw new Error("codex login start returned no auth url");
          }
          pendingLoginId = result.loginId;
          lastLoginError = null;
          publish();
          return { loginId: result.loginId, authUrl: result.authUrl };
        })();
      } catch (error) {
        pendingLoginId = null;
        lastLoginError = toPublicMessage(error);
        publish();
        throw error;
      }
    },
    async cancelLogin(loginId: string): Promise<void> {
      pendingLoginId = null;
      publish();
      try {
        const activeClient = await ensureClient();
        await activeClient.request("account/login/cancel", { loginId });
        logger.info(undefined, "codex chatgpt login canceled", { accountId });
      } catch (error) {
        logger.warn(undefined, "codex login cancel failed", error);
      }
    },
    async logout(): Promise<void> {
      const activeClient = await ensureClient();
      await activeClient.request("account/logout");
      logger.info(undefined, "codex account logged out", { accountId });
      authMode = null;
      email = null;
      planType = null;
      lastLoginError = null;
      publish();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const activeClient = client;
      client = null;
      clientPromise = null;
      void activeClient?.dispose().catch(() => undefined);
    },
  };
}
