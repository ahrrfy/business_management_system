import { and, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import {
  aftercareCases,
  aftercareLines,
  aftercareExecutions,
  aftercareExecutionLines,
} from "../../../drizzle/fulfillmentSchema";
import {
  accountingEntries,
  branchStock,
  customers,
  deliveryConsignments,
  deliveryLedgerEntries,
  deliveryParties,
  inventoryMovements,
  invoices,
  productVariants,
  products,
  receipts,
  users,
  workOrders,
} from "../../../drizzle/schema";
import type { AftercareCaseStatus } from "../../../shared/fulfillment";
import { canCrossBranches } from "../../lib/branchAuthority";
import type { Tx } from "../../db";
import { prepareDeliveryBarcodeLookup } from "../delivery/barcodeLookupPolicy";
import { withTx, type Actor } from "../tx";
import { loadVariantAvailability } from "../catalog/variantAvailability";
import { fulfillmentCostVisibleTx } from "./visibility";
import {
  assertFulfillmentBranch,
  fulfillmentError,
  loadAftercareCaseTx,
} from "./core";
import {
  assertEligibleAftercareSource,
  lockAftercareSourceTx,
  type AftercareSourceInput,
} from "./aftercareSources";

export async function listAftercareCases(
  input: {
    branchId?: number;
    status?: AftercareCaseStatus;
    search?: string;
    page?: number;
    pageSize?: number;
  },
  actor: Actor,
) {
  const branchId = canCrossBranches(actor) ? input.branchId : actor.branchId;
  if (branchId) assertFulfillmentBranch(actor, branchId);
  else if (!canCrossBranches(actor)) assertFulfillmentBranch(actor, 0);
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 20));
  return withTx(
    async (tx) => {
      const search = input.search?.trim();
      const predicate = and(
        branchId ? eq(aftercareCases.branchId, branchId) : undefined,
        input.status ? eq(aftercareCases.status, input.status) : undefined,
        search
          ? or(
              like(aftercareCases.caseNumber, `%${search}%`),
              like(aftercareCases.reason, `%${search}%`),
              like(customers.name, `%${search}%`),
              like(customers.phone, `%${search}%`),
              sql`CAST(${aftercareCases.invoiceId} AS CHAR) = ${search}`,
            )
          : undefined,
      );
      const rows = await tx
        .select({
          id: aftercareCases.id,
          caseNumber: aftercareCases.caseNumber,
          branchId: aftercareCases.branchId,
          invoiceId: aftercareCases.invoiceId,
          workOrderId: aftercareCases.workOrderId,
          customerName: customers.name,
          status: aftercareCases.status,
          reason: aftercareCases.reason,
          createdAt: aftercareCases.createdAt,
          version: aftercareCases.version,
        })
        .from(aftercareCases)
        .leftJoin(customers, eq(customers.id, aftercareCases.customerId))
        .where(predicate)
        .orderBy(desc(aftercareCases.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const [count] = await tx
        .select({ total: sql<number>`COUNT(*)` })
        .from(aftercareCases)
        .leftJoin(customers, eq(customers.id, aftercareCases.customerId))
        .where(predicate);
      return { rows, total: Number(count?.total ?? 0), page, pageSize };
    },
    { gate: "NONE" },
  );
}

export async function getAftercareCase(id: number, actor: Actor) {
  return withTx(
    async (tx) => {
      const row = await loadAftercareCaseTx(tx, id, actor);
      const costVisible = await fulfillmentCostVisibleTx(tx, actor);
      const lines = await tx
        .select({
          line: aftercareLines,
          productName: products.name,
          variantName: productVariants.variantName,
          sku: productVariants.sku,
        })
        .from(aftercareLines)
        .innerJoin(
          productVariants,
          eq(productVariants.id, aftercareLines.componentVariantId),
        )
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(eq(aftercareLines.caseId, id))
        .orderBy(aftercareLines.id);
      const executions = await tx
        .select({
          execution: aftercareExecutions,
          partyName: deliveryParties.name,
          consignmentNumber: deliveryConsignments.consignmentNumber,
          externalTrackingRef: deliveryConsignments.externalTrackingRef,
        })
        .from(aftercareExecutions)
        .leftJoin(
          deliveryConsignments,
          eq(deliveryConsignments.id, aftercareExecutions.consignmentId),
        )
        .leftJoin(
          deliveryParties,
          eq(deliveryParties.id, aftercareExecutions.partyId),
        )
        .where(eq(aftercareExecutions.caseId, id))
        .orderBy(desc(aftercareExecutions.id));
      const executionIds = executions.map(({ execution }) => execution.id);
      const executionLines = executionIds.length
        ? await tx
            .select({
              line: aftercareExecutionLines,
              productName: products.name,
              variantName: productVariants.variantName,
            })
            .from(aftercareExecutionLines)
            .innerJoin(
              productVariants,
              eq(productVariants.id, aftercareExecutionLines.variantId),
            )
            .innerJoin(products, eq(products.id, productVariants.productId))
            .where(inArray(aftercareExecutionLines.executionId, executionIds))
            .orderBy(aftercareExecutionLines.id)
        : [];
      const consignmentIds = executions.flatMap(({ execution }) =>
        execution.consignmentId ? [execution.consignmentId] : [],
      );
      const fees = consignmentIds.length
        ? await tx
            .select({
              consignmentId: deliveryLedgerEntries.consignmentId,
              earned: sql<string>`SUM(CASE WHEN ${deliveryLedgerEntries.entryType}='FEE_EARNED' THEN ${deliveryLedgerEntries.amount} WHEN ${deliveryLedgerEntries.entryType}='FEE_REFUNDED' THEN -${deliveryLedgerEntries.amount} ELSE 0 END)`,
              paid: sql<string>`SUM(CASE WHEN ${deliveryLedgerEntries.entryType} IN ('FEE_PAID','FEE_OFFSET') THEN ${deliveryLedgerEntries.amount} ELSE 0 END)`,
              due: sql<string>`SUM(CASE WHEN ${deliveryLedgerEntries.entryType}='FEE_EARNED' THEN ${deliveryLedgerEntries.amount} WHEN ${deliveryLedgerEntries.entryType} IN ('FEE_REFUNDED','FEE_PAID','FEE_OFFSET') THEN -${deliveryLedgerEntries.amount} ELSE 0 END)`,
            })
            .from(deliveryLedgerEntries)
            .where(inArray(deliveryLedgerEntries.consignmentId, consignmentIds))
            .groupBy(deliveryLedgerEntries.consignmentId)
        : [];
      const receiptRows = consignmentIds.length
        ? await tx
            .selectDistinct({
              id: receipts.id,
              amount: receipts.amount,
              direction: receipts.direction,
              paymentMethod: receipts.paymentMethod,
              cashBucket: receipts.cashBucket,
              referenceNumber: receipts.referenceNumber,
              createdAt: receipts.createdAt,
            })
            .from(receipts)
            .innerJoin(
              accountingEntries,
              eq(accountingEntries.receiptId, receipts.id),
            )
            .innerJoin(
              aftercareExecutions,
              and(
                eq(
                  aftercareExecutions.partyId,
                  accountingEntries.deliveryPartyId,
                ),
                or(
                  sql`${accountingEntries.dedupeKey} LIKE CONCAT('DELIVERY_FEE_PAID:',${aftercareExecutions.consignmentId},':%')`,
                  and(
                    sql`${accountingEntries.dedupeKey} = CONCAT('AFTERCARE_FEE_PAYMENT:',${receipts.id})`,
                    sql`EXISTS (SELECT 1 FROM deliveryLedgerEntries dl WHERE dl.consignmentId = ${aftercareExecutions.consignmentId} AND dl.eventKey = CONCAT('AC:',${aftercareExecutions.id},':FEE_PAID:',${receipts.id}))`,
                  ),
                ),
              ),
            )
            .where(
              and(
                eq(aftercareExecutions.caseId, id),
                eq(accountingEntries.entryType, "DELIVERY_FEE"),
                eq(receipts.branchId, row.branchId),
              ),
            )
        : [];
      const actorIds = [row.createdBy, row.approvedBy, row.resolvedBy].filter(
        (value): value is number => value != null,
      );
      const actors = actorIds.length
        ? await tx
            .select({ id: users.id, name: users.name })
            .from(users)
            .where(inArray(users.id, actorIds))
        : [];
      return {
        case: row,
        lines: lines.map(({ line, ...label }) => ({ ...line, ...label })),
        executions: executions.map(
          ({
            execution,
            partyName,
            consignmentNumber,
            externalTrackingRef,
          }) => ({
            ...execution,
            totalCost: costVisible ? execution.totalCost : null,
            partyName,
            consignmentNumber,
            externalTrackingRef,
            feeLedger: fees.find(
              (fee) => fee.consignmentId === execution.consignmentId,
            ) ?? { earned: "0.00", paid: "0.00", due: "0.00" },
            lines: executionLines
              .filter(({ line }) => line.executionId === execution.id)
              .map(({ line, ...label }) => ({
                ...line,
                ...label,
                unitCost: costVisible ? line.unitCost : null,
                lineCost: costVisible ? line.lineCost : null,
              })),
          }),
        ),
        receipts: receiptRows,
        actors,
      };
    },
    { gate: "NONE" },
  );
}

export async function resolveAftercareExecution(
  executionId: number,
  actor: Actor,
) {
  return withTx(
    async (tx) => {
      const [execution] = await tx
        .select({
          id: aftercareExecutions.id,
          caseId: aftercareExecutions.caseId,
          branchId: aftercareExecutions.branchId,
        })
        .from(aftercareExecutions)
        .where(eq(aftercareExecutions.id, executionId))
        .limit(1);
      if (!execution)
        throw fulfillmentError("دفعة المعالجة غير موجودة", "NOT_FOUND");
      assertFulfillmentBranch(actor, execution.branchId);
      await loadAftercareCaseTx(tx, execution.caseId, actor);
      return { executionId: execution.id, caseId: execution.caseId };
    },
    { gate: "NONE" },
  );
}

/** Uses historical bundle rows exclusively; returns movement choices with source identity. */
export type AftercarePreviewInput = AftercareSourceInput & {
  sourceKind?: "INVOICE" | "WORK_ORDER";
  sourceReference?: string;
};

async function resolveAftercareReferenceTx(
  tx: Tx,
  input: AftercarePreviewInput,
  actor: Actor,
): Promise<AftercareSourceInput> {
  if (input.sourceReference == null) return input;
  if (input.invoiceId != null || input.workOrderId != null || !input.sourceKind)
    throw fulfillmentError(
      "اختر نوع الأصل ورقمه أو باركوده، أو افتحه من رابط المستند الأصلي",
    );
  const reference = input.sourceReference.trim();
  if (!reference || reference.length > 255)
    throw fulfillmentError(
      "أدخل رقم الفاتورة أو أمر الشغل المطبوع أو امسح باركوده",
    );
  const lookup = prepareDeliveryBarcodeLookup(reference);
  if (![input.sourceKind, "NUMERIC", "REFERENCE"].includes(lookup.namespace))
    throw fulfillmentError(
      "نوع الباركود لا يطابق نوع الأصل المختار؛ اختر فاتورة أو أمر شغل مطابقاً",
      "NOT_FOUND",
    );
  const references = Array.from(
    new Set(
      [reference, lookup.code, lookup.documentCode, lookup.systemCode].filter(
        Boolean,
      ),
    ),
  );
  const scope = canCrossBranches(actor) ? undefined : actor.branchId;
  if (scope !== undefined) assertFulfillmentBranch(actor, scope);
  const missing = () =>
    fulfillmentError(
      "لم يُعثر على أصل مطابق في نطاق فرعك؛ تحقق من الرقم المطبوع ونوع المستند أو افتح المعالجة من تفاصيله",
      "NOT_FOUND",
    );
  if (input.sourceKind === "INVOICE") {
    const matches = await tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(
          inArray(invoices.invoiceNumber, references),
          scope !== undefined ? eq(invoices.branchId, scope) : undefined,
        ),
      )
      .limit(2)
      .for("share");
    if (matches.length > 1)
      throw fulfillmentError(
        "المرجع يطابق أكثر من فاتورة تاريخية؛ افتح الفاتورة المطلوبة من تفاصيلها",
        "CONFLICT",
      );
    if (matches[0]) return { invoiceId: matches[0].id };
  } else {
    const matches = await tx
      .select({ id: workOrders.id })
      .from(workOrders)
      .where(
        and(
          inArray(workOrders.orderNumber, references),
          scope !== undefined ? eq(workOrders.branchId, scope) : undefined,
        ),
      )
      .limit(2)
      .for("share");
    if (matches.length > 1)
      throw fulfillmentError(
        "المرجع يطابق أكثر من أمر شغل تاريخي؛ افتح الأمر المطلوب من تفاصيله",
        "CONFLICT",
      );
    if (matches[0]) return { workOrderId: matches[0].id };
  }
  throw missing();
}

export async function previewAftercareSource(
  input: AftercarePreviewInput,
  actor: Actor,
) {
  return withTx(async (tx) => {
    const actualSource = await resolveAftercareReferenceTx(tx, input, actor);
    const source = await lockAftercareSourceTx(tx, actualSource, actor);
    assertEligibleAftercareSource(source);
    const variantIds = Array.from(
      new Set([
        ...source.items.map((item) => item.variantId),
        ...source.components.map((part) => part.componentVariantId),
      ]),
    );
    const variants = variantIds.length
      ? await tx
          .select({
            id: productVariants.id,
            name: products.name,
            variantName: productVariants.variantName,
            sku: productVariants.sku,
          })
          .from(productVariants)
          .innerJoin(products, eq(products.id, productVariants.productId))
          .where(inArray(productVariants.id, variantIds))
      : [];
    const movements = await tx
      .select({
        id: inventoryMovements.id,
        variantId: inventoryMovements.variantId,
        quantity: inventoryMovements.quantity,
        createdAt: inventoryMovements.createdAt,
      })
      .from(inventoryMovements)
      .where(
        and(
          or(
            and(
              eq(inventoryMovements.referenceType, "INVOICE"),
              eq(inventoryMovements.referenceId, source.invoice.id),
            ),
            source.invoice.sourceType === "WORKORDER" &&
              source.items.some((item) => item.workOrderId != null)
              ? and(
                  eq(inventoryMovements.referenceType, "WORK_ORDER"),
                  inArray(
                    inventoryMovements.referenceId,
                    source.items.flatMap((item) =>
                      item.workOrderId ? [item.workOrderId] : [],
                    ),
                  ),
                )
              : undefined,
          ),
          eq(inventoryMovements.branchId, source.invoice.branchId),
          eq(inventoryMovements.movementType, "OUT"),
        ),
      );
    const allocated = await tx
      .select({
        itemId: aftercareLines.originalInvoiceItemId,
        variantId: aftercareLines.componentVariantId,
        quantity: sql<number>`SUM(${aftercareLines.baseQuantity})`,
      })
      .from(aftercareLines)
      .innerJoin(aftercareCases, eq(aftercareCases.id, aftercareLines.caseId))
      .where(
        and(
          sql`${aftercareLines.originalInvoiceItemId} IN (${sql.join(
            source.items.map((item) => sql`${item.id}`),
            sql`,`,
          )})`,
          sql`${aftercareCases.status} <> 'CANCELLED'`,
        ),
      )
      .groupBy(
        aftercareLines.originalInvoiceItemId,
        aftercareLines.componentVariantId,
      );
    const choices = source.items.flatMap((item) => {
      const parts = source.components.filter(
        (part) => part.invoiceItemId === item.id,
      );
      return (
        parts.length
          ? parts.map((part) => ({
              variantId: part.componentVariantId,
              originalBundleComponentId: part.id,
              originalQuantity: part.componentBaseQuantity * item.baseQuantity,
              remainingQuantity:
                part.componentBaseQuantity *
                (item.baseQuantity - item.returnedBaseQuantity),
            }))
          : [
              {
                variantId: item.variantId,
                originalBundleComponentId: undefined,
                originalQuantity: item.baseQuantity,
                remainingQuantity:
                  item.baseQuantity - item.returnedBaseQuantity,
              },
            ]
      ).map((choice) => ({
        ...choice,
        originalInvoiceItemId: item.id,
        label: variants.find((variant) => variant.id === choice.variantId),
        availableForAftercare: Math.max(
          0,
          choice.remainingQuantity -
            Number(
              allocated.find(
                (row) =>
                  row.itemId === item.id && row.variantId === choice.variantId,
              )?.quantity ?? 0,
            ),
        ),
        movements: movements.filter(
          (movement) => movement.variantId === choice.variantId,
        ),
      }));
    });
    return {
      invoiceId: source.invoice.id,
      workOrderId: actualSource.workOrderId ?? null,
      invoiceNumber: source.invoice.invoiceNumber,
      sourceNumber:
        source.orderSource?.orderNumber ?? source.invoice.invoiceNumber,
      branchId: source.invoice.branchId,
      customerId: source.invoice.customerId,
      choices,
    };
  });
}

export async function aftercareAvailableProducts(
  input: { branchId: number; search?: string },
  actor: Actor,
) {
  assertFulfillmentBranch(actor, input.branchId);
  return withTx(
    async (tx) => {
      const costVisible = await fulfillmentCostVisibleTx(tx, actor);
      const search = input.search?.trim();
      const rows = await tx
        .select({
          id: productVariants.id,
          name: products.name,
          variantName: productVariants.variantName,
          sku: productVariants.sku,
          quantity: branchStock.quantity,
          unitCost: productVariants.costPrice,
        })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .innerJoin(
          branchStock,
          and(
            eq(branchStock.variantId, productVariants.id),
            eq(branchStock.branchId, input.branchId),
          ),
        )
        .where(
          and(
            eq(productVariants.isActive, true),
            eq(products.isService, false),
            eq(products.isBundle, false),
            eq(products.isConsignment, false),
            sql`${branchStock.quantity} > 0`,
            search
              ? or(
                  like(products.name, `%${search}%`),
                  like(productVariants.sku, `%${search}%`),
                  like(productVariants.variantName, `%${search}%`),
                )
              : undefined,
          ),
        )
        .orderBy(products.name, productVariants.id)
        .limit(100);
      const availability = await loadVariantAvailability(
        tx,
        input.branchId,
        rows.map((row) => row.id),
      );
      return rows
        .map((row) => ({
          ...row,
          unitCost: costVisible ? row.unitCost : null,
          quantity: availability.get(row.id)?.availableBase ?? 0,
        }))
        .filter((row) => row.quantity > 0);
    },
    { gate: "NONE" },
  );
}
