import Decimal from "decimal.js";
import {
  createPostingIntent,
  signedPostingLines,
  type PostingIntent,
  type PostingProfile,
  type PostingSourceComponents,
} from "../accounting/postingEngine";
import { money, round2, type DecimalInput } from "../money";

export interface GiftPostingClassification {
  intent: PostingIntent;
  sourceComponents?: PostingSourceComponents;
  consignmentRemainder: Decimal;
}

/**
 * Classify one operational GIFT_OUT without duplicating the consignor liability leg.
 * `totalCost` is the source accountingEntry cost; `ownedCost` is the part backed by
 * our inventory. Reversals pass `direction=-1` and stay free of negative line values.
 */
export function classifyGiftPosting(
  totalCost: DecimalInput,
  ownedCost: DecimalInput,
  direction: 1 | -1,
): GiftPostingClassification {
  const total = round2(money(totalCost));
  const owned = round2(money(ownedCost));
  if (total.lte(0) || owned.lt(0) || owned.gt(total)) {
    throw new Error(
      "تصنيف GIFT_OUT غير صالح: يجب أن تكون 0 ≤ ownedCost ≤ totalCost وأن يكون الإجمالي موجباً",
    );
  }
  const consignmentRemainder = round2(total.minus(owned));
  const profile: PostingProfile = owned.isZero()
    ? "GIFT_OUT_CONSIGNMENT_MEMO"
    : consignmentRemainder.gt(0)
      ? "GIFT_OUT_MIXED_PROMO"
      : "GIFT_OUT_PROMO";
  const signedOwned = direction === 1 ? owned : owned.neg();
  const lines = owned.isZero()
    ? []
    : signedPostingLines("GIFTS_PROMO", "INVENTORY", signedOwned);
  const sourceComponents: PostingSourceComponents | undefined =
    profile === "GIFT_OUT_MIXED_PROMO"
      ? direction === 1
        ? {
            roleDebits: { GIFTS_PROMO: owned },
            roleCredits: { INVENTORY: owned },
          }
        : {
            roleDebits: { INVENTORY: owned },
            roleCredits: { GIFTS_PROMO: owned },
          }
      : undefined;

  return {
    intent: createPostingIntent(profile, "GIFT_OUT", lines, sourceComponents),
    sourceComponents,
    consignmentRemainder,
  };
}
