// دورة حياة خطة الأقساط: الإنشاء (createPlan) والإلغاء بلا أي قسط مسدَّد (cancelPlan).
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  branches,
  customers,
  idempotencyKeys,
  installmentLines,
  installmentPlans,
  invoices,
  receipts,
} from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { money, sumMoney, toDbMoney } from "../money";
import { type Actor, withTx } from "../tx";
import { assertPlanBranch, type BranchRestriction, type CreatePlanInput, YMD_RE } from "./types";

/* ============================ إنشاء خطة ============================ */

export async function createPlan(input: CreatePlanInput, actor: Actor): Promise<{ planId: number }> {
  const total = money(input.totalAmount);
  if (total.lte(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "إجمالي الخطة يجب أن يكون موجباً" });
  }
  const down = money(input.downPayment ?? "0");
  if (down.isNegative()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الدفعة الأولى لا يمكن أن تكون سالبة" });
  }
  // قرار المالك (١٢/٨) — «لا دينار بلا مسار وبلا سند وبلا قيد»: الدفعة الأولى نقدٌ يدخل، فيجب تسجيلها
  // **سندَ قبضٍ فعليّاً** (إيصال IN + قيد PAYMENT_IN + مسارٌ منسوب) قبل الخطة، ثمّ تُبنى الخطة على المتبقّي.
  // كان يُرفَض للفاتورة المرتبطة فقط (أدناه) بينما يُخزَّن صامتاً للخطة المستقلّة (invoiceId=null) — دينارٌ
  // بلا سند. الآن يُرفَض **لكلّ** خطةٍ تحت الإنفاذ، فلا تُخزَّن دفعةٌ أولى بلا سند من أيّ قناة.
  if (input.enforceFinancialIntegrity && !down.isZero()) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "الدفعة الأولى يجب تسجيلها سندَ قبضٍ نقديٍّ فعليّاً أولاً (لا دينار بلا سند)، ثمّ إنشاء الخطة على المتبقّي.",
    });
  }
  if (!input.lines || input.lines.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الخطة تحتاج قسطاً واحداً على الأقل" });
  }

  // تحقّقات الأسطر: مبالغ موجبة + تواريخ صالحة متصاعدة + شيك برقم شيك.
  for (let i = 0; i < input.lines.length; i++) {
    const ln = input.lines[i];
    if (money(ln.amount).lte(0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `مبلغ القسط رقم ${i + 1} يجب أن يكون موجباً` });
    }
    if (!YMD_RE.test(ln.dueDate)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `تاريخ القسط رقم ${i + 1} غير صالح (YYYY-MM-DD)` });
    }
    if (i > 0 && ln.dueDate < input.lines[i - 1].dueDate) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `تواريخ الأقساط يجب أن تكون متصاعدة — القسط رقم ${i + 1} (${ln.dueDate}) أسبق من الذي قبله (${input.lines[i - 1].dueDate})`,
      });
    }
    if (ln.kind === "CHECK" && !ln.checkNumber?.trim()) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `القسط رقم ${i + 1} شيك — رقم الشيك إلزامي` });
    }
  }

  // Σ(الأقساط) + الدفعة الأولى = الإجمالي، بدقّة decimal (لا floats).
  const linesSum = sumMoney(input.lines.map((l) => l.amount));
  const scheduled = linesSum.plus(down);
  if (!scheduled.eq(total)) {
    const diff = total.minus(scheduled);
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `مجموع الأقساط (${toDbMoney(linesSum)}) + الدفعة الأولى (${toDbMoney(down)}) لا يطابق إجمالي الخطة (${toDbMoney(total)}) — الفرق ${toDbMoney(diff)} د.ع`,
    });
  }

  return withTx(async (tx) => {
    const cust = (await tx.select().from(customers).where(eq(customers.id, input.customerId)).limit(1))[0];
    if (!cust) throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });
    if (!cust.isActive) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إنشاء خطة أقساط لعميل مُعطَّل" });
    }

    const br = (await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, input.branchId)).limit(1))[0];
    if (!br) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود" });

    if (input.invoiceId != null) {
      const inv = (
        await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).for("update").limit(1)
      )[0];
      if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة المرتبطة غير موجودة" });
      if (Number(inv.customerId) !== Number(input.customerId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "الفاتورة المرتبطة لا تخصّ هذا العميل" });
      }
      if (input.enforceFinancialIntegrity && Number(inv.branchId) !== Number(input.branchId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "الفاتورة المرتبطة لا تخصّ فرع الخطة" });
      }
      if (inv.status === "CANCELLED" || inv.status === "RETURNED") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن الربط بفاتورة ملغاة أو مرتجعة" });
      }
      const outstanding = money(inv.total).minus(money(inv.returnedTotal ?? "0")).minus(money(inv.paidAmount));
      if (input.enforceFinancialIntegrity && outstanding.lte(0)) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الفاتورة لا تحمل مبلغاً متبقياً للتقسيط" });
      }
      if (input.enforceFinancialIntegrity && !total.eq(outstanding)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `إجمالي الخطة (${toDbMoney(total)}) يجب أن يساوي متبقي الفاتورة (${toDbMoney(outstanding)})`,
        });
      }
      // (رفض الدفعة الأولى بلا سند صار حارساً موحَّداً في صدر الدالة — لكلّ خطة لا للمرتبطة فقط.)
      if (input.enforceFinancialIntegrity) {
        const activePlan = (
          await tx
            .select({ id: installmentPlans.id })
            .from(installmentPlans)
            .where(and(eq(installmentPlans.invoiceId, input.invoiceId), eq(installmentPlans.status, "ACTIVE")))
            .limit(1)
        )[0];
        if (activePlan) {
          throw new TRPCError({ code: "CONFLICT", message: "توجد خطة أقساط نشطة لهذه الفاتورة بالفعل" });
        }
      }
    }

    // لا قيد محاسبي هنا عمداً — الخطة جدولة تحصيل فوق الذمّة القائمة (راجع رأس الملف).
    const planRes = await tx.insert(installmentPlans).values({
      customerId: input.customerId,
      invoiceId: input.invoiceId ?? null,
      branchId: input.branchId,
      totalAmount: toDbMoney(total),
      downPayment: toDbMoney(down),
      status: "ACTIVE",
      notes: input.notes?.trim() || null,
      createdBy: actor.userId,
    });
    const planId = extractInsertId(planRes);

    await tx.insert(installmentLines).values(
      input.lines.map((ln, i) => ({
        planId,
        seq: i + 1,
        dueDate: ln.dueDate,
        amount: toDbMoney(ln.amount),
        kind: ln.kind,
        checkNumber: ln.kind === "CHECK" ? (ln.checkNumber?.trim() ?? null) : (ln.checkNumber?.trim() || null),
        bankName: ln.bankName?.trim() || null,
        status: "PENDING" as const,
      })),
    );

    return { planId };
  });
}

/* ============================ إلغاء خطة ============================ */

/** إلغاء خطة بلا أي قسط مسدَّد: الخطة CANCELLED وأقساطها المعلَّقة/المرتجعة CANCELLED. */
export async function cancelPlan(
  input: { planId: number; reason?: string | null },
  _actor: Actor,
  restrictToBranchId: BranchRestriction = null,
): Promise<{ planId: number }> {
  return withTx(async (tx) => {
    const plan = (
      await tx.select().from(installmentPlans).where(eq(installmentPlans.id, input.planId)).for("update").limit(1)
    )[0];
    if (!plan) throw new TRPCError({ code: "NOT_FOUND", message: "الخطة غير موجودة" });
    assertPlanBranch(Number(plan.branchId), restrictToBranchId);
    if (plan.status !== "ACTIVE") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الخطة ليست نشطة — لا يمكن إلغاؤها" });
    }
    const paid = (
      await tx
        .select({ n: sql<number>`COUNT(*)` })
        .from(installmentLines)
        .where(and(eq(installmentLines.planId, input.planId), eq(installmentLines.status, "PAID")))
    )[0];
    if (Number(paid?.n ?? 0) > 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يمكن إلغاء خطة سُدِّد منها قسط — ألغِ السندات أولاً من شاشة السندات إن لزم",
      });
    }
    const planLines = await tx
      .select({ id: installmentLines.id, receiptId: installmentLines.receiptId })
      .from(installmentLines)
      .where(eq(installmentLines.planId, input.planId));
    const directReceiptIds = planLines
      .map((line) => line.receiptId != null ? Number(line.receiptId) : null)
      .filter((id): id is number => id != null);
    const requestIds = planLines.map((line) => `instpay-${Number(line.id)}`);
    const keyRows = requestIds.length
      ? await tx
          .select({ refId: idempotencyKeys.refId })
          .from(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.operation, "voucher.create"),
              inArray(idempotencyKeys.clientRequestId, requestIds),
            ),
          )
      : [];
    const receiptIds = Array.from(new Set([
      ...directReceiptIds,
      ...keyRows.map((row) => Number(row.refId)),
    ]));
    if (receiptIds.length > 0) {
      const approved = (
        await tx
          .select({ n: sql<number>`COUNT(*)` })
          .from(receipts)
          .where(
            and(
              inArray(receipts.id, receiptIds),
              eq(receipts.approvalStatus, "APPROVED"),
              eq(receipts.status, "COMPLETED"),
            ),
          )
      )[0];
      if (Number(approved?.n ?? 0) > 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "لا يمكن إلغاء خطة لها سند تحصيل معتمد؛ زامن السداد أو اعكس السند أولاً",
        });
      }
      // المسار و-٢ (١٧/٨): الحارس كان يفحص **المعتمَد المنجَز** فقط، فسندُ تحصيلٍ ما زال في
      // طابور الاعتماد يبقى يتيماً بعد إلغاء خطته: يعتمده مديرٌ لاحقاً فيُقيَّد نقدٌ على خطةٍ
      // ملغاة (والمعتمِد لا يرى في الطابور أنّ خطتها أُلغيت). لا نُلغيه هنا ضمناً — إلغاء
      // مستندٍ ماليّ قرارُ صاحبه لا أثرٌ جانبيّ لعمليةٍ أخرى — بل نوقف الإلغاء ونسمّي المطلوب.
      const pending = (
        await tx
          .select({ n: sql<number>`COUNT(*)` })
          .from(receipts)
          .where(
            and(
              inArray(receipts.id, receiptIds),
              eq(receipts.approvalStatus, "PENDING_APPROVAL"),
              sql`${receipts.status} <> 'REVERSED'`,
            ),
          )
      )[0];
      if (Number(pending?.n ?? 0) > 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "لا يمكن إلغاء خطة لها سند تحصيل في انتظار الاعتماد؛ ارفض السند أو ألغِه أولاً",
        });
      }
    }
    const reason = input.reason?.trim();
    await tx
      .update(installmentPlans)
      .set({
        status: "CANCELLED",
        notes: reason ? `${plan.notes ? `${plan.notes}\n` : ""}أُلغيت: ${reason}` : plan.notes,
      })
      .where(eq(installmentPlans.id, input.planId));
    await tx
      .update(installmentLines)
      .set({ status: "CANCELLED" })
      .where(and(eq(installmentLines.planId, input.planId), inArray(installmentLines.status, ["PENDING", "BOUNCED"])));
    return { planId: input.planId };
  });
}
