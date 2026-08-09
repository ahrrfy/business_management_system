/**
 * موافقات ائتمان مُسبَقة — B5: ربط creditApproved بـ(customer, maxAmount, expiresAt, single-use).
 *
 * المنطق:
 * - مدير يستدعي createApproval(customerId, maxAmount, ttlMinutes) ⇒ يعيد approvalId.
 * - الكاشير يمرّر creditApprovalId في sale.createSale؛ الخدمة تتحقّق:
 *     * customerId يطابق المعتمَد
 *     * unpaid ≤ maxAmount
 *     * now ≤ expiresAt
 *     * consumedAt IS NULL
 * - بعد نجاح الفاتورة: consumeApproval(approvalId, invoiceId) يضع consumedAt + consumedByInvoiceId.
 * - عدم تطابق أي شرط ⇒ TRPCError FORBIDDEN.
 *
 * الأمان: حتى لو الكاشير أرسل creditApproved:true منفرداً (بلا approvalId) ⇒ FORBIDDEN.
 * الموافقة العامة (blanket) لم تعد ممكنة. كل تجاوز سقف يحتاج صفّاً صريحاً مع سقف مالي + تاريخ انتهاء.
 */
import { TRPCError } from "@trpc/server";
import type Decimal from "decimal.js";
import { and, eq, gt, isNull } from "drizzle-orm";
import { branches, creditApprovals, customers } from "../../drizzle/schema";
import type { Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { money } from "./money";

export interface CreateApprovalInput {
  customerId: number;
  branchId: number;
  maxAmount: string; // decimal as string
  approvedBy: number;
  ttlMinutes?: number; // default 60
  notes?: string | null;
}

export interface ApprovalRow {
  id: number;
  customerId: number;
  branchId: number;
  approvedBy: number;
  maxAmount: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

/** مدير ينشئ موافقة قبل أن يستعملها الكاشير. */
export async function createApproval(tx: Tx, input: CreateApprovalInput): Promise<{ id: number; expiresAt: Date }> {
  const ttl = input.ttlMinutes ?? 60;
  const expiresAt = new Date(Date.now() + ttl * 60 * 1000);
  if (money(input.maxAmount).lte(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "سقف الموافقة يجب أن يكون موجباً" });
  }
  const [branch] = await tx
    .select({ id: branches.id, isActive: branches.isActive })
    .from(branches)
    .where(eq(branches.id, input.branchId))
    .limit(1);
  if (!branch || branch.isActive === false) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الفرع غير موجود أو غير نشط" });
  }
  // تدقيق ١٧/٧: كان يُدرِج بلا قراءة العميل ⇒ معرّف غير موجود يفشل بخطأ FK خام، وموافقة تُنشأ
  // لعميل معطَّل ثم تفشل عند البيع. نتحقّق داخل المعاملة.
  const [cust] = await tx
    .select({ id: customers.id, isActive: customers.isActive })
    .from(customers)
    .where(eq(customers.id, input.customerId))
    .limit(1);
  if (!cust) throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });
  if (cust.isActive === false) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "لا موافقة ائتمان لعميل معطَّل" });
  }
  const res = await tx.insert(creditApprovals).values({
    customerId: input.customerId,
    branchId: input.branchId,
    maxAmount: input.maxAmount,
    approvedBy: input.approvedBy,
    expiresAt,
    notes: input.notes ?? null,
  });
  return { id: extractInsertId(res), expiresAt };
}

/**
 * يتحقّق ويستهلك في خطوتين (داخل نفس withTx):
 *  ١) validateApproval(approvalId, customerId, unpaid) — يرفض mismatch
 *  ٢) consumeApproval(approvalId, invoiceId) — بعد إنشاء الفاتورة
 */
export async function validateApproval(
  tx: Tx,
  approvalId: number,
  expectedCustomerId: number,
  unpaid: Decimal,
  usage: { branchId: number; consumerUserId: number },
): Promise<ApprovalRow> {
  // SELECT FOR UPDATE لمنع double-spend عبر سباق ⇒ المعاملتان لنفس approvalId تتسلسلان.
  // استخدم mapper المخطط للتواريخ؛ قراءة DATETIME كنص خام ثم new Date(text)
  // تفسّر النص كتوقيت محلي وتطرح إزاحة المنطقة مرة ثانية، فتُنهي موافقة سليمة مبكراً.
  const row = (
    await tx
      .select({
        id: creditApprovals.id,
        customerId: creditApprovals.customerId,
        branchId: creditApprovals.branchId,
        approvedBy: creditApprovals.approvedBy,
        maxAmount: creditApprovals.maxAmount,
        expiresAt: creditApprovals.expiresAt,
        consumedAt: creditApprovals.consumedAt,
      })
      .from(creditApprovals)
      .where(eq(creditApprovals.id, approvalId))
      .for("update")
      .limit(1)
  )[0];
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: `موافقة الائتمان ${approvalId} غير موجودة` });
  }
  if (Number(row.customerId) !== expectedCustomerId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `موافقة الائتمان لعميل آخر (${row.customerId})؛ الفاتورة لعميل ${expectedCustomerId}.`,
    });
  }
  // الصفوف التاريخية التي تعذّر ترحيل نطاقها تُرفض، والقرار لا يعبر الفروع.
  if (row.branchId == null || Number(row.branchId) !== Number(usage.branchId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "موافقة الائتمان صادرة لفرع آخر أو بلا نطاق فرع صالح",
    });
  }
  // فصل المهام: مُصدر القرار لا يستهلك القرار بنفسه في البيع.
  if (Number(row.approvedBy) === Number(usage.consumerUserId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "لا يمكن لمُصدر قرار الائتمان استهلاكه بنفسه — يلزم منفّذ بيع آخر",
    });
  }
  if (row.consumedAt) {
    throw new TRPCError({ code: "FORBIDDEN", message: "موافقة الائتمان مُستَهلَكة سابقاً (single-use)" });
  }
  const exp = new Date(row.expiresAt);
  if (exp.getTime() <= Date.now()) {
    throw new TRPCError({ code: "FORBIDDEN", message: `موافقة الائتمان منتهية الصلاحية (${exp.toISOString()})` });
  }
  if (unpaid.gt(money(row.maxAmount))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `الباقي ${unpaid.toFixed(2)} يتجاوز سقف الموافقة ${row.maxAmount}`,
    });
  }
  return {
    id: Number(row.id),
    customerId: Number(row.customerId),
    branchId: Number(row.branchId),
    approvedBy: Number(row.approvedBy),
    maxAmount: String(row.maxAmount),
    expiresAt: exp,
    consumedAt: row.consumedAt ? new Date(row.consumedAt) : null,
  };
}

/** بعد نجاح الفاتورة — يربط الموافقة بالفاتورة ويُعلَم أنها استُهلِكَت. */
export async function consumeApproval(tx: Tx, approvalId: number, invoiceId: number): Promise<void> {
  await tx
    .update(creditApprovals)
    .set({ consumedAt: new Date(), consumedByInvoiceId: invoiceId })
    .where(and(eq(creditApprovals.id, approvalId), isNull(creditApprovals.consumedAt)));
}

/** قراءة الموافقات النشِطة لعميل (غير مستَهلَكة + غير منتهية). */
export async function getActiveApprovalsForCustomer(tx: Tx, customerId: number, branchId: number) {
  return tx
    .select()
    .from(creditApprovals)
    .where(
      and(
        eq(creditApprovals.customerId, customerId),
        eq(creditApprovals.branchId, branchId),
        isNull(creditApprovals.consumedAt),
        gt(creditApprovals.expiresAt, new Date()),
      ),
    );
}
