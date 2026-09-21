import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { readFile } from "node:fs/promises";

/**
 * Codex 多账号目录布局（host 与 CLI runtime 共用同一纯函数，保证一致）。
 *
 * - 注册表：`<base>/.zcode/v2/codex/accounts/accounts.json`
 * - 账号隔离 CODEX_HOME：`<base>/.zcode/v2/codex/accounts/<accountId>/`
 * - accountId 永远是服务端生成的 UUID；email/凭据不进入路径。
 * - `~/.codex` 既不读取也不修改。
 */
export const CODEX_HOME_ENV = "CODEX_HOME";
export const ZCODE_DATA_BASE_DIR_ENV = "ZCODE_DATA_BASE_DIR";
export const CODEX_ACCOUNT_DIR_MARKER_FILE = ".zcode-codex-account";

/**
 * accountId 必须是 createUuid 生成的 UUID 形态（8-4-4-4-12 hex）。
 * 注册表按 id 直接拼接 CODEX_HOME 路径，非 UUID（`..`、`../foo`、`foo/bar`、
 * 任意字符串）的记录一律跳过：不建目录、不派生路径、不做删除。
 */
const CODEX_ACCOUNT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCodexAccountId(value: string): boolean {
  return CODEX_ACCOUNT_ID_PATTERN.test(value);
}

/** 与 services/paths.getDataBaseDir 默认分支一致：env 优先，否则 homedir。 */
export function resolveZCodeDataBaseDir(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string {
  return env[ZCODE_DATA_BASE_DIR_ENV]?.trim() || homedir();
}

export function resolveCodexAccountsDir(dataBaseDir: string): string {
  return join(dataBaseDir, ".zcode", "v2", "codex", "accounts");
}

export function resolveCodexAccountsFile(dataBaseDir: string): string {
  return join(resolveCodexAccountsDir(dataBaseDir), "accounts.json");
}

export function resolveCodexAccountHomeDir(dataBaseDir: string, accountId: string): string {
  return join(resolveCodexAccountsDir(dataBaseDir), accountId);
}

/** 删除账号目录前的安全门：目标必须严格位于 accountsDir 之内。 */
export function isPathWithinDir(dir: string, target: string): boolean {
  const relativePath = relative(resolve(dir), resolve(target));
  return (
    relativePath.length > 0 &&
    !relativePath.startsWith("..") &&
    !relativePath.startsWith("/") &&
    !/^[a-zA-Z]:/.test(relativePath)
  );
}

export interface CodexAccountsRegistrySummary {
  readonly activeAccountId: string | null;
  readonly accountIds: readonly string[];
}

/**
 * 只读（容错）读取账号注册表，供 CLI runtime 解析 legacy base id。
 * 文件缺失/损坏返回 null；绝不抛错、不创建目录。
 */
export async function readCodexAccountsRegistry(
  accountsFile: string,
): Promise<CodexAccountsRegistrySummary | null> {
  let raw: string;
  try {
    raw = await readFile(accountsFile, "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as { activeAccountId?: unknown; accounts?: unknown };
    const accountIds: string[] = [];
    if (Array.isArray(record.accounts)) {
      for (const entry of record.accounts) {
        if (
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as { id?: unknown }).id === "string" &&
          isCodexAccountId((entry as { id: string }).id)
        ) {
          accountIds.push((entry as { id: string }).id);
        }
      }
    }
    const activeAccountId =
      typeof record.activeAccountId === "string" && accountIds.includes(record.activeAccountId)
        ? record.activeAccountId
        : null;
    return { activeAccountId, accountIds };
  } catch {
    return null;
  }
}
