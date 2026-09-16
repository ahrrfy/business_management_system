/**
 * شبكة بطاقات نقطة البيع (ش٥) — القراءة الوحيدة المتاحة للكاشير على هذه الوحدة.
 *
 * **عقد أمنيّ صارم (§٨.٢ من وثيقة التصميم):** المخرَج **لا يحمل** تكلفة ولا حصة مزوّد ولا هامش
 * ولا رصيد محفظة ولا نمط تسوية. هذا حجبٌ في طبقة الاستعلام نفسه (لا CSS ولا تصفية عميل):
 * الحقول ببساطة لا تُقرأ من القاعدة، فلا تصل الشبكة أصلاً.
 *
 * الفرع يُفرَض خادمياً، والبطاقة غير المسموح بيعها في هذا الفرع لا تُعاد إطلاقاً.
 */
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import {
  branches,
  digitalCurrentPrices,
  digitalOfferingBranches,
  digitalOfferings,
  digitalPriceVersions,
  digitalProviders,
  digitalSaleIntentItems,
  productImages,
  products,
  suppliers,
} from "../../../drizzle/schema";
import { normalizeDigitalSaleReference } from "../../../shared/digitalSale";
import type { DB } from "../../db";

export type CardCategory = "FAVORITES" | "TELECOM" | "GLOBAL" | "EDUCATIONAL" | "ALL";

/** «جاهز» = سعرٌ نافذ غير منتهٍ. ما عداه لا يُباع (الحارس النهائيّ خادميّ في prepare/finalize). */
export type CardAvailability = "READY" | "STALE_PRICE" | "NO_PRICE";

export interface PosCard {
  offeringId: number;
  productId: number;
  variantId: number;
  productUnitId: number;
  name: string;
  providerId: number;
  providerName: string;
  offeringType: string;
  requiresStudentData: boolean;
  subscriptionDurationDays: number | null;
  faceValue: string | null;
  sellPrice: string | null;
  priceVersionId: number | null;
  imageUrl: string | null;
  cardColorToken: string | null;
  isFavorite: boolean;
  displayOrder: number;
  availability: CardAvailability;
}

const CATEGORY_TO_TYPE: Record<Exclude<CardCategory, "FAVORITES" | "ALL">, string> = {
  TELECOM: "TELECOM_CARD",
  GLOBAL: "GLOBAL_CARD",
  EDUCATIONAL: "EDUCATIONAL_SUBSCRIPTION",
};

/** تطبيع خفيف للبحث العربي (همزات/تاء مربوطة/تشكيل) — مطابقٌ لروح `searchNorm` بلا عمود مولَّد. */
function norm(s: string): string {
  return s
    .replace(/[ً-ْٰ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .toLowerCase()
    .trim();
}

export async function listCards(
  db: DB,
  input: { branchId: number; category?: CardCategory; providerId?: number; q?: string; now?: Date },
): Promise<PosCard[]> {
  const [branch] = await db.select({ id: branches.id }).from(branches).where(eq(branches.id, input.branchId)).limit(1);
  if (!branch) return [];

  const conds = [
    eq(digitalOfferingBranches.branchId, input.branchId),
    eq(digitalOfferingBranches.isActive, true),
    eq(digitalOfferings.isActive, true),
    eq(digitalProviders.isActive, true),
  ];
  if (input.providerId != null) conds.push(eq(digitalOfferings.providerId, input.providerId));
  if (input.category && input.category !== "ALL" && input.category !== "FAVORITES") {
    conds.push(eq(digitalOfferings.offeringType, CATEGORY_TO_TYPE[input.category] as never));
  }
  if (input.category === "FAVORITES") conds.push(eq(digitalOfferingBranches.isFavorite, true));

  const rows = await db
    .select({
      offeringId: digitalOfferings.id,
      productId: digitalOfferings.productId,
      variantId: digitalOfferings.variantId,
      productUnitId: digitalOfferings.productUnitId,
      name: products.name,
      providerId: digitalOfferings.providerId,
      providerName: suppliers.name,
      offeringType: digitalOfferings.offeringType,
      requiresStudentData: digitalOfferings.requiresStudentData,
      subscriptionDurationDays: digitalOfferings.subscriptionDurationDays,
      faceValue: digitalOfferings.faceValue,
      cardColorToken: digitalOfferings.cardColorToken,
      priceValidityHours: digitalOfferings.priceValidityHours,
      isFavorite: digitalOfferingBranches.isFavorite,
      displayOrder: digitalOfferingBranches.displayOrder,
      // السعر فقط — لا providerShare ولا marginAmount (حجبٌ في الاستعلام لا في العرض).
      sellPrice: digitalPriceVersions.sellPrice,
      priceVersionId: digitalPriceVersions.id,
      validFrom: digitalPriceVersions.validFrom,
      validUntil: digitalPriceVersions.validUntil,
      imageUrl: productImages.url,
    })
    .from(digitalOfferings)
    .innerJoin(digitalOfferingBranches, eq(digitalOfferingBranches.offeringId, digitalOfferings.id))
    .innerJoin(digitalProviders, eq(digitalOfferings.providerId, digitalProviders.id))
    .innerJoin(suppliers, eq(digitalProviders.supplierId, suppliers.id))
    .innerJoin(products, eq(digitalOfferings.productId, products.id))
    .leftJoin(
      digitalCurrentPrices,
      and(
        eq(digitalCurrentPrices.offeringId, digitalOfferings.id),
        eq(digitalCurrentPrices.branchId, input.branchId),
      ),
    )
    .leftJoin(digitalPriceVersions, eq(digitalCurrentPrices.priceVersionId, digitalPriceVersions.id))
    .leftJoin(
      productImages,
      and(eq(productImages.productId, digitalOfferings.productId), eq(productImages.isPrimary, true)),
    )
    .where(and(...conds))
    .orderBy(digitalOfferingBranches.displayOrder, digitalOfferings.id);

  const now = input.now ?? new Date();
  const needle = input.q?.trim() ? norm(input.q) : null;

  const cards: PosCard[] = [];
  for (const r of rows) {
    if (needle && !norm(r.name).includes(needle) && !norm(r.providerName).includes(needle)) continue;

    let availability: CardAvailability;
    if (r.priceVersionId == null || r.sellPrice == null) {
      availability = "NO_PRICE";
    } else if (r.validUntil != null) {
      // نسخة أُغلق سريانها بنشرٍ لاحق لم يشملها (بطاقة عُطِّلت مؤقّتاً ثم أُعيدت) ⇒ آخر سعر معروف، منتهٍ.
      availability = "STALE_PRICE";
    } else if (r.priceValidityHours != null && r.validFrom != null) {
      const ageHours = (now.getTime() - new Date(r.validFrom).getTime()) / 3_600_000;
      availability = ageHours > r.priceValidityHours ? "STALE_PRICE" : "READY";
    } else {
      availability = "READY";
    }

    cards.push({
      offeringId: Number(r.offeringId),
      productId: Number(r.productId),
      variantId: Number(r.variantId),
      productUnitId: Number(r.productUnitId),
      name: r.name,
      providerId: Number(r.providerId),
      providerName: r.providerName,
      offeringType: r.offeringType,
      requiresStudentData: r.requiresStudentData,
      subscriptionDurationDays: r.subscriptionDurationDays,
      faceValue: r.faceValue,
      sellPrice: r.sellPrice,
      priceVersionId: r.priceVersionId != null ? Number(r.priceVersionId) : null,
      imageUrl: r.imageUrl,
      cardColorToken: r.cardColorToken,
      isFavorite: r.isFavorite,
      displayOrder: r.displayOrder,
      availability,
    });
  }
  return cards;
}

/**
 * تأكيد سعر بطاقة قبل إضافتها للسلة — الخادم مصدر السعر الوحيد.
 * يمرّ بنفس منطق `listCards` (لا نسخة ثانية من اشتقاق الجاهزية) ويرفض غير الجاهزة،
 * فلا يدخل السلةَ سطرٌ بسعرٍ منتهٍ أو غير منشور.
 */
export async function confirmCard(
  db: DB,
  input: { branchId: number; offeringId: number },
): Promise<PosCard & { sellPrice: string; priceVersionId: number }> {
  const cards = await listCards(db, { branchId: input.branchId, category: "ALL" });
  const card = cards.find((c) => c.offeringId === input.offeringId);
  if (!card) {
    throw new TRPCError({ code: "NOT_FOUND", message: "البطاقة غير متاحة في هذا الفرع" });
  }
  if (card.availability === "NO_PRICE" || card.sellPrice == null || card.priceVersionId == null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `«${card.name}» بلا سعر منشور لهذا الفرع — انشر سعر اليوم قبل البيع`,
    });
  }
  if (card.availability === "STALE_PRICE") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `سعر «${card.name}» انتهت صلاحيته — يحتاج تحديثاً من شاشة أسعار اليوم`,
    });
  }
  return { ...card, sellPrice: card.sellPrice, priceVersionId: card.priceVersionId };
}

/**
 * يمنع إعادة استعمال رقمٍ حُفظ سابقاً لدى المزوّد نفسه قبل إدخاله للسلة.
 * هذا فحصٌ داخليّ في قاعدة بياناتنا فقط؛ لا يوجد أي اتصال أو تحقق لدى المزوّد.
 * القيد الفريد داخل `prepare` يبقى الحارس النهائي ضد سباق نافذتين متزامنتين.
 */
export async function assertReferenceAvailable(
  db: DB,
  input: { branchId: number; offeringId: number; providerReference: string },
): Promise<{ providerReference: string }> {
  const card = await confirmCard(db, { branchId: input.branchId, offeringId: input.offeringId });
  const providerReference = normalizeDigitalSaleReference(input.providerReference);
  if (!providerReference) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "أدخل رقم العملية أو رقم الاشتراك قبل الإضافة للسلة" });
  }
  if (providerReference.length > 120) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الرقم المرجعي أطول من الحد المسموح" });
  }

  const [used] = await db
    .select({ id: digitalSaleIntentItems.id })
    .from(digitalSaleIntentItems)
    .where(and(
      eq(digitalSaleIntentItems.providerId, card.providerId),
      eq(digitalSaleIntentItems.providerReference, providerReference),
    ))
    .limit(1);
  if (used) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "هذا الرقم محفوظ لعملية سابقة لدى المزوّد نفسه — طابقه مع جهاز المزوّد",
    });
  }
  return { providerReference };
}
