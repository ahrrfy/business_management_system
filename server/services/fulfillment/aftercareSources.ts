import { and, eq, inArray, ne, sql } from "drizzle-orm";
import {
  aftercareCases,
  aftercareLines,
  type AftercareCase,
} from "../../../drizzle/fulfillmentSchema";
import {
  branchStock,
  deliveryConsignments,
  invoiceItemBundleComponents,
  invoiceItems,
  invoices,
  inventoryMovements,
  productVariants,
  products,
  workOrders,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import type { Actor } from "../tx";
import { assertFulfillmentBranch, fulfillmentError } from "./core";

export type AftercareSourceInput = { invoiceId?: number; workOrderId?: number };

/** Original document is the common mutex with sale correction and return. */
export async function lockAftercareSourceTx(
  tx: Tx,
  input: AftercareSourceInput,
  actor: Actor,
) {
  if (Boolean(input.invoiceId) === Boolean(input.workOrderId))
    throw fulfillmentError("اختر فاتورة أصلية أو أمر شغل واحداً");
  let invoiceId = input.invoiceId;
  let sourceWorkOrderId = input.workOrderId;
  if (!sourceWorkOrderId && invoiceId) {
    const linkedOrders = await tx
      .select({ id: workOrders.id })
      .from(workOrders)
      .where(eq(workOrders.invoiceId, invoiceId))
      .limit(2);
    if (linkedOrders.length > 1)
      throw fulfillmentError(
        "الفاتورة مرتبطة بأكثر من أمر شغل؛ افتح أمر الشغل المقصود من تفاصيله",
        "CONFLICT",
      );
    sourceWorkOrderId = linkedOrders[0]?.id;
  }
  let orderSource: typeof workOrders.$inferSelect | undefined;
  if (sourceWorkOrderId) {
    const [order] = await tx
      .select()
      .from(workOrders)
      .where(eq(workOrders.id, sourceWorkOrderId))
      .for("update")
      .limit(1);
    if (!order) throw fulfillmentError("أمر الشغل غير موجود", "NOT_FOUND");
    assertFulfillmentBranch(actor, order.branchId);
    orderSource = order;
    if (order.invoiceId != null) invoiceId = order.invoiceId;
    else {
      const [item] = await tx
        .select({ invoiceId: invoiceItems.invoiceId })
        .from(invoiceItems)
        .where(eq(invoiceItems.workOrderId, order.id))
        .limit(1)
        .for("share");
      if (!item)
        throw fulfillmentError(
          "أمر الشغل لا يملك فاتورة تسليم أصلية موثقة؛ راجع مستند التسليم",
        );
      invoiceId = item.invoiceId;
    }
    if (input.invoiceId != null && invoiceId !== input.invoiceId)
      throw fulfillmentError(
        "رابط فاتورة أمر الشغل تغيّر؛ أعد معاينة الأصل",
        "CONFLICT",
      );
  }
  if (!invoiceId) throw fulfillmentError("الفاتورة الأصلية غير محددة");
  const [invoice] = await tx
    .select()
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .for("update")
    .limit(1);
  if (!invoice)
    throw fulfillmentError("الفاتورة الأصلية غير موجودة", "NOT_FOUND");
  assertFulfillmentBranch(actor, Number(invoice.branchId));
  if (orderSource && invoice.sourceType !== "WORKORDER")
    throw fulfillmentError("فاتورة أمر الشغل لا تطابق مصدر التسليم");
  if (
    orderSource &&
    (orderSource.branchId !== invoice.branchId ||
      orderSource.customerId !== invoice.customerId)
  )
    throw fulfillmentError("فرع أو عميل فاتورة أمر الشغل لا يطابق الأصل");
  const items = await tx
    .select()
    .from(invoiceItems)
    .where(eq(invoiceItems.invoiceId, invoice.id))
    .orderBy(invoiceItems.id)
    .for("update");
  // Recheck the true backlink after obtaining the source mutex; the discovery read
  // above must not take a shared WO lock before upgrading it to FOR UPDATE.
  if (orderSource) {
    const linkedOrders = await tx
      .select({ id: workOrders.id })
      .from(workOrders)
      .where(eq(workOrders.invoiceId, invoice.id))
      .limit(2)
      .for("share");
    if (
      (input.invoiceId != null || !items.length) &&
      (linkedOrders.length !== 1 || linkedOrders[0].id !== orderSource.id)
    )
      throw fulfillmentError(
        "رابط فاتورة أمر الشغل غير منفرد؛ افتح الأصل الصحيح وحقق في علاقة التسليم",
        "CONFLICT",
      );
  }
  const pureWorkOrder =
    !items.length &&
    orderSource?.baseVariantId == null &&
    orderSource?.invoiceId === invoice.id &&
    invoice.sourceType === "WORKORDER"
      ? orderSource
      : null;
  if (!items.length && !pureWorkOrder)
    throw fulfillmentError(
      "لا توجد أسطر أصلية أو علاقة أمر خدمة خالص موثقة؛ راجع مستند التسليم",
    );
  if (
    pureWorkOrder &&
    (!Number.isSafeInteger(pureWorkOrder.quantity) ||
      pureWorkOrder.quantity <= 0)
  )
    throw fulfillmentError(
      "كمية مخرجات أمر الشغل الأصلية غير موثقة؛ راجع الأصل قبل اعتماد إعادة التنفيذ",
    );
  const components = items.length
    ? await tx
        .select()
        .from(invoiceItemBundleComponents)
        .where(
          inArray(
            invoiceItemBundleComponents.invoiceItemId,
            items.map((item) => item.id),
          ),
        )
        .orderBy(invoiceItemBundleComponents.id)
        .for("update")
    : [];
  return { invoice, items, components, orderSource, pureWorkOrder };
}

export type SourceSnapshot = Awaited<ReturnType<typeof lockAftercareSourceTx>>;
export function assertEligibleAftercareSource(source: SourceSnapshot) {
  if (["CANCELLED", "SUPERSEDED", "RETURNED"].includes(source.invoice.status))
    throw fulfillmentError(
      "الفاتورة الأصلية ملغاة أو مستبدلة أو مرتجعة؛ افتح المستند الساري",
    );
  if (source.orderSource && source.orderSource.status !== "DELIVERED")
    throw fulfillmentError(
      "يلزم أمر شغل مسلّم فعلياً؛ جهّز الطلب الأصلي قبل فتح معالجة",
    );
}
export type AftercareSourceLine = {
  originalInvoiceItemId?: number | null;
  sourceWorkOrderId?: number | null;
  originalBundleComponentId?: number | null;
  componentVariantId?: number | null;
  baseQuantity: number;
  disposition: "MISSING_HELD" | "REPLACEMENT" | "REPRINT";
  originalMovementId?: number | null;
};

export async function assertAftercareCapsTx(
  tx: Tx,
  source: SourceSnapshot,
  lines: AftercareSourceLine[],
  excludingCaseId?: number,
) {
  assertEligibleAftercareSource(source);
  const own = new Map<string, number>();
  const heldByMovement = new Map<number, number>();
  let ownWorkOrderQuantity = 0;
  for (const line of lines) {
    if (!Number.isSafeInteger(line.baseQuantity) || line.baseQuantity <= 0)
      throw fulfillmentError("الكمية الأساس يجب أن تكون عدداً صحيحاً موجباً");
    if (source.pureWorkOrder) {
      const order = source.pureWorkOrder;
      if (
        line.sourceWorkOrderId !== order.id ||
        line.originalInvoiceItemId != null ||
        line.componentVariantId != null ||
        line.originalBundleComponentId != null ||
        line.originalMovementId != null ||
        line.disposition !== "REPRINT"
      )
        throw fulfillmentError(
          "الخدمة الخالصة تقبل إعادة تنفيذ مرتبطة بأمر الشغل نفسه فقط، دون صنف أو سطر فاتورة مختلق",
        );
      ownWorkOrderQuantity += line.baseQuantity;
      const [allocated] = await tx
        .select({
          quantity: sql<number>`COALESCE(SUM(${aftercareLines.baseQuantity}),0)`,
        })
        .from(aftercareLines)
        .innerJoin(aftercareCases, eq(aftercareCases.id, aftercareLines.caseId))
        .where(
          and(
            eq(aftercareLines.sourceWorkOrderId, order.id),
            ne(aftercareCases.status, "CANCELLED"),
            excludingCaseId
              ? ne(aftercareCases.id, excludingCaseId)
              : undefined,
          ),
        )
        .for("share");
      if (
        Number(allocated?.quantity ?? 0) + ownWorkOrderQuantity >
        order.quantity
      )
        throw fulfillmentError(
          "كمية إعادة التنفيذ تتجاوز مخرجات أمر الشغل الأصلي بعد المعالجات السابقة",
          "CONFLICT",
        );
      continue;
    }
    if (
      line.sourceWorkOrderId != null ||
      line.originalInvoiceItemId == null ||
      line.componentVariantId == null
    )
      throw fulfillmentError(
        "حدد سطر الفاتورة ومكوّنه الحقيقي؛ المصدر ليس أمر خدمة خالصاً",
      );
    const item = source.items.find(
      (item) => item.id === line.originalInvoiceItemId,
    );
    if (!item) throw fulfillmentError("سطر المعالجة لا ينتمي للفاتورة الأصلية");
    const snapshots = source.components.filter(
      (part) => part.invoiceItemId === item.id,
    );
    const component = snapshots.find(
      (part) =>
        part.id === line.originalBundleComponentId &&
        part.componentVariantId === line.componentVariantId,
    );
    if (snapshots.length && !component)
      throw fulfillmentError(
        "اختر المكوّن من لقطة البكج وقت البيع؛ وصفة اليوم ليست دليلاً",
      );
    if (
      !snapshots.length &&
      (line.originalBundleComponentId ||
        item.variantId !== line.componentVariantId)
    )
      throw fulfillmentError("هوية الصنف لا تطابق السطر الأصلي");
    // Snapshot is per bundle base unit; multiply by the unreturned original units.
    const remaining = component
      ? component.componentBaseQuantity *
        (item.baseQuantity - item.returnedBaseQuantity)
      : item.baseQuantity - item.returnedBaseQuantity;
    const key = `${item.id}:${line.componentVariantId}`;
    own.set(key, (own.get(key) ?? 0) + line.baseQuantity);
    const [allocated] = await tx
      .select({
        quantity: sql<number>`COALESCE(SUM(${aftercareLines.baseQuantity}),0)`,
      })
      .from(aftercareLines)
      .innerJoin(aftercareCases, eq(aftercareCases.id, aftercareLines.caseId))
      .where(
        and(
          eq(aftercareLines.originalInvoiceItemId, item.id),
          eq(aftercareLines.componentVariantId, line.componentVariantId),
          ne(aftercareCases.status, "CANCELLED"),
          excludingCaseId ? ne(aftercareCases.id, excludingCaseId) : undefined,
        ),
      )
      .for("share");
    if (Number(allocated?.quantity ?? 0) + own.get(key)! > remaining)
      throw fulfillmentError(
        "كمية المعالجة تتجاوز صافي الأصل بعد المرتجعات والمعالجات السابقة",
        "CONFLICT",
      );
    if (line.disposition === "MISSING_HELD") {
      if (!line.originalMovementId)
        throw fulfillmentError(
          "استكمال المبيع يستلزم حركة الخصم الأصلية وإثبات وجوده بعهدتنا",
        );
      const [movement] = await tx
        .select()
        .from(inventoryMovements)
        .where(eq(inventoryMovements.id, line.originalMovementId))
        .for("share")
        .limit(1);
      const heldQuantity =
        (heldByMovement.get(line.originalMovementId) ?? 0) + line.baseQuantity;
      heldByMovement.set(line.originalMovementId, heldQuantity);
      if (
        !movement ||
        movement.branchId !== source.invoice.branchId ||
        movement.variantId !== line.componentVariantId ||
        movement.movementType !== "OUT" ||
        !(
          (movement.referenceType === "INVOICE" &&
            movement.referenceId === source.invoice.id) ||
          (movement.referenceType === "WORK_ORDER" &&
            item.workOrderId != null &&
            movement.referenceId === item.workOrderId &&
            source.invoice.sourceType === "WORKORDER")
        ) ||
        movement.quantity < heldQuantity
      )
        throw fulfillmentError(
          "حركة الخصم لا تثبت كمية المبيع المطلوبة من هذه الفاتورة",
        );
      const [stock] = await tx
        .select({ lastCountedAt: branchStock.lastCountedAt })
        .from(branchStock)
        .where(
          and(
            eq(branchStock.variantId, line.componentVariantId),
            eq(branchStock.branchId, source.invoice.branchId),
          ),
        )
        .for("share")
        .limit(1);
      const [adjustment] = await tx
        .select({ id: inventoryMovements.id })
        .from(inventoryMovements)
        .where(
          and(
            eq(inventoryMovements.branchId, source.invoice.branchId),
            eq(inventoryMovements.variantId, line.componentVariantId),
            eq(inventoryMovements.movementType, "ADJUST"),
            sql`${inventoryMovements.createdAt} >= ${movement.createdAt}`,
          ),
        )
        .for("share")
        .limit(1);
      if (
        adjustment ||
        (stock?.lastCountedAt && stock.lastCountedAt >= movement.createdAt)
      )
        throw fulfillmentError(
          "أُجري جرد أو تعديل بعد الخصم الأصلي؛ حقق في ملكية القطعة قبل اختيار استكمال مبيع بعهدتنا",
        );
      const [other] = await tx
        .select({
          quantity: sql<number>`COALESCE(SUM(${aftercareLines.baseQuantity}),0)`,
        })
        .from(aftercareLines)
        .innerJoin(aftercareCases, eq(aftercareCases.id, aftercareLines.caseId))
        .where(
          and(
            eq(aftercareLines.originalMovementId, movement.id),
            ne(aftercareCases.status, "CANCELLED"),
            excludingCaseId
              ? ne(aftercareCases.id, excludingCaseId)
              : undefined,
          ),
        )
        .for("share");
      if (Number(other?.quantity ?? 0) + heldQuantity > movement.quantity)
        throw fulfillmentError(
          "حركة الخصم الأصلية مستنفدة في عهدة معالجة أخرى",
          "CONFLICT",
        );
    }
  }
}

/** Call under the invoice lock from return/correct/cancel before reducing its source. */
export async function assertNoActiveAftercareForInvoiceTx(
  tx: Tx,
  invoiceId: number,
) {
  const [active] = await tx
    .select({ id: aftercareCases.id })
    .from(aftercareCases)
    .leftJoin(
      invoiceItems,
      eq(invoiceItems.workOrderId, aftercareCases.workOrderId),
    )
    .leftJoin(workOrders, eq(workOrders.id, aftercareCases.workOrderId))
    .where(
      and(
        sql`(${aftercareCases.invoiceId} = ${invoiceId} OR ${invoiceItems.invoiceId} = ${invoiceId} OR ${workOrders.invoiceId} = ${invoiceId})`,
        inArray(aftercareCases.status, ["DRAFT", "APPROVED", "IN_PROGRESS"]),
      ),
    )
    .limit(1)
    .for("share");
  if (active)
    throw fulfillmentError(
      "توجد معالجة أو عهدة مبيع فعالة؛ سوّها وألغ تخصيصها قبل المرتجع أو التصحيح",
      "CONFLICT",
    );
}

export async function validateOriginalConsignmentTx(
  tx: Tx,
  id: number | undefined,
  source: SourceSnapshot,
) {
  if (!id) return;
  const [row] = await tx
    .select()
    .from(deliveryConsignments)
    .where(eq(deliveryConsignments.id, id))
    .for("share")
    .limit(1);
  if (
    !row ||
    row.branchId !== source.invoice.branchId ||
    row.invoiceId !== source.invoice.id
  )
    throw fulfillmentError("الإرسالية المرجعية لا تخص الأصل والفرع المحددين");
}

export function caseSource(row: AftercareCase): AftercareSourceInput {
  return row.invoiceId
    ? { invoiceId: row.invoiceId }
    : { workOrderId: row.workOrderId ?? undefined };
}

export async function loadAftercareProductTx(tx: Tx, variantId: number) {
  const [row] = await tx
    .select({
      id: productVariants.id,
      costPrice: productVariants.costPrice,
      isActive: productVariants.isActive,
      name: products.name,
      variantName: productVariants.variantName,
      isService: products.isService,
      isBundle: products.isBundle,
      isConsignment: products.isConsignment,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(productVariants.id, variantId))
    .for("share")
    .limit(1);
  if (
    !row ||
    !row.isActive ||
    row.isService ||
    row.isBundle ||
    row.isConsignment
  )
    throw fulfillmentError("اختر صنف مخزون فعالاً للمكوّن أو الخامة");
  return row;
}
