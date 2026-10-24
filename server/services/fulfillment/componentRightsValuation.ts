import Decimal from "decimal.js";
import { and, eq, inArray, ne, or } from "drizzle-orm";
import {
  aftercareCases,
  aftercareSettlements,
} from "../../../drizzle/fulfillmentSchema";
import { componentRightsAdjustments } from "../../../drizzle/fulfillmentRightsSchema";
import {
  inventoryMovements,
  productVariants,
  products,
} from "../../../drizzle/schema";
import type { AftercareSettlementSourceRight } from "../../../shared/fulfillment";
import type { Tx } from "../../db";
import { allocateLineCost } from "../billing";
import { money, round2 } from "../money";
import { assertPeriodOpen } from "../periodLockService";
import type { Actor } from "../tx";
import type { SourceSnapshot } from "./aftercareSources";
import { assertFulfillmentBranch, fulfillmentError } from "./core";
import { rightsAbsorbedAmount } from "./componentRightsPolicy";

/** Validate and reserve commercial/cost attribution BEFORE independently posting physical settlement. Caller holds source mutex. */
export async function validateAftercareSourceRightsTx(
  tx: Tx,
  input: {
    source: SourceSnapshot;
    rights: AftercareSettlementSourceRight[];
    excludingSettlementId?: number;
  },
  actor: Actor,
): Promise<void> {
  const { source, rights } = input;
  assertFulfillmentBranch(actor, source.invoice.branchId);
  if (!rights.length) return;
  await assertPeriodOpen(tx, source.invoice.invoiceDate);
  if (source.invoice.sourceType === "WORKORDER")
    throw fulfillmentError(
      "أصل أمر الشغل يعكس مواد WIP بمسار عكس التسليم؛ لا تعتمد تسوية مخزون مكوّن قبل تحديد مستند صرف مخزني أصلي مستقل ومراجعته مع المسؤول",
      "CONFLICT",
    );
  const posted = await tx
    .select()
    .from(componentRightsAdjustments)
    .where(eq(componentRightsAdjustments.invoiceId, source.invoice.id))
    .for("share");
  const reservations = await tx
    .select({
      id: aftercareSettlements.id,
      sourceRights: aftercareSettlements.sourceRights,
    })
    .from(aftercareSettlements)
    .innerJoin(
      aftercareCases,
      eq(aftercareCases.id, aftercareSettlements.caseId),
    )
    .where(
      and(
        inArray(aftercareSettlements.status, [
          "REQUESTED",
          "APPROVED",
          "POSTED",
        ]),
        or(
          eq(aftercareCases.invoiceId, source.invoice.id),
          source.orderSource
            ? eq(aftercareCases.workOrderId, source.orderSource.id)
            : undefined,
        ),
        input.excludingSettlementId
          ? ne(aftercareSettlements.id, input.excludingSettlementId)
          : undefined,
      ),
    )
    .for("share");
  const proposedByItem = new Map<
    number,
    {
      commercial: Decimal;
      cost: Decimal;
      componentQuantities: Map<number | null, number>;
    }
  >();
  const netRatio = money(source.invoice.subtotal).gt(0)
    ? money(source.invoice.subtotal)
        .minus(source.invoice.discountAmount)
        .div(source.invoice.subtotal)
    : money(0);
  const taxable = money(source.invoice.subtotal).minus(
    source.invoice.discountAmount,
  );
  const taxRate = taxable.gt(0)
    ? money(source.invoice.taxAmount).div(taxable)
    : money(0);
  for (const right of rights) {
    if (right.costEvidenceReference.trim().length > 500)
      throw fulfillmentError("مرجع مستند التكلفة يجب ألا يتجاوز 500 محرف");
    const item = source.items.find((item) => item.id === right.invoiceItemId);
    const component =
      right.originalBundleComponentId == null
        ? null
        : source.components.find(
            (component) =>
              component.id === right.originalBundleComponentId &&
              component.invoiceItemId === right.invoiceItemId,
          );
    if (
      !item ||
      item.isGift ||
      (right.originalBundleComponentId != null && !component) ||
      (component?.componentVariantId ?? item.variantId) !==
        right.componentVariantId
    )
      throw fulfillmentError(
        "هوية الحق التجاري لا تطابق المبيع الأصلي",
        "CONFLICT",
      );
    const returnedQuantity = item.returnedBaseQuantity ?? 0;
    const restockedQuantity = item.returnedRestockedBaseQuantity ?? 0;
    if (
      !Number.isSafeInteger(item.baseQuantity) ||
      item.baseQuantity <= 0 ||
      !Number.isSafeInteger(returnedQuantity) ||
      returnedQuantity < 0 ||
      returnedQuantity > item.baseQuantity ||
      !Number.isSafeInteger(restockedQuantity) ||
      restockedQuantity < 0 ||
      restockedQuantity > returnedQuantity
    )
      throw fulfillmentError(
        "عدادات كمية الأصل أو المرتجع لا تطابق مصدر البيع؛ راجع أصل البند قبل تسوية الحق",
        "CONFLICT",
      );
    if (
      !Number.isSafeInteger(right.baseQuantity) ||
      right.baseQuantity <= 0 ||
      !Number.isSafeInteger(right.usableBaseQuantity) ||
      right.usableBaseQuantity < 0 ||
      !Number.isSafeInteger(right.damagedBaseQuantity) ||
      right.damagedBaseQuantity < 0 ||
      right.usableBaseQuantity + right.damagedBaseQuantity !==
        right.baseQuantity
    )
      throw fulfillmentError(
        "كميات الحق الأصلي يجب أن تكون صحيحة وموجبة وتتطابق مع الفحص الفعلي",
        "CONFLICT",
      );
    const [product] = await tx
      .select({
        isConsignment: products.isConsignment,
        isService: products.isService,
        productType: products.productType,
      })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(eq(productVariants.id, right.componentVariantId))
      .limit(1);
    if (
      !product ||
      product.isConsignment ||
      product.isService ||
      product.productType === "DIGITAL_CARD"
    )
      throw fulfillmentError(
        "حق المكوّن يخص المبيع المخزني المملوك؛ راجع مسار الأصل للخدمة أو الأمانة قبل اعتماد التسوية",
        "CONFLICT",
      );
    const [movement] = await tx
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.id, right.originalMovementId))
      .limit(1);
    if (
      !movement ||
      movement.movementType !== "OUT" ||
      movement.variantId !== right.componentVariantId ||
      movement.branchId !== source.invoice.branchId ||
      movement.quantity < right.baseQuantity ||
      !(
        (movement.referenceType === "INVOICE" &&
          movement.referenceId === source.invoice.id) ||
        (movement.referenceType === "WORK_ORDER" &&
          movement.referenceId === item.workOrderId)
      )
    )
      throw fulfillmentError(
        "يلزم مستند صرف أصلي يثبت هوية المكوّن وكميته قبل اعتماد تسويته",
        "CONFLICT",
      );
    const prior = posted.filter((row) => row.invoiceItemId === item.id);
    if (
      prior.some(
        (row) =>
          !Number.isSafeInteger(row.normalReturnedBaseQuantity) ||
          row.normalReturnedBaseQuantity < 0 ||
          row.normalReturnedBaseQuantity >= item.baseQuantity ||
          row.normalReturnedBaseQuantity > returnedQuantity,
      )
    )
      throw fulfillmentError(
        "لقطة التسوية السابقة لا تطابق كمية الأصل الحالية؛ راجع الإسناد الأصلي قبل أي خصم أو رد جديد",
        "CONFLICT",
      );
    const reservedRights = reservations
      .flatMap((reservation) =>
        reservation.sourceRights.map((right, rightIndex) => ({
          right,
          executed: posted.some(
            (row) =>
              row.settlementId === reservation.id &&
              row.rightIndex === rightIndex,
          ),
        })),
      )
      .filter((row) => row.right.invoiceItemId === item.id && !row.executed)
      .map((row) => row.right);
    const own = proposedByItem.get(item.id) ?? {
      commercial: money(0),
      cost: money(0),
      componentQuantities: new Map<number | null, number>(),
    };
    own.commercial = own.commercial.plus(right.commercialAmount);
    own.cost = own.cost.plus(right.originalIssueValue);
    own.componentQuantities.set(
      right.originalBundleComponentId,
      (own.componentQuantities.get(right.originalBundleComponentId) ?? 0) +
        right.baseQuantity,
    );
    proposedByItem.set(item.id, own);
    if (
      !money(right.commercialAmount).gt(0) ||
      money(right.originalIssueValue).lt(0)
    )
      throw fulfillmentError(
        "أدخل قيمة تجارية مستقلة موجبة وتكلفة أصل غير سالبة",
      );
    const availableQuantity =
      (component?.componentBaseQuantity ?? 1) *
      (item.baseQuantity - (item.returnedBaseQuantity ?? 0));
    const existingQuantity = component
      ? prior
          .filter((row) => row.originalBundleComponentId === component.id)
          .reduce((sum, row) => sum + row.baseQuantity, 0)
      : 0;
    const reservedQuantity = reservedRights
      .filter(
        (row) =>
          row.originalBundleComponentId === right.originalBundleComponentId,
      )
      .reduce((sum, row) => sum + row.baseQuantity, 0);
    if (
      existingQuantity +
        reservedQuantity +
        own.componentQuantities.get(right.originalBundleComponentId)! >
      availableQuantity
    )
      throw fulfillmentError(
        "كمية المكوّن محجوزة لتسوية أخرى أو تتجاوز المصدر المتبقي",
        "CONFLICT",
      );
    const originalCostRemaining = allocateLineCost(
      item.lineCost,
      item.baseQuantity,
      item.returnedBaseQuantity ?? 0,
      item.baseQuantity - (item.returnedBaseQuantity ?? 0),
    );
    const unabsorbed = (
      row: (typeof posted)[number],
      field: "commercialAmount" | "originalIssueValue",
    ) =>
      money(row[field]).minus(
        rightsAbsorbedAmount(
          row[field],
          item.baseQuantity,
          row.normalReturnedBaseQuantity,
          row.normalReturnedBaseQuantity,
          (item.returnedBaseQuantity ?? 0) - row.normalReturnedBaseQuantity,
        ),
      );
    const priorComponents = prior.filter(
      (row) => row.originalBundleComponentId != null,
    );
    const originalNetRemaining = money(item.total)
      .times(netRatio)
      .times(new Decimal(1).plus(taxRate))
      .times(item.baseQuantity - (item.returnedBaseQuantity ?? 0))
      .div(item.baseQuantity);
    const wholeInvoicePlainReturn =
      !component &&
      rights.length === 1 &&
      source.items.every((sourceItem) =>
        sourceItem.id === item.id
          ? (sourceItem.returnedBaseQuantity ?? 0) + right.baseQuantity ===
            sourceItem.baseQuantity
          : (sourceItem.returnedBaseQuantity ?? 0) === sourceItem.baseQuantity,
      );
    const commercialCap = (
      wholeInvoicePlainReturn
        ? money(source.invoice.total).minus(source.invoice.returnedTotal ?? "0")
        : originalNetRemaining
    ).minus(
      priorComponents.reduce(
        (sum, row) => sum.plus(unabsorbed(row, "commercialAmount")),
        money(0),
      ),
    );
    if (
      own.commercial
        .plus(
          reservedRights.reduce(
            (sum, row) => sum.plus(row.commercialAmount),
            money(0),
          ),
        )
        .gt(round2(commercialCap)) ||
      own.cost
        .plus(
          reservedRights.reduce(
            (sum, row) => sum.plus(row.originalIssueValue),
            money(0),
          ),
        )
        .plus(
          priorComponents.reduce(
            (sum, row) => sum.plus(unabsorbed(row, "originalIssueValue")),
            money(0),
          ),
        )
        .gt(originalCostRemaining)
    )
      throw fulfillmentError(
        "القيمة التجارية أو تكلفة الأصل محجوزة أو تتجاوز البيع الأصلي؛ صحّح المبالغ قبل طلب الاعتماد",
        "CONFLICT",
      );
    if (!component) {
      const exactCost = allocateLineCost(
        item.lineCost,
        item.baseQuantity,
        item.returnedBaseQuantity ?? 0,
        right.baseQuantity,
      );
      const exactValue = wholeInvoicePlainReturn
        ? commercialCap
        : round2(
            money(item.total)
              .times(netRatio)
              .times(new Decimal(1).plus(taxRate))
              .times(right.baseQuantity)
              .div(item.baseQuantity),
          );
      if (
        !money(right.originalIssueValue).eq(exactCost) ||
        !money(right.commercialAmount).eq(exactValue)
      )
        throw fulfillmentError(
          "قيمة الصنف الكامل وتكلفته يجب أن تطابقا المرتجع الأصلي؛ صحّح المبالغ قبل الاعتماد",
          "CONFLICT",
        );
    } else if (component.issueLineCost != null) {
      const exact = round2(
        money(component.issueLineCost)
          .times(right.baseQuantity)
          .div(component.componentBaseQuantity * item.baseQuantity),
      );
      if (!money(right.originalIssueValue).eq(exact))
        throw fulfillmentError(
          "التكلفة لا تطابق لقطة صرف المكوّن الأصلية؛ صحّح المبلغ قبل الاعتماد",
          "CONFLICT",
        );
    } else if (
      right.costEvidence.trim().length < 3 ||
      right.costEvidenceReference.trim().length < 3
    )
      throw fulfillmentError(
        "بانتظار مستند تاريخي حقيقي يثبت تكلفة المكوّن عند الصرف؛ أرفق مرجعه ثم اطلب المراجعة المستقلة",
      );
  }
}
