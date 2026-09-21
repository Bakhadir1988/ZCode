/**
 * useCodexAccounts —— OpenAI Codex 多账号 hook。
 *
 * 数据源是官方 Codex App Server 的账号投影（ICodexService），不含任何凭据。
 * host 未注册 codex 频道（旧 wire / 远端 host）时 serviceMissing=true，UI 应隐藏入口。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CodexAccountsState } from "@zcode/shared";
import { useServices } from "./useServices.js";
import { logger } from "@/logger.js";

interface UseCodexAccountsResult {
  /** 聚合多账号状态；service missing 时为空态（调用方据 serviceMissing 隐藏入口）。 */
  readonly state: CodexAccountsState;
  /** codex 频道不可用时为 true；调用方此时不应渲染 Codex 入口。 */
  readonly serviceMissing: boolean;
  /**
   * 为新账号发起官方 ChatGPT 浏览器登录；成功返回 {accountId, authUrl}
   *（调用方用 platform.openExternal 打开），失败返回 null。
   */
  readonly startLogin: (label?: string) => Promise<{ accountId: string; authUrl: string } | null>;
  readonly cancelLogin: (accountId: string) => Promise<void>;
  readonly logout: (accountId: string) => Promise<void>;
  /**
   * 设为默认账号（仅影响新会话/legacy base 选择；其余账号保持可用，
   * 已有会话不受影响）。服务端字段仍叫 activeAccountId（wire 兼容）。
   */
  readonly setDefaultAccount: (accountId: string) => Promise<void>;
  readonly setAccountEnabled: (accountId: string, enabled: boolean) => Promise<void>;
  readonly setModelEnabled: (accountId: string, modelId: string, enabled: boolean) => Promise<void>;
  readonly refresh: (accountId?: string) => Promise<void>;
}

const EMPTY_STATE: CodexAccountsState = Object.freeze({
  accounts: Object.freeze([]),
  activeAccountId: null,
});

export function useCodexAccounts(): UseCodexAccountsResult {
  const { codexService } = useServices();
  const [state, setState] = useState<CodexAccountsState | null>(null);
  const [serviceMissing, setServiceMissing] = useState(false);
  const disposedRef = useRef(false);

  useEffect(() => {
    if (!codexService) {
      setServiceMissing(true);
      return;
    }
    disposedRef.current = false;
    let subscription: { dispose(): void } | null = null;
    try {
      subscription = codexService.onDidChange((next) => {
        if (!disposedRef.current) setState(next);
      });
    } catch (error) {
      logger.warn("[useCodexAccounts] codex channel unavailable", error);
      setServiceMissing(true);
      return;
    }
    codexService
      .getState()
      .then((initial) => {
        if (!disposedRef.current) setState(initial);
      })
      .catch((error) => {
        // 缺失频道表现为调用失败；此时隐藏入口而不是展示不可用态。
        logger.warn("[useCodexAccounts] initial codex state failed", error);
        if (!disposedRef.current) setServiceMissing(true);
      });
    return () => {
      disposedRef.current = true;
      subscription?.dispose();
    };
  }, [codexService]);

  const startLogin = useCallback(
    async (label?: string) => {
      if (!codexService) return null;
      try {
        return await codexService.startChatGptLogin(label === undefined ? {} : { label });
      } catch (error) {
        logger.warn("[useCodexAccounts] start chatgpt login failed", error);
        return null;
      }
    },
    [codexService],
  );

  const cancelLogin = useCallback(
    async (accountId: string) => {
      if (!codexService) return;
      try {
        await codexService.cancelPendingLogin(accountId);
      } catch (error) {
        logger.warn("[useCodexAccounts] cancel chatgpt login failed", error);
      }
    },
    [codexService],
  );

  const logout = useCallback(
    async (accountId: string) => {
      if (!codexService) return;
      try {
        await codexService.logout(accountId);
      } catch (error) {
        logger.warn("[useCodexAccounts] codex logout failed", error);
      }
    },
    [codexService],
  );

  const setDefaultAccount = useCallback(
    async (accountId: string) => {
      if (!codexService) return;
      try {
        await codexService.setActiveAccount(accountId);
      } catch (error) {
        logger.warn("[useCodexAccounts] set default codex account failed", error);
      }
    },
    [codexService],
  );

  const setAccountEnabled = useCallback(
    async (accountId: string, enabled: boolean) => {
      if (!codexService) return;
      try {
        await codexService.setAccountEnabled(accountId, enabled);
      } catch (error) {
        logger.warn("[useCodexAccounts] set codex account enabled failed", error);
      }
    },
    [codexService],
  );

  const setModelEnabled = useCallback(
    async (accountId: string, modelId: string, enabled: boolean) => {
      if (!codexService) return;
      try {
        await codexService.setModelEnabled(accountId, modelId, enabled);
      } catch (error) {
        logger.warn("[useCodexAccounts] set codex model enabled failed", error);
      }
    },
    [codexService],
  );

  const refresh = useCallback(
    async (accountId?: string) => {
      if (!codexService) return;
      try {
        await codexService.refresh(accountId);
      } catch (error) {
        logger.warn("[useCodexAccounts] codex refresh failed", error);
      }
    },
    [codexService],
  );

  return { state: state ?? EMPTY_STATE, serviceMissing, startLogin, cancelLogin, logout, setDefaultAccount, setAccountEnabled, setModelEnabled, refresh };
}
