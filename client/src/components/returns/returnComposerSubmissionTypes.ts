import { ReturnComposerProps } from "./returnComposerTypes";
import type { useReturnComposerState } from "./useReturnComposerState";
import type { useReturnComposerSettlement } from "./useReturnComposerSettlement";
import type { useReturnComposerMutations } from "./useReturnComposerMutations";
import type { useReturnComposerGuard } from "./useReturnComposerGuard";
export type ReturnComposerSubmissionContext = Pick<
  ReturnType<typeof useReturnComposerState> &
    ReturnType<typeof useReturnComposerSettlement> &
    ReturnType<typeof useReturnComposerMutations> &
    ReturnType<typeof useReturnComposerGuard> &
    ReturnComposerProps,
  | "me"
  | "operationPermission"
  | "executesImmediately"
  | "qty"
  | "setQty"
  | "restock"
  | "manualAmount"
  | "setManualAmount"
  | "railState"
  | "setRailState"
  | "reason"
  | "setReason"
  | "error"
  | "setError"
  | "setDone"
  | "clientRequestId"
  | "inv"
  | "isWalkIn"
  | "isDeliveryReversal"
  | "items"
  | "itemsById"
  | "pickedRail"
  | "method"
  | "shiftId"
  | "cardReference"
  | "usesTreasury"
  | "activeOption"
  | "refundD"
  | "selectedLines"
  | "approve"
  | "create"
  | "isLocked"
  | "pending"
  | "noRefundNeeded"
  | "requiresExecutableRail"
  | "blockReason"
  | "invoiceId"
  | "approvingRequestId"
>;
