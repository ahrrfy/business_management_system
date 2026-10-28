// Reservation-to-sale conversion is a single transaction: invoice, stock reservation release,
// and reservation lifecycle transition commit or roll back together.
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { customers, invoiceItems, invoices, productPrices, products, productUnits, productVariants, reservationEvents, reservationLines, reservations, shifts } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { computeInvoiceTotals, computeLineTotal } from "../billing";
import { resolveContractPrices } from "../contractPriceService";
import { idempotencyHash } from "../idempotency";
import { money, toDbMoney } from "../money";
import { getUnitPrice, resolveTier, type PriceTier } from "../pricing";
import { createSaleInTx, notifySaleCustomerAfterCommit } from "../sale/create";
import { logger } from "../../logger";
import type { PaymentMethod } from "../sale/types";
import { openShiftIdTx } from "../shiftService";
import { assertPosPaymentMethodEnabled } from "../posPaymentPolicy";
import { withTx, type Actor } from "../tx";
import { assertReservationBranch, CLOSEABLE_STATUSES } from "./helpers";
import { adjustReservedStock } from "./stock";

export interface ConvertReservationInput {
  reservationId: number;
  /** وردية مساحة العمل النشطة إن عُرفَت في الواجهة (الاستقبال يمرّر RECEPTION صراحةً). */
  shiftId?: number | null;
  payment?: { amount: string; method: PaymentMethod; reference?: string | null } | null;
  /** Required at the public boundary; optional for existing trusted internal callers. */
  pricingConfirmation?: { fingerprint: string; total: string };
}

function conversionConflict(why: string) {
  return new TRPCError({ code: "CONFLICT", message: appErrorMessage({
    what: "تعذّر تأكيد تحويل الحجز",
    why,
    doThis: "حدّث معاينة الحجز وراجع إجمالي التنفيذ ثم أكّد من جديد، أو افتح الفاتورة المرتبطة بالحجز المنفّذ",
  }) });
}

function conversionRequest(input: ConvertReservationInput, actor: Actor) {
  return {
    reservationId: input.reservationId,
    userId: actor.userId,
    shiftId: input.shiftId === undefined ? "AUTO" : input.shiftId,
    payment: input.payment ? {
      amount: toDbMoney(input.payment.amount), method: input.payment.method,
      reference: input.payment.reference?.trim() || null,
    } : null,
    pricingConfirmation: input.pricingConfirmation ?? null,
  };
}

async function conversionPricing(tx: Tx, res: typeof reservations.$inferSelect, input: ConvertReservationInput, actor: Actor, currentRead = false) {
  const lineQuery = tx.select().from(reservationLines)
    .where(eq(reservationLines.reservationId, Number(res.id))).orderBy(asc(reservationLines.id));
  const rawLines = currentRead ? await lineQuery.for("update") : await lineQuery;
  const remaining = rawLines.filter((line) => line.baseQuantity > line.fulfilledBase);
  if (!remaining.length) throw conversionConflict("لا كميات متبقّية للتحويل");
  const customer = res.customerId != null
    ? (await tx.select({ id: customers.id, tier: customers.defaultPriceTier, creditLimit: customers.creditLimit, currentBalance: customers.currentBalance })
      .from(customers).where(eq(customers.id, Number(res.customerId))).for("update").limit(1))[0]
    : null;
  const tier = resolveTier({ customerTier: customer?.tier as PriceTier | undefined });
  const unitQuery = tx.select({ unit: productUnits, productName: products.name })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(inArray(productUnits.variantId, Array.from(new Set(remaining.map((line) => Number(line.variantId))))));
  const units = currentRead ? await unitQuery.for("update") : await unitQuery;
  const baseUnits = new Map(units.filter((row) => row.unit.isBaseUnit).map((row) => [Number(row.unit.variantId), row]));
  const contracts = res.customerId != null
    ? await resolveContractPrices(tx, Number(res.customerId), Array.from(baseUnits.values()).map((row) => Number(row.unit.id)), { forUpdate: currentRead })
    : new Map<number, string>();
  const currentPrices = currentRead ? await tx.select({ unitId: productPrices.productUnitId, price: productPrices.price })
    .from(productPrices).where(and(inArray(productPrices.productUnitId, Array.from(baseUnits.values()).map((row) => Number(row.unit.id))), eq(productPrices.priceTier, tier)))
    .orderBy(asc(productPrices.productUnitId)).for("update") : [];
  const currentPriceMap = new Map(currentPrices.map((row) => [Number(row.unitId), row.price]));
  let reference = money(0);
  let hasUnpriced = false;
  const lines = [];
  for (const line of remaining) {
    const base = baseUnits.get(Number(line.variantId));
    if (!base) throw conversionConflict(`لا وحدة أساس للمتغيّر ${line.variantId}`);
    const quantity = line.baseQuantity - line.fulfilledBase;
    const lockedPrice = contracts.get(Number(base.unit.id)) ?? currentPriceMap.get(Number(base.unit.id));
    if (currentRead && lockedPrice == null) throw conversionConflict("أُزيل سعر التنفيذ أثناء التحويل");
    const unitPrice = lockedPrice != null ? money(lockedPrice) : await getUnitPrice(tx, Number(base.unit.id), tier);
    const computed = computeLineTotal({ unitPrice, quantity: money(quantity) });
    const original = units.find((row) => Number(row.unit.id) === Number(line.productUnitId));
    if (line.quotedUnitPrice == null || !original) hasUnpriced = true;
    else reference = reference.plus(money(line.quotedUnitPrice).times(quantity).div(original.unit.conversionFactor));
    lines.push({ lineId: Number(line.id), variantId: Number(line.variantId), productUnitId: Number(base.unit.id),
      productName: base.productName, unitName: base.unit.unitName, baseQuantity: quantity,
      unitPrice: computed.unitPrice, lineTotal: computed.total });
  }
  const total = computeInvoiceTotals({ lineTotals: lines.map((line) => line.lineTotal) }).total;
  // The request excludes its own confirmation when deriving the preview fingerprint.
  const request = conversionRequest({ ...input, pricingConfirmation: undefined }, actor);
  return { reservationId: Number(res.id), total, lines,
    referenceTotal: hasUnpriced ? null : toDbMoney(reference),
    difference: hasUnpriced ? null : toDbMoney(money(total).minus(reference)),
    fingerprint: idempotencyHash({ request, branchId: Number(res.branchId), customerId: res.customerId,
      status: res.status, expiresAt: res.expiresAt, customer, rawLines, lines, total }),
  };
}

export async function previewReservationConversion(input: ConvertReservationInput, actor: Actor) {
  return withTx(async (tx) => {
    const res = (await tx.select().from(reservations).where(eq(reservations.id, input.reservationId)).limit(1))[0];
    if (!res) throw new TRPCError({ code: "NOT_FOUND", message: appErrorMessage({ what: "الحجز غير موجود", why: "تعذّر العثور على الحجز المطلوب", doThis: "حدّث قائمة الحجوزات واختر حجزاً موجوداً" }) });
    assertReservationBranch(res, actor);
    if (!CLOSEABLE_STATUSES.includes(res.status as typeof CLOSEABLE_STATUSES[number]) || new Date(res.expiresAt).getTime() <= Date.now()) {
      throw conversionConflict("الحجز منتهٍ أو تغيّرت حالته؛ راجع الفاتورة المرتبطة إن كان منفّذاً");
    }
    return conversionPricing(tx, res, input, actor);
  });
}

export interface ConvertReservationResult {
  reservationId: number;
  invoiceId: number;
  invoiceNumber: string;
  shiftId: number | null;
  total: string;
  status: "PENDING" | "PARTIALLY_PAID" | "PAID";
  idempotentReplay?: boolean;
}

export async function convertReservationToSale(input: ConvertReservationInput, actor: Actor): Promise<ConvertReservationResult> {
  // التحويل يخصم مخزوناً وينشئ فاتورة/إيصالاً؛ الحارس يسبق أي قراءة أو قفل.
  if (input.payment) assertPosPaymentMethodEnabled(input.payment.method);
  if (input.payment && input.payment.method !== "CASH" && !input.payment.reference?.trim()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "مرجع الدفع غير النقدي مطلوب" });
  }

  const result = await withTx(async (tx) => {
    // نقرأ مرشح الفرع أولاً، ثم نقفل الحجوزات النشطة كلها بترتيب id ثابت. بذلك تكون
    // أولوية FIFO قابلة للحساب تحت قفل واحد ولا يستطيع تحويل B الأحدث تجاوز A الأقدم.
    const candidate = (await tx.select().from(reservations)
      .where(eq(reservations.id, input.reservationId)).limit(1))[0];
    if (!candidate) throw new TRPCError({ code: "NOT_FOUND", message: "الحجز غير موجود" });
    assertReservationBranch(candidate, actor);
    const lockedReservations = await tx.select().from(reservations)
      .where(and(
        eq(reservations.branchId, Number(candidate.branchId)),
        or(
          eq(reservations.id, input.reservationId),
          inArray(reservations.status, [...CLOSEABLE_STATUSES]),
        ),
      ))
      .orderBy(asc(reservations.id))
      .for("update");
    const res = lockedReservations.find((row) => Number(row.id) === input.reservationId);
    if (!res) throw new TRPCError({ code: "NOT_FOUND", message: "الحجز غير موجود" });
    assertReservationBranch(res, actor);
    // Recovery precedes expiry, shift and stock validation: the original commit already happened.
    if (res.status === "FULFILLED") {
      const event = (await tx.select().from(reservationEvents).where(and(
        eq(reservationEvents.reservationId, input.reservationId), eq(reservationEvents.eventType, "FULFILL"),
      )).orderBy(asc(reservationEvents.id)).for("update").limit(1))[0];
      let saved: { requestHash?: string; result?: ConvertReservationResult } | undefined;
      try { saved = JSON.parse(event?.note ?? ""); } catch { /* Legacy conversions have no safe replay contract. */ }
      const invoice = res.fulfilledInvoiceId != null
        ? (await tx.select().from(invoices).where(eq(invoices.id, Number(res.fulfilledInvoiceId))).for("update").limit(1))[0] : null;
      if (!invoice || Number(invoice.branchId) !== Number(res.branchId) || invoice.sourceType !== "ORDER" ||
        invoice.sourceId !== `RES-${res.id}` || saved?.requestHash !== idempotencyHash(conversionRequest(input, actor)) ||
        !saved.result || saved.result.invoiceId !== Number(res.fulfilledInvoiceId)) {
        throw conversionConflict(`الحجز منفّذ بالفاتورة ${res.fulfilledInvoiceId ?? "غير المتاحة"}، وحمولة الاسترداد أو رابط الأصل لا يطابقان التنفيذ المسجّل`);
      }
      return { result: { ...saved.result, idempotentReplay: true }, notificationInput: null };
    }
    if (res.status !== "ACTIVE" && res.status !== "PARTIALLY_FULFILLED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: `لا يمكن تحويل حجز حالته ${res.status}` });
    }
    if (new Date(res.expiresAt).getTime() <= Date.now()) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "انتهت مدّة الحجز — لا يمكن تحويله" });
    }

    const lines = await tx.select().from(reservationLines).where(eq(reservationLines.reservationId, input.reservationId));
    const remaining = lines.filter((line) => line.baseQuantity - line.fulfilledBase > 0);
    if (!remaining.length) throw new TRPCError({ code: "BAD_REQUEST", message: "لا كميات متبقّية للتحويل" });

    // مساحة الاستقبال قد تتعايش مع وردية RETAIL للفاعل نفسه؛ لذلك تمرّر الواجهة معرّف مساحة العمل
    // الفعلي. نتحقق منه تحت القفل (المستخدم/الفرع/OPEN) ولا نثق بالمدخل حتى للمدير. عند غيابه فقط
    // نستعمل قاعدة RETAIL الافتراضية للتدفق المستقل.
    let shiftId: number | null;
    if (input.shiftId === null) {
      // null صريح من مساحة عمل مضمّنة يعني «لا وردية في هذه المساحة»؛ لا نستبدله سراً
      // بورديّة RETAIL أخرى للموظف نفسه.
      shiftId = null;
    } else if (input.shiftId !== undefined) {
      const requestedShift = (await tx
        .select({ id: shifts.id, userId: shifts.userId, branchId: shifts.branchId, status: shifts.status })
        .from(shifts)
        .where(eq(shifts.id, input.shiftId))
        .for("update")
        .limit(1))[0];
      if (
        !requestedShift ||
        requestedShift.status !== "OPEN" ||
        Number(requestedShift.userId) !== Number(actor.userId) ||
        Number(requestedShift.branchId) !== Number(res.branchId)
      ) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "وردية مساحة العمل أُغلقت أو لا تخص الموظف والفرع الحاليين — أعد فتح المساحة",
        });
      }
      shiftId = Number(requestedShift.id);
    } else {
      shiftId = await openShiftIdTx(tx, actor.userId, Number(res.branchId));
    }
    if (input.payment?.method === "CASH" && money(input.payment.amount).gt(0)) {
      if (shiftId == null) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "افتح وردية أولاً لتحصيل دفعة نقدية عند التحويل" });
      }
    }
    // Preserve sale's lock order: shift precedes customer. Catalog locks remain owned by the engine.
    const pricing = input.pricingConfirmation ? await conversionPricing(tx, res, input, actor) : null;
    if (pricing && (pricing.fingerprint !== input.pricingConfirmation!.fingerprint || !money(pricing.total).eq(input.pricingConfirmation!.total))) {
      throw conversionConflict("تغيّر سعر التنفيذ أو العميل أو الكمية أو الدفع منذ المعاينة؛ لم يُثبّت التحويل");
    }

    const saleLines: Array<{ variantId: number; productUnitId: number; baseQty: number; lineId: number; toFulfilled: number }> = [];
    for (const line of remaining) {
      const baseUnit = (await tx
        .select({ id: productUnits.id })
        .from(productUnits)
        .where(and(eq(productUnits.variantId, Number(line.variantId)), eq(productUnits.isBaseUnit, true)))
        .limit(1))[0];
      if (!baseUnit) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `لا وحدة أساس للمتغيّر ${line.variantId}` });
      }
      saleLines.push({
        variantId: Number(line.variantId),
        productUnitId: Number(baseUnit.id),
        baseQty: line.baseQuantity - line.fulfilledBase,
        lineId: Number(line.id),
        toFulfilled: line.baseQuantity,
      });
    }
    const variantIds = Array.from(new Set(saleLines.map((line) => line.variantId))).sort((a, b) => a - b);
    const activeAllocationLines = await tx
      .select({
        reservationId: reservationLines.reservationId,
        variantId: reservationLines.variantId,
        baseQuantity: reservationLines.baseQuantity,
        fulfilledBase: reservationLines.fulfilledBase,
      })
      .from(reservationLines)
      .innerJoin(reservations, eq(reservationLines.reservationId, reservations.id))
      .where(and(
        eq(reservations.branchId, Number(res.branchId)),
        inArray(reservations.status, [...CLOSEABLE_STATUSES]),
        inArray(reservationLines.variantId, variantIds),
      ))
      .orderBy(asc(reservations.id), asc(reservationLines.id))
      .for("update");
    const formalReservationExemptions: Record<number, number> = {};
    for (const line of activeAllocationLines) {
      // الحجز الجاري والأحدث منه لا يسبقان الجاري في FIFO. طرحهما من aggregate
      // يبقي الحجوزات الأقدم محمية، وأي drift غير منسوب يبقى محمياً fail-closed.
      if (Number(line.reservationId) < Number(res.id)) continue;
      const variantId = Number(line.variantId);
      const remainingBase = Math.max(0, Number(line.baseQuantity) - Number(line.fulfilledBase));
      formalReservationExemptions[variantId] =
        (formalReservationExemptions[variantId] ?? 0) + remainingBase;
    }
    const sale = await createSaleInTx(tx, {
      branchId: Number(res.branchId),
      shiftId,
      customerId: res.customerId ? Number(res.customerId) : null,
      sourceType: "ORDER",
      clientRequestId: `RES-${res.id}`,
      lines: saleLines.map((line) => ({
        variantId: line.variantId,
        productUnitId: line.productUnitId,
        quantity: String(line.baseQty),
      })),
      payment: input.payment ?? null,
      notes: `محوّل من الحجز ${res.reservationNumber}`,
      // الحجز وعدٌ لعميل محدد: لا يرث سماح السالب المؤقت لـORDER في وضع الافتتاح. يفحص
      // applyMovement الرصيد تحت قفله وفي ترتيب نواة البيع، فيغلق سباق refetch→commit أيضاً.
      strictStock: true,
      formalReservationExemptions,
    }, actor);

    // The engine remains the execution authority. A mismatch rolls back invoice, stock, receipts,
    // accounting and queued post-commit hooks together, even if a pricing dependency drifted.
    if (pricing) {
      // Current reads after the engine's catalog locks also catch updates committed since the
      // transaction's initial snapshot, without inverting catalog -> price lock order.
      const currentPricing = await conversionPricing(tx, res, input, actor, true);
      if (idempotencyHash(currentPricing.lines) !== idempotencyHash(pricing.lines) || currentPricing.total !== pricing.total) {
        throw conversionConflict("تغيّر السعر الحالي أثناء التنفيذ؛ أُعيدت المعاملة كاملة دون تثبيت التحويل");
      }
      const billed = await tx.select({ variantId: invoiceItems.variantId, productUnitId: invoiceItems.productUnitId,
        baseQuantity: invoiceItems.baseQuantity, unitPrice: invoiceItems.unitPrice, total: invoiceItems.total })
        .from(invoiceItems).where(eq(invoiceItems.invoiceId, sale.invoiceId));
      const expected = pricing.lines.map((line) => ({ variantId: line.variantId, productUnitId: line.productUnitId,
        baseQuantity: line.baseQuantity, unitPrice: line.unitPrice, total: line.lineTotal }));
      const sort = <T extends { variantId: number; productUnitId: number | null }>(rows: T[]) =>
        rows.sort((a, b) => a.variantId - b.variantId || (a.productUnitId ?? 0) - (b.productUnitId ?? 0));
      if (!money(sale.total).eq(pricing.total) || idempotencyHash(sort(billed)) !== idempotencyHash(sort(expected))) {
        throw conversionConflict("تغيّر تسعير الفاتورة أثناء التنفيذ؛ أُعيدت المعاملة كاملة دون أثر مالي أو مخزني");
      }
    }

    const conversionResult: ConvertReservationResult = {
      reservationId: input.reservationId, invoiceId: sale.invoiceId, invoiceNumber: sale.invoiceNumber,
      shiftId: sale.shiftId ?? null, total: sale.total, status: sale.status, idempotentReplay: sale.idempotentReplay,
    };

    for (const line of saleLines) {
      await tx.update(reservationLines).set({ fulfilledBase: line.toFulfilled }).where(eq(reservationLines.id, line.lineId));
      await adjustReservedStock(tx, line.variantId, Number(res.branchId), -line.baseQty);
    }
    await tx.update(reservations)
      .set({ status: "FULFILLED", fulfilledInvoiceId: sale.invoiceId })
      .where(eq(reservations.id, input.reservationId));
    await tx.insert(reservationEvents).values({
      reservationId: input.reservationId,
      eventType: "FULFILL",
      fromStatus: res.status,
      toStatus: "FULFILLED",
      note: JSON.stringify({ version: 1, note: `فاتورة ${sale.invoiceNumber}`,
        requestHash: idempotencyHash(conversionRequest(input, actor)), result: conversionResult }),
      userId: actor.userId,
    });

    return {
      result: conversionResult,
      notificationInput: {
        branchId: Number(res.branchId),
        customerId: res.customerId != null ? Number(res.customerId) : null,
      },
    };
  });

  // Match normal sale behaviour without allowing a notification outage to undo a committed sale.
  try {
    if (!result.notificationInput) return result.result;
    await notifySaleCustomerAfterCommit({
      branchId: result.notificationInput.branchId,
      customerId: result.notificationInput.customerId,
      sourceType: "ORDER",
      lines: [],
    }, result.result);
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error.message : String(error), invoiceId: result.result.invoiceId }, "reservation: customer sale notification failed");
  }
  return result.result;
}
