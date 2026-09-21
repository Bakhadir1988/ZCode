/**
 * OpenAI Codex 账户连接的对外快照类型。
 *
 * 集成走官方 Codex App Server（`codex app-server` JSON-RPC，OpenAI 公开文档协议）：
 * ChatGPT OAuth（PKCE/state/localhost callback/token 持久化/刷新）全部由官方 runtime
 * 完成，ZCode 从不接触 OAuth token。这里只承载 UI 需要的账户投影（authMode/邮箱/套餐），
 * 不包含任何凭据字段。
 */

/** App Server account/updated.authMode 的已知取值；未知值原样透传，避免枚举收窄丢信息。 */
export type CodexAuthMode = string;

/** Codex App Server 子进程生命周期。 */
export type CodexRuntimeState = "starting" | "ready" | "unavailable";

export type CodexRuntimeUnavailableReason =
  | "binary-not-found"
  | "spawn-failed"
  | "handshake-failed"
  | "exited";

/**
 * Codex 账户连接快照（通过 ICodexService.onDidChange 广播）。
 *
 * - `authMode === "chatgpt"`：已用 ChatGPT 登录（UI 显示 "Connected with ChatGPT"）。
 * - `authMode === null`：未连接（官方 runtime 无已存凭据）。
 * - `pendingLoginId !== null`：浏览器登录流程进行中（Connecting）。
 * - `lastLoginError !== null`：最近一次登录失败原因（Authentication failed）。
 */
export interface CodexAccountSnapshot {
  readonly runtime: CodexRuntimeState;
  /** 仅 runtime === "unavailable" 时有意义。 */
  readonly runtimeUnavailableReason?: CodexRuntimeUnavailableReason;
  /** 面向开发者的补充信息（不含凭据）。 */
  readonly runtimeDetail?: string;
  readonly authMode: CodexAuthMode | null;
  readonly email: string | null;
  /** ChatGPT 套餐标识（如 plus/pro/business），由官方 runtime 下发。 */
  readonly planType: string | null;
  /** 进行中的官方 `account/login/start` 流程 id。 */
  readonly pendingLoginId: string | null;
  /** 最近一次登录失败/取消的展示文案；成功登录或新的流程会清除。 */
  readonly lastLoginError: string | null;
}

/** 发起 ChatGPT 登录后的授权 URL；PKCE verifier 留在官方 runtime，URL 本身可交给系统浏览器。 */
export interface CodexLoginStartResult {
  readonly authUrl: string;
}

/** 官方 model/list 条目的安全投影（不含凭据）。 */
export interface CodexModelDescriptor {
  readonly id: string;
  readonly displayName: string | null;
  readonly defaultReasoningEffort: string | null;
  readonly supportedReasoningEfforts: readonly string[];
}

/** Codex provider 家族基 id（选择器/执行层解析后缀 accountId 的锚点）。 */
export const CODEX_BASE_PROVIDER_ID = "account:openai-codex";

/** 从 providerId 解析 Codex accountId 后缀；base id 返回 null（调用方回退到 active）。 */
export function parseCodexProviderAccountId(providerId: string): string | null {
  if (providerId === CODEX_BASE_PROVIDER_ID) return null;
  const prefix = `${CODEX_BASE_PROVIDER_ID}:`;
  if (!providerId.startsWith(prefix)) return null;
  const accountId = providerId.slice(prefix.length).trim();
  return accountId.length > 0 ? accountId : null;
}

/** 为指定账号构造 registry provider 行 id。 */
export function createCodexAccountProviderId(accountId: string): string {
  return `${CODEX_BASE_PROVIDER_ID}:${accountId}`;
}

/** 单个 ChatGPT/Codex 账号的 UI 安全投影（不含凭据、不含路径）。 */
export interface CodexAccountInfo {
  readonly id: string;
  readonly label: string;
  readonly email: string | null;
  readonly planType: string | null;
  readonly authMode: CodexAuthMode | null;
  readonly connected: boolean;
  /** 用户 OFF 偏好；键天然是 accountId+modelId。 */
  readonly disabledModels: readonly string[];
  /**
   * 账号对新会话的可用性偏好（UI "Enabled" 开关）。独立于 OAuth：
   * false 只把账号从 picker 隐藏，不登出、不删 CODEX_HOME；
   * 已绑定该账号的既有会话继续可用。
   */
  readonly enabled: boolean;
  readonly runtime: CodexRuntimeState;
  readonly runtimeUnavailableReason?: CodexRuntimeUnavailableReason;
  readonly pendingLoginId: string | null;
  readonly lastLoginError: string | null;
}

/** 多账号聚合状态（单次 RPC 广播）。 */
export interface CodexAccountsState {
  readonly accounts: readonly CodexAccountInfo[];
  /**
   * 默认账号（UI 概念 "Default"）：仅用于新会话、legacy base 选择与新会话
   * 默认模型偏好。不代表其他账号被关闭；字段名保持 activeAccountId 以兼容
   * 已有 wire 协议与 accounts.json 磁盘格式。
   */
  readonly activeAccountId: string | null;
}
