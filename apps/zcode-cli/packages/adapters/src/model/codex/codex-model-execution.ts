import {
  ModelErrorCode,
  ModelProtocolError,
  type Model,
  type ModelEvent,
} from "@zcode/contracts";
import { parseCodexProviderAccountId } from "@zcode/shared";
import {
  CODEX_HOME_ENV,
  CodexAppServerClient,
  readCodexAccountsRegistry,
  resolveCodexAccountHomeDir,
  resolveCodexAccountsFile,
  resolveZCodeDataBaseDir,
  type CodexAppServerClientLogger,
} from "@zcode/shared/node";
import type { EnvRecord } from "../model-execution.js";
import { createModel, type ModelExecutionRequest } from "../model.js";
import type { CreateAiSdkModelOptions } from "../runner.js";
import {
  CODEX_AGENT_MESSAGE_ITEM_TYPE,
  CODEX_NOTIFICATION,
  describeCodexNotificationError,
  extractCodexTurnInput,
  mapCodexTurnStatusToFinishReason,
  mapCodexUsageToModelUsage,
  resolveCodexTurnTerminalStatus,
  toCodexTurnInputItems,
  type CodexAgentMessageDeltaParams,
  type CodexErrorNotificationParams,
  type CodexTurnCompletedParams,
} from "./codex-turn-mapping.js";

/** Codex thread 映射的持久化端口；实现方负责写入 session 元数据（不含任何凭据）。 */
export interface CodexThreadMapping {
  /** null = 无归属的 legacy 记录；执行时归属到当前选择。 */
  readonly accountId: string | null;
  readonly threadId: string | null;
}

export interface CodexThreadStorePort {
  load(): Promise<CodexThreadMapping | null>;
  save(mapping: CodexThreadMapping): Promise<void>;
  clear(): Promise<void>;
}

/** 每次 turn 需要的执行上下文；cwd 必须显式来自 workspace，不允许隐式 process cwd。 */
export interface CodexTurnExecutionContext {
  readonly cwd: string;
}

export interface CodexModelExecutionOptions {
  /** 官方 Codex 可执行文件；装配层从 ZCODE_CODEX_BIN 或缺省 "codex" 解析。 */
  readonly command: string;
  /** 子进程参数；缺省 ["app-server"]，测试注入 fake server 时覆盖。 */
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /** App data base dir（与 host 同一约定）；缺省按环境解析，测试可注入。 */
  readonly dataBaseDir?: string;
  readonly threadStore: CodexThreadStorePort;
  readonly resolveTurnContext: () => CodexTurnExecutionContext;
  readonly requestTimeoutMs?: number;
  readonly initializeTimeoutMs?: number;
  readonly log?: CodexAppServerClientLogger;
}

const DEFAULT_CODEX_TURN_TIMEOUT_MS = 20_000;
/** thread/start 会创建本地回调端口与工作目录状态，冷启动比普通请求慢。 */
const DEFAULT_CODEX_THREAD_TIMEOUT_MS = 30_000;
/** 官方 Codex 可执行文件的覆盖环境变量（apps/zcode-cli AGENTS：ZCODE_ 前缀）。 */
export const CODEX_BINARY_ENV = "ZCODE_CODEX_BIN";
const DEFAULT_CODEX_COMMAND = "codex";

/** 从环境解析官方 codex 命令；缺省依赖 PATH 解析（安装包形态是原生 .exe）。 */
export function resolveCodexCommandFromEnv(env: EnvRecord | undefined): string {
  const override = env?.[CODEX_BINARY_ENV]?.trim();
  return override || DEFAULT_CODEX_COMMAND;
}

interface AccountClientState {
  client: CodexAppServerClient | null;
  clientPromise: Promise<CodexAppServerClient> | null;
  threadId: string | null;
  threadReady: Promise<string> | null;
}

function createAccountClientState(): AccountClientState {
  return { client: null, clientPromise: null, threadId: null, threadReady: null };
}

interface AccountReadResult {
  account?: { type?: string } | null;
}

interface ThreadStartResult {
  thread?: { id?: string };
}

interface TurnStartResult {
  turn?: { id?: string; status?: string };
}

interface PendingCodexNotification {
  readonly method: string;
  readonly params: unknown;
}

/**
 * Codex App Server 执行后端（apiType = "codex-app-server"）。
 *
 * 设计边界（与官方 runtime 的契约保持一致）：
 * - Codex 拥有自己的 agent/tool loop；ZCode 是 turn 客户端，不把 Codex 工具调用
 *   翻译成 ZCode tool calls，也不把 ZCode 工具注入 Codex。
 * - ZCode session ↔ Codex thread 一一对应：首个 turn `thread/start`，后续
 *   `thread/resume` + `turn/start`；映射经注入的 threadStore 持久化（重启可续），
 *   不包含任何 OAuth 凭据。
 * - thread 不可用时抛可恢复错误，不静默新建 thread 丢失上下文。
 * - 保守沙箱：workspaceWrite（只可写 workspace cwd）+ 禁网 + 无审批旁路。
 */
export class CodexModelExecution {
  readonly #options: CodexModelExecutionOptions;
  /** 每个 Codex 账号拥有独立 client/thread（崩溃隔离），key = accountId。 */
  readonly #accountClients = new Map<string, AccountClientState>();
  #disposed = false;

  constructor(options: CodexModelExecutionOptions) {
    this.#options = options;
  }

  createModel(createOptions: CreateAiSdkModelOptions): Model {
    const execution = this;
    const properties = createOptions.modelConfig.properties;
    return createModel({
      providerId: createOptions.providerId as Model["providerId"],
      modelId: createOptions.modelId as Model["modelId"],
      ...(createOptions.displayName ? { displayName: createOptions.displayName } : {}),
      properties,
      optionSpecs: createOptions.modelConfig.optionSpecs,
      options: createOptions.options,
      executor: {
        async generateText(request: ModelExecutionRequest) {
          return execution.#collectStream(execution.#streamTurn(createOptions, request));
        },
        streamText(request: ModelExecutionRequest) {
          return execution.#streamTurn(createOptions, request);
        },
      },
    });
  }

  /** 宿主退出时回收全部账号子进程；进行中的请求会在客户端 dispose 时一起被拒绝。 */
  async disposeAll(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const states = [...this.#accountClients.values()];
    this.#accountClients.clear();
    await Promise.all(
      states.map(async (state) => {
        const client = state.client;
        state.client = null;
        state.clientPromise = null;
        state.threadReady = null;
        await client?.dispose().catch(() => undefined);
      }),
    );
  }

  async #collectStream(events: AsyncIterable<ModelEvent>) {
    let text = "";
    let finishReason = "unknown";
    let usage: Awaited<ReturnType<typeof mapCodexUsageToModelUsage>> = {};
    for await (const event of events) {
      if (event.type === "text_delta") text += event.text;
      if (event.type === "finish") {
        finishReason = event.finishReason;
        usage = event.usage;
      }
      if (event.type === "error") {
        throw event.error instanceof Error ? event.error : new Error(String(event.error));
      }
    }
    return { text, finishReason, usage };
  }

  #dataBaseDir(): string {
    return this.#options.dataBaseDir ?? resolveZCodeDataBaseDir(this.#options.env);
  }

  #stateFor(accountId: string): AccountClientState {
    let state = this.#accountClients.get(accountId);
    if (!state) {
      state = createAccountClientState();
      this.#accountClients.set(accountId, state);
    }
    return state;
  }

  /**
   * 从 providerId 解析 accountId；legacy base id 回退到 active 账号。
   * base 回退读的是注册表文件（只读、容错），保持旧会话可用。
   */
  async #resolveAccountId(providerId: string): Promise<string> {
    const parsed = parseCodexProviderAccountId(providerId);
    if (parsed) return parsed;
    const summary = await readCodexAccountsRegistry(
      resolveCodexAccountsFile(this.#dataBaseDir()),
    );
    const activeAccountId = summary?.activeAccountId ?? null;
    if (!activeAccountId) {
      throw new ModelProtocolError(
        ModelErrorCode.ProviderNotConfigured,
        "OpenAI Codex is not connected. Sign in with ChatGPT in Settings → Providers.",
        { reason: "auth_failed", retryable: false },
      );
    }
    return activeAccountId;
  }

  async #ensureClient(accountId: string): Promise<CodexAppServerClient> {
    if (this.#disposed) {
      throw new ModelProtocolError(
        ModelErrorCode.ProviderNotConfigured,
        "Codex execution backend is disposed",
      );
    }
    const state = this.#stateFor(accountId);
    if (state.client?.isRunning()) return state.client;
    if (state.clientPromise) return state.clientPromise;
    state.clientPromise = (async () => {
      const client = new CodexAppServerClient({
        command: this.#options.command,
        args: this.#options.args,
        // 账号隔离：每个账号的 runtime 看到自己的 CODEX_HOME。
        env: {
          ...this.#options.env,
          [CODEX_HOME_ENV]: resolveCodexAccountHomeDir(this.#dataBaseDir(), accountId),
        },
        requestTimeoutMs: this.#options.requestTimeoutMs ?? DEFAULT_CODEX_TURN_TIMEOUT_MS,
        initializeTimeoutMs: this.#options.initializeTimeoutMs ?? DEFAULT_CODEX_THREAD_TIMEOUT_MS,
        ...(this.#options.log ? { log: this.#options.log } : {}),
      });
      client.onDidExit(() => {
        const current = this.#accountClients.get(accountId);
        if (current?.client !== client) return;
        current.client = null;
        current.clientPromise = null;
        // thread 由官方 runtime 在账号 CODEX_HOME 下持久化，进程重启不丢；仅内存态重置。
      });
      try {
        await client.start();
      } catch (error) {
        await client.dispose().catch(() => undefined);
        throw toCodexProtocolError(error, "codex app-server is unavailable");
      }
      state.client = client;
      return client;
    })();
    try {
      return await state.clientPromise;
    } catch (error) {
      state.clientPromise = null;
      throw error;
    }
  }

  async #ensureAuthenticated(client: CodexAppServerClient): Promise<void> {
    const result = (await client.requestAccountRead(false).catch((error: unknown) => {
      throw toCodexProtocolError(error, "codex account/read failed");
    })) as AccountReadResult;
    if (!result.account?.type) {
      throw new ModelProtocolError(
        ModelErrorCode.ProviderNotConfigured,
        "OpenAI Codex is not connected. Sign in with ChatGPT in Settings → Providers.",
        { reason: "auth_failed", retryable: false },
      );
    }
  }

  async #ensureThread(accountId: string, client: CodexAppServerClient): Promise<string> {
    const state = this.#stateFor(accountId);
    if (state.threadId) return state.threadId;
    if (state.threadReady) return state.threadReady;
    state.threadReady = this.#createOrResumeThread(accountId, client);
    try {
      return await state.threadReady;
    } catch (error) {
      state.threadReady = null;
      throw error;
    }
  }

  async #createOrResumeThread(accountId: string, client: CodexAppServerClient): Promise<string> {
    const state = this.#stateFor(accountId);
    const persisted = await this.#options.threadStore.load().catch(() => null);
    const persistedThreadId = persisted?.threadId ?? null;
    const persistedAccountId = persisted?.accountId ?? null;
    if (persistedThreadId && (!persistedAccountId || persistedAccountId === accountId)) {
      // 已有映射必须显式复用；thread 丢失属可恢复错误，不能静默新建丢失上下文。
      // legacy 记录无 accountId：归属到当前选择并在成功后补写归属。
      await client.request(
        "thread/resume",
        { threadId: persistedThreadId },
        DEFAULT_CODEX_THREAD_TIMEOUT_MS,
      );
      state.threadId = persistedThreadId;
      if (!persistedAccountId) {
        await this.#options.threadStore
          .save({ accountId, threadId: persistedThreadId })
          .catch(() => undefined);
      }
      return persistedThreadId;
    }
    if (persistedThreadId && persistedAccountId && persistedAccountId !== accountId) {
      // 会话中途显式切换了账号：thread 属于旧账号，不能跨账号 resume；
      // 在新账号下开新 thread 并覆盖映射（映射始终 1:1）。
      this.#options.log?.(
        "info",
        `codex session switched accounts, starting fresh thread (old=${persistedAccountId})`,
      );
    }
    const context = this.#options.resolveTurnContext();
    const result = (await client.request(
      "thread/start",
      {
        cwd: context.cwd,
        approvalPolicy: "never",
        // 官方 thread/start 的 sandbox 是单键 map，值为 unit；workspace-write = 仅可写
        // workspace（cwd）且网络默认关闭，是 MVP 的保守策略。
        sandbox: { "workspace-write": {} },
      },
      DEFAULT_CODEX_THREAD_TIMEOUT_MS,
    )) as ThreadStartResult;
    const threadId = result.thread?.id;
    if (!threadId) {
      throw new ModelProtocolError(
        ModelErrorCode.ModelRequestFailed,
        "codex thread/start returned no thread id",
        { retryable: true },
      );
    }
    state.threadId = threadId;
    await this.#options.threadStore.save({ accountId, threadId }).catch((error: unknown) => {
      // 映射持久化失败不阻断当前 turn，但必须可见：重启后该 session 只能新开。
      this.#options.log?.("warn", "codex thread mapping persistence failed", error);
    });
    return threadId;
  }

  async *#streamTurn(
    createOptions: CreateAiSdkModelOptions,
    request: ModelExecutionRequest,
  ): AsyncGenerator<ModelEvent> {
    const abortSignal = request.abortSignal;
    if (abortSignal?.aborted) {
      throw new ModelProtocolError(ModelErrorCode.ModelRequestCancelled, "codex turn aborted", {
        reason: "cancelled",
        retryable: false,
      });
    }
    const accountId = await this.#resolveAccountId(createOptions.providerId);
    const client = await this.#ensureClient(accountId);
    await this.#ensureAuthenticated(client);
    const threadId = await this.#ensureThread(accountId, client);
    const turnInputText = extractCodexTurnInput(request.messages);
    if (!turnInputText) {
      throw new ModelProtocolError(
        ModelErrorCode.InvalidModelRequest,
        "codex turn requires a non-empty trailing user message",
        { reason: "invalid_request", retryable: false },
      );
    }

    yield { type: "start" };
    const notifications: PendingCodexNotification[] = [];
    let notifyWaiter: (() => void) | null = null;
    const wakeConsumer = () => {
      const waiter = notifyWaiter;
      notifyWaiter = null;
      waiter?.();
    };
    const subscription = client.onNotification((notification) => {
      notifications.push({ method: notification.method, params: notification.params });
      wakeConsumer();
    });
    // runtime 崩溃时不能把等待通知的 consumer 永久挂起：立即以错误终态收尾。
    let runtimeExited: Error | null = null;
    const exitSubscription = client.onDidExit((event) => {
      runtimeExited = event.error ?? new Error("codex app-server exited during turn");
      wakeConsumer();
    });
    const onAbort = () => {
      // Stop 必须走官方 turn/interrupt，不能只停听通知把 turn 留在后台跑。
      void client
        .request("turn/interrupt", { threadId })
        .catch(() => undefined);
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    try {
      await client.request(
        "turn/start",
        {
          threadId,
          input: toCodexTurnInputItems(turnInputText),
          ...(request.options.reasoningLevel ? { effort: request.options.reasoningLevel } : {}),
          ...(createOptions.modelId ? { model: createOptions.modelId } : {}),
        },
        DEFAULT_CODEX_TURN_TIMEOUT_MS,
      );
    } catch (error) {
      abortSignal?.removeEventListener("abort", onAbort);
      exitSubscription.dispose();
      subscription.dispose();
      throw toCodexProtocolError(error, "codex turn/start failed");
    }

    let agentText = "";
    try {
      while (true) {
        const notification = notifications.shift();
        if (!notification) {
          if (runtimeExited) {
            yield {
              type: "error",
              error: toCodexProtocolError(runtimeExited, "codex app-server exited during turn"),
            };
            return;
          }
          await new Promise<void>((resolve) => {
            notifyWaiter = resolve;
          });
          continue;
        }
        const event = toModelEvent({
          notification,
          threadId,
          currentAgentText: agentText,
          onAgentText: (text) => {
            agentText = text;
          },
        });
        if (!event) continue;
        if (event.kind === "stream") {
          yield event.event;
          continue;
        }
        // 终态：补齐官方 completed item 与增量流的差值，保证文本完整。
        if (event.missingText) {
          yield { type: "text_delta", text: event.missingText };
        }
        if (event.terminal) {
          yield event.terminal;
        }
        return;
      }
    } finally {
      abortSignal?.removeEventListener("abort", onAbort);
      exitSubscription.dispose();
      subscription.dispose();
      wakeConsumer();
    }
  }
}

interface TerminalEventResult {
  kind: "terminal";
  terminal?: ModelEvent;
  missingText?: string;
}

function toModelEvent(input: {
  notification: PendingCodexNotification;
  threadId: string;
  currentAgentText: string;
  onAgentText: (text: string) => void;
}): { kind: "stream"; event: ModelEvent } | TerminalEventResult | null {
  const { notification, threadId } = input;
  if (notification.method === CODEX_NOTIFICATION.agentMessageDelta) {
    const params = (notification.params ?? {}) as CodexAgentMessageDeltaParams;
    if (params.threadId && params.threadId !== threadId) return null;
    const delta = params.delta ?? "";
    if (!delta) return null;
    input.onAgentText(input.currentAgentText + delta);
    return { kind: "stream", event: { type: "text_delta", text: delta } };
  }
  if (notification.method === CODEX_NOTIFICATION.turnCompleted) {
    const params = (notification.params ?? {}) as CodexTurnCompletedParams;
    if (params.threadId && params.threadId !== threadId) return null;
    const status = resolveCodexTurnTerminalStatus(params.turn?.status);
    if (!status) return null;
    const completedText = readAgentMessageText(params);
    const missingText =
      completedText && completedText.startsWith(input.currentAgentText)
        ? completedText.slice(input.currentAgentText.length)
        : "";
    if (status === "failed") {
      return {
        kind: "terminal",
        terminal: {
          type: "error",
          error: new ModelProtocolError(
            ModelErrorCode.ModelRequestFailed,
            params.turn?.error || "codex turn failed",
            { retryable: false },
          ),
        },
      };
    }
    return {
      kind: "terminal",
      missingText,
      terminal: {
        type: "finish",
        finishReason: mapCodexTurnStatusToFinishReason(status),
        usage: params.turn?.usage ? mapCodexUsageToModelUsage(params.turn.usage) : {},
      },
    };
  }
  if (notification.method === CODEX_NOTIFICATION.error) {
    const params = (notification.params ?? {}) as CodexErrorNotificationParams;
    if (params.threadId && params.threadId !== threadId) return null;
    return {
      kind: "terminal",
      terminal: {
        type: "error",
        error: new ModelProtocolError(
          ModelErrorCode.ModelRequestFailed,
          describeCodexNotificationError(params),
          { retryable: false },
        ),
      },
    };
  }
  return null;
}

function readAgentMessageText(params: CodexTurnCompletedParams): string | null {
  const item = (params.turn as { item?: { type?: string; text?: string } } | undefined)?.item;
  if (item?.type === CODEX_AGENT_MESSAGE_ITEM_TYPE && typeof item.text === "string") {
    return item.text;
  }
  return null;
}

export function toCodexProtocolError(error: unknown, message: string): ModelProtocolError {
  if (error instanceof ModelProtocolError) return error;
  const raw = error instanceof Error ? error.message : String(error);
  const cancelled = raw.includes("aborted") || raw.includes("cancelled");
  return new ModelProtocolError(
    cancelled ? ModelErrorCode.ModelRequestCancelled : ModelErrorCode.ModelRequestFailed,
    `${message}: ${raw}`,
    {
      reason: cancelled ? "cancelled" : "unknown",
      retryable: !cancelled,
    },
  );
}
