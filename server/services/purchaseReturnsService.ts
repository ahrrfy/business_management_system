import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import {
  accountingEntries, branchStock, inventoryMovements,
  products,
  productVariants,
  purchaseOrderItems,
  purchaseOrders,
  receipts,
  suppliers,
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
import { extractInsertId } from "../lib/insertId";
import { paymentAssetRole } from "./sale/paymentPosting";

type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";

export function refundablePurchaseCash(returned: Decimal, paid: Decimal, priorRefunded: Decimal): Decimal {
  const available = Decimal.max(new Decimal(0), paid.minus(priorRefunded));
  return round2(Decimal.min(returned, available));
}

export interface PurchaseReturnLineInput {
  variantId: number;
  productUnitId: number;
  quantity: string; // بوحدة الشراء
  unitPrice: string; // سعر بوحدة الشراء (تكلفة الإرجاع)
}

export interface CreatePurchaseReturnInput {
  clientRequestId?: string;
  supplierId: number;
  branchId: number;
  /** أمر شراء مرجعي اختياري — يُحدّ من كمّيات الإرجاع بما لا يتجاوز المستلَم−المُرتجَع سابقاً */
  purchaseOrderRefId?: number;
  items: PurchaseReturnLineInput[];
  reason?: string | null;
  paymentMethod?: PaymentMethod; // CASH = استرداد فوري؛ غيره = خصم من ذمم المورد فقط
  /** افتراضياً CREDIT (خصم من رصيد المورد). CASH ⇒ يُسجَّل receipt OUT */
  settlement?: "CASH" | "CREDIT";
}

function purchaseReturnFingerprint(input: CreatePurchaseReturnInput): string {
  const items = input.items
    .map((item) => ({
      variantId: item.variantId,
      productUnitId: item.productUnitId,
      quantity: new Decimal(item.quantity).toString(),
      unitPrice: money(item.unitPrice).toFixed(2),
    }))
    .sort((a, b) =>
      a.variantId - b.variantId ||
      a.productUnitId - b.productUnitId ||
      a.quantity.localeCompare(b.quantity) ||
      a.unitPrice.localeCompare(b.unitPrice),
    );
  return idempotencyHash({
    version: 1,
    supplierId: input.supplierId,
    branchId: input.branchId,
    sourcePurchaseOrderId: input.purchaseOrderRefId ?? null,
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
    // idempotency: جدول idempotencyKeys ذو القيد الفريد (operation,clientRequestId) — ذرّي بلا سباق TOCTOU
    // (بخلاف البحث القديم في notes غير المفهرس). نفس المفتاح ⇒ يُعاد بنتيجة المرتجع الأول.
    if (input.clientRequestId) {
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
            amount: accountingEntries.amount,
            supplierId: accountingEntries.supplierId,
            branchId: accountingEntries.branchId,
          })
          .from(accountingEntries)
          .where(eq(accountingEntries.id, existingRefId))
          .limit(1))[0];
        // تحقّق البصمة (تدقيق ١٧/٧): نفس مفتاح idempotency بمورّد/فرع مختلف ⇒ CONFLICT — لا نعيد نتيجة
        // مرتجعٍ آخر (كان returnService يتحقّق بينما مسار الشراء يعيد الأول عمياءً). مرآةٌ لـsale.pay.
        if (prior && (Number(prior.supplierId) !== input.supplierId || Number(prior.branchId) !== input.branchId)) {
          throw new TRPCError({ code: "CONFLICT", message: "مفتاح idempotency مُستعمَل بمورّد أو فرع مختلف" });
        }
        return {
          purchaseReturnEntryId: existingRefId,
          returnedTotal: money(prior?.amount ?? "0").neg().toFixed(2),
          idempotent: true as const,
        };
      }
    }

    const settlement = input.settlement ?? "CREDIT";
    const method = input.paymentMethod ?? "CASH";
    if (settlement === "CASH" && input.purchaseOrderRefId == null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "الاسترداد النقدي يتطلب أمر شراء مرجعياً وإيصال دفع سابقاً مكتملًا ومعتمداً",
      });
    }
    let prelockedCash: { shiftId: number | null; cashBucket: "DRAWER" | "TREASURY" } | null = null;
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
    if (input.purchaseOrderRefId == null && supplier.kind === "CONSIGNOR") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "لا يُنشأ مرتجع شراء بلا أمر مرجعي لمودِع أمانة؛ استخدم سند سحب/استبدال الأمانة",
      });
    }

    // إن وُجد أمر شراء مرجعي ⇒ تحقّق ملكية المورد/الفرع + سقف الكميّات.
    let refPo: typeof purchaseOrders.$inferSelect | undefined;
    let refItems: (typeof purchaseOrderItems.$inferSelect)[] = [];
    if (input.purchaseOrderRefId) {
      const r = await tx
        .select()
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, input.purchaseOrderRefId))
        .for("update")
        .limit(1);
      refPo = r[0];
      if (!refPo) throw new TRPCError({ code: "NOT_FOUND", message: "أمر الشراء المرجعي غير موجود" });
      if (Number(refPo.supplierId) !== input.supplierId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "أمر الشراء لا يخصّ هذا المورد" });
      }
      if (Number(refPo.branchId) !== input.branchId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "أمر الشراء لا يخصّ هذا الفرع" });
      }
      refItems = await tx.select().from(purchaseOrderItems)
        .where(eq(purchaseOrderItems.purchaseOrderId, Number(refPo.id)));
    }

    // حضِّر العمل: حوِّل لوحدة الأساس + احسب صافي البند.
    type Work = {
      input: PurchaseReturnLineInput;
      baseQuantity: number;
      lineTotal: Decimal;
      usdTotal: Decimal;
      /** التكلفة الدفترية (WAVG) لكلّ وحدة أساس — تُستعمَل لسقف خسارة الشحن/الكمرك (landed) عند الإرجاع. */
      bookCostPerBase: Decimal;
    };
    const variantIds = Array.from(new Set(input.items.map((item) => item.variantId))).sort((a, b) => a - b);
    await tx.select({ id: branchStock.id }).from(branchStock).where(inArray(branchStock.variantId, variantIds)).for("update");
      // سقف القيمة: سعر إرجاع الوحدة لا يتجاوز التكلفة المسجّلة للصنف (book cost) ⇒ يمنع تضخيم تخفيض AP/الاسترداد
      //  بقيمة عشوائية (الثغرة الحرجة للمرتجع بلا أمر مرجعي). الكمية مُقيّدة بالمخزون المتاح في applyMovement.
    const lockedVariants = await tx
      .select({
        id: productVariants.id,
        costPrice: productVariants.costPrice,
        isConsignment: products.isConsignment,
        consignorId: products.consignorId,
        isService: products.isService,
        isBundle: products.isBundle,
      })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(inArray(productVariants.id, variantIds))
      .for("update");
    const variantById = new Map(
      lockedVariants.map((variant) => [Number(variant.id), variant]),
    );
    const work: Work[] = [];
    for (const it of input.items) {
      const variant = variantById.get(it.variantId);
      if (!variant) {
        throw new TRPCError({ code: "NOT_FOUND", message: `المتغيّر ${it.variantId} غير موجود` });
      }
      if (
        input.purchaseOrderRefId == null &&
        (variant.isConsignment ||
          variant.consignorId != null ||
          variant.isService ||
          variant.isBundle)
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            `المتغيّر ${it.variantId} ليس مخزوناً مملوكاً قابلاً لمرتجع شراء بلا أمر مرجعي`,
        });
      }
      const { baseQuantity } = await convertToBaseQuantity(tx, it.productUnitId, it.quantity, it.variantId);
      // سقف القيمة: سعر إرجاع الوحدة لا يتجاوز التكلفة المسجّلة للصنف (book cost) ⇒ يمنع تضخيم تخفيض AP/الاسترداد
      //  بقيمة عشوائية (الثغرة الحرجة للمرتجع بلا أمر مرجعي). الكمية مُقيّدة بالمخزون المتاح في applyMovement.
      const bookCostPerBase = money(variant.costPrice ?? "0");
      const factor = money(baseQuantity).dividedBy(money(it.quantity)); // وحدات الأساس لكل وحدة شراء
      const bookUnitCost = round2(bookCostPerBase.times(factor)); // تكلفة وحدة الشراء بالكتب
      let reqUnit = money(it.unitPrice);
      let refItem: (typeof purchaseOrderItems.$inferSelect) | undefined;
      if (refPo) {
        const matching = refItems.filter(
          (row) => Number(row.variantId) === it.variantId && Number(row.productUnitId) === it.productUnitId,
        );
        if (matching.length !== 1) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `تعذرت مطابقة المتغيّر ${it.variantId} ببند مرجعي واحد` });
        }
        refItem = matching[0];
        const poUnitPrice = money(matching[0].unitPrice);
        if (!reqUnit.eq(poUnitPrice)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `سعر المرتجع يجب أن يطابق سعر أمر الشراء (${poUnitPrice.toFixed(2)})` });
        }
        reqUnit = poUnitPrice;
      }
      // PROC-02: سعر الإرجاع لا يصحّ أن يكون سالباً — السقف العلوي وحده أعمى عن الإشارة
      // (reqUnit.gt(bookUnitCost) يَمرّ على السالب) ⇒ كان سعرٌ سالب يَعكس اتجاه AP ويَحقن قيمة.
      if (reqUnit.lt(0)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "سعر إرجاع الشراء لا يصحّ أن يكون سالباً" });
      }
      if (reqUnit.gt(bookUnitCost)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `سعر إرجاع المتغيّر ${it.variantId} (${reqUnit.toFixed(2)}) يتجاوز تكلفته المسجّلة (${bookUnitCost.toFixed(2)}) — لا يُسمح بتضخيم قيمة المرتجع.`,
        });
      }
      const lineTotal = round2(reqUnit.times(money(it.quantity)));
      const usdTotal = refPo?.agreedCurrency === "USD" && refItem?.usdTotal
        ? round2(money(refItem.usdTotal).times(new Decimal(baseQuantity).dividedBy(refItem.baseQuantity)))
        : new Decimal(0);
      work.push({ input: it, baseQuantity, lineTotal, usdTotal, bookCostPerBase });
    }

    // سقف الكميّات حسب أمر الشراء المرجعي: لا يتجاوز (مستلم − مُرتجَع سابقاً) لكل (variantId).
    if (refPo) {
      const receivedByVariant = new Map<number, number>();
      for (const ri of refItems) {
        receivedByVariant.set(
          Number(ri.variantId),
          (receivedByVariant.get(Number(ri.variantId)) ?? 0) + (ri.receivedBaseQuantity ?? 0)
        );
      }
      // كميّات مُرتجَعة سابقاً من نفس الأمر (مجموع OUT بحركات referenceType='PURCHASE_RETURN_REF' + referenceId=poId).
      const priorMoves = await tx
        .select({
          variantId: inventoryMovements.variantId,
          q: sql<number>`COALESCE(SUM(${inventoryMovements.quantity}), 0)`,
        })
        .from(inventoryMovements)
        .where(
          and(
            eq(inventoryMovements.referenceType, "PURCHASE_RETURN_REF"),
            eq(inventoryMovements.referenceId, Number(refPo.id)),
            eq(inventoryMovements.movementType, "OUT")
          )
        )
        .groupBy(inventoryMovements.variantId);
      const priorByVariant = new Map<number, number>();
      for (const m of priorMoves) {
        priorByVariant.set(Number(m.variantId), Number(m.q));
      }
      // اجمع الطلب الحالي حسب variantId.
      const requestedByVariant = new Map<number, number>();
      for (const w of work) {
        requestedByVariant.set(
          w.input.variantId,
          (requestedByVariant.get(w.input.variantId) ?? 0) + w.baseQuantity
        );
      }
      requestedByVariant.forEach((reqQty, vid) => {
        const received = receivedByVariant.get(vid) ?? 0;
        const priorReturned = priorByVariant.get(vid) ?? 0;
        const remaining = received - priorReturned;
        if (reqQty > remaining) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `كمية المرتجع للمتغيّر ${vid} تتجاوز المتبقّي القابل للإرجاع (المستلَم=${received}، المُرتجَع سابقاً=${priorReturned})`,
          });
        }
      });
    }

    // ترتيب حركات OUT حسب variantId (قفل حتمي ⇒ يمنع deadlock).
    const ordered = [...work].sort((a, b) => a.input.variantId - b.input.variantId);
    const refType = input.purchaseOrderRefId ? "PURCHASE_RETURN_REF" : "PURCHASE_RETURN";
    const refId = input.purchaseOrderRefId ?? undefined;
    for (const w of ordered) {
      await applyMovement(tx, {
        variantId: w.input.variantId,
        branchId: input.branchId,
        baseQuantity: w.baseQuantity,
        movementType: "OUT",
        referenceType: refType,
        referenceId: refId,
        createdBy: actor.userId,
      });
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
    const purchaseReturnPostingSource = {
      roleDebits: { AP: returnedTotal, PURCHASE_PRICE_VARIANCE: purchasePriceVariance.isPositive() ? purchasePriceVariance : money(0) },
      roleCredits: { INVENTORY: returnedInventoryBook, TAX_PAYABLE: returnedTax, PURCHASE_PRICE_VARIANCE: purchasePriceVariance.isNegative() ? purchasePriceVariance.abs() : money(0) },
    };

    // قيد دفتر RETURN — الاتفاقية: قيم سالبة. cost سالب (تكلفة عُكست)، amount سالب.
    await postEntry(tx, {
      entryType: "RETURN",
      branchId: input.branchId,
      purchaseOrderId: input.purchaseOrderRefId ?? null,
      supplierId: input.supplierId,
      cost: returnedNet.neg(),
      taxAmount: returnedTax.neg(),
      amount: returnedTotal.neg(),
      notes: input.reason ?? undefined,
      postingIntent: createPostingIntent("RETURN_PURCHASE_INVENTORY", "RETURN", [debitLine("AP", returnedTotal), creditLine("INVENTORY", returnedInventoryBook), ...(returnedTax.isZero() ? [] : [creditLine("TAX_PAYABLE", returnedTax)]), ...(purchasePriceVariance.isPositive() ? [debitLine("PURCHASE_PRICE_VARIANCE", purchasePriceVariance)] : purchasePriceVariance.isNegative() ? [creditLine("PURCHASE_PRICE_VARIANCE", purchasePriceVariance.abs())] : [])], purchaseReturnPostingSource),
      postingSourceComponents: purchaseReturnPostingSource,
    });

    // التقط معرف قيد المرتجع للإرجاع للعميل (للتتبّع/idempotency).
    const last = await tx
      .select({ id: accountingEntries.id })
      .from(accountingEntries)
      .where(
        and(
          eq(accountingEntries.entryType, "RETURN"),
          eq(accountingEntries.supplierId, input.supplierId),
          eq(accountingEntries.amount, toDbMoney(returnedTotal.neg()))
        )
      )
      .orderBy(sql`id DESC`)
      .limit(1);
    const purchaseReturnEntryId = Number(last[0]?.id ?? 0);

    // Idempotency: سجّل المفتاح (refId = قيد المرتجع). سباق نفس المفتاح ⇒ ER_DUP_ENTRY فيُعاد المحاولة replay.
    if (input.clientRequestId) {
      await recordIdempotencyKey(
        tx,
        "purchase.return",
        input.clientRequestId,
        purchaseReturnEntryId,
        requestFingerprint,
      );
    }

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
            eq(accountingEntries.postingProfile, "PAYMENT_IN_SUPPLIER_REFUND"),
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
            eq(accountingEntries.postingProfile, "PAYMENT_OUT_SUPPLIER"),
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
        purchaseOrderId: input.purchaseOrderRefId ?? null,
        supplierId: input.supplierId,
        receiptId,
        amount: cashRefund,
        postingIntent: createPostingIntent("PAYMENT_IN_SUPPLIER_REFUND", "PAYMENT_IN", [debitLine(refundAssetRole, cashRefund), creditLine("AP", cashRefund)], refundPostingSource),
        postingSourceComponents: refundPostingSource,
      });
      // العاكس: لأنّ النقد دخل صندوقنا، نُلغي خصم الذمم بمقدار النقد المُسترد.
      await adjustSupplierBalance(tx, input.supplierId, cashRefund);
    }

    // ── الشحن/الكمرك على مرتجع الشراء: لا منطق (قرار المالك ٥/٨/٢٦) ──
    // أُزيلت هنا كتلةُ «خسارة الشحن غير المستردّ». كانت لازمةً حين كان الشحن يُرسمَل في WAVG
    // ويُضاف إلى ذمّة المورّد عند الاستلام (#311/#318/#321): فالإرجاع كان يترك حصّة شحنٍ عالقةً
    // في الذمّة وقيمةً دفتريةً غير مستردّة تستوجب قيدَ خسارةٍ صريحاً بسقفٍ محسوب.
    // بعد قرار المالك صار الشحن **مصروفاً معترَفاً به لحظة الاستلام**، خارج ذمّة المورّد وخارج
    // تكلفة الصنف تماماً — فلا شيء يتبقّى ليُعكَس أو يُخسَر هنا: المرتجع يعكس قيمة البضاعة وحدها،
    // والمصروف وقع فعلاً ولا يُستردّ (البضاعة شُحنت إلينا بالفعل). إبقاء الكتلة كان يقيّد الخسارة مرّتين.

    return {
      purchaseReturnEntryId,
      returnedTotal: returnedTotal.toFixed(2),
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
      ) as any,
    );
  }

  const rows = await db
    .select({
      id: accountingEntries.id,
      entryDate: accountingEntries.entryDate,
      supplierId: accountingEntries.supplierId,
      branchId: accountingEntries.branchId,
      purchaseOrderId: accountingEntries.purchaseOrderId,
      amount: accountingEntries.amount,
      notes: accountingEntries.notes,
    })
    .from(accountingEntries)
    .leftJoin(suppliers, eq(accountingEntries.supplierId, suppliers.id))
    .where(and(...where))
    .orderBy(sql`${accountingEntries.id} DESC`)
    .limit(limit)
    .offset(offset);

  const totalRow = await db
    .select({ c: sql<number>`COUNT(*)` })
    .from(accountingEntries)
    .leftJoin(suppliers, eq(accountingEntries.supplierId, suppliers.id))
    .where(and(...where));

  return { rows, total: Number(totalRow[0]?.c ?? 0) };
}
