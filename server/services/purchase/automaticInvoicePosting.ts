import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { asc, eq } from "drizzle-orm";
import {
  accountingEntries,
  expenses,
  goodsReceiptItems,
  goodsReceipts,
  purchaseOrderItems,
  purchaseOrderRevisionItems,
  purchaseOrderRevisions,
  purchaseOrders,
  supplierInvoiceLines,
  supplierInvoiceMatchRuns,
  supplierInvoices,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { expenseAccrualRecognition } from "../accounting/accrualPosting";
import {
  createAccrualObligationTx,
  transitionAccrualObligationTx,
} from "../accounting/accrualObligations";
import {
  adjustSupplierBalance,
  adjustSupplierBalanceUsd,
  postEntry,
} from "../ledgerService";
import { money, round2, toDateStr, toDbMoney } from "../money";
import type { Actor } from "../tx";
import { createSystemPaymentRequestTx, finalizeOwnerSystemVoucherTx } from "../voucher/create";
import { createGoodsReceiptInTx } from "./goodsReceipts";
import { postSupplierInvoiceGrniTx } from "./grniAccounting";
import { assertPurchaseBranch } from "./internal";
import {
  decideSupplierPaymentInTx,
  requestSupplierPaymentInTx,
  SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY,
} from "./supplierPayments";
import { createSupplierInvoiceInTx } from "./supplierInvoices";
import { runThreeWayMatchInTx } from "./threeWayMatch";

function normalizeDeterministicKey(value: string): string {
  const key = value.trim();
  if (!key || key.length > 90) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مفتاح الترحيل التلقائي مطلوب وبحد أقصى 90 محرفاً",
    });
  }
  return key;
}

function originalReceiptOrderVersion(payloadCanonical: string): number {
  try {
    const value = JSON.parse(payloadCanonical) as {
      expectedOrderVersion?: unknown;
    };
    const version = Number(value.expectedOrderVersion);
    if (Number.isSafeInteger(version) && version > 0) return version;
  } catch {
    // The stored canonical payload is immutable evidence. A malformed value is
    // a data-integrity conflict, never a reason to guess the current version.
  }
  throw new TRPCError({
    code: "CONFLICT",
    message: "بصمة إذن الاستلام التلقائي المخزنة غير صالحة",
  });
}

async function recognizeShippingAndCustomsInTx(
  tx: Tx,
  input: {
    purchaseOrderId: number;
    poNumber: string;
    branchId: number;
    shippingCost: string;
    customsCost: string;
    actor: Actor;
    deterministicKey: string;
    recognizedAt: Date;
  },
): Promise<number | null> {
  const amount = round2(
    money(input.shippingCost).plus(money(input.customsCost)),
  );
  if (!amount.gt(0)) return null;

  const token = createHash("sha256")
    .update(input.deterministicKey)
    .digest("hex")
    .slice(0, 16);
  const reference = `SHIP-${input.poNumber}-${token}`;
  const evidenceReference = `AUTO-PO-APPROVAL:${input.deterministicKey}`;
  const beneficiaryName = "ناقل غير محدَّد";
  const recognitionDedupe = `PURCHASE_SHIPPING_ACCRUAL:${input.purchaseOrderId}:${token}`;

  const expenseResult = await tx.insert(expenses).values({
    branchId: input.branchId,
    shiftId: null,
    cashBucket: null,
    expenseDate: input.recognizedAt,
    category: "TRANSPORT",
    amount: toDbMoney(amount),
    paymentMethod: "ACCRUAL",
    source: "ACCRUAL",
    description: `شحن/كمرك أمر الشراء ${input.poNumber}`,
    referenceNumber: reference,
    payee: beneficiaryName,
    receiptId: null,
    status: "ACTIVE",
    createdBy: input.actor.userId,
  });
  const expenseId = extractInsertId(expenseResult);
  const shippingAccrual = expenseAccrualRecognition("DELIVERY_EXPENSE", amount);
  await postEntry(tx, {
    entryType: "ADJUST",
    branchId: input.branchId,
    createdBy: input.actor.userId,
    purchaseOrderId: input.purchaseOrderId,
    receiptId: null,
    amount,
    postingIntent: shippingAccrual.intent,
    postingSourceComponents: shippingAccrual.sourceComponents,
    dedupeKey: recognitionDedupe,
    notes: `استحقاق مصروف شحن/كمرك — أمر الشراء ${input.poNumber}`,
  });
  const recognitionEntry = (
    await tx
      .select({ id: accountingEntries.id })
      .from(accountingEntries)
      .where(eq(accountingEntries.dedupeKey, recognitionDedupe))
      .limit(1)
  )[0];
  if (!recognitionEntry) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "قيد مصروف الشحن/الكمرك التلقائي مفقود",
    });
  }
  const obligation = await createAccrualObligationTx(tx, {
    kind: "PURCHASE_SHIPPING",
    branchId: input.branchId,
    expenseId,
    purchaseOrderId: input.purchaseOrderId,
    sourceKey: recognitionDedupe,
    recognizedAmount: toDbMoney(amount),
    initialStatus: "ACCRUED_UNPAID",
    beneficiaryType: "OTHER",
    beneficiarySupplierId: null,
    beneficiaryName,
    evidenceReference,
    plannedPaymentMethod: "CASH",
    clientRequestId: `auto-purchase-shipping-${token}`,
    recognizedBy: input.actor.userId,
    recognizedAt: input.recognizedAt,
    recognitionAccountingEntryId: Number(recognitionEntry.id),
  });
  const request = await createSystemPaymentRequestTx(
    tx,
    {
      branchId: input.branchId,
      amount: toDbMoney(amount),
      paymentMethod: "CASH",
      partyType: "OTHER",
      partyId: null,
      counterpartyName: beneficiaryName,
      description: `تسوية مصروف شحن/كمرك — أمر الشراء ${input.poNumber}`,
      referenceNumber: reference,
      clientRequestId: `auto-purchase-shipping-payment-${token}`,
    },
    input.actor,
    {
      kind: "PURCHASE_SHIPPING",
      purchaseOrderId: input.purchaseOrderId,
      requestToken: token,
      expectedAmount: toDbMoney(amount),
      sourceShippingTotal: toDbMoney(amount),
      paymentReference: null,
      obligationId: Number(obligation.id),
      obligationSourceHash: obligation.sourceHash,
      beneficiaryType: "OTHER",
      beneficiaryId: null,
      beneficiaryNameSnapshot: beneficiaryName,
      sourceEvidenceReference: evidenceReference,
    },
  );
  await transitionAccrualObligationTx(tx, {
    obligationId: Number(obligation.id),
    expectedStatus: "ACCRUED_UNPAID",
    nextStatus: "PAYMENT_PENDING",
    eventType: "PAYMENT_REQUESTED",
    actorId: input.actor.userId,
    receiptId: request.receiptId,
    evidenceReference,
    dedupeKey: `ACCRUAL:PAYMENT_REQUESTED:${obligation.id}:${request.receiptId}`,
  });
  await finalizeOwnerSystemVoucherTx(tx, request.receiptId, input.actor);
  return request.receiptId;
}

/**
 * Materialize all accounting and inventory artifacts of an approved purchase
 * order inside the caller's transaction. There is deliberately no public API
 * for this function: the caller must already have completed the independently
 * governed purchase-order approval and passes that exact approver as `actor`.
 *
 * Deterministic child keys make the whole command replayable. Because every
 * child writer receives the same `tx`, no GRN, WAVG movement, GRNI entry,
 * supplier invoice, match evidence, AP entry, or supplier balance can commit
 * without all the others.
 */
export async function postApprovedPurchaseInvoiceInTx(
  tx: Tx,
  purchaseOrderId: number,
  actor: Actor,
  deterministicKeyInput: string,
) {
  if (!Number.isSafeInteger(purchaseOrderId) || purchaseOrderId <= 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "معرّف أمر الشراء غير صالح",
    });
  }
  const deterministicKey = normalizeDeterministicKey(deterministicKeyInput);
  const goodsReceiptKey = `auto-grn:${deterministicKey}`;
  const supplierInvoiceKey = `auto-sinvoice:${deterministicKey}`;
  const matchKey = `auto-match:${deterministicKey}`;

  // Canonical lock order begins with the PO. Every child service re-locks the
  // same rows in the same order, which is safe on the current connection.
  const po = (
    await tx
      .select()
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, purchaseOrderId))
      .for("update")
      .limit(1)
  )[0];
  if (!po) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "أمر الشراء غير موجود",
    });
  }
  assertPurchaseBranch(po, actor);
  if (
    po.approvedRevisionId == null ||
    po.approvedBy == null ||
    po.approvedAt == null ||
    !(po.status === "CONFIRMED" || po.status === "RECEIVED")
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "لا يمكن الترحيل التلقائي قبل اكتمال اعتماد أمر الشراء",
    });
  }
  if (Number(po.approvedBy) !== actor.userId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "الترحيل التلقائي ينفذه معتمد أمر الشراء نفسه داخل قرار الاعتماد",
    });
  }
  if (!actor.isOwner && po.createdBy != null && Number(po.createdBy) === actor.userId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "فصل المهام: منشئ أمر الشراء لا يعتمد ترحيله التلقائي",
    });
  }

  const revision = (
    await tx
      .select()
      .from(purchaseOrderRevisions)
      .where(eq(purchaseOrderRevisions.id, Number(po.approvedRevisionId)))
      .for("update")
      .limit(1)
  )[0];
  if (!revision || Number(revision.purchaseOrderId) !== purchaseOrderId) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "نسخة أمر الشراء المعتمدة مفقودة أو لا تخص الأمر",
    });
  }
  const poItems = await tx
    .select()
    .from(purchaseOrderItems)
    .where(eq(purchaseOrderItems.purchaseOrderId, purchaseOrderId))
    .orderBy(asc(purchaseOrderItems.id))
    .for("update");
  const revisionItems = await tx
    .select()
    .from(purchaseOrderRevisionItems)
    .where(eq(purchaseOrderRevisionItems.revisionId, Number(revision.id)))
    .orderBy(asc(purchaseOrderRevisionItems.lineNo))
    .for("update");
  if (!poItems.length || poItems.length !== revisionItems.length) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "بنود أمر الشراء لا تطابق النسخة المعتمدة",
    });
  }
  poItems.forEach((item, index) => {
    const snapshot = revisionItems[index];
    if (
      !snapshot ||
      Number(item.variantId) !== Number(snapshot.variantId) ||
      Number(item.baseQuantity) !== Number(snapshot.baseQuantity)
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "إسقاط بنود أمر الشراء على النسخة المعتمدة غير متسق",
      });
    }
  });

  const priorAutomaticReceipt = (
    await tx
      .select({
        purchaseOrderId: goodsReceipts.purchaseOrderId,
        payloadCanonical: goodsReceipts.payloadCanonical,
      })
      .from(goodsReceipts)
      .where(eq(goodsReceipts.clientRequestId, goodsReceiptKey))
      .limit(1)
  )[0];
  if (
    priorAutomaticReceipt &&
    Number(priorAutomaticReceipt.purchaseOrderId) !== purchaseOrderId
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "مفتاح الترحيل التلقائي مستعمل لأمر شراء آخر",
    });
  }
  const expectedOrderVersion = priorAutomaticReceipt
    ? originalReceiptOrderVersion(priorAutomaticReceipt.payloadCanonical)
    : Number(po.version);
  const receiptResult = await createGoodsReceiptInTx(
    tx,
    {
      purchaseOrderId,
      purchaseOrderRevisionId: Number(revision.id),
      expectedOrderVersion,
      clientRequestId: goodsReceiptKey,
      supplierDeliveryNote: `AUTO-${po.poNumber}`,
      notes: "إذن استلام آلي ناتج عن اعتماد فاتورة الشراء",
      lines: poItems.map((item) => ({
        purchaseOrderItemId: Number(item.id),
        acceptedBaseQuantity: Number(item.baseQuantity),
        rejectedBaseQuantity: 0,
      })),
    },
    actor,
    { allowPurchaseOrderApproverForAutomaticPosting: true },
  );
  const goodsReceiptId = Number(
    "goodsReceiptId" in receiptResult
      ? receiptResult.goodsReceiptId
      : receiptResult.id,
  );

  const invoiceDate = toDateStr(new Date(po.approvedAt));
  const invoiceResult = await createSupplierInvoiceInTx(
    tx,
    {
      clientRequestId: supplierInvoiceKey,
      supplierId: Number(revision.supplierId),
      branchId: Number(revision.branchId),
      externalInvoiceNumber: `AUTO-${po.poNumber}-R${revision.revisionNo}`,
      invoiceDate,
      dueDate: null,
      currency: revision.agreedCurrency,
      agreedRate:
        revision.agreedCurrency === "USD"
          ? String(revision.agreedRate ?? "")
          : null,
      taxAmount: "0.00",
      discountAmount: "0.00",
      evidenceType: "OTHER",
      evidenceReference: `AUTO-PO-APPROVAL:${deterministicKey}`,
      lines: revisionItems.map((item) => {
        const documentLineTotal =
          revision.agreedCurrency === "USD"
            ? item.usdLineTotal
            : item.lineTotal;
        if (documentLineTotal == null) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `إجمالي بند النسخة المعتمدة ${item.lineNo} مفقود`,
          });
        }
        return {
          purchaseOrderRevisionItemId: Number(item.id),
          description: [item.productNameSnapshot, item.variantNameSnapshot]
            .filter(Boolean)
            .join(" — "),
          invoicedBaseQuantity: Number(item.baseQuantity),
          unitPrice: money(documentLineTotal)
            .dividedBy(Number(item.baseQuantity))
            .toFixed(revision.agreedCurrency === "USD" ? 4 : 2),
        };
      }),
    },
    actor,
    {
      approvedRevisionExactAmounts: revisionItems.map((item) => {
        const grossDocumentUnitPrice =
          revision.agreedCurrency === "USD"
            ? (item.usdListUnitPrice ?? item.usdUnitPrice)
            : item.listUnitPrice;
        if (grossDocumentUnitPrice == null) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `سعر القائمة في بند النسخة المعتمدة ${item.lineNo} مفقود`,
          });
        }
        const grossDocumentAmount = money(grossDocumentUnitPrice)
          .times(item.quantity)
          .toDecimalPlaces(2);
        const netDocumentAmount =
          revision.agreedCurrency === "USD"
            ? money(item.usdLineTotal ?? "0")
            : money(item.lineTotal);
        const grossAmountIqd =
          revision.agreedCurrency === "USD"
            ? grossDocumentAmount
                .times(revision.agreedRate ?? "0")
                .toDecimalPlaces(2)
            : grossDocumentAmount;
        return {
          purchaseOrderRevisionItemId: Number(item.id),
          grossAmountIqd: grossAmountIqd.toFixed(2),
          netAmountIqd: String(item.lineTotal),
          grossDocumentAmount: grossDocumentAmount.toFixed(2),
          netDocumentAmount: netDocumentAmount.toFixed(2),
          usdTotal:
            revision.agreedCurrency === "USD"
              ? String(item.usdLineTotal ?? "0")
              : null,
        };
      }),
    },
  );
  const supplierInvoiceId = Number(
    "supplierInvoiceId" in invoiceResult
      ? invoiceResult.supplierInvoiceId
      : invoiceResult.id,
  );

  const receiptItems = await tx
    .select()
    .from(goodsReceiptItems)
    .where(eq(goodsReceiptItems.goodsReceiptId, goodsReceiptId))
    .orderBy(asc(goodsReceiptItems.lineNo));
  const invoiceLines = await tx
    .select()
    .from(supplierInvoiceLines)
    .where(eq(supplierInvoiceLines.supplierInvoiceId, supplierInvoiceId))
    .orderBy(asc(supplierInvoiceLines.lineNo));
  const receiptByRevisionItem = new Map(
    receiptItems.map((item) => [
      Number(item.purchaseOrderRevisionItemId),
      item,
    ]),
  );
  if (
    receiptItems.length !== revisionItems.length ||
    invoiceLines.length !== revisionItems.length
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "آثار الاستلام والفاتورة لا تغطي النسخة المعتمدة كاملة",
    });
  }
  const invoiceBeforeMatch = (
    await tx
      .select({ version: supplierInvoices.version })
      .from(supplierInvoices)
      .where(eq(supplierInvoices.id, supplierInvoiceId))
      .limit(1)
  )[0];
  if (!invoiceBeforeMatch) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "فاتورة المورد التلقائية مفقودة",
    });
  }
  const matchResult = await runThreeWayMatchInTx(
    tx,
    {
      supplierInvoiceId,
      expectedInvoiceVersion: Number(invoiceBeforeMatch.version),
      matchKey,
      allocations: invoiceLines.map((line) => {
        const receiptItem = receiptByRevisionItem.get(
          Number(line.purchaseOrderRevisionItemId),
        );
        if (!receiptItem) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعذّر ربط بند فاتورة المورد ببند الاستلام الآلي",
          });
        }
        return {
          supplierInvoiceLineId: Number(line.id),
          goodsReceiptItemId: Number(receiptItem.id),
          matchedBaseQuantity: Number(line.invoicedBaseQuantity),
        };
      }),
    },
    actor,
  );
  const matchRunId = Number(
    "matchRunId" in matchResult ? matchResult.matchRunId : matchResult.id,
  );
  const match = (
    await tx
      .select()
      .from(supplierInvoiceMatchRuns)
      .where(eq(supplierInvoiceMatchRuns.id, matchRunId))
      .for("update")
      .limit(1)
  )[0];
  if (!match || match.outcome === "HOLD") {
    const holdCodes = Array.isArray(match?.holdCodes)
      ? match.holdCodes.map(String)
      : [];
    throw new TRPCError({
      code: "CONFLICT",
      message: `فشلت المطابقة التلقائية${holdCodes.length ? `: ${holdCodes.join(", ")}` : ""}`,
    });
  }

  const invoice = (
    await tx
      .select()
      .from(supplierInvoices)
      .where(eq(supplierInvoices.id, supplierInvoiceId))
      .for("update")
      .limit(1)
  )[0];
  if (!invoice) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "فاتورة المورد التلقائية مفقودة بعد المطابقة",
    });
  }
  assertPurchaseBranch(invoice, actor);
  if (invoice.status === "POSTED") {
    if (invoice.postingEntryId == null) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "فاتورة المورد مرحلة بلا مرجع قيد",
      });
    }
    return {
      purchaseOrderId,
      goodsReceiptId,
      supplierInvoiceId,
      matchRunId,
      accountingEntryId: Number(invoice.postingEntryId),
      status: "POSTED" as const,
      idempotentReplay: true as const,
    };
  }
  if (
    invoice.status !== "MATCHED" ||
    invoice.postingEntryId != null ||
    match.invoiceHash !== invoice.payloadHash
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "فاتورة المورد لم تعد صالحة للترحيل التلقائي",
    });
  }

  const accountingEntryId = await postSupplierInvoiceGrniTx(tx, {
    supplierInvoiceId,
    purchaseOrderId,
    supplierId: Number(invoice.supplierId),
    branchId: Number(invoice.branchId),
    invoiceAmount: money(invoice.totalAmount),
    taxAmount: money(invoice.taxAmount),
    grniAmount: money(match.grnTotal),
    actorId: actor.userId,
  });
  await adjustSupplierBalance(
    tx,
    Number(invoice.supplierId),
    money(invoice.totalAmount),
  );
  if (invoice.currency === "USD") {
    await adjustSupplierBalanceUsd(
      tx,
      Number(invoice.supplierId),
      money(invoice.usdTotal ?? "0"),
    );
  }
  const postedAt = new Date();
  await tx
    .update(supplierInvoices)
    .set({
      status: "POSTED",
      holdReason: null,
      postingEntryId: accountingEntryId,
      postedBy: actor.userId,
      postedAt,
    })
    .where(eq(supplierInvoices.id, supplierInvoiceId));

  const shippingPaymentRequestReceiptId = await recognizeShippingAndCustomsInTx(
    tx,
    {
      purchaseOrderId,
      poNumber: po.poNumber,
      branchId: Number(po.branchId),
      shippingCost: String(revision.shippingCost),
      customsCost: String(revision.customsCost),
      actor,
      deterministicKey,
      recognizedAt: postedAt,
    },
  );

  // قرار المالك (٦/٩/٢٦، بلاغ «المشتريات النقدية تظهر ذمّةً»، مُعدَّلٌ بقرارٍ لاحقٍ في نفس اليوم):
  // أمر الشراء النقديّ «اعتمادٌ وصرفٌ» في خطوةٍ واحدة بلا شاشةٍ ثانية ولا شخصٍ ثانٍ يعتمد الصرف
  // منفصلاً — المالك رفض صراحةً نمط «طلبٍ معلَّق بانتظار اعتماد مستقل» بحجّة التعقيد والخطوات
  // الزائدة. فصلُ المهام يبقى محفوظاً على مستوى أمر الشراء نفسه (مُعتمِد الأمر ≠ منشئه، شرطٌ
  // قائمٌ أعلاه في هذه الدالّة)، لا على مستوى دفعةٍ منفصلة. الاعتماد التلقائي الفوري (لا تعليق
  // «بانتظار اعتماد») يستدعي requestSupplierPaymentInTx ثم decideSupplierPaymentInTx بالمتتالي
  // ضمن هذه المعاملة نفسها — فلا يظهر طلبٌ «معلَّق» لأي مستخدمٍ في «سداد الموردين» إطلاقاً، ولا
  // يُرى رصيد المورد مرتفعاً من خارج هذه المعاملة قبل أن يعود صفراً. صرفُ النقد الفعليّ من
  // الخزينة يبقى محروساً بلا استثناء: authorizeExternalTreasuryDisbursement يشترط حساب مالكٍ
  // نشطٍ دائماً، فمُعتمِد أمر الشراء النقديّ يلزمه أن يكون مالكاً حين يكون مصدر النقد الخزينة.
  let cashSettlementPaymentId: number | null = null;
  if (po.settlementType === "CASH" && money(invoice.totalAmount).gt(0)) {
    const cashSettlementToken = createHash("sha256")
      .update(`cash-settle:${deterministicKey}`)
      .digest("hex")
      .slice(0, 16);
    // لا تُعِد استعمال invoice.version الملتقَط أعلاه: requestSupplierPaymentInTx يُعيد قفل
    // الفاتورة وقراءتها بنفسه (lockPaymentAggregate)، والنسخة الملتقَطة هنا أقدم من نسخة ما
    // بعد كتابة الفاتورة POSTED مباشرةً — راجع [[read-every-writer-before-you-rely-on-a-field]].
    const [currentInvoiceVersion] = await tx
      .select({ version: supplierInvoices.version })
      .from(supplierInvoices)
      .where(eq(supplierInvoices.id, supplierInvoiceId))
      .limit(1);
    if (!currentInvoiceVersion) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "فاتورة المورد التلقائية مفقودة قبل التسوية النقدية",
      });
    }
    const cashSettlementRequest = await requestSupplierPaymentInTx(
      tx,
      {
        supplierId: Number(invoice.supplierId),
        branchId: Number(invoice.branchId),
        requestKey: `auto-cash-settle-${cashSettlementToken}`,
        currency: "IQD",
        exchangeRate: null,
        amount: toDbMoney(invoice.totalAmount),
        currencyAmount: toDbMoney(invoice.totalAmount),
        paymentMethod: "CASH",
        evidenceType: "OTHER",
        evidenceReference: `AUTO-PO-APPROVAL:${deterministicKey}`,
        reason: `تسوية نقدية فورية عند اعتماد أمر الشراء النقدي ${po.poNumber}`,
        allocations: [
          {
            supplierInvoiceId,
            invoiceVersion: Number(currentInvoiceVersion.version),
            amount: toDbMoney(invoice.totalAmount),
            currencyAmount: toDbMoney(invoice.totalAmount),
          },
        ],
      },
      actor,
    );
    const cashSettlementDecision = await decideSupplierPaymentInTx(
      tx,
      {
        requestId: cashSettlementRequest.requestId,
        decisionKey: `auto-cash-settle-decide-${cashSettlementToken}`,
        action: "APPROVE",
        reviewReason: `تسوية نقدية فورية عند اعتماد أمر الشراء النقدي ${po.poNumber}`,
      },
      actor,
      SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY,
    );
    cashSettlementPaymentId = cashSettlementDecision.supplierPaymentId;
  }

  return {
    purchaseOrderId,
    goodsReceiptId,
    supplierInvoiceId,
    matchRunId,
    accountingEntryId,
    shippingPaymentRequestReceiptId,
    cashSettlementPaymentId,
    status: "POSTED" as const,
    idempotentReplay: false as const,
  };
}
