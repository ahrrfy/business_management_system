import Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import { aftercareSettlements } from "../../../drizzle/fulfillmentSchema";
import {
  componentRightsAdjustments,
  componentRightsRefunds,
} from "../../../drizzle/fulfillmentRightsSchema";
import {
  accountingEntries,
  inventoryMovements,
  invoiceItems,
  invoices,
  productVariants,
  products,
  receipts,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { allocateLineCost } from "../billing";
import { money, round2, toDbMoney } from "../money";
import {
  returnSaleInTx,
  type ComponentRightsReturn,
  type ComponentRightsRefundLeg,
} from "../returnService";
import { loadRefundCaps } from "../returns/refundCaps";
import { withTx, type Actor } from "../tx";
import { aftercarePermissionTx, lockedCase } from "./aftercare";
import {
  assertFulfillmentBranch,
  fulfillmentError,
  fulfillmentFingerprint,
} from "./core";
import { fulfillmentCostVisibleTx } from "./visibility";
import { rightsAbsorbedAmount } from "./componentRightsPolicy";
import {
  adjustCustomerBalance,
  computeInvoiceStatus,
  postEntry,
} from "../ledgerService";
import {
  creditLine,
  createPostingIntent,
  debitLine,
} from "../accounting/postingEngine";
import { assertPeriodOpen } from "../periodLockService";
import { todayUtcDate } from "../businessDay";
import { checkIdempotency, recordIdempotencyKey } from "../idempotency";
import { loadOperationUserTx } from "../authorization/operationAuthority";
import { paymentAssetRole } from "../sale/paymentPosting";
import { reserveExternalRefundConfirmationTx } from "../externalRefundConfirmation";
import { validateAftercareSourceRightsTx } from "./componentRightsValuation";
export { validateAftercareSourceRightsTx };

type RightsRefundView = {
  receiptId: number;
  method: string;
  amount: string;
  status: string;
  approvalStatus: string;
  voucherNumber: string | null;
  pendingExternal: boolean;
};

async function rightsRefundsTx(
  tx: Tx,
  adjustmentId: number,
): Promise<RightsRefundView[]> {
  const rows = await tx
    .select({
      receiptId: receipts.id,
      method: receipts.paymentMethod,
      amount: receipts.amount,
      status: receipts.status,
      approvalStatus: receipts.approvalStatus,
      voucherNumber: receipts.voucherNumber,
      internalNote: receipts.internalNote,
    })
    .from(componentRightsRefunds)
    .innerJoin(receipts, eq(receipts.id, componentRightsRefunds.receiptId))
    .where(eq(componentRightsRefunds.adjustmentId, adjustmentId));
  return rows.map((row) => ({
    ...row,
    pendingExternal:
      row.status === "PENDING" &&
      row.internalNote?.startsWith("COMPONENT_REFUND_PENDING:") === true,
  }));
}

export type PostComponentRightsInput = {
  settlementId: number;
  rightIndex: number;
  clientRequestId: string;
  refund?: ComponentRightsRefundLeg;
  refunds?: ComponentRightsRefundLeg[];
};

async function settlementPreviewTx(tx: Tx, id: number, actor: Actor) {
  const [row] = await tx
    .select()
    .from(aftercareSettlements)
    .where(eq(aftercareSettlements.id, id))
    .limit(1);
  if (!row)
    throw fulfillmentError("مستند تسوية المعالجة غير موجود", "NOT_FOUND");
  assertFulfillmentBranch(actor, row.branchId);
  return row;
}

export async function getComponentRightsSettlement(
  input: { settlementId: number },
  actor: Actor,
) {
  return withTx(
    async (tx) => {
      await aftercarePermissionTx(tx, actor, "rightsPreview");
      const row = await settlementPreviewTx(tx, input.settlementId, actor);
      const visible = await fulfillmentCostVisibleTx(tx, actor);
      const adjustments = await tx
        .select()
        .from(componentRightsAdjustments)
        .where(eq(componentRightsAdjustments.settlementId, row.id));
      const refunds: Array<{
        rightIndex: number;
        id: number;
        refundReceiptId: number | null;
        refundVoucherNumber: string | null;
        completed: boolean;
        refunds: RightsRefundView[];
      }> = [];
      for (const adjustment of adjustments) {
        const [receipt] = adjustment.refundReceiptId
          ? await tx
              .select({
                status: receipts.status,
                approvalStatus: receipts.approvalStatus,
                voucherNumber: receipts.voucherNumber,
              })
              .from(receipts)
              .where(eq(receipts.id, adjustment.refundReceiptId))
              .limit(1)
          : [];
        const legs = await rightsRefundsTx(tx, adjustment.id);
        refunds.push({
          rightIndex: adjustment.rightIndex,
          id: adjustment.id,
          refundReceiptId: adjustment.refundReceiptId,
          refundVoucherNumber: receipt?.voucherNumber ?? null,
          completed:
            legs.every(
              (leg) =>
                leg.status === "COMPLETED" && leg.approvalStatus === "APPROVED",
            ) &&
            legs
              .reduce((sum, leg) => sum.plus(leg.amount), money(0))
              .eq(adjustment.refundRequiredAmount),
          refunds: legs,
        });
      }
      const [firstItem] = row.sourceRights[0]
        ? await tx
            .select({ invoiceId: invoiceItems.invoiceId })
            .from(invoiceItems)
            .where(eq(invoiceItems.id, row.sourceRights[0].invoiceItemId))
            .limit(1)
        : [];
      const [invoice] = firstItem
        ? await tx
            .select()
            .from(invoices)
            .where(eq(invoices.id, firstItem.invoiceId))
            .limit(1)
        : [];
      const caps = invoice ? await loadRefundCaps(tx, invoice.id) : null;
      const pendingReservations = invoice
        ? await tx
            .select({ method: receipts.paymentMethod, amount: receipts.amount })
            .from(componentRightsRefunds)
            .innerJoin(
              componentRightsAdjustments,
              eq(
                componentRightsAdjustments.id,
                componentRightsRefunds.adjustmentId,
              ),
            )
            .innerJoin(
              receipts,
              eq(receipts.id, componentRightsRefunds.receiptId),
            )
            .where(
              and(
                eq(componentRightsAdjustments.invoiceId, invoice.id),
                eq(receipts.status, "PENDING"),
              ),
            )
        : [];
      const originalRefundMethods = caps
        ? Array.from(caps.netByMethod.entries())
            .map(([method, cap]) => ({
              method,
              cap: Decimal.max(
                0,
                cap.minus(
                  pendingReservations
                    .filter((row) => row.method === method)
                    .reduce((sum, row) => sum.plus(row.amount), money(0)),
                ),
              ),
            }))
            .filter(({ cap }) => cap.gt(0))
            .map(({ method, cap }) => ({ method, amount: toDbMoney(cap) }))
        : [];
      const unpaid = invoice
        ? Decimal.max(
            0,
            money(invoice.total)
              .minus(invoice.returnedTotal ?? "0")
              .minus(invoice.paidAmount),
          )
        : money(0);
      return {
        settlementId: row.id,
        invoiceId: firstItem?.invoiceId ?? null,
        status: row.status,
        originalRefundMethods,
        rights: row.sourceRights.map((right, rightIndex) => {
          const adjustment =
            refunds.find(
              (adjustment) => adjustment.rightIndex === rightIndex,
            ) ?? null;
          return {
            ...right,
            rightIndex,
            requiredRefundAmount: toDbMoney(
              Decimal.max(0, money(right.commercialAmount).minus(unpaid)),
            ),
            executed: adjustment != null,
            pendingRefundReceiptId:
              adjustment && !adjustment.completed
                ? (adjustment.refunds.find((leg) => leg.status !== "COMPLETED")
                    ?.receiptId ?? adjustment.refundReceiptId)
                : null,
            refundVoucherNumber: adjustment?.refundVoucherNumber ?? null,
            refunds: adjustment?.refunds ?? [],
            originalIssueValue: visible ? right.originalIssueValue : null,
            costEvidence: visible ? right.costEvidence : null,
            costEvidenceReference: visible ? right.costEvidenceReference : null,
            adjustment,
          };
        }),
      };
    },
    { gate: "NONE" },
  );
}

/** Source rights re-use the real return receipt, drawer, period, provider and AR policies. */
export async function postComponentRights(
  input: PostComponentRightsInput,
  actor: Actor,
) {
  return withTx(async (tx) => {
    await aftercarePermissionTx(tx, actor, "rightsPost");
    if (
      !input.clientRequestId?.trim() ||
      input.clientRequestId.length > 80 ||
      !Number.isSafeInteger(input.rightIndex) ||
      input.rightIndex < 0
    )
      throw fulfillmentError("مفتاح التنفيذ أو سطر الحق غير صالح");
    const preview = await settlementPreviewTx(tx, input.settlementId, actor);
    const right = preview.sourceRights[input.rightIndex];
    if (!right)
      throw fulfillmentError("سطر الحق غير موجود في الاعتماد", "NOT_FOUND");
    const sourceHash = fulfillmentFingerprint(input);
    if (input.refund && input.refunds)
      throw fulfillmentError(
        "وصلت خطة الرد مرتين؛ استخدم توزيعاً واحداً على الروافع الأصلية",
      );
    const refundLegs = input.refunds ?? (input.refund ? [input.refund] : []);
    if (
      refundLegs.length > 5 ||
      new Set(refundLegs.map((leg) => leg.method)).size !== refundLegs.length ||
      refundLegs.some(
        (leg) =>
          !money(leg.amount).gt(0) ||
          (leg.reference?.trim().length ?? 0) > 100 ||
          (leg.pendingExternal && leg.method !== "CARD"),
      )
    )
      throw fulfillmentError(
        "توزيع الرد غير صالح؛ حصة موجبة واحدة لكل رافد أصلي ومرجع تنفيذ لا يتجاوز 100 محرف والتأكيد الخارجي المعلق للبطاقة فقط",
      );
    const primaryRefund = refundLegs[0];
    const [replay] = await tx
      .select()
      .from(componentRightsAdjustments)
      .where(
        eq(componentRightsAdjustments.clientRequestId, input.clientRequestId),
      )
      .limit(1);
    if (replay) {
      if (
        replay.sourceHash !== sourceHash ||
        replay.settlementId !== preview.id
      )
        throw fulfillmentError(
          "مفتاح التنفيذ استُعمل لحمولة مختلفة",
          "CONFLICT",
        );
      return {
        id: replay.id,
        invoiceId: replay.invoiceId,
        returnedTotal: replay.commercialAmount,
        replay: true,
      };
    }
    const [itemPreview] = await tx
      .select()
      .from(invoiceItems)
      .where(eq(invoiceItems.id, right.invoiceItemId))
      .limit(1);
    if (!itemPreview)
      throw fulfillmentError("بند البيع الأصلي غير موجود", "NOT_FOUND");
    const [invoicePreview] = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.id, itemPreview.invoiceId))
      .limit(1);
    if (!invoicePreview)
      throw fulfillmentError("فاتورة البيع الأصلية غير موجودة", "NOT_FOUND");
    const restoredValue =
      right.usableBaseQuantity === 0
        ? money(0)
        : round2(
            money(right.originalIssueValue)
              .times(right.usableBaseQuantity)
              .div(right.baseQuantity),
          );
    const adapter: ComponentRightsReturn = {
      ...right,
      restoredValue: toDbMoney(restoredValue),
      wholeItem: right.originalBundleComponentId == null,
    };
    let approvedInvoice = invoicePreview;
    let normalReturnedBaseQuantity = itemPreview.returnedBaseQuantity ?? 0;
    let priorRestoredValue = money(0);
    const result = await returnSaleInTx(
      tx,
      {
        invoiceId: itemPreview.invoiceId,
        lines: [
          {
            invoiceItemId: right.invoiceItemId,
            baseQuantity:
              right.originalBundleComponentId == null ? right.baseQuantity : 1,
          },
        ],
        refund: invoicePreview.customerId == null ? undefined : primaryRefund,
        resolution:
          invoicePreview.customerId == null
            ? {
                kind: "IMMEDIATE_REFUND",
                method: primaryRefund?.method ?? "CASH",
                amount: primaryRefund?.amount ?? "0",
                shiftId: primaryRefund?.shiftId,
                reference: primaryRefund?.reference,
                reason: preview.reason,
                disposition: "RESTOCK",
              }
            : undefined,
        restock: true,
        operatorReason: `تسوية حق مصدرية ${preview.id}/${input.rightIndex} — ${preview.reason}`,
        clientRequestId: input.clientRequestId,
      },
      actor,
      {
        componentRights: adapter,
        componentRefunds: refundLegs,
        validateComponentRightsTx: async () => {
          const state = await lockedCase(tx, preview.caseId, actor);
          if (!["APPROVED", "IN_PROGRESS"].includes(state.row.status))
            throw fulfillmentError(
              "الحالة مقفلة أو ملغاة؛ اعرض إيصالات الحق الأصلي ولا تبدأ ترحيلاً جديداً",
              "CONFLICT",
            );
          const [settlement] = await tx
            .select()
            .from(aftercareSettlements)
            .where(eq(aftercareSettlements.id, preview.id))
            .for("update")
            .limit(1);
          if (
            !settlement ||
            settlement.status !== "POSTED" ||
            settlement.approvedBy == null ||
            settlement.approvedBy === settlement.createdBy ||
            !settlement.approvedAt ||
            fulfillmentFingerprint(
              settlement.sourceRights[input.rightIndex],
            ) !== fulfillmentFingerprint(right)
          )
            throw fulfillmentError(
              "يلزم اعتماد مستقل وترحيل فحص الأصل؛ تغير الحق المعتمد أو لم يكتمل إثباته",
              "CONFLICT",
            );
          approvedInvoice = state.source.invoice;
          if (
            approvedInvoice.id !== itemPreview.invoiceId ||
            !state.lines.some(
              (line) =>
                line.disposition === "MISSING_HELD" &&
                line.originalInvoiceItemId === right.invoiceItemId &&
                (line.originalBundleComponentId ?? null) ===
                  right.originalBundleComponentId &&
                line.originalMovementId === right.originalMovementId &&
                line.baseQuantity - line.deliveredBaseQuantity ===
                  right.baseQuantity,
            )
          )
            throw fulfillmentError(
              "الحق لا يطابق المبيع المتبقي بعهدتنا",
              "CONFLICT",
            );
          const [duplicate] = await tx
            .select({ id: componentRightsAdjustments.id })
            .from(componentRightsAdjustments)
            .where(
              and(
                eq(componentRightsAdjustments.settlementId, settlement.id),
                eq(componentRightsAdjustments.rightIndex, input.rightIndex),
              ),
            )
            .for("share")
            .limit(1);
          if (duplicate)
            throw fulfillmentError(
              "سُوّي هذا الحق مسبقاً؛ حدّث المستند لعرض الإيصال الأصلي",
              "CONFLICT",
            );
          const executed = await tx
            .select({ rightIndex: componentRightsAdjustments.rightIndex })
            .from(componentRightsAdjustments)
            .where(eq(componentRightsAdjustments.settlementId, settlement.id))
            .for("share");
          await validateAftercareSourceRightsTx(
            tx,
            {
              source: state.source,
              rights: settlement.sourceRights.filter(
                (_, index) => !executed.some((row) => row.rightIndex === index),
              ),
              excludingSettlementId: settlement.id,
            },
            actor,
          );
          const item = state.source.items.find(
            (item) => item.id === right.invoiceItemId,
          );
          const component =
            right.originalBundleComponentId == null
              ? null
              : state.source.components.find(
                  (component) =>
                    component.id === right.originalBundleComponentId,
                );
          if (
            !item ||
            item.isGift ||
            (component &&
              (component.invoiceItemId !== item.id ||
                component.componentVariantId !== right.componentVariantId)) ||
            (right.originalBundleComponentId != null && !component) ||
            (!component && item.variantId !== right.componentVariantId)
          )
            throw fulfillmentError(
              "هوية المكوّن لا تطابق لقطة البيع",
              "CONFLICT",
            );
          normalReturnedBaseQuantity = item.returnedBaseQuantity ?? 0;
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
              "تسوية المكوّن تخص المبيع المخزني المملوك؛ الصنف له التزام مورد أو خدمة يلزم مسار مرتجعه الأصلي",
              "CONFLICT",
            );
          const [movement] = await tx
            .select()
            .from(inventoryMovements)
            .where(eq(inventoryMovements.id, right.originalMovementId))
            .for("share")
            .limit(1);
          if (
            !movement ||
            movement.variantId !== right.componentVariantId ||
            movement.branchId !== approvedInvoice.branchId ||
            movement.movementType !== "OUT" ||
            movement.quantity < right.baseQuantity ||
            !(
              (movement.referenceType === "INVOICE" &&
                movement.referenceId === approvedInvoice.id) ||
              (movement.referenceType === "WORK_ORDER" &&
                movement.referenceId === item.workOrderId)
            )
          )
            throw fulfillmentError(
              "حركة الصرف لا تثبت هوية وكمية هذا الحق",
              "CONFLICT",
            );
          const prior = await tx
            .select()
            .from(componentRightsAdjustments)
            .where(eq(componentRightsAdjustments.invoiceItemId, item.id))
            .for("share");
          if (!prior.length && (item.returnedRestockedBaseQuantity ?? 0) > 0)
            priorRestoredValue = allocateLineCost(
              item.lineCost,
              item.baseQuantity,
              0,
              item.returnedRestockedBaseQuantity ?? 0,
            );
          const priorComponent = component
            ? prior.filter(
                (row) =>
                  row.originalBundleComponentId ===
                  right.originalBundleComponentId,
              )
            : [];
          const availableQuantity =
            (component ? component.componentBaseQuantity : 1) *
              (item.baseQuantity - (item.returnedBaseQuantity ?? 0)) -
            priorComponent.reduce((sum, row) => sum + row.baseQuantity, 0);
          if (
            !Number.isSafeInteger(right.baseQuantity) ||
            right.baseQuantity <= 0 ||
            right.baseQuantity > availableQuantity ||
            !Number.isSafeInteger(right.usableBaseQuantity) ||
            right.usableBaseQuantity < 0 ||
            !Number.isSafeInteger(right.damagedBaseQuantity) ||
            right.damagedBaseQuantity < 0 ||
            right.usableBaseQuantity + right.damagedBaseQuantity !==
              right.baseQuantity
          )
            throw fulfillmentError(
              "الكمية تتجاوز المكوّن الأصلي المتبقي",
              "CONFLICT",
            );
          const originalRemainingCost = allocateLineCost(
            item.lineCost,
            item.baseQuantity,
            item.returnedBaseQuantity ?? 0,
            item.baseQuantity - (item.returnedBaseQuantity ?? 0),
          );
          const componentPrior = prior.filter(
            (row) => row.originalBundleComponentId != null,
          );
          const unabsorbed = (
            row: (typeof prior)[number],
            field: "originalIssueValue" | "commercialAmount",
          ) =>
            money(row[field]).minus(
              rightsAbsorbedAmount(
                row[field],
                item.baseQuantity,
                row.normalReturnedBaseQuantity,
                row.normalReturnedBaseQuantity,
                (item.returnedBaseQuantity ?? 0) -
                  row.normalReturnedBaseQuantity,
              ),
            );
          const costCap = originalRemainingCost.minus(
            componentPrior.reduce(
              (sum, row) => sum.plus(unabsorbed(row, "originalIssueValue")),
              money(0),
            ),
          );
          if (
            money(right.originalIssueValue).lt(0) ||
            money(right.originalIssueValue).gt(costCap)
          )
            throw fulfillmentError(
              "قيمة الأصل تتجاوز COGS الأصلية المتبقية؛ راجع مستند الصرف والتسويات السابقة",
              "CONFLICT",
            );
          if (component?.issueLineCost != null) {
            const exact = round2(
              money(component.issueLineCost)
                .times(right.baseQuantity)
                .div(component.componentBaseQuantity * item.baseQuantity),
            );
            if (!exact.eq(money(right.originalIssueValue)))
              throw fulfillmentError(
                "قيمة الأصل المعتمدة لا تطابق لقطة تكلفة صرف المكوّن الأصلية",
                "CONFLICT",
              );
          } else if (!component) {
            const exact = allocateLineCost(
              item.lineCost,
              item.baseQuantity,
              item.returnedBaseQuantity ?? 0,
              right.baseQuantity,
            );
            if (!exact.eq(money(right.originalIssueValue)))
              throw fulfillmentError(
                "قيمة الصنف لا تطابق تكلفة البيع الأصلية",
                "CONFLICT",
              );
          } else if (
            right.costEvidence.trim().length < 3 ||
            right.costEvidenceReference.trim().length < 3
          )
            throw fulfillmentError(
              "بانتظار دليل التكلفة: أرفق مرجع مستند تاريخي حقيقي يثبت تكلفة المكوّن عند الصرف ثم أعد المراجعة المستقلة",
            );
          const netRatio = money(approvedInvoice.subtotal).gt(0)
            ? money(approvedInvoice.subtotal)
                .minus(approvedInvoice.discountAmount)
                .div(approvedInvoice.subtotal)
            : money(0);
          const taxRate = money(approvedInvoice.subtotal)
            .minus(approvedInvoice.discountAmount)
            .gt(0)
            ? money(approvedInvoice.taxAmount).div(
                money(approvedInvoice.subtotal).minus(
                  approvedInvoice.discountAmount,
                ),
              )
            : money(0);
          const lineCap = money(item.total)
            .times(netRatio)
            .times(new Decimal(1).plus(taxRate))
            .times(item.baseQuantity - (item.returnedBaseQuantity ?? 0))
            .div(item.baseQuantity)
            .minus(
              componentPrior.reduce(
                (sum, row) => sum.plus(unabsorbed(row, "commercialAmount")),
                money(0),
              ),
            );
          const amount = money(right.commercialAmount);
          const wholeInvoice =
            !component &&
            state.source.items.every((sourceItem) =>
              sourceItem.id === item.id
                ? (sourceItem.returnedBaseQuantity ?? 0) +
                    right.baseQuantity ===
                  sourceItem.baseQuantity
                : (sourceItem.returnedBaseQuantity ?? 0) ===
                  sourceItem.baseQuantity,
            );
          if (
            !amount.gt(0) ||
            (!wholeInvoice && amount.gt(round2(lineCap))) ||
            amount.gt(
              money(approvedInvoice.total).minus(
                approvedInvoice.returnedTotal ?? "0",
              ),
            )
          )
            throw fulfillmentError(
              "المبلغ التجاري المعتمد يتجاوز قيمة البيع الأصلية المتبقية",
              "CONFLICT",
            );
          if (!component) {
            const nativeAmount = wholeInvoice
              ? money(approvedInvoice.total).minus(
                  approvedInvoice.returnedTotal ?? "0",
                )
              : round2(
                  money(item.total)
                    .times(netRatio)
                    .times(new Decimal(1).plus(taxRate))
                    .times(right.baseQuantity)
                    .div(item.baseQuantity),
                );
            if (!amount.eq(nativeAmount))
              throw fulfillmentError(
                `حق الصنف الكامل يمر بالمرتجع الأصلي؛ قيمته الحالية ${toDbMoney(nativeAmount)} ويجب اعتمادها دون تسعير مكوّن جديد`,
                "CONFLICT",
              );
          }
          const unpaid = Decimal.max(
            0,
            money(approvedInvoice.total)
              .minus(approvedInvoice.returnedTotal ?? "0")
              .minus(approvedInvoice.paidAmount),
          );
          const refundDue = Decimal.max(0, amount.minus(unpaid));
          if (
            !refundLegs
              .reduce((sum, leg) => sum.plus(leg.amount), money(0))
              .eq(refundDue)
          )
            throw fulfillmentError(
              `يلزم رد فعلي أو سند رد معلق بمبلغ ${toDbMoney(refundDue)}؛ وزعه على روافع القبض الأصلية دون إسقاط حق العميل`,
            );
          const caps = await loadRefundCaps(tx, approvedInvoice.id, {
            lock: true,
          });
          const reserved = await tx
            .select({ method: receipts.paymentMethod, amount: receipts.amount })
            .from(componentRightsRefunds)
            .innerJoin(
              componentRightsAdjustments,
              eq(
                componentRightsAdjustments.id,
                componentRightsRefunds.adjustmentId,
              ),
            )
            .innerJoin(
              receipts,
              eq(receipts.id, componentRightsRefunds.receiptId),
            )
            .where(
              and(
                eq(componentRightsAdjustments.invoiceId, approvedInvoice.id),
                eq(receipts.status, "PENDING"),
              ),
            )
            .for("share");
          const reservedTotal = reserved.reduce(
            (sum, row) => sum.plus(row.amount),
            money(0),
          );
          if (refundDue.gt(caps.pool.minus(reservedTotal)))
            throw fulfillmentError(
              "المقبوض الأصلي محجوز لرد معلق؛ أكمل تأكيد السندات الأصلية أولاً",
              "CONFLICT",
            );
          for (const method of Array.from(
            new Set(refundLegs.map((leg) => leg.method)),
          )) {
            const requested = refundLegs
              .filter((leg) => leg.method === method)
              .reduce((sum, leg) => sum.plus(leg.amount), money(0));
            const pending = reserved
              .filter((row) => row.method === method)
              .reduce((sum, row) => sum.plus(row.amount), money(0));
            if (
              requested.gt(
                (caps.netByMethod.get(method) ?? money(0)).minus(pending),
              )
            )
              throw fulfillmentError(
                "لا يكفي المقبوض الأصلي المتبقي على رافد الرد؛ راجع توزيع القبض والسندات المعلقة",
                "CONFLICT",
              );
          }
        },
      },
    );
    const taxRate = money(approvedInvoice.subtotal)
      .minus(approvedInvoice.discountAmount)
      .gt(0)
      ? money(approvedInvoice.taxAmount).div(
          money(approvedInvoice.subtotal).minus(approvedInvoice.discountAmount),
        )
      : money(0);
    const revenue = round2(
      money(right.commercialAmount).div(new Decimal(1).plus(taxRate)),
    );
    const id = extractInsertId(
      await tx.insert(componentRightsAdjustments).values({
        settlementId: preview.id,
        rightIndex: input.rightIndex,
        invoiceId: approvedInvoice.id,
        invoiceItemId: right.invoiceItemId,
        originalBundleComponentId: right.originalBundleComponentId,
        originalMovementId: right.originalMovementId,
        baseQuantity: right.baseQuantity,
        normalReturnedBaseQuantity,
        usableBaseQuantity: right.usableBaseQuantity,
        commercialAmount: right.commercialAmount,
        revenueAmount: toDbMoney(revenue),
        taxAmount: toDbMoney(money(right.commercialAmount).minus(revenue)),
        originalIssueValue: right.originalIssueValue,
        restoredValue: toDbMoney(restoredValue),
        priorRestoredValue: toDbMoney(priorRestoredValue),
        costEvidence: right.costEvidence,
        costEvidenceReference: right.costEvidenceReference,
        refundReceiptId:
          "refundReceiptId" in result ? result.refundReceiptId : null,
        refundRequiredAmount: toDbMoney(
          refundLegs.reduce((sum, leg) => sum.plus(leg.amount), money(0)),
        ),
        clientRequestId: input.clientRequestId,
        sourceHash,
        createdBy: actor.userId,
      }),
    );
    for (const receiptId of "refundReceiptIds" in result
      ? (result.refundReceiptIds ?? [])
      : "refundReceiptId" in result && result.refundReceiptId
        ? [result.refundReceiptId]
        : []) {
      const [receipt] = await tx
        .select()
        .from(receipts)
        .where(eq(receipts.id, receiptId))
        .limit(1);
      if (!receipt)
        throw fulfillmentError("إيصال توزيع الرد غير موجود", "CONFLICT");
      if (
        receipt.status === "COMPLETED" &&
        receipt.paymentMethod !== "CASH" &&
        receipt.referenceNumber
      )
        await reserveExternalRefundConfirmationTx(tx, {
          receiptId: receipt.id,
          method: receipt.paymentMethod,
          reference: receipt.referenceNumber,
        });
      await tx.insert(componentRightsRefunds).values({
        adjustmentId: id,
        receiptId,
        providerReference:
          receipt.paymentMethod === "CARD" && receipt.status === "COMPLETED"
            ? `CARD:${receipt.referenceNumber}`
            : null,
      });
    }
    return { ...result, id, replay: false };
  });
}

/** A pending bank/provider refund keeps closure open even after the commercial credit posted. */
export async function assertComponentRightsClosedTx(
  tx: Tx,
  settlementId: number,
) {
  const [settlement] = await tx
    .select()
    .from(aftercareSettlements)
    .where(eq(aftercareSettlements.id, settlementId))
    .limit(1);
  if (!settlement || settlement.status !== "POSTED")
    throw fulfillmentError("أكمل تسوية المعالجة المعتمدة أولاً");
  const adjustments = await tx
    .select()
    .from(componentRightsAdjustments)
    .where(eq(componentRightsAdjustments.settlementId, settlementId));
  for (let index = 0; index < settlement.sourceRights.length; index++) {
    const row = adjustments.find((row) => row.rightIndex === index);
    if (!row)
      throw fulfillmentError(
        "حق العميل الأصلي لم يُسوّ بعد؛ نفّذ تسوية حق المكوّن والرد المرتبط به",
      );
    const refundBindings = await tx
      .select()
      .from(componentRightsRefunds)
      .where(eq(componentRightsRefunds.adjustmentId, row.id));
    let refundTotal = money(0);
    for (const binding of refundBindings) {
      const [receipt] = await tx
        .select()
        .from(receipts)
        .where(eq(receipts.id, binding.receiptId))
        .limit(1);
      if (
        !receipt ||
        receipt.invoiceId !== row.invoiceId ||
        receipt.direction !== "OUT" ||
        receipt.status !== "COMPLETED" ||
        receipt.approvalStatus !== "APPROVED"
      )
        throw fulfillmentError(
          "رد مال العميل لم يُنفّذ فعلياً؛ أكمل سند الرد الأصلي ثم أغلق الحالة",
        );
      refundTotal = refundTotal.plus(receipt.amount);
      const [entry] = await tx
        .select({ id: accountingEntries.id })
        .from(accountingEntries)
        .where(
          and(
            eq(accountingEntries.receiptId, receipt.id),
            eq(accountingEntries.entryType, "PAYMENT_OUT"),
          ),
        )
        .limit(1);
      if (!entry)
        throw fulfillmentError(
          "سند الرد لا يحمل أثر الدفع الفعلي؛ راجع تنفيذ السند قبل الإغلاق",
        );
    }
    if (!refundTotal.eq(row.refundRequiredAmount))
      throw fulfillmentError(
        "توزيع الرد لا يغطي الحق النقدي المعتمد؛ راجع كل إيصالات الروافع الأصلية",
        "CONFLICT",
      );
  }
}

/** Confirm the SAME original pending receipt after actual external execution; never issue a second credit or stock return. */
export async function confirmComponentRightsRefund(
  input: { receiptId: number; reference: string; clientRequestId: string },
  actor: Actor,
) {
  return withTx(async (tx) => {
    await aftercarePermissionTx(tx, actor, "rightsConfirmRefund");
    const reference = input.reference.trim();
    if (
      reference.length < 3 ||
      reference.length > 100 ||
      !input.clientRequestId?.trim() ||
      input.clientRequestId.length > 80
    )
      throw fulfillmentError(
        "أدخل مرجع تنفيذ خارجي حقيقي من 3 إلى 100 محرف ومفتاح تنفيذ صالح",
      );
    const [preview] = await tx
      .select({
        bindingId: componentRightsRefunds.id,
        adjustmentId: componentRightsAdjustments.id,
        invoiceId: componentRightsAdjustments.invoiceId,
        settlementId: componentRightsAdjustments.settlementId,
      })
      .from(componentRightsRefunds)
      .innerJoin(
        componentRightsAdjustments,
        eq(componentRightsAdjustments.id, componentRightsRefunds.adjustmentId),
      )
      .where(eq(componentRightsRefunds.receiptId, input.receiptId))
      .limit(1);
    if (!preview)
      throw fulfillmentError("إيصال الرد لا يرتبط بحق مصدر أصلي", "NOT_FOUND");
    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.id, preview.invoiceId))
      .for("update")
      .limit(1);
    if (!invoice)
      throw fulfillmentError("فاتورة المصدر غير موجودة", "NOT_FOUND");
    assertFulfillmentBranch(actor, invoice.branchId);
    const [receipt] = await tx
      .select()
      .from(receipts)
      .where(eq(receipts.id, input.receiptId))
      .for("update")
      .limit(1);
    if (
      !receipt ||
      receipt.invoiceId !== invoice.id ||
      receipt.direction !== "OUT" ||
      !["CARD", "CHECK", "TRANSFER", "WALLET"].includes(receipt.paymentMethod)
    )
      throw fulfillmentError(
        "إيصال الرد لا يطابق الفاتورة والرافد غير النقدي",
        "CONFLICT",
      );
    const authority = await loadOperationUserTx(tx, actor.userId);
    if (receipt.paymentMethod !== "CARD" && !authority.isOwner)
      throw fulfillmentError(
        "تأكيد صرف التحويل أو المحفظة أو الصك محصور بالمالك النشط",
        "FORBIDDEN",
      );
    const fingerprint = fulfillmentFingerprint(input);
    const replay = await checkIdempotency(
      tx,
      "componentRights.refundConfirm",
      input.clientRequestId,
      fingerprint,
    );
    if (replay != null) {
      if (
        replay !== receipt.id ||
        receipt.status !== "COMPLETED" ||
        receipt.referenceNumber !== reference
      )
        throw fulfillmentError("تعارض مفتاح تأكيد الرد", "CONFLICT");
      return { receiptId: receipt.id, replay: true };
    }
    if (receipt.status === "COMPLETED") {
      if (receipt.referenceNumber !== reference)
        throw fulfillmentError(
          "السند مؤكد بمرجع خارجي مختلف؛ لا يمكن تبديل الإثبات",
          "CONFLICT",
        );
      await recordIdempotencyKey(
        tx,
        "componentRights.refundConfirm",
        input.clientRequestId,
        receipt.id,
        fingerprint,
      );
      return { receiptId: receipt.id, replay: true };
    }
    if (
      receipt.status !== "PENDING" ||
      receipt.approvalStatus !== "PENDING_APPROVAL" ||
      !receipt.internalNote?.startsWith("COMPONENT_REFUND_PENDING:")
    )
      throw fulfillmentError(
        "السند ليس رد حق مصدر معلقاً قابلاً لتأكيد التنفيذ",
        "CONFLICT",
      );
    const [settlement] = await tx
      .select()
      .from(aftercareSettlements)
      .where(eq(aftercareSettlements.id, preview.settlementId))
      .for("share")
      .limit(1);
    if (
      !settlement ||
      settlement.status !== "POSTED" ||
      settlement.approvedBy == null ||
      settlement.approvedBy === settlement.createdBy
    )
      throw fulfillmentError("اعتماد تسوية المصدر غير صالح", "CONFLICT");
    await assertPeriodOpen(tx, new Date(`${todayUtcDate()}T00:00:00.000Z`));
    const caps = await loadRefundCaps(tx, invoice.id, { lock: true });
    const amount = money(receipt.amount);
    if (
      amount.gt(caps.pool) ||
      amount.gt(
        caps.netByMethod.get(
          receipt.paymentMethod as ComponentRightsRefundLeg["method"],
        ) ?? money(0),
      ) ||
      amount.gt(money(invoice.paidAmount))
    )
      throw fulfillmentError(
        "رصيد الرافد الأصلي لا يغطي الرد المعتمد؛ راجع السندات قبل تأكيد أي تنفيذ جديد",
        "CONFLICT",
      );
    await reserveExternalRefundConfirmationTx(tx, {
      receiptId: receipt.id,
      method: receipt.paymentMethod,
      reference,
    });
    await tx
      .update(componentRightsRefunds)
      .set({ providerReference: `${receipt.paymentMethod}:${reference}` })
      .where(eq(componentRightsRefunds.id, preview.bindingId));
    await tx
      .update(receipts)
      .set({
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        referenceNumber: reference,
        approvedBy: actor.userId,
        approvedAt: new Date(),
        executedBy: actor.userId,
        executedAt: new Date(),
        internalNote: `COMPONENT_REFUND_CONFIRMED:${invoice.id}`,
      })
      .where(eq(receipts.id, receipt.id));
    const assetRole = paymentAssetRole(receipt.paymentMethod, null, "OUT");
    const postingSource = {
      roleDebits: { AR: amount },
      roleCredits: { [assetRole]: amount },
    };
    await postEntry(tx, {
      entryType: "PAYMENT_OUT",
      branchId: invoice.branchId,
      invoiceId: invoice.id,
      receiptId: receipt.id,
      customerId: invoice.customerId,
      amount,
      createdBy: actor.userId,
      dedupeKey: `COMPONENT_REFUND:${receipt.id}`,
      postingIntent: createPostingIntent(
        "PAYMENT_OUT_CUSTOMER_REFUND",
        "PAYMENT_OUT",
        [debitLine("AR", amount), creditLine(assetRole, amount)],
        postingSource,
      ),
      postingSourceComponents: postingSource,
      notes: `تأكيد رد المصدر على ${receipt.paymentMethod} — ${reference}`,
    });
    const paid = money(invoice.paidAmount).minus(amount);
    await tx
      .update(invoices)
      .set({
        paidAmount: toDbMoney(paid),
        status:
          invoice.status === "RETURNED"
            ? "RETURNED"
            : computeInvoiceStatus(
                invoice.total,
                toDbMoney(paid),
                invoice.returnedTotal ?? "0",
              ),
      })
      .where(eq(invoices.id, invoice.id));
    if (invoice.customerId != null)
      await adjustCustomerBalance(tx, invoice.customerId, amount);
    await recordIdempotencyKey(
      tx,
      "componentRights.refundConfirm",
      input.clientRequestId,
      receipt.id,
      fingerprint,
    );
    return { receiptId: receipt.id, replay: false };
  });
}
