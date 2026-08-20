import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import {
  accountingEntries, branchStock, inventoryMovements,
  products,
  productUnits,
  productVariants,
  purchaseOrderItems,
  purchaseOrders,
  purchaseReturnItems,
  purchaseReturns,
  receipts,
  suppliers,
  users,
} from "../../drizzle/schema";
import { escLike } from "../lib/sqlLike";
import { localDayStart } from "./dateRange";
import {
  checkIdempotency,
  idempotencyHash,
  recordIdempotencyKey,
} from "./idempotency";
import { applyMovement, convertToBaseQuantity } from "./inventoryService";
import { adjustSupplierBalance, adjustSupplierBalanceUsd, postEntry } from "./ledgerService";
import { createPostingIntent, creditLine, debitLine } from "./accounting/postingEngine";
import { money, round2, sumMoney, toDbMoney } from "./money";
import { shiftIdForCashTx } from "./shiftService";
import { lockCashSourceForUpdate } from "./cash/cashAvailability";
import { withTx, type Actor } from "./tx";
import { extractAffectedRows, extractInsertId } from "../lib/insertId";
import { paymentAssetRole } from "./sale/paymentPosting";

type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";

export function refundablePurchaseCash(returned: Decimal, paid: Decimal, priorRefunded: Decimal): Decimal {
  const available = Decimal.max(new Decimal(0), paid.minus(priorRefunded));
  return round2(Decimal.min(returned, available));
}

export interface PurchaseReturnLineInput {
  purchaseOrderItemId: number;
  quantity: string; // بوحدة الشراء
}

export interface CreatePurchaseReturnInput {
  clientRequestId: string;
  supplierId: number;
  branchId: number;
  /** كل مرتجع قياسي يجب أن يرجع إلى أمر شراء مثبت ومستلم كلياً أو جزئياً. */
  purchaseOrderRefId: number;
  items: PurchaseReturnLineInput[];
  reason?: string | null;
  paymentMethod?: PaymentMethod; // CASH = استرداد فوري؛ غيره = خصم من ذمم المورد فقط
  /** افتراضياً CREDIT (خصم من رصيد المورد). CASH ⇒ يُسجَّل receipt OUT */
  settlement?: "CASH" | "CREDIT";
}

function purchaseReturnFingerprint(input: CreatePurchaseReturnInput): string {
  const items = input.items
    .map((item) => ({
      purchaseOrderItemId: item.purchaseOrderItemId,
      quantity: new Decimal(item.quantity).toString(),
    }))
    .sort((a, b) =>
      a.purchaseOrderItemId - b.purchaseOrderItemId ||
      a.quantity.localeCompare(b.quantity),
    );
  return idempotencyHash({
    version: 1,
    supplierId: input.supplierId,
    branchId: input.branchId,
    sourcePurchaseOrderId: input.purchaseOrderRefId,
    settlement: input.settlement ?? "CREDIT",
    paymentMethod: input.paymentMethod ?? "CASH",
    reason: input.reason?.trim() || null,
    items,
  });
}

/**
 * مرتجع مشتريات (إرجاع بضاعة للمورد):
 *  - OUT حركة مخزون عن كل بند (بقفل ذرّي على branchStock).
 *  - قيد RETURN في الدفتر بقيم سالبة (cost سالب، amount سالب).
 *  - تخفيض ذمم المورد: AP موجب = نحن مدينون له ⇒ المرتجع يُنقصها ⇒ delta = -returnedTotal.
 *    (إن دفع المورد نقداً ⇒ نسجّل receipt IN ⇒ يزيد الصندوق، ويُلغى أثر تخفيض الذمم بمقدار النقد).
 *  - idempotency على clientRequestId عبر تخزينه في accountingEntries.notes (مفتاح فريد منطقي).
 */
export async function createPurchaseReturn(input: CreatePurchaseReturnInput, actor: Actor) {
  if (!input.items.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "مرتجع المشتريات بلا أصناف" });
  }
  const requestFingerprint = purchaseReturnFingerprint(input);

  return withTx(async (tx) => {
    const settlement = input.settlement ?? "CREDIT";
    const method = input.paymentMethod ?? "CASH";
    let prelockedCash: { shiftId: number | null; cashBucket: "DRAWER" | "TREASURY" } | null = null;
    let cashRefundAmount = new Decimal(0);
    if (settlement === "CASH") {
      if (method !== "CASH") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "الاسترداد غير النقدي يتطلب سند قبض موثقاً" });
      }
      const resolved = await shiftIdForCashTx(
        tx,
        { userId: actor.userId, branchId: input.branchId, role: (actor as Actor & { role?: string }).role },
        input.branchId,
        "استرداد من المورد",
      );
      await lockCashSourceForUpdate(tx, {
        branchId: input.branchId,
        cashBucket: resolved.cashBucket,
        shiftId: resolved.shiftId,
      });
      prelockedCash = resolved;
    }

    const [supplier] = await tx
      .select({ id: suppliers.id, kind: suppliers.supplierKind })
      .from(suppliers)
      .where(eq(suppliers.id, input.supplierId))
      .for("update")
      .limit(1);
    if (!supplier) {
      throw new TRPCError({ code: "NOT_FOUND", message: "المورّد غير موجود" });
    }
    if (supplier.kind === "CONSIGNOR") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "مرتجع مودِع الأمانة يُسجّل بسند سحب/استبدال الأمانة، لا كمرتجع شراء",
      });
    }

    // إن وُجد أمر شراء مرجعي ⇒ تحقّق ملكية المورد/الفرع + سقف الكميّات.
    let refPo: typeof purchaseOrders.$inferSelect | undefined;
    let refItems: (typeof purchaseOrderItems.$inferSelect)[] = [];
    const r = await tx
      .select()
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, input.purchaseOrderRefId))
      .for("update")
      .limit(1);
    refPo = r[0];
    if (!refPo) throw new TRPCError({ code: "NOT_FOUND", message: "أمر الشراء المرجعي غير موجود" });
    if (!(["CONFIRMED", "RECEIVED"] as const).includes(refPo.status as "CONFIRMED" | "RECEIVED")) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يُرجع إلا من أمر شراء مثبت ومستلم كلياً أو جزئياً" });
    }
    if (Number(refPo.supplierId) !== input.supplierId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "أمر الشراء لا يخصّ هذا المورد" });
    }
    if (Number(refPo.branchId) !== input.branchId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "أمر الشراء لا يخصّ هذا الفرع" });
    }
    refItems = await tx.select().from(purchaseOrderItems)
      .where(eq(purchaseOrderItems.purchaseOrderId, Number(refPo.id)))
      .orderBy(purchaseOrderItems.id)
      .for("update");

    // يجب أن يأتي فحص idempotency بعد القفل الجاري للأمر وبنوده. بهذا لا تُنشئ قراءةٌ
    // متّسقة مبكرة snapshot قديماً تحت REPEATABLE READ قبل فحص سقف المرتجع.
    const existingRefId = await checkIdempotency(
      tx,
      "purchase.return",
      input.clientRequestId,
      requestFingerprint,
      { requireStoredHash: true },
    );
    if (existingRefId != null) {
      const prior = (await tx
        .select({
          totalAmount: purchaseReturns.totalAmount,
          supplierId: purchaseReturns.supplierId,
          branchId: purchaseReturns.branchId,
          accountingEntryId: purchaseReturns.accountingEntryId,
        })
        .from(purchaseReturns)
        .where(eq(purchaseReturns.id, existingRefId))
        .limit(1))[0];
      if (!prior || Number(prior.supplierId) !== input.supplierId || Number(prior.branchId) !== input.branchId) {
        throw new TRPCError({ code: "CONFLICT", message: "مفتاح الطلب مستعمل بمرتجع مختلف" });
      }
      return {
        purchaseReturnId: existingRefId,
        purchaseReturnEntryId: Number(prior.accountingEntryId ?? 0),
        returnedTotal: money(prior.totalAmount).toFixed(2),
        idempotent: true as const,
      };
    }

    // حضِّر العمل من بنود أمر الشراء المقفلة. السعر/الوحدة/المورد لا تُقبل من العميل.
    type Work = {
      input: PurchaseReturnLineInput;
      refItem: typeof purchaseOrderItems.$inferSelect;
      variantId: number;
      productUnitId: number;
      productName: string;
      variantName: string | null;
      unitName: string | null;
      baseQuantity: number;
      lineTotal: Decimal;
      usdTotal: Decimal;
      bookCostPerBase: Decimal;
    };
    const refItemById = new Map(refItems.map((item) => [Number(item.id), item]));
    const requestedItemIds = input.items.map((item) => item.purchaseOrderItemId);
    if (new Set(requestedItemIds).size !== requestedItemIds.length) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يجوز تكرار بند أمر الشراء في المرتجع" });
    }
    const selectedRefItems = input.items.map((item) => {
      const refItem = refItemById.get(item.purchaseOrderItemId);
      if (!refItem) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `البند ${item.purchaseOrderItemId} لا ينتمي إلى أمر الشراء المرجعي` });
      }
      return refItem;
    });
    const variantIds = Array.from(new Set(selectedRefItems.map((item) => Number(item.variantId)))).sort((a, b) => a - b);
    await tx.select({ id: branchStock.id }).from(branchStock).where(inArray(branchStock.variantId, variantIds)).for("update");
    const lockedVariants = await tx
      .select({
        id: productVariants.id,
        costPrice: productVariants.costPrice,
        productName: products.name,
        variantName: productVariants.variantName,
      })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(inArray(productVariants.id, variantIds))
      .for("update");
    const variantById = new Map(
      lockedVariants.map((variant) => [Number(variant.id), variant]),
    );
    const unitIds = Array.from(new Set(selectedRefItems.map((item) => Number(item.productUnitId)).filter(Boolean)));
    const unitRows = unitIds.length
      ? await tx.select({ id: productUnits.id, unitName: productUnits.unitName }).from(productUnits).where(inArray(productUnits.id, unitIds))
      : [];
    const unitNameById = new Map(unitRows.map((unit) => [Number(unit.id), unit.unitName]));
    const work: Work[] = [];
    for (const it of input.items) {
      const refItem = refItemById.get(it.purchaseOrderItemId)!;
      const variantId = Number(refItem.variantId);
      const productUnitId = Number(refItem.productUnitId);
      const variant = variantById.get(variantId);
      if (!variant) {
        throw new TRPCError({ code: "NOT_FOUND", message: `المتغيّر ${variantId} غير موجود` });
      }
      const { baseQuantity } = await convertToBaseQuantity(tx, productUnitId, it.quantity, variantId);
      const bookCostPerBase = money(variant.costPrice ?? "0");
      const reqUnit = money(refItem.unitPrice);
      if (reqUnit.lt(0)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "سعر إرجاع الشراء لا يصحّ أن يكون سالباً" });
      }
      const lineTotal = round2(reqUnit.times(money(it.quantity)));
      const usdTotal = refPo.agreedCurrency === "USD" && refItem.usdTotal
        ? round2(money(refItem.usdTotal).times(new Decimal(baseQuantity).dividedBy(refItem.baseQuantity)))
        : new Decimal(0);
      const remaining = Number(refItem.receivedBaseQuantity ?? 0) - Number(refItem.returnedBaseQuantity ?? 0);
      if (baseQuantity > remaining) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `كمية المرتجع في بند ${refItem.id} تتجاوز المتبقّي القابل للإرجاع (${remaining} بالوحدة الأساس)`,
        });
      }
      work.push({
        input: it,
        refItem,
        variantId,
        productUnitId,
        productName: variant.productName,
        variantName: variant.variantName,
        unitName: unitNameById.get(productUnitId) ?? null,
        baseQuantity,
        lineTotal,
        usdTotal,
        bookCostPerBase,
      });
    }

    // تحديث شرطي ذري إضافةً إلى FOR UPDATE: دفاعٌ مزدوج ضد over-return تحت التزامن.
    for (const w of work) {
      const updated = await tx.update(purchaseOrderItems)
        .set({ returnedBaseQuantity: sql`${purchaseOrderItems.returnedBaseQuantity} + ${w.baseQuantity}` })
        .where(and(
          eq(purchaseOrderItems.id, Number(w.refItem.id)),
          sql`${purchaseOrderItems.returnedBaseQuantity} + ${w.baseQuantity} <= ${purchaseOrderItems.receivedBaseQuantity}`,
        ));
      if (extractAffectedRows(updated) !== 1) {
        throw new TRPCError({ code: "CONFLICT", message: "تغيّرت الكمية القابلة للإرجاع؛ حدّث أمر الشراء وأعد المحاولة" });
      }
    }

    const returnedNet = round2(sumMoney(work.map((w) => w.lineTotal.toFixed(2))));
    // المرتجع المرجعي يرث نسبة ضريبة أمر الشراء؛ لا نسمح بإنشاء نسبة جديدة في المرتجع.
    // المرتجع غير المرجعي يبقى بلا ضريبة لغياب مستند أصل يمكن تدقيقه.
    const returnedInventoryBook = round2(sumMoney(work.map((w) => w.bookCostPerBase.times(w.baseQuantity).toFixed(2))));
    const purchasePriceVariance = round2(returnedInventoryBook.minus(returnedNet));
    // المرتجع المرجعي يرث نسبة ضريبة أمر الشراء؛ لا نسمح بإنشاء نسبة جديدة في المرتجع.
    // المرتجع غير المرجعي يبقى بلا ضريبة لغياب مستند أصل يمكن تدقيقه.
    const returnedTax = refPo
      ? round2(returnedNet.times(money(refPo.taxRatePercent ?? "0")).dividedBy(100))
      : new Decimal(0);
    const returnedTotal = round2(returnedNet.plus(returnedTax));
    const returnedUsdNet = round2(sumMoney(work.map((w) => w.usdTotal.toFixed(2))));
    const returnedUsdTax = refPo?.agreedCurrency === "USD"
      ? round2(returnedUsdNet.times(money(refPo.taxRatePercent ?? "0")).dividedBy(100))
      : new Decimal(0);
    const returnedUsd = round2(returnedUsdNet.plus(returnedUsdTax));
    const actorRow = (await tx
      .select({ name: users.name, username: users.username })
      .from(users)
      .where(eq(users.id, actor.userId))
      .limit(1))[0];
    const actorName = actorRow?.name?.trim() || actorRow?.username?.trim() || `مستخدم #${actor.userId}`;
    const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const returnNumber = `PR-${input.branchId}-${today}-${idempotencyHash(input.clientRequestId).slice(0, 16).toUpperCase()}`;
    const returnInsert = await tx.insert(purchaseReturns).values({
      returnNumber,
      clientRequestId: input.clientRequestId,
      purchaseOrderId: input.purchaseOrderRefId,
      supplierId: input.supplierId,
      branchId: input.branchId,
      settlement,
      paymentMethod: method,
      netAmount: toDbMoney(returnedNet),
      taxAmount: toDbMoney(returnedTax),
      totalAmount: toDbMoney(returnedTotal),
      cashRefundAmount: "0.00",
      creditOffsetAmount: toDbMoney(returnedTotal),
      reason: input.reason?.trim() || null,
      createdBy: actor.userId,
      createdByNameSnapshot: actorName,
    });
    const purchaseReturnId = extractInsertId(returnInsert);
    await tx.insert(purchaseReturnItems).values(work.map((w) => ({
      purchaseReturnId,
      purchaseOrderItemId: Number(w.refItem.id),
      variantId: w.variantId,
      productUnitId: w.productUnitId,
      quantity: money(w.input.quantity).toFixed(3),
      baseQuantity: w.baseQuantity,
      unitPrice: toDbMoney(w.refItem.unitPrice),
      lineTotal: toDbMoney(w.lineTotal),
      productNameSnapshot: w.productName,
      variantNameSnapshot: w.variantName,
      unitNameSnapshot: w.unitName,
    })));

    // هوية حركة المخزون هي مستند المرتجع نفسه، لا أمر الشراء؛ يبقى PO متاحاً عبر رأس المرتجع.
    for (const w of [...work].sort((a, b) => a.variantId - b.variantId)) {
      await applyMovement(tx, {
        variantId: w.variantId,
        branchId: input.branchId,
        baseQuantity: w.baseQuantity,
        movementType: "OUT",
        referenceType: "PURCHASE_RETURN",
        referenceId: purchaseReturnId,
        createdBy: actor.userId,
      });
    }
    const purchaseReturnPostingSource = {
      roleDebits: {
        AP: returnedTotal,
        ...(purchasePriceVariance.gt(0)
          ? { PURCHASE_PRICE_VARIANCE: purchasePriceVariance }
          : {}),
      },
      roleCredits: {
        INVENTORY: returnedInventoryBook,
        ...(returnedTax.isZero() ? {} : { TAX_PAYABLE: returnedTax }),
        ...(purchasePriceVariance.lt(0)
          ? { PURCHASE_PRICE_VARIANCE: purchasePriceVariance.abs() }
          : {}),
      },
    };

    // قيد دفتر RETURN — الاتفاقية: قيم سالبة. cost سالب (تكلفة عُكست)، amount سالب.
    await postEntry(tx, {
      entryType: "RETURN",
      branchId: input.branchId,
      purchaseOrderId: input.purchaseOrderRefId,
      supplierId: input.supplierId,
      cost: returnedNet.neg(),
      taxAmount: returnedTax.neg(),
      amount: returnedTotal.neg(),
      notes: input.reason ?? undefined,
      dedupeKey: `PURCHASE_RETURN:${purchaseReturnId}`,
      createdBy: actor.userId,
      createdByNameSnapshot: actorName,
      postingIntent: createPostingIntent("RETURN_PURCHASE_INVENTORY", "RETURN", [debitLine("AP", returnedTotal), creditLine("INVENTORY", returnedInventoryBook), ...(returnedTax.isZero() ? [] : [creditLine("TAX_PAYABLE", returnedTax)]), ...(purchasePriceVariance.gt(0) ? [debitLine("PURCHASE_PRICE_VARIANCE", purchasePriceVariance)] : purchasePriceVariance.lt(0) ? [creditLine("PURCHASE_PRICE_VARIANCE", purchasePriceVariance.abs())] : [])], purchaseReturnPostingSource),
      postingSourceComponents: purchaseReturnPostingSource,
    });

    // التقط القيد بمفتاح بنيوي فريد، لا ببحث «آخر مبلغ لنفس المورد» القابل للالتباس.
    const last = await tx
      .select({ id: accountingEntries.id })
      .from(accountingEntries)
      .where(eq(accountingEntries.dedupeKey, `PURCHASE_RETURN:${purchaseReturnId}`))
      .limit(1);
    const purchaseReturnEntryId = Number(last[0]?.id ?? 0);
    await tx.update(purchaseReturns)
      .set({ accountingEntryId: purchaseReturnEntryId })
      .where(eq(purchaseReturns.id, purchaseReturnId));

    // refId = مستند المرتجع القانوني، لا القيد المساعد.
    await recordIdempotencyKey(
      tx,
      "purchase.return",
      input.clientRequestId,
      purchaseReturnId,
      requestFingerprint,
    );

    // AP: المورد يدين لنا الآن بقيمة المرتجع ⇒ ننقص رصيده الدائن لدينا (suppliers.currentBalance) بالسالب.
    await adjustSupplierBalance(tx, input.supplierId, returnedTotal.neg());
    if (refPo?.agreedCurrency === "USD" && returnedUsd.gt(0)) {
      const returnableUsd = money(refPo.usdTotal ?? 0).minus(money(refPo.returnedUsd));
      if (returnedUsd.gt(returnableUsd)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "قيمة المرتجع الدولارية تتجاوز قيمة الفاتورة القابلة للإرجاع" });
      }
      await adjustSupplierBalanceUsd(tx, input.supplierId, returnedUsd.neg());
      await tx.update(purchaseOrders)
        .set({ returnedUsd: toDbMoney(money(refPo.returnedUsd).plus(returnedUsd)) })
        .where(eq(purchaseOrders.id, Number(refPo.id)));
    }

    // الاسترداد النقدي اختياري: لو CASH ⇒ المورد ردّ النقد ⇒ receipt IN ⇒ يزيد الصندوق،
    // ولأنّنا أنقصنا الذمم بكامل القيمة فإن استلامنا نقداً يجب أن "يُعيد" قيمة النقد للذمم
    // كي يظل صافي الأثر: AP -= (returnedTotal − cashReceived). يُحقّق ذلك بـ PAYMENT_IN + adjustSupplier(+cash).
    if (settlement === "CASH") {
      if (refPo?.agreedCurrency === "USD") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "استرداد فاتورة دولارية يُسجَّل عبر عملية صيرفة مرتبطة، لا كقبض نقدي ديناري مباشر" });
      }
      if (!refPo) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "تعذر تثبيت أمر الشراء المرجعي للاسترداد النقدي",
        });
      }
      const priorRefundRow = (
        await tx
          .select({ v: sql<string>`COALESCE(SUM(${accountingEntries.amount}), 0)` })
          .from(accountingEntries)
          .innerJoin(receipts, eq(receipts.id, accountingEntries.receiptId))
          .where(and(
            eq(accountingEntries.entryType, "PAYMENT_IN"),
            or(
              eq(accountingEntries.postingProfile, "PAYMENT_IN_SUPPLIER_REFUND"),
              sql`${accountingEntries.postingProfile} IS NULL`,
            ),
            eq(accountingEntries.purchaseOrderId, Number(refPo.id)),
            eq(accountingEntries.supplierId, input.supplierId),
            eq(receipts.direction, "IN"),
            eq(receipts.paymentMethod, "CASH"),
            eq(receipts.status, "COMPLETED"),
            eq(receipts.approvalStatus, "APPROVED"),
          ))
      )[0];
      const approvedCashPaidRow = (
        await tx
          .select({ v: sql<string>`COALESCE(SUM(${accountingEntries.amount}), 0)` })
          .from(accountingEntries)
          .innerJoin(receipts, eq(receipts.id, accountingEntries.receiptId))
          .where(and(
            eq(accountingEntries.entryType, "PAYMENT_OUT"),
            or(
              eq(accountingEntries.postingProfile, "PAYMENT_OUT_SUPPLIER"),
              sql`${accountingEntries.postingProfile} IS NULL`,
            ),
            eq(accountingEntries.purchaseOrderId, Number(refPo.id)),
            eq(accountingEntries.supplierId, input.supplierId),
            eq(receipts.direction, "OUT"),
            eq(receipts.paymentMethod, "CASH"),
            eq(receipts.status, "COMPLETED"),
            eq(receipts.approvalStatus, "APPROVED"),
          ))
      )[0];
      const cashRefund = refundablePurchaseCash(
        returnedTotal,
        money(approvedCashPaidRow?.v ?? "0"),
        money(priorRefundRow?.v ?? "0"),
      );
      if (cashRefund.lte(0)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "لا توجد دفعة سابقة تبرر استرداداً نقدياً؛ استخدم خصماً من الذمة" });
      }
      cashRefundAmount = cashRefund;
      // G14 (١٩/٦/٢٦): استرداد نقدي من المورد يَلزم وردية مفتوحة (متّسق مع receivePurchase).
      if (!prelockedCash) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "لم يُقفل مصدر الاسترداد النقدي من المورد",
        });
      }
      const rRes = await tx.insert(receipts).values({
        branchId: input.branchId,
        shiftId: prelockedCash.shiftId,
        cashBucket: prelockedCash.cashBucket,
        direction: "IN",
        amount: toDbMoney(cashRefund),
        paymentMethod: method,
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        createdBy: actor.userId,
      });
      const receiptId = extractInsertId(rRes);
      const refundAssetRole = paymentAssetRole(method, prelockedCash.cashBucket, "IN");
      const refundPostingSource = {
        roleDebits: { [refundAssetRole]: cashRefund },
        roleCredits: { AP: cashRefund },
      };
      await postEntry(tx, {
        entryType: "PAYMENT_IN",
        branchId: input.branchId,
        purchaseOrderId: input.purchaseOrderRefId,
        supplierId: input.supplierId,
        receiptId,
        amount: cashRefund,
        createdBy: actor.userId,
        createdByNameSnapshot: actorName,
        postingIntent: createPostingIntent("PAYMENT_IN_SUPPLIER_REFUND", "PAYMENT_IN", [debitLine(refundAssetRole, cashRefund), creditLine("AP", cashRefund)], refundPostingSource),
        postingSourceComponents: refundPostingSource,
      });
      // العاكس: لأنّ النقد دخل صندوقنا، نُلغي خصم الذمم بمقدار النقد المُسترد.
      await adjustSupplierBalance(tx, input.supplierId, cashRefund);
    }

    await tx.update(purchaseReturns)
      .set({
        cashRefundAmount: toDbMoney(cashRefundAmount),
        creditOffsetAmount: toDbMoney(returnedTotal.minus(cashRefundAmount)),
      })
      .where(eq(purchaseReturns.id, purchaseReturnId));

    // ── الشحن/الكمرك على مرتجع الشراء: لا منطق (قرار المالك ٥/٨/٢٦) ──
    // أُزيلت هنا كتلةُ «خسارة الشحن غير المستردّ». كانت لازمةً حين كان الشحن يُرسمَل في WAVG
    // ويُضاف إلى ذمّة المورّد عند الاستلام (#311/#318/#321): فالإرجاع كان يترك حصّة شحنٍ عالقةً
    // في الذمّة وقيمةً دفتريةً غير مستردّة تستوجب قيدَ خسارةٍ صريحاً بسقفٍ محسوب.
    // بعد قرار المالك صار الشحن **مصروفاً معترَفاً به لحظة الاستلام**، خارج ذمّة المورّد وخارج
    // تكلفة الصنف تماماً — فلا شيء يتبقّى ليُعكَس أو يُخسَر هنا: المرتجع يعكس قيمة البضاعة وحدها،
    // والمصروف وقع فعلاً ولا يُستردّ (البضاعة شُحنت إلينا بالفعل). إبقاء الكتلة كان يقيّد الخسارة مرّتين.

    return {
      purchaseReturnId,
      purchaseReturnEntryId,
      returnNumber,
      returnedTotal: returnedTotal.toFixed(2),
      cashRefundAmount: cashRefundAmount.toFixed(2),
      creditOffsetAmount: returnedTotal.minus(cashRefundAmount).toFixed(2),
      idempotent: false as const,
    };
  });
}

export interface ListPurchaseReturnsInput {
  supplierId?: number;
  branchId?: number;
  /** فترة على entryDate (YYYY-MM-DD) — عمود DATE بلا وقت ⇒ gte/lte شاملان مباشرة. */
  from?: string;
  to?: string;
  /** بحث نصّي خادمي: ملاحظات/رقم القيد/أمر الشراء/اسم المورد. */
  q?: string;
  limit?: number;
  offset?: number;
}

/** قائمة مرتجعات الشراء (قيود RETURN ذات supplierId). */
export async function listPurchaseReturns(input: ListPurchaseReturnsInput = {}) {
  const { getDb } = await import("../db");
  const db = getDb();
  if (!db) return { rows: [], total: 0 };
  const limit = input.limit ?? 50;
  const offset = input.offset ?? 0;
  const where = [eq(accountingEntries.entryType, "RETURN")];
  if (input.supplierId) where.push(eq(accountingEntries.supplierId, input.supplierId));
  if (input.branchId) where.push(eq(accountingEntries.branchId, input.branchId));
  // entryDate عمود DATE (بلا وقت) ⇒ gte/lte شاملان للطرفين — بمنتصف ليلٍ محلي
  // (new Date("YYYY-MM-DD") = منتصف ليل UTC يُسلسَل +03:00 فيستثني يوم from كاملاً).
  if (input.from) where.push(gte(accountingEntries.entryDate, localDayStart(input.from)));
  if (input.to) where.push(lte(accountingEntries.entryDate, localDayStart(input.to)));
  // فقط قيود الشراء (لها supplierId غير null) — تمييزها عن مرتجعات البيع.
  where.push(sql`${accountingEntries.supplierId} IS NOT NULL` as any);
  // بحث نصّي آمن (escLike + ESCAPE '!'): ملاحظات/رقم القيد/أمر الشراء/اسم المورد (عبر join).
  if (input.q) {
    const pat = `%${escLike(input.q.trim())}%`;
    where.push(
      or(
        sql`${accountingEntries.notes} LIKE ${pat} ESCAPE '!'`,
        sql`CAST(${accountingEntries.id} AS CHAR) LIKE ${pat} ESCAPE '!'`,
        sql`CAST(${accountingEntries.purchaseOrderId} AS CHAR) LIKE ${pat} ESCAPE '!'`,
        sql`${suppliers.name} LIKE ${pat} ESCAPE '!'`,
        sql`${purchaseReturns.returnNumber} LIKE ${pat} ESCAPE '!'`,
        sql`${purchaseOrders.poNumber} LIKE ${pat} ESCAPE '!'`,
      ) as any,
    );
  }

  const rows = await db
    .select({
      id: accountingEntries.id,
      purchaseReturnId: purchaseReturns.id,
      returnNumber: purchaseReturns.returnNumber,
      entryDate: accountingEntries.entryDate,
      supplierId: accountingEntries.supplierId,
      supplierName: suppliers.name,
      branchId: accountingEntries.branchId,
      purchaseOrderId: accountingEntries.purchaseOrderId,
      purchaseOrderNumber: purchaseOrders.poNumber,
      amount: sql<string>`ABS(${accountingEntries.amount})`,
      notes: accountingEntries.notes,
      createdBy: accountingEntries.createdBy,
      createdByName: sql<string | null>`COALESCE(${purchaseReturns.createdByNameSnapshot}, ${accountingEntries.createdByNameSnapshot})`,
      createdAt: purchaseReturns.createdAt,
      settlement: purchaseReturns.settlement,
      cashRefundAmount: purchaseReturns.cashRefundAmount,
      creditOffsetAmount: purchaseReturns.creditOffsetAmount,
    })
    .from(accountingEntries)
    .leftJoin(suppliers, eq(accountingEntries.supplierId, suppliers.id))
    .leftJoin(purchaseReturns, eq(purchaseReturns.accountingEntryId, accountingEntries.id))
    .leftJoin(purchaseOrders, eq(accountingEntries.purchaseOrderId, purchaseOrders.id))
    .where(and(...where))
    .orderBy(sql`${accountingEntries.id} DESC`)
    .limit(limit)
    .offset(offset);

  const totalRow = await db
    .select({ c: sql<number>`COUNT(*)` })
    .from(accountingEntries)
    .leftJoin(suppliers, eq(accountingEntries.supplierId, suppliers.id))
    .leftJoin(purchaseReturns, eq(purchaseReturns.accountingEntryId, accountingEntries.id))
    .leftJoin(purchaseOrders, eq(accountingEntries.purchaseOrderId, purchaseOrders.id))
    .where(and(...where));

  return { rows, total: Number(totalRow[0]?.c ?? 0) };
}

export interface EligiblePurchaseOrdersInput {
  branchId: number;
  q?: string;
  limit?: number;
}

/** أوامر مثبتة لها كمية مستلمة لم تُرجع بعد؛ لا تُعيد أية بيانات مورد حساسة. */
export async function listEligiblePurchaseOrders(input: EligiblePurchaseOrdersInput) {
  const { getDb } = await import("../db");
  const db = getDb();
  if (!db) return [];
  const where = [
    eq(purchaseOrders.branchId, input.branchId),
    inArray(purchaseOrders.status, ["CONFIRMED", "RECEIVED"]),
    sql`${purchaseOrderItems.receivedBaseQuantity} > ${purchaseOrderItems.returnedBaseQuantity}`,
  ];
  if (input.q?.trim()) {
    const pat = `%${escLike(input.q.trim())}%`;
    where.push(or(
      sql`${purchaseOrders.poNumber} LIKE ${pat} ESCAPE '!'`,
      sql`${suppliers.name} LIKE ${pat} ESCAPE '!'`,
      sql`CAST(${purchaseOrders.id} AS CHAR) LIKE ${pat} ESCAPE '!'`,
    ) as any);
  }
  return db.select({
    id: purchaseOrders.id,
    poNumber: purchaseOrders.poNumber,
    supplierId: purchaseOrders.supplierId,
    supplierName: suppliers.name,
    branchId: purchaseOrders.branchId,
    orderDate: purchaseOrders.orderDate,
    status: purchaseOrders.status,
    returnableLines: sql<number>`COUNT(${purchaseOrderItems.id})`,
  })
    .from(purchaseOrders)
    .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
    .innerJoin(purchaseOrderItems, eq(purchaseOrderItems.purchaseOrderId, purchaseOrders.id))
    .where(and(...where))
    .groupBy(purchaseOrders.id, purchaseOrders.poNumber, purchaseOrders.supplierId, suppliers.name, purchaseOrders.branchId, purchaseOrders.orderDate, purchaseOrders.status)
    .orderBy(desc(purchaseOrders.orderDate), desc(purchaseOrders.id))
    .limit(input.limit ?? 20);
}

/** يحل المرجع حلّاً تاماً: الرقم المرئي يُطابق poNumber كاملاً، والرقم الصرف فقط يطابق id. */
export async function resolveReturnablePurchaseOrder(input: { branchId: number; reference: string }) {
  const { getDb } = await import("../db");
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  const raw = input.reference.trim();
  const numericId = /^\d+$/.test(raw) ? Number(raw) : null;
  const po = (await db.select({
    id: purchaseOrders.id,
    poNumber: purchaseOrders.poNumber,
    supplierId: purchaseOrders.supplierId,
    supplierName: suppliers.name,
    branchId: purchaseOrders.branchId,
    status: purchaseOrders.status,
    taxAmount: purchaseOrders.taxAmount,
    taxRatePercent: purchaseOrders.taxRatePercent,
    agreedCurrency: purchaseOrders.agreedCurrency,
  })
    .from(purchaseOrders)
    .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
    .where(and(
      eq(purchaseOrders.branchId, input.branchId),
      inArray(purchaseOrders.status, ["CONFIRMED", "RECEIVED"]),
      numericId != null ? eq(purchaseOrders.id, numericId) : eq(purchaseOrders.poNumber, raw),
    ))
    .limit(1))[0];
  if (!po) throw new TRPCError({ code: "NOT_FOUND", message: "لم يُعثر على أمر شراء مثبت بهذا الرقم في الفرع" });

  const items = await db.select({
    purchaseOrderItemId: purchaseOrderItems.id,
    variantId: purchaseOrderItems.variantId,
    productUnitId: purchaseOrderItems.productUnitId,
    productName: products.name,
    variantName: productVariants.variantName,
    sku: productVariants.sku,
    unitName: productUnits.unitName,
    conversionFactor: productUnits.conversionFactor,
    unitPrice: purchaseOrderItems.unitPrice,
    receivedBaseQuantity: purchaseOrderItems.receivedBaseQuantity,
    returnedBaseQuantity: purchaseOrderItems.returnedBaseQuantity,
    remainingBaseQuantity: sql<number>`${purchaseOrderItems.receivedBaseQuantity} - ${purchaseOrderItems.returnedBaseQuantity}`,
    remainingQuantity: sql<string>`(${purchaseOrderItems.receivedBaseQuantity} - ${purchaseOrderItems.returnedBaseQuantity}) / NULLIF(${productUnits.conversionFactor}, 0)`,
  })
    .from(purchaseOrderItems)
    .innerJoin(productVariants, eq(productVariants.id, purchaseOrderItems.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(productUnits, eq(productUnits.id, purchaseOrderItems.productUnitId))
    .where(and(
      eq(purchaseOrderItems.purchaseOrderId, Number(po.id)),
      sql`${purchaseOrderItems.receivedBaseQuantity} > ${purchaseOrderItems.returnedBaseQuantity}`,
    ))
    .orderBy(purchaseOrderItems.id);
  if (!items.length) throw new TRPCError({ code: "BAD_REQUEST", message: "لا توجد كمية متبقية قابلة للإرجاع في هذا الأمر" });
  return { ...po, items };
}

export async function getPurchaseReturn(id: number, branchId?: number) {
  const { getDb } = await import("../db");
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  const where = [eq(purchaseReturns.id, id)];
  if (branchId != null) where.push(eq(purchaseReturns.branchId, branchId));
  const header = (await db.select({
    id: purchaseReturns.id,
    returnNumber: purchaseReturns.returnNumber,
    purchaseOrderId: purchaseReturns.purchaseOrderId,
    purchaseOrderNumber: purchaseOrders.poNumber,
    supplierId: purchaseReturns.supplierId,
    supplierName: suppliers.name,
    branchId: purchaseReturns.branchId,
    settlement: purchaseReturns.settlement,
    paymentMethod: purchaseReturns.paymentMethod,
    netAmount: purchaseReturns.netAmount,
    taxAmount: purchaseReturns.taxAmount,
    totalAmount: purchaseReturns.totalAmount,
    cashRefundAmount: purchaseReturns.cashRefundAmount,
    creditOffsetAmount: purchaseReturns.creditOffsetAmount,
    reason: purchaseReturns.reason,
    createdBy: purchaseReturns.createdBy,
    createdByName: purchaseReturns.createdByNameSnapshot,
    createdAt: purchaseReturns.createdAt,
  })
    .from(purchaseReturns)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseReturns.purchaseOrderId))
    .innerJoin(suppliers, eq(suppliers.id, purchaseReturns.supplierId))
    .where(and(...where))
    .limit(1))[0];
  if (!header) throw new TRPCError({ code: "NOT_FOUND", message: "مستند مرتجع الشراء غير موجود" });
  const items = await db.select().from(purchaseReturnItems)
    .where(eq(purchaseReturnItems.purchaseReturnId, id))
    .orderBy(purchaseReturnItems.id);
  return { ...header, items };
}
