// Fake Codex App Server для тестов execution backend: реализует initialize / account/read /
// thread/start / thread/resume / turn/start / turn/interrupt и стримит нотификации.
// Все полученные методы пишутся в FAKE_CODEX_TRACE_FILE (JSONL) для проверки lifecycle.
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

const traceFile = process.env.FAKE_CODEX_TRACE_FILE;

function trace(entry) {
  if (!traceFile) return;
  try {
    appendFileSync(traceFile, `${JSON.stringify(entry)}\n`);
  } catch {}
}

// Стартовый след с CODEX_HOME — изоляция аккаунтов проверяется по нему.
trace({ direction: "started", codexHome: process.env.CODEX_HOME ?? null });

let threadCounter = 0;
const threads = new Map();
let activeTurn = null;

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(request, result) {
  write({ id: request.id, result });
}

function respondError(request, message) {
  write({ id: request.id, error: { code: -32000, message } });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const method = request.method;
  trace({ direction: "in", method, params: request.params ?? null });
  switch (method) {
    case "initialize":
      respond(request, { userAgent: "fake-codex", codexHome: "/tmp/fake-codex-home" });
      break;
    case "account/read": {
      const mode = process.env.FAKE_CODEX_ACCOUNT ?? "chatgpt";
      respond(request, {
        account: mode === "chatgpt" ? { type: "chatgpt", email: "user@example.com", planType: "plus" } : null,
        requiresOpenaiAuth: true,
      });
      break;
    }
    case "thread/start": {
      threadCounter += 1;
      const threadId = `thr_${threadCounter}`;
      threads.set(threadId, { cwd: request.params?.cwd ?? null });
      respond(request, { thread: { id: threadId, sessionId: threadId } });
      break;
    }
    case "thread/resume": {
      const threadId = request.params?.threadId;
      if (process.env.FAKE_CODEX_THREAD_RESUME_FAIL === "1" || !threads.has(threadId)) {
        respondError(request, `thread not found: ${threadId}`);
        break;
      }
      respond(request, { thread: { id: threadId, sessionId: threadId } });
      break;
    }
    case "turn/start": {
      const threadId = request.params?.threadId;
      const turnId = `turn_${threadCounter}_${Date.now()}`;
      activeTurn = { threadId, turnId };
      respond(request, { turn: { id: turnId, status: "inProgress" } });
      const mode = process.env.FAKE_CODEX_TURN_MODE ?? "ok";
      if (mode === "exit") {
        setTimeout(() => process.exit(7), 30);
        break;
      }
      if (mode === "interrupt") {
        // Ждём turn/interrupt; завершение отправит обработчик interrupt.
        break;
      }
      setTimeout(() => {
        write({
          method: "item/agentMessage/delta",
          params: { threadId, turnId, delta: `echo:` },
        });
        write({
          method: "item/agentMessage/delta",
          params: { threadId, turnId, delta: request.params?.input?.[0]?.text ?? "" },
        });
        write({
          method: "turn/completed",
          params: {
            threadId,
            turn: {
              id: turnId,
              status: "completed",
              usage: { input_tokens: 5, output_tokens: 7 },
            },
          },
        });
        activeTurn = null;
      }, 20);
      break;
    }
    case "turn/interrupt": {
      trace({ direction: "interrupt", threadId: request.params?.threadId });
      const pending = activeTurn;
      activeTurn = null;
      respond(request, {});
      if (pending) {
        write({
          method: "turn/completed",
          params: { threadId: pending.threadId, turn: { id: pending.turnId, status: "interrupted" } },
        });
      }
      break;
    }
    default:
      respondError(request, `unknown method: ${method}`);
  }
});
