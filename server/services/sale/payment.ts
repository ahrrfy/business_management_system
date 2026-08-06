// تسجيل دفعة لاحقة على فاتورة آجلة؛ يُحدّث الحالة والذمم.
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { invoices, receipts, shifts } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { findIdempotentRefId, recordIdempotencyKey } from "../idempotency";
import { adjustCustomerBalance, computeInvoiceStatus, postEntry } from "../ledgerService";
import { money, toDbMoney } from "../money";
import { openShiftIdTx } from "../shiftService";
import { type Actor, withTx } from "../tx";
import type { Tx } from "../../db";
import type { PaymentMethod } from "./types";

export interface ProcessPaymentInput {
  invoiceId: number;
  amount: string;
  method: PaymentMethod;
  reference?: string | null;
  shiftId?: number | null;
  /** إن حُدِّد، يُرفض الدفع على فاتورة فرعٍ مغاير (عزل الفروع لغير المدير). */
  enforceBranchId?: number | null;
  /** Idempotency: نفس الـmagic key يُعاد تشغيله بنتيجة العملية الأولى (لا تكرّر دفعة عند النقر المزدوج). */
  clientRequestId?: string | null;
  /**
   * فحصٌ حارس يُنفَّذ **داخل** معاملة الدفع بعد مسار الـreplay وقبل إدراج الإيصال (ش٥):
   * فحصه في معاملةٍ مستقلّة قبل النداء يفتح TOCTOU (الحارس يلتزم ويحرّر أقفال فجوته قبل أن
   * يُدرَج الإيصال ⇒ كودُ كارتٍ يُقبَض مرّتين تحت التزامن)، ويصطدم بإيصال العملية نفسها عند
   * إعادة الإرسال المشروعة. هنا يتخطّاه الـreplay وتبقى أقفاله حيّةً حتى التزام الإدراج.
   */
  preInsertCheck?: (tx: Tx) => Promise<void>;
}

/** Record a later payment against a credit invoice; updates status + AR. */
export async function processPayment(input: ProcessPaymentInput, actor: Actor) {
  return withTx(async (tx) => {
    // Idempotency (نمط جذري ١): قبل أيّ replay، نتحقّق أنّ الإيصال المخزَّن يخصّ نفس الفاتورة
    // وفرع المستخدم الحقيقي. كان الـreplay يَعود قبل enforceBranchId وقبل أيّ ربط بـinput.invoiceId
    // ⇒ مفتاح يُعاد استعماله على فاتورة مختلفة كان يُرجع نجاحاً صامتاً (no-op) فيتلقّى الكاشير «مدفوع»
    // ولا تُسجَّل دفعةٌ ثانية فعلياً ⇒ منفذ سرقة نقد. التأكيد يغلق الفئة بأكملها.
    if (input.clientRequestId) {
      const existingRefId = await findIdempotentRefId(tx, "sale.pay", input.clientRequestId);
      if (existingRefId != null) {
        const r = (await tx.select().from(receipts).where(eq(receipts.id, existingRefId)).limit(1))[0];
        if (!r || Number(r.invoiceId) !== Number(input.invoiceId)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعارض idempotency: المفتاح مستعمَل لدفعة على فاتورة مختلفة",
          });
        }
        if (money(r.amount).toFixed(2) !== money(input.amount).toFixed(2)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعارض idempotency: المفتاح مستعمَل لدفعة بمبلغ مختلف",
          });
        }
        if ((r.paymentMethod ?? null) !== (input.method ?? null)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعارض idempotency: المفتاح مستعمَل لدفعة بطريقة سداد مختلفة",
          });
        }
        if ((r.referenceNumber ?? null) !== (input.reference?.trim() || null)) {
          throw new TRPCError({ code: "CONFLICT", message: "تعارض idempotency: مرجع عملية الدفع مختلف" });
        }
        // أعِد قراءة الفاتورة لإرجاع حالتها الحديثة (replay آمن، لا كتابة).
        const inv = (await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1))[0];
        if (input.enforceBranchId != null && inv && Number(inv.branchId) !== input.enforceBranchId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية على فاتورة فرع آخر" });
        }
        return {
          invoiceId: input.invoiceId,
          paidAmount: inv?.paidAmount ?? "0.00",
          status: inv?.status ?? "PENDING",
          idempotentReplay: true as const,
        };
      }
    }

    const rows = await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).for("update").limit(1);
    const inv = rows[0];
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });
    // عزل الفرع: غير المدير لا يدفع على فاتورة فرع آخر (منع IDOR).
    if (input.enforceBranchId != null && Number(inv.branchId) !== input.enforceBranchId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا تملك صلاحية على فاتورة فرع آخر" });
    }
    if (inv.status === "CANCELLED" || inv.status === "RETURNED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن الدفع على فاتورة ملغاة أو مرتجعة" });
    }
    if (inv.status === "PAID") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الفاتورة مدفوعة بالكامل" });
    }
    const amount = money(input.amount);
    const paymentReference = input.reference?.trim() || null;
    if (input.method !== "CASH" && !paymentReference) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "مرجع عملية البطاقة/التحويل مطلوب" });
    }
    if (amount.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ يجب أن يكون موجباً" });
    const remaining = money(inv.total)
      .minus(money(inv.returnedTotal ?? "0"))
      .minus(money(inv.paidAmount));
    if (remaining.lte(0)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يوجد مبلغ مستحق على الفاتورة" });
    }
    if (amount.gt(remaining)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `الدفعة (${amount.toFixed(2)}) تتجاوز المتبقي على الفاتورة (${remaining.toFixed(2)}).`,
      });
    }

    // إن مُرِّر shiftId: تَحقّق من حالة الوردية وملكيتها (M5 + M9).
    if (input.shiftId != null) {
      const sRows = await tx
        .select()
        .from(shifts)
        .where(eq(shifts.id, input.shiftId))
        .for("update")
        .limit(1);
      const s = sRows[0];
      if (!s) {
        throw new TRPCError({ code: "NOT_FOUND", message: "الوردية غير موجودة" });
      }
      if (s.status !== "OPEN") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الوردية مغلقة" });
      }
      // لا يكفي أن تكون الوردية مفتوحة ومملوكة للفاعل: يجب أن تكون درجاً من
      // الفرع نفسه للفـاتورة. من دون ذلك يمكن تمرير وردية فرعٍ آخر فتُسجّل
      // مقبوضات الفرع A في Z-report للفرع B (مع receipt.branchId=A)، وهو
      // انحراف نقدي لا يمكن تسويته على مستوى الفرع.
      if (Number(s.branchId) !== Number(inv.branchId)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "الوردية لا تخص فرع الفاتورة",
        });
      }
      const role = actor.role;
      if (role !== "admin" && role !== "manager") {
        if (Number(s.userId) !== Number(actor.userId)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "لا تَستطيع التسجيل على وردية مستخدم آخر",
          });
        }
      }
    }
    // انسب الدفع النقدي لوردية الموظّف المفتوحة إن لم يُمرَّر صراحةً (تسوية الصندوق).
    const shiftId = input.shiftId ?? (await openShiftIdTx(tx, actor.userId, Number(inv.branchId)));
    // M5/M8: النقد يَستوجب وردية مفتوحة (سواء مُرِّرت صراحةً أو حُلّت من المستخدم).
    if (input.method === "CASH" && shiftId == null) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "يَلزم وردية مفتوحة للبيع النقدي",
      });
    }
    if (input.preInsertCheck) await input.preInsertCheck(tx);
    const rRes = await tx.insert(receipts).values({
      invoiceId: input.invoiceId,
      branchId: Number(inv.branchId),
      shiftId,
      // cashBucket=DRAWER للنقد، NULL لغير النقد — مرآة لـcreateSale ولـvoucherService.
      cashBucket: input.method === "CASH" ? "DRAWER" : null,
      direction: "IN",
      amount: toDbMoney(amount),
      paymentMethod: input.method,
      referenceNumber: paymentReference,
      status: "COMPLETED",
      createdBy: actor.userId,
    });
    const receiptId = extractInsertId(rRes);
    if (input.clientRequestId) await recordIdempotencyKey(tx, "sale.pay", input.clientRequestId, receiptId);

    const newPaid = money(inv.paidAmount).plus(amount);
    const status = computeInvoiceStatus(inv.total, toDbMoney(newPaid), inv.returnedTotal ?? "0");
    await tx
      .update(invoices)
      .set({ paidAmount: toDbMoney(newPaid), status, paymentDate: new Date(), paymentMethod: input.method })
      .where(eq(invoices.id, input.invoiceId));

    await postEntry(tx, {
      entryType: "PAYMENT_IN",
      branchId: Number(inv.branchId),
      invoiceId: input.invoiceId,
      receiptId,
      customerId: inv.customerId,
      amount,
    });
    if (inv.customerId) {
      await adjustCustomerBalance(tx, Number(inv.customerId), amount.neg());
    }

    return { invoiceId: input.invoiceId, paidAmount: toDbMoney(newPaid), status };
  });
}
