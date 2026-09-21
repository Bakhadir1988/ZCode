/**
 * Node-only shared utilities.
 *
 * This subpath must not be imported by renderer/browser bundles.
 */
export { acquireFileLock } from "./node/atomicFileLock.js";
export { scanOfficialPluginCacheRoots } from "./node/officialPluginCache.js";
export {
  migrateUserSubagentMarkdown,
  migrateSubagentStateFile,
} from "./node/subagentMarkdownMigration.js";
export {
  atomicWritePrivateTextFile,
  backupCorruptFile,
  withFileLock,
  type SharedFileLockOptions,
} from "./node/privateFilePersistence.js";
export {
  createNodeSelfResourceSampler,
  NODE_SELF_RESOURCE_SAMPLE_INTERVAL_MS,
  type NodeSelfResourceSampler,
  type NodeSelfResourceSamplerOptions,
} from "./node/nodeSelfResourceTelemetry.js";
export {
  CodexAppServerClient,
  type CodexAppServerClientLogger,
  type CodexAppServerClientOptions,
  type CodexAppServerExitEvent,
  type CodexAppServerNotification,
  type CodexInitializeResult,
} from "./node/codexAppServerClient.js";
export {
  CODEX_ACCOUNT_DIR_MARKER_FILE,
  CODEX_HOME_ENV,
  ZCODE_DATA_BASE_DIR_ENV,
  isCodexAccountId,
  isPathWithinDir,
  readCodexAccountsRegistry,
  resolveCodexAccountHomeDir,
  resolveCodexAccountsDir,
  resolveCodexAccountsFile,
  resolveZCodeDataBaseDir,
  type CodexAccountsRegistrySummary,
} from "./node/codexAccountPaths.js";
