/** Durable public-price snapshot for ordinary lines travelling with digital cards. */
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import {
  customers,
  products,
  productUnits,
  productVariants,
  promotions,
} from "../../../drizzle/schema";
import {
  evaluateCartPromotions,
  type CartEvalItem,
} from "../../../shared/promotionEngine";
import {
  loadPromotionRuleSnapshot,
  snapshotToEngineRules,
} from "../salesPromotionService";
import type {
  DigitalCheckoutInventoryReservationSnapshot,
  DigitalCheckoutPricingGuardSnapshot,
  DigitalCheckoutRegularLineInput,
  DigitalCheckoutSnapshot,
} from "../../../shared/digitalSale";
import { appErrorMessage } from "../../../shared/errors";
import type { Tx } from "../../db";
import {
  computeInvoiceCost,
  computeLineTotal,
  isInvoiceBelowCost,
  lineDiscountExceedsThreshold,
} from "../billing";
import {
  computeBundleUnitCosts,
  getBundleDefinitions,
} from "../bundleService";
import { loadVariantAvailability } from "../catalog/variantAvailability";
import { resolveContractPrices } from "../contractPriceService";
import { GIFT_APPROVAL_THRESHOLD } from "../gifts/outbound";
import { convertToBaseQuantity } from "../inventoryService";
import { addQuantities, isQuantity } from "@shared/quantity";
import { money, round2, sumMoney, toDbMoney } from "../money";
import {
  getUnitPrice,
  resolveTier,
  tryGetUnitPrice,
  type PriceTier,
} from "../pricing";
import {
  exactRecipeMaterialQuantity,
  loadServiceRecipeDefinitions,
} from "../serviceRecipeConsumption";
import type { SaleLineInput } from "../sale/types";
import type { Actor } from "../tx";

export interface CheckoutSnapshotInput {
  branchId?: number;
  customerId?: number | null;
  priceTier?: PriceTier | null;
  dueDate?: string | null;
  notes?: string | null;
  sourceType?: "POS" | "INVOICE" | "RECEPTION";
  sourcePayload?: unknown;
  regularLines?: DigitalCheckoutRegularLineInput[];
  /** قدرة داخلية غير قابلة للتمثيل في JSON، تُمنح فقط بعد تحقق صلاحية المدير في الراوتر. */
  priceApprovalCapability?: typeof VERIFIED_DIGITAL_PRICE_APPROVAL;
  priceApprovedBy?: number | null;
}

/** رمز process-local لا يستطيع عميل HTTP تصنيعه أو تمريره في حمولة JSON. */
export const VERIFIED_DIGITAL_PRICE_APPROVAL = Symbol(
  "VERIFIED_DIGITAL_PRICE_APPROVAL",
);

function checkoutError(
  why: string,
  code: "BAD_REQUEST" | "CONFLICT" | "FORBIDDEN" = "BAD_REQUEST",
): never {
  throw new TRPCError({
    code,
    message: appErrorMessage({
      what: "تعذّر تثبيت السلة المختلطة",
      why,
      doThis:
        "راجِع العميل والأسعار والكميات قبل إصدار الكروت؛ إن صدرت بالفعل فاستعمل مراجعة العمليات ولا تكرر الإصدار",
    }),
  });
}

/** Pick fields explicitly: internal cost overrides/tokens can never enter the snapshot. */
function normalizedRequest(input: CheckoutSnapshotInput) {
  const lines = input.regularLines ?? [];
  if (lines.length > 100) checkoutError("السلة تتجاوز 100 بند عادي");
  const keys = new Set<string>();
  const regularLines = lines
    .map((line) => {
      const lineKey = line.lineKey.trim();
      if (!lineKey || keys.has(lineKey))
        checkoutError("مفتاح بند عادي فارغ أو مكرر");
      keys.add(lineKey);
      const quantity = money(line.quantity);
      if (
        !quantity.isFinite() ||
        quantity.lte(0) ||
        quantity.decimalPlaces() > 3
      ) {
        checkoutError(
          "كمية البند يجب أن تكون موجبة وبثلاث منازل عشرية كحد أقصى",
        );
      }
      const optionalMoney = (
        value: string | null | undefined,
      ): string | null => {
        if (value == null || value === "") return null;
        const amount = money(value);
        if (!amount.isFinite() || amount.lt(0) || amount.decimalPlaces() > 2) {
          checkoutError(
            "السعر أو الخصم غير صالح؛ استعمل مبلغاً غير سالب بمنزلتين عشريتين",
          );
        }
        return toDbMoney(amount);
      };
      return {
        lineKey,
        variantId: line.variantId,
        productUnitId: line.productUnitId,
        quantity: quantity.toFixed(3),
        unitPriceOverride: optionalMoney(line.unitPriceOverride),
        discountAmount: optionalMoney(line.discountAmount),
        discountPercent: optionalMoney(line.discountPercent),
        promotionId: line.promotionId ?? null,
        isGift: line.isGift === true,
      };
    })
    .sort((a, b) => a.lineKey.localeCompare(b.lineKey));
  const dueDate = input.dueDate?.trim() || null;
  if (dueDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    checkoutError("تاريخ استحقاق الفاتورة الآجلة غير صالح");
  }
  const notes = input.notes?.trim() || null;
  if (notes != null && notes.length > 5_000) {
    checkoutError("ملاحظات الفاتورة تتجاوز 5000 محرف");
  }
  return {
    customerId: input.customerId ?? null,
    priceTier: input.priceTier ?? null,
    dueDate,
    notes,
    regularLines,
  };
}

export function checkoutRequestFingerprint(
  input: CheckoutSnapshotInput,
): string {
  return createHash("sha256")
    .update(
      [
        JSON.stringify(normalizedRequest(input)),
        input.sourceType ?? "POS",
        JSON.stringify(input.sourcePayload ?? {}),
      ].join("|"),
    )
    .digest("hex");
}

/** Replay is bound to submitted fields without repricing an already prepared sale. */
export function assertCheckoutReplay(
  snapshot: DigitalCheckoutSnapshot | null,
  input: CheckoutSnapshotInput,
): void {
  if (snapshot == null) {
    if (
      input.customerId != null ||
      input.priceTier != null ||
      input.regularLines?.length
    ) {
      checkoutError(
        "الطلب القديم لا يحمل لقطة لهذه الأصناف أو لهذا العميل",
        "CONFLICT",
      );
    }
    return;
  }
  if (
    snapshot.version !== 1 ||
    snapshot.requestFingerprint !== checkoutRequestFingerprint(input)
  ) {
    checkoutError(
      "نفس مفتاح الطلب يخص عميلاً أو أسعاراً أو بنوداً مختلفة",
      "CONFLICT",
    );
  }
}

export async function prepareCheckoutSnapshot(
  tx: Tx,
  input: CheckoutSnapshotInput,
  actor: Actor,
): Promise<DigitalCheckoutSnapshot> {
  const request = normalizedRequest(input);
  let customerTier: PriceTier | null = null;
  if (request.customerId != null) {
    const [customer] = await tx
      .select({
        defaultPriceTier: customers.defaultPriceTier,
        isActive: customers.isActive,
      })
      .from(customers)
      .where(eq(customers.id, request.customerId))
      .for("update")
      .limit(1);
    if (!customer || customer.isActive !== true)
      checkoutError("العميل غير موجود أو معطّل");
    customerTier = customer.defaultPriceTier as PriceTier;
  }
  const priceTier = resolveTier({ override: request.priceTier, customerTier });
  const regularLines: DigitalCheckoutSnapshot["regularLines"] = [];
  let inventoryReservations: DigitalCheckoutInventoryReservationSnapshot[] = [];
  let pricingGuard: DigitalCheckoutPricingGuardSnapshot = {
    paidCostTotal: "0.00",
    giftCostTotal: "0.00",
    paidLineBelowCost: false,
    manualLineDiscountGate: false,
    referenceGrossTotal: "0.00",
  };
  if (request.regularLines.length) {
    const branchId = input.branchId ?? actor.branchId;
    if (branchId == null) checkoutError("الفرع غير محدد لفحص مخزون السلة");
    const variantIds = Array.from(
      new Set(request.regularLines.map((line) => line.variantId)),
    );
    const variants = await tx
      .select({
        id: productVariants.id,
        productId: productVariants.productId,
        categoryId: products.categoryId,
        active: productVariants.isActive,
        productActive: products.isActive,
        productType: products.productType,
        name: products.name,
        isService: products.isService,
        isBundle: products.isBundle,
        allowBackorder: products.allowBackorder,
        costPrice: productVariants.costPrice,
      })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(inArray(productVariants.id, variantIds));
    const byId = new Map(
      variants.map((variant) => [Number(variant.id), variant]),
    );
    const requestedUnitIds = Array.from(
      new Set(request.regularLines.map((line) => line.productUnitId)),
    );
    const unitRows = await tx
      .select({
        id: productUnits.id,
        variantId: productUnits.variantId,
        isActive: productUnits.isActive,
        isBaseUnit: productUnits.isBaseUnit,
      })
      .from(productUnits)
      .where(inArray(productUnits.id, requestedUnitIds));
    const unitById = new Map(
      unitRows.map((unit) => [Number(unit.id), unit]),
    );
    const baseByLine = new Map<string, number>();
    let referenceGrossTotal = money(0);
    let manualLineDiscountGate = false;
    const exemptPromoLossByKey = new Map<string, boolean>();
    const contracts =
      request.customerId == null
        ? new Map<number, string>()
        : await resolveContractPrices(
            tx,
            request.customerId,
            request.regularLines.map((line) => line.productUnitId),
          );
    const preRegular: Array<{
      line: DigitalCheckoutRegularLineInput;
      variant: NonNullable<ReturnType<typeof byId.get>>;
      unit: NonNullable<ReturnType<typeof unitById.get>>;
      contractPrice: string | undefined;
      reference: Decimal | null;
      price: Decimal;
      priced: ReturnType<typeof computeLineTotal>;
    }> = [];
    for (const line of request.regularLines) {
      const variant = byId.get(line.variantId);
      if (
        !variant ||
        variant.active !== true ||
        variant.productActive !== true
      )
        checkoutError("صنف عادي غير موجود أو معطّل");
      const unit = unitById.get(line.productUnitId);
      if (
        !unit ||
        Number(unit.variantId) !== line.variantId ||
        unit.isActive !== true
      ) {
        checkoutError("وحدة الصنف العادي غير موجودة أو معطّلة");
      }
      if (variant.productType === "DIGITAL_CARD")
        checkoutError(
          "الكرت الرقمي لا يقبل ضمن البنود العادية؛ أضفه من مجموعة المزوّد",
        );
      const { baseQuantity } = await convertToBaseQuantity(
        tx,
        line.productUnitId,
        line.quantity,
        line.variantId,
      );
      baseByLine.set(line.lineKey, baseQuantity);
      const contractPrice = contracts.get(line.productUnitId);
      const reference =
        contractPrice == null
          ? await tryGetUnitPrice(tx, line.productUnitId, priceTier)
          : money(contractPrice);
      const price =
        line.unitPriceOverride == null
          ? (reference ??
            (await getUnitPrice(tx, line.productUnitId, priceTier)))
          : money(line.unitPriceOverride);
      const priced = computeLineTotal(
        line.isGift
          ? { unitPrice: money(0), quantity: money(line.quantity) }
          : {
              unitPrice: price,
              quantity: money(line.quantity),
              discountAmount: line.discountAmount,
              discountPercent: line.discountPercent,
            },
      );
      preRegular.push({
        line,
        variant,
        unit,
        contractPrice,
        reference,
        price,
        priced,
      });
    }

    const authPromoByIdx = new Map<
      number,
      {
        promotionId: number;
        discountAmount: Decimal;
        refDiscountAmount: Decimal;
        allowBelowCost: boolean;
      }
    >();
    const hasUpwardPriceOverride = preRegular.some(
      (item) =>
        item.line.isGift !== true &&
        item.reference != null &&
        item.reference.gt(0) &&
        item.price.gt(item.reference),
    );
    const claimedPromoIds = Array.from(
      new Set(
        preRegular
          .map((item) =>
            item.line.promotionId != null ? Number(item.line.promotionId) : null,
          )
          .filter((pid): pid is number => pid != null && pid > 0),
      ),
    );
    if (claimedPromoIds.length > 0) {
      const todayYmd = new Date(Date.now() + 3 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      const promoMetaRows = await tx
        .select({
          id: promotions.id,
          isActive: promotions.isActive,
          allowBelowCost: promotions.allowBelowCost,
        })
        .from(promotions)
        .where(inArray(promotions.id, claimedPromoIds));
      const promoMetaById = new Map(
        promoMetaRows.map((r) => [Number(r.id), r]),
      );
      const autoSnapshot = await loadPromotionRuleSnapshot(tx, {
        branchId,
        customerTier: priceTier,
        todayYmd,
        includeStoreManaged: false,
        evaluationChannel: "POS",
        requiredApplicationMode: "AUTO",
      });
      const allAutoRules = snapshotToEngineRules(autoSnapshot);
      const buildEvalItems = (useRefCap: boolean): CartEvalItem[] =>
        preRegular.map((item, idx) => {
          const claimedPid =
            item.line.promotionId != null
              ? Number(item.line.promotionId)
              : null;
          const refUnit = item.reference ?? money(0);
          const hasUnclaimedPriceOverride =
            (claimedPid == null || claimedPid <= 0) &&
            refUnit.gt(0) &&
            !item.price.eq(refUnit) &&
            !item.price.eq(refUnit.toDecimalPlaces(0, Decimal.ROUND_HALF_UP));
          const evalPrice =
            useRefCap && refUnit.gt(0)
              ? Decimal.min(item.price, refUnit)
              : item.price;
          return {
            lineKey: String(idx),
            productId: Number(item.variant.productId),
            variantId: item.line.variantId,
            productUnitId: item.line.productUnitId,
            categoryId:
              item.variant.categoryId == null
                ? null
                : Number(item.variant.categoryId),
            unitPrice: evalPrice.toFixed(2),
            quantity: money(item.line.quantity).toNumber(),
            isBaseUnit: Boolean(item.unit.isBaseUnit),
            hasContractPrice:
              item.contractPrice != null || hasUnclaimedPriceOverride,
            isBundle: Boolean(item.variant.isBundle),
            isGift: item.line.isGift === true,
            isService: Boolean(item.variant.isService),
          };
        });
      const evalCtx = {
        branchId,
        customerTier: priceTier,
        channel: "POS" as const,
        todayYmd,
      };
      const autoEval = evaluateCartPromotions(
        buildEvalItems(false),
        allAutoRules,
        evalCtx,
      );
      const refAutoEval = hasUpwardPriceOverride
        ? evaluateCartPromotions(buildEvalItems(true), allAutoRules, evalCtx)
        : autoEval;
      for (const alloc of Array.from(autoEval.lineAllocations.values())) {
        const lineIdx = Number(alloc.lineKey);
        const claimedPid = Number(preRegular[lineIdx]?.line.promotionId);
        if (claimedPid !== alloc.promotionId) continue;
        const meta = promoMetaById.get(alloc.promotionId);
        if (!meta || !meta.isActive) continue;
        const disc = money(alloc.discountAmount.toFixed(2));
        if (disc.gt(0) && !authPromoByIdx.has(lineIdx)) {
          const refAlloc = refAutoEval.lineAllocations.get(alloc.lineKey);
          const refDisc =
            refAlloc && refAlloc.promotionId === alloc.promotionId
              ? Decimal.min(disc, money(refAlloc.discountAmount.toFixed(2)))
              : money(0);
          authPromoByIdx.set(lineIdx, {
            promotionId: alloc.promotionId,
            discountAmount: disc,
            refDiscountAmount: refDisc,
            allowBelowCost: meta.allowBelowCost === true,
          });
        }
      }
    }

    for (let idx = 0; idx < preRegular.length; idx++) {
      const { line, variant, reference, price, priced } = preRegular[idx]!;
      const authPromo = !line.isGift ? authPromoByIdx.get(idx) : undefined;
      const recordedPromoDiscount =
        authPromo && authPromo.discountAmount.gt(0)
          ? Decimal.max(
              money(0),
              Decimal.min(money(priced.discountAmount), authPromo.discountAmount),
            )
          : money(0);
      const recordedRefPromoDiscount = authPromo
        ? Decimal.min(recordedPromoDiscount, authPromo.refDiscountAmount)
        : money(0);
      const refUnit = reference ?? money(0);
      const lineRefAfterPromo = Decimal.max(
        money(0),
        refUnit.times(money(line.quantity)).minus(recordedRefPromoDiscount),
      );
      // The native sale repeats all pricing/cost/stock gates under its own locks at commit.
      const lineNeedsApproval =
        !line.isGift &&
        lineDiscountExceedsThreshold(lineRefAfterPromo, money(1), priced.total);
      if (!line.isGift) {
        referenceGrossTotal = referenceGrossTotal.plus(lineRefAfterPromo);
        manualLineDiscountGate ||= lineNeedsApproval;
      }
      if (
        lineNeedsApproval &&
        actor.role !== "admin" &&
        input.priceApprovalCapability !== VERIFIED_DIGITAL_PRICE_APPROVAL
      ) {
        checkoutError(`خصم «${variant.name}» يتطلب موافقة مدير`, "FORBIDDEN");
      }
      const hasExtraManualDiscount = money(priced.discountAmount).gt(
        recordedPromoDiscount,
      );
      const hasManualPriceReduction = price.lt(refUnit);
      exemptPromoLossByKey.set(
        line.lineKey,
        Boolean(
          !line.isGift &&
            authPromo?.allowBelowCost === true &&
            recordedPromoDiscount.gt(0) &&
            !hasExtraManualDiscount &&
            !hasManualPriceReduction,
        ),
      );
      regularLines.push({
        lineKey: line.lineKey,
        variantId: line.variantId,
        productUnitId: line.productUnitId,
        quantity: priced.quantity,
        unitPrice: priced.unitPrice,
        discountAmount: priced.discountAmount,
        total: priced.total,
        promotionId: authPromo ? authPromo.promotionId : null,
        isGift: line.isGift === true,
      });
    }
    const requestedStock = new Map<
      number,
      { quantity: number; requiresOwnedStock: boolean }
    >();
    const reservationBySourceStock = new Map<
      string,
      DigitalCheckoutInventoryReservationSnapshot
    >();
    // كل مصدر عادي يقفل معنى كتالوجه حتى لو كان عمالة صرفة أو backorder بلا حجز كمية.
    for (const line of regularLines) {
      reservationBySourceStock.set(`${line.variantId}:${line.variantId}`, {
        sourceVariantId: line.variantId,
        stockVariantId: line.variantId,
        demandedBase: 0,
        reservedBase: 0,
      });
    }
    const addRequestedStock = (
      sourceVariantId: number,
      variantId: number,
      quantity: number,
      requiresOwnedStock: boolean,
      label: string,
    ) => {
      if (!isQuantity(quantity) || quantity <= 0) {
        checkoutError(`كمية ${label} غير قابلة للتتبع بوحدة الأساس`);
      }
      const current = requestedStock.get(variantId);
      let total: number;
      try {
        total = addQuantities(current?.quantity ?? 0, quantity);
      } catch {
        checkoutError(`إجمالي كمية ${label} يتجاوز الحد الآمن`);
      }
      requestedStock.set(variantId, {
        quantity: total,
        requiresOwnedStock:
          requiresOwnedStock || (current?.requiresOwnedStock ?? false),
      });
      const reservationKey = `${sourceVariantId}:${variantId}`;
      const reservation = reservationBySourceStock.get(reservationKey);
      reservationBySourceStock.set(reservationKey, {
        sourceVariantId,
        stockVariantId: variantId,
        demandedBase: addQuantities(reservation?.demandedBase ?? 0, quantity),
        reservedBase: 0,
      });
    };
    const bundleVariantIds = variants
      .filter((variant) => variant.isBundle === true)
      .map((variant) => Number(variant.id));
    const bundleDefinitions = await getBundleDefinitions(tx, bundleVariantIds);
    const bundleCosts = await computeBundleUnitCosts(
      tx,
      bundleVariantIds,
      bundleDefinitions,
    );
    // Mirrors sale/create.ts's computeServiceUnitCost (recipe load + per-line formula)
    // exactly, so the below-cost/gift-threshold checks below see the same service cost
    // createSaleInTx enforces at commit instead of silently skipping service lines.
    const serviceVariantIds = variants
      .filter((variant) => variant.isService && !variant.isBundle)
      .map((variant) => Number(variant.id));
    const serviceRecipes = await loadServiceRecipeDefinitions(tx, serviceVariantIds);
    const materialCostByVariant = new Map<number, string>();
    const serviceMaterialIds = new Set<number>();
    if (serviceRecipes.size) {
      for (const recipe of Array.from(serviceRecipes.values())) {
        for (const rl of recipe.lines) serviceMaterialIds.add(rl.inputVariantId);
      }
      if (serviceMaterialIds.size) {
        const matRows = await tx
          .select({
            id: productVariants.id,
            cost: productVariants.costPrice,
          })
          .from(productVariants)
          .where(inArray(productVariants.id, Array.from(serviceMaterialIds)));
        for (const r of matRows) {
          materialCostByVariant.set(Number(r.id), String(r.cost ?? "0"));
        }
      }
    }
    const computeServiceUnitCost = (
      variantId: number,
      baseQuantity: number,
    ): string => {
      const recipe = serviceRecipes.get(variantId);
      if (!recipe || baseQuantity <= 0) return "0.00";
      let lineCost = money(0);
      for (const rl of recipe.lines) {
        const consumed = exactRecipeMaterialQuantity(
          rl.qtyPerOutputBase,
          baseQuantity,
          `مادة الوصفة #${rl.inputVariantId}`,
        );
        const matCost = round2(
          money(materialCostByVariant.get(rl.inputVariantId) ?? "0"),
        );
        lineCost = lineCost.plus(round2(matCost.times(consumed)));
      }
      return round2(lineCost.div(baseQuantity)).toFixed(2);
    };
    const costedLines: {
      total: string;
      unitCost: string;
      baseQuantity: number;
      isGift: boolean;
      exemptPromoLoss: boolean;
    }[] = [];
    for (const line of regularLines) {
      const variant = byId.get(line.variantId)!;
      const baseQuantity = baseByLine.get(line.lineKey)!;
      costedLines.push({
        total: line.total,
        unitCost: variant.isBundle
          ? (bundleCosts.get(line.variantId) ?? "0")
          : variant.isService
            ? computeServiceUnitCost(line.variantId, baseQuantity)
            : variant.costPrice,
        baseQuantity,
        isGift: line.isGift,
        exemptPromoLoss: exemptPromoLossByKey.get(line.lineKey) === true,
      });
      if (!variant.isService && !variant.isBundle) {
        addRequestedStock(
          line.variantId,
          line.variantId,
          baseQuantity,
          false,
          `الصنف «${variant.name}»`,
        );
      } else if (variant.isBundle === true) {
        const components = bundleDefinitions.get(line.variantId) ?? [];
        if (!components.length) {
          checkoutError(`البكج «${variant.name}» بلا مكوّنات قابلة للبيع`);
        }
        for (const component of components) {
          addRequestedStock(
            line.variantId,
            component.componentVariantId,
            component.componentBaseQuantity * baseQuantity,
            true,
            `مكوّن البكج «${variant.name}»`,
          );
        }
      } else if (variant.isService === true) {
        const recipe = serviceRecipes.get(line.variantId);
        for (const recipeLine of recipe?.lines ?? []) {
          const consumed = exactRecipeMaterialQuantity(
            recipeLine.qtyPerOutputBase,
            baseQuantity,
            `مادة الوصفة #${recipeLine.inputVariantId}`,
          );
          addRequestedStock(
            line.variantId,
            recipeLine.inputVariantId,
            consumed,
            true,
            `مادة الخدمة «${variant.name}»`,
          );
        }
      }
    }
    // اجمع الطلب الحقيقي كله قبل حجز البطاقات: بيع مباشر + وصفات الخدمات + مكوّنات
    // البكجات. فحص الخرائط المنفصلة كان يسمح لكل مسار أن ينجح منفرداً رغم أن مجموعهما
    // يتجاوز الرصيد نفسه. createSaleInTx يعيد الفحص المقفول ويبقى مصدر التثبيت الحاكم.
    if (requestedStock.size) {
      const strictStockVariantIds = new Set<number>();
      const stockVariantIds = Array.from(requestedStock.keys()).sort(
        (a, b) => a - b,
      );
      const stockRows = await tx
        .select({
          id: productVariants.id,
          variantActive: productVariants.isActive,
          productActive: products.isActive,
          name: products.name,
          isService: products.isService,
          isBundle: products.isBundle,
          isConsignment: products.isConsignment,
          allowBackorder: products.allowBackorder,
        })
        .from(productVariants)
        .innerJoin(products, eq(productVariants.productId, products.id))
        .where(inArray(productVariants.id, stockVariantIds));
      const stockById = new Map(
        stockRows.map((row) => [Number(row.id), row]),
      );
      const availability = await loadVariantAvailability(
        tx,
        branchId,
        stockVariantIds,
      );
      for (const [variantId, demand] of Array.from(requestedStock.entries())) {
        const stock = stockById.get(variantId);
        if (
          !stock ||
          stock.variantActive !== true ||
          stock.productActive !== true
        ) {
          checkoutError(`المادة المخزنية #${variantId} غير موجودة أو معطّلة`);
        }
        if (
          demand.requiresOwnedStock &&
          (stock.isService === true ||
            stock.isBundle === true ||
            stock.isConsignment === true)
        ) {
          checkoutError(
            `«${stock.name}» لا تصلح مادة خدمة أو مكوّن بكج مخزنياً مملوكاً`,
          );
        }
        if (
          !demand.requiresOwnedStock &&
          stock.allowBackorder === true
        ) {
          continue;
        }
        const available = availability.get(variantId);
        if (!available?.hasStockRow) {
          checkoutError(
            `لا يوجد رصيد مخزون مسجل لـ«${stock.name}» في الفرع`,
            "CONFLICT",
          );
        }
        if (demand.quantity > available.availableBase) {
          checkoutError(
            `المخزون غير كافٍ لـ«${stock.name}»: المتاح ${available.availableBase} والمطلوب ${demand.quantity} وحدة أساس`,
            "CONFLICT",
          );
        }
        strictStockVariantIds.add(variantId);
      }
      inventoryReservations = Array.from(reservationBySourceStock.values())
        .map((reservation) => ({
          ...reservation,
          reservedBase: strictStockVariantIds.has(reservation.stockVariantId)
            ? reservation.demandedBase
            : 0,
        }))
        .sort(
          (a, b) =>
            a.sourceVariantId - b.sourceVariantId ||
            a.stockVariantId - b.stockVariantId,
        );
    } else {
      inventoryReservations = Array.from(reservationBySourceStock.values()).sort(
        (a, b) =>
          a.sourceVariantId - b.sourceVariantId ||
          a.stockVariantId - b.stockVariantId,
      );
    }
    const paid = costedLines.filter((line) => !line.isGift);
    const gifts = costedLines.filter((line) => !line.isGift === false);
    const paidSubtotal = toDbMoney(sumMoney(paid.map((line) => line.total)));
    const effectivePaidCostFloor = toDbMoney(
      round2(
        paid.reduce((sum, line) => {
          const lineCost = round2(
            money(line.unitCost).times(line.baseQuantity),
          );
          return sum.plus(
            line.exemptPromoLoss
              ? Decimal.min(lineCost, money(line.total))
              : lineCost,
          );
        }, money(0)),
      ),
    );
    const giftCostTotal = computeInvoiceCost(gifts);
    const paidLineBelowCost = paid.some(
      (line) =>
        !line.exemptPromoLoss &&
        money(line.total).lt(money(line.unitCost).times(line.baseQuantity)),
    );
    pricingGuard = {
      paidCostTotal: effectivePaidCostFloor,
      giftCostTotal,
      paidLineBelowCost,
      manualLineDiscountGate,
      referenceGrossTotal: toDbMoney(referenceGrossTotal),
    };
    const carriesVerifiedApproval =
      input.priceApprovalCapability === VERIFIED_DIGITAL_PRICE_APPROVAL;
    if (
      actor.role !== "admin" &&
      !carriesVerifiedApproval
    ) {
      if (
        paidLineBelowCost ||
        money(paidSubtotal).lt(money(effectivePaidCostFloor))
      ) {
        checkoutError("بيع بأقل من التكلفة يتطلب موافقة مدير", "FORBIDDEN");
      }
      if (
        money(giftCostTotal).gt(money(GIFT_APPROVAL_THRESHOLD))
      ) {
        checkoutError(
          "تكلفة الهدايا تتجاوز حد الإهداء بلا تفويض؛ يتطلب موافقة مدير",
          "FORBIDDEN",
        );
      }
    }
  }
  return {
    version: 1,
    customerId: request.customerId,
    priceTier,
    regularLines,
    inventoryReservations,
    priceOverrideApproved:
      actor.role === "admin" ||
      input.priceApprovalCapability === VERIFIED_DIGITAL_PRICE_APPROVAL,
    priceApprovedBy: input.priceApprovedBy ?? null,
    pricingGuard,
    expectedSubtotal: toDbMoney(
      sumMoney(regularLines.map((line) => line.total)),
    ),
    dueDate: request.dueDate,
    notes: request.notes,
    requestFingerprint: checkoutRequestFingerprint(input),
    sourceType: input.sourceType,
    sourcePayload: input.sourcePayload,
  };
}

/** Explicit allowlist: ordinary lines always use live WAVG, never a stored/client cost. */
export function checkoutSnapshotToSaleLines(
  snapshot: DigitalCheckoutSnapshot | null,
): SaleLineInput[] {
  if (snapshot == null) return [];
  if (snapshot.version !== 1)
    checkoutError("إصدار لقطة السلة غير معروف", "CONFLICT");
  return snapshot.regularLines.map((line) => ({
    variantId: line.variantId,
    productUnitId: line.productUnitId,
    quantity: line.quantity,
    unitPriceOverride: line.unitPrice,
    discountAmount: line.discountAmount,
    promotionId: line.promotionId,
    isGift: line.isGift,
  }));
}
