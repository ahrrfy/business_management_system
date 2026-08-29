import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import {
  accrualObligationEvents,
  accrualObligations,
  fixedAssets,
  suppliers,
} from "../../../drizzle/schema";
import { createSystemPaymentRequestTx } from "../voucher/create";
import {
  lockAccrualObligationTx,
  transitionAccrualObligationTx,
} from "../accounting/accrualObligations";
import { money, toDateStr, toDbMoney } from "../money";
import { withTx, type Actor } from "../tx";

export async function requestSupplierAssetSettlement(
  input: { assetId: number; clientRequestId: string },
  actor: Actor,
) {
  const clientRequestId = input.clientRequestId.trim();
  if (!clientRequestId || clientRequestId.length > 64) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "مفتاح منع تكرار طلب سداد الأصل إلزامي" });
  }
  return withTx(async (tx) => {
    const [asset] = await tx
      .select({
        id: fixedAssets.id,
        code: fixedAssets.code,
        branchId: fixedAssets.branchId,
        supplierId: fixedAssets.supplierId,
        purchaseValue: fixedAssets.purchaseValue,
        recognitionStatus: fixedAssets.recognitionStatus,
      })
      .from(fixedAssets)
      .where(eq(fixedAssets.id, input.assetId))
      .for("update")
      .limit(1);
    if (!asset || asset.supplierId == null || asset.branchId == null) {
      throw new TRPCError({ code: "NOT_FOUND", message: "أصل المورد أو فرعه المالي غير موجود" });
    }
    if (asset.recognitionStatus !== "ACTIVE") {
      throw new TRPCError({ code: "CONFLICT", message: "اقتناء الأصل قيد التصحيح أو مصحح" });
    }
    if (actor.isOwner !== true && actor.role !== "admin" && Number(actor.branchId) !== Number(asset.branchId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "الأصل تابع لفرع آخر" });
    }
    const [obligationPreview] = await tx
      .select({ id: accrualObligations.id })
      .from(accrualObligations)
      .where(
        and(
          eq(accrualObligations.assetId, input.assetId),
          eq(accrualObligations.kind, "ASSET_ACQUISITION_SUPPLIER"),
        ),
      )
      .orderBy(desc(accrualObligations.id))
      .limit(1);
    if (!obligationPreview) {
      throw new TRPCError({ code: "CONFLICT", message: "التزام اقتناء الأصل على المورد مفقود" });
    }
    const obligation = await lockAccrualObligationTx(tx, Number(obligationPreview.id));
    if (obligation.status === "PAID") {
      return { obligationId: Number(obligation.id), receiptId: null, replayed: true as const, status: "PAID" as const };
    }
    if (obligation.status !== "PAYABLE_UNSETTLED" && obligation.status !== "PAYMENT_PENDING") {
      throw new TRPCError({ code: "CONFLICT", message: `حالة ذمة الأصل ${obligation.status} لا تسمح بطلب سداد` });
    }
    if (
      Number(obligation.beneficiarySupplierId) !== Number(asset.supplierId) ||
      !money(obligation.recognizedAmount).eq(money(asset.purchaseValue))
    ) {
      throw new TRPCError({ code: "CONFLICT", message: "ذمة الأصل لا تطابق المورد/قيمة الاقتناء" });
    }
    const [supplier] = await tx
      .select({ id: suppliers.id, name: suppliers.name, isActive: suppliers.isActive })
      .from(suppliers)
      .where(eq(suppliers.id, Number(asset.supplierId)))
      .for("update")
      .limit(1);
    if (!supplier || supplier.isActive === false) {
      throw new TRPCError({ code: "CONFLICT", message: "مورد الأصل غير نشط" });
    }
    const receipt = await createSystemPaymentRequestTx(tx, {
      branchId: Number(asset.branchId),
      amount: toDbMoney(obligation.recognizedAmount),
      paymentMethod: "CASH",
      partyType: "SUPPLIER",
      partyId: Number(supplier.id),
      counterpartyName: supplier.name,
      description: `سداد ذمة اقتناء الأصل ${asset.code}`,
      referenceNumber: `ASSET-SUP-SETTLE-${asset.id}-${obligation.id}`,
      voucherDate: toDateStr(),
      clientRequestId,
    }, actor, {
      kind: "ASSET_SUPPLIER_SETTLEMENT",
      assetId: Number(asset.id),
      supplierId: Number(supplier.id),
      expectedAmount: toDbMoney(obligation.recognizedAmount),
      obligationId: Number(obligation.id),
      obligationSourceHash: obligation.sourceHash,
      beneficiaryType: "SUPPLIER",
      beneficiaryId: Number(supplier.id),
      beneficiaryNameSnapshot: supplier.name,
      sourceEvidenceReference: obligation.evidenceReference,
    });
    if (obligation.status === "PAYMENT_PENDING") {
      const [linked] = await tx
        .select({ receiptId: accrualObligationEvents.receiptId })
        .from(accrualObligationEvents)
        .where(
          and(
            eq(accrualObligationEvents.obligationId, Number(obligation.id)),
            eq(accrualObligationEvents.eventType, "PAYMENT_REQUESTED"),
          ),
        )
        .orderBy(desc(accrualObligationEvents.id))
        .limit(1);
      if (Number(linked?.receiptId) !== receipt.receiptId) {
        throw new TRPCError({ code: "CONFLICT", message: "إعادة الطلب لا تطابق سند السداد المعلق" });
      }
      return { obligationId: Number(obligation.id), receiptId: receipt.receiptId, replayed: true as const, status: "PAYMENT_PENDING" as const };
    }
    await transitionAccrualObligationTx(tx, {
      obligationId: Number(obligation.id),
      expectedStatus: "PAYABLE_UNSETTLED",
      nextStatus: "PAYMENT_PENDING",
      eventType: "PAYMENT_REQUESTED",
      actorId: actor.userId,
      receiptId: receipt.receiptId,
      evidenceReference: obligation.evidenceReference,
      dedupeKey: `ACCRUAL:PAYMENT_REQUESTED:${obligation.id}:${receipt.receiptId}`,
    });
    return { obligationId: Number(obligation.id), receiptId: receipt.receiptId, replayed: false as const, status: "PAYMENT_PENDING" as const };
  });
}
