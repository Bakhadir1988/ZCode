import type { Event } from "@zcode/rpc";
import type {
  CodexAccountsState,
  CodexLoginStartResult,
  CodexModelDescriptor,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * OpenAI Codex 多账号服务。
 *
 * 每个 ChatGPT 账号拥有隔离的 CODEX_HOME（`<appData>/codex/accounts/<uuid>/`）
 * 与独立的官方 App Server 进程。OAuth（PKCE/state/callback/持久化/刷新）全部由
 * 官方 runtime 承担；ZCode 只消费账户投影与 model/list，绝不接触 token。
 */
export interface ICodexService {
  /** 全量多账号状态；实现会惰性拉起各账号的 App Server runtime 以返回实时连接态。 */
  getState(): Promise<CodexAccountsState>;

  /** 当前默认账号 id（只读注册表文件，不拉起 runtime；字段名 activeAccountId 为 wire 兼容）。 */
  getActiveAccountId(): Promise<string | null>;

  /** 主动刷新一个或全部账号（account/read），并返回最新聚合状态。 */
  refresh(accountId?: string): Promise<CodexAccountsState>;

  /**
   * 为新账号发起官方 ChatGPT 浏览器登录：创建账号记录与隔离 CODEX_HOME，
   * 返回 accountId + 授权 URL（调用方用 platform.openExternal 打开）。
   */
  startChatGptLogin(input?: { label?: string }): Promise<CodexLoginStartResult & { accountId: string }>;

  /** 取消指定账号进行中的登录流程。 */
  cancelPendingLogin(accountId: string): Promise<CodexAccountsState>;

  /**
   * 登出指定账号：官方 account/logout → 释放 runtime → 删除账号元数据 →
   * 安全删除其隔离 CODEX_HOME。其他账号与 `~/.codex` 不受影响。
   */
  logout(accountId: string): Promise<CodexAccountsState>;

  /**
   * 设为默认账号（UI 概念 "Default"）：仅决定新会话与 legacy base 选择的
   * 落点；不关闭、不断开其他账号，已有会话不受影响。
   * 持久化字段仍为 activeAccountId（wire/磁盘兼容）。
   */
  setActiveAccount(accountId: string): Promise<CodexAccountsState>;

  /** 账号内模型开关（持久化 disabledModels；物理模型列表不受影响）。 */
  setModelEnabled(
    accountId: string,
    modelId: string,
    enabled: boolean,
  ): Promise<CodexAccountsState>;

  /**
   * 账号可用性开关（UI "Enabled"）：只影响新会话选择（picker 可见性），
   * 不登出、不删 CODEX_HOME/凭据；既有会话继续可用。
   * 关闭 default 时升格第一个其他可用账号；没有则 default=null。
   * 重新开启不会触发新的 OAuth 登录。
   */
  setAccountEnabled(accountId: string, enabled: boolean): Promise<CodexAccountsState>;

  /** 官方 `model/list` 指定账号的动态模型目录。 */
  listModels(accountId: string): Promise<CodexModelDescriptor[]>;

  /** 聚合状态变化事件（登录完成、登出、toggle、默认账号切换、runtime 生命周期）。 */
  readonly onDidChange: Event<CodexAccountsState>;

  /**
   * Host 生命周期钩子：终止全部官方 App Server 子进程并释放事件。
   * 与其它托管服务一致通过 dispose 链调用；不属于 Renderer 契约。
   */
  disposeAll(): void;
}

export const ICodexService = createServiceDescriptor<ICodexService>(ServiceChannels.Codex);
