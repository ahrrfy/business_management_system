// اعتماد/رفض سند مُعلَّق (Maker-Checker، SOD-04: مالك نشط والمُعتمِد ≠ المُنشئ بلا استثناء).
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import {
  assetMaintenance,
  expenses,
  fixedAssets,
  purchaseOrders,
  receipts,
  suppliers,
  users,
} from "../../../drizzle/schema";
import { activateAdvanceForApprovedVoucherTx } from "../advancesService";
import { adjustCustomerBalance, adjustSupplierBalance, postEntry } from "../ledgerService";
import { money, toDateStr, toDbMoney } from "../money";
import { openShiftIdTx, shiftIdForCashTx } from "../shiftService";
import {
  assertApprovedTreasuryOutAvailable,
  assertCashOutAvailable,
  assertNonPhysicalOutReceipt,
  authorizeExternalTreasuryDisbursement,
  lockCashSourceForUpdate,
  type CashAccountRef,
  type ExternalTreasuryDisbursementApproval,
} from "../cash/cashAvailability";
import { type Actor, withTx } from "../tx";
import { computeSignature } from "./helpers";
import type { PartyType, PaymentMethod } from "./types";
import { isSystemPaymentReference, parseSystemPaymentRequest } from "./create";

export interface ApproveVoucherResult {
  receiptId: number;
  voucherNumber: string;
  approvalStatus: "APPROVED";
  signatureHash: string;
  replayed: boolean;
}

/** اعتماد سند مُعلَّق (Maker-Checker): يُسجّل الأثر المالي ويُختم بـsignatureHash.
 *
 * عقد المالك: المُعتمِد حساب users نشط وisOwner=true، ومختلف عن المُنشئ بلا استثناء دور.
 * إعادة اعتماد سند APPROVED idempotent: تعيد البصمة بلا أي كتابة أو أثر مالي ثانٍ.
 */
export async function approveVoucher(receiptId: number, actor: Actor): Promise<ApproveVoucherResult> {
  return withTx(async (tx) => {
    const [preview] = await tx.select().from(receipts).where(eq(receipts.id, receiptId)).limit(1);
    if (!preview || preview.voucherNumber == null) {
      throw new TRPCError({ code: "NOT_FOUND", message: "السند غير موجود" });
    }
    const [approverPreview] = await tx.select().from(users).where(eq(users.id, actor.userId)).limit(1);
    if (!approverPreview?.isActive || !approverPreview.isOwner) {
      throw new TRPCError({ code: "FORBIDDEN", message: "اعتماد السندات محصور بحساب مالك نشط" });
    }
    const previewApproverActor: Actor = {
      userId: actor.userId,
      branchId: Number(approverPreview.branchId ?? actor.branchId),
      role: approverPreview.role,
      isOwner: true,
    };
    const cashOutPreview = preview.direction === "OUT" && preview.paymentMethod === "CASH";
    const cashInPreview = preview.direction === "IN" && preview.paymentMethod === "CASH";
    const systemRequestPreview = parseSystemPaymentRequest(preview.internalNote);
    if (isSystemPaymentReference(preview.referenceNumber) && !systemRequestPreview) {
      throw new TRPCError({ code: "CONFLICT", message: "مرجع نظامي بلا payload موثوق — أوقف الاعتماد وراجع التدقيق" });
    }
    let cancellationOriginalPreview: typeof preview | null = null;
    if (systemRequestPreview?.kind === "VOUCHER_CANCELLATION") {
      [cancellationOriginalPreview] = await tx
        .select()
        .from(receipts)
        .where(eq(receipts.id, systemRequestPreview.originalReceiptId))
        .limit(1);
      if (!cancellationOriginalPreview) {
        throw new TRPCError({ code: "CONFLICT", message: "سند القبض الأصلي لطلب الإلغاء مفقود" });
      }
    }
    let preResolvedCashIn: { shiftId: number | null; cashBucket: "DRAWER" | "TREASURY" } | null = null;
    let externalTreasuryApproval: ExternalTreasuryDisbursementApproval | null = null;
    if (cashOutPreview) {
      const cancellationBucket = cancellationOriginalPreview?.cashBucket as "DRAWER" | "TREASURY" | null | undefined;
      if (cancellationOriginalPreview && cancellationBucket == null) {
        throw new TRPCError({ code: "CONFLICT", message: "طلب إلغاء قبض نقدي بلا مصدر نقد أصلي" });
      }
      const source: CashAccountRef = cancellationOriginalPreview
        ? {
            branchId: Number(cancellationOriginalPreview.branchId),
            cashBucket: cancellationBucket as "DRAWER" | "TREASURY",
            shiftId: cancellationOriginalPreview.shiftId != null ? Number(cancellationOriginalPreview.shiftId) : null,
          }
        : { branchId: Number(preview.branchId), cashBucket: "TREASURY" as const, shiftId: null };
      if (source.cashBucket === "TREASURY") {
        externalTreasuryApproval = await authorizeExternalTreasuryDisbursement(tx, {
          actor,
          makerUserIds: [preview.createdBy, cancellationOriginalPreview?.createdBy],
          branchIds: [source.branchId],
          operation: cancellationOriginalPreview ? "اعتماد إلغاء سند قبض نقدي" : "اعتماد سند الصرف النقدي",
        });
      } else {
        await lockCashSourceForUpdate(tx, source);
      }
    } else if (cashInPreview) {
      preResolvedCashIn = await shiftIdForCashTx(
        tx, previewApproverActor, Number(preview.branchId), "اعتماد سند قبض نقدي",
      );
      await lockCashSourceForUpdate(tx, {
        branchId: Number(preview.branchId),
        cashBucket: preResolvedCashIn.cashBucket,
        shiftId: preResolvedCashIn.shiftId,
      });
    }
    // قفل مشاركة يكفي لتثبيت isActive/isOwner حتى نهاية المعاملة، ويبقى متوافقاً
    // مع FK createdBy في كتّاب النقد الآخرين. الترتيب الحاكم للنقد: source → user SHARE → receipt.
    const [approver] = await tx.select().from(users).where(eq(users.id, actor.userId)).for("share").limit(1);
    if (!approver?.isActive || !approver.isOwner) {
      throw new TRPCError({ code: "FORBIDDEN", message: "اعتماد السندات محصور بحساب مالك نشط" });
    }
    if (
      approver.role !== approverPreview.role ||
      Number(approver.branchId ?? actor.branchId) !== Number(approverPreview.branchId ?? actor.branchId)
    ) {
      throw new TRPCError({ code: "CONFLICT", message: "تغيّرت صلاحيات المالك أثناء الاعتماد — أعد المحاولة" });
    }
    const r = (
      await tx.select().from(receipts).where(eq(receipts.id, receiptId)).for("update").limit(1)
    )[0];
    if (!r || r.voucherNumber == null) {
      throw new TRPCError({ code: "NOT_FOUND", message: "السند غير موجود" });
    }
    if (
      (cashOutPreview || cashInPreview) &&
      (r.direction !== preview.direction || r.paymentMethod !== "CASH" || Number(r.branchId) !== Number(preview.branchId))
    ) {
      throw new TRPCError({ code: "CONFLICT", message: "تغيّر مصدر السند النقدي أثناء الاعتماد — أعد المحاولة" });
    }
    if (r.createdBy != null && Number(r.createdBy) === actor.userId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يجوز اعتماد سند أنشأته بنفسك — يلزم مالك آخر" });
    }
    const systemRequest = parseSystemPaymentRequest(r.internalNote);
    if (JSON.stringify(systemRequest) !== JSON.stringify(systemRequestPreview)) {
      throw new TRPCError({ code: "CONFLICT", message: "تغيّر ارتباط الطلب النظامي أثناء الاعتماد — أعد المحاولة" });
    }
    if (r.approvalStatus === "APPROVED") {
      if (!r.signatureHash) throw new TRPCError({ code: "CONFLICT", message: "السند معتمد بلا بصمة سلامة — راجع التدقيق" });
      return {
        receiptId,
        voucherNumber: String(r.voucherNumber),
        approvalStatus: "APPROVED" as const,
        signatureHash: String(r.signatureHash),
        replayed: true,
      };
    }
    if (r.approvalStatus === "REJECTED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "السند مرفوض — لا يمكن اعتماده" });
    }
    if (r.status === "REVERSED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "السند ملغى — لا يمكن اعتماده" });
    }
    if (r.approvalStatus !== "PENDING_APPROVAL" || r.status !== "PENDING") {
      throw new TRPCError({ code: "CONFLICT", message: "السند ليس طلباً معلّقاً صالحاً للاعتماد" });
    }
    let cancellationOriginal: typeof r | null = null;
    if (systemRequest?.kind === "VOUCHER_CANCELLATION") {
      cancellationOriginal = (
        await tx
          .select()
          .from(receipts)
          .where(eq(receipts.id, systemRequest.originalReceiptId))
          .for("update")
          .limit(1)
      )[0] ?? null;
      if (
        !cancellationOriginal ||
        cancellationOriginal.direction !== "IN" ||
        cancellationOriginal.paymentMethod !== "CASH" ||
        cancellationOriginal.approvalStatus !== "APPROVED" ||
        cancellationOriginal.status !== "COMPLETED" ||
        cancellationOriginal.voucherNumber == null ||
        cancellationOriginal.cashBucket == null ||
        Number(cancellationOriginal.branchId) !== Number(r.branchId) ||
        money(cancellationOriginal.amount).toFixed(2) !== money(r.amount).toFixed(2) ||
        (cancellationOriginal.partyType ?? null) !== (r.partyType ?? null) ||
        Number(cancellationOriginal.partyId ?? 0) !== Number(r.partyId ?? 0) ||
        Number(cancellationOriginal.createdBy ?? 0) !== Number(systemRequest.originalCreatorId ?? 0)
      ) {
        throw new TRPCError({ code: "CONFLICT", message: "سند القبض الأصلي تغيّر أو لم يعد صالحاً للإلغاء" });
      }
      if (cancellationOriginal.createdBy != null && Number(cancellationOriginal.createdBy) === actor.userId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا يجوز لمن أنشأ القبض اعتماد إلغائه — يلزم مالك آخر" });
      }
    }
    const amount = money(r.amount);
    const direction = r.direction as "IN" | "OUT";
    const branchId = Number(r.branchId);
    const partyType = r.partyType as PartyType | null;
    const partyId = r.partyId != null ? Number(r.partyId) : null;
    const paymentMethod = r.paymentMethod as PaymentMethod;

    if (systemRequest?.kind === "VOUCHER_CANCELLATION") {
      if (r.referenceNumber !== `CANCEL-VCH-${systemRequest.originalReceiptId}`) {
        throw new TRPCError({ code: "CONFLICT", message: "مرجع طلب إلغاء القبض غير متطابق" });
      }
    } else if (
      systemRequest?.kind === "ASSET_ACQUISITION" ||
      systemRequest?.kind === "ASSET_REACQUISITION" ||
      systemRequest?.kind === "ASSET_MAINTENANCE"
    ) {
      const assetId = systemRequest.assetId;
      const [asset] = await tx
        .select()
        .from(fixedAssets)
        .where(eq(fixedAssets.id, assetId))
        .for("update")
        .limit(1);
      if (
        !asset ||
        Number(asset.branchId) !== branchId ||
        asset.status === "disposed" ||
        asset.status === "retired" ||
        (systemRequest.kind !== "ASSET_MAINTENANCE" && asset.supplierId != null)
      ) {
        throw new TRPCError({ code: "CONFLICT", message: "الأصل المرتبط بطلب الدفع تغيّر أو لم يعد نقدياً" });
      }
      if (systemRequest.kind === "ASSET_ACQUISITION") {
        if (r.referenceNumber !== `ASSET-ACQ-${assetId}` || !money(asset.purchaseValue).eq(amount)) {
          throw new TRPCError({ code: "CONFLICT", message: "طلب اقتناء الأصل لا يطابق الأصل الحالي" });
        }
      } else if (systemRequest.kind === "ASSET_REACQUISITION") {
        if (
          !Number.isInteger(systemRequest.sequence) || systemRequest.sequence <= 0 ||
          r.referenceNumber !== `ASSET-REACQ-${assetId}-${systemRequest.sequence}` ||
          !money(asset.purchaseValue).eq(amount)
        ) {
          throw new TRPCError({ code: "CONFLICT", message: "طلب إعادة اقتناء الأصل لا يطابق الأصل الحالي" });
        }
      } else {
        const [maintenance] = await tx
          .select()
          .from(assetMaintenance)
          .where(eq(assetMaintenance.id, systemRequest.maintenanceId))
          .for("update")
          .limit(1);
        if (
          !maintenance ||
          Number(maintenance.assetId) !== assetId ||
          r.referenceNumber !== `ASSET-MAINT-${systemRequest.maintenanceId}` ||
          !money(maintenance.cost).eq(amount)
        ) {
          throw new TRPCError({ code: "CONFLICT", message: "طلب دفع الصيانة لا يطابق سجل الصيانة" });
        }
      }
    }

    // سند الصرف العادي يُموَّل من الخزينة دائماً. طلب إلغاء قبضٍ مادي هو الاستثناء
    // التعويضي المحصور: يعكس دلو/وردية القبض الأصلية كي يتصافر الحساب نفسه.
    let shiftId: number | null;
    let cashBucket: "DRAWER" | "TREASURY" | null = null;
    const approverActor: Actor = {
      userId: actor.userId,
      branchId: Number(approver.branchId ?? actor.branchId),
      role: approver.role,
      isOwner: true,
    };
    if (paymentMethod === "CASH" && direction === "OUT") {
      if (cancellationOriginal) {
        shiftId = cancellationOriginal.shiftId != null ? Number(cancellationOriginal.shiftId) : null;
        cashBucket = cancellationOriginal.cashBucket as "DRAWER" | "TREASURY";
      } else {
        shiftId = null;
        cashBucket = "TREASURY";
      }
    } else if (paymentMethod === "CASH") {
      const g = preResolvedCashIn ?? await shiftIdForCashTx(tx, approverActor, branchId, "اعتماد سند قبض نقدي");
      shiftId = g.shiftId;
      cashBucket = g.cashBucket;
    } else {
      shiftId = await openShiftIdTx(tx, approverActor.userId, branchId);
    }

    let systemPurchaseOrder: typeof purchaseOrders.$inferSelect | null = null;
    if (systemRequest?.kind === "PURCHASE_SUPPLIER" || systemRequest?.kind === "PURCHASE_SHIPPING") {
      systemPurchaseOrder = (
        await tx
          .select()
          .from(purchaseOrders)
          .where(eq(purchaseOrders.id, systemRequest.purchaseOrderId))
          .for("update")
          .limit(1)
      )[0] ?? null;
      if (!systemPurchaseOrder || Number(systemPurchaseOrder.branchId) !== branchId) {
        throw new TRPCError({ code: "CONFLICT", message: "أمر الشراء المرتبط بطلب الدفع مفقود أو من فرع آخر" });
      }
      const expectedReference = systemRequest.kind === "PURCHASE_SUPPLIER"
        ? `PO-PAY-${systemPurchaseOrder.poNumber}-${systemRequest.requestToken}`
        : `SHIP-${systemPurchaseOrder.poNumber}-${systemRequest.requestToken}`;
      if (!/^[0-9a-f]{16}$/i.test(systemRequest.requestToken)) {
        throw new TRPCError({ code: "CONFLICT", message: "رمز مصدر طلب دفع أمر الشراء غير صالح" });
      }
      if (r.referenceNumber !== expectedReference) {
        throw new TRPCError({ code: "CONFLICT", message: "مرجع طلب دفع أمر الشراء غير متطابق" });
      }
      if (typeof systemRequest.expectedAmount !== "string" || !money(systemRequest.expectedAmount).eq(amount)) {
        throw new TRPCError({ code: "CONFLICT", message: "مبلغ طلب دفع أمر الشراء لا يطابق مصدره" });
      }
      if (
        systemRequest.kind === "PURCHASE_SUPPLIER" &&
        (
          partyType !== "SUPPLIER" || partyId == null ||
          Number(systemPurchaseOrder.supplierId) !== partyId ||
          typeof systemRequest.sourceTotal !== "string" ||
          !money(systemPurchaseOrder.total).eq(money(systemRequest.sourceTotal))
        )
      ) {
        throw new TRPCError({ code: "CONFLICT", message: "مورد طلب الدفع لا يطابق أمر الشراء" });
      }
      if (
        systemRequest.kind === "PURCHASE_SHIPPING" &&
        (
          typeof systemRequest.sourceShippingTotal !== "string" ||
          !money(systemPurchaseOrder.shippingCost)
            .plus(money(systemPurchaseOrder.customsCost))
            .eq(money(systemRequest.sourceShippingTotal))
        )
      ) {
        throw new TRPCError({ code: "CONFLICT", message: "تكلفة الشحن المرتبطة بطلب الدفع تغيّرت" });
      }
      if (
        systemRequest.kind === "PURCHASE_SUPPLIER" &&
        money(systemPurchaseOrder.paidAmount).plus(amount).gt(money(systemPurchaseOrder.total))
      ) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "دفعة المورد المعلّقة تتجاوز المتبقي على أمر الشراء" });
      }
    }

    // بضاعة الأمانة (ش٥): إعادة فحص السقف تحت قفل صف المودِع — مرتجعٌ بين الإصدار والاعتماد قد يكون
    // خفّض المستحق فيصير الصرف زائداً (السقف عند الإنشاء صار مسرحياً لولا هذا). §٥ حاصرة ٢/ث٤.
    if (partyType === "SUPPLIER" && partyId != null && direction === "OUT") {
      const [sup] = await tx.select({ kind: suppliers.supplierKind, bal: suppliers.currentBalance })
        .from(suppliers).where(eq(suppliers.id, partyId)).for("update").limit(1);
      if (sup?.kind === "CONSIGNOR" && money(sup.bal ?? "0").lt(amount)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `مستحقّ المودِع (${money(sup.bal ?? "0").toFixed(2)}) أقلّ من مبلغ الصرف — أعِد توليد كشف التسوية` });
      }
    }

    if (
      direction === "OUT" &&
      paymentMethod === "CASH" &&
      cashBucket != null
    ) {
      if (cashBucket === "TREASURY") {
        if (!externalTreasuryApproval) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "إثبات اعتماد مالك الصرف الخارجي مفقود" });
        }
        await assertApprovedTreasuryOutAvailable(tx, {
          branchId,
          amount,
          operation: cancellationOriginal ? "اعتماد إلغاء سند قبض نقدي" : "اعتماد سند الصرف النقدي",
        }, externalTreasuryApproval);
      } else {
        await assertCashOutAvailable(tx, {
          branchId,
          cashBucket,
          shiftId,
          amount,
          operation: "اعتماد إلغاء سند قبض من درج الوردية",
        });
      }
    } else if (direction === "OUT") {
      assertNonPhysicalOutReceipt({
        classification: "NON_CASH_METHOD", paymentMethod, cashBucket,
        operation: "اعتماد سند صرف غير نقدي",
      });
    }

    const voucherDate = (r.voucherDate as string | null) ?? toDateStr();

    await tx.update(receipts).set({
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      approvedBy: actor.userId,
      approvedAt: new Date(),
      shiftId,
      cashBucket,
    }).where(eq(receipts.id, receiptId));

    if (cancellationOriginal) {
      await tx.update(receipts).set({ status: "REVERSED" }).where(eq(receipts.id, Number(cancellationOriginal.id)));
    }

    if (systemRequest?.kind === "PURCHASE_SHIPPING" && systemPurchaseOrder) {
      await tx.insert(expenses).values({
        branchId,
        shiftId: null,
        cashBucket: "TREASURY",
        expenseDate: new Date(),
        category: "TRANSPORT",
        amount: toDbMoney(amount),
        paymentMethod: "CASH",
        description: `شحن/كمرك أمر الشراء ${systemPurchaseOrder.poNumber}`,
        referenceNumber: String(systemPurchaseOrder.poNumber),
        receiptId,
        status: "ACTIVE",
        createdBy: r.createdBy != null ? Number(r.createdBy) : actor.userId,
      });
    }

    // الأثر المالي:
    await postEntry(tx, {
      entryType: direction === "IN" ? "PAYMENT_IN" : "PAYMENT_OUT",
      branchId,
      receiptId,
      customerId: partyType === "CUSTOMER" ? partyId : null,
      supplierId: partyType === "SUPPLIER" ? partyId : null,
      purchaseOrderId: systemPurchaseOrder ? Number(systemPurchaseOrder.id) : null,
      amount,
      notes:
        systemRequest?.kind === "PURCHASE_SHIPPING"
          ? `مصروف شحن/كمرك — أمر الشراء ${systemPurchaseOrder?.poNumber ?? systemRequest.purchaseOrderId}`
          : cancellationOriginal
            ? `إلغاء سند ${cancellationOriginal.voucherNumber}`
            : undefined,
      // قفل الفترة على تاريخ السند الفعلي لا لحظة الاعتماد (تدقيق ١٧/٧) — يمنع اعتماد سند بتاريخ رجعي
      // داخل فترة مُقفَلة. voucherDate عمود DATE (drizzle يُصنّفه string لكن mysql2 يعيد Date) ⇒ new Date
      // يعمل للحالتين، وtoDateStr = toISOString.slice(0,10) مطابق لدلالة assertPeriodOpen.
      entryDate: new Date(r.voucherDate ? toDateStr(new Date(r.voucherDate)) : toDateStr()),
    });
    if (partyType === "CUSTOMER" && partyId) {
      await adjustCustomerBalance(tx, partyId, direction === "IN" ? amount.neg() : amount);
    } else if (partyType === "SUPPLIER" && partyId) {
      await adjustSupplierBalance(tx, partyId, direction === "OUT" ? amount.neg() : amount);
    }
    if (systemRequest?.kind === "PURCHASE_SUPPLIER" && systemPurchaseOrder) {
      await tx
        .update(purchaseOrders)
        .set({ paidAmount: toDbMoney(money(systemPurchaseOrder.paidAmount).plus(amount)) })
        .where(eq(purchaseOrders.id, Number(systemPurchaseOrder.id)));
    }

    await activateAdvanceForApprovedVoucherTx(tx, {
      id: receiptId,
      branchId: r.branchId != null ? Number(r.branchId) : null,
      direction,
      amount: String(r.amount),
      paymentMethod,
      internalNote: r.internalNote,
      createdBy: r.createdBy != null ? Number(r.createdBy) : null,
    });

    // البَصمة بعد إكمال كل التَغييرات.
    const hash = computeSignature({
      id: receiptId,
      amount: toDbMoney(amount),
      partyType: partyType ?? "OTHER",
      partyId,
      paymentMethod,
      voucherDate: String(voucherDate).slice(0, 10),
      voucherNumber: String(r.voucherNumber),
      createdBy: r.createdBy != null ? Number(r.createdBy) : 0,
      approvedBy: actor.userId,
      branchId,
    });
    await tx.update(receipts).set({ signatureHash: hash }).where(eq(receipts.id, receiptId));

    return {
      receiptId,
      voucherNumber: String(r.voucherNumber),
      approvalStatus: "APPROVED" as const,
      signatureHash: hash,
      replayed: false,
    };
  });
}

export interface RejectVoucherResult {
  receiptId: number;
  voucherNumber: string;
  approvalStatus: "REJECTED";
}

/** رفض سند مُعلَّق — لا أثر مالي (لم يُسجَّل قيد ولا تَغيَّر رصيد). يَبقى للسجل التَدقيقي.
 *  نفس عقد المالك وفصل المهام: مالك نشط مختلف عن المنشئ فقط. */
export async function rejectVoucher(
  receiptId: number,
  actor: Actor,
  reason: string,
): Promise<RejectVoucherResult> {
  return withTx(async (tx) => {
    // لا يلزم قفل X على حساب المالك؛ SHARE يثبت صفات التفويض ويتوافق مع FK createdBy.
    const [approver] = await tx.select().from(users).where(eq(users.id, actor.userId)).for("share").limit(1);
    if (!approver?.isActive || !approver.isOwner) {
      throw new TRPCError({ code: "FORBIDDEN", message: "رفض السندات محصور بحساب مالك نشط" });
    }
    const r = (
      await tx.select().from(receipts).where(eq(receipts.id, receiptId)).for("update").limit(1)
    )[0];
    if (!r || r.voucherNumber == null) {
      throw new TRPCError({ code: "NOT_FOUND", message: "السند غير موجود" });
    }
    if (r.approvalStatus !== "PENDING_APPROVAL") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "السند ليس في انتظار الموافقة" });
    }
    if (r.createdBy != null && Number(r.createdBy) === actor.userId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "لا يجوز رفض سند أنشأته بنفسك — يلزم مالك آخر",
      });
    }

    const trimmedReason = reason.trim().slice(0, 500);
    if (!trimmedReason) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "سبب الرفض مطلوب (للسجل التَدقيقي)" });
    }
    const noteSuffix = `\n[رُفض ${new Date().toISOString().slice(0, 19)}: ${trimmedReason}]`;
    const newInternal = (r.internalNote ?? "") + noteSuffix;

    await tx.update(receipts).set({
      status: "FAILED",
      approvalStatus: "REJECTED",
      approvedBy: actor.userId,
      approvedAt: new Date(),
      internalNote: newInternal,
    }).where(eq(receipts.id, receiptId));

    return {
      receiptId,
      voucherNumber: String(r.voucherNumber),
      approvalStatus: "REJECTED" as const,
    };
  });
}
