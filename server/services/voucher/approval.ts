// اعتماد/رفض سند مُعلَّق (Maker-Checker، SOD-04: مالك نشط والمُعتمِد ≠ المُنشئ بلا استثناء).
import { TRPCError } from "@trpc/server";
import { and, desc, eq, like, ne, or } from "drizzle-orm";
import {
  accountingEntries,
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
import { extractInsertId } from "../../lib/insertId";
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
import {
  createSystemPaymentRequestTx,
  isSystemPaymentReference,
  parseSystemPaymentRequest,
  type AssetFinancialSnapshot,
} from "./create";
import { computeDepreciation } from "../assets/depreciation";

function dbDate(value: unknown): string {
  if (value instanceof Date) return toDateStr(value);
  return String(value ?? "").slice(0, 10);
}

function assetFinancialSnapshot(asset: typeof fixedAssets.$inferSelect): AssetFinancialSnapshot {
  return {
    branchId: asset.branchId == null ? null : Number(asset.branchId),
    supplierId: asset.supplierId == null ? null : Number(asset.supplierId),
    purchaseDate: dbDate(asset.purchaseDate),
    purchaseValue: money(asset.purchaseValue).toFixed(2),
    salvageValue: money(asset.salvageValue).toFixed(2),
    usefulLifeYears: Number(asset.usefulLifeYears),
    depreciationMethod: asset.depreciationMethod as "sl" | "db",
    accumulatedDepreciation: money(asset.accumulatedDepreciation).toFixed(2),
  };
}

function sameAssetFinancialSnapshot(
  actual: AssetFinancialSnapshot,
  expected: AssetFinancialSnapshot,
): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
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
    let prelockedExchangeHouse: typeof exchangeHouses.$inferSelect | null = null;
    let prelockedDigitalWallet: typeof digitalWallets.$inferSelect | null = null;
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
        // إعادة اقتناء أصل قد تعكس CASH في فرع المصدر ثم تصرف من فرع الهدف.
        // كلا الحسابين يجب أن يُقفلا قبل asset/receipt وبترتيب هوية ثابت؛ قفل الهدف
        // وحده يصنع دورة target→source مقابل cash transfer source→target.
        const disbursementBranchIds = systemRequestPreview?.kind === "ASSET_REACQUISITION"
          ? [source.branchId, systemRequestPreview.source.branchId]
              .filter((id): id is number => id != null)
          : [source.branchId];
        externalTreasuryApproval = await authorizeExternalTreasuryDisbursement(tx, {
          actor,
          makerUserIds: [preview.createdBy, cancellationOriginalPreview?.createdBy],
          branchIds: disbursementBranchIds,
          operation: cancellationOriginalPreview ? "اعتماد إلغاء سند قبض نقدي" : "اعتماد سند الصرف النقدي",
        });
        if (systemRequestPreview?.kind === "EXCHANGE_IQD_DEPOSIT") {
          [prelockedExchangeHouse] = await tx
            .select()
            .from(exchangeHouses)
            .where(eq(exchangeHouses.id, systemRequestPreview.exchangeHouseId))
            .for("update")
            .limit(1);
          if (!prelockedExchangeHouse) {
            throw new TRPCError({ code: "CONFLICT", message: "الصيرفة المرتبطة بطلب الإيداع مفقودة" });
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
            throw new TRPCError({ code: "CONFLICT", message: "المحفظة المرتبطة بطلب الإيداع مفقودة" });
          }
        }
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
    let systemAsset: typeof fixedAssets.$inferSelect | null = null;
    let systemExchangeTxn: typeof exchangeTransactions.$inferSelect | null = null;
    let systemWalletTxn: typeof digitalWalletTransactions.$inferSelect | null = null;
    let systemRecognizedExpense: typeof expenses.$inferSelect | null = null;

    if (systemRequest?.kind === "VOUCHER_CANCELLATION") {
      if (r.referenceNumber !== `CANCEL-VCH-${systemRequest.originalReceiptId}`) {
        throw new TRPCError({ code: "CONFLICT", message: "مرجع طلب إلغاء القبض غير متطابق" });
      }
    } else if (systemRequest?.kind === "TERMINATION_SETTLEMENT") {
      if (
        !Number.isInteger(systemRequest.terminationId) ||
        systemRequest.terminationId <= 0 ||
        !Number.isInteger(systemRequest.employeeId) ||
        systemRequest.employeeId <= 0 ||
        typeof systemRequest.expectedAmount !== "string" ||
        r.referenceNumber !== `TERM-SETTLEMENT-${systemRequest.terminationId}`
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
        !money(termination.settlement).eq(amount) ||
        !money(systemRequest.expectedAmount).eq(amount)
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "تغيّر سجل إنهاء الخدمة أو مبلغ تسويته — أوقف الصرف وراجع الموارد البشرية",
        });
      }
      const [alreadyPaid] = await tx
        .select({ id: receipts.id })
        .from(receipts)
        .where(
          and(
            eq(receipts.referenceNumber, `TERM-SETTLEMENT-${systemRequest.terminationId}`),
            ne(receipts.id, receiptId),
            eq(receipts.direction, "OUT"),
            eq(receipts.status, "COMPLETED"),
            eq(receipts.approvalStatus, "APPROVED"),
          ),
        )
        .for("update")
        .limit(1);
      if (alreadyPaid) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "تسوية نهاية الخدمة مصروفة مسبقاً بسند آخر — مُنع الصرف المكرر",
        });
      }
    } else if (
      systemRequest?.kind === "ASSET_ACQUISITION" ||
      systemRequest?.kind === "ASSET_REACQUISITION" ||
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
        throw new TRPCError({ code: "CONFLICT", message: "الأصل المرتبط بطلب الدفع تغيّر أو لم يعد صالحاً" });
      }
      if (systemRequest.kind === "ASSET_ACQUISITION") {
        if (
          Number(systemAsset.branchId) !== branchId ||
          systemAsset.supplierId != null ||
          systemAsset.isActive !== false ||
          r.referenceNumber !== `ASSET-ACQ-${assetId}` ||
          !money(systemAsset.purchaseValue).eq(amount)
        ) {
          throw new TRPCError({ code: "CONFLICT", message: "طلب اقتناء الأصل لا يطابق الأصل الحالي" });
        }
      } else if (systemRequest.kind === "ASSET_REACQUISITION") {
        if (
          !Number.isInteger(systemRequest.sequence) || systemRequest.sequence <= 0 ||
          r.referenceNumber !== `ASSET-REACQ-${assetId}-${systemRequest.sequence}` ||
          !sameAssetFinancialSnapshot(assetFinancialSnapshot(systemAsset), systemRequest.source) ||
          systemRequest.target.supplierId !== null ||
          Number(systemRequest.target.branchId) !== branchId ||
          !money(systemRequest.target.purchaseValue).eq(amount)
        ) {
          throw new TRPCError({ code: "CONFLICT", message: "طلب إعادة اقتناء الأصل لا يطابق الأصل الحالي" });
        }
      } else {
        if (Number(systemAsset.branchId) !== branchId || systemAsset.isActive === false) {
          throw new TRPCError({ code: "CONFLICT", message: "الأصل غير نافذ أو انتقل من فرع طلب الصيانة" });
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
          throw new TRPCError({ code: "CONFLICT", message: "طلب دفع الصيانة لا يطابق سجل الصيانة" });
        }
        [systemRecognizedExpense] = await tx
          .select()
          .from(expenses)
          .where(eq(expenses.receiptId, receiptId))
          .for("update")
          .limit(1);
        const [recognitionEntry] = await tx
          .select({ id: accountingEntries.id, amount: accountingEntries.amount, entryType: accountingEntries.entryType })
          .from(accountingEntries)
          .where(eq(accountingEntries.dedupeKey, `ASSET_MAINT_ACCRUAL:${systemRequest.maintenanceId}`))
          .limit(1);
        if (
          !systemRecognizedExpense || systemRecognizedExpense.status !== "ACTIVE" ||
          Number(systemRecognizedExpense.branchId) !== branchId ||
          systemRecognizedExpense.category !== "MAINTENANCE" ||
          systemRecognizedExpense.paymentMethod !== "CASH" ||
          systemRecognizedExpense.cashBucket !== "TREASURY" ||
          !money(systemRecognizedExpense.amount).eq(amount) ||
          !recognitionEntry || recognitionEntry.entryType !== "PAYMENT_OUT" ||
          !money(recognitionEntry.amount).eq(amount)
        ) {
          throw new TRPCError({ code: "CONFLICT", message: "استحقاق الصيانة المرتبط بطلب الدفع مفقود أو تغيّر" });
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
        Number(systemExchangeTxn.exchangeHouseId) !== systemRequest.exchangeHouseId ||
        Number(systemExchangeTxn.branchId) !== branchId ||
        systemExchangeTxn.type !== "DEPOSIT" ||
        systemExchangeTxn.currency !== "IQD" ||
        systemExchangeTxn.status !== "PENDING_APPROVAL" ||
        Number(systemExchangeTxn.receiptId) !== receiptId ||
        Number(systemExchangeTxn.createdBy ?? 0) !== Number(r.createdBy ?? 0) ||
        r.referenceNumber !== `EXCHANGE-IQD-DEP-${systemRequest.transactionId}` ||
        typeof systemRequest.expectedAmount !== "string" ||
        !money(systemRequest.expectedAmount).eq(amount) ||
        !money(systemExchangeTxn.iqdAmount).eq(amount)
      ) {
        throw new TRPCError({ code: "CONFLICT", message: "طلب إيداع الصيرفة تغيّر أو لم يعد صالحاً" });
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
        r.referenceNumber !== `DIGITAL-WALLET-DEP-${systemRequest.transactionId}` ||
        typeof systemRequest.expectedAmount !== "string" ||
        !money(systemRequest.expectedAmount).eq(amount) ||
        !money(systemWalletTxn.amount).eq(amount)
      ) {
        throw new TRPCError({ code: "CONFLICT", message: "طلب إيداع المحفظة تغيّر أو لم يعد صالحاً" });
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
      if (systemRequest.kind === "PURCHASE_SHIPPING") {
        [systemRecognizedExpense] = await tx
          .select()
          .from(expenses)
          .where(eq(expenses.receiptId, receiptId))
          .for("update")
          .limit(1);
        const [recognitionEntry] = await tx
          .select({
            id: accountingEntries.id,
            amount: accountingEntries.amount,
            entryType: accountingEntries.entryType,
            purchaseOrderId: accountingEntries.purchaseOrderId,
          })
          .from(accountingEntries)
          .where(eq(
            accountingEntries.dedupeKey,
            `PURCHASE_SHIPPING_ACCRUAL:${systemRequest.purchaseOrderId}:${systemRequest.requestToken}`,
          ))
          .limit(1);
        if (
          !systemRecognizedExpense ||
          systemRecognizedExpense.status !== "ACTIVE" ||
          Number(systemRecognizedExpense.branchId) !== branchId ||
          systemRecognizedExpense.category !== "TRANSPORT" ||
          systemRecognizedExpense.paymentMethod !== "CASH" ||
          systemRecognizedExpense.cashBucket !== "TREASURY" ||
          !money(systemRecognizedExpense.amount).eq(amount) ||
          !recognitionEntry ||
          recognitionEntry.entryType !== "PAYMENT_OUT" ||
          Number(recognitionEntry.purchaseOrderId) !== systemRequest.purchaseOrderId ||
          !money(recognitionEntry.amount).eq(amount)
        ) {
          throw new TRPCError({ code: "CONFLICT", message: "استحقاق الشحن المرتبط بطلب الدفع مفقود أو تغيّر" });
        }
      }
      if (
        systemRequest.kind === "PURCHASE_SUPPLIER" &&
        money(systemPurchaseOrder.paidAmount).plus(amount).gt(money(systemPurchaseOrder.total))
      ) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "دفعة المورد المعلّقة تتجاوز المتبقي على أمر الشراء" });
      }
    }

    // كل دفعة مورد تعيد فحص AP الحالي تحت القفل؛ مرتجع أو دفعة أخرى بين الطلب
    // والاعتماد قد تخفض المستحق لأي مورد، لا المودِع فقط.
    if (partyType === "SUPPLIER" && partyId != null && direction === "OUT") {
      const [sup] = await tx.select({ kind: suppliers.supplierKind, bal: suppliers.currentBalance })
        .from(suppliers).where(eq(suppliers.id, partyId)).for("update").limit(1);
      if (!sup) {
        throw new TRPCError({ code: "CONFLICT", message: "المورد المرتبط بسند الصرف مفقود" });
      }
      if (money(sup.bal ?? "0").lt(amount)) {
        const label = sup.kind === "CONSIGNOR" ? "مستحقّ المودِع" : "الرصيد المستحق للمورد";
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `${label} (${money(sup.bal ?? "0").toFixed(2)}) أقلّ من مبلغ الصرف — أعد الطلب بعد مراجعة الكشف`,
        });
      }
    }

    // في تصحيح تمويل أصلٍ نقدي، ساق IN التعويضية يجب أن تسبق الحارس كي يرى
    // الرصيد الصافي الحقيقي. كل ذلك في tx نفسها؛ أي نقص لاحق يرجع AP/receipts/ledger معاً.
    if (systemRequest?.kind === "ASSET_REACQUISITION" && systemAsset) {
      const sourceValue = money(systemRequest.source.purchaseValue);
      if (sourceValue.gt(0) && systemRequest.source.supplierId != null) {
        await adjustSupplierBalance(tx, systemRequest.source.supplierId, sourceValue.neg());
        await postEntry(tx, {
          entryType: "PURCHASE",
          branchId: systemRequest.source.branchId,
          supplierId: systemRequest.source.supplierId,
          cost: sourceValue.neg(),
          amount: sourceValue.neg(),
          dedupeKey: `ASSET_ACQREV:${systemRequest.assetId}:${systemRequest.sequence}`,
          notes: `عكس اقتناء أصل ${systemAsset.code} عند اعتماد تحويل التمويل إلى نقد`,
        });
      } else if (sourceValue.gt(0)) {
        const [oldCashReceipt] = await tx
          .select()
          .from(receipts)
          .where(and(
            ne(receipts.id, receiptId),
            eq(receipts.direction, "OUT"),
            eq(receipts.paymentMethod, "CASH"),
            eq(receipts.approvalStatus, "APPROVED"),
            or(
              eq(receipts.referenceNumber, `ASSET-ACQ-${systemRequest.assetId}`),
              like(receipts.referenceNumber, `ASSET-REACQ-${systemRequest.assetId}-%`),
            ),
          ))
          .orderBy(desc(receipts.id))
          .for("update")
          .limit(1);
        if (!oldCashReceipt || oldCashReceipt.status !== "COMPLETED" || systemRequest.source.branchId == null) {
          throw new TRPCError({ code: "CONFLICT", message: "إيصال الاقتناء النقدي السابق مفقود أو معكوس" });
        }
        await tx.update(receipts).set({ status: "REVERSED" }).where(eq(receipts.id, Number(oldCashReceipt.id)));
        const compensation = await tx.insert(receipts).values({
          branchId: systemRequest.source.branchId,
          shiftId: null,
          cashBucket: "TREASURY",
          direction: "IN",
          amount: toDbMoney(sourceValue),
          paymentMethod: "CASH",
          status: "COMPLETED",
          approvalStatus: "APPROVED",
          referenceNumber: `ASSET-REACQ-REV-${systemRequest.assetId}-${systemRequest.sequence}`,
          description: `عكس اقتناء نقدي سابق للأصل ${systemAsset.code}`,
          createdBy: actor.userId,
        });
        await postEntry(tx, {
          entryType: "PAYMENT_OUT",
          branchId: systemRequest.source.branchId,
          receiptId: extractInsertId(compensation),
          amount: sourceValue.neg(),
          dedupeKey: `ASSET_ACQREV:${systemRequest.assetId}:${systemRequest.sequence}`,
          notes: `عكس اقتناء أصل نقدي ${systemAsset.code} عند اعتماد التحويل`,
        });
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

    if (systemRequest?.kind === "ASSET_ACQUISITION" && systemAsset) {
      await tx.update(fixedAssets).set({ isActive: true }).where(eq(fixedAssets.id, systemRequest.assetId));
    }

    if (systemRequest?.kind === "ASSET_REACQUISITION" && systemAsset) {
      let targetAccumulated = money(systemRequest.source.accumulatedDepreciation);
      const depreciationInputsChanged =
        !money(systemRequest.source.purchaseValue).eq(money(systemRequest.target.purchaseValue)) ||
        !money(systemRequest.source.salvageValue).eq(money(systemRequest.target.salvageValue)) ||
        systemRequest.source.purchaseDate !== systemRequest.target.purchaseDate ||
        systemRequest.source.usefulLifeYears !== systemRequest.target.usefulLifeYears ||
        systemRequest.source.depreciationMethod !== systemRequest.target.depreciationMethod;
      if (targetAccumulated.gt(0) && depreciationInputsChanged) {
        const corrected = money(computeDepreciation({
          purchaseValue: systemRequest.target.purchaseValue,
          salvageValue: systemRequest.target.salvageValue,
          usefulLifeYears: systemRequest.target.usefulLifeYears,
          depreciationMethod: systemRequest.target.depreciationMethod,
          purchaseDate: systemRequest.target.purchaseDate,
          status: systemAsset.status,
        }, new Date()).accumulated);
        const delta = corrected.minus(targetAccumulated);
        if (!delta.isZero()) {
          await postEntry(tx, {
            entryType: "ADJUST",
            branchId: systemRequest.target.branchId,
            cost: delta,
            profit: delta.neg(),
            amount: delta,
            dedupeKey: `DEPR_ADJ:${systemRequest.assetId}:APPROVAL:${systemRequest.sequence}`,
            notes: `تصحيح إهلاك متراكم عند اعتماد تعديل الأصل ${systemAsset.code}`,
          });
        }
        targetAccumulated = corrected;
      }
      await tx.update(fixedAssets).set({
        branchId: systemRequest.target.branchId,
        supplierId: null,
        purchaseDate: systemRequest.target.purchaseDate,
        purchaseValue: toDbMoney(systemRequest.target.purchaseValue),
        salvageValue: toDbMoney(systemRequest.target.salvageValue),
        usefulLifeYears: systemRequest.target.usefulLifeYears,
        depreciationMethod: systemRequest.target.depreciationMethod,
        accumulatedDepreciation: toDbMoney(targetAccumulated),
        isActive: true,
      }).where(eq(fixedAssets.id, systemRequest.assetId));
    }

    if (systemRequest?.kind === "EXCHANGE_IQD_DEPOSIT" && systemExchangeTxn && prelockedExchangeHouse) {
      const nextIqd = money(prelockedExchangeHouse.balanceIqd).plus(amount);
      await tx.update(exchangeHouses)
        .set({ balanceIqd: toDbMoney(nextIqd) })
        .where(eq(exchangeHouses.id, systemRequest.exchangeHouseId));
      await tx.update(exchangeTransactions).set({
        status: "ACTIVE",
        balanceIqdAfter: toDbMoney(nextIqd),
        balanceUsdAfter: toDbMoney(money(prelockedExchangeHouse.balanceUsd)),
      }).where(eq(exchangeTransactions.id, systemRequest.transactionId));
      await postEntry(tx, {
        entryType: "EXCHANGE_DEPOSIT",
        branchId,
        exchangeHouseId: systemRequest.exchangeHouseId,
        receiptId,
        amount,
        revenue: money(0),
        cost: money(0),
        profit: money(0),
        dedupeKey: `EXDEP:${systemExchangeTxn.txnNumber}`,
        notes: systemExchangeTxn.notes ?? undefined,
        createdBy: actor.userId,
      });
    }

    if (systemRequest?.kind === "DIGITAL_WALLET_CASH_DEPOSIT" && systemWalletTxn && prelockedDigitalWallet) {
      const next = money(prelockedDigitalWallet.currentBalance).plus(amount);
      await tx.update(digitalWallets)
        .set({ currentBalance: toDbMoney(next) })
        .where(eq(digitalWallets.id, systemRequest.walletId));
      await tx.update(digitalWalletTransactions).set({
        status: "ACTIVE",
        balanceAfter: toDbMoney(next),
        approvedBy: actor.userId,
        approvedAt: new Date(),
      }).where(eq(digitalWalletTransactions.id, systemRequest.transactionId));
      await postEntry(tx, {
        entryType: "DIGITAL_WALLET_DEPOSIT",
        branchId,
        receiptId,
        digitalWalletId: systemRequest.walletId,
        amount,
        revenue: money(0),
        cost: money(0),
        profit: money(0),
        dedupeKey: `DIGITAL:WDEP:${systemRequest.transactionId}`,
        notes: "إيداع رصيد محفظة كروت بعد اعتماد المالك",
        createdBy: actor.userId,
      });
    }

    // الأثر المالي:
    const specializedAssetMovement =
      systemRequest?.kind === "PURCHASE_SHIPPING" ||
      systemRequest?.kind === "ASSET_MAINTENANCE" ||
      systemRequest?.kind === "EXCHANGE_IQD_DEPOSIT" ||
      systemRequest?.kind === "DIGITAL_WALLET_CASH_DEPOSIT";
    if (!specializedAssetMovement) {
      await postEntry(tx, {
        entryType: direction === "IN" ? "PAYMENT_IN" : "PAYMENT_OUT",
        branchId,
        receiptId,
        customerId: partyType === "CUSTOMER" ? partyId : null,
        supplierId: partyType === "SUPPLIER" ? partyId : null,
        purchaseOrderId: systemPurchaseOrder ? Number(systemPurchaseOrder.id) : null,
        amount,
        dedupeKey:
          systemRequest?.kind === "ASSET_ACQUISITION"
            ? `ASSET_ACQ:${systemRequest.assetId}`
            : systemRequest?.kind === "ASSET_REACQUISITION"
              ? `ASSET_REACQ:${systemRequest.assetId}:${systemRequest.sequence}`
              : undefined,
        notes:
          cancellationOriginal
            ? `إلغاء سند ${cancellationOriginal.voucherNumber}`
            : systemRequest?.kind === "ASSET_ACQUISITION"
              ? `اقتناء أصل نقدي ${systemAsset?.code ?? systemRequest.assetId}`
              : systemRequest?.kind === "ASSET_REACQUISITION"
                ? `إعادة اقتناء أصل نقدي ${systemAsset?.code ?? systemRequest.assetId}`
                : undefined,
        // قفل الفترة على تاريخ السند الفعلي لا لحظة الاعتماد.
        entryDate: new Date(r.voucherDate ? toDateStr(new Date(r.voucherDate)) : toDateStr()),
      });
    }
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
    const systemRequest = parseSystemPaymentRequest(r.internalNote);
    // internalNote للطلبات النظامية payload خادمي قابل للتحقق؛ لا نخلط به نص الرفض.
    const newInternal = systemRequest ? r.internalNote : (r.internalNote ?? "") + noteSuffix;
    const newDescription = systemRequest
      ? `${r.description ?? "طلب دفع نظامي"}${noteSuffix}`
      : r.description;

    await tx.update(receipts).set({
      status: "FAILED",
      approvalStatus: "REJECTED",
      approvedBy: actor.userId,
      approvedAt: new Date(),
      internalNote: newInternal,
      description: newDescription,
    }).where(eq(receipts.id, receiptId));

    if (systemRequest?.kind === "EXCHANGE_IQD_DEPOSIT") {
      const [pending] = await tx.select()
        .from(exchangeTransactions)
        .where(eq(exchangeTransactions.id, systemRequest.transactionId))
        .for("update")
        .limit(1);
      if (
        !pending || pending.status !== "PENDING_APPROVAL" ||
        Number(pending.receiptId) !== receiptId
      ) {
        throw new TRPCError({ code: "CONFLICT", message: "طلب إيداع الصيرفة المرتبط بالرفض تغيّر" });
      }
      await tx.update(exchangeTransactions)
        .set({ status: "REVERSED" })
        .where(eq(exchangeTransactions.id, systemRequest.transactionId));
    }

    if (systemRequest?.kind === "DIGITAL_WALLET_CASH_DEPOSIT") {
      const [pending] = await tx.select()
        .from(digitalWalletTransactions)
        .where(eq(digitalWalletTransactions.id, systemRequest.transactionId))
        .for("update")
        .limit(1);
      if (
        !pending || pending.status !== "PENDING_APPROVAL" ||
        Number(pending.receiptId) !== receiptId
      ) {
        throw new TRPCError({ code: "CONFLICT", message: "طلب إيداع المحفظة المرتبط بالرفض تغيّر" });
      }
      await tx.update(digitalWalletTransactions).set({
        status: "REVERSED",
        approvedBy: actor.userId,
        approvedAt: new Date(),
      }).where(eq(digitalWalletTransactions.id, systemRequest.transactionId));
    }

    return {
      receiptId,
      voucherNumber: String(r.voucherNumber),
      approvalStatus: "REJECTED" as const,
    };
  });
}

/**
 * إعادة تقديم صريحة لمحاولة دفع نظامية مرفوضة (مصروف أو تسوية نهاية خدمة).
 * يبقى المصدر والسند المرفوض وسببهما للتدقيق، ويُنشأ طلب clearing واحد بلا أثر مسبق.
 * اسم التصدير القديم باقٍ لتوافق الراوتر والعملاء الحاليين.
 */
export async function resubmitRejectedExpensePayment(
  receiptId: number,
  actor: Actor,
  correction?: { attachmentUrl?: string | null; note?: string | null },
): Promise<{
  receiptId: number;
  voucherNumber: string;
  approvalStatus: "APPROVED" | "PENDING_APPROVAL" | "REJECTED";
}> {
  return withTx(async (tx) => {
    const [preview] = await tx.select().from(receipts).where(eq(receipts.id, receiptId)).limit(1);
    if (!preview || preview.branchId == null) {
      throw new TRPCError({ code: "NOT_FOUND", message: "محاولة الدفع النظامية المرفوضة غير موجودة" });
    }
    const previewRequest = parseSystemPaymentRequest(preview.internalNote);
    if (
      previewRequest?.kind !== "PURCHASE_SHIPPING" &&
      previewRequest?.kind !== "ASSET_MAINTENANCE" &&
      previewRequest?.kind !== "TERMINATION_SETTLEMENT"
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "إعادة التقديم الصريحة متاحة لطلب دفع مصروف أو تسوية نهاية خدمة فقط",
      });
    }
    const branchId = Number(preview.branchId);
    if (actor.role !== "admin" && actor.branchId != null && Number(actor.branchId) !== branchId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "طلب الدفع يخص فرعاً آخر" });
    }
    await lockCashSourceForUpdate(tx, { branchId, cashBucket: "TREASURY", shiftId: null });
    const [rejected] = await tx.select().from(receipts)
      .where(eq(receipts.id, receiptId)).for("update").limit(1);
    const request = parseSystemPaymentRequest(rejected?.internalNote);
    if (
      !rejected ||
      (request?.kind !== "PURCHASE_SHIPPING" &&
        request?.kind !== "ASSET_MAINTENANCE" &&
        request?.kind !== "TERMINATION_SETTLEMENT") ||
      rejected.approvalStatus !== "REJECTED" || rejected.status !== "FAILED" ||
      JSON.stringify(request) !== JSON.stringify(previewRequest) ||
      !rejected.referenceNumber
    ) {
      throw new TRPCError({ code: "CONFLICT", message: "محاولة الدفع لم تعد مرفوضة صالحة لإعادة التقديم" });
    }
    const existingTerminationReplacement = async (clientRequestId: string) => {
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
          message: "مرجع إعادة تقديم الدفع موجود لكن سنده مفقود — أوقف العملية وراجع التدقيق",
        });
      }
      const isDead =
        replacement.status === "REVERSED" ||
        replacement.status === "FAILED" ||
        replacement.approvalStatus === "REJECTED";
      if (isDead) {
        await tx.delete(idempotencyKeys).where(
          and(
            eq(idempotencyKeys.operation, "voucher.create"),
            eq(idempotencyKeys.clientRequestId, clientRequestId),
          ),
        );
        return null;
      }
      if (
        Number(replacement.branchId) !== branchId ||
        replacement.direction !== "OUT" ||
        replacement.paymentMethod !== "CASH" ||
        replacement.partyType !== "OTHER" ||
        replacement.referenceNumber !== rejected.referenceNumber ||
        replacement.internalNote !== rejected.internalNote ||
        !money(replacement.amount).eq(money(rejected.amount))
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "تعارض مفتاح إعادة التقديم مع سند دفع مختلف",
        });
      }
      return {
        receiptId: Number(replacement.id),
        voucherNumber: String(replacement.voucherNumber ?? ""),
        approvalStatus: replacement.approvalStatus as
          | "APPROVED"
          | "PENDING_APPROVAL"
          | "REJECTED",
      };
    };

    if (request.kind === "TERMINATION_SETTLEMENT") {
      if (
        !Number.isInteger(request.terminationId) ||
        request.terminationId <= 0 ||
        !Number.isInteger(request.employeeId) ||
        request.employeeId <= 0 ||
        typeof request.expectedAmount !== "string" ||
        rejected.referenceNumber !== `TERM-SETTLEMENT-${request.terminationId}`
      ) {
        throw new TRPCError({ code: "CONFLICT", message: "ارتباط تسوية نهاية الخدمة المرفوضة غير صالح" });
      }
      const [termination] = await tx
        .select()
        .from(employeeTerminations)
        .where(eq(employeeTerminations.id, request.terminationId))
        .for("update")
        .limit(1);
      const [employee] = await tx
        .select({
          id: employees.id,
          branchId: employees.branchId,
          employmentStatus: employees.employmentStatus,
          firstName: employees.firstName,
          fatherName: employees.fatherName,
          grandfatherName: employees.grandfatherName,
          lastName: employees.lastName,
        })
        .from(employees)
        .where(eq(employees.id, request.employeeId))
        .for("update")
        .limit(1);
      if (
        !termination ||
        termination.status !== "completed" ||
        Number(termination.employeeId) !== request.employeeId ||
        !employee ||
        Number(employee.branchId) !== branchId ||
        employee.employmentStatus !== "terminated" ||
        !money(termination.settlement).eq(money(rejected.amount)) ||
        !money(request.expectedAmount).eq(money(rejected.amount))
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "تغيّر سجل إنهاء الخدمة أو مبلغ تسويته — راجع الموارد البشرية قبل إعادة التقديم",
        });
      }
      const employeeName = [
        employee.firstName,
        employee.fatherName,
        employee.grandfatherName,
        employee.lastName,
      ]
        .filter(Boolean)
        .join(" ");
      const clientRequestId = `termination-settlement-${request.terminationId}`;
      const replay = await existingTerminationReplacement(clientRequestId);
      if (replay) return replay;
      const replacement = await createSystemPaymentRequestTx(tx, {
        branchId,
        amount: toDbMoney(rejected.amount),
        paymentMethod: "CASH",
        partyType: "OTHER",
        counterpartyName: rejected.counterpartyName?.trim() || employeeName,
        description: [
          `إعادة تقديم تسوية نهاية خدمة — ${termination.terminationType}`,
          correction?.note?.trim(),
        ]
          .filter(Boolean)
          .join(" — "),
        referenceNumber: rejected.referenceNumber,
        attachmentUrl: correction?.attachmentUrl?.trim() || rejected.attachmentUrl || null,
        voucherDate: toDateStr(),
        clientRequestId,
      }, actor, request);
      return {
        receiptId: replacement.receiptId,
        voucherNumber: replacement.voucherNumber,
        approvalStatus: replacement.approvalStatus,
      };
    }

    const replayKey = `system-expense-resubmit-${receiptId}`;
    const replayLinks = await tx.select({ refId: idempotencyKeys.refId })
      .from(idempotencyKeys)
      .where(and(
        eq(idempotencyKeys.operation, "voucher.create"),
        eq(idempotencyKeys.clientRequestId, replayKey),
      ))
      .for("update")
      .limit(2);
    if (replayLinks.length > 1) {
      throw new TRPCError({ code: "CONFLICT", message: "رابط إعادة تقديم دفع المصروف غير وحيد" });
    }
    const currentReceiptId = replayLinks[0] ? Number(replayLinks[0].refId) : receiptId;

    // The reference is descriptive and not unique.  On the first call the
    // rejected parent must still be the expense edge; on a retry the unique
    // idempotency link must point to the expense's current child.
    const expenseMatches = await tx.select().from(expenses)
      .where(and(
        eq(expenses.receiptId, currentReceiptId),
        eq(expenses.referenceNumber, rejected.referenceNumber),
      ))
      .for("update")
      .limit(2);
    const expense = expenseMatches[0];
    if (
      expenseMatches.length !== 1 || !expense || expense.status !== "ACTIVE" ||
      Number(expense.branchId) !== branchId || !money(expense.amount).eq(money(rejected.amount))
    ) {
      throw new TRPCError({ code: "CONFLICT", message: "استحقاق المصروف المرتبط بالطلب مفقود أو تغيّر" });
    }
    if (replayLinks[0]) {
      const [child] = await tx.select().from(receipts)
        .where(eq(receipts.id, currentReceiptId))
        .for("update")
        .limit(1);
      if (
        !child || child.status !== "PENDING" || child.approvalStatus !== "PENDING_APPROVAL" ||
        child.direction !== "OUT" || child.shiftId != null || child.cashBucket != null ||
        Number(child.branchId) !== branchId || child.paymentMethod !== rejected.paymentMethod ||
        !money(child.amount).eq(money(rejected.amount)) ||
        (child.referenceNumber ?? null) !== (rejected.referenceNumber ?? null) ||
        (child.internalNote ?? null) !== (rejected.internalNote ?? null) ||
        (child.partyType ?? null) !== (rejected.partyType ?? null) ||
        (child.partyId == null ? null : Number(child.partyId)) !==
          (rejected.partyId == null ? null : Number(rejected.partyId)) ||
        child.voucherNumber == null
      ) {
        throw new TRPCError({ code: "CONFLICT", message: "طفل إعادة تقديم دفع المصروف مفقود أو تغيّر" });
      }
      return {
        receiptId: currentReceiptId,
        voucherNumber: String(child.voucherNumber),
        approvalStatus: "PENDING_APPROVAL" as const,
      };
    }
    const isShipping = request.kind === "PURCHASE_SHIPPING";
    const replacement = await createSystemPaymentRequestTx(tx, {
      branchId,
      amount: toDbMoney(rejected.amount),
      paymentMethod: "CASH",
      partyType: "OTHER",
      counterpartyName: rejected.counterpartyName?.trim() || (isShipping ? "شركة النقل/الكمرك" : "جهة صيانة الأصل"),
      description: [isShipping ? "إعادة تقديم تسوية مصروف شحن/كمرك" : "إعادة تقديم تسوية مصروف صيانة أصل", correction?.note?.trim()].filter(Boolean).join(" — "),
      referenceNumber: rejected.referenceNumber,
      attachmentUrl: correction?.attachmentUrl?.trim() || rejected.attachmentUrl || null,
      voucherDate: toDateStr(),
      clientRequestId: replayKey,
    }, actor, request);
    await tx.update(expenses)
      .set({ receiptId: replacement.receiptId })
      .where(eq(expenses.id, Number(expense.id)));
    return {
      receiptId: replacement.receiptId,
      voucherNumber: replacement.voucherNumber,
      approvalStatus: replacement.approvalStatus,
    };
  });
}
