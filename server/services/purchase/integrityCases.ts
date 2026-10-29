import { scanAfter } from "../decisions/scan";
import { TRPCError } from "@trpc/server";
import { PAYMENT_EVIDENCE_CASE_CODES } from "@shared/purchaseSettlement";
import { appErrorMessage } from "@shared/errors";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  branches,
  goodsReceipts,
  purchaseCharges,
  purchaseIntegrityCaseEvents,
  purchaseIntegrityCases,
  purchaseOrders,
  purchaseReturns,
  supplierInvoices,
  supplierPayments,
  suppliers,
  users,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { money, toDbMoney } from "../money";
import { withTx, type Actor } from "../tx";
import { sha256, stableCanonical } from "./grniAccounting";
import { assertPurchaseBranch } from "./internal";
import { assertIndependentPurchaseReviewer } from "./returnGovernance";
import { purchaseIntegrityResolutionTrigger } from "@shared/approvalTriggers";
import { assertApprover, resolveApprovalActor } from "../approval/ownerGate";
import { autoDecideForActiveOwner } from "../approval/ownerAutoDecision";
import { payloadHashMatches } from "../idempotency";

export type IntegrityCode = typeof purchaseIntegrityCases.$inferInsert["code"];
export type IntegritySeverity = typeof purchaseIntegrityCases.$inferInsert["severity"];

export interface OpenPurchaseIntegrityCaseInput {
  caseKey: string;
  branchId: number;
  supplierId?: number | null;
  purchaseOrderId?: number | null;
  goodsReceiptId?: number | null;
  supplierInvoiceId?: number | null;
  purchaseReturnId?: number | null;
  supplierPaymentId?: number | null;
  purchaseChargeId?: number | null;
  code: IntegrityCode;
  severity: IntegritySeverity;
  title: string;
  description: string;
  detectedAmount?: string | null;
  evidence: unknown;
  reason: string;
}

export interface RequestIntegrityResolutionInput {
  caseId: number;
  requestKey: string;
  reason: string;
  evidenceReference: string;
}

export interface DecideIntegrityResolutionInput {
  caseId: number;
  decisionKey: string;
  decision: "APPROVE_RESOLVED" | "APPROVE_DISMISSED" | "REJECT";
  reason: string;
}

function required(value: string | null | undefined, label: string, max: number) {
  const result = value?.trim() ?? "";
  if (!result) throw new TRPCError({ code: "BAD_REQUEST", message: `${label} مطلوب` });
  if (result.length > max) throw new TRPCError({ code: "BAD_REQUEST", message: `${label} يتجاوز ${max} محرفاً` });
  return result;
}

async function assertLinkedBranches(tx: Tx, input: OpenPurchaseIntegrityCaseInput) {
  const specs = [
    [input.purchaseOrderId, purchaseOrders, purchaseOrders.id] as const,
    [input.goodsReceiptId, goodsReceipts, goodsReceipts.id] as const,
    [input.supplierInvoiceId, supplierInvoices, supplierInvoices.id] as const,
    [input.purchaseReturnId, purchaseReturns, purchaseReturns.id] as const,
    [input.supplierPaymentId, supplierPayments, supplierPayments.id] as const,
    [input.purchaseChargeId, purchaseCharges, purchaseCharges.id] as const,
  ];
  for (const [id, table, column] of specs) {
    if (id == null) continue;
    const row = (await tx.select({ branchId: (table as typeof purchaseOrders).branchId }).from(table as typeof purchaseOrders).where(eq(column, id)).limit(1))[0];
    if (!row) throw new TRPCError({ code: "BAD_REQUEST", message: "أحد المستندات المرتبطة غير موجود" });
    if (Number(row.branchId) !== input.branchId) throw new TRPCError({ code: "FORBIDDEN", message: "لا يجوز ربط قضية بمستند من فرع آخر" });
  }
}

async function appendEvent(tx: Tx, input: {
  eventKey: string;
  caseId: number;
  branchId: number;
  eventType: typeof purchaseIntegrityCaseEvents.$inferInsert["eventType"];
  previousStatus: typeof purchaseIntegrityCaseEvents.$inferInsert["previousStatus"];
  newStatus: typeof purchaseIntegrityCaseEvents.$inferInsert["newStatus"];
  payload: unknown;
  evidenceReference?: string | null;
  reason: string;
  actorId: number;
  counterpartyActorId?: number | null;
}) {
  const canonical = stableCanonical(input.payload);
  await tx.insert(purchaseIntegrityCaseEvents).values({ eventKey: input.eventKey, caseId: input.caseId, branchId: input.branchId, eventType: input.eventType, previousStatus: input.previousStatus, newStatus: input.newStatus, payloadCanonical: canonical, payloadHash: sha256(canonical), evidenceReference: input.evidenceReference ?? null, reason: input.reason, actorId: input.actorId, counterpartyActorId: input.counterpartyActorId ?? null });
}

export async function openPurchaseIntegrityCase(input: OpenPurchaseIntegrityCaseInput, actor: Actor) {
  const caseKey = required(input.caseKey, "مفتاح القضية", 180); const title = required(input.title, "عنوان القضية", 255); const description = required(input.description, "وصف القضية", 1000); const reason = required(input.reason, "سبب الفتح", 1000);
  assertPurchaseBranch({ branchId: input.branchId }, actor);
  const detectedAmount = input.detectedAmount == null ? null : toDbMoney(input.detectedAmount);
  if (detectedAmount != null && money(detectedAmount).isNegative()) throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ المكتشف لا يكون سالباً" });
  const evidenceSnapshot = stableCanonical(input.evidence); const evidenceHash = sha256(evidenceSnapshot);
  return withTx(async (tx) => {
    const replay = (await tx.select().from(purchaseIntegrityCases).where(eq(purchaseIntegrityCases.caseKey, caseKey)).limit(1))[0];
    if (replay) { assertPurchaseBranch(replay, actor); if (replay.evidenceHash !== evidenceHash) throw new TRPCError({ code: "CONFLICT", message: "مفتاح القضية مستعمل بدليل مختلف" }); return { caseId: Number(replay.id), status: replay.status, idempotent: true as const }; }
    // Same branch -> PO -> supplier -> invoice lock order as cash payment. Once the
    // evidence hold commits, a waiting payment must observe it before writing cash.
    if (PAYMENT_EVIDENCE_CASE_CODES.some((code) => code === input.code)) {
      await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, input.branchId)).for("share");
      if (input.purchaseOrderId != null) await tx.select({ id: purchaseOrders.id }).from(purchaseOrders).where(eq(purchaseOrders.id, input.purchaseOrderId)).for("update");
      if (input.supplierId != null) await tx.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, input.supplierId)).for("update");
      if (input.supplierInvoiceId != null) await tx.select({ id: supplierInvoices.id }).from(supplierInvoices).where(eq(supplierInvoices.id, input.supplierInvoiceId)).for("update");
    }
    await assertLinkedBranches(tx, input);
    const caseNumber = `PIC-${input.branchId}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${sha256(caseKey).slice(0, 16).toUpperCase()}`;
    const inserted = await tx.insert(purchaseIntegrityCases).values({ caseNumber, caseKey, openGuard: `OPEN:${caseKey}`, branchId: input.branchId, supplierId: input.supplierId ?? null, purchaseOrderId: input.purchaseOrderId ?? null, goodsReceiptId: input.goodsReceiptId ?? null, supplierInvoiceId: input.supplierInvoiceId ?? null, purchaseReturnId: input.purchaseReturnId ?? null, supplierPaymentId: input.supplierPaymentId ?? null, purchaseChargeId: input.purchaseChargeId ?? null, code: input.code, severity: input.severity, status: "OPEN", title, description, detectedAmount, evidenceSnapshot, evidenceHash, openedBy: actor.userId });
    const caseId = extractInsertId(inserted);
    await appendEvent(tx, { eventKey: `OPEN:${caseKey}`, caseId, branchId: input.branchId, eventType: "OPENED", previousStatus: null, newStatus: "OPEN", payload: { caseKey, evidenceHash, code: input.code, severity: input.severity }, reason, actorId: actor.userId });
    return { caseId, status: "OPEN" as const, idempotent: false as const };
  });
}

export async function requestPurchaseIntegrityResolutionInTx(tx: Tx, input: RequestIntegrityResolutionInput, actor: Actor) {
  const requestKey = required(input.requestKey, "مفتاح الطلب", 120); const reason = required(input.reason, "سبب الحل", 1000); const evidenceReference = required(input.evidenceReference, "مرجع دليل الحل", 500);
  const canonical = stableCanonical({ caseId: input.caseId, reason, evidenceReference }); const hash = sha256(canonical);
    const row = (await tx.select().from(purchaseIntegrityCases).where(eq(purchaseIntegrityCases.id, input.caseId)).for("update").limit(1))[0];
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "قضية النزاهة غير موجودة" }); assertPurchaseBranch(row, actor);
    if (row.status === "PENDING_RESOLUTION" && row.resolutionRequestKey === requestKey && row.resolutionRequestHash === hash) return { caseId: input.caseId, status: row.status, idempotent: true as const };
    if (!(["OPEN", "IN_REVIEW"] as const).includes(row.status as "OPEN" | "IN_REVIEW")) throw new TRPCError({ code: "CONFLICT", message: "حالة القضية لا تسمح بطلب حل" });
    const previousStatus = row.status;
    await tx.update(purchaseIntegrityCases).set({ status: "PENDING_RESOLUTION", resolutionRequestKey: requestKey, resolutionRequestHash: hash, resolutionRequestedBy: actor.userId, resolutionRequestedAt: new Date(), resolutionReason: reason, resolutionEvidenceReference: evidenceReference, pendingResolutionGuard: `RESOLUTION:${input.caseId}` }).where(eq(purchaseIntegrityCases.id, input.caseId));
    await appendEvent(tx, { eventKey: `RESOLUTION-REQUEST:${requestKey}`, caseId: input.caseId, branchId: Number(row.branchId), eventType: "RESOLUTION_REQUESTED", previousStatus, newStatus: "PENDING_RESOLUTION", payload: { requestKey, hash, evidenceReference }, evidenceReference, reason, actorId: actor.userId });
    return { caseId: input.caseId, status: "PENDING_RESOLUTION" as const, idempotent: false as const };
}

export async function requestPurchaseIntegrityResolution(input: RequestIntegrityResolutionInput, actor: Actor) {
  const requestKey = required(input.requestKey, "مفتاح الطلب", 120); const reason = required(input.reason, "سبب الحل", 1000); const evidenceReference = required(input.evidenceReference, "مرجع دليل الحل", 500);
  const result = await withTx(tx => requestPurchaseIntegrityResolutionInTx(tx, { ...input, requestKey, reason, evidenceReference }, actor));
  const approved = await autoDecideForActiveOwner(actor, {
    kind: "purchase.integrity.resolution",
    id: result.caseId,
    reason,
    variant: "APPROVE_RESOLVED",
  });
  return approved ? { ...result, status: "RESOLVED" as const } : result;
}

export async function decidePurchaseIntegrityResolutionInTx(tx: Tx, input: DecideIntegrityResolutionInput, actor: Actor) {
  const decisionKey = required(input.decisionKey, "مفتاح القرار", 120); const reason = required(input.reason, "سبب القرار", 1000); const canonical = stableCanonical({ caseId: input.caseId, decision: input.decision, reason }); const hash = sha256(canonical);
    const priorEvent = (await tx.select().from(purchaseIntegrityCaseEvents).where(eq(purchaseIntegrityCaseEvents.eventKey, `RESOLUTION-DECISION:${decisionKey}`)).limit(1))[0];
    if (priorEvent) { if (!payloadHashMatches(hash, priorEvent.payloadHash)) throw new TRPCError({ code: "CONFLICT", message: "مفتاح القرار مستعمل بقرار مختلف" }); assertPurchaseBranch(priorEvent, actor); return { caseId: input.caseId, status: priorEvent.newStatus, idempotent: true as const }; }
    const row = (await tx.select().from(purchaseIntegrityCases).where(eq(purchaseIntegrityCases.id, input.caseId)).for("update").limit(1))[0];
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "قضية النزاهة غير موجودة" }); assertPurchaseBranch(row, actor);
    if (row.status !== "PENDING_RESOLUTION" || row.resolutionRequestedBy == null) throw new TRPCError({ code: "CONFLICT", message: "لا يوجد طلب حل معلّق" });
    // حلُّ قضية السلامة لا مالَ فيه ولا محو: حالةٌ وحقولُ قرارٍ + حدثُ تدقيق، والمُفرَّغ
    // عند الرفض محفوظٌ في حدث RESOLUTION_REQUESTED فلا يضيع. ⇒ لا بوّابة.
    assertApprover({ actor: await resolveApprovalActor(tx, actor), trigger: purchaseIntegrityResolutionTrigger(), subject: `قضية سلامة ${row.caseKey}`, legacy: () => assertIndependentPurchaseReviewer(Number(row.resolutionRequestedBy), actor.userId) });
    if (input.decision === "REJECT") {
      await tx.update(purchaseIntegrityCases).set({ status: "IN_REVIEW", resolutionRequestKey: null, resolutionRequestHash: null, resolutionRequestedBy: null, resolutionRequestedAt: null, resolutionReason: null, resolutionEvidenceReference: null, pendingResolutionGuard: null }).where(eq(purchaseIntegrityCases.id, input.caseId));
      await appendEvent(tx, { eventKey: `RESOLUTION-DECISION:${decisionKey}`, caseId: input.caseId, branchId: Number(row.branchId), eventType: "RESOLUTION_REJECTED", previousStatus: "PENDING_RESOLUTION", newStatus: "IN_REVIEW", payload: { caseId: input.caseId, decision: input.decision, reason }, reason, actorId: actor.userId, counterpartyActorId: Number(row.resolutionRequestedBy) });
      return { caseId: input.caseId, status: "IN_REVIEW" as const, idempotent: false as const };
    }
    const newStatus = input.decision === "APPROVE_RESOLVED" ? "RESOLVED" as const : "DISMISSED" as const;
    await tx.update(purchaseIntegrityCases).set({ status: newStatus, openGuard: null, pendingResolutionGuard: null, decisionKey, decisionHash: hash, resolutionDecision: input.decision, resolvedBy: actor.userId, resolvedAt: new Date(), decisionReason: reason }).where(eq(purchaseIntegrityCases.id, input.caseId));
    await appendEvent(tx, { eventKey: `RESOLUTION-DECISION:${decisionKey}`, caseId: input.caseId, branchId: Number(row.branchId), eventType: input.decision === "APPROVE_RESOLVED" ? "RESOLUTION_APPROVED" : "DISMISSED", previousStatus: "PENDING_RESOLUTION", newStatus, payload: { caseId: input.caseId, decision: input.decision, reason }, reason, actorId: actor.userId, counterpartyActorId: Number(row.resolutionRequestedBy) });
    return { caseId: input.caseId, status: newStatus, idempotent: false as const };
}

export async function decidePurchaseIntegrityResolution(input: DecideIntegrityResolutionInput, actor: Actor) {
  const decisionKey = required(input.decisionKey, "مفتاح القرار", 120); const reason = required(input.reason, "سبب القرار", 1000);
  return withTx(tx => decidePurchaseIntegrityResolutionInTx(tx, { ...input, decisionKey, reason }, actor));
}

/** Owner-only evidence hold resolution, atomic with the caller's governed financial transaction. */
export async function resolvePurchaseIntegrityForOwnerInTx(tx: Tx, input: RequestIntegrityResolutionInput & {
  expectedPurchaseOrderId: number; expectedSupplierInvoiceId: number; expectedSupplierId: number; expectedBranchId: number;
}, actor: Actor) {
  const requestKey = required(input.requestKey, "مفتاح الطلب", 120); const reason = required(input.reason, "سبب الحل", 1000); const evidenceReference = required(input.evidenceReference, "مرجع دليل الحل", 500);
  const hash = sha256(stableCanonical({ caseId: input.caseId, reason, evidenceReference }));
  const decisionKey = `OWNER-IN-TX:${sha256(requestKey)}`;
  const [owner] = await tx.select({ id: users.id, isOwner: users.isOwner, isActive: users.isActive }).from(users).where(eq(users.id, actor.userId)).for("share").limit(1);
  if (!owner?.isActive || !owner.isOwner) throw new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({ what: "تعذر حل قضية دليل الدفع داخل معاملة الإقرار", why: "الفاعل ليس مالكاً نشطاً في قاعدة البيانات", doThis: "استخدم حساب المالك النشط وأعد التحقق من الإقرار" }) });
  const [row] = await tx.select().from(purchaseIntegrityCases).where(eq(purchaseIntegrityCases.id, input.caseId)).for("update").limit(1);
  if (!row || row.code !== "LEGACY_PAYMENT_EVIDENCE_INVALID" || row.purchaseOrderId !== input.expectedPurchaseOrderId || row.supplierInvoiceId !== input.expectedSupplierInvoiceId || row.supplierId !== input.expectedSupplierId || row.branchId !== input.expectedBranchId) throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تعذر ربط حل قضية النزاهة بالإقرار", why: "هوية القضية أو نوعها لا يطابق الأمر والفاتورة والمورد والفرع المحدد", doThis: "حدّث بيانات القضية والإقرار دون تغيير مصادرهما الأصلية" }) });
  const ownerActor: Actor = { ...actor, role: "admin", isOwner: true };
  const decision: DecideIntegrityResolutionInput = { caseId: input.caseId, decisionKey, decision: "APPROVE_RESOLVED", reason };
  const stableRequest = row.resolutionRequestKey === requestKey && payloadHashMatches(hash, row.resolutionRequestHash ?? "");
  if (row.status === "RESOLVED" && stableRequest && row.decisionKey === decisionKey && row.resolutionDecision === "APPROVE_RESOLVED") return decidePurchaseIntegrityResolutionInTx(tx, decision, ownerActor);
  if (!["OPEN", "IN_REVIEW"].includes(row.status) && !(row.status === "PENDING_RESOLUTION" && stableRequest)) throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تعذر حل قضية النزاهة داخل معاملة الإقرار", why: "القضية ليست مفتوحة أو قيد المراجعة أو مرتبطة بإعادة المحاولة نفسها", doThis: "راجع حالة القضية ومفتاح الإقرار قبل إعادة المحاولة" }) });
  await requestPurchaseIntegrityResolutionInTx(tx, { caseId: input.caseId, requestKey, reason, evidenceReference }, ownerActor);
  return decidePurchaseIntegrityResolutionInTx(tx, decision, ownerActor);
}

/** `order: "ASC"` = الأقدم اكتشافاً أوّلاً (صندوق القرارات) — القصّ بالأحدث يُسقط أكثر القضايا تأخّراً. */
export async function listPurchaseIntegrityCases(input: { branchId: number; status?: typeof purchaseIntegrityCases.$inferSelect["status"]; severity?: IntegritySeverity; limit?: number; order?: "ASC" | "DESC"; scan?: import("../decisions/scan").ScanPosition | null }, actor: Actor) {
  assertPurchaseBranch({ branchId: input.branchId }, actor);
  return withTx(async (tx) => {
    const filters = [eq(purchaseIntegrityCases.branchId, input.branchId)]; if (input.status) filters.push(eq(purchaseIntegrityCases.status, input.status)); if (input.severity) filters.push(eq(purchaseIntegrityCases.severity, input.severity));
    const ordering = input.order === "ASC"
      ? [asc(purchaseIntegrityCases.detectedAt), asc(purchaseIntegrityCases.id)]
      : [desc(purchaseIntegrityCases.detectedAt), desc(purchaseIntegrityCases.id)];
    return tx.select().from(purchaseIntegrityCases).where(and(...filters, scanAfter(purchaseIntegrityCases.id, input.scan, purchaseIntegrityCases.detectedAt))).orderBy(...ordering).limit(Math.min(input.limit ?? 100, 200));
  }, { gate: "NONE" });
}

export async function getPurchaseIntegrityCase(caseId: number, actor: Actor) {
  return withTx(async (tx) => {
    const row = (await tx.select().from(purchaseIntegrityCases).where(eq(purchaseIntegrityCases.id, caseId)).limit(1))[0]; if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "قضية النزاهة غير موجودة" }); assertPurchaseBranch(row, actor);
    const events = await tx.select().from(purchaseIntegrityCaseEvents).where(eq(purchaseIntegrityCaseEvents.caseId, caseId)).orderBy(asc(purchaseIntegrityCaseEvents.createdAt), asc(purchaseIntegrityCaseEvents.id)); return { ...row, events };
  }, { gate: "NONE" });
}

export async function listResolutionCandidates(branchId: number, actor: Actor) {
  assertPurchaseBranch({ branchId }, actor);
  return withTx((tx) => tx.select().from(purchaseIntegrityCases).where(and(eq(purchaseIntegrityCases.branchId, branchId), inArray(purchaseIntegrityCases.status, ["OPEN", "IN_REVIEW", "PENDING_RESOLUTION"]))).orderBy(desc(purchaseIntegrityCases.severity), asc(purchaseIntegrityCases.detectedAt)), { gate: "NONE" });
}
