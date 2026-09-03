import { createHash } from "node:crypto";
import { isDupEntry } from "@shared/errorMap.ar";
import { appErrorMessage } from "@shared/errors";
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  accountingEntries,
  branchStock,
  goodsReceiptItems,
  products,
  productUnits,
  productVariants,
  purchaseOrderItems,
  purchaseOrders,
  purchaseReturnItems,
  purchaseReturnRequestItems,
  purchaseReturnRequests,
  purchaseReturnReversalItems,
  purchaseReturnReversalRequestItems,
  purchaseReturnReversalRequests,
  purchaseReturnReversals,
  purchaseReturns,
  receipts,
  supplierInvoiceLines,
  supplierInvoiceMatchAllocations,
  supplierInvoiceMatchRuns,
  supplierInvoices,
  supplierPaymentAllocations,
  supplierPaymentRequestAllocations,
  supplierPaymentRequests,
  suppliers,
  users,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractAffectedRows, extractInsertId } from "../../lib/insertId";
import { createPostingIntent, creditLine, debitLine } from "../accounting/postingEngine";
import {
  assertApprovedTreasuryOutAvailable,
  assertCashOutAvailable,
  assertNonPhysicalOutReceipt,
  authorizeExternalTreasuryDisbursement,
  type ExternalTreasuryDisbursementApproval,
  lockCashSourceForUpdate,
} from "../cash/cashAvailability";
import { applyMovement, ensureBranchStockRows } from "../inventoryService";
import { lockInventoryVariants } from "../inventory/stockLock";
import { adjustSupplierBalance, adjustSupplierBalanceUsd, postEntry } from "../ledgerService";
import { money, round2, sumMoney, toDbMoney, toDbQty } from "../money";
import { paymentAssetRole } from "../sale/paymentPosting";
import { shiftIdForCashTx } from "../shiftService";
import { withTx, type Actor } from "../tx";
import { sha256, stableCanonical } from "./grniAccounting";
import { assertPurchaseBranch } from "./internal";
import { purchaseReturnReversalTrigger, purchaseReturnTrigger } from "@shared/approvalTriggers";
import { assertApprover, resolveApprovalActor } from "../approval/ownerGate";
import { payloadHashMatches } from "../idempotency";

type PaymentMethod = "CASH" | "CARD" | "TRANSFER" | "WALLET";

export interface RequestPurchaseReturnInput {
  supplierInvoiceId: number;
  matchRunId: number;
  expectedInvoiceVersion: number;
  requestKey: string;
  settlement: "CREDIT" | "CASH";
  paymentMethod: PaymentMethod;
  evidenceType: "RETURN_NOTE" | "SUPPLIER_ACKNOWLEDGEMENT" | "DOCUMENT_IMAGE" | "PDF" | "EMAIL" | "OTHER";
  evidenceReference: string;
  reason: string;
  lines: Array<{ matchAllocationId: number; baseQuantity: number; reason?: string | null }>;
}

export interface DecidePurchaseReturnInput {
  requestId: number;
  decisionKey: string;
  action: "APPROVE" | "REJECT";
  reviewReason: string;
}

export interface RequestPurchaseReturnReversalInput {
  purchaseReturnId: number;
  expectedReturnVersion: number;
  requestKey: string;
  evidenceType: "SUPPLIER_ACKNOWLEDGEMENT" | "DOCUMENT_IMAGE" | "PDF" | "EMAIL" | "SIGNED_APPROVAL" | "OTHER";
  evidenceReference: string;
  reason: string;
  lines: Array<{ purchaseReturnItemId: number; baseQuantity: number; reason?: string | null }>;
}

export interface DecidePurchaseReturnReversalInput {
  requestId: number;
  decisionKey: string;
  action: "APPROVE" | "REJECT";
  reviewReason: string;
}

function required(value: string | null | undefined, label: string, max: number): string {
  const normalized = value?.trim() ?? "";
  if (!normalized)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّرت معالجة طلب المرتجع",
        why: `${label} مطلوب — الحقل وصل فارغاً بعد قصّ الفراغات`,
        doThis: `اكتب قيمةً واضحة في حقل «${label}»، ثمّ أعد الحفظ`,
      }),
    });
  if (normalized.length > max)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّرت معالجة طلب المرتجع",
        why: `${label} يتجاوز ${max} محرفاً`,
        doThis: `اختصر قيمة حقل «${label}» لتصير ${max} محرفاً أو أقل`,
      }),
    });
  return normalized;
}

function positiveUnique(values: number[], label: string): void {
  const seen = new Set<number>();
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّرت معالجة طلب المرتجع",
          why: `${label} غير صالح — القيمة إمّا صفر أو سالبة أو ليست عدداً صحيحاً`,
          doThis: `اختر ${label} من القائمة بدل تحرير معرّفه يدوياً`,
        }),
      });
    if (seen.has(value))
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّرت معالجة طلب المرتجع",
          why: `لا يجوز تكرار ${label} في نفس الطلب`,
          doThis: `احذف السطر المكرَّر واجمع الكميّات في سطرٍ واحد`,
        }),
      });
    seen.add(value);
  }
}

export function assertIndependentPurchaseReviewer(requestedBy: number, reviewerId: number): void {
  if (requestedBy === reviewerId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر حسم طلب المرتجع",
        why: "فصل المهام: من أنشأ الطلب لا يعتمده ولا يرفضه — الاعتماد يلزمه شخصٌ مستقلّ",
        doThis: "اطلب من مستخدمٍ آخر (مديرٍ أو موظّفٍ مؤهَّل) حسم الطلب من قائمة طلبات المراجعة",
      }),
    });
  }
}

export function assertExpectedVersion(actual: number, expected: number, label: string): void {
  if (actual !== expected)
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر حفظ التعديل على المرتجع",
        why: `تغيّرت نسخة ${label} في جهةٍ أخرى بين لحظة الفتح والحفظ (نسختك أقدم من النسخة الحاليّة)`,
        doThis: "أعد تحميل المستند لعرض النسخة الحاليّة، ثمّ أعد إدخال تعديلاتك عليها",
      }),
    });
}

export function proportionalReturnAmount(total: string | number, quantity: number, sourceQuantity: number): Decimal {
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || !Number.isSafeInteger(sourceQuantity) || sourceQuantity <= 0 || quantity > sourceQuantity) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر حساب مبلغ المرتجع",
        why: "كمية المرتجع غير صالحة — إمّا صفر أو سالبة أو أكبر من الكمّية الأصليّة الواردة على المستند",
        doThis: "افتح بند المرتجع وعدّل الكمّية لتكون بين 1 والكمّية الأصليّة",
      }),
    });
  }
  return round2(money(total).times(quantity).dividedBy(sourceQuantity));
}

export function reversalAmountWithFinalResidual(
  sourceTotal: string | number | Decimal,
  sourceQuantity: number,
  requestedQuantity: number,
  previouslyReversedQuantity: number,
  previouslyReversedAmount: string | number | Decimal,
): Decimal {
  if (previouslyReversedQuantity + requestedQuantity === sourceQuantity) {
    return round2(Decimal.max(money(sourceTotal).minus(previouslyReversedAmount), 0));
  }
  return proportionalReturnAmount(money(sourceTotal).toFixed(2), requestedQuantity, sourceQuantity);
}

export function requiresCashShift(settlement: "CREDIT" | "CASH", method: PaymentMethod): boolean {
  return settlement === "CASH" && method === "CASH";
}

export function usdAtAgreedRate(amountIqd: string | number | Decimal, agreedRate: string | number | Decimal | null | undefined): Decimal {
  const rate = money(agreedRate);
  if (!rate.gt(0))
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذّر تحويل مبلغ المرتجع إلى الدولار",
        why: "فاتورة المورد بالدولار مسجَّلة بلا سعر صرفٍ متّفَقٍ عليه صالح، والتحويل يحتاج سعراً موجباً",
        doThis: "افتح فاتورة المورد وأدخل سعر صرفٍ صالحاً في حقل «سعر الصرف المتّفق عليه»، ثمّ أعد المرتجع",
      }),
    });
  return round2(money(amountIqd).dividedBy(rate));
}

function usdCreditBalanceAtIqd(
  invoiceUsdTotal: string | number | Decimal | null | undefined,
  invoiceIqdTotal: string | number | Decimal,
  creditedIqd: string | number | Decimal,
): Decimal {
  if (invoiceUsdTotal == null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذّر حساب رصيد المرتجع بالدولار",
        why: "فاتورة المورد بالدولار بلا لقطةِ المبلغ الدولاريّ الأصليّ عند الترحيل، والاشتقاق يحتاجها",
        doThis: "الفاتورة المرحَّلة لا تُعدَّل مباشرة (`assertDraftMutableTx` يقبل DRAFT فقط). أنشئ **تصحيحَ استحقاقٍ** على الفاتورة عبر مسار حوكمة الفواتير لإدخال قيمة USD، ثم أعد محاولة المرتجع",
      }),
    });
  }
  const sourceUsd = money(invoiceUsdTotal);
  const sourceIqd = money(invoiceIqdTotal);
  if (sourceUsd.isNegative() || !sourceIqd.gt(0)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذّر حساب رصيد المرتجع بالدولار",
        why: "لقطة الفاتورة المخزَّنة غير متسقة (المبلغ الدولاريّ سالبٌ أو المبلغ الدينارّي صفر أو سالب)",
        doThis: "افتح فاتورة المورد وأعد ترحيلها بمبلغَين موجبَين، ثمّ أعد إنشاء المرتجع",
      }),
    });
  }
  const appliedIqd = Decimal.min(Decimal.max(money(creditedIqd), 0), sourceIqd);
  if (appliedIqd.isZero() || sourceUsd.isZero()) return money(0);
  // بلوغ السقف يعيد الأصل نفسه لا ناتج قسمةٍ مقرّباً؛ آخر مرتجع يمتص الباقي الدقيق.
  if (appliedIqd.gte(sourceIqd)) return round2(sourceUsd);
  return round2(sourceUsd.times(appliedIqd).dividedBy(sourceIqd));
}

export function usdReturnAmountWithFinalResidual(
  invoiceUsdTotal: string | number | Decimal | null | undefined,
  invoiceIqdTotal: string | number | Decimal,
  requestedIqd: string | number | Decimal,
  previouslyCreditedIqd: string | number | Decimal,
): Decimal {
  const sourceIqd = money(invoiceIqdTotal);
  const beforeIqd = Decimal.min(Decimal.max(money(previouslyCreditedIqd), 0), sourceIqd);
  const remainingIqd = Decimal.max(sourceIqd.minus(beforeIqd), 0);
  const appliedIqd = Decimal.min(Decimal.max(money(requestedIqd), 0), remainingIqd);
  const beforeUsd = usdCreditBalanceAtIqd(invoiceUsdTotal, sourceIqd, beforeIqd);
  const afterUsd = usdCreditBalanceAtIqd(invoiceUsdTotal, sourceIqd, beforeIqd.plus(appliedIqd));
  const remainingUsd = Decimal.max(money(invoiceUsdTotal).minus(beforeUsd), 0);
  return round2(Decimal.min(Decimal.max(afterUsd.minus(beforeUsd), 0), remainingUsd));
}

function usdReversalAmountWithFinalResidual(
  invoiceUsdTotal: string | number | Decimal | null | undefined,
  invoiceIqdTotal: string | number | Decimal,
  requestedIqd: string | number | Decimal,
  previouslyCreditedIqd: string | number | Decimal,
): Decimal {
  const sourceIqd = money(invoiceIqdTotal);
  const beforeIqd = Decimal.min(Decimal.max(money(previouslyCreditedIqd), 0), sourceIqd);
  const appliedIqd = Decimal.min(Decimal.max(money(requestedIqd), 0), beforeIqd);
  const beforeUsd = usdCreditBalanceAtIqd(invoiceUsdTotal, sourceIqd, beforeIqd);
  const afterUsd = usdCreditBalanceAtIqd(invoiceUsdTotal, sourceIqd, beforeIqd.minus(appliedIqd));
  return round2(Decimal.min(Decimal.max(beforeUsd.minus(afterUsd), 0), beforeUsd));
}

function assertReturnEvidenceForInstrument(input: Pick<RequestPurchaseReturnInput, "settlement" | "paymentMethod" | "evidenceType">): void {
  if (input.settlement === "CASH" && input.paymentMethod !== "CASH" && input.evidenceType === "RETURN_NOTE") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر اعتماد مرتجع الشراء",
        why: "الاسترداد بالبطاقة/التحويل/المحفظة يحتاج دليلاً خارجياً (رقم إيصال أو تحويل)، ومذكّرة المرتجع الداخلية لا تعوّضه",
        doThis: "افتح إيصال البطاقة أو صورة التحويل واكتب المرجع في حقل «رقم التأكيد الخارجي»، أو غيّر طريقة الردّ إلى النقد",
      }),
    });
  }
}

async function assertNoPendingSupplierPayment(tx: Tx, supplierInvoiceId: number): Promise<void> {
  const pending = (await tx.select({ id: supplierPaymentRequests.id })
    .from(supplierPaymentRequestAllocations)
    .innerJoin(supplierPaymentRequests, eq(supplierPaymentRequests.id, supplierPaymentRequestAllocations.requestId))
    .where(and(eq(supplierPaymentRequestAllocations.supplierInvoiceId, supplierInvoiceId), eq(supplierPaymentRequests.status, "PENDING")))
    .limit(1))[0];
  if (pending)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذّر اعتماد المرتجع أو عكسه",
        why: "الفاتورة نفسها تحمل طلب دفعٍ معلّقاً في انتظار الاعتماد، وإتمام المرتجع فوقه يخلط الرصيدَين",
        doThis: "افتح شاشة سداد المورّد وحدّث طلب الدفع المعلَّق (اعتماد أو رفض)، ثمّ أعد اعتماد المرتجع",
      }),
    });
}

async function netInvoiceCreditReturns(tx: Tx, invoiceId: number): Promise<Decimal> {
  const credited = (await tx.select({ amount: sql<string>`COALESCE(SUM(${purchaseReturns.creditOffsetAmount}),0)` })
    .from(purchaseReturns)
    .where(eq(purchaseReturns.supplierInvoiceId, invoiceId)))[0];
  const reversed = (await tx.select({ amount: sql<string>`COALESCE(SUM(${purchaseReturnReversals.totalAmount}),0)` })
    .from(purchaseReturnReversals)
    .innerJoin(purchaseReturns, eq(purchaseReturns.id, purchaseReturnReversals.purchaseReturnId))
    .where(and(eq(purchaseReturnReversals.supplierInvoiceId, invoiceId), eq(purchaseReturns.settlement, "CREDIT"))))[0];
  return Decimal.max(money(credited?.amount).minus(reversed?.amount ?? 0), 0);
}

async function refreshInvoiceCreditState(tx: Tx, invoice: typeof supplierInvoices.$inferSelect): Promise<void> {
  const netCredit = await netInvoiceCreditReturns(tx, Number(invoice.id));
  const paid = (await tx.select({ amount: sql<string>`COALESCE(SUM(${supplierPaymentAllocations.allocatedAmount} - ${supplierPaymentAllocations.refundedAmount}),0)` })
    .from(supplierPaymentAllocations)
    .where(eq(supplierPaymentAllocations.supplierInvoiceId, Number(invoice.id))))[0];
  const effectiveTotal = Decimal.max(money(invoice.totalAmount).minus(netCredit), 0);
  const settled = money(invoice.legacySettledAmount).plus(paid?.amount ?? 0).gte(effectiveTotal);
  await tx.update(supplierInvoices).set({
    version: sql`${supplierInvoices.version} + 1`,
    paymentGate: settled ? "SETTLED" : "OPEN",
    paymentGateReason: settled ? "سُوّيت بالكامل بعد صافي المرتجعات وتخصيصات الدفع" : null,
  }).where(eq(supplierInvoices.id, Number(invoice.id)));
}

function decisionHash(requestId: number, action: string, reviewReason: string): string {
  return sha256(stableCanonical({ requestId, action, reviewReason }));
}

async function actorName(tx: Tx, userId: number): Promise<string> {
  const row = (await tx.select({ name: users.name, username: users.username }).from(users).where(eq(users.id, userId)).limit(1))[0];
  return row?.name?.trim() || row?.username?.trim() || `مستخدم #${userId}`;
}

async function entryId(tx: Tx, dedupeKey: string): Promise<number> {
  const row = (await tx.select({ id: accountingEntries.id }).from(accountingEntries).where(eq(accountingEntries.dedupeKey, dedupeKey)).limit(1))[0];
  if (!row) throw new Error(`missing accounting entry: ${dedupeKey}`);
  return Number(row.id);
}

async function cashContext(
  tx: Tx,
  branchId: number,
  actor: Actor,
  label: string,
  direction: "IN" | "OUT",
  makerUserIds: Array<number | null | undefined>,
): Promise<{
  shiftId: number | null;
  cashBucket: "DRAWER" | "TREASURY";
  treasuryApproval: ExternalTreasuryDisbursementApproval | null;
}> {
  const resolved = await shiftIdForCashTx(tx, { ...actor, branchId }, branchId, label);
  if (direction === "OUT" && resolved.cashBucket === "TREASURY") {
    const treasuryApproval = await authorizeExternalTreasuryDisbursement(tx, {
      actor,
      makerUserIds,
      branchIds: [branchId],
      operation: label,
    });
    return { ...resolved, treasuryApproval };
  }
  await lockCashSourceForUpdate(tx, { branchId, shiftId: resolved.shiftId, cashBucket: resolved.cashBucket });
  return { ...resolved, treasuryApproval: null };
}

async function netReturnedByAllocation(tx: Tx, allocationIds: number[]): Promise<Map<number, number>> {
  if (!allocationIds.length) return new Map();
  const posted = await tx.select({ allocationId: purchaseReturnItems.matchAllocationId, quantity: sql<string>`COALESCE(SUM(${purchaseReturnItems.baseQuantity}),0)` })
    .from(purchaseReturnItems).where(inArray(purchaseReturnItems.matchAllocationId, allocationIds)).groupBy(purchaseReturnItems.matchAllocationId);
  const reversed = await tx.select({ allocationId: purchaseReturnItems.matchAllocationId, quantity: sql<string>`COALESCE(SUM(${purchaseReturnReversalItems.baseQuantity}),0)` })
    .from(purchaseReturnReversalItems)
    .innerJoin(purchaseReturnItems, eq(purchaseReturnItems.id, purchaseReturnReversalItems.purchaseReturnItemId))
    .where(inArray(purchaseReturnItems.matchAllocationId, allocationIds))
    .groupBy(purchaseReturnItems.matchAllocationId);
  const reversedById = new Map(reversed.map((row) => [Number(row.allocationId), Number(row.quantity)]));
  return new Map(posted.map((row) => [Number(row.allocationId), Math.max(0, Number(row.quantity) - (reversedById.get(Number(row.allocationId)) ?? 0))]));
}

export async function requestPurchaseReturn(input: RequestPurchaseReturnInput, actor: Actor) {
  const requestKey = required(input.requestKey, "مفتاح الطلب", 120);
  const evidenceReference = required(input.evidenceReference, "مرجع الدليل", 500);
  const reason = required(input.reason, "سبب المرتجع", 500);
  assertReturnEvidenceForInstrument(input);
  if (!input.lines.length)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إنشاء طلب المرتجع",
        why: "الطلب وصل بلا أيّ بندٍ يُطلب إرجاعه",
        doThis: "أضف بنداً واحداً على الأقل في جدول بنود المرتجع بكميّته، قبل الحفظ",
      }),
    });
  positiveUnique(input.lines.map((line) => line.matchAllocationId), "تخصيص المطابقة");
  const normalizedLines = [...input.lines].map((line) => {
    if (!Number.isSafeInteger(line.baseQuantity) || line.baseQuantity <= 0)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر إنشاء طلب المرتجع",
          why: "أحد البنود يحمل كمية مرتجعٍ غير موجبة أو ليست عدداً صحيحاً (تُخزَّن بالوحدة الأساس)",
          doThis: "افتح البند المتضرِّر وعدّل الكمية لتكون عدداً صحيحاً أكبر من صفر بالوحدة الأساس",
        }),
      });
    return { matchAllocationId: line.matchAllocationId, baseQuantity: line.baseQuantity, reason: line.reason?.trim() || null };
  }).sort((a, b) => a.matchAllocationId - b.matchAllocationId);
  const canonical = stableCanonical({
    supplierInvoiceId: input.supplierInvoiceId,
    matchRunId: input.matchRunId,
    expectedInvoiceVersion: input.expectedInvoiceVersion,
    settlement: input.settlement,
    paymentMethod: input.paymentMethod,
    evidenceType: input.evidenceType,
    evidenceReference,
    reason,
    lines: normalizedLines,
  });
  const payloadHash = sha256(canonical);
  const evidenceHash = sha256(stableCanonical({ type: input.evidenceType, reference: evidenceReference }));

  return withTx(async (tx) => {
    const replay = (await tx.select().from(purchaseReturnRequests).where(eq(purchaseReturnRequests.requestKey, requestKey)).limit(1))[0];
    if (replay) {
      assertPurchaseBranch(replay, actor);
      if (!payloadHashMatches(payloadHash, replay.payloadHash))
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر تسجيل طلب المرتجع",
            why: "نفس مفتاح الطلب مسجَّل قبل قليل بحمولةٍ مختلفة (بنودٌ أو كمّياتٌ أو مرجعٌ مختلف)",
            doThis: "حدّث الشاشة ليُولَّد مفتاحٌ جديد، ثمّ أعد الحفظ بالبيانات المعروضة أمامك",
          }),
        });
      return { requestId: Number(replay.id), status: replay.status, idempotent: true as const };
    }
    const invoice = (await tx.select().from(supplierInvoices).where(eq(supplierInvoices.id, input.supplierInvoiceId)).for("update").limit(1))[0];
    if (!invoice)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر إنشاء طلب المرتجع",
          why: "فاتورة المورد المُختارة غير موجودة، إمّا حُذفت أو أُدخل معرّفٌ غير صحيح",
          doThis: "ارجع لقائمة فواتير الموردين واختر الفاتورة من القائمة، ثمّ ابدأ المرتجع منها",
        }),
      });
    assertPurchaseBranch(invoice, actor);
    assertExpectedVersion(Number(invoice.version), input.expectedInvoiceVersion, "فاتورة المورد");
    if (invoice.status !== "POSTED")
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر إنشاء طلب المرتجع",
          why: "فاتورة المورد ليست بحالة «مُرحَّلة» — لا يُنشأ مرتجعٌ من فاتورةٍ مسودةٍ أو ملغاة",
          doThis: "افتح فاتورة المورد ورحّلها أوّلاً، أو ابدأ المرتجع من فاتورةٍ مرحَّلة أخرى",
        }),
      });
    const matchRun = (await tx.select().from(supplierInvoiceMatchRuns).where(eq(supplierInvoiceMatchRuns.id, input.matchRunId)).for("update").limit(1))[0];
    if (!matchRun || Number(matchRun.supplierInvoiceId) !== input.supplierInvoiceId || matchRun.outcome === "HOLD") {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر إنشاء طلب المرتجع",
          why: "تشغيل المطابقة الثلاثية المُختار ليس بحالةٍ تسمح بمرتجعٍ (رفضٌ أو انتظار)",
          doThis: "افتح شاشة المطابقة الثلاثية على الفاتورة واختر تشغيلاً معتمَداً، ثمّ ابدأ المرتجع",
        }),
      });
    }
    const allocationIds = normalizedLines.map((line) => line.matchAllocationId);
    const allocations = await tx.select().from(supplierInvoiceMatchAllocations)
      .where(inArray(supplierInvoiceMatchAllocations.id, allocationIds)).orderBy(asc(supplierInvoiceMatchAllocations.id)).for("update");
    if (allocations.length !== allocationIds.length)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر إنشاء طلب المرتجع",
          why: "أحد تخصيصات المطابقة الثلاثية المُشار إليها غير موجود في قاعدة البيانات",
          doThis: "أعد فتح شاشة إنشاء المرتجع من صفحة فاتورة المورد لتحميل تخصيصات المطابقة الحاليّة",
        }),
      });
    const invoiceLineIds = allocations.map((row) => Number(row.supplierInvoiceLineId));
    const grnItemIds = allocations.map((row) => Number(row.goodsReceiptItemId));
    const invoiceLines = await tx.select().from(supplierInvoiceLines).where(inArray(supplierInvoiceLines.id, invoiceLineIds)).orderBy(asc(supplierInvoiceLines.id)).for("update");
    const grnItems = await tx.select().from(goodsReceiptItems).where(inArray(goodsReceiptItems.id, grnItemIds)).orderBy(asc(goodsReceiptItems.id)).for("update");
    const sourcePoItems = await tx.select({ id: purchaseOrderItems.id, purchaseOrderId: purchaseOrderItems.purchaseOrderId })
      .from(purchaseOrderItems)
      .where(inArray(purchaseOrderItems.id, grnItems.map((row) => Number(row.purchaseOrderItemId))))
      .orderBy(asc(purchaseOrderItems.id))
      .for("update");
    const purchaseOrderIds = Array.from(new Set(sourcePoItems.map((row) => Number(row.purchaseOrderId))));
    if (purchaseOrderIds.length !== 1)
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر إنشاء طلب المرتجع",
          why: "بنود المرتجع تعود لأكثر من أمر شراءٍ واحد، والمرتجع الواحد يخصّ أمر شراءٍ واحداً",
          doThis: "قسّم البنود إلى مرتجعاتٍ منفصلة، مرتجعٌ لكلّ أمر شراءٍ على حدة",
        }),
      });
    const purchaseOrderId = purchaseOrderIds[0]!;
    const lineById = new Map(invoiceLines.map((row) => [Number(row.id), row]));
    const grnById = new Map(grnItems.map((row) => [Number(row.id), row]));
    const pendingRows = await tx.select({
      allocationId: purchaseReturnRequestItems.matchAllocationId,
      quantity: sql<string>`COALESCE(SUM(${purchaseReturnRequestItems.requestedBaseQuantity}),0)`,
    }).from(purchaseReturnRequestItems)
      .innerJoin(purchaseReturnRequests, eq(purchaseReturnRequests.id, purchaseReturnRequestItems.requestId))
      .where(and(eq(purchaseReturnRequests.status, "PENDING"), inArray(purchaseReturnRequestItems.matchAllocationId, allocationIds)))
      .groupBy(purchaseReturnRequestItems.matchAllocationId).for("update");
    const pendingById = new Map(pendingRows.map((row) => [Number(row.allocationId), Number(row.quantity)]));
    const postedById = await netReturnedByAllocation(tx, allocationIds);
    const allocationById = new Map(allocations.map((row) => [Number(row.id), row]));
    let net = money(0);
    let tax = money(0);
    const items = normalizedLines.map((line, index) => {
      const allocation = allocationById.get(line.matchAllocationId)!;
      if (Number(allocation.matchRunId) !== input.matchRunId)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر إنشاء طلب المرتجع",
            why: "أحد تخصيصات المرتجع لا يعود لتشغيل المطابقة الثلاثية المُختار على هذه الفاتورة",
            doThis: "أعد فتح شاشة إنشاء المرتجع واختر تخصيصاتٍ من نفس تشغيل المطابقة المعروض",
          }),
        });
      const invoiceLine = lineById.get(Number(allocation.supplierInvoiceLineId));
      const grnItem = grnById.get(Number(allocation.goodsReceiptItemId));
      if (!invoiceLine || Number(invoiceLine.supplierInvoiceId) !== input.supplierInvoiceId || !grnItem) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر إنشاء طلب المرتجع",
            why: "مصادر المطابقة الثلاثية (أمر الشراء + إذن الاستلام + فاتورة المورد) لا تتّسق فيما بينها",
            doThis: "افتح شاشة المطابقة الثلاثية على الفاتورة وأعد تشغيل المطابقة، ثمّ ابدأ المرتجع من التشغيل الجديد",
          }),
        });
      }
      const available = Number(allocation.matchedBaseQuantity) - (postedById.get(line.matchAllocationId) ?? 0) - (pendingById.get(line.matchAllocationId) ?? 0);
      if (line.baseQuantity > available)
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر إنشاء طلب المرتجع",
            why: "كمية المرتجع على أحد البنود أكبر من المتبقّي غير المحجوز على المطابقة الثلاثية",
            doThis: "افتح البند وخفّض الكمّية لتكون ≤ المتبقّي المعروض في شاشة المطابقة، أو اعتمد مرتجعاتٍ سابقةً أوّلاً",
          }),
        });
      const lineNet = proportionalReturnAmount(invoiceLine.netAmount, line.baseQuantity, Number(invoiceLine.invoicedBaseQuantity));
      const lineTax = proportionalReturnAmount(invoiceLine.taxAmount, line.baseQuantity, Number(invoiceLine.invoicedBaseQuantity));
      net = net.plus(lineNet); tax = tax.plus(lineTax);
      const sourceSnapshot = stableCanonical({
        matchAllocationId: Number(allocation.id),
        supplierInvoiceLineId: Number(invoiceLine.id),
        goodsReceiptItemId: Number(grnItem.id),
        purchaseOrderItemId: Number(grnItem.purchaseOrderItemId),
        variantId: Number(grnItem.variantId),
        matchedBaseQuantity: Number(allocation.matchedBaseQuantity),
        invoiceVersion: Number(invoice.version),
      });
      return {
        lineNo: index + 1,
        allocation,
        invoiceLine,
        grnItem,
        requestedBaseQuantity: line.baseQuantity,
        netAmount: toDbMoney(lineNet),
        taxAmount: toDbMoney(lineTax),
        totalAmount: toDbMoney(lineNet.plus(lineTax)),
        sourceSnapshot,
        sourceHash: sha256(sourceSnapshot),
        reason: line.reason,
      };
    });
    net = round2(net); tax = round2(tax);
    let requestId: number;
    try {
      const result = await tx.insert(purchaseReturnRequests).values({
        requestKey,
        supplierInvoiceId: input.supplierInvoiceId,
        matchRunId: input.matchRunId,
        purchaseOrderId,
        supplierId: Number(invoice.supplierId),
        branchId: Number(invoice.branchId),
        baseInvoiceVersion: input.expectedInvoiceVersion,
        settlement: input.settlement,
        paymentMethod: input.paymentMethod,
        requestedNetAmount: toDbMoney(net),
        requestedTaxAmount: toDbMoney(tax),
        requestedTotalAmount: toDbMoney(net.plus(tax)),
        payloadCanonical: canonical,
        payloadHash,
        evidenceType: input.evidenceType,
        evidenceReference,
        evidenceHash,
        reason,
        pendingGuard: `RETURN:${input.supplierInvoiceId}`,
        requestedBy: actor.userId,
      });
      requestId = extractInsertId(result);
    } catch (error) {
      if (!isDupEntry(error)) throw error;
      // القراءة القفلية current-read: الـSELECT الأول قد يكون ثبّت snapshot قبل أن يلتزم
      // الطلب المنافس، فلا تكفي إعادة SELECT عادية بعد duplicate-key.
      const raced = (
        await tx
          .select()
          .from(purchaseReturnRequests)
          .where(eq(purchaseReturnRequests.requestKey, requestKey))
          .for("update")
          .limit(1)
      )[0];
      if (!raced) throw error;
      assertPurchaseBranch(raced, actor);
      if (!payloadHashMatches(payloadHash, raced.payloadHash)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر تسجيل طلب المرتجع",
            why: "نفس مفتاح الطلب مسجَّل قبل قليل بحمولةٍ مختلفة (بنودٌ أو كمّياتٌ أو مرجعٌ مختلف)",
            doThis: "حدّث الشاشة ليُولَّد مفتاحٌ جديد، ثمّ أعد الحفظ بالبيانات المعروضة أمامك",
          }),
        });
      }
      return {
        requestId: Number(raced.id),
        status: raced.status,
        idempotent: true as const,
      };
    }
    await tx.insert(purchaseReturnRequestItems).values(items.map((item) => ({
      requestId,
      lineNo: item.lineNo,
      supplierInvoiceLineId: Number(item.invoiceLine.id),
      goodsReceiptItemId: Number(item.grnItem.id),
      matchAllocationId: Number(item.allocation.id),
      purchaseOrderItemId: Number(item.grnItem.purchaseOrderItemId),
      variantId: Number(item.grnItem.variantId),
      requestedBaseQuantity: item.requestedBaseQuantity,
      unitPriceIqd: item.invoiceLine.unitPriceIqd,
      netAmount: item.netAmount,
      taxAmount: item.taxAmount,
      totalAmount: item.totalAmount,
      sourceSnapshot: item.sourceSnapshot,
      sourceHash: item.sourceHash,
      reason: item.reason,
    })));
    return { requestId, status: "PENDING" as const, idempotent: false as const };
  });
}

export async function decidePurchaseReturn(input: DecidePurchaseReturnInput, actor: Actor) {
  const key = required(input.decisionKey, "مفتاح القرار", 120);
  const reviewReason = required(input.reviewReason, "سبب القرار", 500);
  const hash = decisionHash(input.requestId, input.action, reviewReason);
  return withTx(async (tx) => {
    const preview = (await tx.select().from(purchaseReturnRequests).where(eq(purchaseReturnRequests.id, input.requestId)).limit(1))[0];
    if (!preview)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر فتح طلب المرتجع",
          why: "الطلب المطلوب بمعرّفه غير موجود، إمّا حُذف أو أُدخل معرّفٌ غير صحيح",
          doThis: "ارجع لقائمة طلبات المرتجع واختر الطلب من القائمة بدل تحرير المعرّف يدوياً",
        }),
      });
    assertPurchaseBranch(preview, actor);
    let cash: Awaited<ReturnType<typeof cashContext>> | null = null;
    if (input.action === "APPROVE" && preview.status === "PENDING" && requiresCashShift(preview.settlement, preview.paymentMethod as PaymentMethod)) {
      cash = await cashContext(tx, Number(preview.branchId), actor, "استرداد مرتجع شراء", "IN", []);
    }
    const lockedPo = input.action === "APPROVE" ? (await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, Number(preview.purchaseOrderId))).for("update").limit(1))[0] : null;
    const lockedSupplier = input.action === "APPROVE" ? (await tx.select().from(suppliers).where(eq(suppliers.id, Number(preview.supplierId))).for("update").limit(1))[0] : null;
    const lockedInvoice = input.action === "APPROVE" ? (await tx.select().from(supplierInvoices).where(eq(supplierInvoices.id, Number(preview.supplierInvoiceId))).for("update").limit(1))[0] : null;
    const request = (await tx.select().from(purchaseReturnRequests).where(eq(purchaseReturnRequests.id, input.requestId)).for("update").limit(1))[0]!;
    // اعتمادُ المرتجع محوُ أثرٍ مُثبَت: applyMovement بـOUT + قيدٌ منشور + إنقاصُ رصيد المورّد.
    assertApprover({ actor: await resolveApprovalActor(tx, actor), trigger: purchaseReturnTrigger(input.action), subject: `مرتجع شراء (طلب ${input.requestId})`, legacy: () => assertIndependentPurchaseReviewer(Number(request.requestedBy), actor.userId) });
    if (request.status !== "PENDING") {
      if (request.decisionKey === key && request.decisionHash === hash) {
        const existingReturn = request.status === "APPROVED"
          ? (await tx.select({ id: purchaseReturns.id }).from(purchaseReturns).where(eq(purchaseReturns.requestId, input.requestId)).for("update").limit(1))[0]
          : null;
        if (request.status === "APPROVED" && !existingReturn) {
          throw new TRPCError({
            code: "CONFLICT",
            message: appErrorMessage({
              what: "تعذّر إعادة محاولة الاعتماد",
              why: "الطلب مسجَّل معتمَداً في القاعدة، لكن لا يحمل معرّفَ مستند المرتجع الفعليّ",
              doThis: "افتح سجلّ التدقيق لمعرّف الطلب، ثمّ اطلب من المدير إعادة الترحيل يدوياً",
            }),
          });
        }
        return { requestId: input.requestId, status: request.status, purchaseReturnId: existingReturn == null ? null : Number(existingReturn.id), idempotent: true as const };
      }
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر حسم طلب المرتجع",
          why: "الطلب حُسم مسبقاً (اعتماداً أو رفضاً)، وحسم القرار لا يتكرّر بمفتاح جديد",
          doThis: "ارجع لقائمة طلبات المرتجع وحدّثها لعرض النتيجة المسجَّلة",
        }),
      });
    }
    if (input.action === "REJECT") {
      await tx.update(purchaseReturnRequests).set({ status: "REJECTED", pendingGuard: null, reviewedBy: actor.userId, reviewedAt: new Date(), reviewReason, decisionKey: key, decisionHash: hash }).where(eq(purchaseReturnRequests.id, input.requestId));
      return { requestId: input.requestId, status: "REJECTED" as const, purchaseReturnId: null, idempotent: false as const };
    }
    const invoice = lockedInvoice;
    if (!invoice || invoice.status !== "POSTED" || Number(invoice.version) !== Number(request.baseInvoiceVersion)) {
      await tx.update(purchaseReturnRequests).set({ status: "STALE", pendingGuard: null, reviewedBy: actor.userId, reviewedAt: new Date(), reviewReason: "تغيّرت فاتورة المورد بعد إنشاء طلب المرتجع", decisionKey: key, decisionHash: hash }).where(eq(purchaseReturnRequests.id, input.requestId));
      return { requestId: input.requestId, status: "STALE" as const, purchaseReturnId: null, idempotent: false as const };
    }
    if (request.settlement === "CREDIT") await assertNoPendingSupplierPayment(tx, Number(invoice.id));
    const matchRun = (await tx.select().from(supplierInvoiceMatchRuns).where(eq(supplierInvoiceMatchRuns.id, Number(request.matchRunId))).for("update").limit(1))[0];
    if (!matchRun || matchRun.outcome === "HOLD")
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر اعتماد المرتجع",
          why: "تشغيل المطابقة الثلاثية المرجعيّ لم يعد صالحاً (رُفض أو انتظر)، ولا يجوز اعتماد مرتجعٍ بلا مطابقةٍ نافذة",
          doThis: "افتح شاشة المطابقة الثلاثية على الفاتورة وأعد تشغيلها، ثمّ ارفض هذا الطلب وأنشئ آخرَ من التشغيل الجديد",
        }),
      });
    const po = lockedPo;
    const supplier = lockedSupplier;
    if (!po || !supplier || !supplier.isActive)
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر اعتماد المرتجع",
          why: "أمر الشراء المرتبط أو المورد نفسه لم يعد موجوداً أو أنّ المورد موقوف",
          doThis: "افتح شاشة الموردين وتحقّق من نشاط المورد، أو ارفض هذا الطلب وأنشئ مرتجعاً من فاتورةٍ لموردٍ نشط",
        }),
      });
    const requestItems = await tx.select().from(purchaseReturnRequestItems).where(eq(purchaseReturnRequestItems.requestId, input.requestId)).orderBy(asc(purchaseReturnRequestItems.lineNo)).for("update");
    const allocationIds = requestItems.map((row) => Number(row.matchAllocationId));
    const allocations = await tx.select().from(supplierInvoiceMatchAllocations).where(inArray(supplierInvoiceMatchAllocations.id, allocationIds)).orderBy(asc(supplierInvoiceMatchAllocations.id)).for("update");
    const allocationById = new Map(allocations.map((row) => [Number(row.id), row]));
    const postedById = await netReturnedByAllocation(tx, allocationIds);
    const poItemIds = requestItems.map((row) => Number(row.purchaseOrderItemId));
    const grnItemIds = requestItems.map((row) => Number(row.goodsReceiptItemId));
    const poItems = await tx.select().from(purchaseOrderItems).where(inArray(purchaseOrderItems.id, poItemIds)).orderBy(asc(purchaseOrderItems.id)).for("update");
    const grnItems = await tx.select().from(goodsReceiptItems).where(inArray(goodsReceiptItems.id, grnItemIds)).orderBy(asc(goodsReceiptItems.id)).for("update");
    const poItemById = new Map(poItems.map((row) => [Number(row.id), row]));
    const grnById = new Map(grnItems.map((row) => [Number(row.id), row]));
    for (const item of requestItems) {
      const allocation = allocationById.get(Number(item.matchAllocationId));
      const grn = grnById.get(Number(item.goodsReceiptItemId));
      if (!allocation || Number(allocation.matchRunId) !== Number(request.matchRunId) || !grn || Number(grn.purchaseOrderItemId) !== Number(item.purchaseOrderItemId))
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر اعتماد المرتجع",
            why: "أحد مصادر المطابقة على المرتجع (تخصيص أو إذن استلام) تغيّر بعد تسجيل الطلب فلم يعد يطابقه",
            doThis: "ارفض هذا الطلب وأعد إنشاء المرتجع من صفحة فاتورة المورد بمصادرها الحاليّة",
          }),
        });
      if (Number(item.requestedBaseQuantity) + (postedById.get(Number(item.matchAllocationId)) ?? 0) > Number(allocation.matchedBaseQuantity))
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر اعتماد المرتجع",
            why: "كمية المرتجع مع ما اعتُمد قبله تتجاوز المتبقّي على تخصيص المطابقة الثلاثية",
            doThis: "ارفض هذا الطلب وأنشئ مرتجعاً جديداً بكمّياتٍ ≤ المتبقّي المعروض على شاشة المطابقة",
          }),
        });
      if (Number(item.requestedBaseQuantity) + Number(grn.reversedBaseQuantity) + Number(grn.returnedBaseQuantity) > Number(grn.acceptedBaseQuantity))
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر اعتماد المرتجع",
            why: "كمية المرتجع مع ما رُدّ وعُكس سابقاً تتجاوز الكمية المقبولة على إذن الاستلام",
            doThis: "ارفض هذا الطلب وأنشئ مرتجعاً جديداً بكمّياتٍ ≤ المتبقّي على إذن الاستلام",
          }),
        });
    }
    const variantIds = Array.from(new Set(requestItems.map((row) => Number(row.variantId)))).sort((a, b) => a - b);
    await lockInventoryVariants(tx, variantIds);
    await ensureBranchStockRows(tx, variantIds, Number(request.branchId));
    await tx.select({ id: branchStock.id }).from(branchStock).where(and(eq(branchStock.branchId, Number(request.branchId)), inArray(branchStock.variantId, variantIds))).orderBy(asc(branchStock.variantId)).for("update");
    const variants = await tx.select({ id: productVariants.id, costPrice: productVariants.costPrice, productName: products.name, variantName: productVariants.variantName })
      .from(productVariants).innerJoin(products, eq(products.id, productVariants.productId)).where(inArray(productVariants.id, variantIds)).orderBy(asc(productVariants.id)).for("update");
    const variantById = new Map(variants.map((row) => [Number(row.id), row]));
    const unitIds = Array.from(new Set(poItems.map((row) => Number(row.productUnitId)).filter(Boolean)));
    const units = unitIds.length ? await tx.select({ id: productUnits.id, name: productUnits.unitName }).from(productUnits).where(inArray(productUnits.id, unitIds)) : [];
    const unitById = new Map(units.map((row) => [Number(row.id), row.name]));
    const net = round2(request.requestedNetAmount); const tax = round2(request.requestedTaxAmount); const total = round2(request.requestedTotalAmount);
    const priorCreditIqd = invoice.currency === "USD" && request.settlement === "CREDIT"
      ? await netInvoiceCreditReturns(tx, Number(invoice.id))
      : money(0);
    const usdCreditAmount = invoice.currency === "USD" && request.settlement === "CREDIT"
      ? usdReturnAmountWithFinalResidual(invoice.usdTotal, invoice.totalAmount, total, priorCreditIqd)
      : money(0);
    const returnNumber = `PR-${request.branchId}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${createHash("sha256").update(request.requestKey).digest("hex").slice(0, 16).toUpperCase()}`;
    const inserted = await tx.insert(purchaseReturns).values({
      returnNumber,
      clientRequestId: `governed:${request.requestKey}`,
      origin: "NATIVE",
      status: "POSTED",
      requestId: input.requestId,
      supplierInvoiceId: Number(request.supplierInvoiceId),
      matchRunId: Number(request.matchRunId),
      purchaseOrderId: Number(request.purchaseOrderId),
      supplierId: Number(request.supplierId),
      branchId: Number(request.branchId),
      settlement: request.settlement,
      paymentMethod: request.paymentMethod,
      netAmount: toDbMoney(net), taxAmount: toDbMoney(tax), totalAmount: toDbMoney(total),
      // MySQL checks are immediate, even inside this transaction. Keep the new
      // head internally consistent until the CASH receipt exists, then switch
      // amount + receipt atomically below. Nothing can observe this placeholder
      // before commit, and any later failure rolls the complete return back.
      cashRefundAmount: "0.00",
      creditOffsetAmount: toDbMoney(total),
      reason: request.reason,
      payloadCanonical: request.payloadCanonical,
      payloadHash: request.payloadHash,
      evidenceType: request.evidenceType,
      evidenceReference: request.evidenceReference,
      postedBy: actor.userId,
      postedAt: new Date(),
      createdBy: actor.userId,
      createdByNameSnapshot: await actorName(tx, actor.userId),
    });
    const purchaseReturnId = extractInsertId(inserted);
    let inventoryBook = money(0);
    for (const item of requestItems) {
      const poItem = poItemById.get(Number(item.purchaseOrderItemId))!;
      const grn = grnById.get(Number(item.goodsReceiptItemId))!;
      const variant = variantById.get(Number(item.variantId));
      if (!variant)
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر ترحيل المرتجع",
            why: "متغيّر الصنف المرتبط ببند المرتجع لم يعد موجوداً في قاعدة البيانات",
            doThis: "ارفض هذا الطلب واطلب من المدير التحقّق من تعديلات كتالوج المنتجات الأخيرة",
          }),
        });
      const quantity = money(poItem.quantity).times(Number(item.requestedBaseQuantity)).dividedBy(Number(poItem.baseQuantity));
      const movement = await applyMovement(tx, { variantId: Number(item.variantId), branchId: Number(request.branchId), baseQuantity: Number(item.requestedBaseQuantity), movementType: "OUT", referenceType: "PURCHASE_RETURN", referenceId: purchaseReturnId, createdBy: actor.userId });
      if (movement.movementId <= 0)
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر ترحيل المرتجع",
            why: "محرّك المخزون لم يُنتج حركةً فعليّة لأحد البنود (رصيدٌ صفريّ أو صنفٌ لا يمسّ المخزون)",
            doThis: "ارفض هذا الطلب واطلب من المدير التحقّق من نوع الصنف (خدمة/باندل) في كتالوج المنتجات",
          }),
        });
      await tx.insert(purchaseReturnItems).values({
        purchaseReturnId,
        purchaseOrderItemId: Number(item.purchaseOrderItemId),
        supplierInvoiceLineId: Number(item.supplierInvoiceLineId),
        goodsReceiptItemId: Number(item.goodsReceiptItemId),
        matchAllocationId: Number(item.matchAllocationId),
        variantId: Number(item.variantId),
        productUnitId: poItem.productUnitId == null ? null : Number(poItem.productUnitId),
        quantity: toDbQty(quantity), baseQuantity: Number(item.requestedBaseQuantity),
        unitPrice: item.unitPriceIqd, lineTotal: item.totalAmount,
        inventoryMovementId: movement.movementId,
        productNameSnapshot: variant.productName,
        variantNameSnapshot: variant.variantName,
        unitNameSnapshot: poItem.productUnitId == null ? null : unitById.get(Number(poItem.productUnitId)) ?? null,
      });
      const poUpdated = await tx.update(purchaseOrderItems).set({ returnedBaseQuantity: sql`${purchaseOrderItems.returnedBaseQuantity} + ${item.requestedBaseQuantity}` })
        .where(and(eq(purchaseOrderItems.id, Number(item.purchaseOrderItemId)), sql`${purchaseOrderItems.returnedBaseQuantity} + ${item.requestedBaseQuantity} <= ${purchaseOrderItems.receivedBaseQuantity}`));
      const grnUpdated = await tx.update(goodsReceiptItems).set({ returnedBaseQuantity: sql`${goodsReceiptItems.returnedBaseQuantity} + ${item.requestedBaseQuantity}` })
        .where(and(eq(goodsReceiptItems.id, Number(item.goodsReceiptItemId)), sql`${goodsReceiptItems.returnedBaseQuantity} + ${goodsReceiptItems.reversedBaseQuantity} + ${item.requestedBaseQuantity} <= ${goodsReceiptItems.acceptedBaseQuantity}`));
      if (extractAffectedRows(poUpdated) !== 1 || extractAffectedRows(grnUpdated) !== 1)
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر ترحيل المرتجع",
            why: "الكمية المتاحة للإرجاع تغيّرت على أمر الشراء أو على إذن الاستلام بين لحظة الاعتماد وحفظ الأثر",
            doThis: "ارفض هذا الطلب وأعد إنشاء مرتجعٍ جديد بالكميات المتاحة الحاليّة",
          }),
        });
      inventoryBook = inventoryBook.plus(money(variant.costPrice).times(Number(item.requestedBaseQuantity)));
    }
    inventoryBook = round2(inventoryBook);
    const variance = round2(inventoryBook.minus(net));
    const source = { roleDebits: { AP: total, ...(variance.gt(0) ? { PURCHASE_PRICE_VARIANCE: variance } : {}) }, roleCredits: { INVENTORY: inventoryBook, ...(tax.gt(0) ? { TAX_PAYABLE: tax } : {}), ...(variance.lt(0) ? { PURCHASE_PRICE_VARIANCE: variance.abs() } : {}) } };
    const dedupeKey = `PURCHASE_RETURN:${purchaseReturnId}`;
    await postEntry(tx, {
      entryType: "RETURN", branchId: Number(request.branchId), purchaseOrderId: Number(request.purchaseOrderId), supplierId: Number(request.supplierId), purchaseLiabilityAccount: "AP",
      cost: inventoryBook.neg(), taxAmount: tax.neg(), amount: total.neg(), profit: variance.neg(), createdBy: actor.userId, dedupeKey, notes: request.reason,
      postingIntent: createPostingIntent("RETURN_PURCHASE_INVENTORY", "RETURN", [debitLine("AP", total), ...(variance.gt(0) ? [debitLine("PURCHASE_PRICE_VARIANCE", variance)] : []), creditLine("INVENTORY", inventoryBook), ...(tax.gt(0) ? [creditLine("TAX_PAYABLE", tax)] : []), ...(variance.lt(0) ? [creditLine("PURCHASE_PRICE_VARIANCE", variance.abs())] : [])], source), postingSourceComponents: source,
    });
    await adjustSupplierBalance(tx, Number(request.supplierId), total.neg());
    if (invoice.currency === "USD" && request.settlement === "CREDIT") {
      await adjustSupplierBalanceUsd(tx, Number(request.supplierId), usdCreditAmount.neg());
    }
    const accountingEntryId = await entryId(tx, dedupeKey);
    let cashReceiptId: number | null = null;
    if (request.settlement === "CASH") {
      if (request.paymentMethod === "CASH" && !cash) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر قفل مصدر استرداد المورد" });
      const receipt = await tx.insert(receipts).values({ branchId: Number(request.branchId), shiftId: cash?.shiftId ?? null, cashBucket: cash?.cashBucket ?? null, direction: "IN", amount: toDbMoney(total), paymentMethod: request.paymentMethod, referenceNumber: `PURCHASE-RETURN:${purchaseReturnId}`, partyType: "SUPPLIER", partyId: Number(request.supplierId), description: `استرداد مرتجع ${returnNumber} — دليل ${request.evidenceReference}`, status: "COMPLETED", approvalStatus: "APPROVED", approvedBy: actor.userId, approvedAt: new Date(), createdBy: actor.userId });
      cashReceiptId = extractInsertId(receipt);
      const asset = paymentAssetRole(request.paymentMethod, cash?.cashBucket ?? null, "IN");
      const cashSource = { roleDebits: { [asset]: total }, roleCredits: { AP: total } };
      await postEntry(tx, { entryType: "PAYMENT_IN", branchId: Number(request.branchId), purchaseOrderId: Number(request.purchaseOrderId), supplierId: Number(request.supplierId), receiptId: cashReceiptId, amount: total, paymentMethod: request.paymentMethod, createdBy: actor.userId, dedupeKey: `PURCHASE_RETURN_REFUND:${purchaseReturnId}`, postingIntent: createPostingIntent("PAYMENT_IN_SUPPLIER_REFUND", "PAYMENT_IN", [debitLine(asset, total), creditLine("AP", total)], cashSource), postingSourceComponents: cashSource });
      await adjustSupplierBalance(tx, Number(request.supplierId), total);
    }
    if (request.settlement === "CREDIT") await refreshInvoiceCreditState(tx, invoice);
    if (request.settlement === "CASH" && cashReceiptId == null) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر ربط إيصال استرداد المورد بالمرتجع" });
    }
    const finalized = await tx.update(purchaseReturns).set({
      accountingEntryId,
      cashRefundReceiptId: cashReceiptId,
      cashRefundAmount: request.settlement === "CASH" ? toDbMoney(total) : "0.00",
      creditOffsetAmount: request.settlement === "CREDIT" ? toDbMoney(total) : "0.00",
    }).where(eq(purchaseReturns.id, purchaseReturnId));
    if (extractAffectedRows(finalized) !== 1) {
      // Codex #965 P2: الشرط هنا يقيس `UPDATE purchaseReturns` (صفّ المرتجع نفسه)، لا
      // أرصدة المورّد أو الفاتورة. صياغةُ `doThis` القديمة كانت تُرسل الموظّف إلى المكان
      // الخطأ. الرسالةُ الآن تُشير إلى ما فشل فعلاً.
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر تثبيت تسوية مرتجع الشراء",
          why: "لم يُحدَّث صفّ `purchaseReturns` بعد اعتماد التسوية — التزامنُ سباقٌ نادر أو الصفّ اختفى بين لحظة الإدخال والحفظ",
          doThis: "أعد إنشاء مرتجع الشراء من نفس أمر الشراء وفاتورته، وإن تكرّر الخطأ ارفض هذا الطلب وأبلغ فريق الدعم",
        }),
      });
    }
    await tx.update(purchaseReturnRequests).set({ status: "APPROVED", pendingGuard: null, reviewedBy: actor.userId, reviewedAt: new Date(), reviewReason, decisionKey: key, decisionHash: hash, appliedAt: new Date() }).where(eq(purchaseReturnRequests.id, input.requestId));
    return { requestId: input.requestId, status: "APPROVED" as const, purchaseReturnId, idempotent: false as const };
  });
}

export async function requestPurchaseReturnReversal(input: RequestPurchaseReturnReversalInput, actor: Actor) {
  const requestKey = required(input.requestKey, "مفتاح الطلب", 120);
  const reason = required(input.reason, "سبب العكس", 500);
  const evidenceReference = required(input.evidenceReference, "مرجع الدليل", 500);
  if (!input.lines.length)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إنشاء طلب عكس المرتجع",
        why: "الطلب وصل بلا أيّ بند عكس",
        doThis: "أضف بنداً واحداً على الأقل في جدول بنود العكس بكميّته، قبل الحفظ",
      }),
    });
  positiveUnique(input.lines.map((line) => line.purchaseReturnItemId), "بند المرتجع");
  const lines = [...input.lines].map((line) => {
    if (!Number.isSafeInteger(line.baseQuantity) || line.baseQuantity <= 0)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر إنشاء طلب عكس المرتجع",
          why: "أحد البنود يحمل كمية عكسٍ غير موجبة أو ليست عدداً صحيحاً",
          doThis: "افتح البند المتضرِّر وعدّل الكمية لتكون عدداً صحيحاً أكبر من صفر بالوحدة الأساس",
        }),
      });
    return { ...line, reason: line.reason?.trim() || null };
  }).sort((a, b) => a.purchaseReturnItemId - b.purchaseReturnItemId);
  const canonical = stableCanonical({ purchaseReturnId: input.purchaseReturnId, expectedReturnVersion: input.expectedReturnVersion, evidenceType: input.evidenceType, evidenceReference, reason, lines });
  const payloadHash = sha256(canonical);
  return withTx(async (tx) => {
    const replay = (await tx.select().from(purchaseReturnReversalRequests).where(eq(purchaseReturnReversalRequests.requestKey, requestKey)).limit(1))[0];
    if (replay) {
      assertPurchaseBranch(replay, actor);
      if (!payloadHashMatches(payloadHash, replay.payloadHash))
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر تسجيل طلب عكس المرتجع",
            why: "نفس مفتاح الطلب مسجَّل قبل قليل بحمولةٍ مختلفة (بنودٌ أو كمّياتٌ أو مرجعٌ مختلف)",
            doThis: "حدّث الشاشة ليُولَّد مفتاحٌ جديد، ثمّ أعد الحفظ بالبيانات المعروضة أمامك",
          }),
        });
      return { requestId: Number(replay.id), status: replay.status, idempotent: true as const };
    }
    const purchaseReturn = (await tx.select().from(purchaseReturns).where(eq(purchaseReturns.id, input.purchaseReturnId)).for("update").limit(1))[0];
    if (!purchaseReturn)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر فتح مستند المرتجع",
          why: "مرتجع الشراء المطلوب بمعرّفه غير موجود، إمّا حُذف أو أُدخل معرّفٌ غير صحيح",
          doThis: "ارجع لقائمة مرتجعات الشراء واختر المرتجع من القائمة بدل تحرير المعرّف يدوياً",
        }),
      });
    assertPurchaseBranch(purchaseReturn, actor); assertExpectedVersion(Number(purchaseReturn.version), input.expectedReturnVersion, "مرتجع الشراء");
    if (purchaseReturn.origin !== "NATIVE" || purchaseReturn.status === "REVERSED")
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر إنشاء طلب عكس المرتجع",
          why: "المرتجع مستوردٌ من نظامٍ خارجيّ أو معكوسٌ بالفعل — لا يُعكس ما نشأ خارج المستودع ولا ما عُكس سابقاً",
          doThis: "افتح شاشة المرتجع لعرض حالته، وإن كان مستوَرداً فتراجع مع مصدره الخارجيّ",
        }),
      });
    const itemIds = lines.map((line) => line.purchaseReturnItemId);
    const items = await tx.select().from(purchaseReturnItems).where(inArray(purchaseReturnItems.id, itemIds)).orderBy(asc(purchaseReturnItems.id)).for("update");
    if (items.length !== itemIds.length || items.some((item) => Number(item.purchaseReturnId) !== input.purchaseReturnId))
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر إنشاء طلب عكس المرتجع",
          why: "بعض البنود المرسلة للعكس لا تخصّ مستند المرتجع المعروض (بندٌ ملغيٌّ أو بندُ مرتجعٍ آخر)",
          doThis: "أعد فتح شاشة العكس من مستند المرتجع لتحميل بنوده الحاليّة، ثمّ اختر البنود منه",
        }),
      });
    const reversed = await tx.select({ itemId: purchaseReturnReversalItems.purchaseReturnItemId, quantity: sql<string>`COALESCE(SUM(${purchaseReturnReversalItems.baseQuantity}),0)` }).from(purchaseReturnReversalItems).where(inArray(purchaseReturnReversalItems.purchaseReturnItemId, itemIds)).groupBy(purchaseReturnReversalItems.purchaseReturnItemId).for("update");
    const reversedById = new Map(reversed.map((row) => [Number(row.itemId), Number(row.quantity)]));
    const pending = await tx.select({ itemId: purchaseReturnReversalRequestItems.purchaseReturnItemId, quantity: sql<string>`COALESCE(SUM(${purchaseReturnReversalRequestItems.baseQuantity}),0)` }).from(purchaseReturnReversalRequestItems)
      .innerJoin(purchaseReturnReversalRequests, eq(purchaseReturnReversalRequests.id, purchaseReturnReversalRequestItems.requestId)).where(and(eq(purchaseReturnReversalRequests.status, "PENDING"), inArray(purchaseReturnReversalRequestItems.purchaseReturnItemId, itemIds))).groupBy(purchaseReturnReversalRequestItems.purchaseReturnItemId).for("update");
    const pendingById = new Map(pending.map((row) => [Number(row.itemId), Number(row.quantity)]));
    const itemById = new Map(items.map((row) => [Number(row.id), row]));
    for (const line of lines) {
      const item = itemById.get(line.purchaseReturnItemId)!;
      if (line.baseQuantity + (reversedById.get(line.purchaseReturnItemId) ?? 0) + (pendingById.get(line.purchaseReturnItemId) ?? 0) > Number(item.baseQuantity))
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر إنشاء طلب عكس المرتجع",
            why: "كمية العكس مع ما عُكس وما هو معلَّق سابقاً تتجاوز كمّية بند المرتجع الأصليّ",
            doThis: "افتح البند وخفّض الكمّية لتكون ≤ المتبقّي غير المحجوز، أو انتظر حسم طلبات العكس المعلَّقة أوّلاً",
          }),
        });
    }
    const inserted = await tx.insert(purchaseReturnReversalRequests).values({ requestKey, purchaseReturnId: input.purchaseReturnId, branchId: Number(purchaseReturn.branchId), baseReturnVersion: input.expectedReturnVersion, payloadCanonical: canonical, payloadHash, evidenceType: input.evidenceType, evidenceReference, reason, pendingGuard: `RETURN-REV:${input.purchaseReturnId}`, requestedBy: actor.userId });
    const requestId = extractInsertId(inserted);
    await tx.insert(purchaseReturnReversalRequestItems).values(lines.map((line) => ({ requestId, purchaseReturnItemId: line.purchaseReturnItemId, baseQuantity: line.baseQuantity, reason: line.reason })));
    return { requestId, status: "PENDING" as const, idempotent: false as const };
  });
}

export async function decidePurchaseReturnReversal(input: DecidePurchaseReturnReversalInput, actor: Actor) {
  const key = required(input.decisionKey, "مفتاح القرار", 120);
  const reviewReason = required(input.reviewReason, "سبب القرار", 500);
  const hash = decisionHash(input.requestId, input.action, reviewReason);
  return withTx(async (tx) => {
    const preview = (await tx.select().from(purchaseReturnReversalRequests).where(eq(purchaseReturnReversalRequests.id, input.requestId)).limit(1))[0];
    if (!preview)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر فتح طلب عكس المرتجع",
          why: "الطلب المطلوب بمعرّفه غير موجود، إمّا حُذف أو أُدخل معرّفٌ غير صحيح",
          doThis: "ارجع لقائمة طلبات عكس المرتجع واختر الطلب من القائمة بدل تحرير المعرّف يدوياً",
        }),
      });
    assertPurchaseBranch(preview, actor);
    const previewReturn = (await tx.select().from(purchaseReturns).where(eq(purchaseReturns.id, Number(preview.purchaseReturnId))).limit(1))[0];
    const originalReturnRequest = previewReturn?.requestId == null ? null : (await tx.select({ requestedBy: purchaseReturnRequests.requestedBy }).from(purchaseReturnRequests).where(eq(purchaseReturnRequests.id, Number(previewReturn.requestId))).limit(1))[0];
    let cash: Awaited<ReturnType<typeof cashContext>> | null = null;
    if (input.action === "APPROVE" && preview.status === "PENDING" && previewReturn && requiresCashShift(previewReturn.settlement, previewReturn.paymentMethod as PaymentMethod)) {
      cash = await cashContext(
        tx,
        Number(previewReturn.branchId),
        actor,
        "إعادة استرداد مرتجع للمورد",
        "OUT",
        [preview.requestedBy, previewReturn.createdBy, previewReturn.postedBy, originalReturnRequest?.requestedBy],
      );
    }
    const lockedPo = input.action === "APPROVE" && previewReturn ? (await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, Number(previewReturn.purchaseOrderId))).for("update").limit(1))[0] : null;
    const lockedSupplier = input.action === "APPROVE" && previewReturn ? (await tx.select().from(suppliers).where(eq(suppliers.id, Number(previewReturn.supplierId))).for("update").limit(1))[0] : null;
    const lockedInvoice = input.action === "APPROVE" && previewReturn ? (await tx.select().from(supplierInvoices).where(eq(supplierInvoices.id, Number(previewReturn.supplierInvoiceId))).for("update").limit(1))[0] : null;
    const lockedReturn = input.action === "APPROVE" && previewReturn ? (await tx.select().from(purchaseReturns).where(eq(purchaseReturns.id, Number(previewReturn.id))).for("update").limit(1))[0] : null;
    const request = (await tx.select().from(purchaseReturnReversalRequests).where(eq(purchaseReturnReversalRequests.id, input.requestId)).for("update").limit(1))[0]!;
    // عكسُ المرتجع **يُخرج نقداً فعلاً**: إيصال OUT يُصنَّف otherCashOut في تسوية الوردية
    // فيُنقص expectedCash وZ-report. ⇒ المالك حصراً.
    assertApprover({ actor: await resolveApprovalActor(tx, actor), trigger: purchaseReturnReversalTrigger(input.action), subject: `عكس مرتجع شراء (طلب ${input.requestId})`, legacy: () => assertIndependentPurchaseReviewer(Number(request.requestedBy), actor.userId) });
    if (request.status !== "PENDING") {
      if (request.decisionKey === key && request.decisionHash === hash)
        return { requestId: input.requestId, status: request.status, reversalId: null, idempotent: true as const };
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر حسم طلب عكس المرتجع",
          why: "الطلب حُسم مسبقاً (اعتماداً أو رفضاً) بمفتاح قرارٍ مختلف، وحسم القرار لا يتكرّر",
          doThis: "ارجع لقائمة طلبات العكس وحدّثها لعرض النتيجة المسجَّلة",
        }),
      });
    }
    if (input.action === "REJECT") { await tx.update(purchaseReturnReversalRequests).set({ status: "REJECTED", pendingGuard: null, reviewedBy: actor.userId, reviewedAt: new Date(), reviewReason, decisionKey: key, decisionHash: hash }).where(eq(purchaseReturnReversalRequests.id, input.requestId)); return { requestId: input.requestId, status: "REJECTED" as const, reversalId: null, idempotent: false as const }; }
    const purchaseReturn = lockedReturn;
    if (!purchaseReturn)
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر اعتماد عكس المرتجع",
          why: "مستند المرتجع الأصليّ لم يعد موجوداً — قد يكون حُذف أو نُقل بين لحظة إنشاء طلب العكس وحسمه",
          doThis: "ارفض هذا الطلب واطلب من المدير مراجعة سجلّ التدقيق لمستند المرتجع الأصليّ",
        }),
      });
    if (purchaseReturn.status === "REVERSED" || Number(purchaseReturn.version) !== Number(request.baseReturnVersion)) {
      await tx.update(purchaseReturnReversalRequests).set({ status: "STALE", pendingGuard: null, reviewedBy: actor.userId, reviewedAt: new Date(), reviewReason: "تغيّر مرتجع الشراء بعد إنشاء طلب العكس", decisionKey: key, decisionHash: hash }).where(eq(purchaseReturnReversalRequests.id, input.requestId));
      return { requestId: input.requestId, status: "STALE" as const, reversalId: null, idempotent: false as const };
    }
    if (!lockedPo || !lockedSupplier || !lockedSupplier.isActive)
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر اعتماد عكس المرتجع",
          why: "أمر الشراء المرتبط أو المورد نفسه لم يعد موجوداً أو أنّ المورد موقوف",
          doThis: "افتح شاشة الموردين وتحقّق من نشاط المورد، أو ارفض هذا الطلب واطلب مراجعة الرصيد يدوياً",
        }),
      });
    const invoice = lockedInvoice;
    if (!invoice || invoice.status !== "POSTED")
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر اعتماد عكس المرتجع",
          why: "فاتورة المورد المرتبطة لم تعد بحالة «مُرحَّلة» (رُدّت أو أُلغيت أو حُذفت)",
          doThis: "افتح فاتورة المورد لعرض حالتها، ثمّ ارفض هذا الطلب إن لم تعد الفاتورة قابلةً للعكس",
        }),
      });
    if (purchaseReturn.settlement === "CREDIT") await assertNoPendingSupplierPayment(tx, Number(invoice.id));
    const reqItems = await tx.select().from(purchaseReturnReversalRequestItems).where(eq(purchaseReturnReversalRequestItems.requestId, input.requestId)).orderBy(asc(purchaseReturnReversalRequestItems.id)).for("update");
    const itemIds = reqItems.map((row) => Number(row.purchaseReturnItemId));
    const items = await tx.select().from(purchaseReturnItems).where(inArray(purchaseReturnItems.id, itemIds)).orderBy(asc(purchaseReturnItems.id)).for("update");
    const itemById = new Map(items.map((row) => [Number(row.id), row]));
    const reversed = await tx.select({ itemId: purchaseReturnReversalItems.purchaseReturnItemId, quantity: sql<string>`COALESCE(SUM(${purchaseReturnReversalItems.baseQuantity}),0)`, amount: sql<string>`COALESCE(SUM(${purchaseReturnReversalItems.totalAmount}),0)` }).from(purchaseReturnReversalItems).where(inArray(purchaseReturnReversalItems.purchaseReturnItemId, itemIds)).groupBy(purchaseReturnReversalItems.purchaseReturnItemId).for("update");
    const reversedById = new Map(reversed.map((row) => [Number(row.itemId), Number(row.quantity)]));
    const reversedAmountById = new Map(reversed.map((row) => [Number(row.itemId), money(row.amount)]));
    for (const row of reqItems) {
      const item = itemById.get(Number(row.purchaseReturnItemId));
      if (!item || Number(item.purchaseReturnId) !== Number(purchaseReturn.id) || Number(row.baseQuantity) + (reversedById.get(Number(row.purchaseReturnItemId)) ?? 0) > Number(item.baseQuantity))
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر اعتماد عكس المرتجع",
            why: "كمية العكس على أحد البنود لم تعد متاحة (عُكس عليها بعد إنشاء الطلب أو أنّها تخصّ مرتجعاً آخر)",
            doThis: "ارفض هذا الطلب وأنشئ طلب عكسٍ جديداً بالكميات المتاحة الحاليّة",
          }),
        });
    }
    const variantIds = Array.from(new Set(items.map((row) => Number(row.variantId)))).sort((a, b) => a - b);
    await lockInventoryVariants(tx, variantIds); await ensureBranchStockRows(tx, variantIds, Number(purchaseReturn.branchId));
    await tx.select({ id: branchStock.id }).from(branchStock).where(and(eq(branchStock.branchId, Number(purchaseReturn.branchId)), inArray(branchStock.variantId, variantIds))).orderBy(asc(branchStock.variantId)).for("update");
    const variants = await tx.select({ id: productVariants.id, costPrice: productVariants.costPrice }).from(productVariants).where(inArray(productVariants.id, variantIds)).orderBy(asc(productVariants.id)).for("update");
    const costByVariant = new Map(variants.map((row) => [Number(row.id), money(row.costPrice)]));
    const plannedLineTotals = new Map<number, Decimal>();
    let total = money(0); let inventory = money(0);
    for (const row of reqItems) { const item = itemById.get(Number(row.purchaseReturnItemId))!; const lineTotal = reversalAmountWithFinalResidual(item.lineTotal, Number(item.baseQuantity), Number(row.baseQuantity), reversedById.get(Number(item.id)) ?? 0, reversedAmountById.get(Number(item.id)) ?? money(0)); plannedLineTotals.set(Number(item.id), lineTotal); total = total.plus(lineTotal); inventory = inventory.plus((costByVariant.get(Number(item.variantId)) ?? money(0)).times(Number(row.baseQuantity))); }
    total = round2(total); inventory = round2(inventory);
    const originalTotal = money(purchaseReturn.totalAmount); const originalTax = money(purchaseReturn.taxAmount);
    const priorHeader = (await tx.select({ total: sql<string>`COALESCE(SUM(${purchaseReturnReversals.totalAmount}),0)`, tax: sql<string>`COALESCE(SUM(${purchaseReturnReversals.taxAmount}),0)` }).from(purchaseReturnReversals).where(eq(purchaseReturnReversals.purchaseReturnId, Number(purchaseReturn.id))).for("update"))[0];
    const allOriginalQuantity = (await tx.select({ quantity: sql<string>`COALESCE(SUM(${purchaseReturnItems.baseQuantity}),0)` }).from(purchaseReturnItems).where(eq(purchaseReturnItems.purchaseReturnId, Number(purchaseReturn.id))).for("update"))[0];
    const allReversedQuantity = (await tx.select({ quantity: sql<string>`COALESCE(SUM(${purchaseReturnReversalItems.baseQuantity}),0)` }).from(purchaseReturnReversalItems).innerJoin(purchaseReturnItems, eq(purchaseReturnItems.id, purchaseReturnReversalItems.purchaseReturnItemId)).where(eq(purchaseReturnItems.purchaseReturnId, Number(purchaseReturn.id))).for("update"))[0];
    const becomesFullyReversed = Number(allReversedQuantity?.quantity ?? 0) + reqItems.reduce((sum, row) => sum + Number(row.baseQuantity), 0) === Number(allOriginalQuantity?.quantity ?? 0);
    if (becomesFullyReversed) total = round2(Decimal.max(originalTotal.minus(priorHeader?.total ?? 0), 0));
    const tax = becomesFullyReversed ? round2(Decimal.max(originalTax.minus(priorHeader?.tax ?? 0), 0)) : (originalTotal.gt(0) ? round2(originalTax.times(total).dividedBy(originalTotal)) : money(0));
    const net = round2(total.minus(tax));
    const priorCreditIqd = invoice.currency === "USD" && purchaseReturn.settlement === "CREDIT"
      ? await netInvoiceCreditReturns(tx, Number(invoice.id))
      : money(0);
    const usdCreditReversalAmount = invoice.currency === "USD" && purchaseReturn.settlement === "CREDIT"
      ? usdReversalAmountWithFinalResidual(invoice.usdTotal, invoice.totalAmount, total, priorCreditIqd)
      : money(0);
    const reversalNumber = `PRR-${purchaseReturn.branchId}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${createHash("sha256").update(request.requestKey).digest("hex").slice(0, 16).toUpperCase()}`;
    const dedupeKey = `PURCHASE_RETURN_REVERSAL_REQUEST:${input.requestId}`;
    const variance = round2(inventory.minus(net));
    const source = { roleDebits: { INVENTORY: inventory, ...(tax.gt(0) ? { TAX_PAYABLE: tax } : {}), ...(variance.lt(0) ? { PURCHASE_PRICE_VARIANCE: variance.abs() } : {}) }, roleCredits: { AP: total, ...(variance.gt(0) ? { PURCHASE_PRICE_VARIANCE: variance } : {}) } };
    if (purchaseReturn.settlement === "CASH") {
      if (purchaseReturn.paymentMethod === "CASH") {
        if (cash?.cashBucket === "TREASURY") {
          if (!cash.treasuryApproval) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "إثبات اعتماد عكس مرتجع الشراء من الخزينة مفقود" });
          await assertApprovedTreasuryOutAvailable(tx, { branchId: Number(purchaseReturn.branchId), amount: total, operation: "إعادة استرداد مرتجع للمورد" }, cash.treasuryApproval);
        } else if (cash?.cashBucket === "DRAWER") {
          await assertCashOutAvailable(tx, { branchId: Number(purchaseReturn.branchId), shiftId: cash.shiftId, cashBucket: "DRAWER", amount: total, operation: "إعادة استرداد مرتجع للمورد" });
        } else {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "مصدر دفع عكس مرتجع الشراء النقدي مفقود" });
        }
      } else {
        assertNonPhysicalOutReceipt({ classification: "NON_CASH_METHOD", paymentMethod: purchaseReturn.paymentMethod, cashBucket: null, approvalStatus: "APPROVED", operation: "إعادة استرداد مرتجع للمورد" });
      }
    }
    await postEntry(tx, { entryType: "RETURN", branchId: Number(purchaseReturn.branchId), purchaseOrderId: Number(purchaseReturn.purchaseOrderId), supplierId: Number(purchaseReturn.supplierId), purchaseLiabilityAccount: "AP", cost: inventory, taxAmount: tax, amount: total, profit: variance, createdBy: actor.userId, dedupeKey, notes: request.reason, postingIntent: createPostingIntent("RETURN_PURCHASE_INVENTORY", "RETURN", [debitLine("INVENTORY", inventory), ...(tax.gt(0) ? [debitLine("TAX_PAYABLE", tax)] : []), ...(variance.lt(0) ? [debitLine("PURCHASE_PRICE_VARIANCE", variance.abs())] : []), creditLine("AP", total), ...(variance.gt(0) ? [creditLine("PURCHASE_PRICE_VARIANCE", variance)] : [])], source), postingSourceComponents: source });
    const accountingEntryId = await entryId(tx, dedupeKey);
    let cashReceiptId: number | null = null;
    if (purchaseReturn.settlement === "CASH") {
      if (purchaseReturn.paymentMethod === "CASH" && !cash) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر قفل مصدر دفع عكس المرتجع" });
      const receipt = await tx.insert(receipts).values({ branchId: Number(purchaseReturn.branchId), shiftId: cash?.shiftId ?? null, cashBucket: cash?.cashBucket ?? null, direction: "OUT", amount: toDbMoney(total), paymentMethod: purchaseReturn.paymentMethod, referenceNumber: `PURCHASE-RETURN-REV:${input.requestId}`, partyType: "SUPPLIER", partyId: Number(purchaseReturn.supplierId), description: `سداد عكس المرتجع ${purchaseReturn.returnNumber} — دليل ${request.evidenceReference}`, status: "COMPLETED", approvalStatus: "APPROVED", approvedBy: actor.userId, approvedAt: new Date(), createdBy: actor.userId });
      cashReceiptId = extractInsertId(receipt);
      const asset = paymentAssetRole(purchaseReturn.paymentMethod, cash?.cashBucket ?? null, "OUT");
      const cashSource = { roleDebits: { AP: total }, roleCredits: { [asset]: total } };
      await postEntry(tx, { entryType: "PAYMENT_OUT", branchId: Number(purchaseReturn.branchId), purchaseOrderId: Number(purchaseReturn.purchaseOrderId), supplierId: Number(purchaseReturn.supplierId), receiptId: cashReceiptId, amount: total, paymentMethod: purchaseReturn.paymentMethod, createdBy: actor.userId, dedupeKey: `PURCHASE_RETURN_REVERSAL_PAYMENT:${input.requestId}`, postingIntent: createPostingIntent("PAYMENT_OUT_SUPPLIER", "PAYMENT_OUT", [debitLine("AP", total), creditLine(asset, total)], cashSource), postingSourceComponents: cashSource });
    }
    const inserted = await tx.insert(purchaseReturnReversals).values({ reversalNumber, requestId: input.requestId, purchaseReturnId: Number(purchaseReturn.id), supplierInvoiceId: Number(purchaseReturn.supplierInvoiceId), supplierId: Number(purchaseReturn.supplierId), branchId: Number(purchaseReturn.branchId), netAmount: toDbMoney(net), taxAmount: toDbMoney(tax), totalAmount: toDbMoney(total), accountingEntryId, cashRepaymentReceiptId: cashReceiptId, payloadCanonical: request.payloadCanonical, payloadHash: request.payloadHash, reason: request.reason, postedBy: actor.userId });
    const reversalId = extractInsertId(inserted);
    let assignedTax = money(0);
    for (let index = 0; index < reqItems.length; index += 1) {
      const row = reqItems[index]!;
      const item = itemById.get(Number(row.purchaseReturnItemId))!;
      const lineTotal = plannedLineTotals.get(Number(item.id)) ?? money(0);
      const lineTax = index === reqItems.length - 1 ? round2(tax.minus(assignedTax)) : (total.gt(0) ? round2(tax.times(lineTotal).dividedBy(total)) : money(0));
      assignedTax = assignedTax.plus(lineTax);
      const lineNet = round2(lineTotal.minus(lineTax));
      const movement = await applyMovement(tx, { variantId: Number(item.variantId), branchId: Number(purchaseReturn.branchId), baseQuantity: Number(row.baseQuantity), movementType: "IN", referenceType: "PURCHASE_RETURN_REVERSAL", referenceId: reversalId, createdBy: actor.userId });
      await tx.insert(purchaseReturnReversalItems).values({ reversalId, purchaseReturnItemId: Number(item.id), baseQuantity: Number(row.baseQuantity), netAmount: toDbMoney(lineNet), taxAmount: toDbMoney(lineTax), totalAmount: toDbMoney(lineTotal), inventoryMovementId: movement.movementId });
      await tx.update(purchaseOrderItems).set({ returnedBaseQuantity: sql`${purchaseOrderItems.returnedBaseQuantity} - ${row.baseQuantity}` }).where(and(eq(purchaseOrderItems.id, Number(item.purchaseOrderItemId)), sql`${purchaseOrderItems.returnedBaseQuantity} >= ${row.baseQuantity}`));
      if (item.goodsReceiptItemId != null) await tx.update(goodsReceiptItems).set({ returnedBaseQuantity: sql`${goodsReceiptItems.returnedBaseQuantity} - ${row.baseQuantity}` }).where(and(eq(goodsReceiptItems.id, Number(item.goodsReceiptItemId)), sql`${goodsReceiptItems.returnedBaseQuantity} >= ${row.baseQuantity}`));
    }
    await adjustSupplierBalance(tx, Number(purchaseReturn.supplierId), purchaseReturn.settlement === "CASH" ? money(0) : total);
    if (invoice.currency === "USD" && purchaseReturn.settlement === "CREDIT") await adjustSupplierBalanceUsd(tx, Number(purchaseReturn.supplierId), usdCreditReversalAmount);
    if (purchaseReturn.settlement === "CREDIT") await refreshInvoiceCreditState(tx, invoice);
    const totalReversed = (await tx.select({ quantity: sql<string>`COALESCE(SUM(${purchaseReturnReversalItems.baseQuantity}),0)` }).from(purchaseReturnReversalItems).innerJoin(purchaseReturnItems, eq(purchaseReturnItems.id, purchaseReturnReversalItems.purchaseReturnItemId)).where(eq(purchaseReturnItems.purchaseReturnId, Number(purchaseReturn.id))))[0];
    const originalQuantity = (await tx.select({ quantity: sql<string>`COALESCE(SUM(${purchaseReturnItems.baseQuantity}),0)` }).from(purchaseReturnItems).where(eq(purchaseReturnItems.purchaseReturnId, Number(purchaseReturn.id))))[0];
    const status = Number(totalReversed?.quantity ?? 0) >= Number(originalQuantity?.quantity ?? 0) ? "REVERSED" as const : "PARTIALLY_REVERSED" as const;
    await tx.update(purchaseReturns).set({ status, version: sql`${purchaseReturns.version} + 1` }).where(eq(purchaseReturns.id, Number(purchaseReturn.id)));
    await tx.update(purchaseReturnReversalRequests).set({ status: "APPROVED", pendingGuard: null, reviewedBy: actor.userId, reviewedAt: new Date(), reviewReason, decisionKey: key, decisionHash: hash, appliedAt: new Date() }).where(eq(purchaseReturnReversalRequests.id, input.requestId));
    return { requestId: input.requestId, status: "APPROVED" as const, reversalId, idempotent: false as const };
  });
}

export async function listPendingPurchaseReturnRequests(branchId: number, actor: Actor) {
  assertPurchaseBranch({ branchId }, actor);
  return withTx((tx) => tx.select().from(purchaseReturnRequests).where(and(eq(purchaseReturnRequests.branchId, branchId), eq(purchaseReturnRequests.status, "PENDING"))).orderBy(asc(purchaseReturnRequests.requestedAt)), { gate: "NONE" });
}

export async function listPendingPurchaseReturnReversalRequests(branchId: number, actor: Actor) {
  assertPurchaseBranch({ branchId }, actor);
  return withTx((tx) => tx.select().from(purchaseReturnReversalRequests).where(and(eq(purchaseReturnReversalRequests.branchId, branchId), eq(purchaseReturnReversalRequests.status, "PENDING"))).orderBy(asc(purchaseReturnReversalRequests.requestedAt)), { gate: "NONE" });
}

export async function listPurchaseReturnSources(
  input: { branchId: number; limit?: number },
  actor: Actor,
) {
  assertPurchaseBranch({ branchId: input.branchId }, actor);
  return withTx(async (tx) => {
    const invoices = await tx.select().from(supplierInvoices)
      .where(and(eq(supplierInvoices.branchId, input.branchId), eq(supplierInvoices.status, "POSTED")))
      .orderBy(desc(supplierInvoices.invoiceDate), desc(supplierInvoices.id)).limit(Math.min(input.limit ?? 100, 200));
    if (!invoices.length) return [];
    const invoiceIds = invoices.map((row) => Number(row.id));
    const runs = await tx.select().from(supplierInvoiceMatchRuns)
      .where(and(inArray(supplierInvoiceMatchRuns.supplierInvoiceId, invoiceIds), sql`${supplierInvoiceMatchRuns.outcome} <> 'HOLD'`))
      .orderBy(asc(supplierInvoiceMatchRuns.supplierInvoiceId), desc(supplierInvoiceMatchRuns.runNo));
    const latestByInvoice = new Map<number, (typeof runs)[number]>();
    for (const run of runs) if (!latestByInvoice.has(Number(run.supplierInvoiceId))) latestByInvoice.set(Number(run.supplierInvoiceId), run);
    const runIds = Array.from(latestByInvoice.values()).map((row) => Number(row.id));
    if (!runIds.length) return [];
    const allocations = await tx.select().from(supplierInvoiceMatchAllocations).where(inArray(supplierInvoiceMatchAllocations.matchRunId, runIds)).orderBy(asc(supplierInvoiceMatchAllocations.matchRunId), asc(supplierInvoiceMatchAllocations.id));
    const allocationIds = allocations.map((row) => Number(row.id));
    const invoiceLines = allocations.length ? await tx.select().from(supplierInvoiceLines).where(inArray(supplierInvoiceLines.id, allocations.map((row) => Number(row.supplierInvoiceLineId)))) : [];
    const lineById = new Map(invoiceLines.map((row) => [Number(row.id), row]));
    const pending = allocationIds.length ? await tx.select({ allocationId: purchaseReturnRequestItems.matchAllocationId, quantity: sql<string>`COALESCE(SUM(${purchaseReturnRequestItems.requestedBaseQuantity}),0)` }).from(purchaseReturnRequestItems).innerJoin(purchaseReturnRequests, eq(purchaseReturnRequests.id, purchaseReturnRequestItems.requestId)).where(and(eq(purchaseReturnRequests.status, "PENDING"), inArray(purchaseReturnRequestItems.matchAllocationId, allocationIds))).groupBy(purchaseReturnRequestItems.matchAllocationId) : [];
    const postedById = await netReturnedByAllocation(tx, allocationIds);
    const pendingById = new Map(pending.map((row) => [Number(row.allocationId), Number(row.quantity)]));
    const allocationsByRun = new Map<number, Array<{ id: number; supplierInvoiceLineId: number; goodsReceiptItemId: number; purchaseOrderRevisionItemId: number; description: string; matchedBaseQuantity: number; availableBaseQuantity: number; unitPriceIqd: string; matchedAmount: string }>>();
    for (const allocation of allocations) {
      const line = lineById.get(Number(allocation.supplierInvoiceLineId));
      if (!line) continue;
      const available = Number(allocation.matchedBaseQuantity) - (postedById.get(Number(allocation.id)) ?? 0) - (pendingById.get(Number(allocation.id)) ?? 0);
      if (available <= 0) continue;
      const list = allocationsByRun.get(Number(allocation.matchRunId)) ?? [];
      list.push({ id: Number(allocation.id), supplierInvoiceLineId: Number(allocation.supplierInvoiceLineId), goodsReceiptItemId: Number(allocation.goodsReceiptItemId), purchaseOrderRevisionItemId: Number(allocation.purchaseOrderRevisionItemId), description: line.description, matchedBaseQuantity: Number(allocation.matchedBaseQuantity), availableBaseQuantity: available, unitPriceIqd: allocation.invoiceUnitPriceIqd, matchedAmount: allocation.matchedAmount });
      allocationsByRun.set(Number(allocation.matchRunId), list);
    }
    return invoices.map((invoice) => {
      const run = latestByInvoice.get(Number(invoice.id));
      if (!run) return null;
      const availableAllocations = allocationsByRun.get(Number(run.id)) ?? [];
      if (!availableAllocations.length) return null;
      return { id: Number(invoice.id), invoiceNumber: invoice.invoiceNumber, externalInvoiceNumber: invoice.externalInvoiceNumber, supplierId: Number(invoice.supplierId), branchId: Number(invoice.branchId), version: Number(invoice.version), currency: invoice.currency, totalAmount: invoice.totalAmount, invoiceDate: invoice.invoiceDate, matchRun: { id: Number(run.id), runNo: Number(run.runNo), outcome: run.outcome, performedAt: run.performedAt }, allocations: availableAllocations };
    }).filter((row): row is NonNullable<typeof row> => row != null);
  }, { gate: "NONE" });
}

export async function listPurchaseReturnReversalSources(
  input: { branchId: number; limit?: number },
  actor: Actor,
) {
  assertPurchaseBranch({ branchId: input.branchId }, actor);
  return withTx(async (tx) => {
    const returns = await tx.select().from(purchaseReturns).where(and(eq(purchaseReturns.branchId, input.branchId), eq(purchaseReturns.origin, "NATIVE"), sql`${purchaseReturns.status} <> 'REVERSED'`)).orderBy(desc(purchaseReturns.postedAt), desc(purchaseReturns.id)).limit(Math.min(input.limit ?? 100, 200));
    if (!returns.length) return [];
    const ids = returns.map((row) => Number(row.id));
    const items = await tx.select().from(purchaseReturnItems).where(inArray(purchaseReturnItems.purchaseReturnId, ids)).orderBy(asc(purchaseReturnItems.purchaseReturnId), asc(purchaseReturnItems.id));
    const itemIds = items.map((row) => Number(row.id));
    const reversed = itemIds.length ? await tx.select({ itemId: purchaseReturnReversalItems.purchaseReturnItemId, quantity: sql<string>`COALESCE(SUM(${purchaseReturnReversalItems.baseQuantity}),0)` }).from(purchaseReturnReversalItems).where(inArray(purchaseReturnReversalItems.purchaseReturnItemId, itemIds)).groupBy(purchaseReturnReversalItems.purchaseReturnItemId) : [];
    const pending = itemIds.length ? await tx.select({ itemId: purchaseReturnReversalRequestItems.purchaseReturnItemId, quantity: sql<string>`COALESCE(SUM(${purchaseReturnReversalRequestItems.baseQuantity}),0)` }).from(purchaseReturnReversalRequestItems).innerJoin(purchaseReturnReversalRequests, eq(purchaseReturnReversalRequests.id, purchaseReturnReversalRequestItems.requestId)).where(and(eq(purchaseReturnReversalRequests.status, "PENDING"), inArray(purchaseReturnReversalRequestItems.purchaseReturnItemId, itemIds))).groupBy(purchaseReturnReversalRequestItems.purchaseReturnItemId) : [];
    const reversedById = new Map(reversed.map((row) => [Number(row.itemId), Number(row.quantity)])); const pendingById = new Map(pending.map((row) => [Number(row.itemId), Number(row.quantity)]));
    const itemsByReturn = new Map<number, Array<{ id: number; productName: string; variantName: string | null; baseQuantity: number; remainingBaseQuantity: number; lineTotal: string }>>();
    for (const item of items) { const remaining = Number(item.baseQuantity) - (reversedById.get(Number(item.id)) ?? 0) - (pendingById.get(Number(item.id)) ?? 0); if (remaining <= 0) continue; const list = itemsByReturn.get(Number(item.purchaseReturnId)) ?? []; list.push({ id: Number(item.id), productName: item.productNameSnapshot, variantName: item.variantNameSnapshot, baseQuantity: Number(item.baseQuantity), remainingBaseQuantity: remaining, lineTotal: item.lineTotal }); itemsByReturn.set(Number(item.purchaseReturnId), list); }
    return returns.map((row) => ({ id: Number(row.id), returnNumber: row.returnNumber, version: Number(row.version), status: row.status, supplierId: Number(row.supplierId), supplierInvoiceId: Number(row.supplierInvoiceId), settlement: row.settlement, totalAmount: row.totalAmount, postedAt: row.postedAt, items: itemsByReturn.get(Number(row.id)) ?? [] })).filter((row) => row.items.length > 0);
  }, { gate: "NONE" });
}
