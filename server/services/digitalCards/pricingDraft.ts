/** أسعار بداية اليوم (ش٤) — دورة حياة المسودّة: الكشف، المعاينة، الإنشاء/النسخ، الحفظ، الإلغاء. */
import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import {
  digitalCurrentPrices,
  digitalPriceBatches,
  digitalPriceVersions,
} from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { money } from "../money";
import type { Actor } from "../tx";
import {
  activeOfferings,
  assertScopeExists,
  auditLog,
  lockBatch,
  lockPublishedScope,
  priceFor,
  type DraftLineInput,
  type OfferingRules,
  type PriceDraftScope,
  type SheetScope,
} from "./pricingShared";
import {
  BIG_CHANGE_THRESHOLD_PERCENT,
  approvalFingerprint,
  approvalSnapshotFor,
  currentPricesFor,
  detectBigChanges,
  type BigChangeLine,
} from "./pricingBigChange";

/* ────────── كشف الصباح ────────── */

export async function getMorningSheet(db: DB, scope: SheetScope) {
  await assertScopeExists(db, scope.branchId, scope.providerId);
  const offerings = await activeOfferings(db, scope.branchId, scope.providerId);

  const [draftBatch] = await db
    .select()
    .from(digitalPriceBatches)
    .where(
      and(
        eq(digitalPriceBatches.branchId, scope.branchId),
        eq(digitalPriceBatches.providerId, scope.providerId),
        eq(digitalPriceBatches.businessDate, scope.businessDate),
        eq(digitalPriceBatches.status, "DRAFT"),
      ),
    )
    .limit(1);

  const offeringIds = offerings.map((o) => o.offeringId);

  const draftLines = draftBatch && offeringIds.length
    ? await db
        .select({
          offeringId: digitalPriceVersions.offeringId,
          providerShare: digitalPriceVersions.providerShare,
          sellPrice: digitalPriceVersions.sellPrice,
          marginAmount: digitalPriceVersions.marginAmount,
        })
        .from(digitalPriceVersions)
        .where(eq(digitalPriceVersions.batchId, draftBatch.id))
    : [];
  const draftByOffering = new Map(draftLines.map((l) => [Number(l.offeringId), l]));

  // السعر النافذ حالياً (المؤشّر) — مرجع «هل تغيّر شيء؟» ومصدر النسخ.
  const current = offeringIds.length
    ? await db
        .select({
          offeringId: digitalCurrentPrices.offeringId,
          priceVersionId: digitalCurrentPrices.priceVersionId,
          providerShare: digitalPriceVersions.providerShare,
          sellPrice: digitalPriceVersions.sellPrice,
          marginAmount: digitalPriceVersions.marginAmount,
          validFrom: digitalPriceVersions.validFrom,
        })
        .from(digitalCurrentPrices)
        .innerJoin(digitalPriceVersions, eq(digitalCurrentPrices.priceVersionId, digitalPriceVersions.id))
        .where(
          and(
            eq(digitalCurrentPrices.branchId, scope.branchId),
            inArray(digitalCurrentPrices.offeringId, offeringIds),
          ),
        )
    : [];
  const currentByOffering = new Map(current.map((c) => [Number(c.offeringId), c]));

  const rows = offerings.map((o) => {
    const draft = draftByOffering.get(o.offeringId) ?? null;
    const live = currentByOffering.get(o.offeringId) ?? null;
    return {
      offeringId: o.offeringId,
      name: o.name,
      pricingMode: o.pricingMode,
      minimumMargin: o.minimumMargin,
      roundingStep: o.roundingStep,
      fixedMargin: o.fixedMargin,
      marginPercent: o.marginPercent,
      currentPriceVersionId: live ? Number(live.priceVersionId) : null,
      currentProviderShare: live?.providerShare ?? null,
      currentSellPrice: live?.sellPrice ?? null,
      draftProviderShare: draft?.providerShare ?? null,
      draftSellPrice: draft?.sellPrice ?? null,
      draftMarginAmount: draft?.marginAmount ?? null,
      // NEEDS_INPUT: لا مسودّة لهذا الصف بعد ⇒ لا يمكن النشر قبل ملئه.
      status: draft ? "DRAFTED" : live ? "CARRIED_OVER" : "NEEDS_INPUT",
    };
  });

  // §٧.١: التغييرات الكبيرة في المسودّة الحالية + حالة اعتمادها — تُحسب هنا كي يرى المدير
  // البوّابة **قبل** أن يصطدم بها عند النشر، ويعرف مَن اعتمد إن اعتُمدت.
  const bigChanges = draftBatch
      ? detectBigChanges(
          offerings,
          new Map(current.map((c) => [Number(c.offeringId), c.providerShare])),
          new Map(draftLines.map((l) => [Number(l.offeringId), l.providerShare])),
          new Map(current.map((c) => [Number(c.offeringId), c.sellPrice])),
          new Map(draftLines.map((l) => [Number(l.offeringId), l.sellPrice])),
        )
    : [];

  return {
    batch: draftBatch
      ? {
          id: draftBatch.id,
          status: draftBatch.status,
          businessDate: draftBatch.businessDate,
          changeReason: draftBatch.changeReason,
          createdBy: Number(draftBatch.createdBy),
          bigChangeApprovedBy: draftBatch.bigChangeApprovedBy != null ? Number(draftBatch.bigChangeApprovedBy) : null,
        }
      : null,
    rows,
    missingCount: rows.filter((r) => r.status === "NEEDS_INPUT").length,
    bigChanges,
    bigChangeThresholdPercent: BIG_CHANGE_THRESHOLD_PERCENT,
  };
}

/* ────────── معاينة السعر (بلا كتابة) ────────── */

/**
 * يحسب سعر البيع والهامش لمجموعة حصص **على الخادم** — كي لا تُعيد الواجهة بناء معادلة
 * التقريب بنفسها (§٧.٣: «التقريب بدالة خادمية مشتركة ومختبرة، لا بمعادلة مستقلة في React»).
 * لا يفرض الحدّ الأدنى بل يُعلّم مخالفته كي يراها المدير قبل النشر.
 */
export async function previewPrices(
  db: DB,
  input: { branchId: number; providerId: number; lines: DraftLineInput[] },
) {
  const offerings = await activeOfferings(db, input.branchId, input.providerId);
  const rulesById = new Map(offerings.map((o) => [o.offeringId, o]));

  return input.lines.map((line) => {
    const rules = rulesById.get(line.offeringId);
    if (!rules) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `العرض ${line.offeringId} ليس ضمن بطاقات هذا المزوّد الفعّالة في هذا الفرع`,
      });
    }
    const priced = priceFor(rules, line.providerShare, line.sellPrice, false);
    return {
      offeringId: line.offeringId,
      providerShare: priced.providerShare,
      sellPrice: priced.sellPrice,
      marginAmount: priced.marginAmount,
      belowCost: money(priced.marginAmount).lt(0),
      belowMinimum: money(priced.marginAmount).lt(money(rules.minimumMargin)),
      minimumMargin: rules.minimumMargin,
    };
  });
}

/* ────────── إنشاء/إحضار المسودّة ────────── */

/** يعيد مسودّة اليوم إن وُجدت، وإلا ينشئها. القيد الفريد يحسم أي سباق. */
export async function createOrGetDraft(
  tx: Tx,
  scope: PriceDraftScope,
  actor: Actor,
): Promise<{ batchId: number; created: boolean }> {
  await assertScopeExists(tx, scope.branchId, scope.providerId);

  const [existing] = await tx
    .select({ id: digitalPriceBatches.id })
    .from(digitalPriceBatches)
    .where(
      and(
        eq(digitalPriceBatches.branchId, scope.branchId),
        eq(digitalPriceBatches.providerId, scope.providerId),
        eq(digitalPriceBatches.businessDate, scope.businessDate),
        eq(digitalPriceBatches.status, "DRAFT"),
      ),
    )
    .limit(1);
  if (existing) {
    if (scope.changeReason !== undefined) {
      await tx
        .update(digitalPriceBatches)
        .set({ changeReason: scope.changeReason?.trim() || null })
        .where(eq(digitalPriceBatches.id, existing.id));
    }
    return { batchId: Number(existing.id), created: false };
  }

  let res;
  try {
    res = await tx.insert(digitalPriceBatches).values({
      branchId: scope.branchId,
      providerId: scope.providerId,
      businessDate: scope.businessDate,
      changeReason: scope.changeReason?.trim() || null,
      status: "DRAFT",
      createdBy: actor.userId,
    });
  } catch (error) {
    // القيد الفريد يحسم سباق SELECT→INSERT. locking read يرى الفائز حتى تحت REPEATABLE READ.
    const [winner] = await tx
      .select({ id: digitalPriceBatches.id })
      .from(digitalPriceBatches)
      .where(
        and(
          eq(digitalPriceBatches.branchId, scope.branchId),
          eq(digitalPriceBatches.providerId, scope.providerId),
          eq(digitalPriceBatches.businessDate, scope.businessDate),
          eq(digitalPriceBatches.status, "DRAFT"),
        ),
      )
      .for("update");
    if (!winner) throw error;
    if (scope.changeReason !== undefined) {
      await tx
        .update(digitalPriceBatches)
        .set({ changeReason: scope.changeReason?.trim() || null })
        .where(eq(digitalPriceBatches.id, winner.id));
    }
    return { batchId: Number(winner.id), created: false };
  }
  const batchId = extractInsertId(res);
  await auditLog(tx, actor, "digitalCards.pricing.draftCreated", batchId, { ...scope });
  return { batchId, created: true };
}

/* ────────── نسخ آخر أسعار منشورة ────────── */

export async function copyPrevious(
  tx: Tx,
  scope: PriceDraftScope,
  actor: Actor,
): Promise<{ batchId: number; copiedCount: number; skippedCount: number }> {
  const { batchId } = await createOrGetDraft(tx, scope, actor);
  await lockBatch(tx, batchId);

  const offerings = await activeOfferings(tx, scope.branchId, scope.providerId);
  if (!offerings.length) return { batchId, copiedCount: 0, skippedCount: 0 };

  const live = await tx
    .select({
      offeringId: digitalCurrentPrices.offeringId,
      providerShare: digitalPriceVersions.providerShare,
      sellPrice: digitalPriceVersions.sellPrice,
    })
    .from(digitalCurrentPrices)
    .innerJoin(digitalPriceVersions, eq(digitalCurrentPrices.priceVersionId, digitalPriceVersions.id))
    .where(
      and(
        eq(digitalCurrentPrices.branchId, scope.branchId),
        inArray(digitalCurrentPrices.offeringId, offerings.map((o) => o.offeringId)),
      ),
    );
  const priceByOffering = new Map(live.map((l) => [Number(l.offeringId), l]));

  const lines: DraftLineInput[] = [];
  for (const o of offerings) {
    const current = priceByOffering.get(o.offeringId);
    if (current != null) {
      lines.push({ offeringId: o.offeringId, providerShare: current.providerShare, sellPrice: current.sellPrice });
    }
  }

  // النسخ لا يفرض الحدّ الأدنى: قد تكون قاعدة الربح تغيّرت بعد آخر نشر، فالمدير يراجع قبل النشر.
  await writeDraftLines(tx, batchId, scope, lines, offerings, actor, false);

  await auditLog(tx, actor, "digitalCards.pricing.copiedPrevious", batchId, {
    copied: lines.length,
    skipped: offerings.length - lines.length,
  });
  return { batchId, copiedCount: lines.length, skippedCount: offerings.length - lines.length };
}

/* ────────── حفظ المسودّة ────────── */

async function writeDraftLines(
  tx: Tx,
  batchId: number,
  scope: SheetScope,
  lines: DraftLineInput[],
  offerings: OfferingRules[],
  actor: Actor,
  enforceMinimum: boolean,
): Promise<number> {
  const rulesById = new Map(offerings.map((o) => [o.offeringId, o]));
  const now = new Date();

  const ids = new Set<number>();
  for (const line of lines) {
    if (ids.has(line.offeringId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `البطاقة ${line.offeringId} مكررة في الأسعار` });
    }
    ids.add(line.offeringId);
  }

  // §٧.١: يُبطَل اعتماد «التغيير الكبير» عند تغيّر الحصص **فعلاً** — لا عند كل كتابة.
  //
  // وُضع هنا (المسار الوحيد الذي يعدّل السطور) لا في `saveDraft` وحده، وإلا التفّ عليه
  // `copyPrevious`: يُعتمَد سعرٌ ثمّ تُستبدَل السطور ويُنشَر غيرُ المعتمَد.
  //
  // وشُرِط بالتغيّر الفعليّ لأن نقطة النهاية `pricing.publish` تحفظ ثمّ تنشر في المعاملة
  // نفسها؛ فمسحٌ غير مشروط كان يُبطل الاعتماد لحظةَ استعماله ⇒ نشرٌ مستحيل (أمسكته الجولة
  // البصرية). إعادةُ حفظٍ مطابقة ليست تعديلاً. المقارنة بـdecimal لا بالنصّ ("20000" = "20000.00").
  const existing = await tx
    .select({
      offeringId: digitalPriceVersions.offeringId,
      providerShare: digitalPriceVersions.providerShare,
      sellPrice: digitalPriceVersions.sellPrice,
    })
    .from(digitalPriceVersions)
    .where(eq(digitalPriceVersions.batchId, batchId));
  const existingByOffering = new Map(existing.map((e) => [Number(e.offeringId), e]));

  // احسب القيمة الفعلية أولاً كي تلتقط المقارنة تغيّر السعر المشتق أيضاً. إعادة الحفظ
  // المطابقة لا تعد تحريراً ولا تغيّر createdBy، وإلا انكسر فصل المهام عند النشر.
  const ordered = [...lines].sort((a, b) => a.offeringId - b.offeringId);
  const prepared = ordered.map((line) => {
    const rules = rulesById.get(line.offeringId);
    if (!rules) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `العرض ${line.offeringId} ليس ضمن بطاقات هذا المزوّد الفعّالة في هذا الفرع`,
      });
    }
    return { line, priced: priceFor(rules, line.providerShare, line.sellPrice, enforceMinimum) };
  });
  const changedByOffering = new Map(
    prepared.map(({ line, priced }) => {
      const prev = existingByOffering.get(line.offeringId);
      return [
        line.offeringId,
        prev == null ||
          !money(prev.providerShare).eq(money(priced.providerShare)) ||
          !money(prev.sellPrice).eq(money(priced.sellPrice)),
      ] as const;
    }),
  );
  const pricesChanged = lines.length !== existing.length || Array.from(changedByOffering.values()).some(Boolean);
  if (pricesChanged) {
    await tx
      .update(digitalPriceBatches)
      .set({ bigChangeApprovedBy: null, bigChangeApprovedAt: null })
      .where(eq(digitalPriceBatches.id, batchId));
  }

  for (const { line, priced } of prepared) {
    if (!changedByOffering.get(line.offeringId)) continue;

    // upsert على القيد الفريد (batchId, offeringId) — إعادة الإدخال تُحدِّث ولا تُكرّر.
    await tx
      .insert(digitalPriceVersions)
      .values({
        batchId,
        branchId: scope.branchId,
        offeringId: line.offeringId,
        providerShare: priced.providerShare,
        sellPrice: priced.sellPrice,
        marginAmount: priced.marginAmount,
        validFrom: now,
        createdBy: actor.userId,
      })
      .onDuplicateKeyUpdate({
        set: {
          providerShare: priced.providerShare,
          sellPrice: priced.sellPrice,
          marginAmount: priced.marginAmount,
          createdBy: actor.userId,
        },
      });
  }
  return ordered.length;
}

/**
 * اعتماد «التغيير الكبير» (§٧.١) — مديرٌ **آخر** يُجيز نشر دُفعةٍ فيها بطاقة تغيّرت حصتها ≥٥٠٪.
 *
 * لا يَنشر بذاته: يضع السِمة فقط، والنشر يبقى فعلاً منفصلاً. ويُعيد قائمة ما اعتُمد كي
 * يوقّع المعتمِد على أرقامٍ رآها، لا على «تغييرٍ كبير» مجهول.
 */
export async function approveBigChange(
  tx: Tx,
  input: { batchId: number },
  actor: Actor,
): Promise<{ batchId: number; approved: BigChangeLine[] }> {
  const batch = await lockBatch(tx, input.batchId);
  if (batch.status !== "DRAFT") {
    throw new TRPCError({ code: "CONFLICT", message: "الاعتماد يخصّ مسودّةً فقط" });
  }
  if (Number(batch.createdBy) === actor.userId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "لا تعتمد تغييراً كبيراً في مسودّةٍ أنشأتَها — يلزم مديرٌ آخر",
    });
  }

  const branchId = Number(batch.branchId);
  const providerId = Number(batch.providerId);
  await lockPublishedScope(tx, branchId, providerId);
  const offerings = await activeOfferings(tx, branchId, providerId);
  const draftLines = await tx
    .select({
      offeringId: digitalPriceVersions.offeringId,
      providerShare: digitalPriceVersions.providerShare,
      sellPrice: digitalPriceVersions.sellPrice,
      createdBy: digitalPriceVersions.createdBy,
    })
    .from(digitalPriceVersions)
    .where(eq(digitalPriceVersions.batchId, input.batchId));

  const offeringIds = offerings.map((o) => o.offeringId);
  const currentPrices = await currentPricesFor(tx, branchId, offeringIds);
  const currentByOffering = new Map(currentPrices.map((r) => [r.offeringId, r]));
  const bigChanges = detectBigChanges(
    offerings,
    new Map(currentPrices.map((r) => [r.offeringId, r.providerShare])),
    new Map(draftLines.map((l) => [Number(l.offeringId), l.providerShare])),
    new Map(currentPrices.map((r) => [r.offeringId, r.sellPrice])),
    new Map(draftLines.map((l) => [Number(l.offeringId), l.sellPrice])),
  );
  if (bigChanges.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "لا تغييرات كبيرة في هذه المسودّة — انشرها مباشرةً بلا اعتمادٍ ثانٍ",
    });
  }

  const draftByOffering = new Map(draftLines.map((line) => [Number(line.offeringId), line]));
  const selfEdited = bigChanges.find((line) => Number(draftByOffering.get(line.offeringId)?.createdBy) === actor.userId);
  if (selfEdited) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `لا تعتمد تغييراً كبيراً حرّرتَه بنفسك — «${selfEdited.name}» يحتاج مديراً آخر`,
    });
  }

  const snapshot = approvalSnapshotFor(
    input.batchId,
    offeringIds,
    currentByOffering,
    draftLines
      .filter((line) => offeringIds.includes(Number(line.offeringId)))
      .map((line) => ({
        offeringId: Number(line.offeringId),
        providerShare: line.providerShare,
        sellPrice: line.sellPrice,
        editedBy: Number(line.createdBy),
      })),
  );
  const fingerprint = approvalFingerprint(snapshot);

  await tx
    .update(digitalPriceBatches)
    .set({ bigChangeApprovedBy: actor.userId, bigChangeApprovedAt: new Date() })
    .where(eq(digitalPriceBatches.id, input.batchId));

  await auditLog(tx, actor, "digitalCards.pricing.bigChangeApproved", input.batchId, {
    branchId, providerId, requestedBy: batch.createdBy,
    thresholdPercent: BIG_CHANGE_THRESHOLD_PERCENT,
    approvalSnapshotVersion: snapshot.version,
    approvalFingerprint: fingerprint,
    lineCount: bigChanges.length,
    lines: bigChanges.slice(0, 20),
  });

  return { batchId: input.batchId, approved: bigChanges };
}

export async function saveDraft(
  tx: Tx,
  input: { batchId: number; lines: DraftLineInput[] },
  actor: Actor,
): Promise<{ batchId: number; savedCount: number }> {
  const batch = await lockBatch(tx, input.batchId);
  if (batch.status !== "DRAFT") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "لا تُعدَّل دُفعة منشورة — أنشئ دُفعة جديدة بدلاً من ذلك",
    });
  }

  const scope: SheetScope = {
    branchId: Number(batch.branchId),
    providerId: Number(batch.providerId),
    businessDate: String(batch.businessDate),
  };
  const offerings = await activeOfferings(tx, scope.branchId, scope.providerId);

  // الحفظ لا يفرض الحدّ الأدنى (المدير يُدخل تدريجياً) — النشر هو البوّابة الصارمة.
  const savedCount = await writeDraftLines(tx, input.batchId, scope, input.lines, offerings, actor, false);
  await auditLog(tx, actor, "digitalCards.pricing.draftSaved", input.batchId, { lines: savedCount });
  return { batchId: input.batchId, savedCount };
}

/* ────────── إلغاء مسودّة ────────── */

export async function cancelDraft(tx: Tx, input: { batchId: number }, actor: Actor): Promise<void> {
  const batch = await lockBatch(tx, input.batchId);
  if (batch.status !== "DRAFT") {
    throw new TRPCError({ code: "CONFLICT", message: "لا تُلغى إلا المسودّة" });
  }
  await tx.delete(digitalPriceVersions).where(eq(digitalPriceVersions.batchId, input.batchId));
  await tx
    .update(digitalPriceBatches)
    .set({ status: "CANCELLED" })
    .where(eq(digitalPriceBatches.id, input.batchId));
  await auditLog(tx, actor, "digitalCards.pricing.draftCancelled", input.batchId, {});
}
