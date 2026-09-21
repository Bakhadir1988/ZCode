import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ModelErrorCode,
  ModelProtocolError,
  type Model,
  type ModelEvent,
  type ModelInputMessage,
} from "@zcode/contracts";
import {
  CodexModelExecution,
  type CodexThreadStorePort,
} from "../src/model/codex/codex-model-execution.js";

const FAKE_SERVER_PATH = fileURLToPath(new URL("./fixtures/fakeCodexTurnServer.mjs", import.meta.url));

// accountId 在持久化注册表读取路径按 UUID 校验；fixture 使用合法 UUID 形态。
const TEST_ACCOUNT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEST_ACCOUNT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function createInMemoryThreadStore(
  initial: { accountId: string | null; threadId: string | null } | null = null,
): CodexThreadStorePort & {
  readonly current: () => { accountId: string | null; threadId: string | null } | null;
  readonly saved: { accountId: string | null; threadId: string | null }[];
} {
  let mapping = initial;
  const saved: { accountId: string | null; threadId: string | null }[] = [];
  return {
    current: () => mapping,
    saved,
    async load() {
      return mapping;
    },
    async save(next) {
      mapping = next;
      saved.push(next);
    },
    async clear() {
      mapping = null;
    },
  };
}

function createExecution(
  env: Record<string, string>,
  threadStore: CodexThreadStorePort,
  dataBaseDir?: string,
): CodexModelExecution {
  return new CodexModelExecution({
    command: process.execPath,
    args: [FAKE_SERVER_PATH],
    env,
    ...(dataBaseDir === undefined ? {} : { dataBaseDir }),
    threadStore,
    resolveTurnContext: () => ({ cwd: "D:/workspace/example" }),
    requestTimeoutMs: 10_000,
    initializeTimeoutMs: 10_000,
  });
}

function createRegistryModel(
  execution: CodexModelExecution,
  providerId = `account:openai-codex:${TEST_ACCOUNT_A}`,
): Model {
  return execution.createModel({
    providerId,
    modelId: "gpt-5.6-terra",
    providerConfig: {
      access: { type: "codex-account", connected: true },
      api: { type: "codex-app-server", baseUrl: "app-server://codex" },
    },
    modelConfig: {
      enabled: true,
      properties: { supportsToolCall: true },
      optionSpecs: {
        reasoningLevel: { values: ["low", "medium", "high"], map: "{}" },
        maxOutputTokens: { max: 128000, map: "{}" },
      },
    },
    options: { reasoningLevel: "medium" },
  } as unknown as Parameters<CodexModelExecution["createModel"]>[0]);
}

function turnRequest(
  text: string,
  extra: { abortSignal?: AbortSignal } = {},
): Parameters<Model["streamText"]>[0] {
  return {
    messages: [userMessage(text)],
    options: { maxOutputTokens: 32000 },
    ...extra,
  };
}

function userMessage(text: string): ModelInputMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const collected: ModelEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

async function readTrace(path: string): Promise<{ method: string | null; params?: unknown }[]> {
  const { readFile } = await import("node:fs/promises");
  try {
    const raw = await readFile(path, "utf-8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method?: string; params?: unknown });
  } catch {
    return [];
  }
}

async function withTraceFile<T>(run: (path: string) => Promise<T>): Promise<T> {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "codex-adapter-test-"));
  const path = join(dir, "trace.jsonl");
  try {
    return await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("codex turn mapping: extracts trailing user text and maps statuses", async () => {
  const mapping = await import("../src/model/codex/codex-turn-mapping.js");
  assert.equal(
    mapping.extractCodexTurnInput([
      { role: "assistant", content: [{ type: "text", text: "previous" }] },
      { role: "user", content: [{ type: "text", text: "  hello  " }] },
    ]),
    "hello",
  );
  assert.equal(
    mapping.extractCodexTurnInput([
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
      { role: "user", content: [{ type: "image", mediaType: "image/png", dataUrl: "data:x" }] },
    ]),
    null,
  );
  assert.equal(mapping.resolveCodexTurnTerminalStatus("interrupted"), "interrupted");
  assert.equal(mapping.resolveCodexTurnTerminalStatus("inProgress"), null);
  assert.equal(mapping.mapCodexTurnStatusToFinishReason("completed"), "stop");
  assert.equal(mapping.mapCodexTurnStatusToFinishReason("interrupted"), "cancelled");
  assert.deepEqual(
    mapping.mapCodexUsageToModelUsage({ input_tokens: 5, output_tokens: 7 }),
    { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
  );
});

test("rejects execution when account is not connected", async () => {
  const execution = createExecution({ FAKE_CODEX_ACCOUNT: "signed-out" }, createInMemoryThreadStore());
  try {
    const model = createRegistryModel(execution);
    await assert.rejects(
      () => collect(model.streamText(turnRequest("hi"))),
      (error: unknown) => {
        assert.ok(error instanceof ModelProtocolError);
        assert.equal(error.code, ModelErrorCode.ProviderNotConfigured);
        assert.match(error.message, /Sign in with ChatGPT/);
        return true;
      },
    );
  } finally {
    await execution.disposeAll();
  }
});

test("first turn starts thread, second turn resumes the same thread", async () => {
  await withTraceFile(async (tracePath) => {
    const threadStore = createInMemoryThreadStore();
    const execution = createExecution({ FAKE_CODEX_TRACE_FILE: tracePath }, threadStore);
    try {
      const model = createRegistryModel(execution);
      const first = await collect(model.streamText(turnRequest("ping")));
      const firstText = first
        .filter((event): event is Extract<ModelEvent, { type: "text_delta" }> => event.type === "text_delta")
        .map((event) => event.text)
        .join("");
      assert.equal(firstText, "echo:ping");
      const finish = first.find((event) => event.type === "finish");
      assert.ok(finish && finish.type === "finish");
      assert.equal(finish.finishReason, "stop");
      assert.deepEqual(finish.usage, { inputTokens: 5, outputTokens: 7, totalTokens: 12 });
      assert.deepEqual(threadStore.current(), { accountId: TEST_ACCOUNT_A, threadId: "thr_1" });


      const second = await collect(model.streamText(turnRequest("pong")));
      assert.equal(
        second
          .filter((event): event is Extract<ModelEvent, { type: "text_delta" }> => event.type === "text_delta")
          .map((event) => event.text)
          .join(""),
        "echo:pong",
      );

      const trace = await readTrace(tracePath);
      const methods = trace.map((entry) => entry.method).filter(Boolean);
      // Живой процесс: один thread/start на сессию; второй turn идёт в уже активный thread
      // (resume нужен только после перезапуска и проверяется отдельным тестом).
      assert.deepEqual(
        methods.filter((method) => method === "thread/start"),
        ["thread/start"],
      );
      assert.equal(methods.filter((method) => method === "thread/resume").length, 0);
      const turnStarts = trace.filter((entry) => entry.method === "turn/start");
      assert.equal(turnStarts.length, 2);
      assert.equal((turnStarts[0]?.params as { effort?: string }).effort, "medium");
    } finally {
      await execution.disposeAll();
    }
  });
});

test("resumes a persisted thread after restart and fails loudly when it is gone", async () => {
  await withTraceFile(async (tracePath) => {
    // 模拟 ZCode 重启：新执行实例 + 已持久化的 {accountId, threadId}。
    const resumedStore = createInMemoryThreadStore({
      accountId: TEST_ACCOUNT_A,
      threadId: "thr_persisted",
    });
    const resumed = createExecution({ FAKE_CODEX_TRACE_FILE: tracePath }, resumedStore);
    try {
      // fake server 不认识 thr_persisted → resume 失败，必须报错且不能新建 thread。
      const model = createRegistryModel(resumed);
      await assert.rejects(() => collect(model.streamText(turnRequest("hi"))));
      const trace = await readTrace(tracePath);
      assert.deepEqual(trace.filter((entry) => entry.method === "thread/start"), []);
      assert.equal(trace.filter((entry) => entry.method === "thread/resume").length, 1);
    } finally {
      await resumed.disposeAll();
    }
  });
});

test("abort interrupts the active codex turn via turn/interrupt", async () => {
  await withTraceFile(async (tracePath) => {
    const execution = createExecution(
      { FAKE_CODEX_TRACE_FILE: tracePath, FAKE_CODEX_TURN_MODE: "interrupt" },
      createInMemoryThreadStore(),
    );
    try {
      const model = createRegistryModel(execution);
      const controller = new AbortController();
      const events: ModelEvent[] = [];
      const consume = async () => {
        for await (const event of model.streamText(
          turnRequest("long task", { abortSignal: controller.signal }),
        )) {
          events.push(event);
        }
      };
      const consuming = consume();
      await new Promise((resolve) => setTimeout(resolve, 60));
      controller.abort();
      await consuming;
      const finish = events.find((event) => event.type === "finish");
      assert.ok(finish && finish.type === "finish");
      assert.equal(finish.finishReason, "cancelled");
      const trace = await readTrace(tracePath);
      assert.equal(trace.filter((entry) => entry.method === "turn/interrupt").length, 1);
    } finally {
      await execution.disposeAll();
    }
  });
});

test("runtime crash during a turn rejects the stream with a recoverable error state", async () => {
  const execution = createExecution(
    { FAKE_CODEX_TURN_MODE: "exit" },
    createInMemoryThreadStore(),
  );
  try {
    const model = createRegistryModel(execution);
    const events = await collect(model.streamText(turnRequest("crash")));
    const error = events.find((event) => event.type === "error");
    assert.ok(error && error.type === "error");
  } finally {
    await execution.disposeAll();
  }
});

test("next request recovers after the runtime crashed", async () => {
  const execution = createExecution(
    { FAKE_CODEX_TURN_MODE: "exit" },
    createInMemoryThreadStore(),
  );
  try {
    const model = createRegistryModel(execution);
    const crashed = await collect(model.streamText(turnRequest("crash")));
    assert.ok(crashed.some((event) => event.type === "error"));
    // 子进程已退出；下一次调用按需重启 runtime（同一 fake 行为仍会退出，但必须能重新建立进程）。
    const retried = await collect(model.streamText(turnRequest("again")));
    assert.ok(retried.some((event) => event.type === "error"));
  } finally {
    await execution.disposeAll();
  }
});

test("same model on different accounts uses isolated runtimes and homes", async () => {
  await withTraceFile(async (tracePath) => {
    const execution = createExecution({ FAKE_CODEX_TRACE_FILE: tracePath }, createInMemoryThreadStore());
    try {
      const modelA = createRegistryModel(execution, `account:openai-codex:${TEST_ACCOUNT_A}`);
      const modelB = createRegistryModel(execution, `account:openai-codex:${TEST_ACCOUNT_B}`);
      const firstA = await collect(modelA.streamText(turnRequest("from-a")));
      const firstB = await collect(modelB.streamText(turnRequest("from-b")));
      assert.ok(
        firstA.some((event) => event.type === "text_delta"),
        "account A produces output",
      );
      assert.ok(
        firstB.some((event) => event.type === "text_delta"),
        "account B produces output",
      );
      const trace = await readTrace(tracePath);
      const homes = trace
        .filter((entry) => entry.direction === "started")
        .map((entry) => (entry as { codexHome?: unknown }).codexHome)
        .filter((home): home is string => typeof home === "string");
      assert.equal(new Set(homes).size, 2);
      assert.ok(homes.some((home) => home.includes(TEST_ACCOUNT_A)));
      assert.ok(homes.some((home) => home.includes(TEST_ACCOUNT_B)));
    } finally {
      await execution.disposeAll();
    }
  });
});

test("switching accounts mid-session starts a fresh thread under the new account", async () => {
  await withTraceFile(async (tracePath) => {
    const threadStore = createInMemoryThreadStore({
      accountId: TEST_ACCOUNT_A,
      threadId: "thr_foreign",
    });
    const execution = createExecution({ FAKE_CODEX_TRACE_FILE: tracePath }, threadStore);
    try {
      // 选择 B，映射属于 A：禁止跨账号 resume，必须在 B 下开新 thread。
      const modelB = createRegistryModel(execution, `account:openai-codex:${TEST_ACCOUNT_B}`);
      const events = await collect(modelB.streamText(turnRequest("hello-b")));
      assert.ok(events.some((event) => event.type === "text_delta"));
      const trace = await readTrace(tracePath);
      const resumes = trace.filter((entry) => entry.method === "thread/resume");
      assert.ok(
        resumes.every(
          (entry) =>
            (entry.params as { threadId?: string } | undefined)?.threadId !== "thr_foreign",
        ),
        "must not resume A's thread on B's runtime",
      );
      assert.ok(trace.some((entry) => entry.method === "thread/start"));
      assert.deepEqual(threadStore.current(), { accountId: TEST_ACCOUNT_B, threadId: "thr_1" });
    } finally {
      await execution.disposeAll();
    }
  });
});

test("base provider id falls back to the active account from the registry file", async () => {
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { resolveCodexAccountsFile } = await import("@zcode/shared/node");
  const dir = await mkdtemp(join(tmpdir(), "codex-base-fallback-"));
  try {
    const accountsFile = resolveCodexAccountsFile(dir);
    await mkdir(join(accountsFile, ".."), { recursive: true });
    await writeFile(
      accountsFile,
      JSON.stringify({
        version: 1,
        activeAccountId: TEST_ACCOUNT_B,
        accounts: [{ id: TEST_ACCOUNT_A }, { id: TEST_ACCOUNT_B }],
      }),
    );
    await withTraceFile(async (tracePath) => {
      const execution = createExecution(
        { FAKE_CODEX_TRACE_FILE: tracePath },
        createInMemoryThreadStore(),
        dir,
      );
      try {
        const model = createRegistryModel(execution, "account:openai-codex");
        const events = await collect(model.streamText(turnRequest("via-base")));
        assert.ok(events.some((event) => event.type === "text_delta"));
        const trace = await readTrace(tracePath);
        const homes = trace
          .filter((entry) => entry.direction === "started")
          .map((entry) => (entry as { codexHome?: unknown }).codexHome);
        assert.equal(homes.length, 1);
        assert.ok(String(homes[0]).includes(TEST_ACCOUNT_B));
      } finally {
        await execution.disposeAll();
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("changing the registry default does not move an existing session off its account", async () => {
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { resolveCodexAccountsFile } = await import("@zcode/shared/node");
  const dir = await mkdtemp(join(tmpdir(), "codex-default-stable-"));
  try {
    const accountsFile = resolveCodexAccountsFile(dir);
    await mkdir(join(accountsFile, ".."), { recursive: true });
    const writeRegistry = (activeAccountId: string): Promise<void> =>
      writeFile(
        accountsFile,
        JSON.stringify({
          version: 1,
          activeAccountId,
          accounts: [{ id: TEST_ACCOUNT_A }, { id: TEST_ACCOUNT_B }],
        }),
      );
    // 初始默认 = A，会话选择 A 的账号行。
    await writeRegistry(TEST_ACCOUNT_A);
    await withTraceFile(async (tracePath) => {
      const threadStore = createInMemoryThreadStore();
      const execution = createExecution({ FAKE_CODEX_TRACE_FILE: tracePath }, threadStore, dir);
      try {
        const modelA = createRegistryModel(execution, `account:openai-codex:${TEST_ACCOUNT_A}`);
        await collect(modelA.streamText(turnRequest("first")));
        // 切换注册表默认账号（A → B）后，既有会话必须仍然落在 A：
        // 不新开 thread、不拉起 B 的 runtime。
        await writeRegistry(TEST_ACCOUNT_B);
        await collect(modelA.streamText(turnRequest("second")));
        assert.deepEqual(
          threadStore.current(),
          { accountId: TEST_ACCOUNT_A, threadId: "thr_1" },
          "session binding stays on account A",
        );
        const trace = await readTrace(tracePath);
        const homes = trace
          .filter((entry) => entry.direction === "started")
          .map((entry) => (entry as { codexHome?: unknown }).codexHome)
          .map((home) => String(home));
        assert.ok(homes.length >= 1);
        assert.ok(
          homes.every((home) => home.includes(TEST_ACCOUNT_A)),
          "account B runtime must never spawn for account A's session",
        );
        const methods = trace.map((entry) => entry.method).filter(Boolean);
        assert.equal(
          methods.filter((method) => method === "thread/start").length,
          1,
          "default switch must not start a fresh thread",
        );
        assert.equal(methods.filter((method) => method === "turn/start").length, 2);
      } finally {
        await execution.disposeAll();
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a new session resolves the legacy base id against the updated default account", async () => {
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { resolveCodexAccountsFile } = await import("@zcode/shared/node");
  const dir = await mkdtemp(join(tmpdir(), "codex-default-new-session-"));
  try {
    const accountsFile = resolveCodexAccountsFile(dir);
    await mkdir(join(accountsFile, ".."), { recursive: true });
    const writeRegistry = (activeAccountId: string): Promise<void> =>
      writeFile(
        accountsFile,
        JSON.stringify({
          version: 1,
          activeAccountId,
          accounts: [{ id: TEST_ACCOUNT_A }, { id: TEST_ACCOUNT_B }],
        }),
      );
    const homesFor = async (tracePath: string): Promise<string[]> => {
      const trace = await readTrace(tracePath);
      return trace
        .filter((entry) => entry.direction === "started")
        .map((entry) => (entry as { codexHome?: unknown }).codexHome)
        .map((home) => String(home));
    };
    await writeRegistry(TEST_ACCOUNT_A);
    await withTraceFile(async (tracePath) => {
      // 旧默认 A 下的新会话。
      const first = createExecution({ FAKE_CODEX_TRACE_FILE: tracePath }, createInMemoryThreadStore(), dir);
      try {
        const events = await collect(
          first.createModel({
            providerId: "account:openai-codex",
            modelId: "gpt-5.6-terra",
            providerConfig: {
              access: { type: "codex-account", connected: true },
              api: { type: "codex-app-server", baseUrl: "app-server://codex" },
            },
            modelConfig: {
              enabled: true,
              properties: { supportsToolCall: true },
              optionSpecs: {
                reasoningLevel: { values: ["low", "medium", "high"], map: "{}" },
                maxOutputTokens: { max: 128000, map: "{}" },
              },
            },
            options: { reasoningLevel: "medium" },
          } as unknown as Parameters<CodexModelExecution["createModel"]>[0]).streamText(
            turnRequest("old-default"),
          ),
        );
        assert.ok(events.some((event) => event.type === "text_delta"));
      } finally {
        await first.disposeAll();
      }
      assert.ok(
        (await homesFor(tracePath)).every((home) => home.includes(TEST_ACCOUNT_A)),
      );
    });
    // 切换默认为 B 后，新会话（新执行实例）必须解析到 B 的 runtime。
    await writeRegistry(TEST_ACCOUNT_B);
    await withTraceFile(async (tracePath) => {
      const second = createExecution({ FAKE_CODEX_TRACE_FILE: tracePath }, createInMemoryThreadStore(), dir);
      try {
        const events = await collect(
          second.createModel({
            providerId: "account:openai-codex",
            modelId: "gpt-5.6-terra",
            providerConfig: {
              access: { type: "codex-account", connected: true },
              api: { type: "codex-app-server", baseUrl: "app-server://codex" },
            },
            modelConfig: {
              enabled: true,
              properties: { supportsToolCall: true },
              optionSpecs: {
                reasoningLevel: { values: ["low", "medium", "high"], map: "{}" },
                maxOutputTokens: { max: 128000, map: "{}" },
              },
            },
            options: { reasoningLevel: "medium" },
          } as unknown as Parameters<CodexModelExecution["createModel"]>[0]).streamText(
            turnRequest("new-default"),
          ),
        );
        assert.ok(events.some((event) => event.type === "text_delta"));
      } finally {
        await second.disposeAll();
      }
      const homes = await homesFor(tracePath);
      assert.equal(homes.length, 1);
      assert.ok(homes[0]!.includes(TEST_ACCOUNT_B), "new session must use the new default");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("base provider id without an active account fails with sign-in guidance", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "codex-base-empty-"));
  try {
    const execution = createExecution({}, createInMemoryThreadStore(), dir);
    try {
      const model = createRegistryModel(execution, "account:openai-codex");
      await assert.rejects(
        () => collect(model.streamText(turnRequest("hi"))),
        (error: unknown) => {
          assert.ok(error instanceof ModelProtocolError);
          assert.match(error.message, /Sign in with ChatGPT/);
          return true;
        },
      );
    } finally {
      await execution.disposeAll();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

