import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createInterface } from "node:readline";

/** 官方文档：initialize 响应体（只取调用方关心的字段）。 */
export interface CodexInitializeResult {
  readonly userAgent?: string;
  readonly codexHome?: string;
}

export interface CodexAppServerNotification {
  readonly method: string;
  readonly params: unknown;
}

export interface CodexAppServerExitEvent {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
}

export type CodexAppServerClientLogger = (
  level: "debug" | "info" | "warn",
  message: string,
  error?: unknown,
) => void;

export interface CodexAppServerClientOptions {
  /** 可执行文件；默认 "codex"（PATH 解析）。 */
  readonly command: string;
  readonly args?: readonly string[];
  /** 传给子进程的环境变量；缺省继承宿主环境。 */
  readonly env?: NodeJS.ProcessEnv;
  readonly requestTimeoutMs?: number;
  readonly initializeTimeoutMs?: number;
  /** 注入式日志（宿主层接 createServiceLogger）；协议参数内容一律不进日志。 */
  readonly log?: CodexAppServerClientLogger;
}

interface PendingRequest {
  readonly method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface JsonRpcResponseMessage {
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotificationMessage {
  method: string;
  params?: unknown;
}

function isResponseMessage(message: unknown): message is JsonRpcResponseMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "id" in message &&
    (message as { id: unknown }).id !== undefined &&
    (("result" in (message as Record<string, unknown>)) ||
      ("error" in (message as Record<string, unknown>)))
  );
}

function isNotificationMessage(message: unknown): message is JsonRpcNotificationMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "method" in message &&
    typeof (message as { method: unknown }).method === "string" &&
    !("id" in message)
  );
}

type CodexAppServerListener<T> = (event: T) => void;

interface ListenerSubscription {
  dispose(): void;
}

/**
 * 官方 Codex App Server 的 stdio JSON-RPC 客户端
 * （协议文档：developers.openai.com/codex/app-server）。
 *
 * 职责仅限传输层：spawn 子进程、initialize 握手、请求/响应关联、通知分发与退出事件。
 * 纯 Node 传输组件，不依赖 RPC 框架与业务 logger；宿主（Host 账户服务、CLI 执行 adapter）
 * 各自持有实例并注入日志。协议数据只在 debug 级别记录，且只记方法名，不记参数——
 * 登录授权 URL 含 state/code_challenge，凭据类内容一律不进日志。
 */
export class CodexAppServerClient {
  readonly #options: Required<
    Pick<CodexAppServerClientOptions, "command" | "args" | "requestTimeoutMs" | "initializeTimeoutMs">
  > & CodexAppServerClientOptions;
  #child: ChildProcess | null = null;
  readonly #pending = new Map<string, PendingRequest>();
  #nextId = 1;
  #disposed = false;
  readonly #notificationListeners = new Set<CodexAppServerListener<CodexAppServerNotification>>();
  readonly #exitListeners = new Set<CodexAppServerListener<CodexAppServerExitEvent>>();

  constructor(options: CodexAppServerClientOptions) {
    this.#options = {
      command: options.command,
      args: options.args ?? ["app-server"],
      env: options.env,
      requestTimeoutMs: options.requestTimeoutMs ?? 20_000,
      initializeTimeoutMs: options.initializeTimeoutMs ?? 15_000,
      ...(options.log ? { log: options.log } : {}),
    };
  }

  /** 订阅官方协议通知；返回取消订阅句柄。 */
  onNotification(listener: CodexAppServerListener<CodexAppServerNotification>): ListenerSubscription {
    this.#notificationListeners.add(listener);
    return { dispose: () => this.#notificationListeners.delete(listener) };
  }

  /** 订阅子进程退出；返回取消订阅句柄。 */
  onDidExit(listener: CodexAppServerListener<CodexAppServerExitEvent>): ListenerSubscription {
    this.#exitListeners.add(listener);
    return { dispose: () => this.#exitListeners.delete(listener) };
  }

  isRunning(): boolean {
    return this.#child !== null && this.#child.exitCode === null && !this.#disposed;
  }

  async start(): Promise<CodexInitializeResult> {
    if (this.#child) {
      throw new Error("codex app-server client already started");
    }
    const child = this.#spawnChild();
    this.#child = child;

    // 握手期的退出/错误监听必须在成功后按引用移除，再换成常驻监听。
    const onHandshakeError = (error: Error) => {
      this.#rejectAllPending(this.#normalizeSpawnError(error));
      handshakeReject(this.#normalizeSpawnError(error));
    };
    const onHandshakeExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const error = new Error(`codex app-server exited (code=${code}, signal=${signal})`);
      this.#rejectAllPending(error);
      handshakeReject(error);
    };
    let handshakeReject: (error: Error) => void = () => undefined;
    const exitPromise = new Promise<never>((_, reject) => {
      handshakeReject = reject;
      child.once("error", onHandshakeError);
      child.once("exit", onHandshakeExit);
    });

    if (!child.stdout || !child.stdin) {
      const error = new Error("codex app-server stdio unavailable");
      this.#rejectAllPending(error);
      throw error;
    }

    const reader = createInterface({ input: child.stdout });
    reader.on("line", (line) => this.#handleLine(line));
    // stderr 只做排空，避免子进程写满管道卡死；内容不进生产日志。
    child.stderr?.resume();

    try {
      const result = (await Promise.race([
        this.request(
          "initialize",
          { clientInfo: { name: "zcode", title: "ZCode", version: "1.0.0" } },
          this.#options.initializeTimeoutMs,
        ),
        exitPromise,
      ])) as CodexInitializeResult;
      child.off("error", onHandshakeError);
      child.off("exit", onHandshakeExit);
      child.once("error", (error) => this.#handleExit(null, null, error));
      child.once("exit", (code, signal) => this.#handleExit(code, signal));
      this.#sendRaw({ method: "initialized", params: {} });
      return result;
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.#disposed || !this.#child) {
      return Promise.reject(new Error("codex app-server client is not running"));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(String(id));
        reject(new Error(`codex app-server request timeout: ${method}`));
      }, timeoutMs ?? this.#options.requestTimeoutMs);
      this.#pending.set(String(id), { method, resolve, reject, timer });
      this.#sendRaw({ method, ...(params === undefined ? {} : { params }), id });
    });
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#rejectAllPending(new Error("codex app-server client disposed"));
    const child = this.#child;
    this.#child = null;
    if (child) {
      try {
        child.kill();
      } catch {
        // 进程已退出时 kill 可能抛错；忽略即可。
      }
    }
    this.#notificationListeners.clear();
    this.#exitListeners.clear();
  }

  /** 官方账户只读投影：account/read（refreshToken=false 时不触发刷新）。 */
  async requestAccountRead(refreshToken: boolean): Promise<unknown> {
    return this.request("account/read", { refreshToken });
  }

  #spawnChild(): ChildProcess {
    const args = [...this.#options.args];
    // 显式清空 execArgv：父进程（如 tsx --test 或调试会话）的 V8/loader 参数
    // 对官方 codex 可执行文件毫无意义，透传反而会让 node shim 形态的子进程启动失败。
    const spawnOptions: SpawnOptions & { execArgv: string[] } = {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      execArgv: [],
      ...(this.#options.env ? { env: { ...process.env, ...this.#options.env } } : {}),
    };
    try {
      // CreateProcess 会按 PATH 搜索并把无扩展名命令解析为 .exe（官方安装包形态）。
      return spawn(this.#options.command, args, spawnOptions);
    } catch (error) {
      // npm shim 形态（codex.cmd）在无 shell 的 spawn 下会抛 EINVAL；仅对常量参数退回 shell。
      if (process.platform === "win32") {
        this.#log("debug", "direct spawn failed, retrying with shell");
        return spawn(this.#options.command, args, { ...spawnOptions, shell: true });
      }
      throw error;
    }
  }

  #handleExit(code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
    const wasRunning = this.#child !== null;
    this.#child = null;
    this.#rejectAllPending(error ?? new Error("codex app-server exited"));
    if (wasRunning) {
      this.#log("info", `codex app-server exited (code=${code}, signal=${signal})`);
      for (const listener of Array.from(this.#exitListeners)) {
        listener({ code, signal, error });
      }
    }
  }

  #handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      this.#log("debug", "dropping non-JSON line from codex app-server stdout");
      return;
    }
    if (isResponseMessage(message)) {
      const pending = this.#pending.get(String(message.id));
      if (!pending) return;
      this.#pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new Error(`codex app-server ${pending.method} failed: ${message.error.message}`),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (isNotificationMessage(message)) {
      for (const listener of Array.from(this.#notificationListeners)) {
        listener({ method: message.method, params: message.params });
      }
    }
  }

  #sendRaw(message: Record<string, unknown>): void {
    const child = this.#child;
    if (!child?.stdin || this.#disposed) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #rejectAllPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #normalizeSpawnError(error: Error): Error {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      const wrapped = new Error(`codex binary not found: ${this.#options.command}`);
      (wrapped as NodeJS.ErrnoException).code = "ENOENT";
      return wrapped;
    }
    return error;
  }

  #log(level: "debug" | "info" | "warn", message: string, error?: unknown): void {
    try {
      this.#options.log?.(level, message, error);
    } catch {
      // 日志注入回调不得影响传输层行为。
    }
  }
}

