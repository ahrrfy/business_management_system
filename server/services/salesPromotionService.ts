// promotions v2 (٨/٧/٢٦، بعد gstack-review PR #163): إدارة العروض + حلّ العرض في pos.ts.
//
// فلسفة v2: «نقطة العرض = نقطة الفرض» — pos.ts (`applyPromotions`) يستدعي `resolvePromotionForLine`
// كي يعرض للـPOS السعر المخصوم مباشرةً. sale/create.ts يتحقّق فقط (idempotent) أن الخصم المُرسَل
// من العميل يطابق الحلّ الخادمي — لا يعيد الحساب من الصفر. هذا يمنع B2 (فائض Z-report من عدم تطابق
// السعر المعروض مع السعر المُسجَّل خادمياً).
//
// الفوارق عن الإصدار المسحوب:
//   - B8: مقارنة التاريخ بحبيبة اليوم المحلي (localDayStart) لا datetime — «آخر يوم» يعمل والتشغيل
//     ليومٍ واحد يعمل. نستعمل `Y-M-D` string comparison لأن effectiveFrom/To نوعُهما DATE.
//   - B11: `minLineAmount` NOT NULL على مستوى المخطّط + الخدمة تُعامل NULL كصفر دفاعاً.
//   - Contract-price wins: الاستدعاء من pos.ts يمرّر hasContractPrice ⇒ نعود null فوراً.
//   - manager scoping للراوتر (في promotionsRouter): يفرض branchId من ctx للـnon-admin.
import { TRPCError } from "@trpc/server";
import { canonicalizeBarcodeInput } from "@shared/barcodeNormalize";
import { appErrorMessage } from "@shared/errors";
import { normalizeSearchText } from "@shared/searchNormalize";
import Decimal from "decimal.js";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  invoiceItems,
  invoices,
  productPrices,
  productUnitBarcodes,
  productUnits,
  productVariants,
  products,
  promotionTargets,
  promotionTiers,
  promotions,
} from "../../drizzle/schema";
import {
  MAX_PROMOTION_TARGETS,
  type PromotionRule,
  type TierRule,
} from "../../shared/promotionEngine";
import { isPromotionActiveOnDay } from "../../shared/promotionScheduling";
import type { Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { loadBundleUnitCosts } from "./bundleService";
import { DecimalInput, money, round2, toDbMoney } from "./money";
import type { PriceTier } from "./pricing";

export type SalesPromotionType =
  | "PERCENT"
  | "AMOUNT"
  | "FIXED_PRICE"
  | "BUNDLE_PRICE"
  | "BOGO"
  | "TIERED_QTY"
  | "FREE_SHIPPING";
export type SalesPromotionScope = "ALL" | "CATEGORIES" | "PRODUCTS";
export type SalesPromotionChannel = "ALL" | "POS_ONLY" | "STORE_ONLY";

export interface PromotionTargetInput {
  categoryId?: number | null;
  productId?: number | null;
  variantId?: number | null;
  productUnitId?: number | null;
}

export interface PromotionTierInput {
  minQuantity: string;
  tierType: "PERCENT" | "AMOUNT" | "FIXED_PRICE";
  discountPercent?: string;
  discountAmount?: string;
  fixedPrice?: string;
}

export interface CreatePromotionInput {
  campaignId?: number | null;
  name: string;
  description?: string | null;
  type: SalesPromotionType;
  discountPercent?: string;
  discountAmount?: string;
  maxDiscountAmount?: string | null;
  minOrderSpend?: string;
  freeShipping?: boolean;
  shippingDiscountAmount?: string;
  scope: SalesPromotionScope;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo?: string | null;
  customerTier?: PriceTier | null;
  branchId?: number | null;
  minLineAmount?: string;
  priority?: number;
  targets?: PromotionTargetInput[];
  channel?: SalesPromotionChannel | "POS" | "STORE";
  /** 0073: true = عرض متجر إلكترونيّ (أونلاين فقط — يُستثنى من تسعير الكاشير). افتراضي false. */
  isStoreManaged?: boolean;
  /** AUTO يُحلّ تلقائياً؛ COUPON لا يدخل التسعير إلا بعد تحقق الكوبون داخل معاملة البيع. */
  applicationMode?: "AUTO" | "COUPON";
  allowBelowCost?: boolean;
  applyToBaseUnitOnly?: boolean;
  activeDays?: number[] | null;
  // Type-specific values
  fixedPrice?: string;
  bundlePrice?: string;
  bundleMode?: "ALL_REQUIRED" | "PICK_ANY_N";
  bundleQuantity?: number;
  bogoBuyQuantity?: number;
  bogoGetQuantity?: number;
  bogoGetDiscountPercent?: string;
  tieredMode?: "PER_ITEM" | "POOL_ACROSS_TARGETS";
  tiers?: PromotionTierInput[];
}

function assertShape(input: CreatePromotionInput) {
  switch (input.type) {
    case "PERCENT": {
      const p = money(input.discountPercent ?? "0");
      if (!p.gt(0) || p.gt(100)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "نسبة الخصم غير صالحة",
            why: `نسبة الخصم (${p.toString()}%) يجب أن تكون أكبر من 0 وأقل من أو تساوي 100`,
            doThis: "أدخل نسبة صحيحة بين 1 و100",
          }),
        });
      }
      if (input.discountAmount && money(input.discountAmount).gt(0)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعارض في نوع الخصم",
            why: "عرض النسبة المئوية لا يقبل تحديد مبلغ ثابت",
            doThis: "احذف قيمة المبلغ الثابت أو غيّر نوع العرض إلى مبلغ ثابت",
          }),
        });
      }
      if (input.maxDiscountAmount != null && input.maxDiscountAmount !== "") {
        const cap = money(input.maxDiscountAmount);
        if (cap.lt(0)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "سقف الخصم الأقصى غير صالح",
              why: "سقف الخصم الأقصى يجب ألا يكون سالباً",
              doThis: "أدخل مبلغ سقف خصم موجب أو اتركه فارغاً",
            }),
          });
        }
      }
      break;
    }
    case "AMOUNT": {
      const a = money(input.discountAmount ?? "0");
      if (a.lt(0) || (!a.gt(0) && !input.freeShipping)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "مبلغ الخصم غير صالح",
            why: "المبلغ الثابت للخصم يجب أن يكون أكبر من صفر",
            doThis: "أدخل مبلغ خصم أكبر من صفر",
          }),
        });
      }
      if (input.discountPercent && money(input.discountPercent).gt(0)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعارض في نوع الخصم",
            why: "عرض المبلغ الثابت لا يقبل تحديد نسبة مئوية",
            doThis: "احذف النسبة المئوية أو غيّر نوع العرض إلى نسبة مئوية",
          }),
        });
      }
      break;
    }
    case "FIXED_PRICE": {
      if (!input.fixedPrice || !money(input.fixedPrice).gt(0)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "السعر الموحد غير صالح",
            why: "السعر الموحد للسلعة يجب أن يكون أكبر من صفر",
            doThis: "أدخل سعراً موحداً صالحاً أكبر من صفر",
          }),
        });
      }
      break;
    }
    case "BUNDLE_PRICE": {
      if (!input.bundlePrice || !money(input.bundlePrice).gt(0)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "سعر الباقة غير صالح",
            why: "سعر الباقة الإجمالي يجب أن يكون أكبر من صفر",
            doThis: "أدخل سعر باقة إجمالي صالح أكبر من صفر",
          }),
        });
      }
      if (!input.bundleMode || !["ALL_REQUIRED", "PICK_ANY_N"].includes(input.bundleMode)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "نمط الباقة غير صالح",
            why: "نمط الباقة يجب أن يكون إما كل المواد مطلوبة أو اختر أي ن من المواد",
            doThis: "اختر نمط باقة معتمد (ALL_REQUIRED أو PICK_ANY_N)",
          }),
        });
      }
      if (input.bundleMode === "PICK_ANY_N" && (!input.bundleQuantity || input.bundleQuantity < 1)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "كمية الباقة غير محددة",
            why: "نمط اختر أي ن يتطلب تحديد كمية الباقة أكبر من أو تساوي 1",
            doThis: "حدد كمية المواد المطلوبة للباقة (1 أو أكثر)",
          }),
        });
      }
      break;
    }
    case "BOGO": {
      if (!input.bogoBuyQuantity || input.bogoBuyQuantity < 1) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "كمية الشراء غير صالحة",
            why: "كمية الشراء المطلوبة لعرض BOGO يجب أن تكون 1 أو أكثر",
            doThis: "أدخل كمية شراء صحيحة تبدأ من 1",
          }),
        });
      }
      if (!input.bogoGetQuantity || input.bogoGetQuantity < 1) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "كمية التخفيض غير صالحة",
            why: "كمية المواد المخفضة/المجانية في عرض BOGO يجب أن تكون 1 أو أكثر",
            doThis: "أدخل كمية مواد مخفضة صحيحة تبدأ من 1",
          }),
        });
      }
      const getPct = money(input.bogoGetDiscountPercent ?? "0");
      if (!getPct.gt(0) || getPct.gt(100)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "نسبة خصم المادة الإضافية غير صالحة",
            why: "نسبة خصم مادة BOGO يجب أن تكون بين 1% و100%",
            doThis: "أدخل نسبة خصم بين 1 و100 (مثلاً 100% لمجاني، أو 50% لنصف السعر)",
          }),
        });
      }
      break;
    }
    case "TIERED_QTY": {
      if (!input.tieredMode || !["PER_ITEM", "POOL_ACROSS_TARGETS"].includes(input.tieredMode)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "نمط الشرائح غير صالح",
            why: "نمط الشرائح يجب أن يكون لكل مادة منفصلة أو مجمعاً عبر المواد",
            doThis: "اختر PER_ITEM أو POOL_ACROSS_TARGETS",
          }),
        });
      }
      if (!input.tiers || input.tiers.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "شرائح الكميات فارغة",
            why: "عرض الكميات المتعددة يتطلب تعريف شريحة كمية واحدة على الأقل",
            doThis: "أضف شريحة كمية واحدة أو أكثر",
          }),
        });
      }
      for (const tier of input.tiers) {
        const minQ = money(tier.minQuantity);
        if (!minQ.gt(0)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "كمية الشريحة غير صالحة",
              why: "الحد الأدنى لكمية تفعيل الشريحة يجب أن يكون أكبر من صفر",
              doThis: "أدخل كمية تفعيل صحيحة للشريحة أكبر من صفر",
            }),
          });
        }
        if (tier.tierType === "PERCENT") {
          const p = money(tier.discountPercent ?? "0");
          if (!p.gt(0) || p.gt(100)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: appErrorMessage({
                what: "نسبة خصم الشريحة غير صالحة",
                why: "نسبة خصم الشريحة يجب أن تكون بين 1 و100%",
                doThis: "أدخل نسبة خصم صالحة للشريحة",
              }),
            });
          }
        } else if (tier.tierType === "AMOUNT") {
          const a = money(tier.discountAmount ?? "0");
          if (!a.gt(0)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: appErrorMessage({
                what: "مبلغ خصم الشريحة غير صالح",
                why: "مبلغ الخصم الثابت للشريحة يجب أن يكون أكبر من صفر",
                doThis: "أدخل مبلغ خصم صالح للشريحة",
              }),
            });
          }
        } else if (tier.tierType === "FIXED_PRICE") {
          if (!tier.fixedPrice || !money(tier.fixedPrice).gt(0)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: appErrorMessage({
                what: "السعر الموحد للشريحة غير صالح",
                why: "السعر الموحد للشريحة يجب أن يكون أكبر من صفر",
                doThis: "أدخل سعراً موحداً صالحاً للشريحة أكبر من صفر",
              }),
            });
          }
        }
      }
      break;
    }
    case "FREE_SHIPPING": {
      break;
    }
    default:
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "نوع العرض غير معروف",
          why: "نوع العرض المدخل غير مدعوم في النظام",
          doThis: "اختر أحد أنواع العروض السبعة المعتمدة",
        }),
      });
  }

  if (input.minOrderSpend != null && input.minOrderSpend !== "") {
    const minSpend = money(input.minOrderSpend);
    if (minSpend.lt(0)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "الحد الأدنى لقيمة الطلب غير صالح",
          why: "الحد الأدنى المطلوب لتفعيل العرض يجب ألا يكون سالباً",
          doThis: "أدخل مبلغاً غير سالب أو اتركه صفراً",
        }),
      });
    }
  }
}

function assertDates(input: CreatePromotionInput) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "صيغة تاريخ البدء غير صالحة",
        why: `التاريخ المدخل (${input.effectiveFrom}) لا يطابق صيغة YYYY-MM-DD`,
        doThis: "أدخل تاريخ البدء بصيغة YYYY-MM-DD (مثال: 2026-07-15)",
      }),
    });
  }
  if (input.effectiveTo) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveTo)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "صيغة تاريخ الانتهاء غير صالحة",
          why: `التاريخ المدخل (${input.effectiveTo}) لا يطابق صيغة YYYY-MM-DD`,
          doThis: "أدخل تاريخ الانتهاء بصيغة YYYY-MM-DD",
        }),
      });
    }
    if (input.effectiveTo < input.effectiveFrom) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعارض في نطاق التواريخ",
          why: `تاريخ الانتهاء (${input.effectiveTo}) يسبق تاريخ البدء (${input.effectiveFrom})`,
          doThis: "اجعل تاريخ الانتهاء لاحقاً لتاريخ البدء أو مساوياً له",
        }),
      });
    }
  }
}

function assertTargets(input: CreatePromotionInput) {
  if (input.scope === "ALL") {
    if (
      input.type === "BUNDLE_PRICE" &&
      (input.bundleMode ?? "ALL_REQUIRED") === "ALL_REQUIRED"
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعارض بين نطاق العرض ونوع الباقة",
          why: "باقة «كل المواد سوية» (ALL_REQUIRED) تتطلب تحديد أقسام أو مواد صريحة ولا تعمل على نطاق كل بضاعة المحل (ALL)",
          doThis: "اختر نطاق أقسام أو مواد محددة، أو غيّر وضع الباقة إلى اختر أي عدد (PICK_ANY_N)",
        }),
      });
    }
    if (input.targets && input.targets.length) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعارض في نطاق العرض",
          why: "العرض العام على مستوى كل الأصناف (ALL) لا يقبل تخصيص أهداف محددة",
          doThis: "احذف قائمة الأهداف أو غيّر النطاق إلى فئات أو منتجات",
        }),
      });
    }
    return;
  }
  const targets = input.targets ?? [];
  if (!targets.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "أهداف العرض مفقودة",
        why: "النطاق المحدد يتطلب إضافة هدف واحد على الأقل",
        doThis: "أضف فئة أو منتجاً أو وحدة تعبئة إلى أهداف العرض",
      }),
    });
  }
  if (targets.length > MAX_PROMOTION_TARGETS) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "عدد أهداف العرض تجاوز الحد الأقصى المسموح",
        why: `تم تمرير ${targets.length} هدفاً بينما السقف الأقصى المسموح للعرض الواحد هو ${MAX_PROMOTION_TARGETS} هدف`,
        doThis: "استخدم نطاق الفئات (CATEGORIES) لشمول أقسام كاملة أو قلّل عدد الأصناف المحددة",
      }),
    });
  }
  for (const t of targets) {
    const filled = [t.categoryId, t.productId, t.variantId, t.productUnitId].filter((v) => v != null && Number(v) > 0);
    if (filled.length !== 1) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "حبيبة الهدف غير صالحة",
          why: "كل سطر هدف يجب أن يحدد حبيبة واحدة فقط صريحة (فئة، منتج، متغير، أو وحدة تعبئة)",
          doThis: "حدد حقلاً واحداً فقط لكل هدف",
        }),
      });
    }
    if (input.scope === "CATEGORIES" && !t.categoryId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "عدم تطابق في نوع الهدف",
          why: "نطاق الفئات (CATEGORIES) يستقبل معرفات الفئات فقط",
          doThis: "اختر فئات فقط أو غيّر نطاق العرض إلى منتجات",
        }),
      });
    }
    if (input.scope === "PRODUCTS" && !(t.productId || t.variantId || t.productUnitId)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "عدم تطابق في نوع الهدف",
          why: "نطاق المنتجات (PRODUCTS) يستقبل منتجات أو متغيرات أو وحدات تعبئة فقط",
          doThis: "اختر منتجاً أو متغيراً أو وحدة تعبئة كهدف للعرض",
        }),
      });
    }
  }
}

function normalizeTypeColumns(input: {
  type: SalesPromotionType;
  discountPercent?: string;
  discountAmount?: string;
  fixedPrice?: string;
  bundlePrice?: string;
  bundleMode?: "ALL_REQUIRED" | "PICK_ANY_N";
  bundleQuantity?: number;
  bogoBuyQuantity?: number;
  bogoGetQuantity?: number;
  bogoGetDiscountPercent?: string;
  tieredMode?: "PER_ITEM" | "POOL_ACROSS_TARGETS";
}) {
  return {
    discountPercent: input.type === "PERCENT" ? toDbMoney(input.discountPercent ?? "0") : "0.00",
    discountAmount: input.type === "AMOUNT" ? toDbMoney(input.discountAmount ?? "0") : "0.00",
    fixedPrice: input.type === "FIXED_PRICE" && input.fixedPrice ? toDbMoney(input.fixedPrice) : null,
    bundlePrice: input.type === "BUNDLE_PRICE" && input.bundlePrice ? toDbMoney(input.bundlePrice) : null,
    bundleMode: input.type === "BUNDLE_PRICE" ? (input.bundleMode ?? null) : null,
    bundleQuantity:
      input.type === "BUNDLE_PRICE" && input.bundleMode === "PICK_ANY_N"
        ? (input.bundleQuantity ?? null)
        : null,
    bogoBuyQuantity: input.type === "BOGO" ? (input.bogoBuyQuantity ?? null) : null,
    bogoGetQuantity: input.type === "BOGO" ? (input.bogoGetQuantity ?? null) : null,
    bogoGetDiscountPercent:
      input.type === "BOGO" && input.bogoGetDiscountPercent
        ? toDbMoney(input.bogoGetDiscountPercent)
        : null,
    tieredMode: input.type === "TIERED_QTY" ? (input.tieredMode ?? null) : null,
  };
}

function normalizeTierColumns(t: PromotionTierInput) {
  return {
    minQuantity: toDbMoney(t.minQuantity),
    tierType: t.tierType,
    discountPercent: t.tierType === "PERCENT" ? toDbMoney(t.discountPercent ?? "0") : "0.00",
    discountAmount: t.tierType === "AMOUNT" ? toDbMoney(t.discountAmount ?? "0") : "0.00",
    fixedPrice: t.tierType === "FIXED_PRICE" && t.fixedPrice ? toDbMoney(t.fixedPrice) : null,
  };
}

async function assertBelowCostTargets(
  tx: Tx,
  opts: {
    scope: SalesPromotionScope;
    type: SalesPromotionType;
    allowBelowCost: boolean;
    applyToBaseUnitOnly: boolean;
    customerTier: PriceTier | null | undefined;
    discountPercent?: string;
    discountAmount?: string;
    maxDiscountAmount?: string | null;
    fixedPrice?: string;
    tiers?: PromotionTierInput[];
    targets?: PromotionTargetInput[];
  },
): Promise<void> {
  if (opts.allowBelowCost || opts.scope !== "PRODUCTS") return;
  if (
    opts.type !== "PERCENT" &&
    opts.type !== "AMOUNT" &&
    opts.type !== "FIXED_PRICE" &&
    opts.type !== "TIERED_QTY"
  ) {
    return;
  }
  const targets = opts.targets ?? [];
  if (targets.length === 0) return;

  const prodIds = targets.filter((t) => t.productId != null).map((t) => Number(t.productId));
  const varIds = targets.filter((t) => t.variantId != null).map((t) => Number(t.variantId));
  const explicitUnitIds = new Set(
    targets.filter((t) => t.productUnitId != null).map((t) => Number(t.productUnitId)),
  );
  const targetConditionParts: any[] = [];
  if (prodIds.length > 0) targetConditionParts.push(inArray(products.id, prodIds));
  if (varIds.length > 0) targetConditionParts.push(inArray(productVariants.id, varIds));
  if (explicitUnitIds.size > 0) {
    targetConditionParts.push(inArray(productUnits.id, Array.from(explicitUnitIds)));
  }
  if (targetConditionParts.length === 0) return;

  const effectiveTier: PriceTier = opts.customerTier ?? "RETAIL";
  const candidateUnits = await tx
    .select({
      unitId: productUnits.id,
      unitName: productUnits.unitName,
      conversionFactor: productUnits.conversionFactor,
      isBaseUnit: productUnits.isBaseUnit,
      variantId: productVariants.id,
      costPrice: productVariants.costPrice,
      productName: products.name,
      isBundle: products.isBundle,
      price: productPrices.price,
    })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(
      productPrices,
      and(
        eq(productPrices.productUnitId, productUnits.id),
        eq(productPrices.priceTier, effectiveTier),
      ),
    )
    .where(
      and(
        eq(products.isActive, true),
        eq(productVariants.isActive, true),
        eq(productUnits.isActive, true),
        or(...targetConditionParts)!,
      ),
    );

  if (candidateUnits.length === 0) return;

  const bundleVariantIds = Array.from(
    new Set(
      candidateUnits
        .filter((u) => Boolean(u.isBundle))
        .map((u) => Number(u.variantId)),
    ),
  );
  const bundleCosts =
    bundleVariantIds.length > 0 ? await loadBundleUnitCosts(tx, bundleVariantIds) : new Map<number, string>();

  const maxCap =
    opts.maxDiscountAmount != null && opts.maxDiscountAmount !== ""
      ? money(opts.maxDiscountAmount)
      : null;

  const computePromoUnitPrice = (
    retailPrice: Decimal,
    ruleType: "PERCENT" | "AMOUNT" | "FIXED_PRICE",
    pctVal?: string,
    amtVal?: string,
    fixedVal?: string,
  ): Decimal => {
    let disc = money(0);
    if (ruleType === "PERCENT") {
      disc = retailPrice.mul(money(pctVal ?? "0")).div(100);
    } else if (ruleType === "AMOUNT") {
      disc = Decimal.min(retailPrice, money(amtVal ?? "0"));
    } else if (ruleType === "FIXED_PRICE") {
      const fp = money(fixedVal ?? "0");
      disc = retailPrice.gt(fp) ? retailPrice.minus(fp) : money(0);
    }
    if (maxCap && maxCap.gt(0) && disc.gt(maxCap)) {
      disc = maxCap;
    }
    disc = Decimal.min(retailPrice, Decimal.max(money(0), round2(disc)));
    return round2(retailPrice.minus(disc));
  };

  for (const u of candidateUnits) {
    const uid = Number(u.unitId);
    const explicitlyTargetedUnit = explicitUnitIds.has(uid);
    if (!explicitlyTargetedUnit && opts.applyToBaseUnitOnly && !u.isBaseUnit) {
      continue;
    }
    const retailPrice = u.price != null ? money(u.price) : money(0);
    if (retailPrice.lte(0)) continue;

    const baseCostStr =
      Boolean(u.isBundle) && bundleCosts.has(Number(u.variantId))
        ? bundleCosts.get(Number(u.variantId))!
        : String(u.costPrice ?? "0");
    const unitCost = round2(money(baseCostStr).mul(money(u.conversionFactor ?? "1")));
    if (unitCost.lte(0)) continue;

    let worstPromoPrice = retailPrice;
    if (opts.type === "PERCENT" || opts.type === "AMOUNT" || opts.type === "FIXED_PRICE") {
      worstPromoPrice = computePromoUnitPrice(
        retailPrice,
        opts.type,
        opts.discountPercent,
        opts.discountAmount,
        opts.fixedPrice,
      );
    } else if (opts.type === "TIERED_QTY") {
      for (const tier of opts.tiers ?? []) {
        const tp = computePromoUnitPrice(
          retailPrice,
          tier.tierType,
          tier.discountPercent,
          tier.discountAmount,
          tier.fixedPrice,
        );
        if (tp.lt(worstPromoPrice)) worstPromoPrice = tp;
      }
    }

    if (worstPromoPrice.lt(retailPrice) && worstPromoPrice.lt(unitCost)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: `سعر العرض للصنف «${u.productName}» (${u.unitName}) أقل من سعر التكلفة`,
          why: `سعر البيع بعد العرض (${worstPromoPrice.toFixed(2)} د.ع) يقل عن تكلفة الوحدة (${unitCost.toFixed(2)} د.ع) دون تفعيل السماح بالبيع تحت التكلفة`,
          doThis: "عدّل قيمة الخصم/السعر الموحد أو فعّل خيار «السماح بالبيع تحت التكلفة» صراحةً من الإدارة",
        }),
      });
    }
  }
}

const TARGET_INSERT_CHUNK_SIZE = 500;

async function insertPromotionTargetsChunked(
  tx: Tx,
  promotionId: number,
  targets: PromotionTargetInput[],
): Promise<void> {
  if (targets.length === 0) return;
  for (let offset = 0; offset < targets.length; offset += TARGET_INSERT_CHUNK_SIZE) {
    const chunk = targets.slice(offset, offset + TARGET_INSERT_CHUNK_SIZE);
    await tx.insert(promotionTargets).values(
      chunk.map((t) => ({
        promotionId,
        categoryId: t.categoryId ?? null,
        productId: t.productId ?? null,
        variantId: t.variantId ?? null,
        productUnitId: t.productUnitId ?? null,
      })),
    );
  }
}

export async function createPromotion(tx: Tx, input: CreatePromotionInput, actorUserId: number): Promise<number> {
  assertShape(input);
  assertDates(input);
  assertTargets(input);
  await assertBelowCostTargets(tx, {
    scope: input.scope,
    type: input.type,
    allowBelowCost: input.allowBelowCost ?? false,
    applyToBaseUnitOnly: input.applyToBaseUnitOnly ?? true,
    customerTier: input.customerTier,
    discountPercent: input.discountPercent,
    discountAmount: input.discountAmount,
    maxDiscountAmount: input.maxDiscountAmount,
    fixedPrice: input.fixedPrice,
    tiers: input.tiers,
    targets: input.targets,
  });

  const channel: SalesPromotionChannel =
    input.channel === "POS" ? "POS_ONLY" :
    input.channel === "STORE" ? "STORE_ONLY" :
    (input.channel ?? (input.isStoreManaged ? "STORE_ONLY" : "ALL"));

  const typeCols = normalizeTypeColumns(input);
  const res = await tx.insert(promotions).values({
    campaignId: input.campaignId ?? null,
    name: input.name.trim(),
    description: input.description?.trim() || null,
    type: input.type,
    discountPercent: typeCols.discountPercent,
    discountAmount: typeCols.discountAmount,
    maxDiscountAmount: input.maxDiscountAmount ? toDbMoney(input.maxDiscountAmount) : null,
    minOrderSpend: toDbMoney(input.minOrderSpend ?? "0"),
    freeShipping: input.type === "FREE_SHIPPING" ? true : (input.freeShipping ?? false),
    shippingDiscountAmount: toDbMoney(input.shippingDiscountAmount ?? "0"),
    scope: input.scope,
    effectiveFrom: new Date(input.effectiveFrom),
    effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
    customerTier: input.customerTier ?? null,
    branchId: input.branchId ?? null,
    minLineAmount: toDbMoney(input.minLineAmount ?? "0"),
    priority: input.priority ?? 0,
    isActive: true,
    applicationMode: input.applicationMode ?? "AUTO",
    channel,
    isStoreManaged: channel === "STORE_ONLY",
    allowBelowCost: input.allowBelowCost ?? false,
    applyToBaseUnitOnly: input.applyToBaseUnitOnly ?? true,
    activeDays: input.activeDays ?? null,
    fixedPrice: typeCols.fixedPrice,
    bundlePrice: typeCols.bundlePrice,
    bundleMode: typeCols.bundleMode,
    bundleQuantity: typeCols.bundleQuantity,
    bogoBuyQuantity: typeCols.bogoBuyQuantity,
    bogoGetQuantity: typeCols.bogoGetQuantity,
    bogoGetDiscountPercent: typeCols.bogoGetDiscountPercent,
    tieredMode: typeCols.tieredMode,
    createdBy: actorUserId,
  });
  const promotionId = extractInsertId(res);

  const targets = input.targets ?? [];
  await insertPromotionTargetsChunked(tx, promotionId, targets);

  if (input.type === "TIERED_QTY" && input.tiers && input.tiers.length > 0) {
    await tx.insert(promotionTiers).values(
      input.tiers.map((t) => ({
        promotionId,
        ...normalizeTierColumns(t),
      })),
    );
  }

  return promotionId;
}

export async function deactivatePromotion(tx: Tx, promotionId: number) {
  await tx.update(promotions).set({ isActive: false }).where(eq(promotions.id, promotionId));
}

export async function reactivatePromotion(tx: Tx, promotionId: number) {
  await tx.update(promotions).set({ isActive: true }).where(eq(promotions.id, promotionId));
}

export interface UpdatePromotionInput {
  id: number;
  campaignId?: number | null;
  isActive?: boolean;
  name?: string;
  description?: string | null;
  type?: SalesPromotionType;
  discountPercent?: string;
  discountAmount?: string;
  maxDiscountAmount?: string | null;
  minOrderSpend?: string;
  freeShipping?: boolean;
  shippingDiscountAmount?: string;
  scope?: SalesPromotionScope;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  customerTier?: PriceTier | null;
  branchId?: number | null;
  minLineAmount?: string;
  priority?: number;
  targets?: PromotionTargetInput[];
  channel?: SalesPromotionChannel | "POS" | "STORE";
  isStoreManaged?: boolean;
  applicationMode?: "AUTO" | "COUPON";
  allowBelowCost?: boolean;
  applyToBaseUnitOnly?: boolean;
  activeDays?: number[] | null;
  fixedPrice?: string;
  bundlePrice?: string;
  bundleMode?: "ALL_REQUIRED" | "PICK_ANY_N";
  bundleQuantity?: number;
  bogoBuyQuantity?: number;
  bogoGetQuantity?: number;
  bogoGetDiscountPercent?: string;
  tieredMode?: "PER_ITEM" | "POOL_ACROSS_TARGETS";
  tiers?: PromotionTierInput[];
}

export async function updatePromotion(
  tx: Tx,
  input: UpdatePromotionInput,
  _actorUserId: number
): Promise<number> {
  const existing = (
    await tx
      .select()
      .from(promotions)
      .where(eq(promotions.id, input.id))
      .for("update")
      .limit(1)
  )[0];
  if (!existing) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "العرض الترويجي غير موجود",
        why: `لم يتم العثور على العرض برقم ${input.id}`,
        doThis: "تأكد من رقم العرض الترويجي أو اختر عرضاً آخر من القائمة",
      }),
    });
  }

  const mergedType = input.type ?? (existing.type as SalesPromotionType);
  const typeChanged = input.type !== undefined && input.type !== existing.type;
  const mergedScope = input.scope ?? (existing.scope as SalesPromotionScope);
  const mergedFrom = input.effectiveFrom ?? (existing.effectiveFrom instanceof Date ? existing.effectiveFrom.toISOString().slice(0, 10) : String(existing.effectiveFrom).slice(0, 10));
  const mergedTo = input.effectiveTo !== undefined ? input.effectiveTo : (existing.effectiveTo ? (existing.effectiveTo instanceof Date ? existing.effectiveTo.toISOString().slice(0, 10) : String(existing.effectiveTo).slice(0, 10)) : null);
  const mergedPercent =
    input.discountPercent !== undefined
      ? input.discountPercent
      : typeChanged
        ? "0"
        : String(existing.discountPercent ?? "0");
  const mergedAmount =
    input.discountAmount !== undefined
      ? input.discountAmount
      : typeChanged
        ? "0"
        : String(existing.discountAmount ?? "0");
  const mergedMaxCap = input.maxDiscountAmount !== undefined ? input.maxDiscountAmount : (existing.maxDiscountAmount ? String(existing.maxDiscountAmount) : null);
  const mergedMinSpend = input.minOrderSpend !== undefined ? input.minOrderSpend : String(existing.minOrderSpend ?? "0");
  const mergedFixedPrice =
    input.fixedPrice !== undefined
      ? input.fixedPrice
      : typeChanged
        ? undefined
        : existing.fixedPrice
          ? String(existing.fixedPrice)
          : undefined;
  const mergedBundlePrice =
    input.bundlePrice !== undefined
      ? input.bundlePrice
      : typeChanged
        ? undefined
        : existing.bundlePrice
          ? String(existing.bundlePrice)
          : undefined;
  const mergedBundleMode =
    input.bundleMode !== undefined
      ? input.bundleMode
      : typeChanged
        ? undefined
        : (existing.bundleMode as "ALL_REQUIRED" | "PICK_ANY_N" | undefined);
  const mergedBundleQuantity =
    input.bundleQuantity !== undefined
      ? input.bundleQuantity
      : typeChanged
        ? undefined
        : existing.bundleQuantity != null
          ? Number(existing.bundleQuantity)
          : undefined;
  const mergedBogoBuyQuantity =
    input.bogoBuyQuantity !== undefined
      ? input.bogoBuyQuantity
      : typeChanged
        ? undefined
        : existing.bogoBuyQuantity != null
          ? Number(existing.bogoBuyQuantity)
          : undefined;
  const mergedBogoGetQuantity =
    input.bogoGetQuantity !== undefined
      ? input.bogoGetQuantity
      : typeChanged
        ? undefined
        : existing.bogoGetQuantity != null
          ? Number(existing.bogoGetQuantity)
          : undefined;
  const mergedBogoGetDiscountPercent =
    input.bogoGetDiscountPercent !== undefined
      ? input.bogoGetDiscountPercent
      : typeChanged
        ? undefined
        : existing.bogoGetDiscountPercent
          ? String(existing.bogoGetDiscountPercent)
          : undefined;
  const mergedTieredMode =
    input.tieredMode !== undefined
      ? input.tieredMode
      : typeChanged
        ? undefined
        : (existing.tieredMode as "PER_ITEM" | "POOL_ACROSS_TARGETS" | undefined);

  let effectiveTiers: PromotionTierInput[] | undefined = input.tiers;
  if (mergedType === "TIERED_QTY" && effectiveTiers === undefined && !typeChanged) {
    const existingTierRows = await tx
      .select()
      .from(promotionTiers)
      .where(eq(promotionTiers.promotionId, input.id))
      .orderBy(asc(promotionTiers.minQuantity));
    effectiveTiers = existingTierRows.map((tr) => ({
      minQuantity: String(tr.minQuantity),
      tierType: tr.tierType,
      discountPercent: String(tr.discountPercent),
      discountAmount: String(tr.discountAmount),
      fixedPrice: tr.fixedPrice != null ? String(tr.fixedPrice) : undefined,
    }));
  }

  let effectiveTargets: PromotionTargetInput[] | undefined = input.targets;
  if (mergedScope !== "ALL" && effectiveTargets === undefined) {
    const existingTargetRows = await tx
      .select()
      .from(promotionTargets)
      .where(eq(promotionTargets.promotionId, input.id));
    effectiveTargets = existingTargetRows.map((tr) => ({
      categoryId: tr.categoryId == null ? null : Number(tr.categoryId),
      productId: tr.productId == null ? null : Number(tr.productId),
      variantId: tr.variantId == null ? null : Number(tr.variantId),
      productUnitId: tr.productUnitId == null ? null : Number(tr.productUnitId),
    }));
  }

  const mergedFreeShipping =
    mergedType === "FREE_SHIPPING"
      ? true
      : input.freeShipping !== undefined
        ? input.freeShipping
        : existing.type === "FREE_SHIPPING"
          ? false
          : Boolean(existing.freeShipping);

  assertShape({
    name: input.name ?? existing.name,
    type: mergedType,
    scope: mergedScope,
    effectiveFrom: mergedFrom,
    effectiveTo: mergedTo,
    discountPercent: mergedPercent,
    discountAmount: mergedAmount,
    maxDiscountAmount: mergedMaxCap,
    minOrderSpend: mergedMinSpend,
    freeShipping: mergedFreeShipping,
    fixedPrice: mergedFixedPrice,
    bundlePrice: mergedBundlePrice,
    bundleMode: mergedBundleMode,
    bundleQuantity: mergedBundleQuantity,
    bogoBuyQuantity: mergedBogoBuyQuantity,
    bogoGetQuantity: mergedBogoGetQuantity,
    bogoGetDiscountPercent: mergedBogoGetDiscountPercent,
    tieredMode: mergedTieredMode,
    tiers: effectiveTiers,
  });

  assertDates({
    name: input.name ?? existing.name,
    type: mergedType,
    scope: mergedScope,
    effectiveFrom: mergedFrom,
    effectiveTo: mergedTo,
  });

  if (
    input.targets !== undefined ||
    input.scope !== undefined ||
    typeChanged ||
    input.bundleMode !== undefined
  ) {
    assertTargets({
      name: input.name ?? existing.name,
      type: mergedType,
      bundleMode: mergedBundleMode,
      scope: mergedScope,
      effectiveFrom: mergedFrom,
      targets: mergedScope === "ALL" ? undefined : effectiveTargets,
    });
  }

  const mergedAllowBelowCost = input.allowBelowCost !== undefined ? input.allowBelowCost : Boolean(existing.allowBelowCost);
  const mergedApplyBaseOnly = input.applyToBaseUnitOnly !== undefined ? input.applyToBaseUnitOnly : Boolean(existing.applyToBaseUnitOnly);
  const mergedCustomerTier = input.customerTier !== undefined ? input.customerTier : (existing.customerTier as PriceTier | null);

  await assertBelowCostTargets(tx, {
    scope: mergedScope,
    type: mergedType,
    allowBelowCost: mergedAllowBelowCost,
    applyToBaseUnitOnly: mergedApplyBaseOnly,
    customerTier: mergedCustomerTier,
    discountPercent: mergedPercent,
    discountAmount: mergedAmount,
    maxDiscountAmount: mergedMaxCap,
    fixedPrice: mergedFixedPrice,
    tiers: effectiveTiers,
    targets: effectiveTargets,
  });

  const normalizedTypeCols = normalizeTypeColumns({
    type: mergedType,
    discountPercent: mergedPercent,
    discountAmount: mergedAmount,
    fixedPrice: mergedFixedPrice,
    bundlePrice: mergedBundlePrice,
    bundleMode: mergedBundleMode,
    bundleQuantity: mergedBundleQuantity,
    bogoBuyQuantity: mergedBogoBuyQuantity,
    bogoGetQuantity: mergedBogoGetQuantity,
    bogoGetDiscountPercent: mergedBogoGetDiscountPercent,
    tieredMode: mergedTieredMode,
  });

  const patch: Record<string, unknown> = {};
  if (input.campaignId !== undefined) patch.campaignId = input.campaignId;
  if (input.isActive !== undefined) patch.isActive = input.isActive;
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (
    typeChanged ||
    input.discountPercent !== undefined ||
    input.discountAmount !== undefined ||
    input.fixedPrice !== undefined ||
    input.bundlePrice !== undefined ||
    input.bundleMode !== undefined ||
    input.bundleQuantity !== undefined ||
    input.bogoBuyQuantity !== undefined ||
    input.bogoGetQuantity !== undefined ||
    input.bogoGetDiscountPercent !== undefined ||
    input.tieredMode !== undefined
  ) {
    patch.type = mergedType;
    patch.discountPercent = normalizedTypeCols.discountPercent;
    patch.discountAmount = normalizedTypeCols.discountAmount;
    patch.fixedPrice = normalizedTypeCols.fixedPrice;
    patch.bundlePrice = normalizedTypeCols.bundlePrice;
    patch.bundleMode = normalizedTypeCols.bundleMode;
    patch.bundleQuantity = normalizedTypeCols.bundleQuantity;
    patch.bogoBuyQuantity = normalizedTypeCols.bogoBuyQuantity;
    patch.bogoGetQuantity = normalizedTypeCols.bogoGetQuantity;
    patch.bogoGetDiscountPercent = normalizedTypeCols.bogoGetDiscountPercent;
    patch.tieredMode = normalizedTypeCols.tieredMode;
  }
  if (input.maxDiscountAmount !== undefined) patch.maxDiscountAmount = input.maxDiscountAmount ? toDbMoney(input.maxDiscountAmount) : null;
  if (input.minOrderSpend !== undefined) patch.minOrderSpend = input.minOrderSpend ? toDbMoney(input.minOrderSpend) : "0.00";
  if (mergedType === "FREE_SHIPPING") {
    patch.freeShipping = true;
  } else if (input.freeShipping !== undefined) {
    patch.freeShipping = input.freeShipping;
  } else if (existing.type === "FREE_SHIPPING") {
    patch.freeShipping = false;
  }
  if (input.shippingDiscountAmount !== undefined) patch.shippingDiscountAmount = input.shippingDiscountAmount ? toDbMoney(input.shippingDiscountAmount) : "0.00";
  if (input.scope !== undefined) patch.scope = input.scope;
  if (input.effectiveFrom !== undefined) patch.effectiveFrom = new Date(input.effectiveFrom);
  if (input.effectiveTo !== undefined) patch.effectiveTo = input.effectiveTo ? new Date(input.effectiveTo) : null;
  if (input.customerTier !== undefined) patch.customerTier = input.customerTier;
  if (input.branchId !== undefined) patch.branchId = input.branchId;
  if (input.minLineAmount !== undefined) patch.minLineAmount = input.minLineAmount ? toDbMoney(input.minLineAmount) : "0.00";
  if (input.priority !== undefined) patch.priority = input.priority;
  if (input.channel !== undefined) {
    const ch: SalesPromotionChannel =
      input.channel === "POS" ? "POS_ONLY" :
      input.channel === "STORE" ? "STORE_ONLY" :
      input.channel;
    patch.channel = ch;
    patch.isStoreManaged = ch === "STORE_ONLY";
  } else if (input.isStoreManaged !== undefined) {
    patch.isStoreManaged = input.isStoreManaged;
    patch.channel = input.isStoreManaged ? "STORE_ONLY" : "ALL";
  }
  if (input.applicationMode !== undefined) patch.applicationMode = input.applicationMode;
  if (input.allowBelowCost !== undefined) patch.allowBelowCost = input.allowBelowCost;
  if (input.applyToBaseUnitOnly !== undefined) patch.applyToBaseUnitOnly = input.applyToBaseUnitOnly;
  if (input.activeDays !== undefined) patch.activeDays = input.activeDays;

  if (Object.keys(patch).length > 0) {
    await tx.update(promotions).set(patch).where(eq(promotions.id, input.id));
  }

  if (input.targets !== undefined || (input.scope === "ALL" && existing.scope !== "ALL")) {
    await tx.delete(promotionTargets).where(eq(promotionTargets.promotionId, input.id));
    if (mergedScope !== "ALL" && input.targets) {
      await insertPromotionTargetsChunked(tx, input.id, input.targets);
    }
  }

  if (mergedType !== "TIERED_QTY") {
    if (existing.type === "TIERED_QTY" || input.tiers !== undefined) {
      await tx.delete(promotionTiers).where(eq(promotionTiers.promotionId, input.id));
    }
  } else if (input.tiers !== undefined) {
    await tx.delete(promotionTiers).where(eq(promotionTiers.promotionId, input.id));
    if (input.tiers.length > 0) {
      await tx.insert(promotionTiers).values(
        input.tiers.map((t) => ({
          promotionId: input.id,
          ...normalizeTierColumns(t),
        })),
      );
    }
  }

  return input.id;
}

export interface ResolvedPromotion {
  promotionId: number;
  promotionName: string;
  discountForUnit: string; // خصم لكل وحدة (بعد قصّه لسعر الوحدة عند الحاجة)
}

export interface ResolveLineInput {
  branchId: number;
  customerTier: PriceTier;
  productId: number;
  variantId: number;
  categoryId: number | null;
  productUnitId?: number | null;
  isBaseUnit?: boolean;
  isBundle?: boolean;
  quantity?: string | number;
  orderSubtotal?: string | number;
  unitPrice: string;
  lineAmount: string;
  hasContractPrice: boolean;
  /** تاريخ يوم البيع بصيغة YYYY-MM-DD (لا datetime) — يفرض حبيبة اليوم المحلي (B8). */
  todayYmd: string;
  /** 0073: هل تُدرَج عروض المتجر (isStoreManaged)؟ الكاشير=false (أونلاين فقط)، المتجر=true. افتراضي false. */
  includeStoreManaged?: boolean;
  evaluationChannel?: "POS" | "STORE";
  /** داخلي: لحل عرض كوبون محدد من دون إدخاله في المنافسة التلقائية. */
  requiredApplicationMode?: "AUTO" | "COUPON";
  specificPromotionId?: number;
  /** Current Read + FOR UPDATE للعروض وأهدافها. يستعمله تثبيت طلب المتجر كي
   * لا يطبّق خصماً عُطّل أثناء انتظاره أقفال الكتالوج. */
  lockForUpdate?: boolean;
}

export interface PromotionRuleSnapshotInput {
  branchId: number;
  customerTier: PriceTier;
  todayYmd: string;
  includeStoreManaged?: boolean;
  evaluationChannel?: "POS" | "STORE";
  requiredApplicationMode?: "AUTO" | "COUPON";
  specificPromotionId?: number | null;
  /** Current Read + FOR UPDATE للعروض وأهدافها عند تثبيت طلب المتجر دفعةً واحدة خارج حلقة الأسطر. */
  lockForUpdate?: boolean;
}

export interface PromotionRuleSnapshot {
  readonly branchId: number;
  readonly customerTier: PriceTier;
  readonly todayYmd: string;
  readonly includeStoreManaged: boolean;
  readonly evaluationChannel?: "POS" | "STORE";
  readonly requiredApplicationMode: "AUTO" | "COUPON";
  readonly specificPromotionId?: number | null;
  readonly rules: ReadonlyArray<{
    readonly id: number;
    readonly name: string;
    readonly type: SalesPromotionType;
    readonly discountPercent: string;
    readonly discountAmount: string;
    readonly maxDiscountAmount: string | null;
    readonly minOrderSpend: string;
    readonly freeShipping: boolean;
    readonly shippingDiscountAmount: string;
    readonly scope: SalesPromotionScope | "CATEGORY";
    readonly priority: number;
    readonly minLineAmount: string;
    readonly channel?: SalesPromotionChannel;
    readonly isStoreManaged?: boolean;
    readonly allowBelowCost?: boolean;
    readonly applyToBaseUnitOnly?: boolean;
    readonly activeDays?: ReadonlyArray<number> | null;
    readonly effectiveFrom?: string;
    readonly effectiveTo?: string | null;
    readonly branchId?: number | null;
    readonly customerTier?: PriceTier | null;
    readonly fixedPrice?: string | null;
    readonly bundlePrice?: string | null;
    readonly bundleMode?: "ALL_REQUIRED" | "PICK_ANY_N" | null;
    readonly bundleQuantity?: number | null;
    readonly bogoBuyQuantity?: number | null;
    readonly bogoGetQuantity?: number | null;
    readonly bogoGetDiscountPercent?: string | null;
    readonly tieredMode?: "PER_ITEM" | "POOL_ACROSS_TARGETS" | null;
    readonly targets: ReadonlyArray<{
      readonly promotionId?: number;
      readonly categoryId: number | null;
      readonly productId: number | null;
      readonly variantId: number | null;
      readonly productUnitId?: number | null;
    }>;
    readonly tiers?: ReadonlyArray<TierRule>;
  }>;
}

function formatDateYmd(value: unknown, fallback: string): string {
  if (!value) return fallback;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/**
 * لقطة مجمّعة لقواعد العروض وأهدافها وشرائحها (استعلام قواعد + استعلام أهداف، واستعلام شرائح فقط عند وجود TIERED_QTY).
 * تدعم `specificPromotionId` للكوبونات و`lockForUpdate` بترتيب مفاتيح تصاعدي لتثبيت الطلب بلا N+1.
 */
export async function loadPromotionRuleSnapshot(
  tx: Tx,
  input: PromotionRuleSnapshotInput,
): Promise<PromotionRuleSnapshot> {
  const evalChannel: "POS" | "STORE" =
    input.evaluationChannel ?? (input.includeStoreManaged ? "STORE" : "POS");

  const channelCondition =
    evalChannel === "STORE"
      ? inArray(promotions.channel, ["ALL", "STORE_ONLY"])
      : and(
          eq(promotions.isStoreManaged, false),
          inArray(promotions.channel, ["ALL", "POS_ONLY"]),
        );

  const baseCandidateQuery = tx
    .select({
      id: promotions.id,
      name: promotions.name,
      type: promotions.type,
      discountPercent: promotions.discountPercent,
      discountAmount: promotions.discountAmount,
      maxDiscountAmount: promotions.maxDiscountAmount,
      minOrderSpend: promotions.minOrderSpend,
      freeShipping: promotions.freeShipping,
      shippingDiscountAmount: promotions.shippingDiscountAmount,
      scope: promotions.scope,
      priority: promotions.priority,
      minLineAmount: promotions.minLineAmount,
      channel: promotions.channel,
      isStoreManaged: promotions.isStoreManaged,
      allowBelowCost: promotions.allowBelowCost,
      applyToBaseUnitOnly: promotions.applyToBaseUnitOnly,
      activeDays: promotions.activeDays,
      effectiveFrom: promotions.effectiveFrom,
      effectiveTo: promotions.effectiveTo,
      branchId: promotions.branchId,
      customerTier: promotions.customerTier,
      fixedPrice: promotions.fixedPrice,
      bundlePrice: promotions.bundlePrice,
      bundleMode: promotions.bundleMode,
      bundleQuantity: promotions.bundleQuantity,
      bogoBuyQuantity: promotions.bogoBuyQuantity,
      bogoGetQuantity: promotions.bogoGetQuantity,
      bogoGetDiscountPercent: promotions.bogoGetDiscountPercent,
      tieredMode: promotions.tieredMode,
    })
    .from(promotions)
    .where(
      and(
        eq(promotions.isActive, true),
        eq(promotions.applicationMode, input.requiredApplicationMode ?? "AUTO"),
        input.specificPromotionId != null ? eq(promotions.id, input.specificPromotionId) : undefined,
        sql`${promotions.effectiveFrom} <= DATE(${input.todayYmd})`,
        or(isNull(promotions.effectiveTo), sql`${promotions.effectiveTo} >= DATE(${input.todayYmd})`)!,
        or(isNull(promotions.branchId), eq(promotions.branchId, input.branchId))!,
        or(isNull(promotions.customerTier), eq(promotions.customerTier, input.customerTier))!,
        channelCondition,
      ),
    )
    .orderBy(asc(promotions.id));

  const rawCandidateRows = input.lockForUpdate
    ? await baseCandidateQuery.for("update")
    : await baseCandidateQuery;

  const candidateRows = rawCandidateRows.filter((row) =>
    isPromotionActiveOnDay(
      Array.isArray(row.activeDays) ? row.activeDays : null,
      input.todayYmd,
    ),
  );

  const targetLookupIds = (
    input.lockForUpdate
      ? candidateRows.filter((row) => row.scope !== "ALL")
      : candidateRows
  ).map((row) => Number(row.id));

  let targetRows: Array<{
    promotionId: number;
    categoryId: number | null;
    productId: number | null;
    variantId: number | null;
    productUnitId?: number | null;
  }> = [];
  if (targetLookupIds.length) {
    const baseTargetQuery = tx
      .select({
        promotionId: promotionTargets.promotionId,
        categoryId: promotionTargets.categoryId,
        productId: promotionTargets.productId,
        variantId: promotionTargets.variantId,
        productUnitId: promotionTargets.productUnitId,
      })
      .from(promotionTargets)
      .where(inArray(promotionTargets.promotionId, targetLookupIds))
      .orderBy(asc(promotionTargets.promotionId), asc(promotionTargets.id));
    targetRows = input.lockForUpdate
      ? await baseTargetQuery.for("update")
      : await baseTargetQuery;
  }

  const targetsByPromotion = new Map<
    number,
    Array<{
      categoryId: number | null;
      productId: number | null;
      variantId: number | null;
      productUnitId: number | null;
    }>
  >();
  for (const target of targetRows) {
    const promotionId = Number(target.promotionId);
    const current = targetsByPromotion.get(promotionId) ?? [];
    current.push({
      categoryId: target.categoryId == null ? null : Number(target.categoryId),
      productId: target.productId == null ? null : Number(target.productId),
      variantId: target.variantId == null ? null : Number(target.variantId),
      productUnitId: target.productUnitId == null ? null : Number(target.productUnitId),
    });
    targetsByPromotion.set(promotionId, current);
  }

  const tieredPromotionIds = candidateRows
    .filter((row) => row.type === "TIERED_QTY")
    .map((row) => Number(row.id));
  const tiersByPromotion = new Map<number, TierRule[]>();
  if (tieredPromotionIds.length > 0) {
    const baseTiersQuery = tx
      .select({
        promotionId: promotionTiers.promotionId,
        minQuantity: promotionTiers.minQuantity,
        tierType: promotionTiers.tierType,
        discountPercent: promotionTiers.discountPercent,
        discountAmount: promotionTiers.discountAmount,
        fixedPrice: promotionTiers.fixedPrice,
      })
      .from(promotionTiers)
      .where(inArray(promotionTiers.promotionId, tieredPromotionIds))
      .orderBy(asc(promotionTiers.promotionId), asc(promotionTiers.minQuantity), asc(promotionTiers.id));
    const tierRows = input.lockForUpdate
      ? await baseTiersQuery.for("update")
      : await baseTiersQuery;
    for (const t of tierRows) {
      const pid = Number(t.promotionId);
      const list = tiersByPromotion.get(pid) ?? [];
      list.push({
        minQuantity: String(t.minQuantity),
        tierType: t.tierType,
        discountPercent: t.discountPercent != null ? String(t.discountPercent) : "0.00",
        discountAmount: t.discountAmount != null ? String(t.discountAmount) : "0.00",
        fixedPrice: t.fixedPrice != null ? String(t.fixedPrice) : undefined,
      });
      tiersByPromotion.set(pid, list);
    }
  }

  return {
    branchId: input.branchId,
    customerTier: input.customerTier,
    todayYmd: input.todayYmd,
    includeStoreManaged: input.includeStoreManaged === true,
    evaluationChannel: evalChannel,
    requiredApplicationMode: input.requiredApplicationMode ?? "AUTO",
    specificPromotionId: input.specificPromotionId ?? null,
    rules: candidateRows.map((row) => {
      const pid = Number(row.id);
      const resolvedChannel: SalesPromotionChannel =
        row.channel === "POS_ONLY" || row.channel === "STORE_ONLY"
          ? row.channel
          : row.isStoreManaged
            ? "STORE_ONLY"
            : "ALL";
      return {
        id: pid,
        name: row.name,
        type: row.type,
        discountPercent: String(row.discountPercent ?? "0"),
        discountAmount: String(row.discountAmount ?? "0"),
        maxDiscountAmount: row.maxDiscountAmount != null ? String(row.maxDiscountAmount) : null,
        minOrderSpend: String(row.minOrderSpend ?? "0"),
        freeShipping: Boolean(row.freeShipping) || row.type === "FREE_SHIPPING",
        shippingDiscountAmount: String(row.shippingDiscountAmount ?? "0"),
        scope: row.scope,
        priority: Number(row.priority ?? 0),
        minLineAmount: String(row.minLineAmount ?? "0"),
        channel: resolvedChannel,
        isStoreManaged: Boolean(row.isStoreManaged),
        allowBelowCost: Boolean(row.allowBelowCost),
        applyToBaseUnitOnly: row.applyToBaseUnitOnly !== false,
        activeDays: Array.isArray(row.activeDays) ? row.activeDays : null,
        effectiveFrom: formatDateYmd(row.effectiveFrom, input.todayYmd),
        effectiveTo: row.effectiveTo ? formatDateYmd(row.effectiveTo, input.todayYmd) : null,
        branchId: row.branchId == null ? null : Number(row.branchId),
        customerTier: (row.customerTier as PriceTier | null | undefined) ?? null,
        fixedPrice: row.fixedPrice != null ? String(row.fixedPrice) : null,
        bundlePrice: row.bundlePrice != null ? String(row.bundlePrice) : null,
        bundleMode: row.bundleMode ?? null,
        bundleQuantity: row.bundleQuantity != null ? Number(row.bundleQuantity) : null,
        bogoBuyQuantity: row.bogoBuyQuantity != null ? Number(row.bogoBuyQuantity) : null,
        bogoGetQuantity: row.bogoGetQuantity != null ? Number(row.bogoGetQuantity) : null,
        bogoGetDiscountPercent: row.bogoGetDiscountPercent != null ? String(row.bogoGetDiscountPercent) : null,
        tieredMode: row.tieredMode ?? null,
        targets: targetsByPromotion.get(pid) ?? [],
        tiers: tiersByPromotion.get(pid) ?? [],
      };
    }),
  };
}

/**
 * تحويل لقطة قواعد العروض المحمّلة من قاعدة البيانات إلى صيغة المحرك النقي `PromotionRule[]`
 * لاستعمالها مباشرةً في `evaluateCartPromotions` على الخادم أو إرسالها للعميل.
 */
export function snapshotToEngineRules(snapshot: PromotionRuleSnapshot): PromotionRule[] {
  return snapshot.rules.map((r) => {
    const targetCategoryIds: number[] = [];
    const targetProductIds: number[] = [];
    const targetVariantIds: number[] = [];
    const targetUnitIds: number[] = [];
    for (const t of r.targets) {
      if (t.productUnitId != null) {
        targetUnitIds.push(t.productUnitId);
      } else if (t.variantId != null) {
        targetVariantIds.push(t.variantId);
      } else if (t.productId != null) {
        targetProductIds.push(t.productId);
      } else if (t.categoryId != null) {
        targetCategoryIds.push(t.categoryId);
      }
    }
    const normalizedScope: SalesPromotionScope =
      r.scope === "CATEGORY" ? "CATEGORIES" : r.scope;
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      scope: normalizedScope,
      priority: r.priority,
      channel: r.channel ?? (r.isStoreManaged ? "STORE_ONLY" : "ALL"),
      applicationMode: snapshot.requiredApplicationMode,
      branchId: r.branchId ?? null,
      customerTier: r.customerTier ?? null,
      allowBelowCost: r.allowBelowCost ?? false,
      applyToBaseUnitOnly: r.applyToBaseUnitOnly !== false,
      freeShipping: Boolean(r.freeShipping) || r.type === "FREE_SHIPPING",
      activeDays: r.activeDays ? [...r.activeDays] : null,
      effectiveFrom: r.effectiveFrom ?? snapshot.todayYmd,
      effectiveTo: r.effectiveTo ?? null,
      minOrderSpend: r.minOrderSpend,
      minLineAmount: r.minLineAmount,
      maxDiscountAmount: r.maxDiscountAmount,
      discountPercent: r.discountPercent,
      discountAmount: r.discountAmount,
      fixedPrice: r.fixedPrice ?? null,
      bundlePrice: r.bundlePrice ?? null,
      bundleMode: r.bundleMode ?? null,
      bundleQuantity: r.bundleQuantity ?? null,
      bogoBuyQuantity: r.bogoBuyQuantity ?? null,
      bogoGetQuantity: r.bogoGetQuantity ?? null,
      bogoGetDiscountPercent: r.bogoGetDiscountPercent ?? null,
      tieredMode: r.tieredMode ?? null,
      tiers: r.tiers ? [...r.tiers] : [],
      targetCategoryIds,
      targetProductIds,
      targetVariantIds,
      targetUnitIds,
    };
  });
}

/** حلّ نقي من snapshot محمّلة مسبقاً؛ لا ينفّذ SQL ويمكن استدعاؤه لكل بطاقات الصفحة وأسطر السلة. */
export function resolvePromotionFromSnapshot(
  snapshot: PromotionRuleSnapshot,
  input: ResolveLineInput,
): ResolvedPromotion | null {
  const inputEvalChannel: "POS" | "STORE" =
    input.evaluationChannel ?? (input.includeStoreManaged ? "STORE" : "POS");
  const snapshotEvalChannel: "POS" | "STORE" =
    snapshot.evaluationChannel ?? (snapshot.includeStoreManaged ? "STORE" : "POS");
  if (
    input.hasContractPrice ||
    input.branchId !== snapshot.branchId ||
    input.customerTier !== snapshot.customerTier ||
    input.todayYmd !== snapshot.todayYmd ||
    (input.requiredApplicationMode ?? "AUTO") !== snapshot.requiredApplicationMode ||
    (input.specificPromotionId ?? null) !== (snapshot.specificPromotionId ?? null) ||
    inputEvalChannel !== snapshotEvalChannel
  ) {
    return null;
  }

  const unitPrice = money(input.unitPrice);
  const lineAmount = round2(money(input.lineAmount));
  if (unitPrice.lte(0)) return null;

  const qty =
    input.quantity != null
      ? money(input.quantity)
      : lineAmount.gt(0)
        ? lineAmount.dividedBy(unitPrice)
        : money(1);
  if (qty.lte(0)) return null;

  const isBaseUnit = input.isBaseUnit ?? true;
  const effectiveSubtotal =
    input.orderSubtotal != null
      ? money(input.orderSubtotal)
      : snapshot.requiredApplicationMode === "AUTO"
        ? lineAmount
        : null;

  const scored: Array<{
    id: number;
    name: string;
    priority: number;
    discountForUnit: Decimal;
  }> = [];

  for (const rule of snapshot.rules) {
    if (!isPromotionActiveOnDay(rule.activeDays ? [...rule.activeDays] : null, input.todayYmd)) {
      continue;
    }
    if (
      effectiveSubtotal != null &&
      money(rule.minOrderSpend).gt(0) &&
      effectiveSubtotal.lt(money(rule.minOrderSpend))
    ) {
      continue;
    }
    if (money(rule.minLineAmount).gt(lineAmount)) continue;

    const explicitUnitMatch =
      input.productUnitId != null &&
      rule.targets.some(
        (target) =>
          target.productUnitId != null && target.productUnitId === input.productUnitId,
      );

    if ((rule.applyToBaseUnitOnly ?? true) && !isBaseUnit && !explicitUnitMatch) {
      continue;
    }

    if (rule.scope === "ALL") {
      if (input.isBundle === true) continue;
    } else {
      const targetMatches = rule.targets.some((target) => {
        if (target.productUnitId != null) {
          return input.productUnitId != null && target.productUnitId === input.productUnitId;
        }
        if (target.variantId != null) {
          return target.variantId === input.variantId;
        }
        if (target.productId != null) {
          return target.productId === input.productId;
        }
        if (target.categoryId != null) {
          return input.categoryId != null && target.categoryId === input.categoryId;
        }
        return false;
      });
      if (!targetMatches) continue;
    }

    let discount = money(0);
    if (rule.type === "PERCENT") {
      discount = round2(unitPrice.mul(money(rule.discountPercent)).dividedBy(100));
      if (rule.maxDiscountAmount != null && money(rule.maxDiscountAmount).gt(0)) {
        const cap = money(rule.maxDiscountAmount);
        if (discount.gt(cap)) discount = cap;
      }
    } else if (rule.type === "AMOUNT") {
      discount = round2(money(rule.discountAmount));
    } else if (rule.type === "FIXED_PRICE") {
      if (rule.fixedPrice == null) continue;
      const fixed = money(rule.fixedPrice);
      if (fixed.lt(0) || unitPrice.lte(fixed)) continue;
      discount = round2(unitPrice.minus(fixed));
      if (rule.maxDiscountAmount != null && money(rule.maxDiscountAmount).gt(0)) {
        const cap = money(rule.maxDiscountAmount);
        if (discount.gt(cap)) discount = cap;
      }
    } else if (rule.type === "TIERED_QTY") {
      const tiers = rule.tiers ?? [];
      if (!tiers.length) continue;
      const sortedTiers = [...tiers].sort((a, b) =>
        money(b.minQuantity).comparedTo(money(a.minQuantity)),
      );
      const matchedTier = sortedTiers.find((t) => qty.gte(money(t.minQuantity)));
      if (!matchedTier) continue;
      if (matchedTier.tierType === "PERCENT" && matchedTier.discountPercent != null) {
        discount = round2(unitPrice.mul(money(matchedTier.discountPercent)).dividedBy(100));
      } else if (matchedTier.tierType === "AMOUNT" && matchedTier.discountAmount != null) {
        discount = round2(money(matchedTier.discountAmount));
      } else if (matchedTier.tierType === "FIXED_PRICE" && matchedTier.fixedPrice != null) {
        const fixed = money(matchedTier.fixedPrice);
        if (fixed.lt(0) || unitPrice.lte(fixed)) continue;
        discount = round2(unitPrice.minus(fixed));
      }
      if (rule.maxDiscountAmount != null && money(rule.maxDiscountAmount).gt(0)) {
        const capPerUnit = round2(money(rule.maxDiscountAmount).dividedBy(qty));
        if (discount.gt(capPerUnit)) discount = capPerUnit;
      }
    } else {
      // BUNDLE_PRICE / BOGO: عروض مشروطة بالسلة تُقيَّم عبر evaluateCartPromotions ولا تُطبَع كسعر مفرد على الرف/الملصق
      continue;
    }

    if (discount.gt(unitPrice)) discount = unitPrice;
    if (discount.lte(0)) continue;
    scored.push({
      id: rule.id,
      name: rule.name,
      priority: rule.priority,
      discountForUnit: discount,
    });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const discountOrder = b.discountForUnit.comparedTo(a.discountForUnit);
    return discountOrder !== 0 ? discountOrder : a.id - b.id;
  });
  const winner = scored[0];
  return {
    promotionId: winner.id,
    promotionName: winner.name,
    discountForUnit: toDbMoney(winner.discountForUnit),
  };
}

/**
 * دالة مركزية لحساب مبلغ الخصم مع تطبيق السقف المالي بالدينار والتقريب المحاسبي HALF_UP.
 */
export function calculateDiscountAmount(options: {
  type: SalesPromotionType;
  unitPrice: DecimalInput;
  quantity?: DecimalInput;
  discountPercent?: DecimalInput | null;
  discountAmount?: DecimalInput | null;
  fixedPrice?: DecimalInput | null;
  maxDiscountAmount?: DecimalInput | null;
}): Decimal {
  const unitPrice = money(options.unitPrice);
  const qty = options.quantity != null ? money(options.quantity) : money(1);
  const lineTotal = unitPrice.mul(qty);
  let discount: Decimal;

  if (options.type === "FREE_SHIPPING") {
    return money(0);
  }
  if (options.type === "PERCENT") {
    const rawDiscount = round2(lineTotal.mul(money(options.discountPercent ?? "0")).dividedBy(100));
    if (options.maxDiscountAmount != null && money(options.maxDiscountAmount).gt(0)) {
      const cap = money(options.maxDiscountAmount);
      discount = rawDiscount.gt(cap) ? cap : rawDiscount;
    } else {
      discount = rawDiscount;
    }
  } else if (options.type === "FIXED_PRICE") {
    const fixed = options.fixedPrice != null ? money(options.fixedPrice) : unitPrice;
    const perUnit = unitPrice.gt(fixed) && fixed.gte(0) ? unitPrice.minus(fixed) : money(0);
    const rawDiscount = round2(perUnit.mul(qty));
    if (options.maxDiscountAmount != null && money(options.maxDiscountAmount).gt(0)) {
      const cap = money(options.maxDiscountAmount);
      discount = rawDiscount.gt(cap) ? cap : rawDiscount;
    } else {
      discount = rawDiscount;
    }
  } else {
    discount = round2(money(options.discountAmount ?? "0"));
    if (options.maxDiscountAmount != null && money(options.maxDiscountAmount).gt(0)) {
      const cap = money(options.maxDiscountAmount);
      if (discount.gt(cap)) discount = cap;
    }
  }

  if (discount.gt(lineTotal)) {
    discount = lineTotal;
  }
  if (discount.lt(0)) {
    discount = money(0);
  }
  return round2(discount);
}

export interface LineForCouponAllocation {
  promotionId?: number | null;
  promotionDiscount: DecimalInput;
  discountAmount: DecimalInput;
  total: DecimalInput;
}

export interface AllocatedCouponLineResult {
  promotionDiscount: string;
  discountAmount: string;
  total: string;
  clampedDelta: string;
}

/**
 * توزيع سقف الكوبون المالي (maxDiscountAmount) بالتناسب على أسطر الفاتورة المؤهلة
 * لضمان عدم تجاوز مجموع الخصومات الممنوحة للعميل السقف المحدد بالدينار إطلاقاً،
 * وتحقيق التطابق المحاسبي الكامل بين أسطر الفاتورة وإجمالي الخصم ومبلغ الاستهلاك.
 */
export function allocateCouponDiscountAcrossLines<T extends LineForCouponAllocation>(
  lines: T[],
  promotionId: number,
  maxDiscountAmount?: DecimalInput | null,
): {
  lines: Array<T & AllocatedCouponLineResult>;
  totalCouponDiscount: string;
  isCapped: boolean;
} {
  const cap = (maxDiscountAmount != null && money(maxDiscountAmount).gt(0))
    ? money(maxDiscountAmount)
    : null;

  // تحديد الأسطر المؤهلة للكوبون
  const qualifyingIndices: number[] = [];
  let totalUncapped = money(0);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.promotionId != null && Number(l.promotionId) === promotionId) {
      const pDisc = money(l.promotionDiscount);
      if (pDisc.gt(0)) {
        qualifyingIndices.push(i);
        totalUncapped = totalUncapped.plus(pDisc);
      }
    }
  }

  const shouldCap = cap != null && totalUncapped.gt(cap);
  const finalTotalDiscount = shouldCap ? cap : totalUncapped;

  const resultLines: Array<T & AllocatedCouponLineResult> = lines.map((l) => ({
    ...l,
    promotionDiscount: round2(money(l.promotionDiscount)).toFixed(2),
    discountAmount: round2(money(l.discountAmount)).toFixed(2),
    total: round2(money(l.total)).toFixed(2),
    clampedDelta: "0.00",
  }));

  if (shouldCap && cap && qualifyingIndices.length > 0) {
    let remainingCap = cap;
    for (let k = 0; k < qualifyingIndices.length; k++) {
      const idx = qualifyingIndices[k];
      const origPromo = money(lines[idx].promotionDiscount);
      let alloc: Decimal;
      if (k === qualifyingIndices.length - 1) {
        alloc = remainingCap;
      } else {
        alloc = round2(origPromo.mul(cap).dividedBy(totalUncapped));
        if (alloc.gt(remainingCap)) alloc = remainingCap;
        remainingCap = remainingCap.minus(alloc);
      }
      const delta = origPromo.minus(alloc);
      const newDiscountAmount = round2(money(lines[idx].discountAmount).minus(delta));
      const newTotal = round2(money(lines[idx].total).plus(delta));

      resultLines[idx].promotionDiscount = alloc.toFixed(2);
      resultLines[idx].discountAmount = newDiscountAmount.toFixed(2);
      resultLines[idx].total = newTotal.toFixed(2);
      resultLines[idx].clampedDelta = delta.toFixed(2);
    }
  }

  return {
    lines: resultLines,
    totalCouponDiscount: finalTotalDiscount.toFixed(2),
    isCapped: shouldCap,
  };
}

/**
 * حلّ العرض الأنسب على سطر بيع. يعود null لو لا عرض ينطبق.
 *
 * فلسفة v2 (B1+B8 من gstack):
 *  - `todayYmd` (YYYY-MM-DD) يمرَّر بدل `Date` object ⇒ مقارنة string-based مع DATE لا datetime.
 *    يفرض حبيبة اليوم المحلي: عرض «من ٢٠٢٦-٠٧-٠١ إلى ٢٠٢٦-٠٧-٠١» يعمل يومَه كاملاً (بلا 3h drift).
 *  - `hasContractPrice=true` ⇒ يعود null فوراً (السعر التعاقدي يفوز — قرار المالك).
 *  - أسبقية عند التعارض حتميّة: أعلى priority ⇒ أعلى discountForUnit ⇒ أصغر id.
 */
export async function resolvePromotionForLine(tx: Tx, input: ResolveLineInput): Promise<ResolvedPromotion | null> {
  if (input.hasContractPrice) return null;

  const unitPrice = money(input.unitPrice);
  if (unitPrice.lte(0)) return null;

  const snapshot = await loadPromotionRuleSnapshot(tx, {
    branchId: input.branchId,
    customerTier: input.customerTier,
    todayYmd: input.todayYmd,
    includeStoreManaged: input.includeStoreManaged,
    evaluationChannel: input.evaluationChannel,
    requiredApplicationMode: input.requiredApplicationMode,
    specificPromotionId: input.specificPromotionId,
    lockForUpdate: input.lockForUpdate,
  });

  return resolvePromotionFromSnapshot(snapshot, input);
}

export function resolveCouponPromotionForLine(tx: Tx, promotionId: number, input: ResolveLineInput) {
  return resolvePromotionForLine(tx, { ...input, requiredApplicationMode: "COUPON", specificPromotionId: promotionId });
}

export async function listPromotions(tx: Tx, includeInactive = false) {
  if (includeInactive) return tx.select().from(promotions);
  return tx.select().from(promotions).where(eq(promotions.isActive, true));
}

export interface HydratedPromotionTarget {
  targetId: number;
  targetGrain: "PRODUCT" | "VARIANT" | "UNIT";
  productId: number;
  productName: string;
  productCode: string;
  variantId: number;
  sku: string;
  variantKind: "VARIANT" | "ALTERNATIVE";
  isConsignment: boolean;
  isBundle: boolean;
  costPrice: string | null;
  productUnitId: number;
  unitName: string;
  conversionFactor: string;
  retailPrice: string;
  barcode: string | null;
  isBaseUnit: boolean;
  units: Array<{
    id: number;
    unitName: string;
    conversionFactor: string;
    barcode: string | null;
    isBaseUnit: boolean;
    retailPrice: string;
  }>;
}

export async function getPromotionWithTargets(tx: Tx, promotionId: number, canViewCost = false) {
  const p = (await tx.select().from(promotions).where(eq(promotions.id, promotionId)).limit(1))[0];
  if (!p) return null;

  const targets = await tx
    .select()
    .from(promotionTargets)
    .where(eq(promotionTargets.promotionId, promotionId));

  const tiers = await tx
    .select()
    .from(promotionTiers)
    .where(eq(promotionTiers.promotionId, promotionId))
    .orderBy(asc(promotionTiers.minQuantity));

  const productTargets = targets.filter(
    (t) => t.productId != null || t.variantId != null || t.productUnitId != null,
  );
  const hydratedTargets: HydratedPromotionTarget[] = [];

  if (productTargets.length > 0) {
    const directProdIds = productTargets.filter((t) => t.productId != null).map((t) => Number(t.productId));
    const directVarIds = productTargets.filter((t) => t.variantId != null).map((t) => Number(t.variantId));
    const directUnitIds = productTargets.filter((t) => t.productUnitId != null).map((t) => Number(t.productUnitId));

    const unitToVariantMap = new Map<number, number>();
    if (directUnitIds.length > 0) {
      const uRows = await tx
        .select({ id: productUnits.id, variantId: productUnits.variantId })
        .from(productUnits)
        .where(inArray(productUnits.id, directUnitIds));
      for (const ur of uRows) {
        unitToVariantMap.set(Number(ur.id), Number(ur.variantId));
      }
    }

    const allVarIds = Array.from(new Set([...directVarIds, ...Array.from(unitToVariantMap.values())]));
    const lookupOrs: any[] = [];
    if (directProdIds.length > 0) lookupOrs.push(inArray(products.id, directProdIds));
    if (allVarIds.length > 0) lookupOrs.push(inArray(productVariants.id, allVarIds));

    if (lookupOrs.length > 0) {
      const variantRows = await tx
        .select({
          productId: products.id,
          productName: products.name,
          isConsignment: products.isConsignment,
          isBundle: products.isBundle,
          variantId: productVariants.id,
          sku: productVariants.sku,
          variantKind: productVariants.variantKind,
          costPrice: productVariants.costPrice,
        })
        .from(productVariants)
        .innerJoin(products, eq(productVariants.productId, products.id))
        .where(or(...lookupOrs)!)
        .orderBy(asc(productVariants.id));

      if (variantRows.length > 0) {
        const foundVarIds = Array.from(new Set(variantRows.map((r) => Number(r.variantId))));
        let bundleCostMap = new Map<number, string>();
        if (canViewCost) {
          const bundleVarIds = variantRows
            .filter((r) => Boolean(r.isBundle))
            .map((r) => Number(r.variantId));
          if (bundleVarIds.length > 0) {
            bundleCostMap = await loadBundleUnitCosts(tx, bundleVarIds);
          }
        }

        const effectiveTier: PriceTier = (p.customerTier as PriceTier | null) ?? "RETAIL";
        const unitRows = await tx
          .select({
            id: productUnits.id,
            variantId: productUnits.variantId,
            unitName: productUnits.unitName,
            conversionFactor: productUnits.conversionFactor,
            barcode: productUnits.barcode,
            isBaseUnit: productUnits.isBaseUnit,
            retailPrice: productPrices.price,
          })
          .from(productUnits)
          .leftJoin(
            productPrices,
            and(
              eq(productPrices.productUnitId, productUnits.id),
              eq(productPrices.priceTier, effectiveTier),
            ),
          )
          .where(inArray(productUnits.variantId, foundVarIds))
          .orderBy(desc(productUnits.isBaseUnit), asc(productUnits.conversionFactor), asc(productUnits.id));

        const unitsByVariant = new Map<number, HydratedPromotionTarget["units"]>();
        for (const u of unitRows) {
          const vid = Number(u.variantId);
          const list = unitsByVariant.get(vid) ?? [];
          list.push({
            id: Number(u.id),
            unitName: u.unitName,
            conversionFactor: String(u.conversionFactor ?? "1"),
            barcode: u.barcode ?? null,
            isBaseUnit: Boolean(u.isBaseUnit),
            retailPrice: u.retailPrice != null ? String(u.retailPrice) : "0.00",
          });
          unitsByVariant.set(vid, list);
        }

        const variantById = new Map(variantRows.map((r) => [Number(r.variantId), r]));
        const firstVariantByProd = new Map<number, (typeof variantRows)[number]>();
        for (const r of variantRows) {
          const pid = Number(r.productId);
          if (!firstVariantByProd.has(pid)) firstVariantByProd.set(pid, r);
        }

        for (const t of productTargets) {
          let targetGrain: "PRODUCT" | "VARIANT" | "UNIT" = "PRODUCT";
          let vRow: (typeof variantRows)[number] | undefined;
          let preferredUnitId: number | null = null;

          if (t.productUnitId != null) {
            targetGrain = "UNIT";
            preferredUnitId = Number(t.productUnitId);
            const vid = unitToVariantMap.get(preferredUnitId);
            if (vid != null) vRow = variantById.get(vid);
          } else if (t.variantId != null) {
            targetGrain = "VARIANT";
            vRow = variantById.get(Number(t.variantId));
          } else if (t.productId != null) {
            targetGrain = "PRODUCT";
            vRow = firstVariantByProd.get(Number(t.productId));
          }

          if (!vRow) continue;
          const varId = Number(vRow.variantId);
          const units = unitsByVariant.get(varId) ?? [];
          const activeUnit =
            (preferredUnitId != null ? units.find((u) => u.id === preferredUnitId) : undefined) ??
            units.find((u) => u.isBaseUnit) ??
            units[0];
          if (!activeUnit) continue;

          const isBundle = Boolean(vRow.isBundle);
          const effectiveCost =
            isBundle && bundleCostMap.has(varId)
              ? bundleCostMap.get(varId)!
              : vRow.costPrice != null
                ? String(vRow.costPrice)
                : "0.00";

          hydratedTargets.push({
            targetId: Number(t.id),
            targetGrain,
            productId: Number(vRow.productId),
            productName: vRow.productName,
            productCode: vRow.sku,
            variantId: varId,
            sku: vRow.sku,
            variantKind: (vRow.variantKind as "VARIANT" | "ALTERNATIVE") ?? "VARIANT",
            isConsignment: Boolean(vRow.isConsignment),
            isBundle,
            costPrice: canViewCost ? effectiveCost : null,
            productUnitId: activeUnit.id,
            unitName: activeUnit.unitName,
            conversionFactor: activeUnit.conversionFactor,
            retailPrice: activeUnit.retailPrice,
            barcode: activeUnit.barcode,
            isBaseUnit: activeUnit.isBaseUnit,
            units,
          });
        }
      }
    }
  }

  return {
    promotion: {
      ...p,
      id: Number(p.id),
      campaignId: p.campaignId == null ? null : Number(p.campaignId),
      branchId: p.branchId == null ? null : Number(p.branchId),
      createdBy: p.createdBy == null ? null : Number(p.createdBy),
      effectiveFrom: p.effectiveFrom instanceof Date ? p.effectiveFrom.toISOString().slice(0, 10) : String(p.effectiveFrom),
      effectiveTo: p.effectiveTo ? (p.effectiveTo instanceof Date ? p.effectiveTo.toISOString().slice(0, 10) : String(p.effectiveTo)) : null,
    },
    targets: targets.map((t) => ({
      id: Number(t.id),
      promotionId: Number(t.promotionId),
      categoryId: t.categoryId == null ? null : Number(t.categoryId),
      productId: t.productId == null ? null : Number(t.productId),
      variantId: t.variantId == null ? null : Number(t.variantId),
      productUnitId: t.productUnitId == null ? null : Number(t.productUnitId),
    })),
    hydratedTargets,
    tiers: tiers.map((tier) => ({
      id: Number(tier.id),
      promotionId: Number(tier.promotionId),
      minQuantity: String(tier.minQuantity),
      tierType: tier.tierType,
      discountPercent: String(tier.discountPercent),
      discountAmount: String(tier.discountAmount),
      fixedPrice: tier.fixedPrice == null ? null : String(tier.fixedPrice),
    })),
  };
}

export async function duplicatePromotion(
  tx: Tx,
  promotionId: number,
  actorUserId: number,
  todayYmd: string,
  user: { role: string; branchId?: number | null },
): Promise<number> {
  const existing = await getPromotionWithTargets(tx, promotionId);
  if (!existing) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "العرض الترويجي غير موجود",
        why: `لم يتم العثور على العرض برقم ${promotionId}`,
        doThis: "تأكد من رقم العرض الترويجي أو اختر عرضاً آخر من القائمة",
      }),
    });
  }
  if (user.role !== "admin" && existing.promotion.branchId != null && Number(existing.promotion.branchId) !== Number(user.branchId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "صلاحية غير كافية",
        why: "العرض الترويجي المطلوب نسخه يخص فرعاً آخر",
        doThis: "انسخ العروض التابعة لفرعك فقط أو راجع مدير النظام",
      }),
    });
  }

  const p = existing.promotion;
  const newName = `نسخة من ${p.name}`.slice(0, 255);

  const res = await tx.insert(promotions).values({
    campaignId: p.campaignId ?? null,
    name: newName,
    description: p.description ?? null,
    type: p.type,
    discountPercent: toDbMoney(p.discountPercent ?? "0"),
    discountAmount: toDbMoney(p.discountAmount ?? "0"),
    maxDiscountAmount: p.maxDiscountAmount ? toDbMoney(p.maxDiscountAmount) : null,
    minOrderSpend: toDbMoney(p.minOrderSpend ?? "0"),
    freeShipping: p.freeShipping ?? false,
    shippingDiscountAmount: toDbMoney(p.shippingDiscountAmount ?? "0"),
    scope: p.scope,
    effectiveFrom: new Date(todayYmd),
    effectiveTo: null, // Draft has open end date
    customerTier: p.customerTier ?? null,
    branchId: user.role === "admin" ? (p.branchId ?? null) : (user.branchId ?? null),
    minLineAmount: toDbMoney(p.minLineAmount ?? "0"),
    priority: p.priority ?? 0,
    isActive: false, // Default to inactive draft!
    applicationMode: p.applicationMode,
    channel: p.channel,
    isStoreManaged: p.channel === "STORE_ONLY",
    allowBelowCost: p.allowBelowCost,
    applyToBaseUnitOnly: p.applyToBaseUnitOnly,
    activeDays: p.activeDays ?? null,
    fixedPrice: p.fixedPrice ? toDbMoney(p.fixedPrice) : null,
    bundlePrice: p.bundlePrice ? toDbMoney(p.bundlePrice) : null,
    bundleMode: p.bundleMode ?? null,
    bundleQuantity: p.bundleQuantity ?? null,
    bogoBuyQuantity: p.bogoBuyQuantity ?? null,
    bogoGetQuantity: p.bogoGetQuantity ?? null,
    bogoGetDiscountPercent: p.bogoGetDiscountPercent ? toDbMoney(p.bogoGetDiscountPercent) : null,
    tieredMode: p.tieredMode ?? null,
    createdBy: actorUserId,
  });
  const newId = extractInsertId(res);

  await insertPromotionTargetsChunked(tx, newId, existing.targets);

  if (existing.tiers.length > 0) {
    await tx.insert(promotionTiers).values(
      existing.tiers.map((t) => ({
        promotionId: newId,
        ...normalizeTierColumns({
          minQuantity: String(t.minQuantity),
          tierType: t.tierType,
          discountPercent: String(t.discountPercent),
          discountAmount: String(t.discountAmount),
          fixedPrice: t.fixedPrice ?? undefined,
        }),
      })),
    );
  }

  return newId;
}

export interface SearchProductResultItem {
  productId: number;
  productName: string;
  productCode: string;
  categoryId: number;
  categoryName?: string;
  variantId: number;
  sku: string;
  variantKind: "VARIANT" | "ALTERNATIVE";
  isConsignment: boolean;
  isBundle?: boolean;
  costPrice: string | null; // Sanitized: null if unauthorized
  units: Array<{
    id: number;
    unitName: string;
    conversionFactor: string;
    barcode: string | null;
    altBarcodes?: string[];
    isBaseUnit: boolean;
    retailPrice: string;
  }>;
}

export async function searchPromotionProducts(
  db: any,
  input: {
    q?: string;
    categoryId?: number | null;
    codes?: string[];
    limit?: number;
    offset?: number;
  },
  canViewCost: boolean,
): Promise<SearchProductResultItem[]> {
  const rawCodes = Array.isArray(input.codes)
    ? input.codes.map((c) => String(c ?? "").trim()).filter(Boolean).slice(0, 500)
    : [];
  const rawQ = input.q?.trim() ?? "";
  const canonicalBarcodeQ = rawQ ? canonicalizeBarcodeInput(rawQ) : "";
  const normQ = rawQ ? normalizeSearchText(rawQ) : "";
  const normTokens = normQ ? normQ.split(/\s+/).filter(Boolean) : [];
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 500);
  const safeOffset =
    !rawQ && rawCodes.length === 0
      ? Math.min(Math.max(0, Math.trunc(input.offset ?? 0)), 50_000)
      : 0;

  const exactBarcodeVariantIds = new Set<number>();
  const matchedVariantIdsSet = new Set<number>();

  if (rawCodes.length > 0) {
    const bulkTerms = Array.from(
      new Set(
        rawCodes.flatMap((c) => {
          const canon = canonicalizeBarcodeInput(c);
          return canon && canon !== c ? [c, canon] : [c];
        }),
      ),
    );
    if (bulkTerms.length > 0) {
      const unitHits = await db
        .select({ variantId: productUnits.variantId })
        .from(productUnits)
        .where(
          and(
            eq(productUnits.isActive, true),
            inArray(productUnits.barcode, bulkTerms),
          ),
        );
      for (const u of unitHits) {
        const vid = Number(u.variantId);
        exactBarcodeVariantIds.add(vid);
        matchedVariantIdsSet.add(vid);
      }

      const aliasHits = await db
        .select({ variantId: productUnits.variantId })
        .from(productUnitBarcodes)
        .innerJoin(productUnits, eq(productUnitBarcodes.productUnitId, productUnits.id))
        .where(
          and(
            eq(productUnits.isActive, true),
            inArray(productUnitBarcodes.barcode, bulkTerms),
          ),
        );
      for (const a of aliasHits) {
        const vid = Number(a.variantId);
        exactBarcodeVariantIds.add(vid);
        matchedVariantIdsSet.add(vid);
      }

      const skuHits = await db
        .select({ variantId: productVariants.id })
        .from(productVariants)
        .where(
          and(
            eq(productVariants.isActive, true),
            inArray(productVariants.sku, bulkTerms),
          ),
        );
      for (const s of skuHits) {
        const vid = Number(s.variantId);
        exactBarcodeVariantIds.add(vid);
        matchedVariantIdsSet.add(vid);
      }
    }
    if (matchedVariantIdsSet.size === 0) return [];
  } else if (rawQ) {
    const barcodeTerms = Array.from(new Set([rawQ, canonicalBarcodeQ].filter(Boolean)));
    // 1a. Exact primary & alias barcode matches (never truncated by small limit)
    const exactUnitMatches = await db
      .select({ variantId: productUnits.variantId })
      .from(productUnits)
      .where(
        and(
          eq(productUnits.isActive, true),
          inArray(productUnits.barcode, barcodeTerms),
        ),
      )
      .limit(50);
    for (const u of exactUnitMatches) {
      const vid = Number(u.variantId);
      exactBarcodeVariantIds.add(vid);
      matchedVariantIdsSet.add(vid);
    }

    const exactAliasMatches = await db
      .select({ variantId: productUnits.variantId })
      .from(productUnitBarcodes)
      .innerJoin(productUnits, eq(productUnitBarcodes.productUnitId, productUnits.id))
      .where(
        and(
          eq(productUnits.isActive, true),
          inArray(productUnitBarcodes.barcode, barcodeTerms),
        ),
      )
      .limit(50);
    for (const a of exactAliasMatches) {
      const vid = Number(a.variantId);
      exactBarcodeVariantIds.add(vid);
      matchedVariantIdsSet.add(vid);
    }

    // 1b. Substring barcode matches
    const likeLimit = Math.min(Math.max(limit * 2, 20), 60);
    const primaryLikeOrs = barcodeTerms.map((term) => like(productUnits.barcode, `%${term}%`));
    const unitMatches = await db
      .select({ variantId: productUnits.variantId })
      .from(productUnits)
      .where(
        and(
          eq(productUnits.isActive, true),
          or(...primaryLikeOrs)!,
        ),
      )
      .limit(likeLimit);
    for (const u of unitMatches) {
      matchedVariantIdsSet.add(Number(u.variantId));
    }

    const aliasLikeOrs = barcodeTerms.map((term) => like(productUnitBarcodes.barcode, `%${term}%`));
    const aliasMatches = await db
      .select({ variantId: productUnits.variantId })
      .from(productUnitBarcodes)
      .innerJoin(productUnits, eq(productUnitBarcodes.productUnitId, productUnits.id))
      .where(
        and(
          eq(productUnits.isActive, true),
          or(...aliasLikeOrs)!,
        ),
      )
      .limit(likeLimit);
    for (const a of aliasMatches) {
      matchedVariantIdsSet.add(Number(a.variantId));
    }
  }

  const matchedVariantIds = Array.from(matchedVariantIdsSet);

  // 2. Query productVariants joined with products
  const conditions: any[] = [
    eq(products.isActive, true),
    eq(productVariants.isActive, true),
  ];

  if (input.categoryId != null) {
    conditions.push(eq(products.categoryId, input.categoryId));
  }

  if (rawCodes.length > 0) {
    conditions.push(inArray(productVariants.id, matchedVariantIds));
  } else if (rawQ) {
    const textConditions: any[] = [
      like(products.name, `%${rawQ}%`),
      like(productVariants.sku, `%${rawQ}%`),
    ];
    if (canonicalBarcodeQ && canonicalBarcodeQ !== rawQ) {
      textConditions.push(like(productVariants.sku, `%${canonicalBarcodeQ}%`));
    }
    if (products.searchNorm && normTokens.length > 0) {
      if (normTokens.length === 1) {
        textConditions.push(like(products.searchNorm, `%${normTokens[0]}%`));
      } else {
        textConditions.push(
          and(...normTokens.map((tok) => like(products.searchNorm, `%${tok}%`)))!,
        );
      }
    }
    if (matchedVariantIds.length > 0) {
      textConditions.push(inArray(productVariants.id, matchedVariantIds));
    }
    conditions.push(or(...textConditions)!);
  }

  const candidateLimit =
    rawCodes.length > 0
      ? Math.max(limit, matchedVariantIds.length)
      : rawQ
      ? Math.min(Math.max(limit * 4, 40), 600)
      : limit;
  const candidateRows = await db
    .select({
      productId: products.id,
      productName: products.name,
      categoryId: products.categoryId,
      isConsignment: products.isConsignment,
      isBundle: products.isBundle,
      variantId: productVariants.id,
      sku: productVariants.sku,
      variantKind: productVariants.variantKind,
      costPrice: productVariants.costPrice,
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(and(...conditions))
    .orderBy(desc(products.id), asc(productVariants.id))
    .limit(candidateLimit)
    .offset(safeOffset);

  if (rawQ && exactBarcodeVariantIds.size > 0) {
    const presentIds = new Set(candidateRows.map((r: any) => Number(r.variantId)));
    const missingExactIds = Array.from(exactBarcodeVariantIds).filter((id) => !presentIds.has(id));
    if (missingExactIds.length > 0) {
      const exactConds: any[] = [
        eq(products.isActive, true),
        eq(productVariants.isActive, true),
        inArray(productVariants.id, missingExactIds),
      ];
      if (input.categoryId != null) {
        exactConds.push(eq(products.categoryId, input.categoryId));
      }
      const extraRows = await db
        .select({
          productId: products.id,
          productName: products.name,
          categoryId: products.categoryId,
          isConsignment: products.isConsignment,
          isBundle: products.isBundle,
          variantId: productVariants.id,
          sku: productVariants.sku,
          variantKind: productVariants.variantKind,
          costPrice: productVariants.costPrice,
        })
        .from(productVariants)
        .innerJoin(products, eq(productVariants.productId, products.id))
        .where(and(...exactConds));
      candidateRows.push(...extraRows);
    }
  }

  if (candidateRows.length === 0) return [];

  const rawQLower = rawQ.toLowerCase();
  const canonicalLower = canonicalBarcodeQ.toLowerCase();
  const rankOfRow = (r: any): number => {
    if (!rawQ) return 0;
    const vid = Number(r.variantId);
    const skuLower = String(r.sku ?? "").toLowerCase();
    if (
      exactBarcodeVariantIds.has(vid) ||
      skuLower === rawQLower ||
      (canonicalLower && skuLower === canonicalLower)
    ) {
      return 0;
    }
    const nameNorm = normalizeSearchText(String(r.productName ?? ""));
    if (
      skuLower.startsWith(rawQLower) ||
      (canonicalLower && skuLower.startsWith(canonicalLower)) ||
      (normQ && nameNorm === normQ)
    ) {
      return 1;
    }
    if ((normQ && nameNorm.startsWith(normQ)) || matchedVariantIdsSet.has(vid)) {
      return 2;
    }
    return 3;
  };

  const variantRows = rawQ
    ? [...candidateRows]
        .sort((a: any, b: any) => {
          const rDiff = rankOfRow(a) - rankOfRow(b);
          if (rDiff !== 0) return rDiff;
          const pDiff = Number(b.productId) - Number(a.productId);
          if (pDiff !== 0) return pDiff;
          return Number(a.variantId) - Number(b.variantId);
        })
        .slice(0, limit)
    : candidateRows.slice(0, limit);

  const foundVariantIds = variantRows.map((r: any) => Number(r.variantId));

  // Resolve live component cost for pre-packaged bundles when cost visibility is authorized
  let bundleCostMap = new Map<number, string>();
  if (canViewCost) {
    const bundleVariantIds = variantRows
      .filter((r: any) => Boolean(r.isBundle))
      .map((r: any) => Number(r.variantId));
    if (bundleVariantIds.length > 0) {
      bundleCostMap = await loadBundleUnitCosts(db, bundleVariantIds);
    }
  }

  // 3. Load packaging units with retail price
  const unitRows = await db
    .select({
      id: productUnits.id,
      variantId: productUnits.variantId,
      unitName: productUnits.unitName,
      conversionFactor: productUnits.conversionFactor,
      barcode: productUnits.barcode,
      isBaseUnit: productUnits.isBaseUnit,
      retailPrice: productPrices.price,
    })
    .from(productUnits)
    .leftJoin(
      productPrices,
      and(
        eq(productPrices.productUnitId, productUnits.id),
        eq(productPrices.priceTier, "RETAIL"),
      ),
    )
    .where(
      and(
        inArray(productUnits.variantId, foundVariantIds),
        eq(productUnits.isActive, true),
      ),
    )
    .orderBy(desc(productUnits.isBaseUnit), asc(productUnits.conversionFactor), asc(productUnits.id));

  const foundUnitIds = unitRows.map((u: any) => Number(u.id));
  const altBarcodesByUnit = new Map<number, string[]>();
  if (foundUnitIds.length > 0) {
    const aliasRows = await db
      .select({
        productUnitId: productUnitBarcodes.productUnitId,
        barcode: productUnitBarcodes.barcode,
      })
      .from(productUnitBarcodes)
      .where(inArray(productUnitBarcodes.productUnitId, foundUnitIds));
    for (const ar of aliasRows) {
      const uid = Number(ar.productUnitId);
      const list = altBarcodesByUnit.get(uid) ?? [];
      if (ar.barcode) list.push(String(ar.barcode));
      altBarcodesByUnit.set(uid, list);
    }
  }

  const unitsByVariant = new Map<number, SearchProductResultItem["units"]>();
  for (const u of unitRows) {
    const varId = Number(u.variantId);
    const uid = Number(u.id);
    const list = unitsByVariant.get(varId) ?? [];
    const altBarcodes = altBarcodesByUnit.get(uid);
    list.push({
      id: uid,
      unitName: u.unitName,
      conversionFactor: String(u.conversionFactor ?? "1"),
      barcode: u.barcode ?? null,
      ...(altBarcodes && altBarcodes.length > 0 ? { altBarcodes } : {}),
      isBaseUnit: Boolean(u.isBaseUnit),
      retailPrice: u.retailPrice != null ? String(u.retailPrice) : "0.00",
    });
    unitsByVariant.set(varId, list);
  }

  return variantRows.map((r: any) => {
    const varId = Number(r.variantId);
    const isBundle = Boolean(r.isBundle);
    const effectiveCost = isBundle && bundleCostMap.has(varId)
      ? bundleCostMap.get(varId)!
      : r.costPrice != null
        ? String(r.costPrice)
        : "0.00";
    return {
      productId: Number(r.productId),
      productName: r.productName,
      productCode: r.sku,
      categoryId: r.categoryId == null ? 0 : Number(r.categoryId),
      variantId: varId,
      sku: r.sku,
      variantKind: (r.variantKind as "VARIANT" | "ALTERNATIVE") ?? "VARIANT",
      isConsignment: Boolean(r.isConsignment),
      isBundle,
      costPrice: canViewCost ? effectiveCost : null,
      units: unitsByVariant.get(varId) ?? [],
    };
  });
}

export async function getProductCategoryIds(tx: Tx, productIds: number[]): Promise<Map<number, number | null>> {
  const map = new Map<number, number | null>();
  if (!productIds.length) return map;
  const rows = await tx
    .select({ id: products.id, categoryId: products.categoryId })
    .from(products)
    .where(inArray(products.id, Array.from(new Set(productIds))));
  for (const r of rows) map.set(Number(r.id), r.categoryId == null ? null : Number(r.categoryId));
  return map;
}

export interface PromotionPerformanceRow {
  promotionId: number;
  invoiceCount: number;
  netSales: string;
  discount: string;
  cost: string | null;
  grossProfit: string | null;
}

/**
 * أثر العروض من لقطات الفواتير وبنودها، لا من تعريف العرض الحيّ. المرتجعات الجزئية تُنزّل الإيراد
 * بنسبة الكمية المرتجعة، وتعيد COGS فقط لما عاد فعلياً إلى المخزون؛ وتُضمَّن عروض الشحن المجاني
 * (`invoices.freeShippingPromotionId`) في عدّاد الفواتير لكل عرض وفي الملخص الكلي دون تضخيم الإيراد
 * أو التكلفة (§٦: التوصيل المجاني إفصاحٌ لا محاسبة). عند غياب صلاحية رؤية التكلفة تُقنَّع `cost`
 * و`grossProfit` بـ `null` خادمياً على الصفوف والملخص معاً.
 */
export async function loadPromotionPerformance(
  tx: Tx,
  branchId: number | null,
  canViewCost = true,
): Promise<{
  canSeeCost: boolean;
  rows: PromotionPerformanceRow[];
  summary: Omit<PromotionPerformanceRow, "promotionId">;
}> {
  const { componentRightsNetCostSql, invoiceLineReportProjectionSql } =
    await import("./fulfillment/componentRightsReportSql");
  const branchFilter =
    branchId == null ? sql`` : sql`AND i.branchId = ${branchId}`;
  const invoiceScope = sql`i.invoiceStatus NOT IN ('CANCELLED', 'SUPERSEDED') ${branchFilter} AND EXISTS (SELECT 1 FROM invoiceItems pii WHERE pii.invoiceId = i.id AND pii.promotionId IS NOT NULL)`;
  const projection = invoiceLineReportProjectionSql(invoiceScope);

  const remainingSaleRatio = sql`CASE
    WHEN ii.baseQuantity <= 0 THEN 0
    ELSE GREATEST(ii.baseQuantity - COALESCE(ii.returnedBaseQuantity, 0), 0) / ii.baseQuantity
  END`;
  const discountExpr = sql`ii.promotionDiscount * (${remainingSaleRatio})`;
  const costSelectExpr = canViewCost
    ? componentRightsNetCostSql({
        itemId: sql`ii.id`,
        originalCost: sql`ii.lineCost`,
        ordinary: sql`CASE
          WHEN ii.baseQuantity <= 0 THEN ii.lineCost
          WHEN COALESCE(ii.returnedRestockedBaseQuantity, 0) >= ii.baseQuantity THEN 0
          ELSE ii.lineCost - ROUND(
            ii.lineCost * COALESCE(ii.returnedRestockedBaseQuantity, 0) / ii.baseQuantity,
            2
          )
        END`,
      })
    : sql`0`;

  const queryRes = await tx.execute(sql`
    SELECT
      ii.promotionId AS promotionId,
      CAST(COALESCE(SUM(rp.revenue), 0) AS CHAR) AS netSales,
      CAST(COALESCE(SUM(${discountExpr}), 0) AS CHAR) AS discount,
      CAST(COALESCE(SUM(${costSelectExpr}), 0) AS CHAR) AS cost
    FROM invoiceItems ii
    INNER JOIN invoices i ON i.id = ii.invoiceId
    INNER JOIN (${projection}) rp ON rp.id = ii.id
    WHERE ii.promotionId IS NOT NULL
      AND i.invoiceStatus NOT IN ('CANCELLED', 'SUPERSEDED')
      ${branchFilter}
    GROUP BY ii.promotionId
  `);
  const rawMerch = ((queryRes as unknown as [any[]])[0] ?? queryRes) as Array<{
    promotionId: number | string;
    netSales: string;
    discount: string;
    cost: string;
  }>;

  const qualifyingPromoInvoicesSql = sql`
    SELECT ii.promotionId AS promotionId, ii.invoiceId AS invoiceId
    FROM invoiceItems ii
    INNER JOIN invoices i ON i.id = ii.invoiceId
    WHERE ii.promotionId IS NOT NULL
      AND (${remainingSaleRatio}) > 0
      AND i.invoiceStatus NOT IN ('CANCELLED', 'SUPERSEDED')
      ${branchFilter}
    UNION
    SELECT i.freeShippingPromotionId AS promotionId, i.id AS invoiceId
    FROM invoices i
    WHERE i.freeShippingPromotionId IS NOT NULL
      AND i.deliveryFree = 1
      AND i.invoiceStatus NOT IN ('CANCELLED', 'SUPERSEDED', 'RETURNED')
      ${branchFilter}
      AND (
        NOT EXISTS (SELECT 1 FROM invoiceItems aii WHERE aii.invoiceId = i.id)
        OR EXISTS (
          SELECT 1 FROM invoiceItems rii
          WHERE rii.invoiceId = i.id
            AND rii.baseQuantity > COALESCE(rii.returnedBaseQuantity, 0)
        )
      )
  `;

  const perPromoCountRes = await tx.execute(sql`
    SELECT
      u.promotionId AS promotionId,
      COUNT(DISTINCT u.invoiceId) AS invoiceCount
    FROM (${qualifyingPromoInvoicesSql}) u
    GROUP BY u.promotionId
  `);
  const rawCounts = ((perPromoCountRes as unknown as [any[]])[0] ?? perPromoCountRes) as Array<{
    promotionId: number | string;
    invoiceCount: number | string;
  }>;

  const invoiceCountByPromoId = new Map<number, number>();
  for (const rc of rawCounts) {
    invoiceCountByPromoId.set(Number(rc.promotionId), Number(rc.invoiceCount ?? 0));
  }

  const merchByPromoId = new Map<
    number,
    { netSales: Decimal; discount: string; cost: Decimal }
  >();
  for (const rm of rawMerch) {
    merchByPromoId.set(Number(rm.promotionId), {
      netSales: money(rm.netSales),
      discount: rm.discount,
      cost: money(rm.cost),
    });
  }

  const allPromotionIdSet = new Set<number>();
  merchByPromoId.forEach((_v, k) => allPromotionIdSet.add(k));
  invoiceCountByPromoId.forEach((_v, k) => allPromotionIdSet.add(k));
  const allPromotionIds = Array.from(allPromotionIdSet).sort((a, b) => a - b);

  const rows: PromotionPerformanceRow[] = allPromotionIds.map((promotionId) => {
    const merch = merchByPromoId.get(promotionId);
    const netSales = merch ? merch.netSales : money(0);
    const cost = merch ? merch.cost : money(0);
    return {
      promotionId,
      invoiceCount: invoiceCountByPromoId.get(promotionId) ?? 0,
      netSales: toDbMoney(netSales),
      discount: toDbMoney(merch?.discount ?? "0"),
      cost: canViewCost ? toDbMoney(cost) : null,
      grossProfit: canViewCost ? toDbMoney(netSales.minus(cost)) : null,
    };
  });

  let distinctInvoiceCount = 0;
  if (invoiceCountByPromoId.size > 0) {
    const distinctRes = await tx.execute(sql`
      SELECT COUNT(DISTINCT u.invoiceId) AS invoiceCount
      FROM (${qualifyingPromoInvoicesSql}) u
    `);
    const distinctRows = ((distinctRes as unknown as [any[]])[0] ?? distinctRes) as Array<{
      invoiceCount?: number | string;
    }>;
    distinctInvoiceCount = Number(distinctRows[0]?.invoiceCount ?? 0);
  }

  const totalNetSales = rows.reduce((sum, r) => sum.plus(money(r.netSales)), money(0));
  const totalDiscount = rows.reduce((sum, r) => sum.plus(money(r.discount)), money(0));
  const totalCost = canViewCost
    ? rows.reduce((sum, r) => sum.plus(money(r.cost ?? "0")), money(0))
    : null;
  const summary: Omit<PromotionPerformanceRow, "promotionId"> = {
    invoiceCount: distinctInvoiceCount,
    netSales: toDbMoney(totalNetSales),
    discount: toDbMoney(totalDiscount),
    cost: totalCost ? toDbMoney(totalCost) : null,
    grossProfit: totalCost ? toDbMoney(totalNetSales.minus(totalCost)) : null,
  };
  return { canSeeCost: canViewCost, rows, summary };
}
