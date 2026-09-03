/** Durable public-price snapshot for ordinary lines travelling with digital cards. */
import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import { customers, products, productVariants } from "../../../drizzle/schema";
import type {
  DigitalCheckoutRegularLineInput,
  DigitalCheckoutSnapshot,
} from "../../../shared/digitalSale";
import { appErrorMessage } from "../../../shared/errors";
import type { Tx } from "../../db";
import { computeLineTotal, lineDiscountExceedsThreshold } from "../billing";
import { resolveContractPrices } from "../contractPriceService";
import { convertToBaseQuantity } from "../inventoryService";
import { money, sumMoney, toDbMoney } from "../money";
import {
  getUnitPrice,
  resolveTier,
  tryGetUnitPrice,
  type PriceTier,
} from "../pricing";
import type { SaleLineInput } from "../sale/types";
import type { Actor } from "../tx";

export interface CheckoutSnapshotInput {
  customerId?: number | null;
  priceTier?: PriceTier | null;
  regularLines?: DigitalCheckoutRegularLineInput[];
}

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
  return {
    customerId: input.customerId ?? null,
    priceTier: input.priceTier ?? null,
    regularLines,
  };
}

export function checkoutRequestFingerprint(
  input: CheckoutSnapshotInput,
): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizedRequest(input)))
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
      .limit(1);
    if (!customer || customer.isActive === false)
      checkoutError("العميل غير موجود أو معطّل");
    customerTier = customer.defaultPriceTier as PriceTier;
  }
  const priceTier = resolveTier({ override: request.priceTier, customerTier });
  const regularLines: DigitalCheckoutSnapshot["regularLines"] = [];
  if (request.regularLines.length) {
    const variantIds = Array.from(
      new Set(request.regularLines.map((line) => line.variantId)),
    );
    const variants = await tx
      .select({
        id: productVariants.id,
        active: productVariants.isActive,
        productActive: products.isActive,
        productType: products.productType,
        name: products.name,
      })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(inArray(productVariants.id, variantIds));
    const byId = new Map(
      variants.map((variant) => [Number(variant.id), variant]),
    );
    const contracts =
      request.customerId == null
        ? new Map<number, string>()
        : await resolveContractPrices(
            tx,
            request.customerId,
            request.regularLines.map((line) => line.productUnitId),
          );
    for (const line of request.regularLines) {
      const variant = byId.get(line.variantId);
      if (
        !variant ||
        variant.active === false ||
        variant.productActive === false
      )
        checkoutError("صنف عادي غير موجود أو معطّل");
      if (variant.productType === "DIGITAL_CARD")
        checkoutError(
          "الكرت الرقمي لا يقبل ضمن البنود العادية؛ أضفه من مجموعة المزوّد",
        );
      await convertToBaseQuantity(
        tx,
        line.productUnitId,
        line.quantity,
        line.variantId,
      );
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
      // The native sale repeats all pricing/cost/stock gates under its own locks at commit.
      if (
        !line.isGift &&
        actor.role !== "admin" &&
        actor.role !== "manager" &&
        lineDiscountExceedsThreshold(
          reference ?? money(0),
          money(line.quantity),
          priced.total,
        )
      ) {
        checkoutError(`خصم «${variant.name}» يتطلب موافقة مدير`, "FORBIDDEN");
      }
      regularLines.push({
        lineKey: line.lineKey,
        variantId: line.variantId,
        productUnitId: line.productUnitId,
        quantity: priced.quantity,
        unitPrice: priced.unitPrice,
        discountAmount: priced.discountAmount,
        total: priced.total,
        promotionId: line.promotionId,
        isGift: line.isGift,
      });
    }
  }
  return {
    version: 1,
    customerId: request.customerId,
    priceTier,
    regularLines,
    expectedSubtotal: toDbMoney(
      sumMoney(regularLines.map((line) => line.total)),
    ),
    requestFingerprint: checkoutRequestFingerprint(input),
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
