// اعتماد/رفض سند مُعلَّق (Maker-Checker، SOD-04: مالك نشط والمُعتمِد ≠ المُنشئ بلا استثناء).
import { TRPCError } from "@trpc/server";
import { allocateVoucherToInvoiceTx } from "./invoiceAllocation";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  accountingEntries,
  accrualObligationEvents,
  assetMaintenance,
  digitalWalletTransactions,
  digitalWallets,
  employees,
  employeeTerminations,
  exchangeHouses,
  exchangeTransactions,
  expenses,
  fixedAssets,
  idempotencyKeys,
  purchaseOrders,
  receipts,
  suppliers,
  users,
} from "../../../drizzle/schema";
import {
  activateAdvanceForApprovedVoucherTx,
  assertEmployeeAdvanceVoucherRequestTx,
} from "../advancesService";
import {
  adjustCustomerBalance,
  adjustSupplierBalance,
  postEntry,
} from "../ledgerService";
import { baghdadToday } from "../businessDay";
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
import {
  createSystemPaymentRequestTx,
  isCanonicalSystemPaymentRequest,
  hasSystemPaymentRequestEnvelope,
  isSystemPaymentReference,
  parseTerminationSettlementReference,
  parseSystemPaymentRequest,
  terminationSettlementReference,
  type SystemPaymentRequest,
} from "./create";
import {
  createPostingIntent,
  signedPostingLines,
  type AccountRole,
  type PostingIntent,
  type PostingProfile,
  type PostingSourceComponents,
} from "../accounting/postingEngine";
import {
  expenseAccrualSettlement,
  fixedAssetAccrualSettlement,
} from "../accounting/accrualPosting";
import {
  assertAccrualRequestBindingTx,
  lockAccrualRecognitionTx,
  transitionAccrualObligationTx,
} from "../accounting/accrualObligations";
import {
  rejectAccrualCorrectionRefundTx,
  settleAccrualCorrectionRefundTx,
} from "../accounting/accrualCorrection";
import { postExchangeControlReclassification } from "../exchange/controlClassification";
import { loadVoucherCategoryForPosting } from "./categoryAccounting";
import { voucherPostingPlan } from "./posting";
import type { VoucherCategoryPostingRole } from "../../../shared/voucherCategoryAccounting";
import { settleTerminationVoucherTx } from "../terminationSettlementService";
import type { PayrollPaymentMethod } from "../payroll/types";
import type { Tx } from "../../db";
import {
  cancelLockedEmployeeAdvanceTx,
  lockUntouchedEmployeeAdvanceForCancellationTx,
  type LockedEmployeeAdvanceCancellation,
} from "./employeeAdvanceCancellation";
import {
  expensePaymentResubmitDescriptionSuffix,
  expensePaymentResubmitKey,
  parseExpensePaymentResubmitDescription,
  parseExpensePaymentResubmitKey,
} from "./resubmitLineage";
import { withMysqlDeadlockRetry } from "./deadlockRetry";
import {
  pendingPurchaseSupplierPaymentsTx,
  purchaseCashSettlementUsesClearingTx,
  purchaseOrderPayableBalanceTx,
} from "../purchase/internal";
import {
  assertPurchaseUsdResubmissionAvailableTx,
  assertPurchaseUsdSettlementMaterializedTx,
  materializePurchaseUsdSettlementTx,
  reversePurchaseUsdSettlementTx,
} from "../purchase/usdSettlement";

type VoucherPostingPlan = {
  intent: PostingIntent;
  sourceComponents: PostingSourceComponents;
};

type AccrualSettlementSystemRequest = Extract<
  SystemPaymentRequest,
  {
    kind:
      | "ASSET_ACQUISITION"
      | "ASSET_MAINTENANCE"
      | "ASSET_SUPPLIER_SETTLEMENT"
      | "PURCHASE_SHIPPING";
  }
>;

function isAccrualSettlementSystemRequest(
  request: SystemPaymentRequest | null,
): request is AccrualSettlementSystemRequest {
  return (
    request?.kind === "ASSET_ACQUISITION" ||
    request?.kind === "ASSET_MAINTENANCE" ||
    request?.kind === "ASSET_SUPPLIER_SETTLEMENT" ||
    request?.kind === "PURCHASE_SHIPPING"
  );
}

async function assertAccrualSettlementReceiptBindingTx(
  tx: Tx,
  receipt: typeof receipts.$inferSelect,
  request: AccrualSettlementSystemRequest,
  expectedStatus:
    | "PAYMENT_PENDING"
    | "ACCRUED_UNPAID"
    | "PAYABLE_UNSETTLED"
    | "PAID"
    | ReadonlyArray<
        "PAYMENT_PENDING" | "ACCRUED_UNPAID" | "PAYABLE_UNSETTLED" | "PAID"
      >,
) {
  const branchId = Number(receipt.branchId);
  const amount = money(receipt.amount);
  const obligation = await assertAccrualRequestBindingTx(tx, {
    obligationId: request.obligationId,
    sourceHash: request.obligationSourceHash,
    branchId,
    amount: toDbMoney(amount),
    beneficiaryType: request.beneficiaryType,
    beneficiaryId: request.beneficiaryId,
    beneficiaryName: request.beneficiaryNameSnapshot,
    evidenceReference: request.sourceEvidenceReference,
  });
  const expectedKind =
    request.kind === "ASSET_ACQUISITION"
      ? "ASSET_ACQUISITION_CASH"
      : request.kind === "ASSET_SUPPLIER_SETTLEMENT"
        ? "ASSET_ACQUISITION_SUPPLIER"
        : request.kind;
  const receiptPartyMatches =
    request.kind === "ASSET_SUPPLIER_SETTLEMENT"
      ? receipt.partyType === "SUPPLIER" &&
        Number(receipt.partyId) === request.supplierId &&
        request.beneficiaryType === "SUPPLIER" &&
        request.beneficiaryId === request.supplierId
      : receipt.partyType === "OTHER" && receipt.partyId == null;
  const sourceForeignKeysMatch =
    request.kind === "PURCHASE_SHIPPING"
      ? Number(obligation.purchaseOrderId) === request.purchaseOrderId
      : request.kind === "ASSET_MAINTENANCE"
        ? Number(obligation.assetId) === request.assetId &&
          Number(obligation.maintenanceId) === request.maintenanceId
        : Number(obligation.assetId) === request.assetId;
  const paymentRequestEvents = await tx
    .select()
    .from(accrualObligationEvents)
    .where(
      and(
        eq(accrualObligationEvents.obligationId, request.obligationId),
        eq(accrualObligationEvents.eventType, "PAYMENT_REQUESTED"),
        eq(accrualObligationEvents.receiptId, Number(receipt.id)),
      ),
    )
    .for("update")
    .limit(2);
  const paymentRequestEvent = paymentRequestEvents[0];
  const expectedStatuses = Array.isArray(expectedStatus)
    ? expectedStatus
    : [expectedStatus];
  if (
    obligation.kind !== expectedKind ||
    !expectedStatuses.includes(
      obligation.status as (typeof expectedStatuses)[number],
    ) ||
    obligation.plannedPaymentMethod !== receipt.paymentMethod ||
    receipt.direction !== "OUT" ||
    !sourceForeignKeysMatch ||
    !receiptPartyMatches ||
    (receipt.counterpartyName ?? "") !== request.beneficiaryNameSnapshot ||
    paymentRequestEvents.length !== 1 ||
    !paymentRequestEvent ||
    paymentRequestEvent.accountingEntryId != null ||
    paymentRequestEvent.reviewerId != null ||
    Number(paymentRequestEvent.actorId) !== Number(receipt.createdBy ?? 0) ||
    !money(paymentRequestEvent.amount).eq(amount) ||
    paymentRequestEvent.evidenceReference !== request.sourceEvidenceReference
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "طلب تسوية الاستحقاق لا يطابق الالتزام أو المستفيد أو حدث طلب الدفع المثبت",
    });
  }
  return obligation;
}

function terminationVoucherPaymentMethod(
  direction: "IN" | "OUT",
  paymentMethod: PaymentMethod,
): PayrollPaymentMethod {
  if (direction !== "OUT") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "طلب تسوية نهاية الخدمة يجب أن يكون سند صرف",
    });
  }
  switch (paymentMethod) {
    case "CASH":
    case "CARD":
    case "TRANSFER":
    case "WALLET":
      return paymentMethod;
    case "CHECK":
    case "EXCHANGE":
      throw new TRPCError({
        code: "CONFLICT",
        message: "طريقة دفع تسوية نهاية الخدمة لا تطابق عقد الرواتب",
      });
  }
}

function voucherPaymentAssetRole(
  method: PaymentMethod,
  direction: "IN" | "OUT",
  cashBucket: "DRAWER" | "TREASURY" | null,
): AccountRole | null {
  switch (method) {
    case "CASH":
      return cashBucket === "DRAWER"
        ? "CASH"
        : cashBucket === "TREASURY"
          ? "TREASURY_CASH"
          : null;
    case "CARD":
    case "TRANSFER":
      return "CARD_BANK";
    case "CHECK":
      // A received cheque is an asset in hand. An issued cheque clears the bank;
      // it must never reduce CHECKS_RECEIVABLE.
      return direction === "IN" ? "CHECKS_RECEIVABLE" : "CARD_BANK";
    case "WALLET":
      return "PAYMENT_WALLET";
    case "EXCHANGE":
      return null;
  }
}

function signedSourceComponents(
  debitRole: AccountRole,
  creditRole: AccountRole,
  signedAmount: ReturnType<typeof money>,
): PostingSourceComponents {
  const absolute = signedAmount.abs();
  return signedAmount.isNegative()
    ? {
        roleDebits: { [creditRole]: absolute },
        roleCredits: { [debitRole]: absolute },
      }
    : {
        roleDebits: { [debitRole]: absolute },
        roleCredits: { [creditRole]: absolute },
      };
}

function twoRolePostingPlan(
  profile: PostingProfile,
  entryType: "PURCHASE" | "PAYMENT_IN" | "PAYMENT_OUT" | "ADJUST",
  debitRole: AccountRole,
  creditRole: AccountRole,
  signedAmount: ReturnType<typeof money>,
): VoucherPostingPlan {
  const sourceComponents = signedSourceComponents(
    debitRole,
    creditRole,
    signedAmount,
  );
  return {
    intent: createPostingIntent(
      profile,
      entryType,
      signedPostingLines(debitRole, creditRole, signedAmount),
      sourceComponents,
    ),
    sourceComponents,
  };
}

function approvedVoucherPostingPlan(args: {
  direction: "IN" | "OUT";
  paymentMethod: PaymentMethod;
  cashBucket: "DRAWER" | "TREASURY" | null;
  partyType: PartyType | null;
  amount: ReturnType<typeof money>;
  referenceNumber: string | null;
  systemKind: SystemPaymentRequest["kind"] | null;
  categoryPostingRole?: VoucherCategoryPostingRole | null;
  categoryReversalOfDirection?: "IN" | "OUT" | null;
  originalDirectionForCancellation?: "IN" | "OUT" | null;
  purchaseCashClearing: boolean;
}): VoucherPostingPlan | null {
  const assetRole = voucherPaymentAssetRole(
    args.paymentMethod,
    args.originalDirectionForCancellation ?? args.direction,
    args.cashBucket,
  );
  if (!assetRole) return null;

  if (args.systemKind === "ASSET_SUPPLIER_SETTLEMENT") {
    return twoRolePostingPlan(
      "PAYMENT_OUT_SUPPLIER",
      "PAYMENT_OUT",
      "AP",
      assetRole,
      args.amount,
    );
  }
  if (args.systemKind === "ASSET_ACQUISITION") {
    return fixedAssetAccrualSettlement(assetRole, args.amount);
  }
  if (args.systemKind === "PURCHASE_SUPPLIER") {
    const liabilityRole = args.purchaseCashClearing
      ? ("OTHER_LIABILITY" as const)
      : ("AP" as const);
    return args.direction === "OUT"
      ? twoRolePostingPlan(
          args.purchaseCashClearing
            ? "PAYMENT_OUT_PURCHASE_CASH_CLEARING"
            : "PAYMENT_OUT_SUPPLIER",
          "PAYMENT_OUT",
          liabilityRole,
          assetRole,
          args.amount,
        )
      : twoRolePostingPlan(
          args.purchaseCashClearing
            ? "PAYMENT_IN_PURCHASE_CASH_CLEARING"
            : "PAYMENT_IN_SUPPLIER_REFUND",
          "PAYMENT_IN",
          assetRole,
          liabilityRole,
          args.amount,
        );
  }
  if (
    args.systemKind === "PURCHASE_SHIPPING" ||
    args.systemKind === "ASSET_MAINTENANCE"
  ) {
    // Recognition already posted Dr expense / Cr ACCRUED_EXPENSES. Approval
    // clears that liability and is the sole cash materialization point.
    return expenseAccrualSettlement(assetRole, args.amount);
  }
  if (args.systemKind === "EMPLOYEE_ADVANCE") {
    return args.direction === "OUT"
      ? twoRolePostingPlan(
          "PAYMENT_OUT_EMPLOYEE_ADVANCE",
          "PAYMENT_OUT",
          "EMPLOYEE_ADVANCES",
          assetRole,
          args.amount,
        )
      : twoRolePostingPlan(
          "PAYMENT_IN_OTHER",
          "PAYMENT_IN",
          assetRole,
          "EMPLOYEE_ADVANCES",
          args.amount,
        );
  }

  if (args.partyType === "CUSTOMER") {
    return args.direction === "IN"
      ? twoRolePostingPlan(
          "PAYMENT_IN_CUSTOMER",
          "PAYMENT_IN",
          assetRole,
          "AR",
          args.amount,
        )
      : twoRolePostingPlan(
          "PAYMENT_OUT_CUSTOMER_REFUND",
          "PAYMENT_OUT",
          "AR",
          assetRole,
          args.amount,
        );
  }
  if (args.partyType === "SUPPLIER") {
    return args.direction === "OUT"
      ? twoRolePostingPlan(
          "PAYMENT_OUT_SUPPLIER",
          "PAYMENT_OUT",
          "AP",
          assetRole,
          args.amount,
        )
      : twoRolePostingPlan(
          "PAYMENT_IN_SUPPLIER_REFUND",
          "PAYMENT_IN",
          assetRole,
          "AP",
          args.amount,
        );
  }

  if (args.partyType === "OTHER" && args.categoryPostingRole) {
    return (
      voucherPostingPlan({
        entryType: args.direction === "IN" ? "PAYMENT_IN" : "PAYMENT_OUT",
        partyType: args.partyType,
        paymentMethod: args.paymentMethod,
        cashBucket: args.cashBucket,
        amount: args.amount,
        referenceNumber: args.referenceNumber,
        categoryPostingRole: args.categoryPostingRole,
        categoryReversalOfDirection: args.categoryReversalOfDirection,
      }) ?? null
    );
  }

  return null;
}

export interface ApproveVoucherResult {
  receiptId: number;
  voucherNumber: string;
  approvalStatus: "APPROVED";
  signatureHash: string;
  replayed: boolean;
}

/** اعتماد سند مُعلَّق (Maker-Checker): يُسجّل الأثر المالي ويُختم بـsignatureHash.
 *
 * عقد المالك: المُعتمِد حساب users نشط وisOwner=true — هذا وحده هو الحارس (٣/٩/٢٦).
 * ⭐ **قرار المالك:** «لا اعتماد ثانٍ بعد المالك؛ المالك أعلى سلطة» — أُزيل شرط «مختلفٌ عن
 * المُنشئ» الذي كان يمنع مالكاً وحيداً فعّالاً (يُنشئ سنداته ويعتمدها بنفسه) من اعتماد أيّ سندٍ
 * أنشأه هو شخصياً، رغم وجود مُلّاكٍ آخرين نشطين في النظام لم يكونوا طرفاً في ذلك السند تحديداً.
 * الاعتمادُ الذاتيّ للمالك يبقى كاملَ الأثر التدقيقيّ: createdBy وapprovedBy يُسجَّلان كما هما.
 * إعادة اعتماد سند APPROVED idempotent: تعيد البصمة بلا أي كتابة أو أثر مالي ثانٍ.
 */
export async function approveVoucher(
  receiptId: number,
  actor: Actor,
): Promise<ApproveVoucherResult> {
  return withTx(async (tx) => {
    const [preview] = await tx
      .select()
      .from(receipts)
      .where(eq(receipts.id, receiptId))
      .limit(1);
    if (!preview || preview.voucherNumber == null) {
      throw new TRPCError({ code: "NOT_FOUND", message: "السند غير موجود" });
    }
    const [approverPreview] = await tx
      .select()
      .from(users)
      .where(eq(users.id, actor.userId))
      .limit(1);
    if (!approverPreview?.isActive || !approverPreview.isOwner) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "اعتماد السندات محصور بحساب مالك نشط",
      });
    }
    const previewApproverActor: Actor = {
      userId: actor.userId,
      branchId: Number(approverPreview.branchId ?? actor.branchId),
      role: approverPreview.role,
      isOwner: true,
    };
    const cashOutPreview =
      preview.direction === "OUT" && preview.paymentMethod === "CASH";
    const cashInPreview =
      preview.direction === "IN" && preview.paymentMethod === "CASH";
    const systemRequestPreview = parseSystemPaymentRequest(
      preview.internalNote,
    );
    if (
      (isSystemPaymentReference(preview.referenceNumber) ||
        hasSystemPaymentRequestEnvelope(preview.internalNote)) &&
      (!systemRequestPreview ||
        !isCanonicalSystemPaymentRequest(
          systemRequestPreview,
          preview.referenceNumber,
        ))
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "مرجع نظامي بلا payload موثوق — أوقف الاعتماد وراجع التدقيق",
      });
    }
    let cancellationOriginalPreview: typeof preview | null = null;
    let cancellationAttemptIdsPreview: number[] = [];
    if (systemRequestPreview?.kind === "VOUCHER_CANCELLATION") {
      [cancellationOriginalPreview] = await tx
        .select()
        .from(receipts)
        .where(eq(receipts.id, systemRequestPreview.originalReceiptId))
        .limit(1);
      if (!cancellationOriginalPreview) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "سند القبض الأصلي لطلب الإلغاء مفقود",
        });
      }
      if (!preview.referenceNumber) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "طلب إلغاء السند لا يحمل مرجع سلسلة canonical",
        });
      }
      cancellationAttemptIdsPreview = (
        await tx
          .select({ id: receipts.id })
          .from(receipts)
          .where(eq(receipts.referenceNumber, preview.referenceNumber))
          .orderBy(asc(receipts.id))
      ).map((row) => Number(row.id));
      if (!cancellationAttemptIdsPreview.includes(receiptId)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "محاولة الإلغاء الحالية مفقودة من سلسلة الطلبات",
        });
      }
    }
    let preResolvedCashIn: {
      shiftId: number | null;
      cashBucket: "DRAWER" | "TREASURY";
    } | null = null;
    let externalTreasuryApproval: ExternalTreasuryDisbursementApproval | null =
      null;
    let prelockedExchangeHouse: typeof exchangeHouses.$inferSelect | null =
      null;
    let prelockedDigitalWallet: typeof digitalWallets.$inferSelect | null =
      null;
    if (cashInPreview && cancellationOriginalPreview) {
      const cancellationBucket = cancellationOriginalPreview.cashBucket as
        | "DRAWER"
        | "TREASURY"
        | null;
      if (
        cancellationOriginalPreview.paymentMethod !== "CASH" ||
        cancellationBucket == null
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "طلب إلغاء الصرف النقدي لا يطابق مصدر النقد الأصلي",
        });
      }
      preResolvedCashIn = {
        shiftId:
          cancellationOriginalPreview.shiftId != null
            ? Number(cancellationOriginalPreview.shiftId)
            : null,
        cashBucket: cancellationBucket,
      };
    }
    if (cashOutPreview) {
      const cancellationBucket = cancellationOriginalPreview?.cashBucket as
        | "DRAWER"
        | "TREASURY"
        | null
        | undefined;
      if (cancellationOriginalPreview && cancellationBucket == null) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "طلب إلغاء قبض نقدي بلا مصدر نقد أصلي",
        });
      }
      const source: CashAccountRef = cancellationOriginalPreview
        ? {
            branchId: Number(cancellationOriginalPreview.branchId),
            cashBucket: cancellationBucket as "DRAWER" | "TREASURY",
            shiftId:
              cancellationOriginalPreview.shiftId != null
                ? Number(cancellationOriginalPreview.shiftId)
                : null,
          }
        : {
            branchId: Number(preview.branchId),
            cashBucket: "TREASURY" as const,
            shiftId: null,
          };
      if (source.cashBucket === "TREASURY") {
        // إعادة اقتناء أصل قد تعكس CASH في فرع المصدر ثم تصرف من فرع الهدف.
        // كلا الحسابين يجب أن يُقفلا قبل asset/receipt وبترتيب هوية ثابت؛ قفل الهدف
        // وحده يصنع دورة target→source مقابل cash transfer source→target.
        const disbursementBranchIds = [source.branchId];
        externalTreasuryApproval = await authorizeExternalTreasuryDisbursement(
          tx,
          {
            actor,
            makerUserIds: [
              preview.createdBy,
              cancellationOriginalPreview?.createdBy,
            ],
            branchIds: disbursementBranchIds,
            operation: cancellationOriginalPreview
              ? "اعتماد إلغاء سند قبض نقدي"
              : "اعتماد سند الصرف النقدي",
          },
        );
        if (systemRequestPreview?.kind === "EXCHANGE_IQD_DEPOSIT") {
          [prelockedExchangeHouse] = await tx
            .select()
            .from(exchangeHouses)
            .where(eq(exchangeHouses.id, systemRequestPreview.exchangeHouseId))
            .for("update")
            .limit(1);
          if (!prelockedExchangeHouse) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "الصيرفة المرتبطة بطلب الإيداع مفقودة",
            });
          }
        }
        if (systemRequestPreview?.kind === "DIGITAL_WALLET_CASH_DEPOSIT") {
          [prelockedDigitalWallet] = await tx
            .select()
            .from(digitalWallets)
            .where(eq(digitalWallets.id, systemRequestPreview.walletId))
            .for("update")
            .limit(1);
          if (!prelockedDigitalWallet) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "المحفظة المرتبطة بطلب الإيداع مفقودة",
            });
          }
        }
      } else {
        await lockCashSourceForUpdate(tx, source);
      }
    } else if (cashInPreview) {
      preResolvedCashIn =
        preResolvedCashIn ??
        (await shiftIdForCashTx(
          tx,
          previewApproverActor,
          Number(preview.branchId),
          "اعتماد سند قبض نقدي",
        ));
      await lockCashSourceForUpdate(tx, {
        branchId: Number(preview.branchId),
        cashBucket: preResolvedCashIn.cashBucket,
        shiftId: preResolvedCashIn.shiftId,
      });
    }
    // قفل مشاركة يكفي لتثبيت isActive/isOwner حتى نهاية المعاملة، ويبقى متوافقاً
    // مع FK createdBy في كتّاب النقد الآخرين. الترتيب الحاكم للنقد: source → user SHARE → receipt.
    const [approver] = await tx
      .select()
      .from(users)
      .where(eq(users.id, actor.userId))
      .for("share")
      .limit(1);
    if (!approver?.isActive || !approver.isOwner) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "اعتماد السندات محصور بحساب مالك نشط",
      });
    }
    if (
      approver.role !== approverPreview.role ||
      Number(approver.branchId ?? actor.branchId) !==
        Number(approverPreview.branchId ?? actor.branchId)
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "تغيّرت صلاحيات المالك أثناء الاعتماد — أعد المحاولة",
      });
    }
    const receiptIdsToLock = Array.from(
      new Set(
        systemRequestPreview?.kind === "VOUCHER_CANCELLATION"
          ? [
              systemRequestPreview.originalReceiptId,
              ...cancellationAttemptIdsPreview,
            ]
          : [receiptId],
      ),
    ).sort((left, right) => left - right);
    const lockedReceiptRows = await tx
      .select()
      .from(receipts)
      .where(inArray(receipts.id, receiptIdsToLock))
      .orderBy(asc(receipts.id))
      .for("update");
    const r = lockedReceiptRows.find((row) => Number(row.id) === receiptId);
    if (!r || r.voucherNumber == null) {
      throw new TRPCError({ code: "NOT_FOUND", message: "السند غير موجود" });
    }
    if (systemRequestPreview?.kind === "VOUCHER_CANCELLATION") {
      const lockedIds = lockedReceiptRows.map((row) => Number(row.id));
      const currentAttemptIds = (
        await tx
          .select({ id: receipts.id })
          .from(receipts)
          .where(eq(receipts.referenceNumber, String(preview.referenceNumber)))
          .orderBy(asc(receipts.id))
      ).map((row) => Number(row.id));
      if (
        lockedIds.length !== receiptIdsToLock.length ||
        JSON.stringify(currentAttemptIds) !==
          JSON.stringify(cancellationAttemptIdsPreview)
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "تغيّرت سلسلة محاولات إلغاء السند أثناء الاعتماد؛ أعد المحاولة على أحدث حالة",
        });
      }
    }
    if (
      (cashOutPreview || cashInPreview) &&
      (r.direction !== preview.direction ||
        r.paymentMethod !== "CASH" ||
        Number(r.branchId) !== Number(preview.branchId))
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "تغيّر مصدر السند النقدي أثناء الاعتماد — أعد المحاولة",
      });
    }
    // ⭐ قرار المالك (٣/٩/٢٦): لا اعتماد ثانٍ فوق المالك — أُزيل شرط «غير صانع الطلب».
    // البوّابة الوحيدة الباقية أعلاه: أن يكون المُعتمِد مالكاً نشطاً فعلاً. createdBy/approvedBy
    // يبقيان مسجَّلين فيكشف أيّ تقريرٍ الاعتمادَ الذاتيّ إن احتاج أحدٌ مراجعته لاحقاً.
    const systemRequest = parseSystemPaymentRequest(r.internalNote);
    if (
      JSON.stringify(systemRequest) !== JSON.stringify(systemRequestPreview)
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "تغيّر ارتباط الطلب النظامي أثناء الاعتماد — أعد المحاولة",
      });
    }
    if (r.approvalStatus === "APPROVED") {
      if (!r.signatureHash)
        throw new TRPCError({
          code: "CONFLICT",
          message: "السند معتمد بلا بصمة سلامة — راجع التدقيق",
        });
      return {
        receiptId,
        voucherNumber: String(r.voucherNumber),
        approvalStatus: "APPROVED" as const,
        signatureHash: String(r.signatureHash),
        replayed: true,
      };
    }
    if (r.approvalStatus === "REJECTED") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "السند مرفوض — لا يمكن اعتماده",
      });
    }
    if (r.status === "REVERSED") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "السند ملغى — لا يمكن اعتماده",
      });
    }
    if (r.approvalStatus !== "PENDING_APPROVAL" || r.status !== "PENDING") {
      throw new TRPCError({
        code: "CONFLICT",
        message: "السند ليس طلباً معلّقاً صالحاً للاعتماد",
      });
    }
    let cancellationOriginal: typeof r | null = null;
    let cancellationSourceRequest: SystemPaymentRequest | null = null;
    let cancellationPurchaseOrder: typeof purchaseOrders.$inferSelect | null =
      null;
    if (systemRequest?.kind === "VOUCHER_CANCELLATION") {
      cancellationOriginal =
        lockedReceiptRows.find(
          (row) => Number(row.id) === systemRequest.originalReceiptId,
        ) ?? null;
      if (
        !cancellationOriginal ||
        (cancellationOriginal.direction !== "IN" &&
          cancellationOriginal.direction !== "OUT") ||
        r.direction !==
          (cancellationOriginal.direction === "IN" ? "OUT" : "IN") ||
        cancellationOriginal.direction !== systemRequest.originalDirection ||
        cancellationOriginal.paymentMethod !== r.paymentMethod ||
        cancellationOriginal.paymentMethod !==
          systemRequest.originalPaymentMethod ||
        cancellationOriginal.approvalStatus !== "APPROVED" ||
        cancellationOriginal.status !== "COMPLETED" ||
        cancellationOriginal.voucherNumber == null ||
        (cancellationOriginal.paymentMethod === "CASH" &&
          cancellationOriginal.cashBucket == null) ||
        Number(cancellationOriginal.branchId) !== Number(r.branchId) ||
        money(cancellationOriginal.amount).toFixed(2) !==
          money(r.amount).toFixed(2) ||
        (cancellationOriginal.partyType ?? null) !== (r.partyType ?? null) ||
        Number(cancellationOriginal.partyId ?? 0) !== Number(r.partyId ?? 0) ||
        (r.counterpartyName?.trim() || null) !==
          (cancellationOriginal.partyType === "OTHER"
            ? cancellationOriginal.counterpartyName?.trim() ||
              `إلغاء سند ${cancellationOriginal.voucherNumber}`
            : null) ||
        Number(cancellationOriginal.createdBy ?? 0) !==
          Number(systemRequest.originalCreatorId ?? 0) ||
        (cancellationOriginal.referenceNumber?.trim() || null) !==
          systemRequest.originalReferenceNumber ||
        (cancellationOriginal.checkNumber?.trim() || null) !==
          systemRequest.originalCheckNumber ||
        (cancellationOriginal.cardLastFour?.trim() || null) !==
          systemRequest.originalCardLastFour ||
        Number(cancellationOriginal.voucherCategoryId ?? 0) !==
          Number(systemRequest.originalCategoryId ?? 0) ||
        Number(r.voucherCategoryId ?? 0) !==
          Number(cancellationOriginal.voucherCategoryId ?? 0) ||
        (r.checkNumber?.trim() || null) !==
          (cancellationOriginal.checkNumber?.trim() || null) ||
        (r.cardLastFour?.trim() || null) !==
          (cancellationOriginal.cardLastFour?.trim() || null)
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "سند القبض الأصلي تغيّر أو لم يعد صالحاً للإلغاء",
        });
      }
      // ⭐ قرار المالك (٣/٩/٢٦): لا اعتماد ثانٍ فوق المالك (انظر الشرح أعلى الدالّة).
      cancellationSourceRequest = parseSystemPaymentRequest(
        cancellationOriginal.internalNote,
      );
      if (
        (isSystemPaymentReference(cancellationOriginal.referenceNumber) ||
          hasSystemPaymentRequestEnvelope(cancellationOriginal.internalNote)) &&
        (!cancellationSourceRequest ||
          !isCanonicalSystemPaymentRequest(
            cancellationSourceRequest,
            cancellationOriginal.referenceNumber,
          ))
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "مرجع السند الأصلي نظامي بلا payload موثوق — أوقف الإلغاء وراجع التدقيق",
        });
      }
      const materializedEntries = await tx
        .select({
          id: accountingEntries.id,
          entryType: accountingEntries.entryType,
          amount: accountingEntries.amount,
          customerId: accountingEntries.customerId,
          supplierId: accountingEntries.supplierId,
          purchaseOrderId: accountingEntries.purchaseOrderId,
        })
        .from(accountingEntries)
        .where(eq(accountingEntries.receiptId, Number(cancellationOriginal.id)))
        .for("update")
        .limit(
          cancellationSourceRequest?.kind === "PURCHASE_SUPPLIER_USD" ? 4 : 2,
        );
      const materialized = materializedEntries[0];
      if (cancellationSourceRequest?.kind === "PURCHASE_SUPPLIER_USD") {
        await assertPurchaseUsdSettlementMaterializedTx(
          tx,
          cancellationOriginal,
          cancellationSourceRequest,
        );
      } else if (
        materializedEntries.length !== 1 ||
        !materialized ||
        materialized.entryType !==
          (cancellationOriginal.direction === "IN"
            ? "PAYMENT_IN"
            : "PAYMENT_OUT") ||
        !money(materialized.amount).eq(money(cancellationOriginal.amount)) ||
        Number(materialized.customerId ?? 0) !==
          (cancellationOriginal.partyType === "CUSTOMER"
            ? Number(cancellationOriginal.partyId ?? 0)
            : 0) ||
        Number(materialized.supplierId ?? 0) !==
          (cancellationOriginal.partyType === "SUPPLIER"
            ? Number(cancellationOriginal.partyId ?? 0)
            : 0)
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "تعذر إثبات القيد المالي المنفذ لسند القبض الأصلي؛ أوقف الإلغاء وراجع التدقيق",
        });
      }
      if (cancellationSourceRequest?.kind === "PURCHASE_SUPPLIER") {
        cancellationPurchaseOrder =
          (
            await tx
              .select()
              .from(purchaseOrders)
              .where(
                eq(
                  purchaseOrders.id,
                  cancellationSourceRequest.purchaseOrderId,
                ),
              )
              .for("update")
              .limit(1)
          )[0] ?? null;
        if (
          !cancellationPurchaseOrder ||
          cancellationOriginal.direction !== "OUT" ||
          cancellationOriginal.partyType !== "SUPPLIER" ||
          cancellationOriginal.partyId == null ||
          Number(cancellationPurchaseOrder.branchId) !==
            Number(cancellationOriginal.branchId) ||
          Number(cancellationPurchaseOrder.supplierId) !==
            Number(cancellationOriginal.partyId) ||
          !/^[0-9a-f]{16}$/i.test(cancellationSourceRequest.requestToken) ||
          cancellationOriginal.referenceNumber !==
            `PO-PAY-${cancellationPurchaseOrder.poNumber}-${cancellationSourceRequest.requestToken}` ||
          typeof cancellationSourceRequest.expectedAmount !== "string" ||
          !money(cancellationSourceRequest.expectedAmount).eq(
            money(cancellationOriginal.amount),
          ) ||
          typeof cancellationSourceRequest.sourceTotal !== "string" ||
          !money(cancellationPurchaseOrder.total).eq(
            money(cancellationSourceRequest.sourceTotal),
          ) ||
          Number(materialized.purchaseOrderId ?? 0) !==
            Number(cancellationPurchaseOrder.id) ||
          money(cancellationPurchaseOrder.paidAmount).lt(
            money(cancellationOriginal.amount),
          )
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "رابط دفعة أمر الشراء أو تخصيصها تغيّر؛ أوقف الإلغاء وراجع التدقيق",
          });
        }
      }
      const cancellationAttempts = await tx
        .select({
          id: receipts.id,
          status: receipts.status,
          approvalStatus: receipts.approvalStatus,
          referenceNumber: receipts.referenceNumber,
          internalNote: receipts.internalNote,
        })
        .from(receipts)
        .where(
          eq(
            receipts.referenceNumber,
            `CANCEL-VCH-${systemRequest.originalReceiptId}`,
          ),
        )
        .orderBy(asc(receipts.id))
        .for("update");
      const currentAttemptIndex = cancellationAttempts.findIndex(
        (attempt) => Number(attempt.id) === receiptId,
      );
      const attemptChainValid = cancellationAttempts.every((attempt, index) => {
        const request = parseSystemPaymentRequest(attempt.internalNote);
        const prior = index === 0 ? null : cancellationAttempts[index - 1];
        return (
          request?.kind === "VOUCHER_CANCELLATION" &&
          isCanonicalSystemPaymentRequest(request, attempt.referenceNumber) &&
          request.originalReceiptId === systemRequest.originalReceiptId &&
          request.attempt === index + 1 &&
          request.priorCancellationReceiptId ===
            (prior == null ? null : Number(prior.id)) &&
          (prior == null ||
            prior.status === "FAILED" ||
            prior.status === "REVERSED" ||
            prior.approvalStatus === "REJECTED")
        );
      });
      if (
        !attemptChainValid ||
        currentAttemptIndex !== cancellationAttempts.length - 1 ||
        systemRequest.attempt !== currentAttemptIndex + 1
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "تسلسل محاولات إلغاء السند غير موثق أو أن الطلب ليس أحدث محاولة",
        });
      }
      if (
        cancellationSourceRequest &&
        cancellationSourceRequest.kind !== "EMPLOYEE_ADVANCE" &&
        cancellationSourceRequest.kind !== "PURCHASE_SUPPLIER" &&
        cancellationSourceRequest.kind !== "PURCHASE_SUPPLIER_USD"
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "العملية النظامية تُعكس من وحدتها المصدرية فقط",
        });
      }
    }
    const amount = money(r.amount);
    const direction = r.direction as "IN" | "OUT";
    const branchId = Number(r.branchId);
    const partyType = r.partyType as PartyType | null;
    const partyId = r.partyId != null ? Number(r.partyId) : null;
    const paymentMethod = r.paymentMethod as PaymentMethod;
    const postingReferenceNumber =
      cancellationOriginal?.referenceNumber ?? r.referenceNumber;
    const isEmployeeAdvance =
      systemRequest?.kind === "EMPLOYEE_ADVANCE" ||
      cancellationSourceRequest?.kind === "EMPLOYEE_ADVANCE";
    let lockedEmployeeAdvanceCancellation: LockedEmployeeAdvanceCancellation | null =
      null;
    if (isEmployeeAdvance) {
      const advanceRequest =
        systemRequest?.kind === "EMPLOYEE_ADVANCE"
          ? systemRequest
          : cancellationSourceRequest?.kind === "EMPLOYEE_ADVANCE"
            ? cancellationSourceRequest
            : null;
      const advanceReceipt = cancellationOriginal ?? r;
      if (!advanceRequest) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "بيانات المصدر النظامي لسلفة الموظف مفقودة",
        });
      }
      await assertEmployeeAdvanceVoucherRequestTx(
        tx,
        {
          id: Number(advanceReceipt.id),
          branchId:
            advanceReceipt.branchId != null
              ? Number(advanceReceipt.branchId)
              : null,
          direction: String(advanceReceipt.direction),
          amount: String(advanceReceipt.amount),
          paymentMethod: String(advanceReceipt.paymentMethod),
          partyType: advanceReceipt.partyType,
          referenceNumber: advanceReceipt.referenceNumber,
          createdBy:
            advanceReceipt.createdBy != null
              ? Number(advanceReceipt.createdBy)
              : null,
        },
        advanceRequest,
        { requireMaterialized: cancellationOriginal != null },
      );
      if (
        cancellationOriginal &&
        cancellationSourceRequest?.kind === "EMPLOYEE_ADVANCE"
      ) {
        lockedEmployeeAdvanceCancellation =
          await lockUntouchedEmployeeAdvanceForCancellationTx(tx, {
            originalReceiptId: Number(cancellationOriginal.id),
            employeeId: cancellationSourceRequest.employeeId,
            branchId: cancellationSourceRequest.branchId,
            expectedAmount: cancellationSourceRequest.expectedAmount,
          });
      }
    }
    let categoryPostingRole: VoucherCategoryPostingRole | null = null;
    let categoryReversalOfDirection: "IN" | "OUT" | null = null;
    if (partyType === "OTHER" && !isEmployeeAdvance) {
      if (cancellationOriginal) {
        if (cancellationOriginal.voucherCategoryId == null) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "سند القبض الأصلي بلا فئة محاسبية؛ عيّن تصنيفاً تاريخياً معتمداً قبل اعتماد الإلغاء",
          });
        }
        const category = await loadVoucherCategoryForPosting(
          tx,
          Number(cancellationOriginal.voucherCategoryId),
          cancellationOriginal.direction as "IN" | "OUT",
          { allowInactive: true, lock: true },
        );
        categoryPostingRole = category.postingRole;
        categoryReversalOfDirection = cancellationOriginal.direction as
          | "IN"
          | "OUT";
      } else if (!systemRequest) {
        if (r.voucherCategoryId == null) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "سند OTHER بلا فئة محاسبية؛ عيّن فئة وحساباً مقابلاً معتمدين قبل الاعتماد",
          });
        }
        const category = await loadVoucherCategoryForPosting(
          tx,
          Number(r.voucherCategoryId),
          direction,
          { allowInactive: true, lock: true },
        );
        categoryPostingRole = category.postingRole;
      }
    }
    let systemAsset: typeof fixedAssets.$inferSelect | null = null;
    let systemExchangeTxn: typeof exchangeTransactions.$inferSelect | null =
      null;
    let systemWalletTxn: typeof digitalWalletTransactions.$inferSelect | null =
      null;
    let systemAccrualObligation: Awaited<
      ReturnType<typeof assertAccrualRequestBindingTx>
    > | null = null;

    if (isAccrualSettlementSystemRequest(systemRequest)) {
      systemAccrualObligation = await assertAccrualSettlementReceiptBindingTx(
        tx,
        r,
        systemRequest,
        "PAYMENT_PENDING",
      );
      if (systemRequest.kind !== "ASSET_SUPPLIER_SETTLEMENT") {
        const recognition = await lockAccrualRecognitionTx(
          tx,
          systemRequest.obligationId,
        );
        if (
          Number(recognition.obligation.id) !==
            Number(systemAccrualObligation.id) ||
          recognition.obligation.sourceHash !==
            systemAccrualObligation.sourceHash
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "قيد الاعتراف لا يطابق التزام طلب التسوية",
          });
        }
      }
    }

    if (systemRequest?.kind === "VOUCHER_CANCELLATION") {
      if (
        r.referenceNumber !== `CANCEL-VCH-${systemRequest.originalReceiptId}`
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "مرجع طلب إلغاء القبض غير متطابق",
        });
      }
    } else if (systemRequest?.kind === "TERMINATION_SETTLEMENT") {
      const canonicalReference = terminationSettlementReference(systemRequest);
      const parsedReference = parseTerminationSettlementReference(
        r.referenceNumber,
      );
      const evidence =
        systemRequest.paymentEvidenceReference === null
          ? null
          : typeof systemRequest.paymentEvidenceReference === "string"
            ? systemRequest.paymentEvidenceReference.trim() || null
            : undefined;
      if (
        !Number.isSafeInteger(systemRequest.terminationId) ||
        systemRequest.terminationId <= 0 ||
        !Number.isSafeInteger(systemRequest.employeeId) ||
        systemRequest.employeeId <= 0 ||
        typeof systemRequest.expectedAmount !== "string" ||
        !Number.isSafeInteger(systemRequest.attempt) ||
        systemRequest.attempt <= 0 ||
        (systemRequest.originReturnEventId !== null &&
          (!Number.isSafeInteger(systemRequest.originReturnEventId) ||
            systemRequest.originReturnEventId <= 0)) ||
        !Number.isSafeInteger(systemRequest.obligationId) ||
        systemRequest.obligationId <= 0 ||
        typeof systemRequest.settlementSnapshotHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(systemRequest.settlementSnapshotHash) ||
        evidence === undefined ||
        canonicalReference == null ||
        parsedReference == null ||
        r.referenceNumber !== canonicalReference ||
        parsedReference.terminationId !== systemRequest.terminationId ||
        parsedReference.attempt !== systemRequest.attempt ||
        parsedReference.originReturnEventId !==
          systemRequest.originReturnEventId
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "ارتباط طلب تسوية نهاية الخدمة غير صالح",
        });
      }
      const [termination] = await tx
        .select()
        .from(employeeTerminations)
        .where(eq(employeeTerminations.id, systemRequest.terminationId))
        .for("update")
        .limit(1);
      const [employee] = await tx
        .select({
          id: employees.id,
          branchId: employees.branchId,
          employmentStatus: employees.employmentStatus,
        })
        .from(employees)
        .where(eq(employees.id, systemRequest.employeeId))
        .for("update")
        .limit(1);
      if (
        !termination ||
        termination.status !== "completed" ||
        Number(termination.employeeId) !== systemRequest.employeeId ||
        !employee ||
        Number(employee.id) !== systemRequest.employeeId ||
        Number(employee.branchId) !== branchId ||
        employee.employmentStatus !== "terminated" ||
        termination.settlementPaymentMethod !== paymentMethod ||
        (termination.settlementPaymentReference?.trim() || null) !== evidence ||
        termination.settlementSnapshotHash !==
          systemRequest.settlementSnapshotHash ||
        !money(termination.settlement).eq(amount) ||
        !money(systemRequest.expectedAmount).eq(amount) ||
        (paymentMethod === "CASH" && evidence !== null) ||
        (paymentMethod !== "CASH" && evidence === null) ||
        (paymentMethod === "CARD" &&
          (!/^\d{4}$/.test(evidence ?? "") ||
            (r.cardLastFour?.trim() || null) !== evidence)) ||
        (paymentMethod !== "CARD" && r.cardLastFour != null) ||
        r.checkNumber != null
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "تغيّر سجل إنهاء الخدمة أو مبلغ تسويته — أوقف الصرف وراجع الموارد البشرية",
        });
      }
    } else if (
      systemRequest?.kind === "ASSET_ACQUISITION" ||
      systemRequest?.kind === "ASSET_MAINTENANCE"
    ) {
      const assetId = systemRequest.assetId;
      [systemAsset] = await tx
        .select()
        .from(fixedAssets)
        .where(eq(fixedAssets.id, assetId))
        .for("update")
        .limit(1);
      if (
        !systemAsset ||
        systemAsset.status === "disposed" ||
        systemAsset.status === "retired"
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "الأصل المرتبط بطلب الدفع تغيّر أو لم يعد صالحاً",
        });
      }
      if (systemRequest.kind === "ASSET_ACQUISITION") {
        if (
          Number(systemAsset.branchId) !== branchId ||
          systemAsset.supplierId != null ||
          systemAsset.isActive !== true ||
          r.referenceNumber !== `ASSET-ACQ-${assetId}` ||
          !money(systemAsset.purchaseValue).eq(amount)
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "طلب اقتناء الأصل لا يطابق الأصل الحالي",
          });
        }
      } else {
        if (
          Number(systemAsset.branchId) !== branchId ||
          systemAsset.isActive === false
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "الأصل غير نافذ أو انتقل من فرع طلب الصيانة",
          });
        }
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
          throw new TRPCError({
            code: "CONFLICT",
            message: "طلب دفع الصيانة لا يطابق سجل الصيانة",
          });
        }
      }
    } else if (systemRequest?.kind === "EXCHANGE_IQD_DEPOSIT") {
      [systemExchangeTxn] = await tx
        .select()
        .from(exchangeTransactions)
        .where(eq(exchangeTransactions.id, systemRequest.transactionId))
        .for("update")
        .limit(1);
      if (
        !prelockedExchangeHouse ||
        !systemExchangeTxn ||
        Number(prelockedExchangeHouse.id) !== systemRequest.exchangeHouseId ||
        Number(systemExchangeTxn.exchangeHouseId) !==
          systemRequest.exchangeHouseId ||
        Number(systemExchangeTxn.branchId) !== branchId ||
        systemExchangeTxn.type !== "DEPOSIT" ||
        systemExchangeTxn.currency !== "IQD" ||
        systemExchangeTxn.status !== "PENDING_APPROVAL" ||
        Number(systemExchangeTxn.receiptId) !== receiptId ||
        Number(systemExchangeTxn.createdBy ?? 0) !== Number(r.createdBy ?? 0) ||
        r.referenceNumber !==
          `EXCHANGE-IQD-DEP-${systemRequest.transactionId}` ||
        typeof systemRequest.expectedAmount !== "string" ||
        !money(systemRequest.expectedAmount).eq(amount) ||
        !money(systemExchangeTxn.iqdAmount).eq(amount)
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "طلب إيداع الصيرفة تغيّر أو لم يعد صالحاً",
        });
      }
    } else if (systemRequest?.kind === "DIGITAL_WALLET_CASH_DEPOSIT") {
      [systemWalletTxn] = await tx
        .select()
        .from(digitalWalletTransactions)
        .where(eq(digitalWalletTransactions.id, systemRequest.transactionId))
        .for("update")
        .limit(1);
      if (
        !prelockedDigitalWallet ||
        !systemWalletTxn ||
        Number(prelockedDigitalWallet.id) !== systemRequest.walletId ||
        Number(prelockedDigitalWallet.branchId) !== branchId ||
        prelockedDigitalWallet.isActive !== true ||
        Number(systemWalletTxn.walletId) !== systemRequest.walletId ||
        Number(systemWalletTxn.branchId) !== branchId ||
        systemWalletTxn.type !== "DEPOSIT" ||
        systemWalletTxn.direction !== "IN" ||
        systemWalletTxn.status !== "PENDING_APPROVAL" ||
        Number(systemWalletTxn.receiptId) !== receiptId ||
        Number(systemWalletTxn.createdBy) !== Number(r.createdBy ?? 0) ||
        r.referenceNumber !==
          `DIGITAL-WALLET-DEP-${systemRequest.transactionId}` ||
        typeof systemRequest.expectedAmount !== "string" ||
        !money(systemRequest.expectedAmount).eq(amount) ||
        !money(systemWalletTxn.amount).eq(amount)
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "طلب إيداع المحفظة تغيّر أو لم يعد صالحاً",
        });
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
        shiftId =
          cancellationOriginal.shiftId != null
            ? Number(cancellationOriginal.shiftId)
            : null;
        cashBucket = cancellationOriginal.cashBucket as "DRAWER" | "TREASURY";
      } else {
        shiftId = null;
        cashBucket = "TREASURY";
      }
    } else if (paymentMethod === "CASH") {
      const g =
        preResolvedCashIn ??
        (await shiftIdForCashTx(
          tx,
          approverActor,
          branchId,
          "اعتماد سند قبض نقدي",
        ));
      shiftId = g.shiftId;
      cashBucket = g.cashBucket;
    } else {
      shiftId = await openShiftIdTx(tx, approverActor.userId, branchId);
    }

    let systemPurchaseOrder: typeof purchaseOrders.$inferSelect | null = null;
    if (
      systemRequest?.kind === "PURCHASE_SUPPLIER" ||
      systemRequest?.kind === "PURCHASE_SHIPPING"
    ) {
      systemPurchaseOrder =
        (
          await tx
            .select()
            .from(purchaseOrders)
            .where(eq(purchaseOrders.id, systemRequest.purchaseOrderId))
            .for("update")
            .limit(1)
        )[0] ?? null;
      if (
        !systemPurchaseOrder ||
        Number(systemPurchaseOrder.branchId) !== branchId
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "أمر الشراء المرتبط بطلب الدفع مفقود أو من فرع آخر",
        });
      }
      const expectedReference =
        systemRequest.kind === "PURCHASE_SUPPLIER"
          ? `PO-PAY-${systemPurchaseOrder.poNumber}-${systemRequest.requestToken}`
          : `SHIP-${systemPurchaseOrder.poNumber}-${systemRequest.requestToken}`;
      if (!/^[0-9a-f]{16}$/i.test(systemRequest.requestToken)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "رمز مصدر طلب دفع أمر الشراء غير صالح",
        });
      }
      if (r.referenceNumber !== expectedReference) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "مرجع طلب دفع أمر الشراء غير متطابق",
        });
      }
      if (
        typeof systemRequest.expectedAmount !== "string" ||
        !money(systemRequest.expectedAmount).eq(amount)
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "مبلغ طلب دفع أمر الشراء لا يطابق مصدره",
        });
      }
      if (
        systemRequest.kind === "PURCHASE_SUPPLIER" &&
        (partyType !== "SUPPLIER" ||
          partyId == null ||
          Number(systemPurchaseOrder.supplierId) !== partyId ||
          typeof systemRequest.sourceTotal !== "string" ||
          !money(systemPurchaseOrder.total).eq(
            money(systemRequest.sourceTotal),
          ) ||
          (systemRequest.liabilityAccount === "CASH_CLEARING" &&
            systemPurchaseOrder.settlementType !== "CASH"))
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "مورد طلب الدفع لا يطابق أمر الشراء",
        });
      }
      if (systemRequest.kind === "PURCHASE_SUPPLIER") {
        const expectedCashClearing =
          systemPurchaseOrder.settlementType === "CASH" &&
          (await purchaseCashSettlementUsesClearingTx(
            tx,
            Number(systemPurchaseOrder.id),
          ));
        if (
          (systemRequest.liabilityAccount === "CASH_CLEARING") !==
          expectedCashClearing
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "حساب تسوية طلب دفع أمر الشراء لا يطابق قيده المثبت",
          });
        }
      }
      if (
        systemRequest.kind === "PURCHASE_SHIPPING" &&
        (typeof systemRequest.sourceShippingTotal !== "string" ||
          !money(systemPurchaseOrder.shippingCost)
            .plus(money(systemPurchaseOrder.customsCost))
            .eq(money(systemRequest.sourceShippingTotal)))
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "تكلفة الشحن المرتبطة بطلب الدفع تغيّرت",
        });
      }
      if (systemRequest.kind === "PURCHASE_SHIPPING") {
        const declaredPaymentReference =
          systemRequest.paymentReference?.trim() || null;
        const actualPaymentReference =
          paymentMethod === "CARD"
            ? r.cardLastFour?.trim() || null
            : paymentMethod === "TRANSFER" || paymentMethod === "CHECK"
              ? r.checkNumber?.trim() || null
              : null;
        const referenceRequired =
          paymentMethod === "CARD" ||
          paymentMethod === "TRANSFER" ||
          paymentMethod === "CHECK";
        if (
          (referenceRequired &&
            (!declaredPaymentReference ||
              actualPaymentReference !== declaredPaymentReference)) ||
          (!referenceRequired && declaredPaymentReference != null) ||
          (paymentMethod === "CARD" &&
            !/^\d{4}$/.test(declaredPaymentReference ?? "")) ||
          (paymentMethod !== "CARD" && r.cardLastFour != null) ||
          (paymentMethod !== "TRANSFER" &&
            paymentMethod !== "CHECK" &&
            r.checkNumber != null)
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "مرجع أداة دفع الشحن لا يطابق الطلب الأصلي؛ أوقف الاعتماد وراجع طريقة الدفع",
          });
        }
      }
      if (
        systemRequest.kind === "PURCHASE_SUPPLIER" &&
        money(systemPurchaseOrder.paidAmount)
          .plus(amount)
          .gt(money(systemPurchaseOrder.total))
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "دفعة المورد المعلّقة تتجاوز المتبقي على أمر الشراء",
        });
      }
      if (systemRequest.kind === "PURCHASE_SUPPLIER") {
        const payableBalance = await purchaseOrderPayableBalanceTx(
          tx,
          Number(systemPurchaseOrder.id),
        );
        if (amount.gt(payableBalance)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `الرصيد الدفتري المستحق على أمر الشراء (${payableBalance.toFixed(2)}) أقل من طلب الدفع — راجع المرتجعات والمدفوعات اللاحقة`,
          });
        }
      }
    }

    const purchaseCashClearing =
      (systemRequest?.kind === "PURCHASE_SUPPLIER" &&
        systemRequest.liabilityAccount === "CASH_CLEARING") ||
      (cancellationSourceRequest?.kind === "PURCHASE_SUPPLIER" &&
        cancellationSourceRequest.liabilityAccount === "CASH_CLEARING");

    // كل دفعة مورد تعيد فحص AP الحالي تحت القفل؛ مرتجع أو دفعة أخرى بين الطلب
    // والاعتماد قد تخفض المستحق لأي مورد، لا المودِع فقط.
    if (
      partyType === "SUPPLIER" &&
      partyId != null &&
      direction === "OUT" &&
      systemRequest?.kind !== "PURCHASE_SUPPLIER_USD" &&
      !purchaseCashClearing
    ) {
      const [sup] = await tx
        .select({ kind: suppliers.supplierKind, bal: suppliers.currentBalance })
        .from(suppliers)
        .where(eq(suppliers.id, partyId))
        .for("update")
        .limit(1);
      if (!sup) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "المورد المرتبط بسند الصرف مفقود",
        });
      }
      if (money(sup.bal ?? "0").lt(amount)) {
        const label =
          sup.kind === "CONSIGNOR" ? "مستحقّ المودِع" : "الرصيد المستحق للمورد";
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `${label} (${money(sup.bal ?? "0").toFixed(2)}) أقلّ من مبلغ الصرف — أعد الطلب بعد مراجعة الكشف`,
        });
      }
    }

    if (direction === "OUT" && paymentMethod === "CASH" && cashBucket != null) {
      if (cashBucket === "TREASURY") {
        if (!externalTreasuryApproval) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "إثبات اعتماد مالك الصرف الخارجي مفقود",
          });
        }
        await assertApprovedTreasuryOutAvailable(
          tx,
          {
            branchId,
            amount,
            operation: cancellationOriginal
              ? "اعتماد إلغاء سند قبض نقدي"
              : "اعتماد سند الصرف النقدي",
          },
          externalTreasuryApproval,
        );
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
        classification: "NON_CASH_METHOD",
        paymentMethod,
        cashBucket,
        operation: "اعتماد سند صرف غير نقدي",
      });
    }

    const isAccrualCorrectionRefundMovement = systemRequest?.kind === "ACCRUAL_CORRECTION_REFUND";
    const specializedAssetMovement =
      systemRequest?.kind === "EXCHANGE_IQD_DEPOSIT" ||
      systemRequest?.kind === "DIGITAL_WALLET_CASH_DEPOSIT" ||
      systemRequest?.kind === "TERMINATION_SETTLEMENT" ||
      isAccrualCorrectionRefundMovement ||
      systemRequest?.kind === "PURCHASE_SUPPLIER_USD" ||
      cancellationSourceRequest?.kind === "PURCHASE_SUPPLIER_USD";
    const terminationSettlementPlan =
      systemRequest?.kind === "TERMINATION_SETTLEMENT"
        ? {
            terminationId: systemRequest.terminationId,
            employeeId: systemRequest.employeeId,
            attempt: systemRequest.attempt,
            originReturnEventId: systemRequest.originReturnEventId,
            settlementSnapshotHash: systemRequest.settlementSnapshotHash,
            obligationId: systemRequest.obligationId,
            paymentMethod: terminationVoucherPaymentMethod(
              direction,
              paymentMethod,
            ),
          }
        : null;
    const standardPosting = specializedAssetMovement
      ? null
      : approvedVoucherPostingPlan({
          direction,
          paymentMethod,
          cashBucket,
          partyType,
          amount,
          referenceNumber: postingReferenceNumber,
          systemKind:
            cancellationSourceRequest?.kind ?? systemRequest?.kind ?? null,
          categoryPostingRole,
          categoryReversalOfDirection,
          originalDirectionForCancellation:
            cancellationOriginal?.direction === "IN" ||
            cancellationOriginal?.direction === "OUT"
              ? cancellationOriginal.direction
              : null,
          purchaseCashClearing,
        });
    if (!specializedAssetMovement && !standardPosting) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "تعذر تحديد الحساب المقابل للسند قبل الاعتماد؛ عيّن تصنيفاً محاسبياً موثوقاً ثم أعد المحاولة.",
      });
    }

    const approvedAt = new Date();
    const voucherDate = terminationSettlementPlan
      ? baghdadToday(approvedAt)
      : r.voucherDate
        ? toDateStr(new Date(r.voucherDate))
        : toDateStr(approvedAt);

    await tx
      .update(receipts)
      .set({
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        approvedBy: actor.userId,
        approvedAt,
        shiftId,
        cashBucket,
        ...(terminationSettlementPlan
          ? { voucherDate: new Date(`${voucherDate}T00:00:00.000Z`) }
          : {}),
        ...(cancellationOriginal
          ? { voucherCategoryId: cancellationOriginal.voucherCategoryId }
          : {}),
      })
      .where(eq(receipts.id, receiptId));

    if (terminationSettlementPlan) {
      await settleTerminationVoucherTx(tx, {
        terminationId: terminationSettlementPlan.terminationId,
        employeeId: terminationSettlementPlan.employeeId,
        branchId,
        receiptId,
        amount,
        paymentMethod: terminationSettlementPlan.paymentMethod,
        actorUserId: actor.userId,
        occurredAt: approvedAt,
        attempt: terminationSettlementPlan.attempt,
        originReturnEventId: terminationSettlementPlan.originReturnEventId,
        settlementSnapshotHash:
          terminationSettlementPlan.settlementSnapshotHash,
        expectedObligationId: terminationSettlementPlan.obligationId,
      });
    }

    if (systemRequest?.kind === "ACCRUAL_CORRECTION_REFUND") {
      const [approvedReceipt] = await tx
        .select()
        .from(receipts)
        .where(eq(receipts.id, receiptId))
        .limit(1);
      if (!approvedReceipt) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "سند قبض استرداد التصحيح مفقود بعد الاعتماد",
        });
      }
      await settleAccrualCorrectionRefundTx(tx, {
        receipt: approvedReceipt,
        request: systemRequest,
        approver: approverActor,
        occurredAt: approvedAt,
      });
    }

    if (systemRequest?.kind === "PURCHASE_SUPPLIER_USD") {
      await materializePurchaseUsdSettlementTx(tx, {
        receipt: r,
        request: systemRequest,
        approverUserId: actor.userId,
      });
    }

    if (
      cancellationOriginal &&
      cancellationSourceRequest?.kind === "PURCHASE_SUPPLIER_USD"
    ) {
      await reversePurchaseUsdSettlementTx(tx, {
        originalReceipt: cancellationOriginal,
        cancellationReceipt: r,
        request: cancellationSourceRequest,
        approverUserId: actor.userId,
      });
    }

    if (lockedEmployeeAdvanceCancellation) {
      await cancelLockedEmployeeAdvanceTx(
        tx,
        lockedEmployeeAdvanceCancellation,
      );
    }

    if (cancellationOriginal) {
      await tx
        .update(receipts)
        .set({ status: "REVERSED" })
        .where(eq(receipts.id, Number(cancellationOriginal.id)));
    }

    if (systemRequest?.kind === "ASSET_ACQUISITION" && systemAsset) {
      await tx
        .update(fixedAssets)
        .set({ isActive: true })
        .where(eq(fixedAssets.id, systemRequest.assetId));
    }

    if (
      systemRequest?.kind === "EXCHANGE_IQD_DEPOSIT" &&
      systemExchangeTxn &&
      prelockedExchangeHouse
    ) {
      const nextIqd = money(prelockedExchangeHouse.balanceIqd).plus(amount);
      await tx
        .update(exchangeHouses)
        .set({ balanceIqd: toDbMoney(nextIqd) })
        .where(eq(exchangeHouses.id, systemRequest.exchangeHouseId));
      await tx
        .update(exchangeTransactions)
        .set({
          status: "ACTIVE",
          balanceIqdAfter: toDbMoney(nextIqd),
          balanceUsdAfter: toDbMoney(money(prelockedExchangeHouse.balanceUsd)),
        })
        .where(eq(exchangeTransactions.id, systemRequest.transactionId));
      const exchangeDepositComponents = signedSourceComponents(
        "EXCHANGE_WALLET_IQD",
        "TREASURY_CASH",
        amount,
      );
      await postEntry(tx, {
        entryType: "EXCHANGE_DEPOSIT",
        branchId,
        exchangeHouseId: systemRequest.exchangeHouseId,
        receiptId,
        amount,
        revenue: money(0),
        cost: money(0),
        profit: money(0),
        postingIntent: createPostingIntent(
          "EXCHANGE_DEPOSIT_IQD",
          "EXCHANGE_DEPOSIT",
          signedPostingLines("EXCHANGE_WALLET_IQD", "TREASURY_CASH", amount),
          exchangeDepositComponents,
        ),
        postingSourceComponents: exchangeDepositComponents,
        dedupeKey: `EXDEP:${systemExchangeTxn.txnNumber}`,
        notes: systemExchangeTxn.notes ?? undefined,
        createdBy: actor.userId,
      });
      await postExchangeControlReclassification(tx, {
        exchangeHouseId: systemRequest.exchangeHouseId,
        currency: "IQD",
        beforeSignedIqd: prelockedExchangeHouse.balanceIqd,
        afterSignedIqd: nextIqd,
        sourceKey: systemExchangeTxn.txnNumber,
        notes: `إعادة تصنيف رصيد بيت الصرافة بعد اعتماد إيداع ${systemExchangeTxn.txnNumber}`,
        createdBy: actor.userId,
      });
    }

    if (
      systemRequest?.kind === "DIGITAL_WALLET_CASH_DEPOSIT" &&
      systemWalletTxn &&
      prelockedDigitalWallet
    ) {
      const next = money(prelockedDigitalWallet.currentBalance).plus(amount);
      await tx
        .update(digitalWallets)
        .set({ currentBalance: toDbMoney(next) })
        .where(eq(digitalWallets.id, systemRequest.walletId));
      await tx
        .update(digitalWalletTransactions)
        .set({
          status: "ACTIVE",
          balanceAfter: toDbMoney(next),
          approvedBy: actor.userId,
          approvedAt: new Date(),
        })
        .where(eq(digitalWalletTransactions.id, systemRequest.transactionId));
      const digitalDepositComponents = signedSourceComponents(
        "DIGITAL_WALLET",
        "TREASURY_CASH",
        amount,
      );
      await postEntry(tx, {
        entryType: "DIGITAL_WALLET_DEPOSIT",
        branchId,
        receiptId,
        digitalWalletId: systemRequest.walletId,
        amount,
        revenue: money(0),
        cost: money(0),
        profit: money(0),
        postingIntent: createPostingIntent(
          "DIGITAL_WALLET_DEPOSIT_ASSET",
          "DIGITAL_WALLET_DEPOSIT",
          signedPostingLines("DIGITAL_WALLET", "TREASURY_CASH", amount),
          digitalDepositComponents,
        ),
        postingSourceComponents: digitalDepositComponents,
        dedupeKey: `DIGITAL:WDEP:${systemRequest.transactionId}`,
        notes: "إيداع رصيد محفظة كروت بعد اعتماد المالك",
        createdBy: actor.userId,
      });
    }

    // الأثر المالي:
    if (standardPosting) {
      const settlesRecognizedAccrual =
        systemRequest?.kind === "PURCHASE_SHIPPING" ||
        systemRequest?.kind === "ASSET_MAINTENANCE" ||
        systemRequest?.kind === "ASSET_ACQUISITION";
      await postEntry(tx, {
        entryType: direction === "IN" ? "PAYMENT_IN" : "PAYMENT_OUT",
        branchId,
        receiptId,
        customerId: partyType === "CUSTOMER" ? partyId : null,
        supplierId: partyType === "SUPPLIER" ? partyId : null,
        purchaseOrderId: systemPurchaseOrder
          ? Number(systemPurchaseOrder.id)
          : cancellationPurchaseOrder
            ? Number(cancellationPurchaseOrder.id)
            : null,
        purchaseLiabilityAccount:
          systemRequest?.kind === "PURCHASE_SUPPLIER" ||
          cancellationSourceRequest?.kind === "PURCHASE_SUPPLIER"
            ? purchaseCashClearing
              ? "CASH_CLEARING"
              : "AP"
            : null,
        amount,
        paymentMethod,
        postingIntent: standardPosting.intent,
        postingSourceComponents: standardPosting.sourceComponents,
        dedupeKey:
          systemRequest?.kind === "ASSET_ACQUISITION"
            ? `ASSET_ACQ:${systemRequest.assetId}`
            : undefined,
        notes: cancellationOriginal
          ? `إلغاء سند ${cancellationOriginal.voucherNumber}`
          : systemRequest?.kind === "ASSET_ACQUISITION"
            ? `اقتناء أصل نقدي ${systemAsset?.code ?? systemRequest.assetId}`
            : undefined,
        // الاعتراف يعود لتاريخ الاستلام/الصيانة/الحيازة، أمّا التسوية النقدية
        // فهي واقعة مستقلة في تاريخ اعتمادها الفعلي ولا تُرحّل إلى شهر الطلب.
        entryDate: settlesRecognizedAccrual
          ? new Date()
          : new Date(
              r.voucherDate ? toDateStr(new Date(r.voucherDate)) : toDateStr(),
            ),
      });
    }
    if (
      systemAccrualObligation &&
      isAccrualSettlementSystemRequest(systemRequest)
    ) {
      const settlementEntries = await tx
        .select({
          id: accountingEntries.id,
          entryType: accountingEntries.entryType,
          branchId: accountingEntries.branchId,
          amount: accountingEntries.amount,
        })
        .from(accountingEntries)
        .where(eq(accountingEntries.receiptId, receiptId))
        .for("update")
        .limit(2);
      const settlementEntry = settlementEntries[0];
      if (
        settlementEntries.length !== 1 ||
        !settlementEntry ||
        settlementEntry.entryType !== "PAYMENT_OUT" ||
        Number(settlementEntry.branchId) !== branchId ||
        !money(settlementEntry.amount).eq(amount)
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "قيد تسوية الاستحقاق غير وحيد أو لا يطابق السند المعتمد",
        });
      }
      await transitionAccrualObligationTx(tx, {
        obligationId: Number(systemAccrualObligation.id),
        expectedStatus: "PAYMENT_PENDING",
        nextStatus: "PAID",
        eventType: "PAYMENT_SETTLED",
        actorId: Number(r.createdBy),
        reviewerId: actor.userId,
        receiptId,
        accountingEntryId: Number(settlementEntry.id),
        evidenceReference: systemRequest.sourceEvidenceReference,
        dedupeKey: `ACCRUAL:PAYMENT_SETTLED:${systemAccrualObligation.id}:${receiptId}`,
      });
    }
    // قفل الفترة على تاريخ السند الفعلي لا لحظة الاعتماد (تدقيق ١٧/٧) — يمنع اعتماد سند بتاريخ رجعي
    // داخل فترة مُقفَلة. voucherDate عمود DATE (drizzle يُصنّفه string لكن mysql2 يعيد Date) ⇒ new Date
    // يعمل للحالتين، وtoDateStr = toISOString.slice(0,10) مطابق لدلالة assertPeriodOpen.
    if (partyType === "CUSTOMER" && partyId) {
      // تخصيص السند لفاتورته عند **الاعتماد** لا الطلب (الأثر المالي كلّه هنا). حالةُ الفاتورة
      // تُعاد فحصها داخل allocateVoucherToInvoiceTx تحت القفل: بين الطلب والاعتماد قد تُلغى
      // الفاتورة أو تُصحَّح فيصير تخصيص المال لها نسبةً لمستندٍ ميت.
      //
      // ⚠️ **يسبق تعديل رصيد العميل** — مرآةُ `voucher/create.ts` حرفياً (٣١/٨/٢٦): التخصيص
      // يقفل صفّ الفاتورة والتعديلُ يقفل صفّ العميل ضمنياً، فالترتيب القانونيّ «فاتورة ← عميل»
      // كما في sale/payment وdelivery/dispatch وreturnService. **الإنشاء والاعتماد يجب أن
      // يتحرّكا معاً**: تقويمُ أحدهما وحده يصنع ABBA بينهما — محاسبٌ يعتمد سنداً معلَّقاً على
      // فاتورة، وكاشيرٌ يسجّل سنداً مباشراً على نفس الفاتورة والعميل في اللحظة ذاتها. وخطرُه
      // غيرُ متكافئ: `createVoucher` محميّ بـ`withMysqlDeadlockRetry` بينما الاعتماد بلا غلاف.
      if (r.invoiceId != null) {
        await allocateVoucherToInvoiceTx(tx, {
          invoiceId: Number(r.invoiceId),
          amount,
          direction,
          paymentMethod,
        });
      }
      await adjustCustomerBalance(
        tx,
        partyId,
        direction === "IN" ? amount.neg() : amount,
      );
    } else if (
      partyType === "SUPPLIER" &&
      partyId &&
      systemRequest?.kind !== "PURCHASE_SUPPLIER_USD" &&
      cancellationSourceRequest?.kind !== "PURCHASE_SUPPLIER_USD" &&
      !purchaseCashClearing
    ) {
      await adjustSupplierBalance(
        tx,
        partyId,
        direction === "OUT" ? amount.neg() : amount,
      );
    }
    if (systemRequest?.kind === "PURCHASE_SUPPLIER" && systemPurchaseOrder) {
      await tx
        .update(purchaseOrders)
        .set({
          paidAmount: toDbMoney(
            money(systemPurchaseOrder.paidAmount).plus(amount),
          ),
        })
        .where(eq(purchaseOrders.id, Number(systemPurchaseOrder.id)));
    } else if (
      cancellationSourceRequest?.kind === "PURCHASE_SUPPLIER" &&
      cancellationPurchaseOrder
    ) {
      await tx
        .update(purchaseOrders)
        .set({
          paidAmount: toDbMoney(
            money(cancellationPurchaseOrder.paidAmount).minus(amount),
          ),
        })
        .where(eq(purchaseOrders.id, Number(cancellationPurchaseOrder.id)));
    }

    if (systemRequest?.kind === "EMPLOYEE_ADVANCE") {
      await activateAdvanceForApprovedVoucherTx(
        tx,
        {
          id: receiptId,
          branchId: r.branchId != null ? Number(r.branchId) : null,
          direction,
          amount: String(r.amount),
          paymentMethod,
          partyType: r.partyType,
          referenceNumber: r.referenceNumber,
          createdBy: r.createdBy != null ? Number(r.createdBy) : null,
        },
        systemRequest,
      );
    }

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
    await tx
      .update(receipts)
      .set({ signatureHash: hash })
      .where(eq(receipts.id, receiptId));

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
    const [approver] = await tx
      .select()
      .from(users)
      .where(eq(users.id, actor.userId))
      .for("share")
      .limit(1);
    if (!approver?.isActive || !approver.isOwner) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "رفض السندات محصور بحساب مالك نشط",
      });
    }
    const r = (
      await tx
        .select()
        .from(receipts)
        .where(eq(receipts.id, receiptId))
        .for("update")
        .limit(1)
    )[0];
    if (!r || r.voucherNumber == null) {
      throw new TRPCError({ code: "NOT_FOUND", message: "السند غير موجود" });
    }
    if (r.approvalStatus !== "PENDING_APPROVAL") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "السند ليس في انتظار الموافقة",
      });
    }
    // المسار و-٣ (١٧/٨): إلغاء سندٍ معلَّق يقلبه `REVERSED` **ويُبقي** `approvalStatus` معلَّقاً
    // (`cancel.ts` — لا أثر ماليّ فلا يُغيّر حالة الاعتماد). فكان يبقى في طابور الاعتماد ويقبل
    // «رفضاً» لاحقاً ⇒ حالة مستحيلة `REVERSED + REJECTED`، وأخطر: يُطلق حدث `PAYMENT_REJECTED`
    // على التزامٍ سبق أن أُلغي طلبه. `approveVoucher` يحرس `REVERSED` صراحةً — والرفض لم يكن.
    if (r.status === "REVERSED") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "السند ملغى — لا يمكن رفضه (الإلغاء أنهى الطلب أصلاً)",
      });
    }
    // ⭐ قرار المالك (٣/٩/٢٦): لا اعتماد ثانٍ فوق المالك — الرفض كالاعتماد سواء.
    const trimmedReason = reason.trim().slice(0, 500);
    if (!trimmedReason) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "سبب الرفض مطلوب (للسجل التَدقيقي)",
      });
    }
    const occurredAt = new Date();
    const noteSuffix = `\n[رُفض ${occurredAt.toISOString().slice(0, 19)}: ${trimmedReason}]`;
    const systemRequest = parseSystemPaymentRequest(r.internalNote);
    if (
      (isSystemPaymentReference(r.referenceNumber) ||
        hasSystemPaymentRequestEnvelope(r.internalNote)) &&
      (!systemRequest ||
        !isCanonicalSystemPaymentRequest(systemRequest, r.referenceNumber))
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "مرجع نظامي بلا payload canonical؛ أوقف الرفض وراجع سجل التدقيق",
      });
    }
    if (systemRequest?.kind === "ACCRUAL_CORRECTION_REFUND") {
      const reviewerActor: Actor = {
        userId: actor.userId,
        branchId: Number(approver.branchId ?? actor.branchId),
        role: approver.role,
        isOwner: true,
      };
      await rejectAccrualCorrectionRefundTx(tx, {
        receipt: r,
        request: systemRequest,
        reviewer: reviewerActor,
        rejectionReason: trimmedReason,
        occurredAt,
      });
    }
    if (isAccrualSettlementSystemRequest(systemRequest)) {
      const reviewerActor: Actor = {
        userId: actor.userId,
        branchId: Number(approver.branchId ?? actor.branchId),
        role: approver.role,
        isOwner: true,
      };
      const obligation = await assertAccrualSettlementReceiptBindingTx(
        tx,
        r,
        systemRequest,
        "PAYMENT_PENDING",
      );
      await transitionAccrualObligationTx(tx, {
        obligationId: Number(obligation.id),
        expectedStatus: "PAYMENT_PENDING",
        nextStatus:
          obligation.kind === "ASSET_ACQUISITION_SUPPLIER"
            ? "PAYABLE_UNSETTLED"
            : "ACCRUED_UNPAID",
        eventType: "PAYMENT_REJECTED",
        actorId: Number(r.createdBy),
        reviewerId: reviewerActor.userId,
        receiptId: Number(r.id),
        evidenceReference: systemRequest.sourceEvidenceReference,
        dedupeKey: `ACCRUAL:PAYMENT_REJECTED:${obligation.id}:${r.id}`,
      });
    }
    // internalNote للطلبات النظامية payload خادمي قابل للتحقق؛ لا نخلط به نص الرفض.
    const newInternal = systemRequest
      ? r.internalNote
      : (r.internalNote ?? "") + noteSuffix;
    const newDescription = systemRequest
      ? `${r.description ?? "طلب دفع نظامي"}${noteSuffix}`
      : r.description;

    await tx
      .update(receipts)
      .set({
        status: "FAILED",
        approvalStatus: "REJECTED",
        approvedBy: actor.userId,
        approvedAt: occurredAt,
        internalNote: newInternal,
        description: newDescription,
      })
      .where(eq(receipts.id, receiptId));

    if (systemRequest?.kind === "EXCHANGE_IQD_DEPOSIT") {
      const [pending] = await tx
        .select()
        .from(exchangeTransactions)
        .where(eq(exchangeTransactions.id, systemRequest.transactionId))
        .for("update")
        .limit(1);
      if (
        !pending ||
        pending.status !== "PENDING_APPROVAL" ||
        Number(pending.receiptId) !== receiptId
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "طلب إيداع الصيرفة المرتبط بالرفض تغيّر",
        });
      }
      await tx
        .update(exchangeTransactions)
        .set({ status: "REVERSED" })
        .where(eq(exchangeTransactions.id, systemRequest.transactionId));
    }

    if (systemRequest?.kind === "DIGITAL_WALLET_CASH_DEPOSIT") {
      const [pending] = await tx
        .select()
        .from(digitalWalletTransactions)
        .where(eq(digitalWalletTransactions.id, systemRequest.transactionId))
        .for("update")
        .limit(1);
      if (
        !pending ||
        pending.status !== "PENDING_APPROVAL" ||
        Number(pending.receiptId) !== receiptId
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "طلب إيداع المحفظة المرتبط بالرفض تغيّر",
        });
      }
      await tx
        .update(digitalWalletTransactions)
        .set({
          status: "REVERSED",
          approvedBy: actor.userId,
          approvedAt: new Date(),
        })
        .where(eq(digitalWalletTransactions.id, systemRequest.transactionId));
    }

    return {
      receiptId,
      voucherNumber: String(r.voucherNumber),
      approvalStatus: "REJECTED" as const,
    };
  });
}

/**
 * إعادة تقديم صريحة لمحاولة دفع نظامية مرفوضة (مورد أو مصروف/أصل).
 * يبقى المصدر والسند المرفوض وسببهما للتدقيق، ويُنشأ طلب clearing واحد بلا أثر مسبق.
 * اسم التصدير القديم باقٍ لتوافق الراوتر والعملاء الحاليين.
 */
export async function resubmitRejectedExpensePayment(
  receiptId: number,
  actor: Actor,
  correction: {
    attachmentUrl?: string | null;
    note?: string | null;
    priorReceiptId: number;
    reissueReason: string;
  },
): Promise<{
  receiptId: number;
  voucherNumber: string;
  approvalStatus: "APPROVED" | "PENDING_APPROVAL" | "REJECTED";
  rootReceiptId: number;
  attempt: number;
  priorReceiptId: number;
  reissueReason: string;
  replayed: boolean;
}> {
  return withMysqlDeadlockRetry(() =>
    withTx(async (tx) => {
      const reissueReason = correction.reissueReason.trim();
      if (
        !Number.isSafeInteger(correction.priorReceiptId) ||
        correction.priorReceiptId <= 0 ||
        correction.priorReceiptId !== receiptId ||
        reissueReason.length < 5
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "إعادة إصدار طلب الدفع تتطلب السند المرفوض السابق نفسه وسبباً صريحاً من خمسة أحرف على الأقل",
        });
      }
      const [preview] = await tx
        .select()
        .from(receipts)
        .where(eq(receipts.id, receiptId))
        .limit(1);
      if (!preview || preview.branchId == null) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "محاولة الدفع النظامية المرفوضة غير موجودة",
        });
      }
      const previewRequest = parseSystemPaymentRequest(preview.internalNote);
      if (
        (isSystemPaymentReference(preview.referenceNumber) ||
          hasSystemPaymentRequestEnvelope(preview.internalNote)) &&
        (!previewRequest ||
          !isCanonicalSystemPaymentRequest(
            previewRequest,
            preview.referenceNumber,
          ))
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "طلب إعادة التقديم النظامي لا يحمل ارتباطاً canonical موثوقاً",
        });
      }
      if (previewRequest?.kind === "ACCRUAL_CORRECTION_REFUND") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "أعد طلب استرداد التصحيح من مسار تصحيح المصدر، لا من إعادة تقديم المصروف العامة",
        });
      }
      if (
        previewRequest?.kind !== "PURCHASE_SUPPLIER" &&
        previewRequest?.kind !== "PURCHASE_SUPPLIER_USD" &&
        previewRequest?.kind !== "PURCHASE_SHIPPING" &&
        previewRequest?.kind !== "ASSET_MAINTENANCE" &&
        previewRequest?.kind !== "ASSET_ACQUISITION"
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "إعادة التقديم الصريحة متاحة لطلب دفع مورد أو مصروف أو اقتناء أصل فقط",
        });
      }
      const branchId = Number(preview.branchId);
      if (
        actor.role !== "admin" &&
        actor.branchId != null &&
        Number(actor.branchId) !== branchId
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "طلب الدفع يخص فرعاً آخر",
        });
      }
      if (preview.paymentMethod === "CASH") {
        await lockCashSourceForUpdate(tx, {
          branchId,
          cashBucket: "TREASURY",
          shiftId: null,
        });
      }
      const [rejected] = await tx
        .select()
        .from(receipts)
        .where(eq(receipts.id, receiptId))
        .for("update")
        .limit(1);
      const request = parseSystemPaymentRequest(rejected?.internalNote);
      if (
        !rejected ||
        !request ||
        !isCanonicalSystemPaymentRequest(request, rejected.referenceNumber) ||
        (request?.kind !== "PURCHASE_SUPPLIER" &&
          request?.kind !== "PURCHASE_SUPPLIER_USD" &&
          request?.kind !== "PURCHASE_SHIPPING" &&
          request?.kind !== "ASSET_MAINTENANCE" &&
          request?.kind !== "ASSET_ACQUISITION") ||
        rejected.approvalStatus !== "REJECTED" ||
        rejected.status !== "FAILED" ||
        JSON.stringify(request) !== JSON.stringify(previewRequest) ||
        rejected.paymentMethod !== preview.paymentMethod ||
        !rejected.referenceNumber
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "محاولة الدفع لم تعد مرفوضة صالحة لإعادة التقديم",
        });
      }
      const lineageFamily =
        request.kind === "ASSET_ACQUISITION" ? "asset" : "expense";
      const inboundKeyRows = await tx
        .select({
          clientRequestId: idempotencyKeys.clientRequestId,
          refId: idempotencyKeys.refId,
        })
        .from(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.operation, "voucher.create"),
            eq(idempotencyKeys.refId, receiptId),
          ),
        )
        .for("update");
      const inboundLineage = inboundKeyRows
        .map((row) => ({
          row,
          parsed: parseExpensePaymentResubmitKey(row.clientRequestId),
        }))
        .filter(
          (
            item,
          ): item is typeof item & {
            parsed: NonNullable<
              ReturnType<typeof parseExpensePaymentResubmitKey>
            >;
          } => item.parsed?.family === lineageFamily,
        );
      if (inboundLineage.length > 1) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "سند إعادة إصدار الدفع مرتبط بأكثر من محاولة سابقة؛ أوقف العملية وراجع سجل التدقيق",
        });
      }
      const rootReceiptId =
        inboundLineage[0]?.parsed.rootReceiptId ?? receiptId;
      const priorAttempt = inboundLineage[0]?.parsed.attempt ?? 0;
      const lineagePrefix = `system-${lineageFamily}-resubmit-${rootReceiptId}`;
      const lineageKeyRows = await tx
        .select({
          clientRequestId: idempotencyKeys.clientRequestId,
          refId: idempotencyKeys.refId,
        })
        .from(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.operation, "voucher.create"),
            sql`${idempotencyKeys.clientRequestId} LIKE ${`${lineagePrefix}-A%`}`,
          ),
        )
        .for("update");
      const lineage = lineageKeyRows
        .map((row) => ({
          row,
          parsed: parseExpensePaymentResubmitKey(row.clientRequestId),
        }))
        .sort(
          (left, right) =>
            Number(left.parsed?.attempt ?? 0) -
            Number(right.parsed?.attempt ?? 0),
        );
      const lineageReceiptIds = lineage.map((item) => Number(item.row.refId));
      const lineageReceiptRows =
        lineageReceiptIds.length === 0
          ? []
          : await tx
              .select({ id: receipts.id, description: receipts.description })
              .from(receipts)
              .where(inArray(receipts.id, lineageReceiptIds))
              .orderBy(asc(receipts.id))
              .for("update");
      const lineageReceiptById = new Map(
        lineageReceiptRows.map((row) => [Number(row.id), row]),
      );
      const lineageIsCanonical =
        lineageReceiptRows.length === lineageReceiptIds.length &&
        lineage.every((item, index) => {
          const receipt = lineageReceiptById.get(Number(item.row.refId));
          const description = parseExpensePaymentResubmitDescription(
            receipt?.description,
          );
          const expectedPriorReceiptId =
            index === 0 ? rootReceiptId : Number(lineage[index - 1]?.row.refId);
          return (
            item.parsed?.family === lineageFamily &&
            item.parsed.rootReceiptId === rootReceiptId &&
            item.parsed.attempt === index + 1 &&
            description?.attempt === index + 1 &&
            description.priorReceiptId === expectedPriorReceiptId
          );
        });
      const selectedPriorIsCanonical =
        priorAttempt === 0
          ? rootReceiptId === receiptId
          : lineage[priorAttempt - 1]?.parsed?.attempt === priorAttempt &&
            Number(lineage[priorAttempt - 1]?.row.refId) === receiptId;
      if (!lineageIsCanonical || !selectedPriorIsCanonical) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "سلسلة محاولات إعادة إصدار الدفع غير متصلة أو غير مرتبة؛ لا يمكن إنشاء محاولة جديدة",
        });
      }
      const attempt = priorAttempt + 1;
      const clientRequestId = expensePaymentResubmitKey({
        family: lineageFamily,
        rootReceiptId,
        attempt,
      });
      if (
        request.kind === "PURCHASE_SUPPLIER" ||
        request.kind === "PURCHASE_SUPPLIER_USD"
      ) {
        if (
          !Number.isSafeInteger(request.purchaseOrderId) ||
          request.purchaseOrderId <= 0 ||
          !/^[0-9a-f]{16}$/i.test(request.requestToken) ||
          typeof request.expectedAmount !== "string" ||
          typeof request.sourceTotal !== "string" ||
          (request.kind === "PURCHASE_SUPPLIER_USD" &&
            (typeof request.sourceUsdTotal !== "string" ||
              typeof request.sourceAgreedRate !== "string")) ||
          rejected.direction !== "OUT" ||
          rejected.partyType !== "SUPPLIER" ||
          rejected.partyId == null ||
          !money(request.expectedAmount).eq(money(rejected.amount))
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "ارتباط طلب دفع المورد المرفوض غير صالح",
          });
        }
        const [purchaseOrder] = await tx
          .select()
          .from(purchaseOrders)
          .where(eq(purchaseOrders.id, request.purchaseOrderId))
          .for("update")
          .limit(1);
        if (
          !purchaseOrder ||
          Number(purchaseOrder.branchId) !== branchId ||
          Number(purchaseOrder.supplierId) !== Number(rejected.partyId) ||
          !money(purchaseOrder.total).eq(money(request.sourceTotal)) ||
          (request.kind === "PURCHASE_SUPPLIER_USD"
            ? purchaseOrder.agreedCurrency !== "USD" ||
              purchaseOrder.usdTotal == null ||
              purchaseOrder.agreedRate == null ||
              !money(purchaseOrder.usdTotal).eq(
                money(request.sourceUsdTotal),
              ) ||
              !money(purchaseOrder.agreedRate).eq(
                money(request.sourceAgreedRate),
              ) ||
              rejected.referenceNumber !==
                `PO-USD-PAY-${purchaseOrder.poNumber}-${request.requestToken}`
            : rejected.referenceNumber !==
              `PO-PAY-${purchaseOrder.poNumber}-${request.requestToken}`)
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "أمر الشراء المرتبط بطلب المورد تغيّر أو فُقد",
          });
        }

        const replacementDescription = [
          `إعادة تقديم دفعة مورد — أمر الشراء ${purchaseOrder.poNumber}`,
          correction.note?.trim(),
          expensePaymentResubmitDescriptionSuffix({
            attempt,
            priorReceiptId: receiptId,
            reissueReason,
          }),
        ]
          .filter(Boolean)
          .join(" — ");
        const replacementAttachmentUrl =
          correction.attachmentUrl?.trim() || rejected.attachmentUrl || null;
        const [existingKey] = await tx
          .select({ refId: idempotencyKeys.refId })
          .from(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.operation, "voucher.create"),
              eq(idempotencyKeys.clientRequestId, clientRequestId),
            ),
          )
          .for("update")
          .limit(1);
        if (existingKey) {
          const [replacement] = await tx
            .select()
            .from(receipts)
            .where(eq(receipts.id, Number(existingKey.refId)))
            .for("update")
            .limit(1);
          const replayableState =
            (replacement?.status === "PENDING" &&
              replacement.approvalStatus === "PENDING_APPROVAL") ||
            (replacement?.status === "FAILED" &&
              replacement.approvalStatus === "REJECTED") ||
            (replacement?.status === "COMPLETED" &&
              replacement.approvalStatus === "APPROVED");
          if (
            !replacement ||
            !replayableState ||
            replacement.voucherNumber == null ||
            Number(replacement.branchId) !== branchId ||
            replacement.direction !== "OUT" ||
            replacement.paymentMethod !== rejected.paymentMethod ||
            replacement.shiftId != null ||
            (replacement.status === "COMPLETED" &&
            replacement.paymentMethod === "CASH"
              ? replacement.cashBucket !== "TREASURY"
              : replacement.cashBucket != null) ||
            replacement.partyType !== "SUPPLIER" ||
            Number(replacement.partyId ?? 0) !== Number(rejected.partyId) ||
            replacement.referenceNumber !== rejected.referenceNumber ||
            replacement.internalNote !== rejected.internalNote ||
            replacement.description !== replacementDescription ||
            (replacement.attachmentUrl ?? null) !== replacementAttachmentUrl ||
            !money(replacement.amount).eq(money(rejected.amount))
          ) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "تعارض مفتاح إعادة تقديم دفعة المورد مع سند مختلف",
            });
          }
          return {
            receiptId: Number(replacement.id),
            voucherNumber: String(replacement.voucherNumber),
            approvalStatus: replacement.approvalStatus as
              | "APPROVED"
              | "PENDING_APPROVAL"
              | "REJECTED",
            rootReceiptId,
            attempt,
            priorReceiptId: receiptId,
            reissueReason,
            replayed: true,
          };
        }

        const latestAttempt = lineage.at(-1)?.parsed?.attempt ?? 0;
        if (latestAttempt !== priorAttempt) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "المحاولة المختارة ليست أحدث محاولة مرفوضة؛ أعد تحميل السجل قبل إعادة الإصدار",
          });
        }
        if (request.kind === "PURCHASE_SUPPLIER_USD") {
          await assertPurchaseUsdResubmissionAvailableTx(tx, rejected, request);
        } else {
          const payable = await purchaseOrderPayableBalanceTx(
            tx,
            request.purchaseOrderId,
          );
          const pending = await pendingPurchaseSupplierPaymentsTx(
            tx,
            String(purchaseOrder.poNumber),
          );
          const available = payable.minus(pending);
          if (money(rejected.amount).gt(available)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `لم يعد على أمر الشراء رصيد متاح كافٍ لإعادة الطلب (${available.toFixed(2)})`,
            });
          }
          if (request.liabilityAccount !== "CASH_CLEARING") {
            const [supplier] = await tx
              .select({ currentBalance: suppliers.currentBalance })
              .from(suppliers)
              .where(eq(suppliers.id, Number(rejected.partyId)))
              .for("update")
              .limit(1);
            if (
              !supplier ||
              money(rejected.amount).gt(money(supplier.currentBalance ?? "0"))
            ) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message:
                  "لم يعد رصيد المورد الحالي كافياً لإعادة طلب الدفع — راجع الكشف",
              });
            }
          }
        }
        const replacement = await createSystemPaymentRequestTx(
          tx,
          {
            branchId,
            amount: toDbMoney(rejected.amount),
            paymentMethod: rejected.paymentMethod as PaymentMethod,
            checkNumber: rejected.checkNumber,
            cardLastFour: rejected.cardLastFour,
            partyType: "SUPPLIER",
            partyId: Number(rejected.partyId),
            description: replacementDescription,
            referenceNumber: rejected.referenceNumber,
            attachmentUrl: replacementAttachmentUrl,
            voucherDate: toDateStr(),
            clientRequestId,
          },
          actor,
          request,
        );
        return {
          receiptId: replacement.receiptId,
          voucherNumber: replacement.voucherNumber,
          approvalStatus: replacement.approvalStatus,
          rootReceiptId,
          attempt,
          priorReceiptId: receiptId,
          reissueReason,
          replayed: false,
        };
      }
      const rejectedAccrualObligation =
        await assertAccrualSettlementReceiptBindingTx(tx, rejected, request, [
          "ACCRUED_UNPAID",
          "PAYMENT_PENDING",
          "PAID",
        ]);
      const existingReplacement = async (
        expectedDescription: string,
        expectedAttachmentUrl: string | null,
      ) => {
        const [key] = await tx
          .select({ refId: idempotencyKeys.refId })
          .from(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.operation, "voucher.create"),
              eq(idempotencyKeys.clientRequestId, clientRequestId),
            ),
          )
          .for("update")
          .limit(1);
        if (!key) return null;
        const [replacement] = await tx
          .select()
          .from(receipts)
          .where(eq(receipts.id, Number(key.refId)))
          .for("update")
          .limit(1);
        if (!replacement) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "مرجع إعادة تقديم الدفع موجود لكن سنده مفقود — أوقف العملية وراجع التدقيق",
          });
        }
        const expectedObligationStatus =
          replacement.status === "PENDING" &&
          replacement.approvalStatus === "PENDING_APPROVAL"
            ? "PAYMENT_PENDING"
            : replacement.status === "FAILED" &&
                replacement.approvalStatus === "REJECTED"
              ? "ACCRUED_UNPAID"
              : replacement.status === "COMPLETED" &&
                  replacement.approvalStatus === "APPROVED"
                ? "PAID"
                : null;
        if (!expectedObligationStatus) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "محاولة إعادة إصدار الدفع انتهت بحالة لا تسمح بإعادة التشغيل أو إصدار محاولة ضمنية",
          });
        }
        const fundingStateMatches =
          expectedObligationStatus === "PAID"
            ? replacement.shiftId == null &&
              (replacement.paymentMethod === "CASH"
                ? replacement.cashBucket === "TREASURY"
                : replacement.cashBucket == null)
            : replacement.shiftId == null && replacement.cashBucket == null;
        if (
          Number(replacement.branchId) !== branchId ||
          replacement.direction !== "OUT" ||
          replacement.paymentMethod !== rejected.paymentMethod ||
          !fundingStateMatches ||
          (replacement.checkNumber ?? null) !==
            (rejected.checkNumber ?? null) ||
          (replacement.cardLastFour ?? null) !==
            (rejected.cardLastFour ?? null) ||
          replacement.partyType !== "OTHER" ||
          replacement.referenceNumber !== rejected.referenceNumber ||
          replacement.internalNote !== rejected.internalNote ||
          replacement.description !== expectedDescription ||
          (replacement.attachmentUrl ?? null) !== expectedAttachmentUrl ||
          !money(replacement.amount).eq(money(rejected.amount))
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعارض مفتاح إعادة التقديم مع سند دفع مختلف",
          });
        }
        await assertAccrualSettlementReceiptBindingTx(
          tx,
          replacement,
          request,
          expectedObligationStatus,
        );
        return {
          receiptId: Number(replacement.id),
          voucherNumber: String(replacement.voucherNumber ?? ""),
          approvalStatus: replacement.approvalStatus as
            | "APPROVED"
            | "PENDING_APPROVAL"
            | "REJECTED",
          rootReceiptId,
          attempt,
          priorReceiptId: receiptId,
          reissueReason,
          replayed: true,
        };
      };

      if (request.kind === "ASSET_ACQUISITION") {
        const [asset] = await tx
          .select()
          .from(fixedAssets)
          .where(eq(fixedAssets.id, request.assetId))
          .for("update")
          .limit(1);
        const accruals = await tx
          .select({
            entryType: accountingEntries.entryType,
            branchId: accountingEntries.branchId,
            receiptId: accountingEntries.receiptId,
            amount: accountingEntries.amount,
            postingProfile: accountingEntries.postingProfile,
          })
          .from(accountingEntries)
          .where(
            eq(accountingEntries.dedupeKey, `ASSET_ACCRUAL:${request.assetId}`),
          )
          .for("update")
          .limit(2);
        const accrual = accruals[0];
        if (
          !asset ||
          asset.status === "disposed" ||
          asset.status === "retired" ||
          asset.isActive !== true ||
          asset.supplierId != null ||
          Number(asset.branchId) !== branchId ||
          rejected.referenceNumber !== `ASSET-ACQ-${request.assetId}` ||
          !money(asset.purchaseValue).eq(money(rejected.amount)) ||
          accruals.length !== 1 ||
          !accrual ||
          accrual.entryType !== "ADJUST" ||
          accrual.receiptId != null ||
          Number(accrual.branchId) !== branchId ||
          !money(accrual.amount).eq(money(rejected.amount)) ||
          (accrual.postingProfile != null &&
            accrual.postingProfile !== "ADJUST_FIXED_ASSET_ACCRUAL")
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "الأصل أو قيد التزام اقتنائه تغيّر؛ لا يمكن إعادة تقديم الدفع قبل المراجعة",
          });
        }
        const replacementDescription = [
          `إعادة تقديم تسوية التزام اقتناء الأصل ${asset.code}`,
          correction.note?.trim(),
          expensePaymentResubmitDescriptionSuffix({
            attempt,
            priorReceiptId: receiptId,
            reissueReason,
          }),
        ]
          .filter(Boolean)
          .join(" — ");
        const replacementAttachmentUrl =
          correction.attachmentUrl?.trim() || rejected.attachmentUrl || null;
        const replay = await existingReplacement(
          replacementDescription,
          replacementAttachmentUrl,
        );
        if (replay) return replay;
        const latestAttempt = lineage.at(-1)?.parsed?.attempt ?? 0;
        if (latestAttempt !== priorAttempt) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "المحاولة المختارة ليست أحدث محاولة مرفوضة؛ أعد تحميل السجل قبل إعادة الإصدار",
          });
        }
        if (rejectedAccrualObligation.status !== "ACCRUED_UNPAID") {
          throw new TRPCError({
            code: "CONFLICT",
            message: "التزام اقتناء الأصل مرتبط بمحاولة دفع أخرى",
          });
        }
        const replacement = await createSystemPaymentRequestTx(
          tx,
          {
            branchId,
            amount: toDbMoney(rejected.amount),
            paymentMethod: rejected.paymentMethod as PaymentMethod,
            checkNumber: rejected.checkNumber,
            cardLastFour: rejected.cardLastFour,
            partyType: "OTHER",
            counterpartyName: rejected.counterpartyName?.trim() || asset.name,
            description: replacementDescription,
            referenceNumber: rejected.referenceNumber,
            attachmentUrl: replacementAttachmentUrl,
            voucherDate: toDateStr(),
            clientRequestId,
          },
          actor,
          request,
        );
        await transitionAccrualObligationTx(tx, {
          obligationId: Number(rejectedAccrualObligation.id),
          expectedStatus: "ACCRUED_UNPAID",
          nextStatus: "PAYMENT_PENDING",
          eventType: "PAYMENT_REQUESTED",
          actorId: actor.userId,
          receiptId: replacement.receiptId,
          evidenceReference: request.sourceEvidenceReference,
          dedupeKey: `ACCRUAL:PAYMENT_RESUBMITTED:${rejectedAccrualObligation.id}:${replacement.receiptId}`,
        });
        return {
          receiptId: replacement.receiptId,
          voucherNumber: replacement.voucherNumber,
          approvalStatus: replacement.approvalStatus,
          rootReceiptId,
          attempt,
          priorReceiptId: receiptId,
          reissueReason,
          replayed: false,
        };
      }

      if (rejectedAccrualObligation.expenseId == null) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "استحقاق المصروف لا يحمل رابط مصدر مثبتاً",
        });
      }
      const expenseMatches = await tx
        .select()
        .from(expenses)
        .where(eq(expenses.id, Number(rejectedAccrualObligation.expenseId)))
        .for("update")
        .limit(2);
      const expense = expenseMatches[0];
      if (
        expenseMatches.length !== 1 ||
        !expense ||
        expense.status !== "ACTIVE" ||
        Number(expense.branchId) !== branchId ||
        !money(expense.amount).eq(money(rejected.amount)) ||
        expense.referenceNumber !== rejected.referenceNumber
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "استحقاق المصروف المرتبط بالطلب مفقود أو تغيّر",
        });
      }
      const isShipping = request.kind === "PURCHASE_SHIPPING";
      const replacementDescription = [
        isShipping
          ? "إعادة تقديم تسوية مصروف شحن/كمرك"
          : "إعادة تقديم تسوية مصروف صيانة أصل",
        correction.note?.trim(),
        expensePaymentResubmitDescriptionSuffix({
          attempt,
          priorReceiptId: receiptId,
          reissueReason,
        }),
      ]
        .filter(Boolean)
        .join(" — ");
      const replacementAttachmentUrl =
        correction.attachmentUrl?.trim() || rejected.attachmentUrl || null;
      const replay = await existingReplacement(
        replacementDescription,
        replacementAttachmentUrl,
      );
      if (replay) return replay;
      const latestAttempt = lineage.at(-1)?.parsed?.attempt ?? 0;
      if (latestAttempt !== priorAttempt) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "المحاولة المختارة ليست أحدث محاولة مرفوضة؛ أعد تحميل السجل قبل إعادة الإصدار",
        });
      }
      if (rejectedAccrualObligation.status !== "ACCRUED_UNPAID") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "استحقاق المصروف مرتبط بمحاولة دفع أخرى",
        });
      }
      const replacement = await createSystemPaymentRequestTx(
        tx,
        {
          branchId,
          amount: toDbMoney(rejected.amount),
          paymentMethod: rejected.paymentMethod as PaymentMethod,
          checkNumber: rejected.checkNumber,
          cardLastFour: rejected.cardLastFour,
          partyType: "OTHER",
          counterpartyName:
            rejected.counterpartyName?.trim() ||
            (isShipping ? "شركة النقل/الكمرك" : "جهة صيانة الأصل"),
          description: replacementDescription,
          referenceNumber: rejected.referenceNumber,
          attachmentUrl: replacementAttachmentUrl,
          voucherDate: toDateStr(),
          clientRequestId,
        },
        actor,
        request,
      );
      await transitionAccrualObligationTx(tx, {
        obligationId: Number(rejectedAccrualObligation.id),
        expectedStatus: "ACCRUED_UNPAID",
        nextStatus: "PAYMENT_PENDING",
        eventType: "PAYMENT_REQUESTED",
        actorId: actor.userId,
        receiptId: replacement.receiptId,
        evidenceReference: request.sourceEvidenceReference,
        dedupeKey: `ACCRUAL:PAYMENT_RESUBMITTED:${rejectedAccrualObligation.id}:${replacement.receiptId}`,
      });
      return {
        receiptId: replacement.receiptId,
        voucherNumber: replacement.voucherNumber,
        approvalStatus: replacement.approvalStatus,
        rootReceiptId,
        attempt,
        priorReceiptId: receiptId,
        reissueReason,
        replayed: false,
      };
    }),
  );
}
