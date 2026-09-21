import type { AccountProviderConfigSnapshot } from "@zcode/provider";
import {
  zcodeProviderUpdateAccountConfigParamsSchema,
  type ZCodeProviderUpdateAccountConfigResult,
} from "@zcode/shared";
import { parseProcessAccountProviderConfigSnapshot } from "../app/process-provider-registry-runtime.js";
import {
  parseParams,
  ProtocolRequestError,
  summarizeParamsError,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

/**
 * 更新进程级 Account Provider Config。
 *
 * 该协议传 Account Overlay 与对应状态；API Key、JWT 和动态 Header 由请求期鉴权协议处理。
 */
export async function updateAccountProviderConfig(
  context: ZCodeProtocolAgentServerContext,
  params: unknown,
): Promise<ZCodeProviderUpdateAccountConfigResult> {
  const envelope = parseParams(zcodeProviderUpdateAccountConfigParamsSchema, params);
  let snapshot: AccountProviderConfigSnapshot;
  try {
    snapshot = parseProcessAccountProviderConfigSnapshot(envelope);
  } catch (error) {
    // 账号行校验失败不能再把 raw Zod issues JSON 当作错误正文抛给 Host/UI
    // （多账号回归中它曾以整屏 unrecognized_keys 呈现在会话打开路径上）。
    // 根因已在 provider 层修复；这里保证真实契约破坏也以可读协议错误呈现，
    // 完整 issues 保留在 data 供诊断，不掩盖失败。非 schema 错误原样上抛。
    const detail = summarizeParamsError(error);
    if (!detail) throw error;
    throw new ProtocolRequestError(
      -32602,
      `Invalid account provider config — ${detail}`,
      error,
    );
  }
  if (!context.deps.syncAccountProviderConfig) {
    throw new ProtocolRequestError(-32018, "Account Provider Config runtime is not configured");
  }
  const changed = await context.deps.syncAccountProviderConfig(snapshot);
  return {
    receivedRevision: snapshot.revision,
    providerCount: snapshot.providers.keys().length,
    status: changed ? "received" : "unchanged",
  };
}
