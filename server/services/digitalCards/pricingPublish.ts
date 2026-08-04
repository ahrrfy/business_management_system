/** أسعار بداية اليوم (ش٤) — النشر (الخطوات ١١ في §٧.٤ من وثيقة التصميم). */
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  digitalCurrentPrices,
  digitalPriceBatches,
  digitalPriceVersions,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import type { Actor } from "../tx";
import { activeOfferings, auditLog, lockBatch, priceFor } from "./pricingShared";
import { BIG_CHANGE_THRESHOLD_PERCENT, currentSharesFor, detectBigChanges } from "./pricingBigChange";

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
      sellPrice: digitalPriceVersions.sellPrice,
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
  const now = new Date();
  const priced = offerings.map((o) => ({
    offeringId: o.offeringId,
    ...priceFor(o, draftByOffering.get(o.offeringId)!.providerShare, draftByOffering.get(o.offeringId)!.sellPrice, true),
  }));

  // ٦-ب (§٧.١): بوّابة «التغيير الكبير» — تُحسب من **الحصص المُعاد حسابها** لا من مُدخل العميل،
  // وتحت قفل الدُفعة نفسه الذي يمسكه `saveDraft` ⇒ لا نافذة بين الاعتماد والنشر.
  const currentShares = await currentSharesFor(tx, branchId, offerings.map((o) => o.offeringId));
  const bigChanges = detectBigChanges(
    offerings,
    currentShares,
    new Map(priced.map((p) => [p.offeringId, p.providerShare])),
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
    // فصل المهام: المعتمِد ≠ مُنشئ المسودّة. admin مُستثنى للتصحيح الإداريّ.
    if (approvedBy === Number(batch.createdBy) && actor.role !== "admin") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "اعتماد التغيير الكبير جاء من مُنشئ المسودّة نفسه — يلزم مديرٌ آخر",
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
