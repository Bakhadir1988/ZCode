// Fake Codex App Server（仅测试）：实现被测客户端所需的最小官方协议子集。
// 通过环境变量驱动账户状态与登录结果；日志写 stderr 不影响 stdout 协议通道。
// 多账号场景：FAKE_CODEX_SCENARIO_FILE 指向 JSON { [codexHomeBasename]: scenario }，
// 按自身 CODEX_HOME 选择场景（隔离断言就靠这个）；缺失时退回环境变量默认值。
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

function loadScenario() {
  const scenarioFile = process.env.FAKE_CODEX_SCENARIO_FILE;
  if (scenarioFile) {
    try {
      const scenarios = JSON.parse(readFileSync(scenarioFile, "utf-8"));
      const key = basename(process.env.CODEX_HOME ?? "");
      if (scenarios && typeof scenarios === "object" && scenarios[key]) {
        return scenarios[key];
      }
    } catch {
      // 场景文件损坏时退回环境变量，不让 fake 无法启动。
    }
  }
  return {
    authMode: process.env.FAKE_CODEX_AUTH_MODE,
    email: process.env.FAKE_CODEX_EMAIL,
    planType: process.env.FAKE_CODEX_PLAN_TYPE,
    loginShouldFail: process.env.FAKE_CODEX_LOGIN_FAIL === "1",
  };
}

const scenario = loadScenario();
const state = {
  authMode: scenario.authMode ?? "chatgpt",
  email: scenario.email ?? "user@example.com",
  planType: scenario.planType ?? "plus",
  loginShouldFail: scenario.loginShouldFail === true,
};

// 启动时把看到的 CODEX_HOME 写进 trace（无 trace 文件时静默跳过），
// 账号隔离断言就靠这一行。
try {
  const traceFile = process.env.FAKE_CODEX_TRACE_FILE;
  if (traceFile) {
    appendFileSync(traceFile, `${JSON.stringify({ codexHome: process.env.CODEX_HOME ?? null })}\n`);
  }
} catch {}

let nextLoginId = 1;

function accountPayload() {
  if (state.authMode === null || state.authMode === "signed-out") return null;
  return { type: state.authMode, email: state.email, planType: state.planType };
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(request, result) {
  write({ id: request.id, result });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  // Тестовый триггер аварийного завершения: файл crash-now в собственном CODEX_HOME.
  try {
    const home = process.env.CODEX_HOME ?? "";
    if (home && existsSync(join(home, "crash-now"))) {
      process.exit(7);
    }
  } catch {}
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  switch (request.method) {
    case "initialize":
      respond(request, { userAgent: "fake-codex", codexHome: "/tmp/fake-codex-home" });
      break;
    case "account/read":
      respond(request, { account: accountPayload(), requiresOpenaiAuth: true });
      break;
    case "account/login/start": {
      if (state.loginShouldFail) {
        respond(request, { type: "chatgpt" });
        setTimeout(() => {
          write({
            method: "account/login/completed",
            params: { loginId: null, success: false, error: "browser login failed" },
          });
        }, 20);
        break;
      }
      const loginId = `login-${nextLoginId++}`;
      respond(request, {
        type: "chatgpt",
        loginId,
        authUrl: `https://auth.example.com/oauth/authorize?state=${loginId}`,
      });
      setTimeout(() => {
        state.authMode = "chatgpt";
        write({
          method: "account/login/completed",
          params: { loginId, success: true, error: null },
        });
      }, 20);
      break;
    }
    case "account/login/cancel":
      state.authMode = "signed-out";
      write({
        method: "account/login/completed",
        params: { loginId: request.params?.loginId ?? null, success: false, error: "canceled" },
      });
      respond(request, { status: "canceled" });
      break;
    case "account/logout":
      state.authMode = "signed-out";
      respond(request, {});
      write({ method: "account/updated", params: { authMode: null, planType: null } });
      break;
    default:
      write({
        id: request.id,
        error: { code: -32601, message: `unknown method: ${request.method}` },
      });
  }
});
