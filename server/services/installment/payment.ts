// سداد قسط عبر سند قبض حقيقي (createVoucher) — Maker-Checker + idempotency instpay-<lineId>.
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, like, or, sql } from "drizzle-orm";
import { installmentLines, installmentPlans, invoices, voucherCategories } from "../../../drizzle/schema";
import { toDbMoney } from "../money";
import { type Actor, requireDb, withTx } from "../tx";
import { createVoucher } from "../voucherService";
import { assertPlanBranch, type BranchRestriction, type PayLineInput, type PayLineResult } from "./types";

/**
 * سداد قسط عبر **سند قبض حقيقي** (createVoucher) — الذمّة والدفتر يتحركان بالمسار الموحَّد.
 *
 * الذرّية عبر حدَّي معاملتين (createVoucher يفتح معاملته الخاصة داخلياً — لا يمكن تضمينه في
 * معاملتنا): نعتمد **idempotency حتمياً** بمفتاح `instpay-<lineId>` — كل قسط يُسدَّد مرّة
 * واحدة كحدّ أقصى في عمره، فلو انهار وسم القسط بعد إنشاء السند، إعادة المحاولة تُعيد نفس
 * السند (بلا قبض مزدوج) وتُكمل الوسم — تعافٍ ذاتي.
 *
 * Maker-Checker: إن أعاد createVoucher السند PENDING_APPROVAL (مبلغ ≥ العتبة) فلا أثر مالي
 * بعد ⇒ القسط يبقى PENDING مع ملاحظة تُسمّي السند المعلَّق. بعد اعتماد السند (شاشة السندات)
 * يعيد المستخدم «سداد» فيُعيد idempotency نفس السند بحالته الجديدة APPROVED ⇒ يُوسم PAID.
 */
export async function payLine(
  input: PayLineInput,
  actor: Actor,
  restrictToBranchId: BranchRestriction = null,
): Promise<PayLineResult> {
  const db = requireDb();

  const row = (
    await db
      .select({ line: installmentLines, plan: installmentPlans })
      .from(installmentLines)
      .innerJoin(installmentPlans, eq(installmentLines.planId, installmentPlans.id))
      .where(eq(installmentLines.id, input.lineId))
      .limit(1)
  )[0];
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "القسط غير موجود" });
  const { line, plan } = row;
  assertPlanBranch(Number(plan.branchId), restrictToBranchId);

  if (plan.status !== "ACTIVE") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الخطة غير نشطة — لا يمكن سداد أقساطها" });
  }
  if (line.status !== "PENDING" && line.status !== "BOUNCED") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: line.status === "PAID" ? "هذا القسط مسدَّد بالفعل" : "هذا القسط ملغى — لا يمكن سداده",
    });
  }

  const method = input.paymentMethod ?? (line.kind === "CHECK" ? "CHECK" : "CASH");

  // ربط سند القسط بفاتورة الخطة (يظهر في سجلّ دفعات الفاتورة) — فقط إن كانت ما تزال صالحة،
  // كي لا يُحجَب التحصيل لو أُلغيت الفاتورة بعد إنشاء الخطة (createVoucher يرفض الربط بملغاة).
  let voucherInvoiceId: number | null = null;
  if (plan.invoiceId != null) {
    const inv = (await db.select({ status: invoices.status, customerId: invoices.customerId }).from(invoices).where(eq(invoices.id, Number(plan.invoiceId))).limit(1))[0];
    if (inv && inv.status !== "CANCELLED" && inv.status !== "RETURNED" && Number(inv.customerId) === Number(plan.customerId)) {
      voucherInvoiceId = Number(plan.invoiceId);
    }
  }

  // فئة سند مناسبة (best-effort): أول فئة قبض نشطة يذكر اسمها الأقساط/التحصيل — وإلّا بلا فئة
  // (الفئات بيانات إدارية غير مبذورة إلزامياً؛ الوصف يحمل الدلالة كاملة).
  const cat = (
    await db
      .select({ id: voucherCategories.id })
      .from(voucherCategories)
      .where(
        and(
          eq(voucherCategories.isActive, true),
          inArray(voucherCategories.direction, ["IN", "BOTH"]),
          or(like(voucherCategories.name, "%قسط%"), like(voucherCategories.name, "%أقساط%")),
        ),
      )
      .limit(1)
  )[0];

  const checkInfo =
    line.kind === "CHECK"
      ? ` (شيك رقم ${line.checkNumber ?? "—"}${line.bankName ? ` — ${line.bankName}` : ""})`
      : "";
  const description = `تحصيل القسط رقم ${line.seq} من خطة الأقساط #${plan.id}${checkInfo}`;

  const voucher = await createVoucher(
    {
      voucherType: "RECEIPT",
      branchId: Number(plan.branchId),
      amount: toDbMoney(line.amount),
      paymentMethod: method,
      partyType: "CUSTOMER",
      partyId: Number(plan.customerId),
      description,
      checkNumber: method === "CHECK" ? (line.checkNumber ?? undefined) : undefined,
      voucherCategoryId: cat?.id != null ? Number(cat.id) : null,
      invoiceId: voucherInvoiceId,
      attachmentUrl: input.attachmentUrl ?? null,
      internalNote: input.note?.trim() || null,
      clientRequestId: `instpay-${Number(line.id)}`,
    },
    actor,
  );

  if (voucher.approvalStatus === "PENDING_APPROVAL") {
    // لا أثر مالي بعد ⇒ القسط يبقى PENDING؛ نوثّق السند المعلَّق في ملاحظة القسط.
    await db
      .update(installmentLines)
      .set({
        receiptId: voucher.receiptId,
        note: `سند قبض ${voucher.voucherNumber} بانتظار اعتماد مدير ثانٍ (Maker-Checker)`.slice(0, 255),
      })
      .where(eq(installmentLines.id, Number(line.id)));
    return { status: "PENDING_APPROVAL", receiptId: voucher.receiptId, voucherNumber: voucher.voucherNumber, planCompleted: false };
  }
  // #installments-3 (تدقيق التثبيت): حارس أمان — لا نُوسم القسط PAID إلا بسند APPROVED فعلاً.
  // idempotency الجديد يتجاوز الـreplay على المرفوض (voucher/create.ts) لكن نُبقي هذا الحارس دفاعاً
  // متعدّد الطبقات لكل مسار محتمل يُنتج سنداً بحالة غير APPROVED (لا أثر مالي).
  if (voucher.approvalStatus !== "APPROVED") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `السند ${voucher.voucherNumber} غير معتمد (${voucher.approvalStatus}) — لا يمكن وسم القسط مدفوعاً`,
    });
  }

  // السند مُعتمَد ونافذ مالياً ⇒ وسم القسط PAID + فحص اكتمال الخطة، ذرّياً تحت قفل الصفّ.
  return withTx(async (tx) => {
    const locked = (
      await tx.select().from(installmentLines).where(eq(installmentLines.id, Number(line.id))).for("update").limit(1)
    )[0];
    if (!locked) throw new TRPCError({ code: "NOT_FOUND", message: "القسط غير موجود" });
    if (locked.status === "PAID") {
      // سباق/إعادة محاولة: سُدِّد بالفعل — بنفس السند (idempotency) ⇒ نجاح صامت؛ بغيره ⇒ تعارض.
      if (locked.receiptId != null && Number(locked.receiptId) === Number(voucher.receiptId)) {
        return { status: "PAID" as const, receiptId: voucher.receiptId, voucherNumber: voucher.voucherNumber, planCompleted: false };
      }
      throw new TRPCError({ code: "CONFLICT", message: "القسط سُدِّد بسند آخر بالتوازي — حدّث الشاشة" });
    }
    if (locked.status === "CANCELLED") {
      throw new TRPCError({ code: "CONFLICT", message: "أُلغي القسط أثناء السداد — راجع السند المُنشأ" });
    }

    await tx
      .update(installmentLines)
      .set({
        status: "PAID",
        receiptId: voucher.receiptId,
        paidAt: new Date(),
        note: input.note?.trim() ? input.note.trim().slice(0, 255) : locked.note,
      })
      .where(eq(installmentLines.id, Number(line.id)));

    // اكتمال الخطة: لا قسط PENDING/BOUNCED متبقٍّ ⇒ COMPLETED.
    const remaining = (
      await tx
        .select({ n: sql<number>`COUNT(*)` })
        .from(installmentLines)
        .where(
          and(
            eq(installmentLines.planId, Number(plan.id)),
            inArray(installmentLines.status, ["PENDING", "BOUNCED"]),
          ),
        )
    )[0];
    const planCompleted = Number(remaining?.n ?? 0) === 0;
    if (planCompleted) {
      await tx.update(installmentPlans).set({ status: "COMPLETED" }).where(eq(installmentPlans.id, Number(plan.id)));
    }

    return { status: "PAID" as const, receiptId: voucher.receiptId, voucherNumber: voucher.voucherNumber, planCompleted };
  });
}
