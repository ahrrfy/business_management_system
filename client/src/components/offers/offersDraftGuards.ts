/**
 * client/src/components/offers/offersDraftGuards.ts
 *
 * Pure rule-transition guards (clearing hidden caps on type switches) and
 * paginated whole-category pull helpers with explicit truncation detection.
 */

import { normalizeBarcodeScannerInput } from "@shared/barcodeScanner";
import { MAX_PROMOTION_TARGETS } from "@shared/promotionEngine";
import {
  buildOfferItemFromSearchProduct,
  sanitizeRuleTiers,
} from "./offersMultiRuleHelpers";
import type { OfferRuleDraft, SelectedOfferItem } from "./offersTypes";

/**
 * Applies a partial patch to an OfferRuleDraft while clearing `maxDiscountAmount`
 * whenever switching to an offer type whose form does not expose the cap input.
 */
export function applyOfferRuleDraftPatch(
  prev: OfferRuleDraft,
  patch: Partial<OfferRuleDraft>,
): OfferRuleDraft {
  const next: OfferRuleDraft = { ...prev, ...patch };
  if (patch.type !== undefined && patch.type !== prev.type && patch.type !== "PERCENT") {
    next.maxDiscountAmount = "";
  }
  return next;
}

/**
 * Serializes rule-specific value fields for API submission, ensuring `maxDiscountAmount`
 * is only sent for `PERCENT` rules (where the UI exposes and edits it).
 */
export function buildRulePayloadCore(r: OfferRuleDraft) {
  return {
    type: r.type,
    discountPercent: r.type === "PERCENT" ? r.discountPercent : undefined,
    discountAmount: r.type === "AMOUNT" ? r.discountAmount : undefined,
    maxDiscountAmount: r.type === "PERCENT" ? r.maxDiscountAmount || null : null,
    fixedPrice: r.type === "FIXED_PRICE" ? r.fixedPrice : undefined,
    bundlePrice: r.type === "BUNDLE_PRICE" ? r.bundlePrice : undefined,
    bundleMode: r.type === "BUNDLE_PRICE" ? r.bundleMode : undefined,
    bundleQuantity:
      r.type === "BUNDLE_PRICE" && r.bundleMode === "PICK_ANY_N" ? r.bundleQuantity : undefined,
    bogoBuyQuantity: r.type === "BOGO" ? r.bogoBuyQuantity : undefined,
    bogoGetQuantity: r.type === "BOGO" ? r.bogoGetQuantity : undefined,
    bogoGetDiscountPercent: r.type === "BOGO" ? r.bogoGetDiscountPercent : undefined,
    tieredMode: r.type === "TIERED_QTY" ? r.tieredMode : undefined,
    tiers: sanitizeRuleTiers(r),
  };
}

export async function pullCategorySearchPages<T extends { variantId: number }>(opts: {
  categoryId: number;
  fetchPage: (args: { categoryId: number; limit: number; offset: number }) => Promise<T[]>;
  pageSize?: number;
  maxPages?: number;
}): Promise<{ rows: T[]; truncated: boolean }> {
  const pageSize = opts.pageSize ?? 500;
  const maxPages = opts.maxPages ?? Math.max(1, Math.ceil(MAX_PROMOTION_TARGETS / pageSize));
  const { categoryId, fetchPage } = opts;
  const rows: T[] = [];
  const seenVariantIds = new Set<number>();

  for (let pageIdx = 0; pageIdx < maxPages; pageIdx++) {
    const offset = pageIdx * pageSize;
    const page = await fetchPage({ categoryId, limit: pageSize, offset });
    let addedInPage = 0;
    for (const item of page) {
      const vid = Number(item.variantId);
      if (!seenVariantIds.has(vid)) {
        seenVariantIds.add(vid);
        rows.push(item);
        addedInPage++;
      }
    }
    if (page.length < pageSize) {
      return { rows, truncated: false };
    }
    if (pageIdx > 0 && addedInPage === 0) {
      return { rows, truncated: true };
    }
  }

  const probe = await fetchPage({
    categoryId,
    limit: 1,
    offset: maxPages * pageSize,
  });
  const hasUnseenOverflow = probe.some((p) => !seenVariantIds.has(Number(p.variantId)));
  return { rows, truncated: probe.length > 0 && hasUnseenOverflow };
}

export function capOfferItemsToTargetLimit(
  candidateItems: SelectedOfferItem[],
  currentSelectedCount: number,
  maxTargets: number = MAX_PROMOTION_TARGETS,
): {
  acceptedItems: SelectedOfferItem[];
  droppedCount: number;
  limitReachedNotice: string | null;
} {
  const remainingSlots = Math.max(0, maxTargets - Math.max(0, currentSelectedCount));
  if (candidateItems.length <= remainingSlots) {
    return { acceptedItems: candidateItems, droppedCount: 0, limitReachedNotice: null };
  }
  const acceptedItems = candidateItems.slice(0, remainingSlots);
  const droppedCount = candidateItems.length - acceptedItems.length;
  const limitReachedNotice =
    acceptedItems.length === 0
      ? `وصل جدول العرض للحد الأقصى المسموح (${maxTargets} مادة) ولم تُضف مواد جديدة — لشمول قسم كبير بالكامل اختر نطاق «أقسام محددة».`
      : `تمت إضافة ${acceptedItems.length} مادة فقط للوصول للحد الأقصى المسموح بالعرض (${maxTargets} مادة)، واستُبعدت ${droppedCount} مادة إضافية — لشمول قسم كبير بالكامل اختر نطاق «أقسام محددة».`;
  return { acceptedItems, droppedCount, limitReachedNotice };
}

export function resolveCategoryPullOutcome(opts: {
  fetchedRows: any[];
  truncated: boolean;
  existingVariantIds: ReadonlySet<number>;
  catName: string;
  currentSelectedCount?: number;
  maxTargets?: number;
}): { itemsToAdd: SelectedOfferItem[]; notice: string; tone: "pos" | "warn" } {
  const {
    fetchedRows,
    truncated,
    existingVariantIds,
    catName,
    currentSelectedCount = 0,
    maxTargets = MAX_PROMOTION_TARGETS,
  } = opts;
  const rawItemsToAdd = fetchedRows
    .filter((p) => !existingVariantIds.has(Number(p.variantId)))
    .map((p) => buildOfferItemFromSearchProduct(p))
    .filter((x): x is SelectedOfferItem => x != null);

  const { acceptedItems: itemsToAdd, droppedCount, limitReachedNotice } =
    capOfferItemsToTargetLimit(rawItemsToAdd, currentSelectedCount, maxTargets);

  if (droppedCount > 0 && limitReachedNotice) {
    return {
      itemsToAdd,
      tone: "warn",
      notice: limitReachedNotice,
    };
  }

  if (truncated) {
    if (itemsToAdd.length > 0) {
      return {
        itemsToAdd,
        tone: "warn",
        notice: `تم سحب ${itemsToAdd.length} مادة من فئة «${catName}» حتى السقف الأقصى المسموح للعرض (${maxTargets} مادة) — بقيت أصناف أخرى في الفئة لم تُسحب؛ استعمل مستعرض الإضافة المتعددة لاختيار مواد بعينها أو اختر نطاق «أقسام محددة» لشمول الفئة كاملة.`,
      };
    }
    return {
      itemsToAdd: [],
      tone: "warn",
      notice: `أول ${fetchedRows.length} صنف من فئة «${catName}» مضافة مسبقاً، لكن الفئة تضم أصنافاً إضافية تتجاوز سقف العرض (${maxTargets} مادة)؛ استعمل مستعرض الإضافة المتعددة لاختيار مواد بعينها أو اختر نطاق «أقسام محددة» لشمول الفئة كاملة.`,
    };
  }

  if (itemsToAdd.length > 0) {
    return {
      itemsToAdd,
      tone: "pos",
      notice: `تم سحب ${itemsToAdd.length} مادة من فئة «${catName}» إلى الجدول (يمكنك استثناء أي مادة بحذفها).`,
    };
  }
  return {
    itemsToAdd: [],
    tone: "pos",
    notice: "جميع مواد هذه الفئة مضافة مسبقاً في الجدول أو الفئة فارغة.",
  };
}

export function resolveBulkPasteOutcome(opts: {
  tokens: string[];
  matchedProducts: any[];
  existingVariantIds: ReadonlySet<number>;
  currentSelectedCount?: number;
  maxTargets?: number;
}): {
  itemsToAdd: SelectedOfferItem[];
  unmatchedCodes: string[];
  summary: string;
  tone: "pos" | "warn";
  capped: boolean;
} {
  const {
    tokens,
    matchedProducts,
    existingVariantIds,
    currentSelectedCount = 0,
    maxTargets = MAX_PROMOTION_TARGETS,
  } = opts;
  const candidateItems: SelectedOfferItem[] = [];
  const seenNewVariants = new Set<number>();
  let duplicateCount = 0;
  const unmatchedCodes: string[] = [];

  for (const tok of tokens) {
    const normTok = normalizeBarcodeScannerInput(tok).toLowerCase();
    const rawLower = tok.toLowerCase();
    const found = matchedProducts.find((p: any) => {
      if (
        String(p.sku ?? "").toLowerCase() === rawLower ||
        String(p.sku ?? "").toLowerCase() === normTok
      ) {
        return true;
      }
      return (p.units ?? []).some((u: any) => {
        if (u.barcode && normalizeBarcodeScannerInput(String(u.barcode)).toLowerCase() === normTok) {
          return true;
        }
        if (Array.isArray(u.altBarcodes)) {
          return u.altBarcodes.some(
            (alt: string) => normalizeBarcodeScannerInput(String(alt)).toLowerCase() === normTok,
          );
        }
        return false;
      });
    });

    if (!found) {
      unmatchedCodes.push(tok);
      continue;
    }
    if (existingVariantIds.has(found.variantId) || seenNewVariants.has(found.variantId)) {
      duplicateCount++;
      continue;
    }
    const item = buildOfferItemFromSearchProduct(found, tok);
    if (item) {
      seenNewVariants.add(found.variantId);
      candidateItems.push(item);
    }
  }

  const { acceptedItems, droppedCount, limitReachedNotice } = capOfferItemsToTargetLimit(
    candidateItems,
    currentSelectedCount,
    maxTargets,
  );
  const parts = [
    droppedCount > 0 && limitReachedNotice
      ? limitReachedNotice
      : `تمت إضافة ${acceptedItems.length} مادة بنجاح`,
  ];
  if (duplicateCount > 0) parts.push(`${duplicateCount} مضافة مسبقاً`);
  if (unmatchedCodes.length > 0) {
    parts.push(
      `${unmatchedCodes.length} لم يُعثر عليها (${unmatchedCodes.slice(0, 5).join("، ")}${
        unmatchedCodes.length > 5 ? "…" : ""
      })`,
    );
  }
  return {
    itemsToAdd: acceptedItems,
    unmatchedCodes,
    summary: parts.join(" • "),
    tone: droppedCount > 0 ? "warn" : "pos",
    capped: droppedCount > 0,
  };
}
