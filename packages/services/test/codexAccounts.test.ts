import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createCodexService } from "../src/codex/codexService.js";
import {
  CODEX_ACCOUNT_DIR_MARKER_FILE,
  resolveCodexAccountHomeDir,
  resolveCodexAccountsDir,
  resolveCodexAccountsFile,
} from "@zcode/shared/node";
import type { CodexAccountsState } from "@zcode/shared";

const FAKE_SERVER_PATH = fileURLToPath(
  new URL("./fixtures/fakeCodexAppServer.mjs", import.meta.url),
);

interface ServiceOptions {
  tracePath?: string;
  scenarioFile?: string;
}

async function createTempDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "codex-accounts-test-"));
}

function createService(dir: string, options: ServiceOptions = {}) {
  const env: Record<string, string> = {};
  if (options.tracePath) env.FAKE_CODEX_TRACE_FILE = options.tracePath;
  if (options.scenarioFile) env.FAKE_CODEX_SCENARIO_FILE = options.scenarioFile;
  return createCodexService({
    command: process.execPath,
    args: [FAKE_SERVER_PATH],
    env,
    dataBaseDir: dir,
    requestTimeoutMs: 10_000,
    initializeTimeoutMs: 10_000,
  });
}

function waitForState(
  service: ReturnType<typeof createCodexService>,
  predicate: (state: CodexAccountsState) => boolean,
  timeoutMs = 10_000,
): Promise<CodexAccountsState> {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      disposable.dispose();
      reject(new Error("timeout waiting for codex accounts state"));
    }, timeoutMs);
    const finish = (state: CodexAccountsState) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      disposable.dispose();
      resolve(state);
    };
    const disposable = service.onDidChange((state) => {
      if (predicate(state)) finish(state);
    });
    // Подписка могла опоздать к уже наступившему состоянию — проверяем текущее.
    service
      .getState()
      .then((state) => {
        if (predicate(state)) finish(state);
      })
      .catch(() => undefined);
  });
}

async function loginConnectedAccount(
  service: ReturnType<typeof createCodexService>,
  label?: string,
): Promise<string> {
  const { accountId, authUrl } = await service.startChatGptLogin(
    label === undefined ? undefined : { label },
  );
  assert.ok(authUrl.startsWith("https://auth.example.com/"));
  await waitForState(service, (state) =>
    state.accounts.some((account) => account.id === accountId && account.connected),
  );
  return accountId;
}

async function readTraceHomes(tracePath: string): Promise<(string | null)[]> {
  const raw = await readFile(tracePath, "utf-8").catch(() => "");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { codexHome?: unknown }).codexHome ?? null);
}

test("login creates an account with isolated CODEX_HOME and becomes active", async () => {
  const dir = await createTempDataDir();
  try {
    const service = createService(dir);
    try {
      const accountId = await loginConnectedAccount(service, "Personal");
      const state = await service.getState();
      assert.equal(state.accounts.length, 1);
      assert.equal(state.activeAccountId, accountId);
      const account = state.accounts[0]!;
      assert.equal(account.label, "Personal");
      assert.equal(account.email, "user@example.com");
      assert.equal(account.planType, "plus");
      // UUID 目录，非 email；marker 文件存在。
      const accountsDir = resolveCodexAccountsDir(dir);
      assert.ok(accountId.length >= 8);
      await stat(join(accountsDir, accountId, CODEX_ACCOUNT_DIR_MARKER_FILE));
      // 注册表无凭据。
      const registryRaw = await readFile(join(accountsDir, "accounts.json"), "utf-8");
      assert.ok(!registryRaw.includes("token"));
      assert.ok(!registryRaw.includes("authUrl"));
    } finally {
      service.disposeAll();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("second login gets a distinct home; both accounts stay connected", async () => {
  const dir = await createTempDataDir();
  const tracePath = join(dir, "trace.jsonl");
  try {
    const service = createService(dir, { tracePath });
    try {
      const firstId = await loginConnectedAccount(service, "Personal");
      const secondId = await loginConnectedAccount(service, "Work");
      assert.notEqual(firstId, secondId);
      const state = await service.getState();
      assert.equal(state.accounts.length, 2);
      assert.ok(state.accounts.every((account) => account.connected));
      assert.equal(state.activeAccountId, firstId);
      const homes = (await readTraceHomes(tracePath)).filter(
        (home): home is string => typeof home === "string",
      );
      const uniqueHomes = new Set(homes);
      assert.ok(uniqueHomes.size >= 2, "each account runtime sees its own CODEX_HOME");
      for (const home of uniqueHomes) {
        assert.ok(home.startsWith(resolveCodexAccountsDir(dir)));
        const basename = home.split(/[/\\]/).at(-1) ?? "";
        assert.ok(!basename.includes("@"), "home dir must not be derived from email");
      }
    } finally {
      service.disposeAll();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("accounts persist across service restarts", async () => {
  const dir = await createTempDataDir();
  try {
    const first = createService(dir);
    let firstId = "";
    try {
      firstId = await loginConnectedAccount(first, "Personal");
      await first.setModelEnabled(firstId, "gpt-5.6-luna", false);
    } finally {
      first.disposeAll();
    }
    const second = createService(dir);
    try {
      const state = await second.getState();
      assert.equal(state.accounts.length, 1);
      assert.equal(state.accounts[0]?.id, firstId);
      assert.equal(state.activeAccountId, firstId);
      assert.deepEqual(state.accounts[0]?.disabledModels, ["gpt-5.6-luna"]);
    } finally {
      second.disposeAll();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setActiveAccount switches the default without touching sessions state", async () => {
  const dir = await createTempDataDir();
  try {
    const service = createService(dir);
    try {
      const firstId = await loginConnectedAccount(service, "Personal");
      const secondId = await loginConnectedAccount(service, "Work");
      const switched = await service.setActiveAccount(secondId);
      assert.equal(switched.activeAccountId, secondId);
      assert.ok(switched.accounts.every((account) => account.connected));
      await assert.rejects(service.setActiveAccount("no-such-account"));
      const unchanged = await service.getState();
      assert.equal(unchanged.activeAccountId, secondId);
      assert.ok(unchanged.accounts.some((account) => account.id === firstId));
    } finally {
      service.disposeAll();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("switching the default keeps both accounts connected with independent model toggles", async () => {
  const dir = await createTempDataDir();
  try {
    const service = createService(dir);
    try {
      const firstId = await loginConnectedAccount(service, "Personal");
      const secondId = await loginConnectedAccount(service, "Work");
      await service.setModelEnabled(firstId, "gpt-5.6-luna", false);
      // Default 切到第二个账号：两个账号都必须保持可用（default 不等于"关掉其他账号"），
      // 且各自 disabledModels 互不受影响。
      const switched = await service.setActiveAccount(secondId);
      assert.equal(switched.activeAccountId, secondId);
      assert.ok(
        switched.accounts.every((account) => account.connected),
        "switching the default must not disconnect any account",
      );
      assert.deepEqual(
        switched.accounts.find((account) => account.id === firstId)?.disabledModels,
        ["gpt-5.6-luna"],
      );
      assert.deepEqual(
        switched.accounts.find((account) => account.id === secondId)?.disabledModels,
        [],
      );
      // 同一模型在两个账号下独立开关（accountId+modelId 键）。
      await service.setModelEnabled(secondId, "gpt-5.6-luna", false);
      await service.setModelEnabled(firstId, "gpt-5.6-luna", true);
      const final = await service.getState();
      assert.deepEqual(
        final.accounts.find((account) => account.id === firstId)?.disabledModels,
        [],
        "A/modelX OFF must not leak into B/modelX",
      );
      assert.deepEqual(
        final.accounts.find((account) => account.id === secondId)?.disabledModels,
        ["gpt-5.6-luna"],
      );
    } finally {
      service.disposeAll();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("disabling an account keeps it connected and never touches its CODEX_HOME", async () => {
  const dir = await createTempDataDir();
  try {
    const service = createService(dir);
    try {
      const firstId = await loginConnectedAccount(service, "Personal");
      const secondId = await loginConnectedAccount(service, "Work");
      const disabled = await service.setAccountEnabled(firstId, false);
      const first = disabled.accounts.find((account) => account.id === firstId)!;
      const second = disabled.accounts.find((account) => account.id === secondId)!;
      // 只是一个可用性偏好：OAuth 保持连接，注册表记录和隔离目录原样保留。
      assert.equal(first.enabled, false);
      assert.equal(first.connected, true, "disabled account stays connected (no logout)");
      assert.equal(second.enabled, true);
      assert.equal(disabled.activeAccountId, secondId, "default moves off the disabled account");
      const accountsDir = resolveCodexAccountsDir(dir);
      await stat(join(accountsDir, firstId, CODEX_ACCOUNT_DIR_MARKER_FILE));
      const registryRaw = await readFile(join(accountsDir, "accounts.json"), "utf-8");
      const parsedRegistry = JSON.parse(registryRaw) as { accounts: { id: string }[] };
      assert.equal(parsedRegistry.accounts.length, 2, "disabled account record is kept");

      // 重新启用不需要新的 OAuth 登录：同一账号恢复可用并保持已连接。
      const reEnabled = await service.setAccountEnabled(firstId, true);
      const reEnabledFirst = reEnabled.accounts.find((account) => account.id === firstId)!;
      assert.equal(reEnabledFirst.enabled, true);
      assert.equal(reEnabledFirst.connected, true);
      assert.equal(reEnabledFirst.email, "user@example.com", "same credentials, no re-login");
      // 重新启用不会自动夺回 default。
      assert.equal(reEnabled.activeAccountId, secondId);
    } finally {
      service.disposeAll();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("disabling the default promotes the first other enabled account, not a disabled one", async () => {
  const dir = await createTempDataDir();
  try {
    const service = createService(dir);
    try {
      const firstId = await loginConnectedAccount(service, "Personal");
      const secondId = await loginConnectedAccount(service, "Work");
      const thirdId = await loginConnectedAccount(service, "Third");
      // default=A；关掉 A → 第一个 enabled 的 B 升格。
      const state = await service.getState();
      assert.equal(state.activeAccountId, firstId);
      const afterA = await service.setAccountEnabled(firstId, false);
      assert.equal(afterA.activeAccountId, secondId);
      // 关掉 B（现 default）→ 跳过 disabled 的 A，升格 C。
      const afterB = await service.setAccountEnabled(secondId, false);
      assert.equal(afterB.activeAccountId, thirdId);
      // A、B 重新启用也不改 default（不自动恢复）。
      await service.setAccountEnabled(firstId, true);
      await service.setAccountEnabled(secondId, true);
      const restored = await service.getState();
      assert.equal(restored.activeAccountId, thirdId);
      assert.ok(restored.accounts.every((account) => account.enabled));
    } finally {
      service.disposeAll();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("disabling the only enabled account leaves the default null", async () => {
  const dir = await createTempDataDir();
  try {
    const service = createService(dir);
    try {
      const onlyId = await loginConnectedAccount(service, "Personal");
      const disabled = await service.setAccountEnabled(onlyId, false);
      assert.equal(disabled.activeAccountId, null, "no enabled candidate → default is null");
      // 重新启用不自动恢复 default（不把账号塞回 default）。
      const reEnabled = await service.setAccountEnabled(onlyId, true);
      assert.equal(reEnabled.activeAccountId, null);
      assert.equal(reEnabled.accounts[0]?.enabled, true);
    } finally {
      service.disposeAll();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("enabled=false persists across service restarts", async () => {
  const dir = await createTempDataDir();
  try {
    const first = createService(dir);
    let firstId = "";
    try {
      firstId = await loginConnectedAccount(first, "Personal");
      await first.setAccountEnabled(firstId, false);
    } finally {
      first.disposeAll();
    }
    const second = createService(dir);
    try {
      const state = await second.getState();
      assert.equal(state.accounts.length, 1);
      assert.equal(state.accounts[0]?.enabled, false);
      assert.equal(state.accounts[0]?.connected, true, "re-enable works without new OAuth");
    } finally {
      second.disposeAll();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy account records without enabled default to enabled", async () => {
  const dir = await createTempDataDir();
  try {
    const accountsDir = resolveCodexAccountsDir(dir);
    await mkdir(accountsDir, { recursive: true });
    const legacyAccountId = "1b0e5a2e-9c6d-4a17-8f2b-3d51c0a97e42";
    const legacyHome = resolveCodexAccountHomeDir(dir, legacyAccountId);
    await mkdir(legacyHome, { recursive: true });
    await writeFile(
      resolveCodexAccountsFile(dir),
      JSON.stringify({
        version: 1,
        activeAccountId: legacyAccountId,
        accounts: [
          {
            id: legacyAccountId,
            label: "Personal",
            codexHome: legacyHome,
            email: "legacy@example.com",
            planType: "plus",
            disabledModels: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    );
    const service = createService(dir);
    try {
      const state = await service.getState();
      assert.equal(state.accounts.length, 1);
      assert.equal(state.accounts[0]?.enabled, true, "missing enabled normalizes to true");
      assert.equal(state.activeAccountId, legacyAccountId);
    } finally {
      service.disposeAll();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent registry mutations do not lose updates", async () => {
  const dir = await createTempDataDir();
  try {
    const service = createService(dir);
    try {
      const accountId = await loginConnectedAccount(service, "Personal");
      // 并发 mutate（toggle × 8 + default 切换）必须全部落盘：read→update→write
      // 整体持锁，任何一次都不允许基于过期快照覆盖其余更新。
      const toggles = Array.from({ length: 8 }, (_, index) =>
        service.setModelEnabled(accountId, `model-${index}`, false),
      );
      await Promise.all(toggles);
      const state = await service.getState();
      const account = state.accounts.find((candidate) => candidate.id === accountId);
      assert.equal(
        account?.disabledModels.length,
        8,
        "all concurrent toggles must persist (no lost update)",
      );
    } finally {
      service.disposeAll();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registry records with non-UUID account ids are skipped without filesystem effects", async () => {
  const dir = await createTempDataDir();
  try {
    const accountsDir = resolveCodexAccountsDir(dir);
    await mkdir(accountsDir, { recursive: true });
    const validId = "2c1f6b3f-8d7e-4b26-9a3c-4e62d1b88f53";
    await writeFile(
      resolveCodexAccountsFile(dir),
      JSON.stringify({
        version: 1,
        activeAccountId: "..",
        accounts: [
          { id: "..", label: "Traversal", codexHome: join(accountsDir, ".."), email: null },
          { id: "foo/bar", label: "Slash", codexHome: join(accountsDir, "foo/bar"), email: null },
          { id: "not-a-uuid", label: "Arbitrary", codexHome: join(accountsDir, "not-a-uuid"), email: null },
          {
            id: validId,
            label: "Personal",
            codexHome: resolveCodexAccountHomeDir(dir, validId),
            email: "valid@example.com",
            planType: "plus",
            disabledModels: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    );
    const service = createService(dir);
    try {
      const state = await service.getState();
      // 无效记录按受控损坏跳过：只剩合法 UUID 账号，active 不指向被跳过的 id。
      assert.equal(state.accounts.length, 1);
      assert.equal(state.accounts[0]?.id, validId);
      // active 指向被跳过的无效记录时归零，不会被替换成剩余账号。
      assert.equal(state.activeAccountId, null);
      // 无效 id 从不创建目录：accounts 根下只有合法账号目录（由 runtime 惰性创建）。
      const entries = await readdir(accountsDir);
      const accountDirs = entries.filter((entry) => entry !== "accounts.json");
      assert.ok(
        accountDirs.every((entry) => entry === validId),
        `no home may be created for invalid ids, got: ${JSON.stringify(accountDirs)}`,
      );
    } finally {
      service.disposeAll();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("logout removes only its own account, home and runtime", async () => {
  const dir = await createTempDataDir();
  try {
    const service = createService(dir);
    try {
      const firstId = await loginConnectedAccount(service, "Personal");
      const secondId = await loginConnectedAccount(service, "Work");
      await service.setActiveAccount(firstId);
      const afterLogout = await service.logout(firstId);
      assert.equal(afterLogout.accounts.length, 1);
      assert.equal(afterLogout.accounts[0]?.id, secondId);
      assert.equal(afterLogout.activeAccountId, secondId);
      assert.ok(afterLogout.accounts[0]?.connected, "other account stays connected");
      const accountsDir = resolveCodexAccountsDir(dir);
      await assert.rejects(stat(join(accountsDir, firstId)));
      await stat(join(accountsDir, secondId, CODEX_ACCOUNT_DIR_MARKER_FILE));
    } finally {
      service.disposeAll();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unknown account ids fail loudly", async () => {
  const dir = await createTempDataDir();
  try {
    const service = createService(dir);
    try {
      await assert.rejects(service.logout("missing"));
      await assert.rejects(service.setActiveAccount("missing"));
      await assert.rejects(service.setModelEnabled("missing", "model-x", false));
      await assert.rejects(service.listModels("missing"));
      await assert.rejects(service.cancelPendingLogin("missing"));
      await assert.rejects(service.setModelEnabled("missing", "   ", true));
    } finally {
      service.disposeAll();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("one account runtime crashing leaves the other account usable", async () => {
  const dir = await createTempDataDir();
  const tracePath = join(dir, "trace.jsonl");
  const { writeFile, rm: removeFile } = await import("node:fs/promises");
  try {
    const service = createService(dir, { tracePath });
    try {
      const firstId = await loginConnectedAccount(service, "Personal");
      const { accountId: secondId } = await service.startChatGptLogin({ label: "Work" });
      await waitForState(service, (state) =>
        state.accounts.some((account) => account.id === secondId && account.connected),
      );
      const homes = (await readTraceHomes(tracePath)).filter(
        (home): home is string => typeof home === "string",
      );
      const secondHome = homes.find((home) => home.endsWith(secondId));
      assert.ok(secondHome, "second account home must be traced");
      // Роняем процесс второго аккаунта; первый обязан остаться connected.
      await writeFile(join(secondHome, "crash-now"), "1\n");
      const crashed = await waitForState(
        service,
        (state) =>
          state.accounts.some(
            (account) => account.id === secondId && account.runtime === "unavailable",
          ) &&
          state.accounts.some((account) => account.id === firstId && account.connected),
        15_000,
      );
      assert.ok(crashed);
      // Восстановление: убираем триггер, следующий запрос перезапускает runtime.
      await removeFile(join(secondHome, "crash-now"), { force: true });
      const recovered = await waitForState(
        service,
        (state) =>
          state.accounts.some((account) => account.id === secondId && account.connected),
        15_000,
      ).catch(() => null);
      if (!recovered) {
        const refreshed = await service.refresh(secondId);
        assert.ok(
          refreshed.accounts.some((account) => account.id === secondId && account.connected),
          "account recovers on next request",
        );
      }
    } finally {
      service.disposeAll();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

