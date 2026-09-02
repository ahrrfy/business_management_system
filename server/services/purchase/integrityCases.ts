import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  goodsReceipts,
  purchaseCharges,
  purchaseIntegrityCaseEvents,
  purchaseIntegrityCases,
  purchaseOrders,
  purchaseReturns,
  supplierInvoices,
  supplierPayments,
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
    await assertLinkedBranches(tx, input);
    const caseNumber = `PIC-${input.branchId}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${sha256(caseKey).slice(0, 16).toUpperCase()}`;
    const inserted = await tx.insert(purchaseIntegrityCases).values({ caseNumber, caseKey, openGuard: `OPEN:${caseKey}`, branchId: input.branchId, supplierId: input.supplierId ?? null, purchaseOrderId: input.purchaseOrderId ?? null, goodsReceiptId: input.goodsReceiptId ?? null, supplierInvoiceId: input.supplierInvoiceId ?? null, purchaseReturnId: input.purchaseReturnId ?? null, supplierPaymentId: input.supplierPaymentId ?? null, purchaseChargeId: input.purchaseChargeId ?? null, code: input.code, severity: input.severity, status: "OPEN", title, description, detectedAmount, evidenceSnapshot, evidenceHash, openedBy: actor.userId });
    const caseId = extractInsertId(inserted);
    await appendEvent(tx, { eventKey: `OPEN:${caseKey}`, caseId, branchId: input.branchId, eventType: "OPENED", previousStatus: null, newStatus: "OPEN", payload: { caseKey, evidenceHash, code: input.code, severity: input.severity }, reason, actorId: actor.userId });
    return { caseId, status: "OPEN" as const, idempotent: false as const };
  });
}

export async function requestPurchaseIntegrityResolution(input: RequestIntegrityResolutionInput, actor: Actor) {
  const requestKey = required(input.requestKey, "مفتاح الطلب", 120); const reason = required(input.reason, "سبب الحل", 1000); const evidenceReference = required(input.evidenceReference, "مرجع دليل الحل", 500);
  const canonical = stableCanonical({ caseId: input.caseId, reason, evidenceReference }); const hash = sha256(canonical);
  return withTx(async (tx) => {
    const row = (await tx.select().from(purchaseIntegrityCases).where(eq(purchaseIntegrityCases.id, input.caseId)).for("update").limit(1))[0];
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "قضية النزاهة غير موجودة" }); assertPurchaseBranch(row, actor);
    if (row.status === "PENDING_RESOLUTION" && row.resolutionRequestKey === requestKey && row.resolutionRequestHash === hash) return { caseId: input.caseId, status: row.status, idempotent: true as const };
    if (!(["OPEN", "IN_REVIEW"] as const).includes(row.status as "OPEN" | "IN_REVIEW")) throw new TRPCError({ code: "CONFLICT", message: "حالة القضية لا تسمح بطلب حل" });
    const previousStatus = row.status;
    await tx.update(purchaseIntegrityCases).set({ status: "PENDING_RESOLUTION", resolutionRequestKey: requestKey, resolutionRequestHash: hash, resolutionRequestedBy: actor.userId, resolutionRequestedAt: new Date(), resolutionReason: reason, resolutionEvidenceReference: evidenceReference, pendingResolutionGuard: `RESOLUTION:${input.caseId}` }).where(eq(purchaseIntegrityCases.id, input.caseId));
    await appendEvent(tx, { eventKey: `RESOLUTION-REQUEST:${requestKey}`, caseId: input.caseId, branchId: Number(row.branchId), eventType: "RESOLUTION_REQUESTED", previousStatus, newStatus: "PENDING_RESOLUTION", payload: { requestKey, hash, evidenceReference }, evidenceReference, reason, actorId: actor.userId });
    return { caseId: input.caseId, status: "PENDING_RESOLUTION" as const, idempotent: false as const };
  });
}

export async function decidePurchaseIntegrityResolution(input: DecideIntegrityResolutionInput, actor: Actor) {
  const decisionKey = required(input.decisionKey, "مفتاح القرار", 120); const reason = required(input.reason, "سبب القرار", 1000); const canonical = stableCanonical({ caseId: input.caseId, decision: input.decision, reason }); const hash = sha256(canonical);
  return withTx(async (tx) => {
    const priorEvent = (await tx.select().from(purchaseIntegrityCaseEvents).where(eq(purchaseIntegrityCaseEvents.eventKey, `RESOLUTION-DECISION:${decisionKey}`)).limit(1))[0];
    if (priorEvent) { if (priorEvent.payloadHash !== hash) throw new TRPCError({ code: "CONFLICT", message: "مفتاح القرار مستعمل بقرار مختلف" }); assertPurchaseBranch(priorEvent, actor); return { caseId: input.caseId, status: priorEvent.newStatus, idempotent: true as const }; }
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
  });
}

export async function listPurchaseIntegrityCases(input: { branchId: number; status?: typeof purchaseIntegrityCases.$inferSelect["status"]; severity?: IntegritySeverity; limit?: number }, actor: Actor) {
  assertPurchaseBranch({ branchId: input.branchId }, actor);
  return withTx(async (tx) => {
    const filters = [eq(purchaseIntegrityCases.branchId, input.branchId)]; if (input.status) filters.push(eq(purchaseIntegrityCases.status, input.status)); if (input.severity) filters.push(eq(purchaseIntegrityCases.severity, input.severity));
    return tx.select().from(purchaseIntegrityCases).where(and(...filters)).orderBy(desc(purchaseIntegrityCases.detectedAt), desc(purchaseIntegrityCases.id)).limit(Math.min(input.limit ?? 100, 200));
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
