/**
 * أسعار بداية اليوم (ش٤) — دُفعة مسودة ← نشر ذرّي ← مؤشّر سعر نافذ.
 *
 * المبادئ الحاكمة (وثيقة التصميم §٧):
 * • الخادم لا يثق بسعر من العميل إطلاقاً — يستقبل **حصة المزوّد فقط** ويشتقّ سعر البيع بنفسه
 *   عبر `pricingCalc` المشتركة والمختبرة (لا معادلة موازية في React).
 * • نسخة السعر بعد النشر **غير قابلة للتعديل** — تصحيح السعر = دُفعة جديدة تُسوّد السابقة.
 * • المسودّة تُخزَّن في `digitalPriceVersions` نفسها والدُفعة `DRAFT` (لا جدول مسودّات في المخطّط)
 *   كي ينجو إدخالُ عشرات الأسعار من إغلاق الصفحة؛ النشر يعيد الحساب ويثبّت.
 * • تفرّد الدُفعات محروسٌ **بقيد قاعدة** لا بفحص تطبيقيّ (عمودان مولَّدان + فهرسان فريدان،
 *   هجرة 0125): مسودّة واحدة لكل (فرع×مزوّد×تاريخ)، ودُفعة منشورة واحدة سارية لكل (فرع×مزوّد).
 *   الفحص التطبيقيّ وحده يترك سباق TOCTOU (نفس صنف العلّة التي ضربت توفير الشركات).
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  auditLogs,
  branches,
  digitalCurrentPrices,
  digitalOfferingBranches,
  digitalOfferings,
  digitalPriceBatches,
  digitalPriceChangeReports,
  digitalPriceVersions,
  digitalProviders,
  products,
  suppliers,
} from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { money, toDbMoney } from "../money";
import type { Actor } from "../tx";
import { redactAuditValue } from "../auditService";
import { computeSellPrice, type PricingMode } from "./pricingCalc";

/* ────────── الأنواع ────────── */

export interface SheetScope {
  branchId: number;
  providerId: number;
  businessDate: string;
}

export interface DraftLineInput {
  offeringId: number;
  /** حصة المزوّد (تكلفة الجهاز) — المدخل الوحيد؛ سعر البيع يُشتقّ خادمياً. */
  providerShare: string;
}

/* ────────── التدقيق (داخل المعاملة — ذرّيّ مع التغيير) ────────── */

async function auditLog(
  tx: Tx,
  actor: Actor,
  action: string,
  entityId: number,
  details: unknown,
): Promise<void> {
  try {
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId: actor.branchId,
      action,
      entityType: "digitalPriceBatch",
      entityId: String(entityId),
      newValue: redactAuditValue(details),
    });
  } catch {
    // best-effort: فشل التدقيق لا يُسقط عملية الأعمال
  }
}

/* ────────── مساعدات ────────── */

/** قواعد تسعير عرضٍ ما — تُقرأ من التعريف لا من العميل. */
type OfferingRules = {
  offeringId: number;
  name: string;
  pricingMode: PricingMode;
  fixedMargin: string;
  marginPercent: string;
  minimumMargin: string;
  roundingStep: string;
};

/** العروض الفعّالة لمزوّد داخل فرع (مُفعَّلة على مستوى العرض **وعلى مستوى ربط الفرع**). */
async function activeOfferings(
  runner: DB | Tx,
  branchId: number,
  providerId: number,
): Promise<OfferingRules[]> {
  const rows = await runner
    .select({
      offeringId: digitalOfferings.id,
      name: products.name,
      pricingMode: digitalOfferings.pricingMode,
      fixedMargin: digitalOfferings.fixedMargin,
      marginPercent: digitalOfferings.marginPercent,
      minimumMargin: digitalOfferings.minimumMargin,
      roundingStep: digitalOfferings.roundingStep,
    })
    .from(digitalOfferings)
    .innerJoin(products, eq(digitalOfferings.productId, products.id))
    .innerJoin(
      digitalOfferingBranches,
      eq(digitalOfferingBranches.offeringId, digitalOfferings.id),
    )
    .where(
      and(
        eq(digitalOfferings.providerId, providerId),
        eq(digitalOfferings.isActive, true),
        eq(digitalOfferingBranches.branchId, branchId),
        eq(digitalOfferingBranches.isActive, true),
      ),
    )
    .orderBy(digitalOfferings.id);
  return rows as OfferingRules[];
}

/** يحسب السعر من الحصة + قواعد العرض، ويرفض هامشاً دون الحدّ الأدنى. */
function priceFor(rules: OfferingRules, providerShare: string, enforceMinimum: boolean) {
  const share = money(providerShare);
  if (share.lt(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `حصة المزوّد لا تكون سالبة — «${rules.name}»` });
  }
  const r = computeSellPrice({
    pricingMode: rules.pricingMode,
    providerShare: toDbMoney(share),
    fixedMargin: rules.fixedMargin,
    marginPercent: rules.marginPercent,
    roundingStep: rules.roundingStep,
  });
  if (enforceMinimum && money(r.marginAmount).lt(money(rules.minimumMargin))) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `هامش «${rules.name}» (${r.marginAmount}) أقلّ من الحدّ الأدنى (${rules.minimumMargin}). ` +
        `عدّل حصة المزوّد أو قاعدة الربح قبل النشر.`,
    });
  }
  return r;
}

async function lockBatch(tx: Tx, batchId: number) {
  const [batch] = await tx
    .select()
    .from(digitalPriceBatches)
    .where(eq(digitalPriceBatches.id, batchId))
    .for("update");
  if (!batch) throw new TRPCError({ code: "NOT_FOUND", message: "دُفعة الأسعار غير موجودة" });
  return batch;
}

async function assertScopeExists(runner: DB | Tx, branchId: number, providerId: number) {
  const [branch] = await runner.select({ id: branches.id }).from(branches).where(eq(branches.id, branchId)).limit(1);
  if (!branch) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود" });
  const [provider] = await runner
    .select({ id: digitalProviders.id, isActive: digitalProviders.isActive })
    .from(digitalProviders)
    .where(eq(digitalProviders.id, providerId))
    .limit(1);
  if (!provider) throw new TRPCError({ code: "NOT_FOUND", message: "المزوّد غير موجود" });
  if (!provider.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "المزوّد معطَّل" });
}

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

  return {
    batch: draftBatch
      ? { id: draftBatch.id, status: draftBatch.status, businessDate: draftBatch.businessDate }
      : null,
    rows,
    missingCount: rows.filter((r) => r.status === "NEEDS_INPUT").length,
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
    const priced = priceFor(rules, line.providerShare, false);
    return {
      offeringId: line.offeringId,
      providerShare: priced.providerShare,
      sellPrice: priced.sellPrice,
      marginAmount: priced.marginAmount,
      belowMinimum: money(priced.marginAmount).lt(money(rules.minimumMargin)),
      minimumMargin: rules.minimumMargin,
    };
  });
}

/* ────────── إنشاء/إحضار المسودّة ────────── */

/** يعيد مسودّة اليوم إن وُجدت، وإلا ينشئها. القيد الفريد يحسم أي سباق. */
export async function createOrGetDraft(
  tx: Tx,
  scope: SheetScope,
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
  if (existing) return { batchId: Number(existing.id), created: false };

  const res = await tx.insert(digitalPriceBatches).values({
    branchId: scope.branchId,
    providerId: scope.providerId,
    businessDate: scope.businessDate,
    status: "DRAFT",
    createdBy: actor.userId,
  });
  const batchId = extractInsertId(res);
  await auditLog(tx, actor, "digitalCards.pricing.draftCreated", batchId, { ...scope });
  return { batchId, created: true };
}

/* ────────── نسخ آخر أسعار منشورة ────────── */

export async function copyPrevious(
  tx: Tx,
  scope: SheetScope,
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
    })
    .from(digitalCurrentPrices)
    .innerJoin(digitalPriceVersions, eq(digitalCurrentPrices.priceVersionId, digitalPriceVersions.id))
    .where(
      and(
        eq(digitalCurrentPrices.branchId, scope.branchId),
        inArray(digitalCurrentPrices.offeringId, offerings.map((o) => o.offeringId)),
      ),
    );
  const shareByOffering = new Map(live.map((l) => [Number(l.offeringId), l.providerShare]));

  const lines: DraftLineInput[] = [];
  for (const o of offerings) {
    const share = shareByOffering.get(o.offeringId);
    if (share != null) lines.push({ offeringId: o.offeringId, providerShare: share });
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

  // ترتيب حتميّ بـofferingId ⇒ لا deadlock عند تزامن حفظَين على الدُفعة نفسها.
  const ordered = [...lines].sort((a, b) => a.offeringId - b.offeringId);

  for (const line of ordered) {
    const rules = rulesById.get(line.offeringId);
    if (!rules) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `العرض ${line.offeringId} ليس ضمن بطاقات هذا المزوّد الفعّالة في هذا الفرع`,
      });
    }
    const priced = priceFor(rules, line.providerShare, enforceMinimum);

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

/* ────────── النشر (الخطوات ١١ في §٧.٤) ────────── */

export async function publish(
  tx: Tx,
  input: { batchId: number },
  actor: Actor,
): Promise<{ batchId: number; publishedCount: number; supersededBatchId: number | null }> {
  // ١+٢: قفل الرأس والتحقّق من الحالة.
  const batch = await lockBatch(tx, input.batchId);
  if (batch.status !== "DRAFT") {
    throw new TRPCError({ code: "CONFLICT", message: `الدُفعة ليست مسودّة (حالتها: ${batch.status})` });
  }
  const branchId = Number(batch.branchId);
  const providerId = Number(batch.providerId);

  // ٣: كل البطاقات الفعّالة للمزوّد في هذا الفرع.
  const offerings = await activeOfferings(tx, branchId, providerId);
  if (!offerings.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "لا بطاقات فعّالة لهذا المزوّد في هذا الفرع" });
  }

  const draftLines = await tx
    .select({
      id: digitalPriceVersions.id,
      offeringId: digitalPriceVersions.offeringId,
      providerShare: digitalPriceVersions.providerShare,
    })
    .from(digitalPriceVersions)
    .where(eq(digitalPriceVersions.batchId, input.batchId));
  const shareByOffering = new Map(draftLines.map((l) => [Number(l.offeringId), l.providerShare]));

  // ٤: لا سعر مفقود.
  const missing = offerings.filter((o) => !shareByOffering.has(o.offeringId));
  if (missing.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `أسعار ناقصة (${missing.length}): ${missing.slice(0, 5).map((m) => m.name).join("، ")}` +
        (missing.length > 5 ? "…" : ""),
    });
  }
  // سطرٌ لبطاقة لم تعد فعّالة ⇒ يُحذف بدل نشره (لا نُثبّت سعراً لبطاقة معطَّلة).
  const activeIds = new Set(offerings.map((o) => o.offeringId));
  const stale = draftLines.filter((l) => !activeIds.has(Number(l.offeringId)));
  if (stale.length) {
    await tx.delete(digitalPriceVersions).where(
      inArray(digitalPriceVersions.id, stale.map((s) => Number(s.id))),
    );
  }

  // ٥+٦: إعادة الحساب خادمياً ورفض ما دون الحدّ الأدنى.
  const now = new Date();
  const priced = offerings.map((o) => ({
    offeringId: o.offeringId,
    ...priceFor(o, shareByOffering.get(o.offeringId)!, true),
  }));

  // ٧: تثبيت النسخ (تصير غير قابلة للتعديل بمجرّد صيرورة الدُفعة PUBLISHED).
  for (const p of priced) {
    await tx
      .update(digitalPriceVersions)
      .set({
        providerShare: p.providerShare,
        sellPrice: p.sellPrice,
        marginAmount: p.marginAmount,
        validFrom: now,
      })
      .where(
        and(
          eq(digitalPriceVersions.batchId, input.batchId),
          eq(digitalPriceVersions.offeringId, p.offeringId),
        ),
      );
  }

  // ٩ (قبل ٨ وقبل ختم PUBLISHED): تسويد الدُفعة المنشورة السابقة وإغلاق سريان نسخها.
  // الترتيب مفروضٌ بالقيد الفريد «منشورة واحدة لكل (فرع×مزوّد)» — لا يمكن ختم الجديدة قبله.
  const [prev] = await tx
    .select({ id: digitalPriceBatches.id })
    .from(digitalPriceBatches)
    .where(
      and(
        eq(digitalPriceBatches.branchId, branchId),
        eq(digitalPriceBatches.providerId, providerId),
        eq(digitalPriceBatches.status, "PUBLISHED"),
      ),
    )
    .for("update");
  const supersededBatchId = prev ? Number(prev.id) : null;
  if (supersededBatchId != null) {
    await tx
      .update(digitalPriceVersions)
      .set({ validUntil: now })
      .where(
        and(
          eq(digitalPriceVersions.batchId, supersededBatchId),
          isNull(digitalPriceVersions.validUntil),
        ),
      );
    await tx
      .update(digitalPriceBatches)
      .set({ status: "SUPERSEDED" })
      .where(eq(digitalPriceBatches.id, supersededBatchId));
  }

  await tx
    .update(digitalPriceBatches)
    .set({ status: "PUBLISHED", publishedBy: actor.userId, publishedAt: now })
    .where(eq(digitalPriceBatches.id, input.batchId));

  // ٨: تحديث المؤشّر السريع ذرّياً بعد وجود النسخ.
  // ملاحظة مقصودة: بطاقةٌ سقطت من هذه الدُفعة (عُطِّلت) يبقى مؤشّرها على نسختها القديمة وقد
  // خُتم `validUntil` عليها ⇒ «آخر سعر معروف، منتهي». قراءة نقطة البيع (ش٥) تشتقّ منه
  // الحالة STALE_PRICE ولا تبيع به. لا نحذف المؤشّر كي يبقى الأثر التاريخيّ للتقارير.
  const finalVersions = await tx
    .select({ id: digitalPriceVersions.id, offeringId: digitalPriceVersions.offeringId })
    .from(digitalPriceVersions)
    .where(eq(digitalPriceVersions.batchId, input.batchId));

  for (const v of finalVersions) {
    await tx
      .insert(digitalCurrentPrices)
      .values({ branchId, offeringId: Number(v.offeringId), priceVersionId: Number(v.id) })
      .onDuplicateKeyUpdate({ set: { priceVersionId: Number(v.id) } });
  }

  // ١٠: أثر التدقيق.
  await auditLog(tx, actor, "digitalCards.pricing.published", input.batchId, {
    branchId,
    providerId,
    businessDate: String(batch.businessDate),
    count: priced.length,
    supersededBatchId,
  });

  return { batchId: input.batchId, publishedCount: priced.length, supersededBatchId };
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

/* ────────── بلاغ «السعر لدى الجهاز مختلف» (§٧.٥) ────────── */

export async function reportMismatch(
  tx: Tx,
  input: { branchId: number; offeringId: number; reportedProviderShare: string; notes?: string | null },
  actor: Actor,
): Promise<{ reportId: number }> {
  const [row] = await tx
    .select({
      providerId: digitalOfferings.providerId,
      priceVersionId: digitalCurrentPrices.priceVersionId,
    })
    .from(digitalOfferings)
    .innerJoin(
      digitalCurrentPrices,
      and(
        eq(digitalCurrentPrices.offeringId, digitalOfferings.id),
        eq(digitalCurrentPrices.branchId, input.branchId),
      ),
    )
    .where(eq(digitalOfferings.id, input.offeringId))
    .limit(1);
  if (!row) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "لا سعر نافذ لهذه البطاقة في هذا الفرع — لا معنى لبلاغ تغيّر",
    });
  }

  const share = money(input.reportedProviderShare);
  if (share.lt(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "التكلفة المُبلَّغة لا تكون سالبة" });
  }

  const res = await tx.insert(digitalPriceChangeReports).values({
    branchId: input.branchId,
    offeringId: input.offeringId,
    providerId: Number(row.providerId),
    currentPriceVersionId: Number(row.priceVersionId),
    reportedProviderShare: toDbMoney(share),
    status: "OPEN",
    reportedBy: actor.userId,
    notes: input.notes?.trim() || null,
  });
  const reportId = extractInsertId(res);
  await auditLog(tx, actor, "digitalCards.pricing.mismatchReported", reportId, {
    offeringId: input.offeringId,
    branchId: input.branchId,
  });
  return { reportId };
}

export async function listMismatchReports(
  db: DB,
  filters: { branchId?: number | null; status?: "OPEN" | "APPROVED" | "REJECTED" | "RESOLVED" },
) {
  const conds = [];
  if (filters.branchId != null) conds.push(eq(digitalPriceChangeReports.branchId, filters.branchId));
  if (filters.status) conds.push(eq(digitalPriceChangeReports.status, filters.status));

  return db
    .select({
      id: digitalPriceChangeReports.id,
      branchId: digitalPriceChangeReports.branchId,
      branchName: branches.name,
      offeringId: digitalPriceChangeReports.offeringId,
      offeringName: products.name,
      providerId: digitalPriceChangeReports.providerId,
      providerName: suppliers.name,
      reportedProviderShare: digitalPriceChangeReports.reportedProviderShare,
      currentProviderShare: digitalPriceVersions.providerShare,
      currentSellPrice: digitalPriceVersions.sellPrice,
      status: digitalPriceChangeReports.status,
      notes: digitalPriceChangeReports.notes,
      reportedBy: digitalPriceChangeReports.reportedBy,
      createdAt: digitalPriceChangeReports.createdAt,
      resolvedAt: digitalPriceChangeReports.resolvedAt,
    })
    .from(digitalPriceChangeReports)
    .innerJoin(branches, eq(digitalPriceChangeReports.branchId, branches.id))
    .innerJoin(digitalOfferings, eq(digitalPriceChangeReports.offeringId, digitalOfferings.id))
    .innerJoin(products, eq(digitalOfferings.productId, products.id))
    .innerJoin(digitalProviders, eq(digitalPriceChangeReports.providerId, digitalProviders.id))
    .innerJoin(suppliers, eq(digitalProviders.supplierId, suppliers.id))
    .innerJoin(
      digitalPriceVersions,
      eq(digitalPriceChangeReports.currentPriceVersionId, digitalPriceVersions.id),
    )
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(digitalPriceChangeReports.id))
    .limit(200);
}

/** رفض البلاغ (لا يمسّ أيّ سعر). */
export async function rejectMismatch(
  tx: Tx,
  input: { reportId: number; notes?: string | null },
  actor: Actor,
): Promise<void> {
  const [report] = await tx
    .select()
    .from(digitalPriceChangeReports)
    .where(eq(digitalPriceChangeReports.id, input.reportId))
    .for("update");
  if (!report) throw new TRPCError({ code: "NOT_FOUND", message: "البلاغ غير موجود" });
  if (report.status !== "OPEN") {
    throw new TRPCError({ code: "CONFLICT", message: "البلاغ عولِج مسبقاً" });
  }
  await tx
    .update(digitalPriceChangeReports)
    .set({
      status: "REJECTED",
      resolvedBy: actor.userId,
      resolvedAt: new Date(),
      notes: input.notes?.trim() || report.notes,
    })
    .where(eq(digitalPriceChangeReports.id, input.reportId));
  await auditLog(tx, actor, "digitalCards.pricing.mismatchRejected", input.reportId, {});
}

/**
 * اعتماد البلاغ: **لا يعدّل الإصدار القديم**؛ ينشئ دُفعة سعر جديدة لهذه البطاقة وينشرها،
 * ثم يربط النسخة الناتجة بالبلاغ (§٧.٥). البطاقات الأخرى تحتفظ بأسعارها الحالية.
 */
export async function approveMismatch(
  tx: Tx,
  input: { reportId: number; businessDate: string; notes?: string | null },
  actor: Actor,
): Promise<{ reportId: number; batchId: number; priceVersionId: number }> {
  const [report] = await tx
    .select()
    .from(digitalPriceChangeReports)
    .where(eq(digitalPriceChangeReports.id, input.reportId))
    .for("update");
  if (!report) throw new TRPCError({ code: "NOT_FOUND", message: "البلاغ غير موجود" });
  if (report.status !== "OPEN") {
    throw new TRPCError({ code: "CONFLICT", message: "البلاغ عولِج مسبقاً" });
  }

  const branchId = Number(report.branchId);
  const providerId = Number(report.providerId);
  const scope: SheetScope = { branchId, providerId, businessDate: input.businessDate };

  // حارس فقد بيانات: الاعتماد ينسخ الأسعار النافذة فوق سطور المسودّة، فلو كان مديرٌ آخر
  // في منتصف إدخال مسودّة لهذا اليوم لطُمس عملُه صامتاً. نرفض ونطلب حسمها أوّلاً.
  const [openDraft] = await tx
    .select({ id: digitalPriceBatches.id })
    .from(digitalPriceBatches)
    .where(
      and(
        eq(digitalPriceBatches.branchId, branchId),
        eq(digitalPriceBatches.providerId, providerId),
        eq(digitalPriceBatches.businessDate, input.businessDate),
        eq(digitalPriceBatches.status, "DRAFT"),
      ),
    )
    .limit(1);
  if (openDraft) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "توجد مسودّة أسعار مفتوحة لهذا اليوم — انشرها أو ألغِها قبل اعتماد البلاغ " +
        "(الاعتماد ينشر دُفعةً كاملة فيطمس المسودّة).",
    });
  }

  // دُفعة جديدة تحمل الأسعار النافذة كما هي، والبطاقة المُبلَّغ عنها بالحصة الجديدة.
  const { batchId } = await copyPrevious(tx, scope, actor);
  await saveDraft(
    tx,
    {
      batchId,
      lines: [{ offeringId: Number(report.offeringId), providerShare: report.reportedProviderShare }],
    },
    actor,
  );
  await publish(tx, { batchId }, actor);

  const [newVersion] = await tx
    .select({ id: digitalPriceVersions.id })
    .from(digitalPriceVersions)
    .where(
      and(
        eq(digitalPriceVersions.batchId, batchId),
        eq(digitalPriceVersions.offeringId, Number(report.offeringId)),
      ),
    )
    .limit(1);

  await tx
    .update(digitalPriceChangeReports)
    .set({
      status: "RESOLVED",
      resolvedBy: actor.userId,
      resolvedAt: new Date(),
      resolutionPriceVersionId: newVersion ? Number(newVersion.id) : null,
      notes: input.notes?.trim() || report.notes,
    })
    .where(eq(digitalPriceChangeReports.id, input.reportId));

  await auditLog(tx, actor, "digitalCards.pricing.mismatchApproved", input.reportId, {
    batchId,
    offeringId: Number(report.offeringId),
  });

  return { reportId: input.reportId, batchId, priceVersionId: newVersion ? Number(newVersion.id) : 0 };
}

/** عدد البلاغات المفتوحة — شارة للمدير. */
export async function openMismatchCount(db: DB, branchId: number | null): Promise<number> {
  const conds = [eq(digitalPriceChangeReports.status, "OPEN" as const)];
  if (branchId != null) conds.push(eq(digitalPriceChangeReports.branchId, branchId));
  const [row] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(digitalPriceChangeReports)
    .where(and(...conds));
  return Number(row?.n ?? 0);
}
