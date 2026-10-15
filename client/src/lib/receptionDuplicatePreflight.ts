import type { ReceptionDuplicateInput } from "@shared/receptionDuplicateOrders";

/** A cross-branch administrator must check the selected order's actual branch. */
export async function resolveOnlineDuplicateReference(
  orderId: number,
  loadDetail: () => Promise<
    { id: number; branchId?: number | null } | null | undefined
  >,
): Promise<ReceptionDuplicateInput> {
  if (!Number.isSafeInteger(orderId) || orderId <= 0) {
    throw new Error("Invalid preparation order");
  }
  const detail = await loadDetail();
  const branchId = detail?.branchId;
  if (
    detail?.id !== orderId ||
    typeof branchId !== "number" ||
    !Number.isSafeInteger(branchId) ||
    branchId <= 0
  ) {
    throw new Error("Preparation order branch unavailable");
  }
  return { branchId, reference: { kind: "ONLINE", id: orderId } };
}
