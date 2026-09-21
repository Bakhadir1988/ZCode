import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createUuid } from "@zcode/shared";
import {
  atomicWritePrivateTextFile,
  backupCorruptFile,
  CODEX_ACCOUNT_DIR_MARKER_FILE,
  isCodexAccountId,
  isPathWithinDir,
  resolveCodexAccountHomeDir,
  resolveCodexAccountsDir,
  resolveCodexAccountsFile,
  withFileLock,
} from "@zcode/shared/node";
import { createServiceLogger } from "../logger/serviceLogger.js";

const logger = createServiceLogger("codex-account-registry");

export interface CodexAccountRecord {
  readonly id: string;
  readonly label: string;
  readonly codexHome: string;
  readonly email: string | null;
  readonly planType: string | null;
  readonly disabledModels: readonly string[];
  /**
   * Доступность аккаунта для новых сессий (user preference).
   * Не связана с OAuth: false не разлогинивает и не трогает CODEX_HOME.
   */
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CodexAccountsFileData {
  readonly version: 1;
  readonly activeAccountId: string | null;
  readonly accounts: readonly CodexAccountRecord[];
}

const EMPTY_REGISTRY: CodexAccountsFileData = Object.freeze({
  version: 1,
  activeAccountId: null,
  accounts: Object.freeze([]),
});

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim().length > 0) result.push(entry);
  }
  return result;
}

function normalizeRecord(value: unknown): CodexAccountRecord | null {
  if (!isRecordLike(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const label = typeof value.label === "string" ? value.label.trim() : "";
  const codexHome = typeof value.codexHome === "string" ? value.codexHome : "";
  // 非 UUID id 的记录按受控损坏处理：整条跳过（不建 CODEX_HOME、不派生路径、
  // 不参与删除），不尝试自动"修复"id；路径安全由此在源头收口。
  if (!id || !isCodexAccountId(id) || !label || !codexHome) return null;
  return {
    id,
    label,
    codexHome,
    email: typeof value.email === "string" ? value.email : null,
    planType: typeof value.planType === "string" ? value.planType : null,
    disabledModels: normalizeStringArray(value.disabledModels),
    // Backward compatibility: в старых файлах поля нет — аккаунт доступен.
    enabled: value.enabled === false ? false : true,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
  };
}

function normalizeRegistryFile(value: unknown): CodexAccountsFileData {
  if (!isRecordLike(value)) return EMPTY_REGISTRY;
  const rawAccounts = Array.isArray(value.accounts) ? value.accounts : [];
  const accounts: CodexAccountRecord[] = [];
  const seen = new Set<string>();
  for (const raw of rawAccounts) {
    const record = normalizeRecord(raw);
    if (!record || seen.has(record.id)) continue;
    seen.add(record.id);
    accounts.push(record);
  }
  const activeAccountId =
    typeof value.activeAccountId === "string" && seen.has(value.activeAccountId)
      ? value.activeAccountId
      : null;
  return { version: 1, activeAccountId, accounts };
}

/**
 * Codex 账号注册表（无凭据元数据）。
 *
 * - 文件：`<dataBase>/.zcode/v2/codex/accounts/accounts.json`；mutate 的
 *   读取-变更-写入整体在文件锁内，原子落盘，并发 mutate 不丢更新。
 * - 损坏文件备份后视为空注册表（凭据在各 CODEX_HOME，不受影响）。
 * - 目录名永远是 UUID；email/凭据不进入路径。
 */
export class CodexAccountRegistry {
  readonly #accountsFile: string;
  readonly #accountsDir: string;
  readonly #dataBaseDir: string;

  constructor(dataBaseDir: string) {
    this.#dataBaseDir = dataBaseDir;
    this.#accountsDir = resolveCodexAccountsDir(dataBaseDir);
    this.#accountsFile = resolveCodexAccountsFile(dataBaseDir);
  }

  get accountsDir(): string {
    return this.#accountsDir;
  }

  get accountsFile(): string {
    return this.#accountsFile;
  }

  homeFor(accountId: string): string {
    return resolveCodexAccountHomeDir(this.#dataBaseDir, accountId);
  }

  async read(): Promise<CodexAccountsFileData> {
    let raw: string;
    try {
      raw = await readFile(this.#accountsFile, "utf-8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return EMPTY_REGISTRY;
      throw error;
    }
    try {
      return normalizeRegistryFile(JSON.parse(raw));
    } catch (error) {
      logger.warn(undefined, "codex accounts file corrupt, backing up", error);
      await backupCorruptFile(this.#accountsFile).catch(() => undefined);
      return EMPTY_REGISTRY;
    }
  }

  async write(data: CodexAccountsFileData): Promise<void> {
    await mkdir(this.#accountsDir, { recursive: true });
    await withFileLock(this.#accountsFile, () => this.#writeFile(data));
  }

  /** 锁内的实际落盘；调用方必须已持有 accountsFile 的文件锁。 */
  async #writeFile(data: CodexAccountsFileData): Promise<void> {
    const normalized: CodexAccountsFileData = {
      version: 1,
      activeAccountId: data.activeAccountId,
      accounts: data.accounts.map((account) => ({
        ...account,
        disabledModels: [...account.disabledModels],
      })),
    };
    await atomicWritePrivateTextFile(
      this.#accountsFile,
      `${JSON.stringify(normalized, null, 2)}\n`,
    );
  }

  /** 创建账号记录 + 隔离目录（含 marker 文件，用于安全删除判定）。 */
  async createAccount(label: string): Promise<CodexAccountRecord> {
    const id = createUuid();
    const codexHome = this.homeFor(id);
    await mkdir(codexHome, { recursive: true });
    await writeFile(`${codexHome}/${CODEX_ACCOUNT_DIR_MARKER_FILE}`, `${id}\n`, "utf-8").catch(
      () => undefined,
    );
    const now = Date.now();
    const record: CodexAccountRecord = {
      id,
      label: label.trim() || defaultAccountLabel(await this.read().catch(() => EMPTY_REGISTRY)),
      codexHome,
      email: null,
      planType: null,
      disabledModels: [],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    await this.mutate((data) => ({
      ...data,
      activeAccountId: data.activeAccountId ?? id,
      accounts: [...data.accounts, record],
    }));
    return record;
  }

  async mutate(
    update: (data: CodexAccountsFileData) => CodexAccountsFileData,
  ): Promise<CodexAccountsFileData> {
    await mkdir(this.#accountsDir, { recursive: true });
    // read→update→write 必须整体持锁：锁只包住 write 时，两个并发 mutate
    //（如同时 setAccountEnabled 与 setModelEnabled）会基于同一快照各写各的，
    // 后写者覆盖先写者，造成 lost update。
    return withFileLock(this.#accountsFile, async () => {
      const current = await this.read();
      // Repair читает raw-значение до normalize: normalize молча превращает
      // устаревший (указывающий на удалённый аккаунт) id в null, и по
      // нормализованному значению нельзя отличить "явный null" от "stale id".
      const raw = update(current);
      const next = normalizeRegistryFile(raw);
      const rawActive = raw.activeAccountId;
      // active 必须指向现存账号；删除 active 时由调用方先指定替补。
      // 显式 null（无可用 default）必须保留——不能强行升格第一个账号，
      // 否则"关闭唯一 enabled 账号"会把 default 塞回一个 disabled 账号。
      const fixed: CodexAccountsFileData = {
        ...next,
        activeAccountId:
          rawActive === null
            ? null
            : typeof rawActive === "string" && next.accounts.some((account) => account.id === rawActive)
              ? rawActive
              : (next.accounts[0]?.id ?? null),
      };
      await this.#writeFile(fixed);
      return fixed;
    });
  }

  /**
   * 安全删除账号隔离目录：仅当目标严格位于 accountsDir 之内
   * 且包含我们的 marker 文件；`~/.codex` 不可能落入该目录。
   */
  async removeAccountHome(codexHome: string): Promise<boolean> {
    if (!isPathWithinDir(this.#accountsDir, codexHome)) {
      logger.warn(undefined, "refusing to delete codex home outside accounts dir", { codexHome });
      return false;
    }
    try {
      await readFile(`${codexHome}/${CODEX_ACCOUNT_DIR_MARKER_FILE}`, "utf-8");
    } catch {
      logger.warn(undefined, "refusing to delete codex home without marker file", { codexHome });
      return false;
    }
    await rm(codexHome, { recursive: true, force: true });
    return true;
  }
}

function defaultAccountLabel(data: CodexAccountsFileData): string {
  if (data.accounts.length === 0) return "Personal";
  return `Account ${data.accounts.length + 1}`;
}

