// سندات قبض/صرف مستقلّة (B1) — receipts بلا فاتورة بل بطرف مستقلّ (راتب، إيجار، دفعة لعميل، …).
// سند قبض (RV): direction='IN'، طرف يدفع للمحلّ (مثل مورد يَستلم دفعة، عميل يَدفع توقعاً).
// سند صرف (PV): direction='OUT'، المحلّ يَدفع لطرف (مثل راتب موظف، إيجار، دفعة لمورّد).
//
// التأثيرات:
//   - receipts row (مع voucherNumber فريد + partyType/partyId + description)
//   - accountingEntries (PAYMENT_IN لـRV، PAYMENT_OUT لـPV)
//   - currentBalance للطرف (إن كان CUSTOMER أو SUPPLIER): ينقص لـCUSTOMER عند IN، يزيد عند OUT.
//   - shiftId يُشتقّ تلقائياً من وردية الموظّف المفتوحة (تسوية الصندوق).
//
// الذرّية: كلّها داخل withTx ⇒ rollback كامل عند أي خطأ.
import { TRPCError } from "@trpc/server";
import { and, desc, eq, like } from "drizzle-orm";
import {
  accountingEntries,
  customers,
  receipts,
  suppliers,
} from "../../drizzle/schema";
import { getDb } from "../db";
import {
  adjustCustomerBalance,
  adjustSupplierBalance,
  postEntry,
} from "./ledgerService";
import { findIdempotentRefId, recordIdempotencyKey } from "./idempotency";
import { money, toDateStr, toDbMoney } from "./money";
import { openShiftIdTx } from "./shiftService";
import { withTx, type Actor } from "./tx";

type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";
type PartyType = "CUSTOMER" | "SUPPLIER" | "OTHER";

export interface VoucherInput {
  /** نوع السند: RECEIPT = قبض (IN)، PAYMENT = صرف (OUT). */
  voucherType: "RECEIPT" | "PAYMENT";
  branchId: number;
  amount: string; // موجبة بالطريقة money
  paymentMethod: PaymentMethod;
  partyType: PartyType;
  partyId?: number | null; // لـCUSTOMER/SUPPLIER، إلزامي؛ لـOTHER null.
  description: string;
  referenceNumber?: string | null;
  checkNumber?: string | null;
  cardLastFour?: string | null;
  /** Idempotency: نفس المفتاح ⇒ سند واحد (لا صرف/قبض نقدي مزدوج عند النقر المزدوج/إعادة الشبكة). */
  clientRequestId?: string | null;
}

export interface VoucherResult {
  receiptId: number;
  voucherNumber: string;
  direction: "IN" | "OUT";
}

/** يولّد رقم سند تسلسلي يومي للفرع: RV-1-20260609-00001 أو PV-1-20260609-00001 */
async function nextVoucherNumber(
  tx: Parameters<Parameters<typeof withTx>[0]>[0],
  voucherType: "RECEIPT" | "PAYMENT",
  branchId: number,
): Promise<string> {
  const prefix = `${voucherType === "RECEIPT" ? "RV" : "PV"}-${branchId}-${toDateStr().replace(/-/g, "")}-`;
  const rows = await tx
    .select({ n: receipts.voucherNumber })
    .from(receipts)
    .where(like(receipts.voucherNumber, `${prefix}%`))
    .orderBy(desc(receipts.id))
    .for("update")
    .limit(1);
  const last = rows[0]?.n;
  const seq = last ? parseInt(String(last).slice(prefix.length), 10) + 1 : 1;
  return prefix + String(seq).padStart(5, "0");
}

/** يُنشئ سند قبض (IN) أو صرف (OUT) ذريّاً. */
export async function createVoucher(input: VoucherInput, actor: Actor): Promise<VoucherResult> {
  return withTx(async (tx) => {
    // Idempotency: تكرار نفس المفتاح يُعاد بنتيجة السند الأول (لا قيد/نقد مزدوج).
    if (input.clientRequestId) {
      const existingRefId = await findIdempotentRefId(tx, "voucher.create", input.clientRequestId);
      if (existingRefId != null) {
        const r = (await tx.select({ voucherNumber: receipts.voucherNumber, direction: receipts.direction }).from(receipts).where(eq(receipts.id, existingRefId)).limit(1))[0];
        return { receiptId: existingRefId, voucherNumber: r?.voucherNumber ?? "", direction: (r?.direction as "IN" | "OUT") ?? "IN" };
      }
    }
    const amount = money(input.amount);
    if (amount.lte(0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ السند يجب أن يكون موجباً" });
    }
    const description = input.description?.trim();
    if (!description) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "وصف السند مطلوب" });
    }

    // التحقّق من الطرف:
    if (input.partyType === "CUSTOMER") {
      if (!input.partyId) throw new TRPCError({ code: "BAD_REQUEST", message: "العميل مطلوب لسند مرتبط بعميل" });
      const c = (await tx.select().from(customers).where(eq(customers.id, input.partyId)).limit(1))[0];
      if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });
    } else if (input.partyType === "SUPPLIER") {
      if (!input.partyId) throw new TRPCError({ code: "BAD_REQUEST", message: "المورد مطلوب لسند مرتبط بمورد" });
      const sup = (await tx.select().from(suppliers).where(eq(suppliers.id, input.partyId)).limit(1))[0];
      if (!sup) throw new TRPCError({ code: "NOT_FOUND", message: "المورد غير موجود" });
    }

    const direction: "IN" | "OUT" = input.voucherType === "RECEIPT" ? "IN" : "OUT";
    const voucherNumber = await nextVoucherNumber(tx, input.voucherType, input.branchId);

    // shiftId من وردية الموظّف المفتوحة (لتسوية الصندوق Z-report).
    const shiftId = await openShiftIdTx(tx, actor.userId, input.branchId);

    const rRes = await tx.insert(receipts).values({
      branchId: input.branchId,
      shiftId,
      direction,
      amount: toDbMoney(amount),
      paymentMethod: input.paymentMethod,
      referenceNumber: input.referenceNumber?.trim() || null,
      checkNumber: input.checkNumber?.trim() || null,
      cardLastFour: input.cardLastFour?.trim() || null,
      status: "COMPLETED",
      voucherNumber,
      partyType: input.partyType,
      partyId: input.partyType === "OTHER" ? null : (input.partyId ?? null),
      description,
      createdBy: actor.userId,
    });
    const receiptId = Number((rRes as any)[0]?.insertId ?? (rRes as any).insertId);

    // قيد دفتر: PAYMENT_IN/OUT حسب نوع السند.
    await postEntry(tx, {
      entryType: direction === "IN" ? "PAYMENT_IN" : "PAYMENT_OUT",
      branchId: input.branchId,
      receiptId,
      customerId: input.partyType === "CUSTOMER" ? (input.partyId ?? null) : null,
      supplierId: input.partyType === "SUPPLIER" ? (input.partyId ?? null) : null,
      amount,
    });

    // تحديث رصيد الطرف (إن وُجد):
    if (input.partyType === "CUSTOMER" && input.partyId) {
      // قبض من عميل ⇒ AR -= amount. صرف لعميل (مثل مرتجع نقدي مستقلّ) ⇒ AR += amount.
      await adjustCustomerBalance(tx, input.partyId, direction === "IN" ? amount.neg() : amount);
    } else if (input.partyType === "SUPPLIER" && input.partyId) {
      // صرف لمورّد ⇒ AP -= amount. قبض من مورّد (مثل استرداد) ⇒ AP += amount.
      await adjustSupplierBalance(tx, input.partyId, direction === "OUT" ? amount.neg() : amount);
    }

    // Idempotency: سجّل المفتاح بعد الكتابة (refId = الإيصال). سباق نفس المفتاح ⇒ ER_DUP_ENTRY.
    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "voucher.create", input.clientRequestId, receiptId);
    }

    return { receiptId, voucherNumber, direction };
  });
}

/** قائمة السندات مع فلاتر (للسجلّ والتقارير). */
export interface ListVouchersInput {
  branchId?: number;
  voucherType?: "RECEIPT" | "PAYMENT";
  partyType?: PartyType;
  partyId?: number;
  limit?: number;
  offset?: number;
}

export async function listVouchers(input: ListVouchersInput = {}) {
  const db = getDb();
  if (!db) return [];
  const conds = [
    // فقط السندات المستقلّة (voucherNumber غير null) ⇒ نُستثني receipts المرتبطة بفاتورة.
    eq(receipts.voucherNumber, receipts.voucherNumber), // placeholder سيُستبدل أدناه
  ];
  const wheres: any[] = [];
  // voucherNumber IS NOT NULL
  wheres.push(and(eq(receipts.status, "COMPLETED")));
  if (input.branchId) wheres.push(eq(receipts.branchId, input.branchId));
  if (input.voucherType) wheres.push(eq(receipts.direction, input.voucherType === "RECEIPT" ? "IN" : "OUT"));
  if (input.partyType) wheres.push(eq(receipts.partyType, input.partyType));
  if (input.partyId) wheres.push(eq(receipts.partyId, input.partyId));
  // فلتر voucherNumber IS NOT NULL (يجب أن يكون سنداً مستقلّاً، لا receipt فاتورة).
  // drizzle لا يدعم isNotNull بسهولة هنا — نستعمل sql خام:
  // لكن أبسط: filter في JS بعد القراءة.

  const rows = await db
    .select({
      id: receipts.id,
      voucherNumber: receipts.voucherNumber,
      branchId: receipts.branchId,
      shiftId: receipts.shiftId,
      direction: receipts.direction,
      amount: receipts.amount,
      paymentMethod: receipts.paymentMethod,
      partyType: receipts.partyType,
      partyId: receipts.partyId,
      description: receipts.description,
      referenceNumber: receipts.referenceNumber,
      createdAt: receipts.createdAt,
      createdBy: receipts.createdBy,
    })
    .from(receipts)
    .where(and(...wheres))
    .orderBy(desc(receipts.id))
    .limit(input.limit ?? 100)
    .offset(input.offset ?? 0);

  // استبعِد ما ليس سنداً مستقلّاً (voucherNumber=null).
  return rows.filter((r) => r.voucherNumber != null);
}

/** قراءة سند منفرد. */
export async function getVoucher(receiptId: number) {
  const db = getDb();
  if (!db) return null;
  const r = (await db.select().from(receipts).where(eq(receipts.id, receiptId)).limit(1))[0];
  if (!r || !r.voucherNumber) return null;
  return r;
}

// إعادة تصدير لمنع وحدة الـimport من أن تَكون unused عند تعديلات لاحقة.
void accountingEntries;
