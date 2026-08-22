/** Governed direct settlement of a USD purchase liability. */
import { TRPCError } from "@trpc/server";
import { and, eq, like } from "drizzle-orm";
import {
  accountingEntries,
  purchaseOrders,
  receipts,
  suppliers,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import {
  checkIdempotency,
  idempotencyHash,
  recordIdempotencyKey,
} from "../idempotency";
import {
  adjustSupplierBalance,
  adjustSupplierBalanceUsd,
  postEntry,
} from "../ledgerService";
import {
  createPostingIntent,
  signedPostingLines,
  type AccountRole,
  type PostingSourceComponents,
} from "../accounting/postingEngine";
import { money, round2, toDateStr, toDbMoney } from "../money";
import { type Actor, withTx } from "../tx";
import type { SettlePurchaseUsdDirectInput } from "./types";
import { paymentAssetRole } from "../sale/paymentPosting";
import {
  createSystemPaymentRequestTx,
  encodeSystemPaymentRequest,
  isCanonicalSystemPaymentRequest,
  parseSystemPaymentRequest,
} from "../voucher/create";
import { purchaseOrderPayableBalanceTx } from "./internal";
import {
  PURCHASE_USD_REFERENCE_PREFIX,
  isCanonicalPurchaseUsdSystemPaymentRequest,
  purchaseUsdSettlementReference,
  type PurchaseSupplierUsdSystemPaymentRequest,
} from "./usdSettlementRequest";
import { withMysqlDeadlockRetry } from "../voucher/deadlockRetry";

const SERVICE_IDEMPOTENCY_OPERATION = "purchase.usd-settle.governed";
const LEGACY_IDEMPOTENCY_OPERATION = "purchase.usd-settle";
type PurchaseUsdMethod = "CARD" | "TRANSFER" | "WALLET";
type ReceiptRow = typeof receipts.$inferSelect;
type PurchaseOrderRow = typeof purchaseOrders.$inferSelect;

export interface PurchaseUsdSettlementResult {
  receiptId: number;
  voucherNumber: string | null;
  approvalStatus: "APPROVED" | "PENDING_APPROVAL" | "REJECTED";
  settledUsd: string;
  carryingIqd: string;
  chargedIqd: string;
  feeIqd: string;
  cashOutIqd: string;
  fxDiff: string;
  idempotent: boolean;
  legacy: boolean;
}

type NormalizedInput = {
  purchaseOrderId: number;
  settledUsd: ReturnType<typeof money>;
  chargedIqd: ReturnType<typeof money>;
  feeIqd: ReturnType<typeof money>;
  method: PurchaseUsdMethod;
  referenceNumber: string;
  cardLastFour: string | null;
  clientRequestId: string;
  requestHash: string;
  legacyRequestHash: string;
};

function failConflict(message: string): never {
  throw new TRPCError({ code: "CONFLICT", message });
}

function normalizeInput(input: SettlePurchaseUsdDirectInput): NormalizedInput {
  if (
    !Number.isSafeInteger(input.purchaseOrderId) ||
    input.purchaseOrderId <= 0
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "معرّف أمر الشراء غير صالح",
    });
  }
  const settledUsd = round2(input.settledUsd);
  const chargedIqd = round2(input.chargedIqd);
  const feeIqd = round2(input.feeIqd ?? "0");
  const referenceNumber = input.referenceNumber.trim();
  const clientRequestId = input.clientRequestId?.trim() ?? "";
  const cardLastFour = input.cardLastFour?.trim() || null;
  if (settledUsd.lte(0) || chargedIqd.lte(0)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مبلغ الدولار والمبلغ الديناري الفعلي يجب أن يكونا موجبين",
    });
  }
  if (feeIqd.isNegative()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "عمولة أداة الدفع لا تكون سالبة",
    });
  }
  if (!["CARD", "TRANSFER", "WALLET"].includes(input.method)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "تسديد المورد الدولاري متاح بالبطاقة أو التحويل أو المحفظة فقط",
    });
  }
  if (!referenceNumber || referenceNumber.length > 200) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مرجع إثبات عملية البطاقة أو التحويل أو المحفظة مطلوب",
    });
  }
  if (input.method === "CARD") {
    if (!/^\d{4}$/.test(cardLastFour ?? "")) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "آخر ٤ أرقام من البطاقة مطلوبة مع مرجع عملية البطاقة",
      });
    }
  } else if (cardLastFour != null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "آخر ٤ أرقام تُرسل لطريقة البطاقة فقط",
    });
  }
  if (!clientRequestId || clientRequestId.length > 64) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مفتاح idempotency مطلوب ولا يتجاوز 64 محرفاً",
    });
  }
  const requestHash = idempotencyHash({
    purchaseOrderId: input.purchaseOrderId,
    settledUsd: settledUsd.toFixed(2),
    chargedIqd: chargedIqd.toFixed(2),
    feeIqd: feeIqd.toFixed(2),
    method: input.method,
    referenceNumber,
    cardLastFour,
  });
  const legacyRequestHash = idempotencyHash({
    purchaseOrderId: input.purchaseOrderId,
    settledUsd: settledUsd.toFixed(2),
    chargedIqd: chargedIqd.toFixed(2),
    feeIqd: feeIqd.toFixed(2),
    method: input.method,
    referenceNumber,
  });
  return {
    purchaseOrderId: input.purchaseOrderId,
    settledUsd,
    chargedIqd,
    feeIqd,
    method: input.method,
    referenceNumber,
    cardLastFour,
    clientRequestId,
    requestHash,
    legacyRequestHash,
  };
}

function assertPurchaseBranch(po: PurchaseOrderRow, actor: Actor): void {
  if (actor.role !== "admin" && actor.branchId == null) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "لا فرع مُسنَد لمنشئ طلب تسديد USD",
    });
  }
  if (
    actor.role !== "admin" &&
    actor.branchId != null &&
    Number(po.branchId) !== Number(actor.branchId)
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "فاتورة الشراء تخص فرعاً آخر",
    });
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

function requestAmounts(request: PurchaseSupplierUsdSystemPaymentRequest) {
  const settledUsd = money(request.settledUsd);
  const carryingIqd = money(request.carryingIqd);
  const chargedIqd = money(request.chargedIqd);
  const feeIqd = money(request.feeIqd);
  return {
    settledUsd,
    carryingIqd,
    chargedIqd,
    feeIqd,
    cashOutIqd: chargedIqd.plus(feeIqd),
    fxDiff: carryingIqd.minus(chargedIqd),
  };
}

function resultFromRequest(
  receipt: ReceiptRow,
  request: PurchaseSupplierUsdSystemPaymentRequest,
  idempotent: boolean,
): PurchaseUsdSettlementResult {
  const amounts = requestAmounts(request);
  return {
    receiptId: Number(receipt.id),
    voucherNumber: receipt.voucherNumber,
    approvalStatus:
      receipt.approvalStatus as PurchaseUsdSettlementResult["approvalStatus"],
    settledUsd: amounts.settledUsd.toFixed(2),
    carryingIqd: amounts.carryingIqd.toFixed(2),
    chargedIqd: amounts.chargedIqd.toFixed(2),
    feeIqd: amounts.feeIqd.toFixed(2),
    cashOutIqd: amounts.cashOutIqd.toFixed(2),
    fxDiff: toDbMoney(amounts.fxDiff),
    idempotent,
    legacy: request.legacyReceiptId != null,
  };
}

async function pendingPurchaseUsdTx(tx: Tx, po: PurchaseOrderRow) {
  const pending = await tx
    .select({
      id: receipts.id,
      referenceNumber: receipts.referenceNumber,
      internalNote: receipts.internalNote,
    })
    .from(receipts)
    .where(
      and(
        eq(receipts.direction, "OUT"),
        eq(receipts.status, "PENDING"),
        eq(receipts.approvalStatus, "PENDING_APPROVAL"),
        like(
          receipts.referenceNumber,
          `${PURCHASE_USD_REFERENCE_PREFIX}${po.poNumber}-%`,
        ),
      ),
    );
  let total = money(0);
  for (const row of pending) {
    const request = parseSystemPaymentRequest(row.internalNote);
    if (
      request?.kind !== "PURCHASE_SUPPLIER_USD" ||
      request.purchaseOrderId !== Number(po.id) ||
      !isCanonicalSystemPaymentRequest(request, row.referenceNumber)
    ) {
      failConflict(
        `طلب USD معلّق #${row.id} لا يحمل ارتباطاً canonical؛ راجع التدقيق`,
      );
    }
    total = total.plus(money(request.settledUsd));
  }
  return round2(total);
}

function assertPurchaseSourceSnapshot(
  po: PurchaseOrderRow,
  request: PurchaseSupplierUsdSystemPaymentRequest,
): void {
  if (
    po.status === "CANCELLED" ||
    po.agreedCurrency !== "USD" ||
    po.usdTotal == null ||
    po.agreedRate == null ||
    !money(po.total).eq(money(request.sourceTotal)) ||
    !money(po.usdTotal).eq(money(request.sourceUsdTotal)) ||
    !money(po.agreedRate).eq(money(request.sourceAgreedRate))
  ) {
    failConflict("أمر الشراء الدولاري تغيّر أو لم يعد صالحاً لهذا الطلب");
  }
  if (
    !money(request.carryingIqd).eq(
      round2(money(request.settledUsd).times(money(po.agreedRate))),
    )
  ) {
    failConflict("القيمة الدفترية لطلب USD لا تطابق سعر التثبيت في أمر الشراء");
  }
}

function assertReceiptBinding(
  receipt: ReceiptRow,
  po: PurchaseOrderRow,
  request: PurchaseSupplierUsdSystemPaymentRequest,
): void {
  const amounts = requestAmounts(request);
  if (
    !isCanonicalPurchaseUsdSystemPaymentRequest(
      request,
      receipt.referenceNumber,
    ) ||
    receipt.referenceNumber !==
      purchaseUsdSettlementReference(
        String(po.poNumber),
        request.requestToken,
      ) ||
    receipt.direction !== "OUT" ||
    Number(receipt.branchId) !== Number(po.branchId) ||
    receipt.partyType !== "SUPPLIER" ||
    Number(receipt.partyId ?? 0) !== Number(po.supplierId) ||
    receipt.paymentMethod !== request.paymentMethod ||
    receipt.cashBucket != null ||
    !money(receipt.amount).eq(amounts.cashOutIqd) ||
    (receipt.cardLastFour?.trim() || null) !== request.cardLastFour ||
    receipt.checkNumber != null
  ) {
    failConflict(
      "سند تسديد USD لا يطابق أمر الشراء أو مبلغ الخروج أو دليل الأداة",
    );
  }
}

async function lockPurchaseAndSupplierTx(
  tx: Tx,
  receipt: ReceiptRow,
  request: PurchaseSupplierUsdSystemPaymentRequest,
) {
  const [po] = await tx
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, request.purchaseOrderId))
    .for("update")
    .limit(1);
  if (!po) failConflict("أمر الشراء المرتبط بطلب USD مفقود");
  assertPurchaseSourceSnapshot(po, request);
  assertReceiptBinding(receipt, po, request);
  const [supplier] = await tx
    .select()
    .from(suppliers)
    .where(eq(suppliers.id, Number(po.supplierId)))
    .for("update")
    .limit(1);
  if (
    !supplier ||
    Number(supplier.id) !== Number(receipt.partyId) ||
    !supplier.isActive
  ) {
    failConflict("المورد المرتبط بطلب USD مفقود أو معطّل أو تغيّر");
  }
  return { po, supplier };
}

async function postPurchaseUsdEntriesTx(
  tx: Tx,
  args: {
    receiptId: number;
    originalReceiptId?: number;
    po: PurchaseOrderRow;
    request: PurchaseSupplierUsdSystemPaymentRequest;
    createdBy: number;
    reversed: boolean;
  },
): Promise<void> {
  const amounts = requestAmounts(args.request);
  const sign = args.reversed ? money(-1) : money(1);
  // PAYMENT_IN is the compensating AP restoration and therefore remains a
  // positive amount (purchase payable reconciliation adds PAYMENT_IN).
  const paymentAmount = amounts.carryingIqd;
  const fxAmount = amounts.fxDiff.times(sign);
  const feeAmount = amounts.feeIqd.times(sign);
  const direction = args.reversed ? "IN" : "OUT";
  const paymentRole = paymentAssetRole(
    args.request.paymentMethod,
    null,
    direction,
  );
  const reversalKey = `${args.originalReceiptId ?? "N"}:${args.receiptId}`;
  const paymentDebitRole: AccountRole = args.reversed ? paymentRole : "AP";
  const paymentCreditRole: AccountRole = args.reversed ? "AP" : paymentRole;
  const paymentComponents = signedSourceComponents(
    paymentDebitRole,
    paymentCreditRole,
    paymentAmount,
  );
  await postEntry(tx, {
    entryType: args.reversed ? "PAYMENT_IN" : "PAYMENT_OUT",
    branchId: Number(args.po.branchId),
    purchaseOrderId: Number(args.po.id),
    supplierId: Number(args.po.supplierId),
    receiptId: args.receiptId,
    amount: paymentAmount,
    dedupeKey: args.reversed
      ? `POUSD-CANCEL-PAY:${reversalKey}`
      : `POUSD-PAY:${args.receiptId}`,
    notes: args.reversed
      ? "Governed reversal of direct USD supplier settlement"
      : `Direct USD settlement via ${args.request.paymentMethod}`,
    createdBy: args.createdBy,
    entryDate: new Date(),
    postingSourceComponents: paymentComponents,
    postingIntent: createPostingIntent(
      args.reversed ? "PAYMENT_IN_SUPPLIER_REFUND" : "PAYMENT_OUT_SUPPLIER",
      args.reversed ? "PAYMENT_IN" : "PAYMENT_OUT",
      signedPostingLines(paymentDebitRole, paymentCreditRole, paymentAmount),
      paymentComponents,
    ),
  });
  if (!amounts.fxDiff.isZero()) {
    const originalGain = amounts.fxDiff.isPositive();
    // amount is signed (gain positive, loss negative). Keeping the payment
    // asset as the base debit lets signedPostingLines flip only the loss case.
    const fxDebitRole: AccountRole = paymentRole;
    const fxCreditRole: AccountRole = originalGain ? "FX_GAIN" : "FX_LOSS";
    const fxComponents = signedSourceComponents(
      fxDebitRole,
      fxCreditRole,
      fxAmount,
    );
    await postEntry(tx, {
      entryType: "EXCHANGE_FX_DIFF",
      branchId: Number(args.po.branchId),
      purchaseOrderId: Number(args.po.id),
      supplierId: Number(args.po.supplierId),
      receiptId: args.receiptId,
      amount: fxAmount,
      dedupeKey: args.reversed
        ? `POUSD-CANCEL-FX:${reversalKey}`
        : `POUSD-FX:${args.receiptId}`,
      notes: args.reversed
        ? "Governed reversal of realized FX difference"
        : "Realized FX difference on direct supplier settlement",
      createdBy: args.createdBy,
      entryDate: new Date(),
      postingSourceComponents: fxComponents,
      postingIntent: createPostingIntent(
        originalGain ? "EXCHANGE_FX_GAIN" : "EXCHANGE_FX_LOSS",
        "EXCHANGE_FX_DIFF",
        signedPostingLines(fxDebitRole, fxCreditRole, fxAmount),
        fxComponents,
      ),
    });
  }
  if (amounts.feeIqd.gt(0)) {
    const feeComponents = signedSourceComponents(
      "OPERATING_EXPENSE",
      paymentRole,
      feeAmount,
    );
    await postEntry(tx, {
      entryType: "EXCHANGE_FEE",
      branchId: Number(args.po.branchId),
      purchaseOrderId: Number(args.po.id),
      supplierId: Number(args.po.supplierId),
      receiptId: args.receiptId,
      amount: feeAmount,
      cost: feeAmount,
      profit: feeAmount.negated(),
      dedupeKey: args.reversed
        ? `POUSD-CANCEL-FEE:${reversalKey}`
        : `POUSD-FEE:${args.receiptId}`,
      notes: args.reversed
        ? "Governed reversal of supplier-settlement instrument fee"
        : "Card/transfer/wallet fee for supplier settlement",
      createdBy: args.createdBy,
      entryDate: new Date(),
      postingSourceComponents: feeComponents,
      postingIntent: createPostingIntent(
        "EXCHANGE_FEE_EXPENSE",
        "EXCHANGE_FEE",
        signedPostingLines("OPERATING_EXPENSE", paymentRole, feeAmount),
        feeComponents,
      ),
    });
  }
}

async function assertMaterializedEntriesTx(
  tx: Tx,
  receipt: ReceiptRow,
  request: PurchaseSupplierUsdSystemPaymentRequest,
): Promise<void> {
  const entries = await tx
    .select()
    .from(accountingEntries)
    .where(eq(accountingEntries.receiptId, Number(receipt.id)))
    .for("update");
  const amounts = requestAmounts(request);
  const expectedCount =
    1 + (amounts.fxDiff.isZero() ? 0 : 1) + (amounts.feeIqd.gt(0) ? 1 : 0);
  const payment = entries.filter((entry) => entry.entryType === "PAYMENT_OUT");
  const fx = entries.filter((entry) => entry.entryType === "EXCHANGE_FX_DIFF");
  const fee = entries.filter((entry) => entry.entryType === "EXCHANGE_FEE");
  if (
    entries.length !== expectedCount ||
    payment.length !== 1 ||
    !money(payment[0]!.amount).eq(amounts.carryingIqd) ||
    payment[0]!.dedupeKey !== `POUSD-PAY:${receipt.id}` ||
    Number(payment[0]!.purchaseOrderId ?? 0) !== request.purchaseOrderId ||
    Number(payment[0]!.supplierId ?? 0) !== Number(receipt.partyId) ||
    (amounts.fxDiff.isZero()
      ? fx.length !== 0
      : fx.length !== 1 ||
        !money(fx[0]!.amount).eq(amounts.fxDiff) ||
        fx[0]!.dedupeKey !== `POUSD-FX:${receipt.id}`) ||
    (amounts.feeIqd.isZero()
      ? fee.length !== 0
      : fee.length !== 1 ||
        !money(fee[0]!.amount).eq(amounts.feeIqd) ||
        !money(fee[0]!.cost).eq(amounts.feeIqd) ||
        !money(fee[0]!.profit).eq(amounts.feeIqd.negated()) ||
        fee[0]!.dedupeKey !== `POUSD-FEE:${receipt.id}`)
  ) {
    failConflict(
      "قيود تسديد USD الأصلية ناقصة أو زائدة أو لا تطابق المصدر المثبت",
    );
  }
}

export async function materializePurchaseUsdSettlementTx(
  tx: Tx,
  args: {
    receipt: ReceiptRow;
    request: PurchaseSupplierUsdSystemPaymentRequest;
    approverUserId: number;
  },
): Promise<void> {
  const { po, supplier } = await lockPurchaseAndSupplierTx(
    tx,
    args.receipt,
    args.request,
  );
  const amounts = requestAmounts(args.request);
  const remainingUsd = round2(
    money(po.usdTotal).minus(money(po.paidUsd)).minus(money(po.returnedUsd)),
  );
  const payable = await purchaseOrderPayableBalanceTx(tx, Number(po.id));
  if (
    amounts.settledUsd.gt(remainingUsd) ||
    amounts.carryingIqd.gt(payable) ||
    amounts.settledUsd.gt(money(supplier.currentBalanceUsd)) ||
    amounts.carryingIqd.gt(money(supplier.currentBalance))
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "انخفض مستحق أمر الشراء أو رصيد المورد بعد إنشاء طلب USD؛ أعد الإصدار بعد المراجعة",
    });
  }
  await postPurchaseUsdEntriesTx(tx, {
    receiptId: Number(args.receipt.id),
    po,
    request: args.request,
    createdBy: args.approverUserId,
    reversed: false,
  });
  await adjustSupplierBalance(
    tx,
    Number(po.supplierId),
    amounts.carryingIqd.negated(),
  );
  await adjustSupplierBalanceUsd(
    tx,
    Number(po.supplierId),
    amounts.settledUsd.negated(),
  );
  await tx
    .update(purchaseOrders)
    .set({
      paidAmount: toDbMoney(money(po.paidAmount).plus(amounts.carryingIqd)),
      paidUsd: toDbMoney(money(po.paidUsd).plus(amounts.settledUsd)),
    })
    .where(eq(purchaseOrders.id, Number(po.id)));
}

export async function assertPurchaseUsdResubmissionAvailableTx(
  tx: Tx,
  receipt: ReceiptRow,
  request: PurchaseSupplierUsdSystemPaymentRequest,
): Promise<PurchaseOrderRow> {
  const { po, supplier } = await lockPurchaseAndSupplierTx(
    tx,
    receipt,
    request,
  );
  const amounts = requestAmounts(request);
  const pendingUsd = await pendingPurchaseUsdTx(tx, po);
  const remainingUsd = round2(
    money(po.usdTotal)
      .minus(money(po.paidUsd))
      .minus(money(po.returnedUsd))
      .minus(pendingUsd),
  );
  const payable = await purchaseOrderPayableBalanceTx(tx, Number(po.id));
  if (
    amounts.settledUsd.gt(remainingUsd) ||
    amounts.carryingIqd.gt(payable) ||
    amounts.settledUsd.gt(money(supplier.currentBalanceUsd)) ||
    amounts.carryingIqd.gt(money(supplier.currentBalance))
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "لم يعد مستحق أمر الشراء أو المورد كافياً لإعادة طلب USD",
    });
  }
  return po;
}

export async function assertPurchaseUsdSettlementMaterializedTx(
  tx: Tx,
  receipt: ReceiptRow,
  request: PurchaseSupplierUsdSystemPaymentRequest,
): Promise<void> {
  await lockPurchaseAndSupplierTx(tx, receipt, request);
  await assertMaterializedEntriesTx(tx, receipt, request);
}

export async function reversePurchaseUsdSettlementTx(
  tx: Tx,
  args: {
    originalReceipt: ReceiptRow;
    cancellationReceipt: ReceiptRow;
    request: PurchaseSupplierUsdSystemPaymentRequest;
    approverUserId: number;
  },
): Promise<void> {
  if (args.request.legacyReceiptId != null) {
    failConflict("تسديد USD التاريخي للقراءة والتدقيق فقط ولا يُعكس تلقائياً");
  }
  const { po } = await lockPurchaseAndSupplierTx(
    tx,
    args.originalReceipt,
    args.request,
  );
  await assertMaterializedEntriesTx(tx, args.originalReceipt, args.request);
  const amounts = requestAmounts(args.request);
  if (
    args.cancellationReceipt.direction !== "IN" ||
    args.cancellationReceipt.paymentMethod !==
      args.originalReceipt.paymentMethod ||
    Number(args.cancellationReceipt.branchId) !==
      Number(args.originalReceipt.branchId) ||
    args.cancellationReceipt.partyType !== "SUPPLIER" ||
    Number(args.cancellationReceipt.partyId ?? 0) !==
      Number(args.originalReceipt.partyId) ||
    !money(args.cancellationReceipt.amount).eq(amounts.cashOutIqd) ||
    money(po.paidAmount).lt(amounts.carryingIqd) ||
    money(po.paidUsd).lt(amounts.settledUsd)
  ) {
    failConflict("طلب عكس تسديد USD لا يطابق الأصل أو سيجعل المدفوع سالباً");
  }
  await postPurchaseUsdEntriesTx(tx, {
    receiptId: Number(args.cancellationReceipt.id),
    originalReceiptId: Number(args.originalReceipt.id),
    po,
    request: args.request,
    createdBy: args.approverUserId,
    reversed: true,
  });
  await adjustSupplierBalance(tx, Number(po.supplierId), amounts.carryingIqd);
  await adjustSupplierBalanceUsd(tx, Number(po.supplierId), amounts.settledUsd);
  await tx
    .update(purchaseOrders)
    .set({
      paidAmount: toDbMoney(money(po.paidAmount).minus(amounts.carryingIqd)),
      paidUsd: toDbMoney(money(po.paidUsd).minus(amounts.settledUsd)),
    })
    .where(eq(purchaseOrders.id, Number(po.id)));
}

async function reconstructLegacyRequestTx(
  tx: Tx,
  receiptId: number,
): Promise<{
  receipt: ReceiptRow;
  request: PurchaseSupplierUsdSystemPaymentRequest;
}> {
  const [receipt] = await tx
    .select()
    .from(receipts)
    .where(eq(receipts.id, receiptId))
    .for("update")
    .limit(1);
  if (
    !receipt ||
    receipt.voucherNumber != null ||
    receipt.status !== "COMPLETED" ||
    receipt.approvalStatus !== "APPROVED" ||
    receipt.direction !== "OUT" ||
    !["CARD", "TRANSFER", "WALLET"].includes(receipt.paymentMethod) ||
    receipt.cashBucket != null ||
    receipt.partyType !== "SUPPLIER" ||
    receipt.partyId == null ||
    !receipt.referenceNumber?.trim()
  ) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "السند غير موجود أو ليس تسديد USD تاريخياً قابلاً للإثبات",
    });
  }
  const entries = await tx
    .select()
    .from(accountingEntries)
    .where(eq(accountingEntries.receiptId, receiptId))
    .for("update");
  const payment = entries.filter(
    (entry) =>
      entry.entryType === "PAYMENT_OUT" &&
      entry.dedupeKey === `POUSD-PAY:${receiptId}`,
  );
  const fx = entries.filter(
    (entry) =>
      entry.entryType === "EXCHANGE_FX_DIFF" &&
      entry.dedupeKey === `POUSD-FX:${receiptId}`,
  );
  const fee = entries.filter(
    (entry) =>
      entry.entryType === "EXCHANGE_FEE" &&
      entry.dedupeKey === `POUSD-FEE:${receiptId}`,
  );
  if (
    payment.length !== 1 ||
    fx.length > 1 ||
    fee.length > 1 ||
    entries.length !== payment.length + fx.length + fee.length ||
    payment[0]!.purchaseOrderId == null ||
    payment[0]!.supplierId == null
  ) {
    failConflict(
      "الإيصال القديم لا يملك مجموعة قيود USD الأصلية الكاملة والفريدة",
    );
  }
  const [po] = await tx
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, Number(payment[0]!.purchaseOrderId)))
    .for("update")
    .limit(1);
  if (
    !po ||
    po.agreedCurrency !== "USD" ||
    po.usdTotal == null ||
    po.agreedRate == null ||
    Number(po.branchId) !== Number(receipt.branchId) ||
    Number(po.supplierId) !== Number(receipt.partyId) ||
    Number(payment[0]!.supplierId) !== Number(receipt.partyId) ||
    !money(po.agreedRate).gt(0)
  ) {
    failConflict("تعذر ربط الإيصال القديم بأمر USD ومورده بصورة يقينية");
  }
  const carryingIqd = money(payment[0]!.amount);
  const settledUsd = round2(carryingIqd.dividedBy(money(po.agreedRate)));
  if (
    !round2(settledUsd.times(money(po.agreedRate))).eq(carryingIqd) ||
    round2(settledUsd.minus("0.01").times(money(po.agreedRate))).eq(
      carryingIqd,
    ) ||
    round2(settledUsd.plus("0.01").times(money(po.agreedRate))).eq(carryingIqd)
  ) {
    failConflict(
      "لا يمكن اشتقاق مبلغ الدولار القديم بصورة فريدة؛ لا يُسمح بالتخمين",
    );
  }
  const fxDiff = fx[0] ? money(fx[0].amount) : money(0);
  const chargedIqd = carryingIqd.minus(fxDiff);
  const feeIqd = fee[0] ? money(fee[0].amount) : money(0);
  if (
    !carryingIqd.gt(0) ||
    !settledUsd.gt(0) ||
    !chargedIqd.gt(0) ||
    feeIqd.lt(0) ||
    !money(receipt.amount).eq(chargedIqd.plus(feeIqd)) ||
    (fee[0] != null &&
      (!money(fee[0].cost).eq(feeIqd) ||
        !money(fee[0].profit).eq(feeIqd.negated())))
  ) {
    failConflict(
      "قيم الخروج وفرق الصرف والعمولة في الإيصال القديم غير متوازنة",
    );
  }
  const requestToken = idempotencyHash({
    legacyReceiptId: receiptId,
    purchaseOrderId: Number(po.id),
    paymentEntryId: Number(payment[0]!.id),
    evidenceReference: receipt.referenceNumber.trim(),
  }).slice(0, 16);
  const request: PurchaseSupplierUsdSystemPaymentRequest = {
    kind: "PURCHASE_SUPPLIER_USD",
    purchaseOrderId: Number(po.id),
    requestToken,
    settledUsd: settledUsd.toFixed(2),
    carryingIqd: carryingIqd.toFixed(2),
    chargedIqd: chargedIqd.toFixed(2),
    feeIqd: feeIqd.toFixed(2),
    expectedAmount: chargedIqd.plus(feeIqd).toFixed(2),
    sourceTotal: money(po.total).toFixed(2),
    sourceUsdTotal: money(po.usdTotal).toFixed(2),
    sourceAgreedRate: money(po.agreedRate).toFixed(4),
    paymentMethod: receipt.paymentMethod as PurchaseUsdMethod,
    paymentEvidenceReference: receipt.referenceNumber.trim(),
    cardLastFour: receipt.cardLastFour?.trim() || null,
    legacyReceiptId: receiptId,
  };
  const canonicalReference = purchaseUsdSettlementReference(
    String(po.poNumber),
    requestToken,
  );
  if (
    !isCanonicalPurchaseUsdSystemPaymentRequest(request, canonicalReference)
  ) {
    failConflict("تعذر تكوين رابط canonical من سجل USD القديم المثبت");
  }
  return { receipt, request };
}

/**
 * Legacy direct USD receipts remain read-only. Their entries can prove the
 * instrument amounts, but cannot prove that mutable PO/supplier caches still
 * contain this receipt's exact allocation. Mutating those aggregates would
 * risk reversing a different payment, so cancellation fails closed.
 */
export async function repairLegacyPurchaseUsdSettlementReceiptTx(
  tx: Tx,
  receiptId: number,
): Promise<ReceiptRow> {
  await reconstructLegacyRequestTx(tx, receiptId);
  failConflict(
    "تسديد USD التاريخي متاح للتدقيق فقط؛ يلزم تصحيح مالي موثق بعد مطابقة تخصيصات الأمر وأرصدة المورد قبل العكس",
  );
}

async function loadReplayResultTx(
  tx: Tx,
  receiptId: number,
): Promise<PurchaseUsdSettlementResult> {
  const [receipt] = await tx
    .select()
    .from(receipts)
    .where(eq(receipts.id, receiptId))
    .limit(1);
  if (!receipt) failConflict("مفتاح تسديد USD يشير إلى إيصال مفقود");
  const request = parseSystemPaymentRequest(receipt.internalNote);
  if (
    request?.kind === "PURCHASE_SUPPLIER_USD" &&
    isCanonicalSystemPaymentRequest(request, receipt.referenceNumber)
  ) {
    return resultFromRequest(receipt, request, true);
  }
  if (
    receipt.voucherNumber == null &&
    receipt.status === "COMPLETED" &&
    receipt.direction === "OUT"
  ) {
    const legacy = await reconstructLegacyRequestTx(tx, receiptId);
    return resultFromRequest(receipt, legacy.request, true);
  }
  failConflict(
    "مفتاح تسديد USD مرتبط بإيصال ليس طلباً canonical ولا سجلاً قديماً قابلاً للإثبات",
  );
}

export async function settlePurchaseUsdDirect(
  input: SettlePurchaseUsdDirectInput,
  actor: Actor,
): Promise<PurchaseUsdSettlementResult> {
  const normalized = normalizeInput(input);
  return withMysqlDeadlockRetry(() =>
    withTx(async (tx) => {
      // The PO lock serializes reservations and idempotency checks for this source.
      const [po] = await tx
        .select()
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, normalized.purchaseOrderId))
        .for("update")
        .limit(1);
      if (!po)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "فاتورة الشراء غير موجودة",
        });
      assertPurchaseBranch(po, actor);
      if (po.status === "CANCELLED") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "لا يمكن تسديد فاتورة شراء ملغاة",
        });
      }
      if (po.agreedCurrency !== "USD" || !po.usdTotal || !po.agreedRate) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "الفاتورة المحددة ليست فاتورة مورد بالدولار",
        });
      }
      const existing = await checkIdempotency(
        tx,
        SERVICE_IDEMPOTENCY_OPERATION,
        normalized.clientRequestId,
        normalized.requestHash,
        { requireStoredHash: true },
      );
      if (existing != null) return loadReplayResultTx(tx, existing);
      const legacyExisting = await checkIdempotency(
        tx,
        LEGACY_IDEMPOTENCY_OPERATION,
        normalized.clientRequestId,
        normalized.legacyRequestHash,
        { requireStoredHash: true },
      );
      if (legacyExisting != null) return loadReplayResultTx(tx, legacyExisting);

      const [supplier] = await tx
        .select()
        .from(suppliers)
        .where(eq(suppliers.id, Number(po.supplierId)))
        .for("update")
        .limit(1);
      if (!supplier)
        throw new TRPCError({ code: "NOT_FOUND", message: "المورد غير موجود" });
      if (!supplier.isActive) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "لا يمكن الصرف لمورد معطّل",
        });
      }
      const carryingIqd = round2(
        normalized.settledUsd.times(money(po.agreedRate)),
      );
      const pendingUsd = await pendingPurchaseUsdTx(tx, po);
      const remainingUsd = round2(
        money(po.usdTotal)
          .minus(money(po.paidUsd))
          .minus(money(po.returnedUsd))
          .minus(pendingUsd),
      );
      const payable = await purchaseOrderPayableBalanceTx(tx, Number(po.id));
      if (normalized.settledUsd.gt(remainingUsd)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `الدفع (${normalized.settledUsd.toFixed(2)}$) يتجاوز المتاح بعد الطلبات المعلّقة (${remainingUsd.toFixed(2)}$)`,
        });
      }
      if (
        carryingIqd.gt(payable) ||
        normalized.settledUsd.gt(money(supplier.currentBalanceUsd)) ||
        carryingIqd.gt(money(supplier.currentBalance))
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "طلب USD يتجاوز المستحق الدفتري الحالي لأمر الشراء أو المورد",
        });
      }
      const cashOutIqd = round2(normalized.chargedIqd.plus(normalized.feeIqd));
      const requestToken = idempotencyHash({
        purchaseOrderId: Number(po.id),
        clientRequestId: normalized.clientRequestId,
      }).slice(0, 16);
      const request: PurchaseSupplierUsdSystemPaymentRequest = {
        kind: "PURCHASE_SUPPLIER_USD",
        purchaseOrderId: Number(po.id),
        requestToken,
        settledUsd: normalized.settledUsd.toFixed(2),
        carryingIqd: carryingIqd.toFixed(2),
        chargedIqd: normalized.chargedIqd.toFixed(2),
        feeIqd: normalized.feeIqd.toFixed(2),
        expectedAmount: cashOutIqd.toFixed(2),
        sourceTotal: money(po.total).toFixed(2),
        sourceUsdTotal: money(po.usdTotal).toFixed(2),
        sourceAgreedRate: money(po.agreedRate).toFixed(4),
        paymentMethod: normalized.method,
        paymentEvidenceReference: normalized.referenceNumber,
        cardLastFour: normalized.cardLastFour,
        legacyReceiptId: null,
      };
      const referenceNumber = purchaseUsdSettlementReference(
        String(po.poNumber),
        requestToken,
      );
      const voucherClientRequestId = `purchase-usd-${normalized.requestHash.slice(0, 40)}`;
      const created = await createSystemPaymentRequestTx(
        tx,
        {
          branchId: Number(po.branchId),
          amount: cashOutIqd.toFixed(2),
          paymentMethod: normalized.method,
          partyType: "SUPPLIER",
          partyId: Number(po.supplierId),
          description: `طلب تسديد USD ${normalized.settledUsd.toFixed(2)} لأمر الشراء ${po.poNumber}`,
          referenceNumber,
          cardLastFour: normalized.cardLastFour,
          clientRequestId: voucherClientRequestId,
          voucherDate: toDateStr(),
        },
        actor,
        request,
      );
      await recordIdempotencyKey(
        tx,
        SERVICE_IDEMPOTENCY_OPERATION,
        normalized.clientRequestId,
        created.receiptId,
        normalized.requestHash,
      );
      const [receipt] = await tx
        .select()
        .from(receipts)
        .where(eq(receipts.id, created.receiptId))
        .limit(1);
      if (!receipt) failConflict("تعذر قراءة طلب USD بعد إنشائه");
      return resultFromRequest(receipt, request, false);
    }),
  );
}
