/**
 * bannerAiStudioService — خدمة الخلفية لـ«مركز التصميم الذكي المُدار للبنرات والعروض».
 *
 * المهام الجوهرية:
 * 1. استعراض بصري سريع لمنتجات الكتالوج مع صورها وأسعارها وفئاتها (listStudioCandidateProducts).
 * 2. سحب تلقائي لحقائق وصور الفئة أو المنتج أو الباقة أو العرض، والتعرّف البصري والدلالي على طبيعتها
 *    (Gemini Multimodal Vision على صور المنتجات الفعلية + inferBannerNatureAndPreset) لاقتراح القالب
 *    والإضاءة و3 صياغات تسويقية مرتبطة بطبيعة المنتج وأسعاره الحقيقية.
 * 3. توليد مشهد استوديو وإضاءة عبر Gemini Nano Banana حول صور المنتجات المسحوبة نفسها.
 */

import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import { formatPromotionSummary, type PromotionType } from "@shared/promotionEngine";
import {
  BANNER_STUDIO_PRESETS,
  BANNER_STUDIO_PRESET_IDS,
  buildAiBannerScenePrompt,
  buildDeterministicBannerCopyVariants,
  buildSafeBannerDestinationUrl,
  DEFAULT_BANNER_SCENE_MODEL,
  FALLBACK_BANNER_SCENE_MODEL,
  inferBannerNatureAndPreset,
  validateBannerMarketingCopy,
  type BannerCopySourceFacts,
  type BannerCopyVariant,
  type BannerLightingMode,
  type BannerSceneModel,
  type BannerStudioPresetId,
  type BannerStudioProductPreview,
  type BannerTargetKind,
  type StudioBannerPlacement,
} from "@shared/imageStudio/bannerStudioContract";
import {
  categories,
  productImages,
  productPrices,
  productUnits,
  productVariants,
  products,
  promotionTargets,
  promotions,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import { decodeDataUrl, inventoryProductImageUrl } from "../../imageRoute";
import { escLike } from "../../lib/sqlLike";
import { getImageStore } from "../../lib/imageStore";
import { logger } from "../../logger";
import { AiImageError, aiImageErrorMessageAr, generateStudioImage } from "../aiImageStudioService";
import { loadVariantAvailability } from "../catalog/variantAvailability";
import { getAiStudioRuntime } from "../imageStudioSettingsService";
import {
  ImageStudioGuardError,
  imageStudioGuardErrorMessageAr,
  runGuardedImageStudioCall,
} from "../imageStudioUsageGuard";
import {
  evaluateStorefrontUnitEligibility,
  storefrontPublishableCondition,
} from "../storefrontEligibilityService";
import { resolveStorefrontBranchId } from "../storefrontService";

const GEMINI_CONTENT_BASE = (
  process.env.GEMINI_API_BASE?.trim() || "https://generativelanguage.googleapis.com/v1beta"
).replace(/\/+$/, "");

const BANNER_COPY_MODEL = process.env.PRODUCT_CONTENT_MODEL?.trim() || "gemini-flash-latest";
const BANNER_COPY_FALLBACK_MODEL =
  process.env.PRODUCT_CONTENT_MODEL_FALLBACK?.trim() || "gemini-flash-lite-latest";

export type { BannerStudioProductPreview };

export interface GenerateBannerCopyInput {
  targetKind: BannerTargetKind;
  promotionId?: number | null;
  categoryId?: number | null;
  productIds?: number[];
  customTopic?: string | null;
}

export interface GenerateBannerCopyOutput {
  facts: BannerCopySourceFacts;
  natureLabelAr: string;
  recommendedPresetId: BannerStudioPresetId;
  variants: BannerCopyVariant[];
  products: BannerStudioProductPreview[];
  aiUsed: boolean;
  aiFallbackReason?: string | null;
}

function fmtMoneyPlain(num: number): string {
  return new Intl.NumberFormat("ar-IQ-u-nu-latn", { maximumFractionDigits: 0 }).format(Math.round(num));
}

/** يحمّل تفاصيل المنتجات المختارة (الاسم، الفئة، الماركة، الوصف، السعر، والصورة المعتمدة). */
async function loadRichProductsByIds(productIds: number[]): Promise<
  Array<BannerStudioProductPreview & { description: string | null; numericPrice: number | null }>
> {
  const db = getDb();
  const cleanIds = Array.from(new Set(productIds.filter((id) => Number.isInteger(id) && id > 0))).slice(0, 8);
  if (!db || cleanIds.length === 0) return [];

  const branchId = await resolveStorefrontBranchId();
  const [prodRows, imgRows, priceRows] = await Promise.all([
    db
      .select({
        id: products.id,
        name: products.name,
        description: products.description,
        brand: products.brand,
        categoryId: products.categoryId,
        categoryName: categories.name,
      })
      .from(products)
      .leftJoin(categories, eq(products.categoryId, categories.id))
      .where(inArray(products.id, cleanIds)),
    db
      .select({
        id: productImages.id,
        productId: productImages.productId,
        url: productImages.url,
        objectKey: productImages.objectKey,
        contentHash: productImages.contentHash,
        isPrimary: productImages.isPrimary,
        sortOrder: productImages.sortOrder,
      })
      .from(productImages)
      .where(and(inArray(productImages.productId, cleanIds), eq(productImages.reviewStatus, "APPROVED")))
      .orderBy(desc(productImages.isPrimary), asc(productImages.sortOrder), asc(productImages.id)),
    db
      .select({
        productId: productVariants.productId,
        variantId: productVariants.id,
        conversionFactor: productUnits.conversionFactor,
        price: productPrices.price,
      })
      .from(productPrices)
      .innerJoin(
        productUnits,
        and(
          eq(productPrices.productUnitId, productUnits.id),
          eq(productUnits.isActive, true),
          eq(productUnits.isStoreSaleUnit, true),
        ),
      )
      .innerJoin(
        productVariants,
        and(eq(productUnits.variantId, productVariants.id), eq(productVariants.isActive, true)),
      )
      .where(and(inArray(productVariants.productId, cleanIds), eq(productPrices.priceTier, "RETAIL"))),
  ]);

  const primaryImgByProduct = new Map<number, string | null>();
  for (const img of imgRows) {
    const pid = Number(img.productId);
    if (primaryImgByProduct.has(pid)) continue;
    primaryImgByProduct.set(
      pid,
      inventoryProductImageUrl(Number(img.id), {
        url: img.url,
        objectKey: img.objectKey,
        contentHash: img.contentHash,
      }),
    );
  }

  const availability = await loadVariantAvailability(
    db,
    branchId,
    priceRows.map((pr) => Number(pr.variantId)),
  );
  const inStockMinPriceByProduct = new Map<number, number>();
  const fallbackEligibleMinPriceByProduct = new Map<number, number>();
  for (const pr of priceRows) {
    const pid = Number(pr.productId);
    const val = Number(pr.price ?? 0);
    if (val <= 0) continue;
    const state = availability.get(Number(pr.variantId));
    const eligibility = evaluateStorefrontUnitEligibility({
      isActive: true,
      isStoreSaleUnit: true,
      retailPrice: pr.price,
      conversionFactor: pr.conversionFactor,
      stockBase: state?.hasStockRow ? state.onHandBase : null,
      availableBase: state?.availableBase ?? 0,
    });
    if (!eligibility.publishable) continue;
    const prevFallback = fallbackEligibleMinPriceByProduct.get(pid);
    if (prevFallback == null || val < prevFallback) {
      fallbackEligibleMinPriceByProduct.set(pid, val);
    }
    if (state?.isService === true || eligibility.available) {
      const prevInStock = inStockMinPriceByProduct.get(pid);
      if (prevInStock == null || val < prevInStock) {
        inStockMinPriceByProduct.set(pid, val);
      }
    }
  }

  const byId = new Map(prodRows.map((p) => [Number(p.id), p]));
  return cleanIds.flatMap((pid) => {
    const p = byId.get(pid);
    if (!p) return [];
    const minP = inStockMinPriceByProduct.get(pid) ?? fallbackEligibleMinPriceByProduct.get(pid) ?? null;
    return [
      {
        productId: pid,
        name: p.name,
        categoryId: p.categoryId == null ? null : Number(p.categoryId),
        categoryName: p.categoryName ?? null,
        brand: p.brand ?? null,
        description: p.description ?? null,
        numericPrice: minP,
        priceText: minP != null ? `${fmtMoneyPlain(minP)} د.ع` : null,
        imageUrl: primaryImgByProduct.get(pid) ?? null,
      },
    ];
  });
}

/**
 * يعيد قائمة مصوّرة فورية للمنتجات المتوفرة فعلياً بالمخزون فقط (حماية المتجر من الترويج لأصناف نافدة).
 */
export async function listBannerCandidateProducts(input?: {
  q?: string | null;
  categoryId?: number | null;
  limit?: number;
}): Promise<BannerStudioProductPreview[]> {
  const db = getDb();
  if (!db) return [];
  const limit = Math.min(24, Math.max(4, Math.trunc(input?.limit ?? 16)));
  const branchId = await resolveStorefrontBranchId();
  const conds = [storefrontPublishableCondition()];
  if (input?.categoryId && input.categoryId > 0) {
    conds.push(eq(products.categoryId, input.categoryId));
  }
  const qTrim = input?.q?.trim();
  if (qTrim) {
    const pat = `%${escLike(qTrim)}%`;
    conds.push(sql`(${products.name} LIKE ${pat} ESCAPE '!' OR COALESCE(${products.brand}, '') LIKE ${pat} ESCAPE '!')`);
  }

  const unitRows = await db
    .select({
      productId: products.id,
      variantId: productVariants.id,
      conversionFactor: productUnits.conversionFactor,
      price: productPrices.price,
      isFeatured: products.isFeatured,
      hasImage: sql<number>`EXISTS (SELECT 1 FROM productImages pi WHERE pi.productId = ${products.id} AND pi.reviewStatus = 'APPROVED')`,
    })
    .from(products)
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .innerJoin(productVariants, and(eq(productVariants.productId, products.id), eq(productVariants.isActive, true)))
    .innerJoin(
      productUnits,
      and(eq(productUnits.variantId, productVariants.id), eq(productUnits.isActive, true), eq(productUnits.isStoreSaleUnit, true)),
    )
    .innerJoin(productPrices, and(eq(productPrices.productUnitId, productUnits.id), eq(productPrices.priceTier, "RETAIL")))
    .where(and(...conds))
    .orderBy(
      desc(sql`EXISTS (SELECT 1 FROM productImages pi WHERE pi.productId = ${products.id} AND pi.reviewStatus = 'APPROVED')`),
      desc(products.isFeatured),
      desc(products.id),
    )
    .limit(limit * 6);

  const availability = await loadVariantAvailability(
    db,
    branchId,
    unitRows.map((r) => Number(r.variantId)),
  );
  const inStockProductIds: number[] = [];
  const seen = new Set<number>();
  for (const r of unitRows) {
    const pid = Number(r.productId);
    if (seen.has(pid)) continue;
    const state = availability.get(Number(r.variantId));
    const available =
      state?.isService === true ||
      evaluateStorefrontUnitEligibility({
        isActive: true,
        isStoreSaleUnit: true,
        retailPrice: r.price,
        conversionFactor: r.conversionFactor,
        stockBase: state?.hasStockRow ? state.onHandBase : null,
        availableBase: state?.availableBase ?? 0,
      }).available;
    if (!available) continue;
    seen.add(pid);
    inStockProductIds.push(pid);
    if (inStockProductIds.length >= limit) break;
  }

  const hydrated = await loadRichProductsByIds(inStockProductIds);
  return hydrated.map(({ description: _d, numericPrice: _n, ...rest }) => rest);
}

/** يحمّل بايتات صور المنتجات المعتمدة (حتى 5 صور بالترتيب المحدد) للتعرّف البصري ولتوليد المشهد الجماعي. */
async function loadProductReferenceImages(
  productIds: number[],
): Promise<{ refs: Array<{ data: string; mimeType: string }>; names: string[] }> {
  const db = getDb();
  const cleanIds = Array.from(new Set(productIds.filter((id) => Number.isInteger(id) && id > 0))).slice(0, 5);
  if (!db || cleanIds.length === 0) return { refs: [], names: [] };

  const [prodRows, imgRows] = await Promise.all([
    db.select({ id: products.id, name: products.name }).from(products).where(inArray(products.id, cleanIds)),
    db
      .select({
        productId: productImages.productId,
        url: productImages.url,
        objectKey: productImages.objectKey,
        mime: productImages.mime,
        bytes: productImages.bytes,
        isPrimary: productImages.isPrimary,
        sortOrder: productImages.sortOrder,
      })
      .from(productImages)
      .where(and(inArray(productImages.productId, cleanIds), eq(productImages.reviewStatus, "APPROVED")))
      .orderBy(desc(productImages.isPrimary), asc(productImages.sortOrder)),
  ]);

  const nameById = new Map(prodRows.map((p) => [Number(p.id), p.name]));
  const primaryRowByProduct = new Map<number, (typeof imgRows)[number]>();
  for (const row of imgRows) {
    const pid = Number(row.productId);
    if (!primaryRowByProduct.has(pid)) primaryRowByProduct.set(pid, row);
  }

  const refs: Array<{ data: string; mimeType: string }> = [];
  const orderedNames: string[] = [];
  for (const pid of cleanIds) {
    const row = primaryRowByProduct.get(pid);
    if (!row) continue;
    try {
      if (row.objectKey) {
        const buf = await getImageStore().getBuffer(row.objectKey, row.bytes ?? 4 * 1024 * 1024);
        if (buf && buf.length > 0 && buf.length <= 4 * 1024 * 1024) {
          refs.push({
            data: buf.toString("base64"),
            mimeType: row.mime || "image/webp",
          });
          orderedNames.push(nameById.get(pid) ?? `منتج #${pid}`);
          continue;
        }
      }
      const decoded = decodeDataUrl(row.url);
      if (decoded && decoded.bytes.length <= 4 * 1024 * 1024) {
        refs.push({
          data: decoded.bytes.toString("base64"),
          mimeType: decoded.mime,
        });
        orderedNames.push(nameById.get(pid) ?? `منتج #${pid}`);
      }
    } catch (err) {
      logger.warn({ err, productId: pid }, "bannerAiStudio: skipped unreadable reference product image");
    }
  }

  return {
    refs,
    names: orderedNames.length > 0 ? orderedNames : cleanIds.map((id) => nameById.get(id) ?? `منتج #${id}`),
  };
}

/** يبني الحقائق الموثّقة للهدف ويسحب صوره وطبيعته من الجداول الحية. */
async function resolveBannerSourceFacts(input: GenerateBannerCopyInput): Promise<{
  facts: BannerCopySourceFacts;
  natureLabelAr: string;
  recommendedPresetId: BannerStudioPresetId;
  products: BannerStudioProductPreview[];
  selectedProductIds: number[];
}> {
  const db = getDb();
  const verifiedNumbers = new Set<string>();
  let subjectTitle = input.customTopic?.trim() || "تشكيلة مميزة من المكتبة العربية";
  let categoryName: string | null = null;
  let brandName: string | null = null;
  let subjectSummary: string | null = null;
  let priceBadgeText: string | null = null;
  let itemCount: number | undefined;
  let effectiveFrom: string | null = null;
  let effectiveTo: string | null = null;
  const explicitIds = Array.from(new Set((input.productIds ?? []).filter((n) => Number.isInteger(n) && n > 0))).slice(0, 6);
  let candidateProductIds = [...explicitIds];

  if (db && input.targetKind === "PROMOTION" && input.promotionId) {
    const [promo] = await db
      .select()
      .from(promotions)
      .where(eq(promotions.id, input.promotionId))
      .limit(1);
    if (promo) {
      subjectTitle = promo.name;
      effectiveFrom = promo.effectiveFrom instanceof Date ? promo.effectiveFrom.toISOString().slice(0, 10) : promo.effectiveFrom ? String(promo.effectiveFrom).slice(0, 10) : null;
      effectiveTo = promo.effectiveTo instanceof Date ? promo.effectiveTo.toISOString().slice(0, 10) : promo.effectiveTo ? String(promo.effectiveTo).slice(0, 10) : null;
      const summary = formatPromotionSummary({
        type: promo.type as PromotionType,
        discountPercent: promo.discountPercent,
        discountAmount: promo.discountAmount,
        maxDiscountAmount: promo.maxDiscountAmount,
        fixedPrice: promo.fixedPrice,
        bundlePrice: promo.bundlePrice,
        bundleMode: (promo.bundleMode as "ALL_REQUIRED" | "PICK_ANY_N" | null) ?? null,
        bundleQuantity: promo.bundleQuantity,
        bogoBuyQuantity: promo.bogoBuyQuantity,
        bogoGetQuantity: promo.bogoGetQuantity,
        bogoGetDiscountPercent: promo.bogoGetDiscountPercent,
        tieredMode: promo.tieredMode,
      });
      subjectSummary = promo.description?.trim() || summary;
      priceBadgeText = summary || null;

      for (const raw of [
        promo.discountPercent,
        promo.discountAmount,
        promo.fixedPrice,
        promo.bundlePrice,
        promo.bundleQuantity,
        promo.bogoBuyQuantity,
        promo.bogoGetQuantity,
        promo.minLineAmount,
      ]) {
        const n = Number(raw ?? 0);
        if (Number.isFinite(n) && n > 0) verifiedNumbers.add(String(n));
      }

      const tgts = await db
        .select({ productId: promotionTargets.productId, categoryId: promotionTargets.categoryId })
        .from(promotionTargets)
        .where(eq(promotionTargets.promotionId, promo.id))
        .limit(60);
      const tgtProductIds = tgts.map((t) => Number(t.productId ?? 0)).filter((n) => n > 0);
      const tgtCategoryIds = tgts.map((t) => Number(t.categoryId ?? 0)).filter((n) => n > 0);
      if (tgtProductIds.length > 0) {
        itemCount = tgtProductIds.length;
        if (candidateProductIds.length === 0) candidateProductIds = tgtProductIds.slice(0, 6);
      } else if (tgtCategoryIds.length > 0 && candidateProductIds.length === 0) {
        const catProds = await listBannerCandidateProducts({ categoryId: tgtCategoryIds[0]!, limit: 6 });
        candidateProductIds = catProds.map((p) => p.productId);
      } else if (candidateProductIds.length === 0) {
        const topProds = await listBannerCandidateProducts({ limit: 6 });
        candidateProductIds = topProds.map((p) => p.productId);
      }
    }
  } else if (db && input.targetKind === "CATEGORY" && input.categoryId) {
    const [cat] = await db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(eq(categories.id, input.categoryId))
      .limit(1);
    if (cat) {
      subjectTitle = cat.name;
      categoryName = cat.name;
      const [{ cnt }] = await db
        .select({ cnt: sql<number>`COUNT(*)` })
        .from(products)
        .where(and(eq(products.categoryId, cat.id), eq(products.isActive, true), eq(products.showInStore, true)));
      itemCount = Number(cnt ?? 0);
      if (candidateProductIds.length === 0) {
        const catProds = await listBannerCandidateProducts({ categoryId: Number(cat.id), limit: 6 });
        candidateProductIds = catProds.map((p) => p.productId);
      }
    }
  } else if (input.targetKind === "DEALS" && candidateProductIds.length === 0) {
    const topProds = await listBannerCandidateProducts({ limit: 4 });
    candidateProductIds = topProds.map((p) => p.productId);
  }

  const richProducts = await loadRichProductsByIds(candidateProductIds);
  if (input.targetKind === "PRODUCTS" && richProducts.length > 0 && !input.customTopic?.trim()) {
    const first = richProducts[0]!;
    categoryName = first.categoryName;
    brandName = first.brand;
    subjectSummary = first.description;
    if (richProducts.length === 1) {
      subjectTitle = first.name;
      priceBadgeText = first.priceText;
    } else {
      itemCount = richProducts.length;
      const sharedCat = richProducts.every((p) => p.categoryName && p.categoryName === first.categoryName)
        ? first.categoryName
        : null;
      const distinctCats = Array.from(
        new Set(richProducts.map((p) => p.categoryName).filter((c): c is string => Boolean(c))),
      );
      subjectTitle = sharedCat
        ? `مختارات ${sharedCat}`
        : distinctCats.length >= 2
          ? `باقة مختارة لـ ${distinctCats.slice(0, 2).join(" و")}`
          : `تشكيلة مختارة (${richProducts.length} أصناف)`;
      categoryName = sharedCat ?? "تشكيلة مختارة";
      subjectSummary = richProducts.map((p) => p.name).slice(0, 3).join(" · ");
      const minNum = Math.min(
        ...richProducts.map((p) => p.numericPrice ?? Number.POSITIVE_INFINITY),
      );
      if (Number.isFinite(minNum)) {
        priceBadgeText = `ابتداءً من ${fmtMoneyPlain(minNum)} د.ع`;
        verifiedNumbers.add(String(minNum));
      }
    }
  } else if (input.targetKind === "CATEGORY" && richProducts.length > 0 && !priceBadgeText) {
    const minNum = Math.min(
      ...richProducts.map((p) => p.numericPrice ?? Number.POSITIVE_INFINITY),
    );
    if (Number.isFinite(minNum)) {
      priceBadgeText = `ابتداءً من ${fmtMoneyPlain(minNum)} د.ع`;
      verifiedNumbers.add(String(minNum));
    }
  }

  for (const p of richProducts) {
    if (p.numericPrice && p.numericPrice > 0) {
      verifiedNumbers.add(String(p.numericPrice));
    }
  }

  const nature = inferBannerNatureAndPreset({
    targetKind: input.targetKind,
    title: subjectTitle,
    categoryName,
    description: subjectSummary ?? richProducts.map((p) => p.name).join(" "),
    brandName,
    hasDiscount: input.targetKind === "PROMOTION" || input.targetKind === "DEALS",
  });

  const ctaUrl = buildSafeBannerDestinationUrl({
    kind: input.targetKind,
    promotionId: input.promotionId ?? undefined,
    categoryId: input.categoryId ?? undefined,
    productIds: explicitIds.length > 0 ? explicitIds : candidateProductIds.slice(0, 3),
  });

  return {
    facts: {
      targetKind: input.targetKind,
      subjectTitle,
      categoryName,
      brandName,
      subjectSummary,
      priceBadgeText,
      verifiedNumbers: Array.from(verifiedNumbers),
      ctaUrl,
      itemCount,
      effectiveFrom,
      effectiveTo,
    },
    natureLabelAr: nature.natureLabelAr,
    recommendedPresetId: nature.recommendedPresetId,
    products: richProducts.map(({ description: _d, numericPrice: _n, ...rest }) => rest),
    selectedProductIds: (explicitIds.length > 0 ? explicitIds : candidateProductIds).slice(0, 4),
  };
}

const COPY_RESPONSE_SCHEMA = {
  type: "object",
  required: ["natureLabelAr", "recommendedPresetId", "variants"],
  properties: {
    natureLabelAr: { type: "string" },
    recommendedPresetId: {
      type: "string",
      enum: [...BANNER_STUDIO_PRESET_IDS],
    },
    variants: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        required: ["eyebrow", "headline", "subtitle", "ctaLabel"],
        properties: {
          eyebrow: { type: "string" },
          headline: { type: "string" },
          subtitle: { type: "string" },
          ctaLabel: { type: "string" },
        },
      },
    },
  },
};

/**
 * يسحب صور وحقائق المحدد، ويتعرّف بصرياً ودلالياً على طبيعة المنتج/الفئة (Vision + Facts)
 * ليقترح أنسب قالب وإضاءة و3 صياغات تسويقية مخصّصة ومنطقية.
 */
export async function generateBannerCopyForTarget(
  input: GenerateBannerCopyInput,
  actor: { userId: number; branchId?: number | null },
  fetchImpl: typeof fetch = fetch,
): Promise<GenerateBannerCopyOutput> {
  const {
    facts,
    natureLabelAr: baseNatureLabel,
    recommendedPresetId: basePresetId,
    products: targetProducts,
    selectedProductIds,
  } = await resolveBannerSourceFacts(input);
  const deterministic = buildDeterministicBannerCopyVariants(facts);

  const runtime = await getAiStudioRuntime();
  if (!runtime) {
    return {
      facts,
      natureLabelAr: baseNatureLabel,
      recommendedPresetId: basePresetId,
      variants: deterministic,
      products: targetProducts,
      aiUsed: false,
      aiFallbackReason: null,
    };
  }

  // إرفاق صور المنتجات الفعلية (حتى 3 صور) ليفحصها نموذج الرؤية البصرية Vision ويتعرّف على شكلها وطبيعتها
  const { refs: visionRefs } = await loadProductReferenceImages(selectedProductIds);

  const systemInstruction = `أنت مدير إبداعي وكاتب إعلانات متاجر إلكترونية محترف في العراق لـ«متجر المكتبة العربية»، ومقيّد بـ«حارس أمانة المنتج والنص»:
افحص صور المنتجات المرفقة (إن وجدت) وحقائق FACTS بدقة، وتعرّف على طبيعة المنتج/الفئة واستخدامها الفعلي وشكلها البصري:
1. حدّد وصفاً عربياً موجزاً لطبيعة المحدد في natureLabelAr (مثلاً: ملازم دراسية للسادس الإعدادي، حقائب لابتوب وتجهيزات رسمية، أدوات هندسية، ألوان ومرسم فني).
2. اختر أنسب قالب إضاءة وتدرج لوني في recommendedPresetId من القوالب العشرة المعتمدة حسب طبيعة المنتج ولونه.
3. اكتب 3 خيارات إعلانية مخصّصة منطقياً لهذا المنتج/الفئة بالذات (لا عبارات عامة جامدة):
   - eyebrow: شارة قصيرة تعبّر عن الفئة أو المناسبة (حتى 26 حرفاً).
   - headline: عنوان تسويقي جذاب يحافظ بأمانة تامة على اسم المنتج الحقيقي أو جوهر الفئة دون تحريف أو استبدال بصنف آخر (3 إلى 7 كلمات، حتى 50 حرفاً).
   - subtitle: سطر قيمة يشرح فائدة هذا المنتج تحديداً لجمهور العراق مع التوصيل (حتى 88 حرفاً).
   - ctaLabel: نص زرّ مناسب لطبيعة الهدف (2 إلى 3 كلمات).
قواعد حارس الأمانة غير القابلة للتفاوض:
- الأمانة الحرفية للمنتج: لا تغيّر اسم الماركة أو المرحلة الدراسية أو نوع المنتج المذكور في FACTS.subjectTitle أو FACTS.productNames، ولا تخلط بين فئة وأخرى.
- صفر هلوسة رقمية: يُمنع منعاً باتاً اختراع أي رقم سعر أو نسبة خصم أو عدد قطع غير موجود نصاً في FACTS.verifiedNumbers.
- بلا إيموجي وبلا تشكيل وبلا كشيدة وبأرقام لاتينية 0-9 فقط.`;

  const userParts: Array<Record<string, unknown>> = [];
  for (const ref of visionRefs) {
    userParts.push({ inline_data: { mime_type: ref.mimeType, data: ref.data } });
  }
  userParts.push({
    text: `FACTS:\n${JSON.stringify({
      targetKind: facts.targetKind,
      subjectTitle: facts.subjectTitle,
      categoryName: facts.categoryName,
      brandName: facts.brandName,
      productNames: targetProducts.slice(0, 4).map((p) => p.name),
      subjectSummary: facts.subjectSummary,
      priceBadgeText: facts.priceBadgeText,
      itemCount: facts.itemCount,
      verifiedNumbers: facts.verifiedNumbers,
      initialPresetHint: basePresetId,
    })}`,
  });

  const callModel = async (model: string) => {
    const url = `${GEMINI_CONTENT_BASE}/models/${encodeURIComponent(model)}:generateContent`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "x-goog-api-key": runtime.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: "user", parts: userParts }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: COPY_RESPONSE_SCHEMA,
          temperature: 0.5,
        },
      }),
      signal: AbortSignal.timeout(16_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  try {
    const rawJson = await runGuardedImageStudioCall({
      service: "AI",
      userId: actor.userId,
      branchId: actor.branchId ?? null,
      run: async () => {
        try {
          return await callModel(BANNER_COPY_MODEL);
        } catch {
          return await callModel(BANNER_COPY_FALLBACK_MODEL);
        }
      },
    });

    const rawText = rawJson?.candidates?.[0]?.content?.parts?.find(
      (p: { text?: string; thought?: boolean }) => !p?.thought && typeof p?.text === "string",
    )?.text;
    const parsed = rawText
      ? (JSON.parse(rawText) as {
          natureLabelAr?: string;
          recommendedPresetId?: BannerStudioPresetId;
          variants?: Array<Partial<BannerCopyVariant>>;
        })
      : null;

    const verifiedVariants: BannerCopyVariant[] = [];
    for (const candidate of parsed?.variants ?? []) {
      const check = validateBannerMarketingCopy(candidate, facts);
      if (check.ok) verifiedVariants.push(check.sanitized);
    }

    const aiPreset =
      parsed?.recommendedPresetId && BANNER_STUDIO_PRESETS[parsed.recommendedPresetId]
        ? parsed.recommendedPresetId
        : basePresetId;
    const aiNatureLabel = parsed?.natureLabelAr?.trim().slice(0, 60) || baseNatureLabel;

    for (const fallback of deterministic) {
      if (verifiedVariants.length >= 3) break;
      verifiedVariants.push(fallback);
    }

    return {
      facts,
      natureLabelAr: aiNatureLabel,
      recommendedPresetId: aiPreset,
      variants: verifiedVariants.slice(0, 3),
      products: targetProducts,
      aiUsed: true,
      aiFallbackReason: null,
    };
  } catch (err) {
    logger.warn({ err, userId: actor.userId }, "bannerAiStudio.generateCopy: fell back to deterministic nature & copy");
    return {
      facts,
      natureLabelAr: baseNatureLabel,
      recommendedPresetId: basePresetId,
      variants: deterministic,
      products: targetProducts,
      aiUsed: false,
      aiFallbackReason: null,
    };
  }
}

export interface GenerateBannerSceneInput {
  presetId: BannerStudioPresetId;
  placement: StudioBannerPlacement;
  model?: BannerSceneModel | null;
  productIds?: number[];
  customHint?: string | null;
  lightingMode?: BannerLightingMode;
  sceneMode?: "FULL_SCENE" | "STAGE_BACKDROP";
}

export interface GenerateBannerSceneOutput {
  sceneDataUrl: string;
  modelUsed: string;
  presetId: BannerStudioPresetId;
}

/** يولّد مشهد الخلفية والإضاءة عبر Gemini Nano Banana مع التراجع الآلي للنموذج الاحتياطي. */
export async function generateBannerSceneBackdrop(
  input: GenerateBannerSceneInput,
  actor: { userId: number; branchId?: number | null },
  fetchImpl?: typeof fetch,
): Promise<GenerateBannerSceneOutput> {
  if (!BANNER_STUDIO_PRESETS[input.presetId]) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "قالب التصميم غير معروف",
        why: "معرّف القالب المختار خارج قائمة القوالب المعتمدة",
        doThis: "اختر أحد القوالب المعتمدة في مركز التصميم ثم أعد المحاولة",
      }),
    });
  }

  const runtime = await getAiStudioRuntime();
  if (!runtime) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "مزود التصوير الإعلاني الخارجي غير مفعّل حالياً",
        why: "لم يتم تفعيل مفتاح مزود استوديو الصور المعتمد في شاشة التكاملات",
        doThis: "استعمل وضع «إخراج استوديو Apple التحريري» الجاهز الآن، أو فعّل مفتاح المزود من شاشة التكاملات",
      }),
    });
  }

  const isStageOnly = input.sceneMode === "STAGE_BACKDROP";
  const { refs, names } = isStageOnly
    ? { refs: [] as Array<{ data: string; mimeType: string }>, names: [] as string[] }
    : await loadProductReferenceImages(input.productIds ?? []);
  const prompt = buildAiBannerScenePrompt({
    presetId: input.presetId,
    placement: input.placement,
    productNames: names,
    customHint: input.customHint,
    hasReferenceImages: refs.length > 0,
    referenceCount: refs.length,
    lightingMode: input.lightingMode,
    sceneMode: input.sceneMode ?? "FULL_SCENE",
  });

  // ربط مباشر بنموذج المزود المعتمد المضبوط في إعدادات النظام مع سلسلة بدائل رسمية مضمونة
  const primaryModel = runtime.model || input.model || DEFAULT_BANNER_SCENE_MODEL;
  const candidateModels = Array.from(
    new Set([primaryModel, input.model ?? DEFAULT_BANNER_SCENE_MODEL, FALLBACK_BANNER_SCENE_MODEL, "gemini-3.1-flash-lite-image"]),
  );

  const tryGenerate = async (model: string, includeImageConfig: boolean) =>
    generateStudioImage(
      {
        apiKey: runtime.apiKey,
        model,
        prompt,
        referenceImages: refs,
        aspectRatioEnum: "ASPECT_RATIO_SIXTEEN_BY_NINE",
      },
      {
        fetchImpl,
        includeImageConfig,
        timeoutMs: 28_000,
        runAttempt: (run) =>
          runGuardedImageStudioCall({
            service: "AI",
            userId: actor.userId,
            branchId: actor.branchId ?? null,
            run,
          }),
      },
    );

  try {
    let result: { imageBase64: string; mimeType: string } | null = null;
    let modelUsed: string = primaryModel;
    let lastError: unknown = null;

    for (const candidateModel of candidateModels) {
      modelUsed = candidateModel;
      try {
        result = await tryGenerate(candidateModel, true);
        break;
      } catch (err) {
        lastError = err;
        if (err instanceof AiImageError && err.kind === "BAD_INPUT") {
          try {
            result = await tryGenerate(candidateModel, false);
            break;
          } catch (errNoCfg) {
            lastError = errNoCfg;
          }
        }
        if (
          err instanceof AiImageError &&
          (err.status === 404 || err.kind === "BAD_INPUT" || err.kind === "SERVICE" || err.kind === "NO_IMAGE")
        ) {
          continue;
        }
        throw err;
      }
    }

    if (!result) {
      throw lastError ?? new Error("تعذر إنتاج مشهد الخلفية من المزود المعتمد");
    }

    return {
      sceneDataUrl: `data:${result.mimeType};base64,${result.imageBase64}`,
      modelUsed,
      presetId: input.presetId,
    };
  } catch (err) {
    if (err instanceof ImageStudioGuardError) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: appErrorMessage({
          what: imageStudioGuardErrorMessageAr(err.kind),
          why: "يوجد طلب معالجة صورية قيد التنفيذ حالياً",
          doThis: "انتظر بضع ثوانٍ ثم اضغط توليد المشهد مرة أخرى، أو استعمل الوضع الفوري",
        }),
      });
    }
    if (err instanceof AiImageError) {
      throw new TRPCError({
        code: err.kind === "QUOTA" ? "TOO_MANY_REQUESTS" : err.kind === "AUTH" ? "PRECONDITION_FAILED" : "BAD_REQUEST",
        message: appErrorMessage({
          what: aiImageErrorMessageAr(err.kind),
          why: err.message.slice(0, 180),
          doThis: "جرّب صياغة ملاحظة إضاءة أبسط أو انتقل بنقرة واحدة إلى وضع «الاستوديو الفوري»",
        }),
      });
    }
    throw err;
  }
}
