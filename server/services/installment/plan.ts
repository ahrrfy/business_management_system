// دورة حياة خطة الأقساط: الإنشاء (createPlan) والإلغاء بلا أي قسط مسدَّد (cancelPlan).
import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import {
  branches,
  customers,
  installmentLines,
  installmentPlans,
  invoices,
  receipts,
} from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import {
  checkIdempotency,
  idempotencyHash,
  recordIdempotencyKey,
} from "../idempotency";
import { money, sumMoney, toDbMoney } from "../money";
import { invoiceRemaining } from "@shared/predicates";
import { requireDb, type Actor, withTx } from "../tx";
import { assertPlanBranch, type BranchRestriction, type CreatePlanInput, YMD_RE } from "./types";

import { lockInstallmentPlanTx, installmentConflict, installmentScopeHash, assertInstallmentScopeTx } from "./receiptAllocations";

/* ============================ إنشاء خطة ============================ */

export async function createPlan(input: CreatePlanInput, actor: Actor): Promise<{ planId: number }> {
  const clientRequestId = input.clientRequestId.trim();
  if (!clientRequestId || clientRequestId.length > 36) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "معرّف طلب إنشاء الخطة إلزامي" });
  }
  const total = money(input.totalAmount);
  if (total.lte(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "إجمالي الخطة يجب أن يكون موجباً" });
  }
  const down = money(input.downPayment ?? "0");
  if (down.isNegative()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الدفعة الأولى لا يمكن أن تكون سالبة" });
  }
  // الخطة تساوي المتبقّي الحيّ كاملاً. أي دفعة أولى يجب أن تُقبض على الفاتورة أولاً، ثم تُقرأ
  // قيمة outstanding الجديدة لإنشاء الخطة؛ تخزين دفعة صامتة هنا يجعل الخطة لا تطابق الذمّة.
  if (!down.isZero()) {
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
  const createHash = idempotencyHash({
    customerId: input.customerId,
    invoiceId: input.invoiceId,
    branchId: input.branchId,
    totalAmount: toDbMoney(total),
    downPayment: toDbMoney(down),
    notes: input.notes?.trim() || null,
    lines: input.lines.map((line) => ({
      dueDate: line.dueDate,
      amount: toDbMoney(line.amount),
      kind: line.kind,
      checkNumber: line.checkNumber?.trim() || null,
      bankName: line.bankName?.trim() || null,
    })),
  });

  return withTx(async (tx) => {
    // ترتيب الأقفال الحاكم: invoice -> active plan. كل pay/cancel/return/reissue يلتزم الترتيب نفسه.
    const inv = (
      await tx
        .select()
        .from(invoices)
        .where(eq(invoices.id, input.invoiceId))
        .for("update")
        .limit(1)
    )[0];
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة المرتبطة غير موجودة" });

    const replayPlanId = await checkIdempotency(
      tx,
      "installment.create",
      clientRequestId,
      createHash,
      { requireStoredHash: true },
    );
    if (replayPlanId != null) {
      const replayPlan = (
        await tx
          .select({ id: installmentPlans.id, invoiceId: installmentPlans.invoiceId })
          .from(installmentPlans)
          .where(eq(installmentPlans.id, replayPlanId))
          .limit(1)
      )[0];
      if (!replayPlan || Number(replayPlan.invoiceId) !== Number(input.invoiceId)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "معرّف إنشاء الخطة مرتبط بسجل مفقود أو فاتورة مختلفة؛ راجع التدقيق",
        });
      }
      return { planId: Number(replayPlan.id) };
    }

    const cust = (await tx.select().from(customers).where(eq(customers.id, input.customerId)).limit(1))[0];
    if (!cust) throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });
    if (!cust.isActive) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إنشاء خطة أقساط لعميل مُعطَّل" });
    }

    const br = (await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, input.branchId)).limit(1))[0];
    if (!br) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود" });

    if (Number(inv.customerId) !== Number(input.customerId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الفاتورة المرتبطة لا تخصّ هذا العميل" });
    }
    if (Number(inv.branchId) !== Number(input.branchId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الفاتورة المرتبطة لا تخصّ فرع الخطة" });
    }
    if (inv.status === "CANCELLED" || inv.status === "RETURNED" || inv.status === "SUPERSEDED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن الربط بفاتورة ملغاة أو مرتجعة أو مستبدلة" });
    }
    const outstanding = invoiceRemaining(inv);
    if (outstanding.lte(0)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الفاتورة لا تحمل مبلغاً متبقياً للتقسيط" });
    }
    if (!total.eq(outstanding)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `إجمالي الخطة (${toDbMoney(total)}) يجب أن يساوي متبقي الفاتورة الحي (${toDbMoney(outstanding)})`,
      });
    }
    const activePlan = (
      await tx
        .select({ id: installmentPlans.id })
        .from(installmentPlans)
        .where(and(eq(installmentPlans.invoiceId, input.invoiceId), eq(installmentPlans.status, "ACTIVE")))
        .for("update")
        .limit(1)
    )[0];
    if (activePlan) {
      throw new TRPCError({ code: "CONFLICT", message: "توجد خطة أقساط نشطة لهذه الفاتورة بالفعل" });
    }

    // لا قيد محاسبي هنا عمداً — الخطة جدولة تحصيل فوق الذمّة القائمة (راجع رأس الملف).
    const planRes = await tx.insert(installmentPlans).values({
      customerId: input.customerId,
      invoiceId: input.invoiceId,
      branchId: input.branchId,
      totalAmount: toDbMoney(total),
      downPayment: toDbMoney(down),
      status: "ACTIVE",
      notes: input.notes?.trim() || null,
      createdBy: actor.userId,
    });
    const planId = extractInsertId(planRes);
    await recordIdempotencyKey(tx, "installment.scope", String(planId), inv.id, installmentScopeHash(inv));

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
        allocationHistoryReady: true, allocationHeadId: null, pendingAllocationClaimId: null,
      })),
    );
    await recordIdempotencyKey(
      tx,
      "installment.create",
      clientRequestId,
      planId,
      createHash,
    );

    return { planId };
  });
}

/* ============================ إلغاء خطة ============================ */

/** إلغاء خطة بلا أي قسط مسدَّد: الخطة CANCELLED وأقساطها المعلَّقة/المرتجعة CANCELLED. */
export async function cancelPlan(
  input: { planId: number; reason?: string | null; clientRequestId: string },
  _actor: Actor,
  restrictToBranchId: BranchRestriction = null,
): Promise<{ planId: number }> {
  const clientRequestId = input.clientRequestId.trim();
  if (!clientRequestId || clientRequestId.length > 36) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "معرّف طلب إلغاء الخطة غير صالح" });
  }
  // اقرأ مفتاح القفل خارج المعاملة. لو بدأت snapshot هنا داخلها قبل انتظار قفل الفاتورة،
  // فقد لا ترى الإلغاءُ قسطاً سدّده طلبٌ كان حائزاً القفل ثم التزم أثناء الانتظار.
  const preview = (
    await requireDb()
      .select({ invoiceId: installmentPlans.invoiceId })
      .from(installmentPlans)
      .where(eq(installmentPlans.id, input.planId))
      .limit(1)
  )[0];
  if (!preview) throw new TRPCError({ code: "NOT_FOUND", message: "الخطة غير موجودة" });
  return withTx(async (tx) => {
    let currentInvoice: typeof invoices.$inferSelect | undefined;
    if (preview.invoiceId != null) {
      const invoice = (
        await tx
          .select()
          .from(invoices)
          .where(eq(invoices.id, Number(preview.invoiceId)))
          .for("update")
          .limit(1)
      )[0];
      currentInvoice = invoice;
      if (!invoice) {
        throw new TRPCError({ code: "CONFLICT", message: "فاتورة الخطة مفقودة؛ أوقف الإلغاء وراجع التدقيق" });
      }
    }
    const plan = (
      await tx.select().from(installmentPlans).where(eq(installmentPlans.id, input.planId)).for("update").limit(1)
    )[0];
    if (!plan) throw new TRPCError({ code: "NOT_FOUND", message: "الخطة غير موجودة" });
    if ((plan.invoiceId == null ? null : Number(plan.invoiceId)) !== (preview.invoiceId == null ? null : Number(preview.invoiceId))) {
      throw new TRPCError({ code: "CONFLICT", message: "تغيّر ربط الخطة بالفاتورة؛ أعد المحاولة" });
    }
    assertPlanBranch(Number(plan.branchId), restrictToBranchId);
    const normalizedReason = input.reason?.trim() || null;
    const cancelHash = idempotencyHash({ planId: input.planId, reason: normalizedReason });
    const replayPlanId = await checkIdempotency(
      tx,
      "installment.cancel",
      clientRequestId,
      cancelHash,
      { requireStoredHash: true },
    );
    if (replayPlanId != null) {
      if (Number(replayPlanId) !== Number(input.planId)) {
        throw new TRPCError({ code: "CONFLICT", message: "معرّف طلب الإلغاء مستعمل لخطة أخرى" });
      }
      return { planId: input.planId };
    }
    if (plan.status !== "ACTIVE") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الخطة ليست نشطة — لا يمكن إلغاؤها" });
    }
    const state = await lockInstallmentPlanTx(tx, input.planId);
    if (!state) installmentConflict("الخطة التاريخية تحتاج مطابقة قبل الإلغاء");
    if (!currentInvoice) installmentConflict("فاتورة الخطة مفقودة");
    await assertInstallmentScopeTx(tx, state, currentInvoice);
    if (state.lines.some(line => line.paid.gt(0))) installmentConflict("لا يمكن إلغاء خطة سُدِّد منها قسط — ألغِ السندات أولاً");
    if (state.lines.some(line => line.pendingAllocationClaimId != null)) installmentConflict("لا يمكن إلغاء خطة لها سند في انتظار الاعتماد");
    // A legacy pointer is evidence to reconcile, never proof of a zero balance.
    // Existing allocation history already proves full inverses. A rejected pending
    // receipt is terminal and has no money effect; it may legitimately keep its pointer.
    for (const line of state.lines) {
      if (line.receiptId == null || line.allocations.some(row => row.effectReceiptId === line.receiptId)) continue;
      const [receipt] = await tx.select().from(receipts).where(eq(receipts.id, line.receiptId));
      if (receipt?.status === "COMPLETED" && receipt.approvalStatus === "APPROVED") {
        installmentConflict("لا يمكن إلغاء خطة لها سند تحصيل معتمد غير مطابق لسجل التخصيص؛ يلزم مطابقة السند الأصلي");
      }
      if (!receipt || receipt.approvalStatus !== "REJECTED" || receipt.status !== "FAILED" ||
        receipt.invoiceId !== state.plan.invoiceId || receipt.branchId !== state.plan.branchId ||
        receipt.partyType !== "CUSTOMER" || receipt.partyId !== state.plan.customerId || receipt.direction !== "IN") {
        installmentConflict("سند القسط المرتبط يحتاج مطابقة موثقة قبل الإلغاء");
      }
    }
    const reason = normalizedReason;
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
    await recordIdempotencyKey(
      tx,
      "installment.cancel",
      clientRequestId,
      input.planId,
      cancelHash,
    );
    return { planId: input.planId };
  });
}
