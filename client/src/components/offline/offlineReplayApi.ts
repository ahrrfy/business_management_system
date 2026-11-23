import type { OfflineOutboxItem, OfflineOutboxKind } from "@/lib/offline/db";
import type {
  DismissParkedResult,
  ReissueFencedSaleResult,
  ReplayApiMap,
  ReplayArgs,
  ReplaySaleApi,
} from "@/lib/offline/outbox";

export type OfflineManagerApproval = { email: string; password: string };
type ReplayMutation = (input: never) => ReturnType<ReplaySaleApi>;
export type OfflineReplayRoutes = Record<OfflineOutboxKind, ReplayMutation>;
export type OfflineApprovalApiFactory = (
  approval: OfflineManagerApproval,
) => ReplayApiMap;

export interface OfflineParkedResolutionActions {
  probeStatus?: (item: OfflineOutboxItem) => Promise<{
    outcome: "COMMITTED" | "UNKNOWN_IN_FLIGHT" | "FENCED_NOT_COMMITTED" | "UNKNOWN";
    invoiceNumber?: string;
    recoveryStatus?: "PENDING" | "POSTED" | "DISCARDED" | null;
    discardReason?: string | null;
  }>;
  reissueFencedSale?: (
    args: ReplayArgs,
    approval?: OfflineManagerApproval,
  ) => Promise<ReissueFencedSaleResult>;
  dismissParkedItem?: (params: {
    branchId: number;
    clientRequestId: string;
    kind: OfflineOutboxKind;
    offlineReceiptNumber: string;
    total: string;
    lastError?: string;
    reason: string;
    managerApproval?: OfflineManagerApproval;
  }) => Promise<DismissParkedResult>;
}

export function buildOfflineReplayInput(args: ReplayArgs) {
  return {
    ...(args.payload as object),
    capturedAt: args.capturedAt,
    offlineReceiptNumber: args.offlineReceiptNumber,
    deviceId: args.deviceId,
    ...(args.capturedByUserId != null ? { capturedByUserId: args.capturedByUserId } : {}),
    ...(args.capturedShiftId != null ? { capturedShiftId: args.capturedShiftId } : {}),
    ...(args.captureProof != null ? { captureProof: args.captureProof } : {}),
    ...(args.keyId != null ? { keyId: args.keyId } : {}),
    ...(args.grantId != null ? { grantId: args.grantId } : {}),
    ...(args.grantIssuedAtMs != null ? { grantIssuedAtMs: args.grantIssuedAtMs } : {}),
    ...(args.grantExpiresAtMs != null ? { grantExpiresAtMs: args.grantExpiresAtMs } : {}),
    ...(args.grantToken != null ? { grantToken: args.grantToken } : {}),
  };
}

/** Preserve the saved payload and capture identity. A return never gains manager approval. */
export function createOfflineReplayApi(
  routes: OfflineReplayRoutes,
  approval?: OfflineManagerApproval,
): ReplayApiMap {
  const input = (args: ReplayArgs) => buildOfflineReplayInput(args);
  const approved = (args: ReplayArgs) => ({
    ...input(args),
    ...(approval ? { managerApproval: approval } : {}),
  });
  return {
    SALE: (args) => routes.SALE(approved(args) as never),
    PRINT_SALE: (args) => routes.PRINT_SALE(approved(args) as never),
    RECEPTION: (args) => routes.RECEPTION(approved(args) as never),
    RETURN: (args) => routes.RETURN(input(args) as never),
  };
}
