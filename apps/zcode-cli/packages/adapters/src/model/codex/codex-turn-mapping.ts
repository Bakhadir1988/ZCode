import type { ModelEvent, ModelInputMessage } from "@zcode/contracts";

/** 官方 turn/start 的 input item；MVP 只投递文本（图片/文件输入暂不支持）。 */
export interface CodexTurnInputItem {
  readonly type: "text";
  readonly text: string;
}

/** 官方 turn/completed / turn 状态里已知的终态取值；未知值按失败处理并携带原文。 */
export type CodexTurnTerminalStatus = "completed" | "interrupted" | "failed";

/**
 * 从 ModelRequest.messages 提取要投递给 Codex thread 的新输入。
 *
 * Codex 是 stateful backend：ZCode 每次调用都会传全量历史，但 thread 里已经拥有
 * 之前的轮次，因此这里只取**末尾连续的 user 消息**（通常是一条），文本块直接拼接；
 * 图片/文件块按 MVP 限制显式忽略，避免把占位符文本误发给模型。
 */
export function extractCodexTurnInput(messages: readonly ModelInputMessage[]): string | null {
  let input: string | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") break;
    const text = extractUserText(message);
    if (text) input = text;
  }
  return input;
}

function extractUserText(message: ModelInputMessage): string {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  const textBlocks = content
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text.trim())
    .filter(Boolean);
  return textBlocks.join("\n\n");
}

export function toCodexTurnInputItems(text: string): readonly CodexTurnInputItem[] {
  return [{ type: "text", text }];
}

/** 官方通知名常量：thread/turn/item 事件只在这里声明，避免魔法字符串散落。 */
export const CODEX_NOTIFICATION = {
  agentMessageDelta: "item/agentMessage/delta",
  itemCompleted: "item/completed",
  turnCompleted: "turn/completed",
  error: "error",
} as const;

export const CODEX_AGENT_MESSAGE_ITEM_TYPE = "agentMessage";

/** 官方 item/agentMessage/delta 载荷的最小契约。 */
export interface CodexAgentMessageDeltaParams {
  readonly threadId?: string;
  readonly delta?: string;
}

export interface CodexTurnUsage {
  readonly input_tokens?: number;
  readonly inputTokenCount?: number;
  readonly cached_input_tokens?: number;
  readonly output_tokens?: number;
  readonly outputTokenCount?: number;
  readonly total_tokens?: number;
}

/** 官方 turn/completed 载荷的最小契约（usage 存在时透传给 ZCode）。 */
export interface CodexTurnCompletedParams {
  readonly threadId?: string;
  readonly turn?: {
    readonly id?: string;
    readonly status?: string;
    readonly error?: string | null;
    readonly usage?: CodexTurnUsage | null;
  } | null;
}

/** 官方 error 通知载荷的最小契约。 */
export interface CodexErrorNotificationParams {
  readonly threadId?: string | null;
  readonly error?: { message?: string } | string | null;
  readonly message?: string | null;
}

export function resolveCodexTurnTerminalStatus(
  status: string | undefined,
): CodexTurnTerminalStatus | null {
  if (status === "completed" || status === "interrupted" || status === "failed") return status;
  return null;
}

export function mapCodexTurnStatusToFinishReason(status: CodexTurnTerminalStatus): string {
  switch (status) {
    case "completed":
      return "stop";
    case "interrupted":
      return "cancelled";
    case "failed":
      return "error";
  }
}

/** 把官方 usage 字段（蛇形/驼峰两种历史形态）规整为 ZCode ModelUsage。 */
export function mapCodexUsageToModelUsage(usage: CodexTurnUsage): {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
} {
  const inputTokens = usage.input_tokens ?? usage.inputTokenCount;
  const outputTokens = usage.output_tokens ?? usage.outputTokenCount;
  const totalTokens = usage.total_tokens ?? sumTokens(inputTokens, outputTokens);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function sumTokens(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) return undefined;
  return (left ?? 0) + (right ?? 0);
}

export function createModelTextDeltaEvent(text: string): ModelEvent {
  return { type: "text_delta", text };
}

export function describeCodexNotificationError(params: CodexErrorNotificationParams): string {
  if (typeof params.error === "string") return params.error;
  if (params.error?.message) return params.error.message;
  if (params.message) return params.message;
  return "codex app-server reported an error";
}
