import type { OfflineOutboxKind } from "@/lib/offline/db";
import type {
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

/** Preserve the saved payload and capture identity. A return never gains manager approval. */
export function createOfflineReplayApi(
  routes: OfflineReplayRoutes,
  approval?: OfflineManagerApproval,
): ReplayApiMap {
  const input = (args: ReplayArgs) => ({
    ...(args.payload as object),
    capturedAt: args.capturedAt,
    offlineReceiptNumber: args.offlineReceiptNumber,
    deviceId: args.deviceId,
  });
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
