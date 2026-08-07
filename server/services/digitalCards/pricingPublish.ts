/** أسعار بداية اليوم (ش٤) — النشر (الخطوات ١١ في §٧.٤ من وثيقة التصميم). */
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  digitalCurrentPrices,
  digitalOfferingBranches,
  digitalOfferings,
  digitalPriceBatches,
  digitalPriceVersions,
  digitalProviders,
  users,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import type { Actor } from "../tx";
import {
  activeOfferings,
  auditLog,
  latestBigChangeApproval,
  lockBatch,
  lockPublishedScope,
  priceFor,
} from "./pricingShared";
import {
  BIG_CHANGE_THRESHOLD_PERCENT,
  approvalFingerprint,
  approvalSnapshotFor,
  currentPricesFor,
  detectBigChanges,
} from "./pricingBigChange";

export interface PublishReadiness {
  scopeTotal: number;
  scopeReady: number;
  branchTotal: number;
  branchReady: number;
  missing: number;
}

export async function publish(
  tx: Tx,
  input: { batchId: number; expectedOfferingIds?: number[] },
  actor: Actor,
): Promise<{
  batchId: number;
  publishedCount: number;
  supersededBatchId: number | null;
  readiness: PublishReadiness;
}> {
  // ١+٢: قفل الرأس والتحقّق من الحالة.
  const batch = await lockBatch(tx, input.batchId);
  if (batch.status !== "DRAFT") {
    throw new TRPCError({ code: "CONFLICT", message: `الدُفعة ليست مسودّة (حالتها: ${batch.status})` });
  }
  const branchId = Number(batch.branchId);
  const providerId = Number(batch.providerId);
  const publishedScope = await lockPublishedScope(tx, branchId, providerId);
  const supersededBatchId = publishedScope?.id ?? null;
  if (publishedScope && String(batch.businessDate) < publishedScope.businessDate) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `لا يمكن نشر أسعار ${String(batch.businessDate)} فوق أسعار أحدث (${publishedScope.businessDate})`,
    });
  }
  // كل timestamps بعد قفل النطاق، فلا يمكن back-date لسريان دفعة انتظرَت ناشراً آخر.
  const now = new Date();

  // ٣: كل البطاقات الفعّالة للمزوّد في هذا الفرع.
  const offerings = await activeOfferings(tx, branchId, providerId);
  if (!offerings.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "لا بطاقات فعّالة لهذا المزوّد في هذا الفرع" });
  }
  if (input.expectedOfferingIds) {
    const expected = new Set(input.expectedOfferingIds);
    const active = new Set(offerings.map((o) => o.offeringId));
    const duplicates = input.expectedOfferingIds.length - expected.size;
    const omitted = offerings.filter((o) => !expected.has(o.offeringId));
    const unexpected = Array.from(expected).filter((id) => !active.has(id));
    if (duplicates || omitted.length || unexpected.length) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          `طلب النشر يجب أن يحتوي كل بطاقات النطاق مرةً واحدة ` +
          `(ناقص ${omitted.length}، زائد ${unexpected.length}، مكرر ${duplicates})`,
      });
    }
  }

  const draftLines = await tx
    .select({
      id: digitalPriceVersions.id,
      offeringId: digitalPriceVersions.offeringId,
      providerShare: digitalPriceVersions.providerShare,
      sellPrice: digitalPriceVersions.sellPrice,
      createdBy: digitalPriceVersions.createdBy,
    })
    .from(digitalPriceVersions)
    .where(eq(digitalPriceVersions.batchId, input.batchId));
  const draftByOffering = new Map(draftLines.map((l) => [Number(l.offeringId), l]));

  // ٤: لا سعر مفقود.
  const missing = offerings.filter((o) => !draftByOffering.has(o.offeringId));
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
  const priced = offerings.map((o) => ({
    offeringId: o.offeringId,
    ...priceFor(o, draftByOffering.get(o.offeringId)!.providerShare, draftByOffering.get(o.offeringId)!.sellPrice, true),
  }));

  // ٦-ب (§٧.١): بوّابة «التغيير الكبير» — تُحسب من **الحصص المُعاد حسابها** لا من مُدخل العميل،
  // وتحت قفل الدُفعة نفسه الذي يمسكه `saveDraft` ⇒ لا نافذة بين الاعتماد والنشر.
  const offeringIds = offerings.map((o) => o.offeringId);
  const currentPrices = await currentPricesFor(tx, branchId, offeringIds);
  const currentByOffering = new Map(currentPrices.map((row) => [row.offeringId, row]));
  const bigChanges = detectBigChanges(
    offerings,
    new Map(currentPrices.map((row) => [row.offeringId, row.providerShare])),
    new Map(priced.map((p) => [p.offeringId, p.providerShare])),
    new Map(currentPrices.map((row) => [row.offeringId, row.sellPrice])),
    new Map(priced.map((p) => [p.offeringId, p.sellPrice])),
  );
  if (bigChanges.length > 0) {
    const approvedBy = batch.bigChangeApprovedBy != null ? Number(batch.bigChangeApprovedBy) : null;
    if (approvedBy == null) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          `${bigChanges.length} بطاقة تغيّرت حصتها ≥${BIG_CHANGE_THRESHOLD_PERCENT}% عن السعر النافذ ` +
          `(${bigChanges.slice(0, 3).map((b) => `${b.name}: ${b.changePercent}%`).join("، ")}` +
          `${bigChanges.length > 3 ? "…" : ""}) — يلزم اعتماد مديرٍ آخر قبل النشر.`,
      });
    }
    if (approvedBy === Number(batch.createdBy)) {
      const [approver] = await tx
        .select({ isOwner: users.isOwner })
        .from(users)
        .where(eq(users.id, approvedBy))
        .limit(1);
      if (!approver?.isOwner) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "اعتماد التغيير الكبير جاء من مُنشئ المسودّة نفسه — يلزم مديرٌ آخر، ويُستثنى مالك النظام",
        });
      }
    }

    const snapshot = approvalSnapshotFor(
      input.batchId,
      offeringIds,
      currentByOffering,
      priced.map((line) => ({
        offeringId: line.offeringId,
        providerShare: line.providerShare,
        sellPrice: line.sellPrice,
        editedBy: Number(draftByOffering.get(line.offeringId)!.createdBy),
      })),
    );
    const expectedFingerprint = approvalFingerprint(snapshot);
    const approval = await latestBigChangeApproval(tx, input.batchId);
    const details = approval?.newValue as Record<string, unknown> | null | undefined;
    if (
      Number(approval?.userId) !== approvedBy ||
      details?.approvalFingerprint !== expectedFingerprint ||
      details?.approvalSnapshotVersion !== snapshot.version
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "تغيّر السعر النافذ أو تفاصيل المسودّة بعد الاعتماد — يلزم اعتماد جديد على الأرقام الحالية",
      });
    }
  }

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

  const branchHealth = await tx
    .select({
      providerId: digitalOfferings.providerId,
      priceValidityHours: digitalOfferings.priceValidityHours,
      priceVersionId: digitalCurrentPrices.priceVersionId,
      validFrom: digitalPriceVersions.validFrom,
      validUntil: digitalPriceVersions.validUntil,
    })
    .from(digitalOfferingBranches)
    .innerJoin(digitalOfferings, eq(digitalOfferingBranches.offeringId, digitalOfferings.id))
    .innerJoin(digitalProviders, eq(digitalOfferings.providerId, digitalProviders.id))
    .leftJoin(
      digitalCurrentPrices,
      and(
        eq(digitalCurrentPrices.offeringId, digitalOfferings.id),
        eq(digitalCurrentPrices.branchId, branchId),
      ),
    )
    .leftJoin(digitalPriceVersions, eq(digitalCurrentPrices.priceVersionId, digitalPriceVersions.id))
    .where(
      and(
        eq(digitalOfferingBranches.branchId, branchId),
        eq(digitalOfferingBranches.isActive, true),
        eq(digitalOfferings.isActive, true),
        eq(digitalProviders.isActive, true),
      ),
    );
  const readinessNow = Date.now();
  const isReady = (row: (typeof branchHealth)[number]) => {
    if (row.priceVersionId == null || row.validUntil != null) return false;
    if (row.priceValidityHours == null || row.validFrom == null) return true;
    const ageHours = (readinessNow - new Date(row.validFrom).getTime()) / 3_600_000;
    return ageHours <= row.priceValidityHours;
  };
  const scopeHealth = branchHealth.filter((row) => Number(row.providerId) === providerId);
  const readiness: PublishReadiness = {
    scopeTotal: scopeHealth.length,
    scopeReady: scopeHealth.filter(isReady).length,
    branchTotal: branchHealth.length,
    branchReady: branchHealth.filter(isReady).length,
    missing: branchHealth.filter((row) => !isReady(row)).length,
  };

  // ١٠: أثر التدقيق.
  await auditLog(tx, actor, "digitalCards.pricing.published", input.batchId, {
    branchId,
    providerId,
    businessDate: String(batch.businessDate),
    count: priced.length,
    supersededBatchId,
    readiness,
  });

  return { batchId: input.batchId, publishedCount: priced.length, supersededBatchId, readiness };
}
