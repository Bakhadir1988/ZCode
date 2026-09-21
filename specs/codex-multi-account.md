# Codex Multi-Account — Behavior Spec

## Identity
- `accountId`: server-generated UUID (`createUuid`), never email, never user input.
- Provider row id: `account:openai-codex:<accountId>` (suffix form).
  Legacy base id `account:openai-codex` (no suffix) maps to the DEFAULT account
  at execution time; registry never publishes models on the base row.

## State owners
- Account registry (CRUD, activeAccountId, per-account enabled, per-account
  disabledModels, cached email/planType): host `codexService`, file
  `<appData>/codex/accounts.json` (atomic write + file lock). No credentials
  ever touch this file.
- OAuth tokens: official Codex runtime only, inside per-account `CODEX_HOME`.
- Thread mapping: session entry `runtime/codex_thread` = `{accountId, threadId}`.
- Model enable/disable: `disabledModels: string[]` inside the account record
  (key = accountId + modelId by construction).

## CODEX_HOME layout
`<appData>/codex/accounts/<accountId>/`, computed by shared pure helper
`resolveCodexAccountHomeDir(dataBaseDir, accountId)` — host and CLI runtime
compute identically; `~/.codex` is never used or modified by ZCode.
Deletion on logout only when the dir contains our marker file
`.zcode-codex-account` AND is contained in the accounts dir.

## Provider rows (registry, host + runtime via account snapshot sync)
- For each connected account: row `account:openai-codex:<id>` with full inline
  config (api `codex-app-server`, logo openai, name "OpenAI Codex"),
  `builtinModelIds` = runtime models minus account.disabledModels, access
  `codex-account{connected:true}`.
- Base row `account:openai-codex`: aggregate connected flag, empty models
  (never executable in picker; drives the Providers-list status entry).
- Per (row, model) account model rules carry `optionSpecs.reasoningLevel.values`
  from `supportedReasoningEfforts`; static builtin `codex-app-server` defaults
  apply only until the first successful model/list.
- Rows for disconnected accounts: access connected:false → excluded from picker,
  retained in settings view.
- Ordering: extra codex rows follow the base row, sorted by suffix (deterministic).
- Classification stays `ordinary` for all codex rows (no effective-selection
  rerouting; each row is its own execution target).
- Default account does NOT filter the picker; all connected accounts' enabled
  models are listed.

## Selection & execution
- Picker value keeps full row id (`custom:account%3Aopenai-codex%3A<uuid>:<model>`).
- Executor parses accountId from the row id; base id falls back to active account
  (read-only accounts registry lookup in the runtime).
- Session entry `{accountId, threadId}`: same account → resume (missing thread =
  recoverable error, never silent re-create); different account than stored →
  start fresh thread under the new account and overwrite the entry.
- Turn params unchanged: thread/start{`cwd`, approvalPolicy never,
  sandbox `{"workspace-write": {}}`}, turn/start{input, effort, model},
  turn/interrupt on abort.

## Default account
- UI concept: "default account" (not "active account"). All connected accounts
  stay simultaneously available at all times; the default is only a preference
  for (a) new Codex sessions, (b) legacy selections without an accountId
  (base row id), (c) new-chat preferred selection. It never disables,
  hides, or disconnects the other accounts, and changing it never rewrites
  existing sessions.
- `activeAccountId` persisted in accounts.json (field name kept for wire and
  on-disk compatibility; semantics = default account); first account becomes
  default; deleting the default account promotes the oldest remaining (or null).
- New-chat default: host model-selection `preferredSelection` remaps a
  codex-family configured default to the default account's row (model kept when
  executable there). Existing sessions are never rewritten.
- No global execution `activeAccountId` exists: each session resolves the
  accountId from its own selection/session entry; runtimes are per account.

## Account enabled (availability preference)
- `enabled: boolean` persisted inside the account record; missing value in an
  old file normalizes to `true` (no user migration). Independent of OAuth:
  disabling never logs out, never touches CODEX_HOME, credentials, or the
  account record.
- Semantics = availableForSelection, not permission revoke. The disabled
  account stays visible in Settings (badge "Disabled"), keeps its model list
  with editable per-model switches, and its runtime row stays in the provider
  registry so already-bound sessions keep executing through it. The disabled
  account's models are hidden from the chat model picker for new selections
  (picker grouping filters by the codex accounts state, registry row is
  intentionally preserved — dropping it would break session validation).
- Because the row must survive for existing sessions, the account's app-server
  is NOT disposed on disable (runtime-lifecycle optimization is deliberately
  skipped; auth state is the invariant).
- `setAccountEnabled(accountId, enabled)` on the existing ICodexService
  (no separate service). Disabling the default account promotes the first
  other enabled account with known credentials; if none exists the default
  becomes null (explicit null is sticky — registry mutate no longer force-
  promotes from null). Re-enabling never auto-restores the default and never
  triggers a new OAuth login.
- Picker: one nested submenu per enabled account (existing DropdownMenuSub
  pattern, like API-format provider groups), even for a single account —
  stable structure as accounts are added. Group label = provider name
  ("OpenAI Codex") with the account label as the group badge; no email in
  picker labels. Disabled accounts have no group; per-model OFF toggles still
  filter inside a group; same model on different accounts remains distinct
  selection values (row id stays in the value).

## UI
- Providers list: single "OpenAI Codex" row (status dot = any-connected green /
  accounts-but-none-connected warning / none gray), placed with preset providers.
- Panel: non-exclusive account cards, one per account (label + email + plan).
  The default account carries a "Default" badge; a disabled account carries a
  "Disabled" badge; every other card offers a "Set as default" action. Each
  card has an "Enabled" switch (availability preference — never logs out).
  No radio-button semantics. Disconnect is per account only.
- Each account card embeds that account's model list with per-account ON/OFF
  toggles (key = accountId + modelId) and a per-account Refresh; switches stay
  editable while the account is disabled (list is dimmed). All accounts'
  models are visible at once; one account's refresh/toggle/disconnect failure
  never affects another account's card.
- Footnote states the default account is used for new chats and that every
  connected account stays selectable per chat in the model picker.
- Picker: one nested submenu per enabled codex account (label = provider name,
  badge = account label); disabled accounts are absent; re-enabling restores
  the submenu without new OAuth. Reasoning levels unchanged (optionSpecs).

## Acceptance
- Manual verification list from the task (16 steps).
- Behavior tests:
  1. Accounts A and B are executable at the same time (isolated CODEX_HOME
     runtimes under one session and across sessions).
  2. Default = A does not hide or disable account B's models.
  3. Default = B does not hide or disable account A's models.
  4. Existing session A stays on account A after the default changes.
  5. A new session uses the new default (preferred-selection remap and
     legacy base-id fallback both follow the registry default).
  6. A/modelX OFF does not affect B/modelX.
  7. Account A runtime crash does not disable account B.
  8. Disconnecting A does not touch B; disconnecting the default promotes a
     remaining account (or null).
  9. A and B enabled → both have picker submenus; A disabled → only B's
     submenu (A stays in Settings with models; existing session on A keeps
     executing); A re-enabled → submenu returns without new OAuth.
  10. Disabling the default promotes the first other enabled account, or null.
  11. enabled=false persists across service restarts (old files without the
     field normalize to enabled=true).
- Unit tests: accounts CRUD/persistence, CODEX_HOME isolation, toggles &
  overlay filtering, session binding incl. mismatch error, logout isolation,
  per-account crash isolation, distinct A/modelX vs B/modelX targets.
