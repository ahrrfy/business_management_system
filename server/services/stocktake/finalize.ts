// إنهاء الجلسة: الاعتماد والتسوية الذرّية، الإقفال اليدوي للمراجعة، الإلغاء، وإعادة توليد PIN.
import { TRPCError } from "@trpc/server";
import { randomInt } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  branchStock,
  stocktakeAssignments,
  stocktakeDecisions,
  stocktakeItems,
  stocktakeSessions,
} from "../../../drizzle/schema";
import { hashPassword, verifyPassword } from "../../auth/password";
import { setStock } from "../inventoryService";
import { postEntry } from "../ledgerService";
import { money, toDbMoney } from "../money";
import { withTx } from "../tx";
import type { StkActor } from "./types";
import { assertBranchAccess, chunk, lockSession } from "./internal";
import { loadReviewCore, willAdjust } from "./reviewCore";

export interface ApproveResult {
  ok: true;
  alreadyApproved?: boolean;
  adjustedCount: number;
  shortExpense: string;
  overGain: string;
}

/**
 * الاعتماد والتسوية — الخوارزمية الذرّية (العقد §٢ «الاعتماد») خطوة خطوة داخل withTx واحدة:
 * idempotent على APPROVED، حواجز (recount/تعارض/قرارات)، توقيعان بمستخدمَين مختلفَين (تحقّق
 * خادمي بالمعرّف)، إعادة حساب كاملة داخل المعاملة، setStock حصراً بمرجع STOCKTAKE،
 * قرارات تلقائية (ADJUST ضمن الحد + KEEP للمطابق — يلزم لسجل IRA)، قيدا دفتر بـdedupeKey،
 * ثم lastCountedAt لكل معدود وختم الجلسة APPROVED.
 */
export async function approveStocktake(sessionId: number, actor: StkActor): Promise<ApproveResult> {
  return withTx(async (tx) => {
    // (١) قفل الجلسة. APPROVED ⇒ نجاح بلا أثر (idempotent — حماية النقر المزدوج/إعادة الشبكة).
    const s = await lockSession(tx, sessionId);
    if (s.status === "APPROVED") {
      return { ok: true as const, alreadyApproved: true, adjustedCount: 0, shortExpense: "0.00", overGain: "0.00" };
    }
    if (s.status !== "REVIEW") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الاعتماد متاح على جلسة قيد المراجعة فقط" });
    }

    // (١.٥) قفل أرصدة أصناف الجلسة FOR UPDATE قبل إعادة الحساب — يسدّ سباق TOCTOU مع بيع
    // متزامن: بدونه يُحتسب bookNow/netAfter على لقطة، يلتزم بيعٌ أثناءها، ثم يكتب setStock
    // هدفاً مطلقاً محسوباً على القديم فيمحو أثر البيع من الرصيد. الترتيب تصاعدي بالـvariantId
    // (نفس ترتيب التسويات لاحقاً) لتقليل نوافذ deadlock مع معاملات متعددة الأسطر.
    const lockIds = (
      await tx
        .select({ variantId: stocktakeItems.variantId })
        .from(stocktakeItems)
        .where(eq(stocktakeItems.sessionId, sessionId))
        .orderBy(asc(stocktakeItems.variantId))
    ).map((r) => Number(r.variantId));
    for (const part of chunk(lockIds)) {
      await tx
        .select({ id: branchStock.id })
        .from(branchStock)
        .where(and(eq(branchStock.branchId, Number(s.branchId)), inArray(branchStock.variantId, part)))
        .orderBy(asc(branchStock.variantId))
        .for("update");
    }

    // (٤ قبل ٢) أعد الحساب داخل المعاملة — لا ثقة بحسابات شاشة المراجعة.
    const { rows, directUnderThreshold } = await loadReviewCore(tx, sessionId, true);

    // (٢) الحواجز.
    const pendingRecounts = rows.filter((r) => r.recount?.status === "PENDING");
    if (pendingRecounts.length) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `لا اعتماد و${pendingRecounts.length} صنفاً بانتظار إعادة العدّ`,
      });
    }
    const openConflicts = rows.filter((r) => r.openConflict);
    if (openConflicts.length) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `لا اعتماد ويوجد ${openConflicts.length} تعارض عدَّين بلا فصل`,
      });
    }
    const undecided = rows.filter((r) => {
      if (r.diff == null || r.diff === 0 || r.decision) return false;
      return r.overThreshold || !directUnderThreshold;
    });
    if (undecided.length) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `${undecided.length} فرقاً يحتاج قراراً صريحاً (تسوية/إبقاء) قبل الاعتماد`,
      });
    }

    // (٣) التوقيعان: عنصر سيُسوّى |قيمته| > dualThreshold ⇒ توقيع أول موجود + المعتمد شخص مختلف.
    const dualNeeded = rows.some((r) => r.requiresDualSign && willAdjust(r, directUnderThreshold));
    if (dualNeeded) {
      if (s.firstSignBy == null) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "فروقات تتجاوز حدّ التوقيعين — يلزم توقيع أول ثم اعتماد نهائي من مسؤول آخر",
        });
      }
      if (Number(s.firstSignBy) === actor.userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "وقّعتَ التوقيع الأول — الاعتماد النهائي يلزم أن يكون من مسؤول آخر",
        });
      }
    }

    const now = new Date();

    // (٤+٥) التسويات والقرارات النهائية.
    let adjustedMovements = 0;
    let shortExpense = money(0);
    let overGain = money(0);
    type DecisionUpsert = typeof stocktakeDecisions.$inferInsert;
    const upserts: DecisionUpsert[] = [];

    for (const r of rows) {
      if (r.rawCount == null || r.adjustedCount == null || r.diff == null) continue; // غير معدود ⇒ يبقى دفترياً بلا قرار

      let action: "ADJUST" | "KEEP";
      let decidedBy: number | null;
      let autoApplied: boolean;
      let reason: DecisionUpsert["reason"];
      let note: string | null;
      if (r.diff === 0) {
        // مطابق ⇒ KEEP تلقائي (يلزم لسجل IRA والمحضر). قرار صريح سابق يتحوّل KEEP بقيم نهائية.
        action = "KEEP";
        decidedBy = r.decision && !r.decision.autoApplied ? r.decidedBy : null;
        autoApplied = !(r.decision && !r.decision.autoApplied);
        reason = (r.decision?.reason as DecisionUpsert["reason"]) ?? "UNSPECIFIED";
        note = r.decision?.note ?? null;
      } else if (r.decision) {
        action = r.decision.action;
        decidedBy = r.decidedBy;
        autoApplied = r.decision.autoApplied;
        reason = r.decision.reason as DecisionUpsert["reason"];
        note = r.decision.note ?? null;
      } else if (r.withinThreshold && directUnderThreshold) {
        // (٥) ضمن الحد بلا قرار ⇒ تسوية تلقائية.
        action = "ADJUST";
        decidedBy = null;
        autoApplied = true;
        reason = "UNSPECIFIED";
        note = null;
      } else {
        // مستحيل منطقياً بعد حاجز undecided — حارس دفاعي.
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "حالة قرار غير متوقعة أثناء الاعتماد" });
      }

      if (action === "ADJUST" && r.diff !== 0) {
        if (r.adjustedCount < 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `العدّ المصحَّح سالب للصنف «${r.productName}» — راجع الحركات اللاحقة قبل الاعتماد`,
          });
        }
        await setStock(tx, {
          variantId: r.variantId,
          branchId: Number(s.branchId),
          targetQuantity: r.adjustedCount,
          referenceType: "STOCKTAKE",
          referenceId: sessionId,
          notes: s.code,
          createdBy: actor.userId,
        });
        adjustedMovements++;
        const v = money(r.value ?? 0);
        if (r.diff < 0) shortExpense = shortExpense.plus(v.abs());
        else overGain = overGain.plus(v);
      }

      upserts.push({
        sessionId,
        variantId: r.variantId,
        action,
        finalQty: r.adjustedCount,
        diffQty: r.diff,
        value: toDbMoney(money(r.value ?? 0)),
        reason,
        note,
        decidedBy,
        autoApplied,
      });
    }

    // تثبيت كل القرارات بقيمها النهائية (upsert مجمّع على UNIQUE(sessionId, variantId)).
    for (const part of chunk(upserts, 500)) {
      await tx
        .insert(stocktakeDecisions)
        .values(part)
        .onDuplicateKeyUpdate({
          set: {
            action: sql.raw("VALUES(`action`)"),
            finalQty: sql.raw("VALUES(`finalQty`)"),
            diffQty: sql.raw("VALUES(`diffQty`)"),
            value: sql.raw("VALUES(`value`)"),
            reason: sql.raw("VALUES(`reason`)"),
            note: sql.raw("VALUES(`note`)"),
            decidedBy: sql.raw("VALUES(`decidedBy`)"),
            autoApplied: sql.raw("VALUES(`autoApplied`)"),
          },
        });
    }

    // (٦) القيدان المحاسبيان — قرار التقارير (مفحوص في reportsRouter/reportsService/reconcileService):
    //   - تقارير الربح والمبيعات (salesReport/topProducts/profitByCategory) تُشتق من invoices/invoiceItems
    //     لا من accountingEntries ⇒ قيد ADJUST لا يمسّ المبيعات إطلاقاً.
    //   - الصندوق/الوردية يُشتقان من receipts ⇒ amount=0 لا يلمس الصندوق.
    //   - reconcileLedgerProfit يفرض profit = revenue − cost على كل قيد ⇒ نكتب profit = −cost:
    //     عجز: cost موجب ⇒ profit سالب (ينخفض الربح بقيمة العجز)؛
    //     زيادة: cost سالب ⇒ profit موجب (يرتفع الربح بقيمة الزيادة). dedupeKey يمنع الازدواج بنيوياً.
    if (shortExpense.gt(0)) {
      await postEntry(tx, {
        entryType: "ADJUST",
        branchId: Number(s.branchId),
        cost: shortExpense,
        profit: shortExpense.neg(),
        amount: money(0),
        notes: `جرد ${s.code} — عجز مخزون`,
        dedupeKey: `STOCKTAKE:${sessionId}:SHORT`,
        entryDate: now,
      });
    }
    if (overGain.gt(0)) {
      await postEntry(tx, {
        entryType: "ADJUST",
        branchId: Number(s.branchId),
        cost: overGain.neg(),
        profit: overGain,
        amount: money(0),
        notes: `جرد ${s.code} — زيادة جرد`,
        dedupeKey: `STOCKTAKE:${sessionId}:OVER`,
        entryDate: now,
      });
    }

    // (٧) آخر جرد معتمد لكل صنف معدود — يغذي «آخر جرد» والجرد الدوري ABC.
    // upsert لا UPDATE: صنف عُدّ صفراً بلا صفّ branchStock يبقى بلا صفّ فيظلّ «لم يُجرد» زوراً.
    const countedVariantIds = rows.filter((r) => r.rawCount != null).map((r) => r.variantId);
    for (const part of chunk(countedVariantIds)) {
      if (!part.length) continue;
      await tx
        .insert(branchStock)
        .values(part.map((v) => ({ variantId: v, branchId: Number(s.branchId), quantity: 0, lastCountedAt: now })))
        .onDuplicateKeyUpdate({ set: { lastCountedAt: now } });
    }

    // (٨) ختم الجلسة.
    await tx
      .update(stocktakeSessions)
      .set({ status: "APPROVED", approvedBy: actor.userId, approvedAt: now })
      .where(eq(stocktakeSessions.id, sessionId));

    return {
      ok: true as const,
      adjustedCount: adjustedMovements,
      shortExpense: toDbMoney(shortExpense),
      overGain: toDbMoney(overGain),
    };
  });
}

/** إقفال العدّ يدوياً: كل التكليفات ACTIVE ⇒ SUBMITTED والجلسة ⇒ REVIEW (مراجعة جزئية مسموحة). */
export async function forceStocktakeReview(sessionId: number, _actor: StkActor): Promise<{ ok: true }> {
  return withTx(async (tx) => {
    const s = await lockSession(tx, sessionId);
    if (s.status === "REVIEW") return { ok: true as const }; // idempotent
    if (s.status !== "COUNTING") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "إقفال العدّ متاح على جلسة قيد العدّ فقط" });
    }
    const now = new Date();
    await tx
      .update(stocktakeAssignments)
      .set({ status: "SUBMITTED", submittedAt: now })
      .where(and(eq(stocktakeAssignments.sessionId, sessionId), eq(stocktakeAssignments.status, "ACTIVE")));
    await tx.update(stocktakeSessions).set({ status: "REVIEW", submittedAt: now }).where(eq(stocktakeSessions.id, sessionId));
    return { ok: true as const };
  });
}

/** إلغاء جلسة (أدمن): لا أثر مخزونياً — الجلسة لم تُسوَّ بعد. المعتمدة لا تُلغى. */
export async function cancelStocktakeSession(
  args: { sessionId: number; reason?: string },
  actor: StkActor
): Promise<{ ok: true }> {
  return withTx(async (tx) => {
    const s = await lockSession(tx, args.sessionId);
    if (s.status === "CANCELLED") return { ok: true as const }; // idempotent
    if (s.status === "APPROVED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إلغاء جلسة معتمدة — التسوية نُفّذت فعلاً" });
    }
    const notes = args.reason?.trim()
      ? `${s.notes ? `${s.notes}\n` : ""}سبب الإلغاء: ${args.reason.trim()}`
      : s.notes;
    await tx
      .update(stocktakeSessions)
      .set({ status: "CANCELLED", cancelledBy: actor.userId, cancelledAt: new Date(), notes })
      .where(eq(stocktakeSessions.id, args.sessionId));
    return { ok: true as const };
  });
}

/** إعادة توليد PIN لتكليف خارجي: يُصفِّر قفل المحاولات ويعيد النص مرة واحدة فقط. */
export async function regenerateStocktakePin(
  assignmentId: number,
  opts: { restrictBranchId?: number | null } = {}
): Promise<{ pin: string }> {
  return withTx(async (tx) => {
    const rows = await tx
      .select({
        id: stocktakeAssignments.id,
        sessionId: stocktakeAssignments.sessionId,
        method: stocktakeAssignments.method,
        sessionStatus: stocktakeSessions.status,
        branchId: stocktakeSessions.branchId,
      })
      .from(stocktakeAssignments)
      .innerJoin(stocktakeSessions, eq(stocktakeAssignments.sessionId, stocktakeSessions.id))
      .where(eq(stocktakeAssignments.id, assignmentId))
      .for("update")
      .limit(1);
    const a = rows[0];
    if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "تكليف الجرد غير موجود" });
    assertBranchAccess(Number(a.branchId), opts.restrictBranchId);
    if (a.method !== "PIN") throw new TRPCError({ code: "BAD_REQUEST", message: "هذا التكليف بحساب داخلي — لا PIN له" });
    if (a.sessionStatus !== "COUNTING") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "إعادة توليد PIN متاحة أثناء العدّ فقط" });
    }

    // فرادة PIN داخل الجلسة: لا نملك النصوص (hash فقط) ⇒ نتحقق بـverifyPassword ضد بقية التكليفات.
    const siblings = await tx
      .select({ id: stocktakeAssignments.id, pinHash: stocktakeAssignments.pinHash })
      .from(stocktakeAssignments)
      .where(and(eq(stocktakeAssignments.sessionId, Number(a.sessionId)), eq(stocktakeAssignments.method, "PIN")));
    let pin = "";
    outer: for (let i = 0; i < 100; i++) {
      pin = String(randomInt(0, 10000)).padStart(4, "0");
      for (const sib of siblings) {
        if (Number(sib.id) !== assignmentId && sib.pinHash && verifyPassword(pin, sib.pinHash)) continue outer;
      }
      break;
    }
    if (!pin) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر توليد رمز PIN فريد" });

    await tx
      .update(stocktakeAssignments)
      .set({ pinHash: hashPassword(pin), failedPinAttempts: 0, lockedUntil: null })
      .where(eq(stocktakeAssignments.id, assignmentId));
    return { pin };
  });
}
