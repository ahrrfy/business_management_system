import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { desc, eq, inArray, like } from "drizzle-orm";
import {
  invoiceItems,
  invoices,
  productUnits,
  productVariants,
  receipts,
  workOrderMaterials,
  workOrders,
} from "../../drizzle/schema";
import { applyMovement } from "./inventoryService";
import {
  adjustCustomerBalance,
  computeInvoiceStatus,
  postEntry,
} from "./ledgerService";
import { money, round2, sumMoney, toDateStr, toDbMoney } from "./money";
import { withTx, type Actor } from "./tx";

type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";

export interface WorkOrderMaterialInput {
  variantId: number;
  baseQuantity: number;
}

export interface CreateWorkOrderInput {
  branchId: number;
  customerId?: number | null;
  baseVariantId: number; // required: the product being customized (شيلد، درع، …)
  title: string;
  customizationText?: string | null;
  quantity?: number; // default 1
  materials?: WorkOrderMaterialInput[]; // additional consumables
  laborCost?: string; // default 0
  salePrice: string;
  dueDate?: string | null; // YYYY-MM-DD
  notes?: string | null;
}

async function nextWorkOrderNumber(tx: any, branchId: number): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `WO-${branchId}-${ymd}-`;
  const rows = await tx
    .select({ n: workOrders.orderNumber })
    .from(workOrders)
    .where(like(workOrders.orderNumber, `${prefix}%`))
    .orderBy(desc(workOrders.id))
    .for("update")
    .limit(1);
  const last = rows[0]?.n;
  const seq = last ? parseInt(last.slice(prefix.length), 10) + 1 : 1;
  return prefix + String(seq).padStart(5, "0");
}

/** Create a work order in RECEIVED status — stock is NOT consumed yet. */
export async function createWorkOrder(input: CreateWorkOrderInput, actor: Actor) {
  return withTx(async (tx) => {
    if (!input.title.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "عنوان الأمر مطلوب" });
    if (!input.salePrice || money(input.salePrice).lte(0))
      throw new TRPCError({ code: "BAD_REQUEST", message: "سعر البيع يجب أن يكون موجباً" });
    const qty = Math.trunc(input.quantity ?? 1);
    if (!Number.isInteger(qty) || qty <= 0)
      throw new TRPCError({ code: "BAD_REQUEST", message: "الكمية يجب أن تكون عدداً صحيحاً موجباً" });

    // Validate the base variant exists (required so we can issue an invoice on delivery).
    const base = (
      await tx.select().from(productVariants).where(eq(productVariants.id, input.baseVariantId)).limit(1)
    )[0];
    if (!base) throw new TRPCError({ code: "NOT_FOUND", message: "المنتج الأساس لأمر الشغل غير موجود" });

    // Validate materials list — allow zero materials (printing-only WO).
    for (const m of input.materials ?? []) {
      if (!Number.isInteger(m.baseQuantity) || m.baseQuantity <= 0)
        throw new TRPCError({ code: "BAD_REQUEST", message: "كميات المواد يجب أن تكون أعداداً صحيحة موجبة" });
      const v = await tx.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.id, m.variantId)).limit(1);
      if (!v[0]) throw new TRPCError({ code: "NOT_FOUND", message: `مادة #${m.variantId} غير موجودة` });
    }

    const orderNumber = await nextWorkOrderNumber(tx, input.branchId);
    const insRes = await tx.insert(workOrders).values({
      orderNumber,
      branchId: input.branchId,
      customerId: input.customerId ?? null,
      baseVariantId: input.baseVariantId,
      title: input.title.trim(),
      customizationText: input.customizationText?.trim() || null,
      quantity: qty,
      materialsCost: "0",
      laborCost: input.laborCost ? round2(money(input.laborCost)).toFixed(2) : "0.00",
      salePrice: round2(money(input.salePrice)).toFixed(2),
      status: "RECEIVED",
      dueDate: input.dueDate ? new Date(input.dueDate) : null,
      createdBy: actor.userId,
    });
    const workOrderId = Number((insRes as any)[0]?.insertId ?? (insRes as any).insertId);

    for (const m of input.materials ?? []) {
      await tx.insert(workOrderMaterials).values({
        workOrderId,
        variantId: m.variantId,
        baseQuantity: m.baseQuantity,
        unitCost: "0", // snapshot on consumption
      });
    }

    return { workOrderId, orderNumber };
  });
}

async function loadWorkOrder(tx: any, workOrderId: number) {
  const rows = await tx.select().from(workOrders).where(eq(workOrders.id, workOrderId)).for("update").limit(1);
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "أمر الشغل غير موجود" });
  return rows[0];
}

/** Move RECEIVED → IN_PROGRESS: consume materials from stock (OUT movements) + snapshot unitCost. */
export async function startWorkOrder(workOrderId: number, actor: Actor) {
  return withTx(async (tx) => {
    const wo = await loadWorkOrder(tx, workOrderId);
    if (wo.status !== "RECEIVED") throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن بدء أمر ليس في حالة الاستلام" });

    const mats = await tx.select().from(workOrderMaterials).where(eq(workOrderMaterials.workOrderId, workOrderId));
    // Deterministic lock order: ascending variantId.
    mats.sort((a, b) => Number(a.variantId) - Number(b.variantId));

    // Batch-load all variant costs in one query instead of N queries inside the loop.
    const variantIds = mats.map((m) => Number(m.variantId));
    const costRows = variantIds.length > 0
      ? await tx.select({ id: productVariants.id, costPrice: productVariants.costPrice })
          .from(productVariants)
          .where(inArray(productVariants.id, variantIds))
      : [];
    const costMap = new Map(costRows.map((v) => [Number(v.id), v.costPrice]));

    let materialsCost = new Decimal(0);
    for (const m of mats) {
      // Snapshot unit cost from variant.costPrice at consumption.
      const unitCost = round2(money(costMap.get(Number(m.variantId)) ?? "0"));
      const lineCost = round2(unitCost.times(m.baseQuantity));
      materialsCost = materialsCost.plus(lineCost);
      await tx.update(workOrderMaterials).set({ unitCost: unitCost.toFixed(2) }).where(eq(workOrderMaterials.id, Number(m.id)));
      await applyMovement(tx, {
        variantId: Number(m.variantId),
        branchId: Number(wo.branchId),
        baseQuantity: m.baseQuantity,
        movementType: "OUT",
        referenceType: "WORK_ORDER",
        referenceId: workOrderId,
        createdBy: actor.userId,
      });
    }
    materialsCost = round2(materialsCost);

    await tx
      .update(workOrders)
      .set({ status: "IN_PROGRESS", materialsCost: materialsCost.toFixed(2) })
      .where(eq(workOrders.id, workOrderId));
    return { workOrderId, status: "IN_PROGRESS", materialsCost: materialsCost.toFixed(2) };
  });
}

/** IN_PROGRESS → READY (no stock change). */
export async function markWorkOrderReady(workOrderId: number) {
  return withTx(async (tx) => {
    const wo = await loadWorkOrder(tx, workOrderId);
    if (wo.status !== "IN_PROGRESS") throw new TRPCError({ code: "BAD_REQUEST", message: "الأمر ليس قيد التنفيذ" });
    await tx.update(workOrders).set({ status: "READY" }).where(eq(workOrders.id, workOrderId));
    return { workOrderId, status: "READY" };
  });
}

export interface DeliverWorkOrderInput {
  workOrderId: number;
  payment?: { amount: string; method: PaymentMethod } | null;
}

/** READY → DELIVERED: create invoice (sourceType=WORKORDER) + optional payment + SALE entry + AR adjust. */
export async function deliverWorkOrder(input: DeliverWorkOrderInput, actor: Actor) {
  return withTx(async (tx) => {
    const wo = await loadWorkOrder(tx, input.workOrderId);
    if (wo.status !== "READY") throw new TRPCError({ code: "BAD_REQUEST", message: "الأمر ليس جاهزاً للتسليم" });

    // Look up the base unit of the base variant for the invoice line.
    const baseUnit = (
      await tx
        .select({ id: productUnits.id })
        .from(productUnits)
        .where(eq(productUnits.variantId, Number(wo.baseVariantId)))
        .limit(1)
    )[0];

    const quantity = wo.quantity;
    const salePrice = money(wo.salePrice);
    const unitPrice = round2(salePrice.dividedBy(quantity));
    const materialsCost = money(wo.materialsCost);
    const laborCost = money(wo.laborCost);
    const costTotal = round2(materialsCost.plus(laborCost));

    // Credit-sale guard.
    const paidNow = money(input.payment?.amount ?? "0");
    if (paidNow.lt(salePrice) && !wo.customerId)
      throw new TRPCError({ code: "BAD_REQUEST", message: "أمر الشغل الآجل يتطلب عميلاً محدداً" });
    if (paidNow.lt(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ المدفوع لا يمكن أن يكون سالباً" });
    if (paidNow.gt(salePrice)) throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ المدفوع يتجاوز إجمالي الأمر" });

    // Invoice number — reuse the invoice numbering (per-branch daily seq).
    const { nextInvoiceNumber } = await import("./numbering");
    const invoiceNumber = await nextInvoiceNumber(tx, Number(wo.branchId));
    const status = computeInvoiceStatus(salePrice.toFixed(2), toDbMoney(paidNow));
    const sourceId = `WO-${wo.id}`;
    const invRes = await tx.insert(invoices).values({
      invoiceNumber,
      sourceType: "WORKORDER",
      sourceId,
      branchId: Number(wo.branchId),
      customerId: wo.customerId ?? null,
      priceTier: "RETAIL",
      subtotal: salePrice.toFixed(2),
      taxAmount: "0.00",
      discountAmount: "0.00",
      total: salePrice.toFixed(2),
      costTotal: costTotal.toFixed(2),
      status,
      paidAmount: toDbMoney(paidNow),
      paymentMethod: input.payment?.method ?? null,
      paymentDate: paidNow.gt(0) ? new Date() : null,
      notes: `أمر شغل ${wo.orderNumber}: ${wo.title}`,
      createdBy: actor.userId,
    });
    const invoiceId = Number((invRes as any)[0]?.insertId ?? (invRes as any).insertId);

    await tx.insert(invoiceItems).values({
      invoiceId,
      variantId: Number(wo.baseVariantId),
      productUnitId: baseUnit ? Number(baseUnit.id) : null,
      workOrderId: Number(wo.id),
      quantity: Number(quantity).toFixed(3),
      baseQuantity: quantity,
      unitPrice: unitPrice.toFixed(2),
      unitCost: round2(costTotal.dividedBy(quantity)).toFixed(2),
      discountAmount: "0",
      total: salePrice.toFixed(2),
    });

    // Ledger: SALE entry (no stock movement here — already consumed at start).
    await postEntry(tx, {
      entryType: "SALE",
      branchId: Number(wo.branchId),
      invoiceId,
      customerId: wo.customerId ?? null,
      revenue: salePrice,
      cost: costTotal,
      profit: round2(salePrice.minus(costTotal)),
      amount: salePrice,
    });

    // AR if credit portion.
    if (wo.customerId) {
      const unpaid = round2(salePrice.minus(paidNow));
      if (unpaid.gt(0)) await adjustCustomerBalance(tx, Number(wo.customerId), unpaid);
    }

    // Optional payment receipt + PAYMENT_IN entry.
    if (paidNow.gt(0)) {
      const rRes = await tx.insert(receipts).values({
        branchId: Number(wo.branchId),
        direction: "IN",
        amount: toDbMoney(paidNow),
        paymentMethod: input.payment!.method,
        status: "COMPLETED",
        invoiceId,
        createdBy: actor.userId,
      });
      const receiptId = Number((rRes as any)[0]?.insertId ?? (rRes as any).insertId);
      await postEntry(tx, {
        entryType: "PAYMENT_IN",
        branchId: Number(wo.branchId),
        invoiceId,
        receiptId,
        customerId: wo.customerId ?? null,
        amount: paidNow,
      });
    }

    await tx
      .update(workOrders)
      .set({ status: "DELIVERED", invoiceId, deliveredAt: new Date() })
      .where(eq(workOrders.id, Number(wo.id)));

    return { workOrderId: Number(wo.id), invoiceId, invoiceNumber, status };
  });
}

/** Cancel: restocks consumed materials if status was IN_PROGRESS/READY. */
export async function cancelWorkOrder(workOrderId: number, actor: Actor) {
  return withTx(async (tx) => {
    const wo = await loadWorkOrder(tx, workOrderId);
    if (wo.status === "DELIVERED" || wo.status === "CANCELLED")
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إلغاء أمر مُسلَّم أو مُلغى" });
    if (wo.status === "IN_PROGRESS" || wo.status === "READY") {
      const mats = await tx.select().from(workOrderMaterials).where(eq(workOrderMaterials.workOrderId, workOrderId));
      mats.sort((a, b) => Number(a.variantId) - Number(b.variantId));
      for (const m of mats) {
        await applyMovement(tx, {
          variantId: Number(m.variantId),
          branchId: Number(wo.branchId),
          baseQuantity: m.baseQuantity,
          movementType: "IN",
          referenceType: "WORK_ORDER_CANCEL",
          referenceId: workOrderId,
          createdBy: actor.userId,
        });
      }
    }
    await tx.update(workOrders).set({ status: "CANCELLED" }).where(eq(workOrders.id, workOrderId));
    return { workOrderId, status: "CANCELLED" };
  });
}

// Silence "unused" hint for sumMoney import kept for parity with other services.
void sumMoney;
