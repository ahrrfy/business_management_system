import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { desc, eq, inArray, like, sql } from "drizzle-orm";
import { branchStock, productUnits, productVariants, purchaseOrderItems, purchaseOrders, receipts } from "../../drizzle/schema";
import { findIdempotentRefId, recordIdempotencyKey } from "./idempotency";
import { applyMovement, convertToBaseQuantity } from "./inventoryService";
import { adjustSupplierBalance, postEntry } from "./ledgerService";
import { money, round2, sumMoney, toDateStr, toDbMoney } from "./money";
import { withTx, type Actor } from "./tx";
import { extractInsertId } from "../lib/insertId";

type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";

export interface PurchaseLineInput {
  variantId: number;
  productUnitId: number;
  quantity: string; // in purchase unit
  unitPrice: string; // price per purchase unit
}
export interface CreatePurchaseOrderInput {
  supplierId: number;
  branchId: number;
  taxRatePercent?: string | null;
  status?: "DRAFT" | "SENT" | "CONFIRMED";
  items: PurchaseLineInput[];
  notes?: string | null;
}

export async function createPurchaseOrder(input: CreatePurchaseOrderInput, actor: Actor) {
  return withTx(async (tx) => {
    if (!input.items.length) throw new TRPCError({ code: "BAD_REQUEST", message: "أمر الشراء بلا أصناف" });

    const rows = [];
    const lineNets: string[] = [];
    for (const it of input.items) {
      const { baseQuantity } = await convertToBaseQuantity(tx, it.productUnitId, it.quantity, it.variantId);
      const lineNet = round2(money(it.unitPrice).times(money(it.quantity)));
      lineNets.push(lineNet.toFixed(2));
      rows.push({
        variantId: it.variantId,
        productUnitId: it.productUnitId,
        quantity: money(it.quantity).toFixed(3),
        baseQuantity,
        unitPrice: toDbMoney(it.unitPrice),
        total: lineNet.toFixed(2),
      });
    }
    const subtotal = round2(sumMoney(lineNets));
    const tax = round2(subtotal.times(money(input.taxRatePercent ?? "0")).dividedBy(100));
    const total = round2(subtotal.plus(tax));

    const ymd = toDateStr().replace(/-/g, "");
    const prefix = `PO-${input.branchId}-${ymd}-`;
    const lastRows = await tx
      .select({ n: purchaseOrders.poNumber })
      .from(purchaseOrders)
      .where(like(purchaseOrders.poNumber, `${prefix}%`))
      .orderBy(desc(purchaseOrders.id))
      .for("update")
      .limit(1);
    const seq = lastRows[0]?.n ? parseInt(lastRows[0].n.slice(prefix.length), 10) + 1 : 1;
    const poNumber = prefix + String(seq).padStart(5, "0");

    const insRes = await tx.insert(purchaseOrders).values({
      poNumber,
      supplierId: input.supplierId,
      branchId: input.branchId,
      subtotal: subtotal.toFixed(2),
      taxAmount: tax.toFixed(2),
      total: total.toFixed(2),
      status: input.status ?? "CONFIRMED",
      notes: input.notes ?? null,
      createdBy: actor.userId,
    });
    const purchaseOrderId = extractInsertId(insRes);

    for (const r of rows) {
      await tx.insert(purchaseOrderItems).values({ purchaseOrderId, ...r });
    }
    return { purchaseOrderId, poNumber, total: total.toFixed(2) };
  });
}

/** عزل الفرع: غير المدير/الأدمن يُجبر فرعه على أوامر الشراء (نمط productionService.assertProductionBranch). */
function assertPurchaseBranch(po: { branchId: number | string }, actor: Actor & { role?: string }) {
  const elevated = actor.role === "admin" || actor.role === "manager";
  if (elevated) return;
  if (Number(po.branchId) !== actor.branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا تستطيع التعديل على فرع آخر" });
  }
}

/**
 * إلغاء أمر شراء لم يُستلم منه شيء — قلب حالة خالص (createPurchaseOrder لا يكتب
 * أي قيد دفتر/AP/مخزون/إيصال؛ كل التأثيرات المالية والمخزنية تحدث في receivePurchase فقط).
 * أمرٌ استُلمت منه بضاعة يُعالَج بمرتجع شراء لا بالإلغاء.
 */
export async function cancelPurchaseOrder(purchaseOrderId: number, actor: Actor & { role?: string }) {
  return withTx(async (tx) => {
    const po = (
      await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, purchaseOrderId)).for("update").limit(1)
    )[0];
    if (!po) throw new TRPCError({ code: "NOT_FOUND", message: "أمر الشراء غير موجود" });
    assertPurchaseBranch(po, actor);
    if (po.status === "RECEIVED" || po.status === "CANCELLED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "أمر الشراء مستلَم أو ملغى" });
    }

    const items = await tx
      .select({ receivedBaseQuantity: purchaseOrderItems.receivedBaseQuantity })
      .from(purchaseOrderItems)
      .where(eq(purchaseOrderItems.purchaseOrderId, purchaseOrderId));
    if (items.some((i) => (i.receivedBaseQuantity ?? 0) > 0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إلغاء أمر استُلمت منه بضاعة — استعمل مرتجع شراء" });
    }
    // دفاع متعمّق: الدفع للمورد يحدث فقط عند الاستلام ⇒ أمرٌ بلا استلام لا يحمل دفعة.
    if (money(po.paidAmount).gt(0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "أمر الشراء عليه دفعة مسجَّلة — لا يمكن إلغاؤه" });
    }

    await tx.update(purchaseOrders).set({ status: "CANCELLED" }).where(eq(purchaseOrders.id, purchaseOrderId));
    return { purchaseOrderId, status: "CANCELLED" as const };
  });
}

export interface ReceiveLineInput {
  purchaseOrderItemId: number;
  receivedBaseQuantity: number;
}
export interface ReceivePurchaseInput {
  purchaseOrderId: number;
  lines: ReceiveLineInput[];
  payment?: { amount: string; method: PaymentMethod } | null;
  /** Idempotency: نفس المفتاح يُعاد تشغيله بنتيجة الاستلام الأول (لا تكرار للمخزون/AP). */
  clientRequestId?: string | null;
}

export async function receivePurchase(input: ReceivePurchaseInput, actor: Actor & { role?: string }) {
  return withTx(async (tx) => {
    // Idempotency: تكرار الطلب نفسه يُعاد تشغيله بنتيجة الاستلام الأول بلا تكرار للمخزون أو AP.
    // قبل أيّ replay، نتحقّق أنّ المفتاح المخزَّن يخصّ نفس أمر الشراء وفرعه والكميات المطلوبة.
    // كان الـreplay يَعود بنتيجة مضلِّلة (receivedTotal=0.00) دون أيّ تحقّق ⇒ مفتاح يُعاد استعماله
    // على PO مختلف أو بكميات مختلفة كان يُرجع نجاحاً صامتاً ⇒ يَخفي تكرار طلب على كيان مختلف.
    if (input.clientRequestId) {
      const existingRefId = await findIdempotentRefId(tx, "purchase.receive", input.clientRequestId);
      if (existingRefId != null) {
        if (existingRefId !== input.purchaseOrderId) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعارض idempotency: المفتاح مستعمَل لاستلام أمر شراء مختلف",
          });
        }
        const replayPo = (
          await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, input.purchaseOrderId)).limit(1)
        )[0];
        if (!replayPo) throw new TRPCError({ code: "NOT_FOUND", message: "أمر الشراء غير موجود" });
        assertPurchaseBranch(replayPo, actor);
        const replayItems = await tx
          .select()
          .from(purchaseOrderItems)
          .where(eq(purchaseOrderItems.purchaseOrderId, input.purchaseOrderId));
        const replayItemById = new Map(replayItems.map((i) => [Number(i.id), i]));
        const replayInputSum = input.lines.reduce((acc, l) => acc + Number(l.receivedBaseQuantity), 0);
        const replayActualSum = input.lines.reduce((acc, l) => {
          const it = replayItemById.get(l.purchaseOrderItemId);
          if (!it) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "تعارض idempotency: بنود الاستلام لا تخص أمر الشراء المُسجَّل",
            });
          }
          return acc + Number(it.receivedBaseQuantity ?? 0);
        }, 0);
        if (replayActualSum < replayInputSum) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعارض idempotency: كميات الاستلام المطلوبة لا تطابق المسجَّل",
          });
        }
        const replayFully = replayItems.every((r) => (r.receivedBaseQuantity ?? 0) >= r.baseQuantity);
        return {
          purchaseOrderId: input.purchaseOrderId,
          fullyReceived: replayFully,
          receivedTotal: money(replayPo.total).toFixed(2),
          idempotentReplay: true as const,
        };
      }
    }

    const poRows = await tx
      .select()
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, input.purchaseOrderId))
      .for("update")
      .limit(1);
    const po = poRows[0];
    if (!po) throw new TRPCError({ code: "NOT_FOUND", message: "أمر الشراء غير موجود" });
    assertPurchaseBranch(po, actor);
    if (po.status === "RECEIVED" || po.status === "CANCELLED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "أمر الشراء مستلَم أو ملغى" });
    }

    const items = await tx
      .select()
      .from(purchaseOrderItems)
      .where(eq(purchaseOrderItems.purchaseOrderId, input.purchaseOrderId));
    const itemById = new Map(items.map((i) => [Number(i.id), i]));

    // Validate, then sort received lines by variantId for deterministic locking.
    const work = input.lines.map((l) => {
      const item = itemById.get(l.purchaseOrderItemId);
      if (!item) throw new TRPCError({ code: "BAD_REQUEST", message: `بند الشراء ${l.purchaseOrderItemId} لا يخص هذا الأمر` });
      if (!Number.isInteger(l.receivedBaseQuantity) || l.receivedBaseQuantity <= 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "الكمية المستلمة يجب أن تكون صحيحة موجبة" });
      }
      const alreadyReceived = item.receivedBaseQuantity ?? 0;
      if (alreadyReceived + l.receivedBaseQuantity > item.baseQuantity) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `الكمية المستلمة تتجاوز المطلوب للبند ${l.purchaseOrderItemId}` });
      }
      return { line: l, item };
    });
    work.sort((a, b) => Number(a.item.variantId) - Number(b.item.variantId));

    // Batch-load all required data before the loop (eliminates N×3 queries → 3 queries total).
    const variantIds = work.map(({ item }) => Number(item.variantId));
    const unitIds = work.map(({ item }) => Number(item.productUnitId));

    const unitRows = await tx
      .select({ id: productUnits.id, factor: productUnits.conversionFactor })
      .from(productUnits)
      .where(inArray(productUnits.id, unitIds));
    const unitFactorMap = new Map(unitRows.map((u) => [Number(u.id), u.factor]));

    // قفل صفوف branchStock للمتغيّرات المعنية قبل قراءة الـSUM:
    // يَسَلْسِل receive مع أي sale متزامن على نفس المتغيّرات (تلك تأخذ قفلاً على نفس الصفوف
    // عبر applyMovement). بدون هذا القفل، يمكن لـsale متزامن أن يُغيّر الكميات بين قراءة
    // الـSUM وكتابة costPrice ⇒ WAVG محسوب على رصيد قديم. القفل لا يمنع INSERT جديد، لكن
    // branchStock للـvariant موجود إذ بدونه لا يوجد sale (يعمل applyMovement على ضمان الصفّ).
    await tx
      .select({ id: branchStock.id })
      .from(branchStock)
      .where(inArray(branchStock.variantId, variantIds))
      .for("update");

    // Read existing stock per variant (sum across all branches) AFTER the row lock.
    const stockRows = await tx
      .select({
        variantId: branchStock.variantId,
        totalQty: sql<string>`COALESCE(SUM(${branchStock.quantity}), 0)`,
      })
      .from(branchStock)
      .where(inArray(branchStock.variantId, variantIds))
      .groupBy(branchStock.variantId);
    const stockMap = new Map(stockRows.map((s) => [Number(s.variantId), s.totalQty]));

    // Lock all variants for update in one query (deterministic order = ascending variantId).
    const variantRows = await tx
      .select({ id: productVariants.id, cost: productVariants.costPrice })
      .from(productVariants)
      .where(inArray(productVariants.id, variantIds))
      .for("update");
    const costMap = new Map(variantRows.map((v) => [Number(v.id), v.cost]));

    let receivedNet = new Decimal(0);
    for (const { line, item } of work) {
      const factor = new Decimal(unitFactorMap.get(Number(item.productUnitId)) ?? "1");
      const costPerBase = round2(money(item.unitPrice).dividedBy(factor.lte(0) ? new Decimal(1) : factor));

      // WAVG (المتوسّط المرجّح): المخزون القائم + التكلفة القديمة مُقرآن قبل الحلقة.
      // التكلفة صفة عالمية للصنف ⇒ الوزن بإجمالي الأساس عبر الفروع.
      const existingQty = Decimal.max(new Decimal(stockMap.get(Number(item.variantId)) ?? "0"), 0);
      const oldCost = money(costMap.get(Number(item.variantId)) ?? "0");
      const recvQty = new Decimal(line.receivedBaseQuantity);
      const denom = existingQty.plus(recvQty);
      // لا مخزون قائم (أو تكلفة قديمة صفر) ⇒ المتوسّط = تكلفة الشراء الحالية.
      const newCost =
        denom.lte(0) || oldCost.lte(0)
          ? costPerBase
          : round2(existingQty.times(oldCost).plus(recvQty.times(costPerBase)).dividedBy(denom));

      await applyMovement(tx, {
        variantId: Number(item.variantId),
        branchId: Number(po.branchId),
        baseQuantity: line.receivedBaseQuantity,
        movementType: "IN",
        referenceType: "PURCHASE_ORDER",
        referenceId: input.purchaseOrderId,
        createdBy: actor.userId,
      });
      await tx
        .update(purchaseOrderItems)
        .set({ receivedBaseQuantity: (item.receivedBaseQuantity ?? 0) + line.receivedBaseQuantity })
        .where(eq(purchaseOrderItems.id, Number(item.id)));
      // WAVG policy: تكلفة الصنف = المتوسّط المرجّح للمخزون القديم والمستلَم.
      await tx
        .update(productVariants)
        .set({ costPrice: newCost.toFixed(2) })
        .where(eq(productVariants.id, Number(item.variantId)));

      // حدّث الخريطتين بعد كل سطر ليُحسب المتوسّط المرجّح تسلسلياً لو تكرّر الصنف نفسه في أمر الشراء
      // (سطران لنفس المتغيّر) — وإلّا فالسطر الثاني يتجاهل كمية/تكلفة الأول ويطمس نتيجته.
      stockMap.set(Number(item.variantId), denom.toString());
      costMap.set(Number(item.variantId), newCost.toFixed(2));

      // Ledger/AP value derives from the stored line total (proportional to received).
      // مع عمود receivedNet المخزّن لتتبّع التراكم: عند الاستلام المُكمِل للكمية
      // (priorQty + thisQty === baseQuantity) نستعمل remainder = (total − receivedNet المخزّن سابقاً)
      // بدل round على portion ⇒ مجموع AP/PURCHASE يطابق إجمالي الـPO بالضبط (لا انجراف 0.01 IQD).
      const priorReceivedNet = money(item.receivedNet ?? "0");
      const priorQty = item.receivedBaseQuantity ?? 0;
      const isLastReceive = priorQty + line.receivedBaseQuantity === item.baseQuantity;
      let lineNet: Decimal;
      if (isLastReceive) {
        lineNet = round2(money(item.total).minus(priorReceivedNet));
      } else {
        const portion = new Decimal(line.receivedBaseQuantity).dividedBy(item.baseQuantity);
        lineNet = round2(money(item.total).times(portion));
      }
      await tx
        .update(purchaseOrderItems)
        .set({ receivedNet: toDbMoney(priorReceivedNet.plus(lineNet)) })
        .where(eq(purchaseOrderItems.id, Number(item.id)));
      receivedNet = receivedNet.plus(lineNet);
    }
    receivedNet = round2(receivedNet);

    // Proportional tax from the PO's effective rate.
    const poSubtotal = money(po.subtotal);
    const rate = poSubtotal.gt(0) ? money(po.taxAmount).dividedBy(poSubtotal) : new Decimal(0);
    const receivedTax = round2(receivedNet.times(rate));
    const receivedTotal = round2(receivedNet.plus(receivedTax));

    // Final status: fully received if every item meets its ordered base qty.
    const refreshed = await tx
      .select({ baseQuantity: purchaseOrderItems.baseQuantity, receivedBaseQuantity: purchaseOrderItems.receivedBaseQuantity })
      .from(purchaseOrderItems)
      .where(eq(purchaseOrderItems.purchaseOrderId, input.purchaseOrderId));
    const fullyReceived = refreshed.every((r) => (r.receivedBaseQuantity ?? 0) >= r.baseQuantity);
    await tx
      .update(purchaseOrders)
      .set({ status: fullyReceived ? "RECEIVED" : "CONFIRMED" })
      .where(eq(purchaseOrders.id, input.purchaseOrderId));

    // PURCHASE ledger entry + AP.
    await postEntry(tx, {
      entryType: "PURCHASE",
      branchId: Number(po.branchId),
      purchaseOrderId: input.purchaseOrderId,
      supplierId: Number(po.supplierId),
      cost: receivedNet,
      taxAmount: receivedTax,
      amount: receivedTotal,
    });
    await adjustSupplierBalance(tx, Number(po.supplierId), receivedTotal);

    // Optional payment to supplier.
    const paidNow = money(input.payment?.amount ?? "0");
    if (paidNow.gt(0)) {
      const rRes = await tx.insert(receipts).values({
        branchId: Number(po.branchId),
        direction: "OUT",
        amount: toDbMoney(paidNow),
        paymentMethod: input.payment!.method,
        status: "COMPLETED",
        createdBy: actor.userId,
      });
      const receiptId = extractInsertId(rRes);
      await postEntry(tx, {
        entryType: "PAYMENT_OUT",
        branchId: Number(po.branchId),
        purchaseOrderId: input.purchaseOrderId,
        supplierId: Number(po.supplierId),
        receiptId,
        amount: paidNow,
      });
      await adjustSupplierBalance(tx, Number(po.supplierId), paidNow.neg());
      await tx
        .update(purchaseOrders)
        .set({ paidAmount: toDbMoney(money(po.paidAmount).plus(paidNow)) })
        .where(eq(purchaseOrders.id, input.purchaseOrderId));
    }

    // Idempotency: سجّل المفتاح بعد نجاح الكتابة (refId = أمر الشراء).
    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "purchase.receive", input.clientRequestId, input.purchaseOrderId);
    }

    return { purchaseOrderId: input.purchaseOrderId, fullyReceived, receivedTotal: receivedTotal.toFixed(2) };
  });
}
