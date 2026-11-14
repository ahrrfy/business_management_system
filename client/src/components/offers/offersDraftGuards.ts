/**
 * client/src/components/offers/offersDraftGuards.ts
 *
 * Pure rule-transition guards (clearing hidden caps on type switches) and
 * paginated whole-category pull helpers with explicit truncation detection.
 */

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
  const { categoryId, fetchPage, pageSize = 500, maxPages = 20 } = opts;
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

export function resolveCategoryPullOutcome(opts: {
  fetchedRows: any[];
  truncated: boolean;
  existingVariantIds: ReadonlySet<number>;
  catName: string;
}): { itemsToAdd: SelectedOfferItem[]; notice: string; tone: "pos" | "warn" } {
  const { fetchedRows, truncated, existingVariantIds, catName } = opts;
  const itemsToAdd = fetchedRows
    .filter((p) => !existingVariantIds.has(Number(p.variantId)))
    .map((p) => buildOfferItemFromSearchProduct(p))
    .filter((x): x is SelectedOfferItem => x != null);

  if (truncated) {
    if (itemsToAdd.length > 0) {
      return {
        itemsToAdd,
        tone: "warn",
        notice: `تم سحب ${itemsToAdd.length} مادة من فئة «${catName}» حتى السقف الأقصى للسحب الدفعي (${fetchedRows.length} صنف) — بقيت أصناف أخرى في الفئة لم تُسحب؛ استخدم «مستعرض الإضافة المتعددة» أو اختر نطاق «أقسام محددة» لشمول الفئة كاملة.`,
      };
    }
    return {
      itemsToAdd: [],
      tone: "warn",
      notice: `أول ${fetchedRows.length} صنف من فئة «${catName}» مضافة مسبقاً، لكن الفئة تضم أصنافاً إضافية تتجاوز سقف السحب الدفعي؛ استخدم «مستعرض الإضافة المتعددة» أو نطاق «أقسام محددة» لشمول الفئة كاملة.`,
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
