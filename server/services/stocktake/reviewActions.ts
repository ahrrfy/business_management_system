// معاملات المراجعة قبل الاعتماد: طلب إعادة العدّ، فصل التعارض، القرار الصريح، والتوقيع الأول.
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  stocktakeAssignments,
  stocktakeCounts,
  stocktakeDecisions,
  stocktakeItems,
  stocktakeSessions,
  users,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { withTx } from "../tx";
import type { StkActor } from "./types";
import { assertBranchAccess, lockSession } from "./internal";
import { loadReviewCore, willAdjust } from "./reviewCore";

async function getSessionItem(tx: Tx, sessionId: number, variantId: number) {
  const rows = await tx
    .select()
    .from(stocktakeItems)
    .where(and(eq(stocktakeItems.sessionId, sessionId), eq(stocktakeItems.variantId, variantId)))
    .limit(1);
  const item = rows[0];
  if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "الصنف ليس ضمن أصناف هذه الجلسة" });
  return item;
}

/**
 * طلب إعادة عدّ: مهمة PENDING تحجب الاعتماد حتى يصل عدّ RECOUNT عبر البوابة.
 * البوابة تشترط جلسة COUNTING وتكليفاً ACTIVE ⇒ نعيد فتحهما عند الطلب أثناء المراجعة
 * (وعند تسليم الجميع مجدداً تعود الجلسة لـREVIEW آلياً) — هذا هو التفسير المتّسق للعقد §٥.
 */
export async function requestStocktakeRecount(
  args: { sessionId: number; variantId: number; reason: string },
  actor: StkActor,
  opts: { restrictBranchId?: number | null } = {}
): Promise<{ ok: true }> {
  return withTx(async (tx) => {
    const s = await lockSession(tx, args.sessionId);
    assertBranchAccess(Number(s.branchId), opts.restrictBranchId);
    if (s.status !== "COUNTING" && s.status !== "REVIEW") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن طلب إعادة عدّ على جلسة معتمدة أو ملغاة" });
    }
    const item = await getSessionItem(tx, args.sessionId, args.variantId);
    const hasCount = (
      await tx
        .select({ id: stocktakeCounts.id })
        .from(stocktakeCounts)
        .where(and(eq(stocktakeCounts.sessionId, args.sessionId), eq(stocktakeCounts.variantId, args.variantId)))
        .limit(1)
    )[0];
    if (!hasCount) throw new TRPCError({ code: "BAD_REQUEST", message: "لا عدّ مسجّلاً لهذا الصنف بعد — لا حاجة لإعادة العدّ" });

    await tx
      .update(stocktakeItems)
      .set({
        recountStatus: "PENDING",
        recountReason: args.reason,
        recountRequestedBy: actor.userId,
        recountRequestedAt: new Date(),
      })
      .where(eq(stocktakeItems.id, Number(item.id)));

    // التعارض المفتوح يُحال للعدّ الثالث الحاسم (نمط jrd-review): يُغلق هنا ويتولّى RECOUNT الفصل.
    await tx
      .update(stocktakeCounts)
      .set({ isConflict: false })
      .where(
        and(
          eq(stocktakeCounts.sessionId, args.sessionId),
          eq(stocktakeCounts.variantId, args.variantId),
          eq(stocktakeCounts.isConflict, true),
          sql`${stocktakeCounts.resolvedPick} IS NULL`
        )
      );

    // قرار سابق على الصنف يسقط — سيُعاد بناؤه بعد العدّ الجديد.
    await tx
      .delete(stocktakeDecisions)
      .where(and(eq(stocktakeDecisions.sessionId, args.sessionId), eq(stocktakeDecisions.variantId, args.variantId)));

    // إعادة فتح تكليف الصنف والجلسة كي تقبل البوابة العدّ الجديد.
    await tx
      .update(stocktakeAssignments)
      .set({ status: "ACTIVE", submittedAt: null })
      .where(and(eq(stocktakeAssignments.id, Number(item.assignmentId)), eq(stocktakeAssignments.status, "SUBMITTED")));
    if (s.status === "REVIEW") {
      await tx
        .update(stocktakeSessions)
        // التوقيع الأول يُبطَل أيضاً: البيانات ستتغير بعد إعادة العدّ فلا يصح اعتماد نهائي على توقيع قديم.
        .set({ status: "COUNTING", submittedAt: null, firstSignBy: null, firstSignAt: null })
        .where(eq(stocktakeSessions.id, args.sessionId));
    }
    return { ok: true as const };
  });
}

/** إبطال التوقيع الأول عند أي تغيير لاحق في بيانات المراجعة (قرار/فصل تعارض) — لا اعتماد على توقيع لبيانات قديمة. */
async function invalidateFirstSign(tx: Tx, sessionId: number, firstSignBy: unknown): Promise<void> {
  if (firstSignBy == null) return;
  await tx
    .update(stocktakeSessions)
    .set({ firstSignBy: null, firstSignAt: null })
    .where(eq(stocktakeSessions.id, sessionId));
}

/** الفصل في تعارض عدَّين: اعتماد أحدهما (يبقى كلاهما موثَّقاً في السجل). */
export async function resolveStocktakeConflict(
  args: { sessionId: number; variantId: number; pick: "FIRST" | "VERIFY" },
  actor: StkActor
): Promise<{ ok: true }> {
  return withTx(async (tx) => {
    const s = await lockSession(tx, args.sessionId);
    if (s.status !== "COUNTING" && s.status !== "REVIEW") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن الفصل في تعارض على جلسة معتمدة أو ملغاة" });
    }
    const open = (
      await tx
        .select({ id: stocktakeCounts.id })
        .from(stocktakeCounts)
        .where(
          and(
            eq(stocktakeCounts.sessionId, args.sessionId),
            eq(stocktakeCounts.variantId, args.variantId),
            eq(stocktakeCounts.kind, "VERIFY"),
            eq(stocktakeCounts.isConflict, true),
            sql`${stocktakeCounts.resolvedPick} IS NULL`
          )
        )
        .orderBy(desc(stocktakeCounts.id))
        .limit(1)
    )[0];
    if (!open) throw new TRPCError({ code: "BAD_REQUEST", message: "لا تعارض مفتوحاً على هذا الصنف" });
    await tx
      .update(stocktakeCounts)
      .set({ resolvedPick: args.pick, resolvedBy: actor.userId, resolvedAt: new Date() })
      .where(eq(stocktakeCounts.id, Number(open.id)));
    await invalidateFirstSign(tx, args.sessionId, s.firstSignBy);
    return { ok: true as const };
  });
}

/** قرار مراجعة صريح (تسوية/إبقاء) — تُثبَّت قيمه النهائية عند الاعتماد. */
export async function decideStocktakeItem(
  args: {
    sessionId: number;
    variantId: number;
    action: "ADJUST" | "KEEP";
    reason: "UNSPECIFIED" | "DAMAGE" | "LOSS_THEFT" | "ENTRY_ERROR" | "PRINT_WASTE";
    note?: string;
  },
  actor: StkActor
): Promise<{ ok: true }> {
  return withTx(async (tx) => {
    const s = await lockSession(tx, args.sessionId);
    if (s.status !== "REVIEW") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "القرارات تُتّخذ على جلسة قيد المراجعة فقط" });
    }
    const item = await getSessionItem(tx, args.sessionId, args.variantId);
    if (item.recountStatus === "PENDING") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الصنف بانتظار إعادة العدّ — لا قرار قبل وصول العدّ الجديد" });
    }
    const hasCount = (
      await tx
        .select({ id: stocktakeCounts.id })
        .from(stocktakeCounts)
        .where(and(eq(stocktakeCounts.sessionId, args.sessionId), eq(stocktakeCounts.variantId, args.variantId)))
        .limit(1)
    )[0];
    if (!hasCount) throw new TRPCError({ code: "BAD_REQUEST", message: "لا عدّ مسجّلاً لهذا الصنف — لا يمكن اتخاذ قرار" });
    const openConflict = (
      await tx
        .select({ id: stocktakeCounts.id })
        .from(stocktakeCounts)
        .where(
          and(
            eq(stocktakeCounts.sessionId, args.sessionId),
            eq(stocktakeCounts.variantId, args.variantId),
            eq(stocktakeCounts.isConflict, true),
            sql`${stocktakeCounts.resolvedPick} IS NULL`
          )
        )
        .limit(1)
    )[0];
    if (openConflict) throw new TRPCError({ code: "BAD_REQUEST", message: "افصل في تعارض العدَّين أولاً قبل القرار" });

    await tx
      .insert(stocktakeDecisions)
      .values({
        sessionId: args.sessionId,
        variantId: args.variantId,
        action: args.action,
        reason: args.reason,
        note: args.note ?? null,
        decidedBy: actor.userId,
        autoApplied: false,
      })
      .onDuplicateKeyUpdate({
        set: {
          action: args.action,
          reason: args.reason,
          note: args.note ?? null,
          decidedBy: actor.userId,
          autoApplied: false,
          decidedAt: new Date(),
        },
      });
    await invalidateFirstSign(tx, args.sessionId, s.firstSignBy);
    return { ok: true as const };
  });
}

/** التوقيع الأول (الاعتماد المزدوج): يُسجَّل فقط حين توجد فروقات ستُسوّى فوق dualThreshold. */
export async function firstSignStocktake(
  sessionId: number,
  actor: StkActor
): Promise<{ ok: true; firstSignByName: string; firstSignAt: Date }> {
  return withTx(async (tx) => {
    const s = await lockSession(tx, sessionId);
    if (s.status !== "REVIEW") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "التوقيع الأول متاح على جلسة قيد المراجعة فقط" });
    }
    const me = (await tx.select({ name: users.name }).from(users).where(eq(users.id, actor.userId)).limit(1))[0];
    const myName = me?.name ?? `#${actor.userId}`;
    if (s.firstSignBy != null) {
      if (Number(s.firstSignBy) === actor.userId) {
        return { ok: true as const, firstSignByName: myName, firstSignAt: s.firstSignAt ?? new Date() }; // idempotent
      }
      throw new TRPCError({ code: "CONFLICT", message: "وُقّع توقيع أول مسبقاً من مستخدم آخر" });
    }
    // أعد الحساب داخل المعاملة: التوقيع الأول لا معنى له بلا فرق سيُسوّى فوق حد التوقيعين.
    const { rows, directUnderThreshold } = await loadReviewCore(tx, sessionId, true);
    const needed = rows.some((r) => r.requiresDualSign && willAdjust(r, directUnderThreshold));
    if (!needed) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا فروقات تتجاوز حدّ التوقيعين — الاعتماد المباشر يكفي" });
    }
    const at = new Date();
    await tx.update(stocktakeSessions).set({ firstSignBy: actor.userId, firstSignAt: at }).where(eq(stocktakeSessions.id, sessionId));
    return { ok: true as const, firstSignByName: myName, firstSignAt: at };
  });
}
