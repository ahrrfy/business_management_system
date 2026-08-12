// معاملات المراجعة قبل الاعتماد: طلب إعادة العدّ، فصل التعارض، القرار الصريح، والتوقيع الأول.
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  stocktakeAssignments,
  stocktakeCounts,
  stocktakeDecisions,
  stocktakeItemReviewEvents,
  stocktakeItems,
  stocktakeSessions,
  users,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { withTx } from "../tx";
import type { StkActor } from "./types";
import { assertBranchAccess, lockSession } from "./internal";
import { loadReviewCore, willAdjust } from "./reviewCore";
import {
  assertNoCountInputAnomalies,
  findCountInputAnomalies,
} from "./countIntegrity";
import {
  assertOpeningValuationSafe,
  buildOpeningValuationIntegrity,
} from "./valuationIntegrity";

async function getSessionItem(tx: Tx, sessionId: number, variantId: number) {
  const rows = await tx
    .select()
    .from(stocktakeItems)
    .where(
      and(
        eq(stocktakeItems.sessionId, sessionId),
        eq(stocktakeItems.variantId, variantId),
      ),
    )
    .limit(1);
  const item = rows[0];
  if (!item)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "الصنف ليس ضمن أصناف هذه الجلسة",
    });
  return item;
}

async function recordReviewReopen(
  tx: Tx,
  item: Awaited<ReturnType<typeof getSessionItem>>,
  actor: StkActor,
  reason: string,
): Promise<void> {
  if (item.reviewApprovedAt == null) return;
  await tx.insert(stocktakeItemReviewEvents).values({
    sessionId: Number(item.sessionId),
    variantId: Number(item.variantId),
    action: "REOPEN",
    snapshotOperationId:
      item.reviewApprovedOperationId == null
        ? null
        : Number(item.reviewApprovedOperationId),
    snapshotQty: item.reviewApprovedQty,
    snapshotHash: item.reviewApprovedSnapshotHash,
    reason,
    actedBy: actor.userId,
  });
}

/**
 * طلب إعادة عدّ: مهمة PENDING تحجب الاعتماد حتى يصل عدّ RECOUNT عبر البوابة.
 * البوابة تشترط جلسة COUNTING وتكليفاً ACTIVE ⇒ نعيد فتحهما عند الطلب أثناء المراجعة
 * (وعند تسليم الجميع مجدداً تعود الجلسة لـREVIEW آلياً) — هذا هو التفسير المتّسق للعقد §٥.
 */
export async function requestStocktakeRecount(
  args: { sessionId: number; variantId: number; reason: string },
  actor: StkActor,
  opts: { restrictBranchId?: number | null } = {},
): Promise<{ ok: true }> {
  return withTx(async (tx) => {
    const s = await lockSession(tx, args.sessionId);
    assertBranchAccess(Number(s.branchId), opts.restrictBranchId);
    if (s.status !== "COUNTING" && s.status !== "REVIEW") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يمكن طلب إعادة عدّ على جلسة معتمدة أو ملغاة",
      });
    }
    const item = await getSessionItem(tx, args.sessionId, args.variantId);
    const hasCount = (
      await tx
        .select({ id: stocktakeCounts.id })
        .from(stocktakeCounts)
        .where(
          and(
            eq(stocktakeCounts.sessionId, args.sessionId),
            eq(stocktakeCounts.variantId, args.variantId),
          ),
        )
        .limit(1)
    )[0];
    if (!hasCount)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا عدّ مسجّلاً لهذا الصنف بعد — لا حاجة لإعادة العدّ",
      });

    const now = new Date();
    await recordReviewReopen(tx, item, actor, args.reason);
    await tx
      .update(stocktakeItems)
      .set({
        recountStatus: "PENDING",
        recountReason: args.reason,
        recountRequestedBy: actor.userId,
        recountRequestedAt: now,
        // إعادة العدّ تغيّر أساس المراجعة؛ أي اعتماد مرحلي سابق يسقط حكماً.
        reviewApprovedBy: null,
        reviewApprovedAt: null,
        reviewApprovedOperationId: null,
        reviewApprovedQty: null,
        reviewApprovedSnapshotHash: null,
        ...(item.reviewApprovedAt != null
          ? {
              reviewReopenedBy: actor.userId,
              reviewReopenedAt: now,
              reviewReopenReason: args.reason,
            }
          : {}),
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
          sql`${stocktakeCounts.resolvedPick} IS NULL`,
        ),
      );

    // قرار سابق على الصنف يسقط — سيُعاد بناؤه بعد العدّ الجديد.
    await tx
      .delete(stocktakeDecisions)
      .where(
        and(
          eq(stocktakeDecisions.sessionId, args.sessionId),
          eq(stocktakeDecisions.variantId, args.variantId),
        ),
      );

    // إعادة فتح تكليف الصنف والجلسة كي تقبل البوابة العدّ الجديد.
    await tx
      .update(stocktakeAssignments)
      .set({ status: "ACTIVE", submittedAt: null })
      .where(
        and(
          eq(stocktakeAssignments.sessionId, args.sessionId),
          eq(stocktakeAssignments.status, "SUBMITTED"),
        ),
      );
    if (s.status === "REVIEW") {
      await tx
        .update(stocktakeSessions)
        // التوقيع الأول يُبطَل أيضاً: البيانات ستتغير بعد إعادة العدّ فلا يصح اعتماد نهائي على توقيع قديم.
        .set({
          status: "COUNTING",
          submittedAt: null,
          firstSignBy: null,
          firstSignAt: null,
        })
        .where(eq(stocktakeSessions.id, args.sessionId));
    }
    return { ok: true as const };
  });
}

/** إبطال التوقيع الأول عند أي تغيير لاحق في بيانات المراجعة (قرار/فصل تعارض) — لا اعتماد على توقيع لبيانات قديمة. */
async function invalidateFirstSign(
  tx: Tx,
  sessionId: number,
  firstSignBy: unknown,
): Promise<void> {
  if (firstSignBy == null) return;
  await tx
    .update(stocktakeSessions)
    .set({ firstSignBy: null, firstSignAt: null })
    .where(eq(stocktakeSessions.id, sessionId));
}

/** الفصل في تعارض عدَّين: اعتماد أحدهما (يبقى كلاهما موثَّقاً في السجل). */
export async function resolveStocktakeConflict(
  args: { sessionId: number; variantId: number; pick: "FIRST" | "VERIFY" },
  actor: StkActor,
): Promise<{ ok: true }> {
  return withTx(async (tx) => {
    const s = await lockSession(tx, args.sessionId);
    if (s.status !== "COUNTING" && s.status !== "REVIEW") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يمكن الفصل في تعارض على جلسة معتمدة أو ملغاة",
      });
    }
    const item = await getSessionItem(tx, args.sessionId, args.variantId);
    if (item.reviewApprovedAt != null) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "هذا المنتج معتمد مرحلياً — ألغِ الاعتماد بسبب موثّق قبل تعديل نتيجة التعارض",
      });
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
            sql`${stocktakeCounts.resolvedPick} IS NULL`,
          ),
        )
        .orderBy(desc(stocktakeCounts.id))
        .limit(1)
    )[0];
    if (!open)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا تعارض مفتوحاً على هذا الصنف",
      });
    await tx
      .update(stocktakeCounts)
      .set({
        resolvedPick: args.pick,
        resolvedBy: actor.userId,
        resolvedAt: new Date(),
      })
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
    reason:
      | "UNSPECIFIED"
      | "DAMAGE"
      | "LOSS_THEFT"
      | "ENTRY_ERROR"
      | "PRINT_WASTE";
    note?: string;
  },
  actor: StkActor,
): Promise<{ ok: true }> {
  return withTx(async (tx) => {
    const s = await lockSession(tx, args.sessionId);
    if (s.status !== "COUNTING" && s.status !== "REVIEW") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "القرارات متاحة أثناء العدّ والمراجعة فقط",
      });
    }
    const item = await getSessionItem(tx, args.sessionId, args.variantId);
    if (item.reviewApprovedAt != null) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "هذا المنتج معتمد مرحلياً — ألغِ الاعتماد بسبب موثّق قبل تغيير القرار",
      });
    }
    if (item.recountStatus === "PENDING") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "الصنف بانتظار إعادة العدّ — لا قرار قبل وصول العدّ الجديد",
      });
    }
    const hasCount = (
      await tx
        .select({ id: stocktakeCounts.id })
        .from(stocktakeCounts)
        .where(
          and(
            eq(stocktakeCounts.sessionId, args.sessionId),
            eq(stocktakeCounts.variantId, args.variantId),
          ),
        )
        .limit(1)
    )[0];
    if (!hasCount)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا عدّ مسجّلاً لهذا الصنف — لا يمكن اتخاذ قرار",
      });
    const openConflict = (
      await tx
        .select({ id: stocktakeCounts.id })
        .from(stocktakeCounts)
        .where(
          and(
            eq(stocktakeCounts.sessionId, args.sessionId),
            eq(stocktakeCounts.variantId, args.variantId),
            eq(stocktakeCounts.isConflict, true),
            sql`${stocktakeCounts.resolvedPick} IS NULL`,
          ),
        )
        .limit(1)
    )[0];
    if (openConflict)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "افصل في تعارض العدَّين أولاً قبل القرار",
      });

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

/**
 * اعتماد إداري مرحلي لأصناف معدودة بينما بقية الجلسة مستمرة.
 * لا يكتب حركة مخزون أو قيداً محاسبياً؛ التنفيذ يبقى ذرّياً في approveStocktake النهائي.
 * يمنع اعتماد صف غير معدود/متعارض/بانتظار إعادة عدّ/بلا قرار إلزامي.
 */
export async function approveStocktakeItems(
  args: { sessionId: number; variantIds: number[] },
  actor: StkActor,
): Promise<{
  ok: true;
  approvedCount: number;
  refreshedCount: number;
  alreadyApprovedCount: number;
}> {
  return withTx(async (tx) => {
    const s = await lockSession(tx, args.sessionId);
    if (s.status !== "COUNTING" && s.status !== "REVIEW") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "الاعتماد المرحلي متاح أثناء العدّ والمراجعة فقط",
      });
    }
    const variantIds = Array.from(new Set(args.variantIds.map(Number)));
    if (!variantIds.length) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "اختر منتجاً واحداً على الأقل للاعتماد",
      });
    }

    // تحميل الحساب داخل المعاملة نفسها؛ القرارات والعدّات والحركات يعاد تقييمها خادمياً.
    const { rows, directUnderThreshold } = await loadReviewCore(
      tx,
      args.sessionId,
      true,
    );
    const selectedCountAnomalies = (
      await findCountInputAnomalies(tx, rows)
    ).filter((row) => variantIds.includes(row.variantId));
    assertNoCountInputAnomalies(selectedCountAnomalies);
    const valuationIntegrity = await buildOpeningValuationIntegrity(
      tx,
      s,
      rows,
    );
    const selectedBlocking = valuationIntegrity.rows.filter(
      (row) => row.blocking && variantIds.includes(row.variantId),
    );
    if (selectedBlocking.length) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `حُجب اعتماد ${selectedBlocking.length} منتج بسبب تضخم تكلفة/وحدة مادّي — حدّث أساس التقييم أولاً`,
      });
    }
    const byId = new Map(rows.map((r) => [r.variantId, r]));
    const missing = variantIds.filter((id) => !byId.has(id));
    if (missing.length) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "بعض المنتجات المختارة ليست ضمن جلسة الجرد",
      });
    }

    const invalid = variantIds
      .map((id) => byId.get(id)!)
      .filter((r) => {
        if (r.reviewApproved?.isCurrent) return false;
        if (
          r.rawCount == null ||
          r.recount?.status === "PENDING" ||
          r.openConflict
        )
          return true;
        if (r.diff == null || r.diff === 0 || r.decision) return false;
        return r.overThreshold || !directUnderThreshold;
      });
    if (invalid.length) {
      const sample = invalid
        .slice(0, 3)
        .map((r) =>
          r.variantName ? `${r.productName} — ${r.variantName}` : r.productName,
        )
        .join("، ");
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `تعذّر اعتماد ${invalid.length} منتج قبل إكمال المراجعة أو حسم التعارض${sample ? `: ${sample}` : ""}`,
      });
    }

    const alreadyApprovedCount = variantIds.filter(
      (id) => byId.get(id)?.reviewApproved?.isCurrent,
    ).length;
    const toApprove = variantIds
      .map((id) => byId.get(id)!)
      .filter((r) => !r.reviewApproved?.isCurrent);
    const refreshedCount = toApprove.filter(
      (r) => r.reviewApproved != null,
    ).length;
    if (toApprove.length) {
      const now = new Date();
      for (const r of toApprove) {
        if (r.rawCount == null || r.reviewSnapshotHash == null) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "تعذّر تثبيت نسخة المراجعة لهذا المنتج",
          });
        }
        await tx
          .update(stocktakeItems)
          .set({
            reviewApprovedBy: actor.userId,
            reviewApprovedAt: now,
            reviewApprovedOperationId: r.latestCountOperationId,
            reviewApprovedQty: r.rawCount,
            reviewApprovedSnapshotHash: r.reviewSnapshotHash,
          })
          .where(
            and(
              eq(stocktakeItems.sessionId, args.sessionId),
              eq(stocktakeItems.variantId, r.variantId),
            ),
          );
        await tx.insert(stocktakeItemReviewEvents).values({
          sessionId: args.sessionId,
          variantId: r.variantId,
          action: "APPROVE",
          snapshotOperationId: r.latestCountOperationId,
          snapshotQty: r.rawCount,
          snapshotHash: r.reviewSnapshotHash,
          actedBy: actor.userId,
        });
      }
    }
    return {
      ok: true as const,
      approvedCount: toApprove.length,
      refreshedCount,
      alreadyApprovedCount,
    };
  });
}

/** إلغاء اعتماد مرحلي صراحةً مع سبب، من دون إنشاء طلب إعادة عدّ تلقائياً. */
export async function reopenStocktakeItemReview(
  args: { sessionId: number; variantId: number; reason: string },
  actor: StkActor,
): Promise<{ ok: true }> {
  return withTx(async (tx) => {
    const s = await lockSession(tx, args.sessionId);
    if (s.status !== "COUNTING" && s.status !== "REVIEW") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يمكن إعادة فتح منتج في جلسة معتمدة أو ملغاة",
      });
    }
    const item = await getSessionItem(tx, args.sessionId, args.variantId);
    if (item.reviewApprovedAt == null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "المنتج غير معتمد مرحلياً",
      });
    }
    const now = new Date();
    await recordReviewReopen(tx, item, actor, args.reason);
    await tx
      .update(stocktakeItems)
      .set({
        reviewApprovedBy: null,
        reviewApprovedAt: null,
        reviewApprovedOperationId: null,
        reviewApprovedQty: null,
        reviewApprovedSnapshotHash: null,
        reviewReopenedBy: actor.userId,
        reviewReopenedAt: now,
        reviewReopenReason: args.reason,
      })
      .where(eq(stocktakeItems.id, Number(item.id)));
    await invalidateFirstSign(tx, args.sessionId, s.firstSignBy);
    return { ok: true as const };
  });
}

/** التوقيع الأول (الاعتماد المزدوج): يُسجَّل فقط حين توجد فروقات ستُسوّى فوق dualThreshold. */
export async function firstSignStocktake(
  sessionId: number,
  actor: StkActor,
): Promise<{ ok: true; firstSignByName: string; firstSignAt: Date }> {
  return withTx(async (tx) => {
    const s = await lockSession(tx, sessionId);
    if (s.status !== "REVIEW") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "التوقيع الأول متاح على جلسة قيد المراجعة فقط",
      });
    }
    // Revalidate before the idempotent-return path. A legacy/imported count or
    // corrected catalog cost must never hide behind an earlier signature.
    const { rows, directUnderThreshold } = await loadReviewCore(
      tx,
      sessionId,
      true,
    );
    assertNoCountInputAnomalies(await findCountInputAnomalies(tx, rows));
    assertOpeningValuationSafe(
      await buildOpeningValuationIntegrity(tx, s, rows),
    );
    const me = (
      await tx
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, actor.userId))
        .limit(1)
    )[0];
    const myName = me?.name ?? `#${actor.userId}`;
    if (s.firstSignBy != null) {
      if (Number(s.firstSignBy) === actor.userId) {
        return {
          ok: true as const,
          firstSignByName: myName,
          firstSignAt: s.firstSignAt ?? new Date(),
        }; // idempotent
      }
      throw new TRPCError({
        code: "CONFLICT",
        message: "وُقّع توقيع أول مسبقاً من مستخدم آخر",
      });
    }
    // أعد الحساب داخل المعاملة: التوقيع الأول لا معنى له بلا فرق سيُسوّى فوق حد التوقيعين.
    // ⚠️ الجلسة الافتتاحية: التوقيعان إلزاميان دائماً ⇒ التوقيع الأول مقبول دائماً — بلا هذا الفرع
    // كانت جلسة OPENING كل قيمها تحت dualThreshold تُقفَل نهائياً (finalize يشترط توقيعاً أولاً
    // وهذا الحارس يرفض تسجيله = جمود مثبَت في المراجعة العدائية ١٨/٧).
    const incomplete = rows.filter(
      (r) => r.rawCount == null || !r.reviewApproved?.isCurrent,
    );
    if (incomplete.length) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `لا توقيع أول قبل اكتمال العدّ والاعتماد المرحلي لكل المنتجات (${incomplete.length} غير مكتمل)`,
      });
    }
    const needed =
      s.sessionType === "OPENING" ||
      rows.some(
        (r) => r.requiresDualSign && willAdjust(r, directUnderThreshold),
      );
    if (!needed) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا فروقات تتجاوز حدّ التوقيعين — الاعتماد المباشر يكفي",
      });
    }
    const at = new Date();
    await tx
      .update(stocktakeSessions)
      .set({ firstSignBy: actor.userId, firstSignAt: at })
      .where(eq(stocktakeSessions.id, sessionId));
    return { ok: true as const, firstSignByName: myName, firstSignAt: at };
  });
}
