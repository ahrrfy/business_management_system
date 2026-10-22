import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { eq } from "drizzle-orm";
import { receipts, supplierPaymentRequests } from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { money } from "../money";
import { computeSignature } from "./helpers";

export const SUPPLIER_VOUCHER_REQUEST_PREFIX = "VOUCHER-SUPPLIER:";
/** Only the voucher adapter may reserve invoices for an already-authorized deferred voucher. */
export const SUPPLIER_VOUCHER_REQUEST_CAPABILITY = Symbol(
  "supplier-voucher-request",
);
export function supplierVoucherRequestKey(receiptId: number): string {
  return `${SUPPLIER_VOUCHER_REQUEST_PREFIX}${receiptId}`;
}
export function supplierVoucherReceiptId(key: string): number | null {
  if (!key.startsWith(SUPPLIER_VOUCHER_REQUEST_PREFIX)) return null;
  const suffix = key.slice(SUPPLIER_VOUCHER_REQUEST_PREFIX.length);
  const id = Number(suffix);
  if (!/^[1-9]\d*$/.test(suffix) || !Number.isSafeInteger(id))
    throw supplierVoucherConflict("رابط سند المورد غير صالح");
  return id;
}
export function supplierVoucherConflict(why: string): TRPCError {
  return new TRPCError({
    code: "CONFLICT",
    message: appErrorMessage({
      what: "تعذر تنفيذ سند سداد المورد",
      why,
      doThis: "حدّث السند وراجع تخصيص الفواتير قبل الاعتماد",
    }),
  });
}
export async function linkedSupplierVoucherRequest(
  db: DB | Tx,
  receiptId: number,
  currentRead = false,
) {
  const query = db
    .select()
    .from(supplierPaymentRequests)
    .where(
      eq(
        supplierPaymentRequests.requestKey,
        supplierVoucherRequestKey(receiptId),
      ),
    )
    .limit(1);
  const [request] = await (currentRead ? query.for("update") : query);
  return request ?? null;
}
export async function lockLinkedSupplierVoucherTx(
  tx: Tx,
  request: typeof supplierPaymentRequests.$inferSelect,
) {
  const receiptId = supplierVoucherReceiptId(request.requestKey);
  if (receiptId == null) return null;
  const [receipt] = await tx
    .select()
    .from(receipts)
    .where(eq(receipts.id, receiptId))
    .for("update")
    .limit(1);
  if (
    !receipt ||
    !receipt.voucherNumber ||
    receipt.direction !== "OUT" ||
    receipt.partyType !== "SUPPLIER" ||
    receipt.partyId !== request.supplierId ||
    receipt.branchId !== request.branchId ||
    receipt.createdBy !== request.requestedBy ||
    receipt.paymentMethod !== request.paymentMethod ||
    !money(receipt.amount).eq(request.requestedAmount) ||
    request.currency !== "IQD"
  ) {
    throw supplierVoucherConflict(
      "السند لا يطابق المورد أو الفرع أو المبلغ أو مقدم طلب السداد المرتبط",
    );
  }
  return receipt;
}
export function supplierVoucherSignature(
  receipt: typeof receipts.$inferSelect,
  approvedBy: number,
): string {
  if (receipt.paymentMethod === "TELECOM")
    throw supplierVoucherConflict(
      "طريقة دفع السند لا تدعم تخصيص فواتير المورد",
    );
  return computeSignature({
    id: receipt.id,
    amount: money(receipt.amount).toFixed(2),
    partyType: "SUPPLIER",
    partyId: receipt.partyId,
    paymentMethod: receipt.paymentMethod,
    voucherDate: new Date(receipt.voucherDate ?? receipt.createdAt)
      .toISOString()
      .slice(0, 10),
    voucherNumber: receipt.voucherNumber!,
    createdBy: receipt.createdBy!,
    approvedBy,
    branchId: receipt.branchId!,
  });
}
