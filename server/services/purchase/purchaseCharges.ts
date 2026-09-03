import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  accountingEntries,
  accounts,
  goodsReceipts,
  purchaseChargeAllocations,
  purchaseChargeControlRequests,
  purchaseCharges,
  purchaseOrders,
  receipts,
  supplierInvoices,
  suppliers,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import {
  ACCOUNT_ROLES,
  createPostingIntent,
  creditLine,
  debitLine,
  type AccountRole,
} from "../accounting/postingEngine";
import {
  assertApprovedTreasuryOutAvailable,
  assertCashOutAvailable,
  assertNonPhysicalOutReceipt,
  authorizeExternalTreasuryDisbursement,
  type ExternalTreasuryDisbursementApproval,
  lockCashSourceForUpdate,
} from "../cash/cashAvailability";
import { postEntry } from "../ledgerService";
import { money, round2, sumMoney, toDbMoney } from "../money";
import { paymentAssetRole } from "../sale/paymentPosting";
import { shiftIdForCashTx } from "../shiftService";
import { withTx, type Actor } from "../tx";
import { sha256, stableCanonical } from "./grniAccounting";
import { assertPurchaseBranch } from "./internal";
import { assertExpectedVersion, assertIndependentPurchaseReviewer } from "./returnGovernance";
import { payloadHashMatches } from "../idempotency";

const ACCRUABLE_ROLES = new Set<AccountRole>(["RENT", "UTILITIES", "OPERATING_EXPENSE", "DELIVERY_EXPENSE", "OTHER_EXPENSE"]);
const EXPENSE_ROLES = new Set<AccountRole>([
  "COGS", "SALARIES", "SOCIAL_SECURITY_EXPENSE", "EOS_EXPENSE", "RENT", "UTILITIES",
  "OPERATING_EXPENSE", "DELIVERY_EXPENSE", "GIFTS_PROMO", "DEPRECIATION_EXPENSE", "FX_LOSS",
  "ROUNDING_DIFF", "ASSET_DISPOSAL_LOSS", "PURCHASE_PRICE_VARIANCE", "LOSSES", "OTHER_EXPENSE",
]);

type Method = "CASH" | "CARD" | "TRANSFER" | "WALLET";
type ChargeType = "SHIPPING" | "CUSTOMS" | "FREIGHT" | "INSURANCE" | "INSPECTION" | "OTHER";
type Evidence = "SUPPLIER_INVOICE" | "CARRIER_INVOICE" | "CUSTOMS_RECEIPT" | "BANK_ADVICE" | "DOCUMENT_IMAGE" | "PDF" | "OTHER";

export interface CreatePurchaseChargeInput {
  branchId: number;
  clientRequestId: string;
  payeeSupplierId?: number | null;
  expenseAccountId: number;
  chargeType: ChargeType;
  settlement: "PAID" | "PAYABLE";
  paymentMethod?: Method | null;
  amount: string;
  expenseDate: string;
  externalReference?: string | null;
  evidenceType: Evidence;
  evidenceReference: string;
  allocations: Array<{
    purchaseOrderId?: number | null;
    goodsReceiptId?: number | null;
    supplierInvoiceId?: number | null;
    allocatedAmount: string;
  }>;
}

export interface RequestPurchaseChargeControlInput {
  purchaseChargeId: number;
  expectedChargeVersion: number;
  requestKey: string;
  kind: "POST" | "REVERSE";
  evidenceReference: string;
  reason: string;
}

export interface DecidePurchaseChargeControlInput {
  requestId: number;
  decisionKey: string;
  action: "APPROVE" | "REJECT";
  reviewReason: string;
}

function required(value: string | null | undefined, label: string, max: number): string {
  const result = value?.trim() ?? "";
  if (!result) throw new TRPCError({ code: "BAD_REQUEST", message: `${label} مطلوب` });
  if (result.length > max) throw new TRPCError({ code: "BAD_REQUEST", message: `${label} يتجاوز ${max} محرفاً` });
  return result;
}

export function assertExpenseOnlyAccount(account: { type: string; isActive: boolean; systemRole: string | null }, settlement: "PAID" | "PAYABLE"): AccountRole {
  if (account.type !== "EXPENSE" || !account.isActive || !account.systemRole || !ACCOUNT_ROLES.includes(account.systemRole as AccountRole) || !EXPENSE_ROLES.has(account.systemRole as AccountRole)) {
    throw new TRPCError({ code: "CONFLICT", message: "مصروف الشراء يتطلب حساب EXPENSE نشطاً ومربوطاً بدور محاسبي" });
  }
  const role = account.systemRole as AccountRole;
  if (settlement === "PAYABLE" && !ACCRUABLE_ROLES.has(role)) {
    throw new TRPCError({ code: "CONFLICT", message: "الحساب غير مدعوم في استحقاق المصروف؛ اختر RENT/UTILITIES/OPERATING/DELIVERY/OTHER EXPENSE" });
  }
  return role;
}

export function assertPurchaseChargeSettlementSupported(settlement: "PAID" | "PAYABLE"): void {
  if (settlement === "PAYABLE") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "مصروف الشراء PAYABLE مغلق احترازياً حتى ربطه بالتزام مستحق وتسوية وعكس ذريين" });
  }
}

export function assertChargeAllocationTotal(amount: string, allocations: Array<{ allocatedAmount: string }>): void {
  if (!round2(amount).gt(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "قيمة المصروف يجب أن تكون موجبة" });
  if (!round2(sumMoney(allocations.map((row) => row.allocatedAmount))).eq(round2(amount))) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "مجموع التوزيعات يجب أن يساوي قيمة المصروف بالكامل" });
  }
}

async function entryId(tx: Tx, dedupeKey: string): Promise<number> {
  const row = (await tx.select({ id: accountingEntries.id }).from(accountingEntries).where(eq(accountingEntries.dedupeKey, dedupeKey)).limit(1))[0];
  if (!row) throw new Error(`accounting entry missing: ${dedupeKey}`);
  return Number(row.id);
}

async function paymentContext(
  tx: Tx,
  charge: typeof purchaseCharges.$inferSelect,
  actor: Actor,
  label: string,
  direction: "IN" | "OUT",
  makerUserIds: Array<number | null | undefined>,
): Promise<{
  shiftId: number | null;
  cashBucket: "DRAWER" | "TREASURY" | null;
  treasuryApproval: ExternalTreasuryDisbursementApproval | null;
}> {
  if (charge.paymentMethod !== "CASH") {
    return { shiftId: null, cashBucket: null, treasuryApproval: null };
  }
  const result = await shiftIdForCashTx(tx, { ...actor, branchId: Number(charge.branchId) }, Number(charge.branchId), label);
  if (direction === "OUT" && result.cashBucket === "TREASURY") {
    const treasuryApproval = await authorizeExternalTreasuryDisbursement(tx, {
      actor,
      makerUserIds,
      branchIds: [Number(charge.branchId)],
      operation: label,
    });
    return { ...result, treasuryApproval };
  }
  await lockCashSourceForUpdate(tx, {
    branchId: Number(charge.branchId),
    shiftId: result.shiftId,
    cashBucket: result.cashBucket,
  });
  return { ...result, treasuryApproval: null };
}

function decisionHash(requestId: number, action: string, reviewReason: string) {
  return sha256(stableCanonical({ requestId, action, reviewReason }));
}

export async function createPurchaseCharge(input: CreatePurchaseChargeInput, actor: Actor) {
  const clientRequestId = required(input.clientRequestId, "مفتاح الطلب", 120);
  const evidenceReference = required(input.evidenceReference, "مرجع الدليل", 500);
  const externalReference = input.externalReference?.trim() || null;
  assertPurchaseChargeSettlementSupported(input.settlement);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expenseDate)) throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ المصروف غير صالح" });
  if (!input.allocations.length) throw new TRPCError({ code: "BAD_REQUEST", message: "أضف مصدر توزيع واحداً على الأقل" });
  const allocations = input.allocations.map((row) => {
    if (![row.purchaseOrderId, row.goodsReceiptId, row.supplierInvoiceId].some((id) => id != null)) throw new TRPCError({ code: "BAD_REQUEST", message: "كل توزيع يحتاج PO أو GRN أو فاتورة مورد" });
    return { purchaseOrderId: row.purchaseOrderId ?? null, goodsReceiptId: row.goodsReceiptId ?? null, supplierInvoiceId: row.supplierInvoiceId ?? null, allocatedAmount: toDbMoney(row.allocatedAmount) };
  }).sort((a, b) => (a.purchaseOrderId ?? 0) - (b.purchaseOrderId ?? 0) || (a.goodsReceiptId ?? 0) - (b.goodsReceiptId ?? 0) || (a.supplierInvoiceId ?? 0) - (b.supplierInvoiceId ?? 0));
  assertChargeAllocationTotal(input.amount, allocations);
  if (input.settlement === "PAYABLE" && (input.payeeSupplierId == null || input.paymentMethod != null)) throw new TRPCError({ code: "BAD_REQUEST", message: "المصروف المستحق يحتاج مورداً ولا يقبل طريقة دفع" });
  if (input.settlement === "PAID" && input.paymentMethod == null) throw new TRPCError({ code: "BAD_REQUEST", message: "طريقة الدفع مطلوبة للمصروف المدفوع" });
  const canonical = stableCanonical({ branchId: input.branchId, payeeSupplierId: input.payeeSupplierId ?? null, expenseAccountId: input.expenseAccountId, chargeType: input.chargeType, settlement: input.settlement, paymentMethod: input.paymentMethod ?? null, amount: toDbMoney(input.amount), expenseDate: input.expenseDate, externalReference, evidenceType: input.evidenceType, evidenceReference, allocations });
  const payloadHash = sha256(canonical); const evidenceHash = sha256(stableCanonical({ type: input.evidenceType, reference: evidenceReference }));
  return withTx(async (tx) => {
    const replay = (await tx.select().from(purchaseCharges).where(eq(purchaseCharges.clientRequestId, clientRequestId)).limit(1))[0];
    if (replay) { assertPurchaseBranch(replay, actor); if (!payloadHashMatches(payloadHash, replay.payloadHash)) throw new TRPCError({ code: "CONFLICT", message: "مفتاح الطلب مستعمل بمصروف مختلف" }); return { purchaseChargeId: Number(replay.id), status: replay.status, idempotent: true as const }; }
    assertPurchaseBranch({ branchId: input.branchId }, actor);
    const account = (await tx.select().from(accounts).where(eq(accounts.id, input.expenseAccountId)).for("update").limit(1))[0];
    if (!account) throw new TRPCError({ code: "NOT_FOUND", message: "حساب المصروف غير موجود" });
    assertExpenseOnlyAccount(account, input.settlement);
    const poIds = Array.from(new Set(allocations.map((row) => row.purchaseOrderId).filter((id): id is number => id != null))).sort((a, b) => a - b);
    const grnIds = Array.from(new Set(allocations.map((row) => row.goodsReceiptId).filter((id): id is number => id != null))).sort((a, b) => a - b);
    const invoiceIds = Array.from(new Set(allocations.map((row) => row.supplierInvoiceId).filter((id): id is number => id != null))).sort((a, b) => a - b);
    const pos = poIds.length ? await tx.select().from(purchaseOrders).where(inArray(purchaseOrders.id, poIds)).orderBy(asc(purchaseOrders.id)).for("update") : [];
    const grns = grnIds.length ? await tx.select().from(goodsReceipts).where(inArray(goodsReceipts.id, grnIds)).orderBy(asc(goodsReceipts.id)).for("update") : [];
    const invoices = invoiceIds.length ? await tx.select().from(supplierInvoices).where(inArray(supplierInvoices.id, invoiceIds)).orderBy(asc(supplierInvoices.id)).for("update") : [];
    if (pos.length !== poIds.length || grns.length !== grnIds.length || invoices.length !== invoiceIds.length) throw new TRPCError({ code: "BAD_REQUEST", message: "أحد مصادر التوزيع غير موجود" });
    for (const row of [...pos, ...grns, ...invoices]) assertPurchaseBranch(row, actor);
    if ([...pos, ...grns, ...invoices].some((row) => Number(row.branchId) !== input.branchId)) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يجوز توزيع مصروف على مصدر من فرع آخر" });
    const sourceByPo = new Map(pos.map((row) => [Number(row.id), row])); const sourceByGrn = new Map(grns.map((row) => [Number(row.id), row])); const sourceByInvoice = new Map(invoices.map((row) => [Number(row.id), row]));
    const chargeNumber = `PC-${input.branchId}-${input.expenseDate.replaceAll("-", "")}-${createHash("sha256").update(clientRequestId).digest("hex").slice(0, 16).toUpperCase()}`;
    const inserted = await tx.insert(purchaseCharges).values({ chargeNumber, clientRequestId, branchId: input.branchId, payeeSupplierId: input.payeeSupplierId ?? null, expenseAccountId: input.expenseAccountId, chargeType: input.chargeType, settlement: input.settlement, paymentMethod: input.paymentMethod ?? null, amount: toDbMoney(input.amount), expenseDate: input.expenseDate, externalReference, evidenceType: input.evidenceType, evidenceReference, evidenceHash, payloadCanonical: canonical, payloadHash, createdBy: actor.userId });
    const purchaseChargeId = extractInsertId(inserted);
    await tx.insert(purchaseChargeAllocations).values(allocations.map((row, index) => {
      const source = stableCanonical({ purchaseOrder: row.purchaseOrderId == null ? null : { id: row.purchaseOrderId, poNumber: sourceByPo.get(row.purchaseOrderId)?.poNumber }, goodsReceipt: row.goodsReceiptId == null ? null : { id: row.goodsReceiptId, receiptNumber: sourceByGrn.get(row.goodsReceiptId)?.receiptNumber }, supplierInvoice: row.supplierInvoiceId == null ? null : { id: row.supplierInvoiceId, invoiceNumber: sourceByInvoice.get(row.supplierInvoiceId)?.invoiceNumber }, branchId: input.branchId, allocatedAmount: row.allocatedAmount });
      return { purchaseChargeId, lineNo: index + 1, ...row, sourceSnapshot: source, sourceHash: sha256(source) };
    }));
    return { purchaseChargeId, status: "DRAFT" as const, idempotent: false as const };
  });
}

export async function requestPurchaseChargeControl(input: RequestPurchaseChargeControlInput, actor: Actor) {
  const requestKey = required(input.requestKey, "مفتاح الطلب", 120); const evidenceReference = required(input.evidenceReference, "مرجع الدليل", 500); const reason = required(input.reason, "سبب الطلب", 500);
  const canonical = stableCanonical({ purchaseChargeId: input.purchaseChargeId, expectedChargeVersion: input.expectedChargeVersion, kind: input.kind, evidenceReference, reason }); const payloadHash = sha256(canonical);
  return withTx(async (tx) => {
    const replay = (await tx.select().from(purchaseChargeControlRequests).where(eq(purchaseChargeControlRequests.requestKey, requestKey)).limit(1))[0];
    if (replay) { assertPurchaseBranch(replay, actor); if (!payloadHashMatches(payloadHash, replay.payloadHash)) throw new TRPCError({ code: "CONFLICT", message: "مفتاح الطلب مستعمل بحمولة مختلفة" }); return { requestId: Number(replay.id), status: replay.status, idempotent: true as const }; }
    const charge = (await tx.select().from(purchaseCharges).where(eq(purchaseCharges.id, input.purchaseChargeId)).for("update").limit(1))[0];
    if (!charge) throw new TRPCError({ code: "NOT_FOUND", message: "مصروف الشراء غير موجود" }); assertPurchaseBranch(charge, actor); assertExpectedVersion(Number(charge.version), input.expectedChargeVersion, "مصروف الشراء");
    if ((input.kind === "POST" && charge.status !== "DRAFT") || (input.kind === "REVERSE" && charge.status !== "POSTED")) throw new TRPCError({ code: "CONFLICT", message: "حالة المصروف لا تسمح بهذه العملية" });
    const inserted = await tx.insert(purchaseChargeControlRequests).values({ requestKey, purchaseChargeId: input.purchaseChargeId, branchId: Number(charge.branchId), kind: input.kind, baseChargeVersion: input.expectedChargeVersion, payloadCanonical: canonical, payloadHash, evidenceReference, reason, pendingGuard: `PURCHASE-CHARGE:${input.purchaseChargeId}`, requestedBy: actor.userId });
    return { requestId: extractInsertId(inserted), status: "PENDING" as const, idempotent: false as const };
  });
}

export async function decidePurchaseChargeControl(input: DecidePurchaseChargeControlInput, actor: Actor) {
  const decisionKey = required(input.decisionKey, "مفتاح القرار", 120); const reviewReason = required(input.reviewReason, "سبب القرار", 500); const hash = decisionHash(input.requestId, input.action, reviewReason);
  return withTx(async (tx) => {
    const preview = (await tx.select().from(purchaseChargeControlRequests).where(eq(purchaseChargeControlRequests.id, input.requestId)).limit(1))[0];
    if (!preview) throw new TRPCError({ code: "NOT_FOUND", message: "طلب تحكم المصروف غير موجود" }); assertPurchaseBranch(preview, actor);
    const previewCharge = (await tx.select().from(purchaseCharges).where(eq(purchaseCharges.id, Number(preview.purchaseChargeId))).limit(1))[0];
    let instrument: Awaited<ReturnType<typeof paymentContext>> = {
      shiftId: null,
      cashBucket: null,
      treasuryApproval: null,
    };
    if (input.action === "APPROVE" && preview.status === "PENDING" && previewCharge?.settlement === "PAID") {
      instrument = await paymentContext(
        tx,
        previewCharge,
        actor,
        preview.kind === "POST" ? "ترحيل مصروف شراء" : "عكس مصروف شراء",
        preview.kind === "POST" ? "OUT" : "IN",
        [previewCharge.createdBy, preview.requestedBy],
      );
    }
    const request = (await tx.select().from(purchaseChargeControlRequests).where(eq(purchaseChargeControlRequests.id, input.requestId)).for("update").limit(1))[0]!;
    assertIndependentPurchaseReviewer(Number(request.requestedBy), actor.userId);
    if (request.status !== "PENDING") { if (request.decisionKey === decisionKey && request.decisionHash === hash) return { requestId: input.requestId, status: request.status, purchaseChargeId: Number(request.purchaseChargeId), idempotent: true as const }; throw new TRPCError({ code: "CONFLICT", message: "حُسم طلب التحكم مسبقاً" }); }
    if (input.action === "REJECT") { await tx.update(purchaseChargeControlRequests).set({ status: "REJECTED", pendingGuard: null, reviewedBy: actor.userId, reviewedAt: new Date(), reviewReason, decisionKey, decisionHash: hash }).where(eq(purchaseChargeControlRequests.id, input.requestId)); return { requestId: input.requestId, status: "REJECTED" as const, purchaseChargeId: Number(request.purchaseChargeId), idempotent: false as const }; }
    const charge = (await tx.select().from(purchaseCharges).where(eq(purchaseCharges.id, Number(request.purchaseChargeId))).for("update").limit(1))[0];
    if (!charge) throw new TRPCError({ code: "CONFLICT", message: "مصروف الشراء مفقود" });
    if (Number(charge.version) !== Number(request.baseChargeVersion)) {
      await tx.update(purchaseChargeControlRequests).set({ status: "STALE", pendingGuard: null, reviewedBy: actor.userId, reviewedAt: new Date(), reviewReason: "تغيّر مصروف الشراء بعد إنشاء طلب التحكم", decisionKey, decisionHash: hash }).where(eq(purchaseChargeControlRequests.id, input.requestId));
      return { requestId: input.requestId, status: "STALE" as const, purchaseChargeId: Number(request.purchaseChargeId), idempotent: false as const };
    }
    if ((request.kind === "POST" && charge.status !== "DRAFT") || (request.kind === "REVERSE" && charge.status !== "POSTED")) {
      await tx.update(purchaseChargeControlRequests).set({ status: "STALE", pendingGuard: null, reviewedBy: actor.userId, reviewedAt: new Date(), reviewReason: "تغيّرت حالة مصروف الشراء بعد إنشاء الطلب", decisionKey, decisionHash: hash }).where(eq(purchaseChargeControlRequests.id, input.requestId));
      return { requestId: input.requestId, status: "STALE" as const, purchaseChargeId: Number(request.purchaseChargeId), idempotent: false as const };
    }
    const account = (await tx.select().from(accounts).where(eq(accounts.id, Number(charge.expenseAccountId))).for("update").limit(1))[0];
    if (!account) throw new TRPCError({ code: "CONFLICT", message: "حساب المصروف مفقود" }); const role = assertExpenseOnlyAccount(account, charge.settlement); const amount = money(charge.amount); const entryDate = new Date(`${charge.expenseDate}T12:00:00.000Z`);
    if (request.kind === "POST") assertPurchaseChargeSettlementSupported(charge.settlement);
    let receiptId: number | null = null; let postingEntryId: number;
    if (request.kind === "POST") {
      const dedupeKey = `PURCHASE_CHARGE_POST:${charge.id}`;
      if (charge.settlement === "PAID") {
        const method = charge.paymentMethod!; const asset = paymentAssetRole(method, instrument.cashBucket, "OUT");
        if (method === "CASH") {
          if (instrument.cashBucket === "TREASURY") {
            if (!instrument.treasuryApproval) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "إثبات اعتماد صرف مصروف الشراء من الخزينة مفقود" });
            await assertApprovedTreasuryOutAvailable(tx, { branchId: Number(charge.branchId), amount, operation: "ترحيل مصروف شراء" }, instrument.treasuryApproval);
          } else if (instrument.cashBucket === "DRAWER") {
            await assertCashOutAvailable(tx, { branchId: Number(charge.branchId), shiftId: instrument.shiftId, cashBucket: "DRAWER", amount, operation: "ترحيل مصروف شراء" });
          } else {
            throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "مصدر صرف مصروف الشراء النقدي مفقود" });
          }
        } else {
          assertNonPhysicalOutReceipt({ classification: "NON_CASH_METHOD", paymentMethod: method, cashBucket: null, approvalStatus: "APPROVED", operation: "ترحيل مصروف شراء" });
        }
        const receipt = await tx.insert(receipts).values({ branchId: Number(charge.branchId), shiftId: instrument.shiftId, cashBucket: instrument.cashBucket, direction: "OUT", amount: charge.amount, paymentMethod: method, referenceNumber: charge.externalReference ?? charge.chargeNumber, partyType: charge.payeeSupplierId == null ? "OTHER" : "SUPPLIER", partyId: charge.payeeSupplierId, description: `${charge.chargeType} — ${charge.evidenceReference}`, status: "COMPLETED", approvalStatus: "APPROVED", approvedBy: actor.userId, approvedAt: new Date(), createdBy: actor.userId }); receiptId = extractInsertId(receipt);
        const source = { roleDebits: { [role]: amount }, roleCredits: { [asset]: amount } };
        await postEntry(tx, { entryType: "PAYMENT_OUT", branchId: Number(charge.branchId), supplierId: charge.payeeSupplierId == null ? null : Number(charge.payeeSupplierId), receiptId, amount, paymentMethod: method, entryDate, createdBy: actor.userId, dedupeKey, notes: charge.evidenceReference, postingIntent: createPostingIntent("PAYMENT_OUT_EXPENSE", "PAYMENT_OUT", [debitLine(role, amount), creditLine(asset, amount)], source), postingSourceComponents: source });
      } else {
        const source = { roleDebits: { [role]: amount }, roleCredits: { ACCRUED_EXPENSES: amount } };
        await postEntry(tx, { entryType: "ADJUST", branchId: Number(charge.branchId), supplierId: Number(charge.payeeSupplierId), amount, entryDate, createdBy: actor.userId, dedupeKey, notes: charge.evidenceReference, postingIntent: createPostingIntent("ADJUST_EXPENSE_ACCRUAL", "ADJUST", [debitLine(role, amount), creditLine("ACCRUED_EXPENSES", amount)], source), postingSourceComponents: source });
      }
      postingEntryId = await entryId(tx, dedupeKey);
      await tx.update(purchaseCharges).set({ status: "POSTED", postingEntryId, paymentReceiptId: receiptId, postedBy: actor.userId, postedAt: new Date(), version: sql`${purchaseCharges.version} + 1` }).where(eq(purchaseCharges.id, Number(charge.id)));
    } else {
      const dedupeKey = `PURCHASE_CHARGE_REVERSAL:${charge.id}`;
      if (charge.settlement === "PAID") {
        const method = charge.paymentMethod!; const asset = paymentAssetRole(method, instrument.cashBucket, "IN");
        const receipt = await tx.insert(receipts).values({ branchId: Number(charge.branchId), shiftId: instrument.shiftId, cashBucket: instrument.cashBucket, direction: "IN", amount: charge.amount, paymentMethod: method, referenceNumber: `REV:${charge.chargeNumber}`, partyType: charge.payeeSupplierId == null ? "OTHER" : "SUPPLIER", partyId: charge.payeeSupplierId, description: `عكس ${charge.chargeType}`, status: "COMPLETED", approvalStatus: "APPROVED", approvedBy: actor.userId, approvedAt: new Date(), createdBy: actor.userId }); receiptId = extractInsertId(receipt);
        const source = { roleDebits: { [asset]: amount }, roleCredits: { [role]: amount } };
        await postEntry(tx, { entryType: "PAYMENT_IN", branchId: Number(charge.branchId), supplierId: charge.payeeSupplierId == null ? null : Number(charge.payeeSupplierId), receiptId, amount, paymentMethod: method, entryDate: new Date(), createdBy: actor.userId, dedupeKey, notes: request.reason, postingIntent: createPostingIntent("PAYMENT_IN_OTHER", "PAYMENT_IN", [debitLine(asset, amount), creditLine(role, amount)], source), postingSourceComponents: source });
      } else {
        const source = { roleDebits: { ACCRUED_EXPENSES: amount }, roleCredits: { [role]: amount } };
        await postEntry(tx, { entryType: "ADJUST", branchId: Number(charge.branchId), supplierId: Number(charge.payeeSupplierId), amount: amount.neg(), entryDate: new Date(), createdBy: actor.userId, dedupeKey, notes: request.reason, postingIntent: createPostingIntent("ADJUST_EXPENSE_ACCRUAL_REVERSAL", "ADJUST", [debitLine("ACCRUED_EXPENSES", amount), creditLine(role, amount)], source), postingSourceComponents: source });
      }
      postingEntryId = await entryId(tx, dedupeKey);
      await tx.update(purchaseCharges).set({ status: "REVERSED", reversalEntryId: postingEntryId, reversalReceiptId: receiptId, reversedBy: actor.userId, reversedAt: new Date(), reversalReason: request.reason, version: sql`${purchaseCharges.version} + 1` }).where(eq(purchaseCharges.id, Number(charge.id)));
    }
    await tx.update(purchaseChargeControlRequests).set({ status: "APPROVED", pendingGuard: null, reviewedBy: actor.userId, reviewedAt: new Date(), reviewReason, decisionKey, decisionHash: hash, appliedAt: new Date() }).where(eq(purchaseChargeControlRequests.id, input.requestId));
    return { requestId: input.requestId, status: "APPROVED" as const, purchaseChargeId: Number(charge.id), idempotent: false as const };
  });
}

export async function listPurchaseCharges(input: { branchId: number; status?: "DRAFT" | "POSTED" | "REVERSED"; limit?: number }, actor: Actor) {
  assertPurchaseBranch({ branchId: input.branchId }, actor);
  return withTx(async (tx) => {
    const where = input.status == null ? eq(purchaseCharges.branchId, input.branchId) : and(eq(purchaseCharges.branchId, input.branchId), eq(purchaseCharges.status, input.status));
    return tx.select().from(purchaseCharges).where(where).orderBy(desc(purchaseCharges.createdAt), desc(purchaseCharges.id)).limit(Math.min(input.limit ?? 100, 200));
  }, { gate: "NONE" });
}

export async function listPendingPurchaseChargeControls(branchId: number, actor: Actor) {
  assertPurchaseBranch({ branchId }, actor);
  return withTx((tx) => tx.select().from(purchaseChargeControlRequests).where(and(eq(purchaseChargeControlRequests.branchId, branchId), eq(purchaseChargeControlRequests.status, "PENDING"))).orderBy(asc(purchaseChargeControlRequests.requestedAt)), { gate: "NONE" });
}

export async function listPurchaseChargeSources(input: { branchId: number; limit?: number }, actor: Actor) {
  assertPurchaseBranch({ branchId: input.branchId }, actor); const limit = Math.min(input.limit ?? 100, 200);
  return withTx(async (tx) => {
    const [orders, receiptsRows, invoices, expenseAccountRows, supplierRows] = await Promise.all([
      tx.select({ id: purchaseOrders.id, poNumber: purchaseOrders.poNumber, supplierId: purchaseOrders.supplierId, status: purchaseOrders.status, total: purchaseOrders.total, createdAt: purchaseOrders.createdAt }).from(purchaseOrders).where(eq(purchaseOrders.branchId, input.branchId)).orderBy(desc(purchaseOrders.createdAt)).limit(limit),
      tx.select({ id: goodsReceipts.id, receiptNumber: goodsReceipts.receiptNumber, purchaseOrderId: goodsReceipts.purchaseOrderId, supplierId: goodsReceipts.supplierId, status: goodsReceipts.status, totalAmount: goodsReceipts.totalAmount, receivedAt: goodsReceipts.receivedAt }).from(goodsReceipts).where(eq(goodsReceipts.branchId, input.branchId)).orderBy(desc(goodsReceipts.receivedAt)).limit(limit),
      tx.select({ id: supplierInvoices.id, invoiceNumber: supplierInvoices.invoiceNumber, externalInvoiceNumber: supplierInvoices.externalInvoiceNumber, supplierId: supplierInvoices.supplierId, status: supplierInvoices.status, totalAmount: supplierInvoices.totalAmount, invoiceDate: supplierInvoices.invoiceDate }).from(supplierInvoices).where(eq(supplierInvoices.branchId, input.branchId)).orderBy(desc(supplierInvoices.invoiceDate)).limit(limit),
      tx.select({ id: accounts.id, code: accounts.code, name: accounts.name, systemRole: accounts.systemRole }).from(accounts).where(and(eq(accounts.type, "EXPENSE"), eq(accounts.isActive, true))).orderBy(asc(accounts.code)),
      tx.select({ id: suppliers.id, name: suppliers.name }).from(suppliers).where(eq(suppliers.isActive, true)).orderBy(asc(suppliers.name)).limit(500),
    ]);
    return { orders, goodsReceipts: receiptsRows, supplierInvoices: invoices, expenseAccounts: expenseAccountRows.filter((row) => row.systemRole != null && EXPENSE_ROLES.has(row.systemRole as AccountRole)), suppliers: supplierRows };
  }, { gate: "NONE" });
}
