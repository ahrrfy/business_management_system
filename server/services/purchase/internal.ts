// أدوات مشتركة خاصة بحزمة الشراء (يستهلكها order/receive) — غير مُصدَّرة من البرميل purchaseService.ts.
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, eq, like, sql } from "drizzle-orm";
import { accountingEntries, receipts } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { money } from "../money";
import type { Actor } from "../tx";

/** عزل الفرع (قرار المالك ١٢/٨: عزل مدير الفرع): المالك/الأدمن فقط يعبُران (owner مُطبَّع ⇒ admin)؛
 *  المدير مقيَّدٌ بفرعه على أوامر الشراء. */
export function assertPurchaseBranch(po: { branchId: number | string }, actor: Actor & { role?: string }) {
  const elevated = actor.role === "admin";
  if (elevated) return;
  if (Number(po.branchId) !== actor.branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا تستطيع التعديل على فرع آخر" });
  }
}

/** رصيد أمر الشراء الحقيقي بعد الاستلامات والمرتجعات والمدفوعات والعكس. */
export async function purchaseOrderPayableBalanceTx(tx: Tx, purchaseOrderId: number): Promise<Decimal> {
  const [row] = await tx
    .select({
      balance: sql<string>`COALESCE(SUM(CASE
        WHEN ${accountingEntries.entryType} IN ('PURCHASE','RETURN','PAYMENT_IN') THEN ${accountingEntries.amount}
        WHEN ${accountingEntries.entryType} IN ('PAYMENT_OUT','EXCHANGE_SETTLE') THEN -${accountingEntries.amount}
        ELSE 0 END), 0)`,
    })
    .from(accountingEntries)
    .where(and(
      eq(accountingEntries.purchaseOrderId, purchaseOrderId),
      sql`${accountingEntries.supplierId} IS NOT NULL`,
    ));
  return money(row?.balance ?? "0");
}

/** مبالغ طلبات صرف المورد المعلّقة المحجوزة لنفس الأمر، ولا أثر نقدي لها بعد. */
export async function pendingPurchaseSupplierPaymentsTx(tx: Tx, poNumber: string): Promise<Decimal> {
  const [row] = await tx
    .select({ amount: sql<string>`COALESCE(SUM(${receipts.amount}), 0)` })
    .from(receipts)
    .where(and(
      eq(receipts.direction, "OUT"),
      eq(receipts.status, "PENDING"),
      eq(receipts.approvalStatus, "PENDING_APPROVAL"),
      like(receipts.referenceNumber, `PO-PAY-${poNumber}-%`),
    ));
  return money(row?.amount ?? "0");
}
