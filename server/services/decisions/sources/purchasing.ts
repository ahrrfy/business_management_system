/**
 * ═══ مصادرُ المشتريات — الطوابيرُ التسعةُ المخفيّة (+ عكسُ الاستلام وعكسُ فاتورة المورّد) ═══
 *
 * هذه بالضبط العلّةُ المقيسة في `shared/decisionRegistry.ts`: شاشةُ اعتماد أوامر الشراء كانت
 * تُرجع `purchaseOrderId` و«عدد النسخة» بلا مورّدٍ ولا إجماليّ ولا صنف. كلُّ مصدرٍ هنا يقرأ
 * **ما يُقرَّر عليه** (المورّد · الأصناف بكمّياتها وأسعارها · الإجماليّ بعملته · الدليل · السبب)
 * ويحسم بدالّة الخدمة نفسها التي يستدعيها الراوتر الأصليّ — بلا منطقٍ ماليّ ثانٍ.
 *
 * **البوّابات كما في الراوترات:** `purchasesManagerProcedure` =
 * `moduleProcedure(["manager","purchasing"], "purchases", "FULL")` لكلّ شيءٍ عدا سداد المورّد
 * واسترداده (`treasuryManagerProcedure` = `["manager","accountant"]` على `treasury`).
 */
import { eq, inArray } from "drizzle-orm";
import {
  goodsReceiptReversalTrigger,
  purchaseChargeControlTrigger,
  purchaseIntegrityResolutionTrigger,
  purchaseOrderControlTrigger,
  purchaseRequisitionControlTrigger,
  purchaseReturnReversalTrigger,
  purchaseReturnTrigger,
  supplierInvoiceApprovalTrigger,
  supplierPaymentRefundTrigger,
  supplierPaymentTrigger,
} from "@shared/approvalTriggers";
import { decisionSubkindLabel, type DecisionKind, type DecisionSummaryItem } from "@shared/decisionRegistry";
import {
  goodsReceiptItems,
  goodsReceiptReversalRequestItems,
  goodsReceiptReversalRequests,
  goodsReceipts,
  purchaseChargeControlRequests,
  purchaseCharges,
  purchaseIntegrityCases,
  purchaseOrderControlRequests,
  purchaseOrderItems,
  purchaseOrderRevisionItems,
  purchaseOrderRevisions,
  purchaseOrders,
  purchaseRequisitionControlRequests,
  purchaseRequisitionItems,
  purchaseRequisitions,
  purchaseReturnItems,
  purchaseReturnRequestItems,
  purchaseReturnRequests,
  purchaseReturnReversalRequestItems,
  purchaseReturnReversalRequests,
  purchaseReturns,
  supplierInvoiceApprovalRequests,
  supplierInvoiceLines,
  supplierInvoices,
  supplierPaymentRefundRequests,
  supplierPaymentRequestAllocations,
  supplierPaymentRequests,
  supplierPayments,
} from "../../../../drizzle/schema";
import { decidePurchaseOrderControl, listPendingPurchaseOrderControls } from "../../purchase/controls";
import { decideGoodsReceiptReversal, listPendingGoodsReceiptReversals } from "../../purchase/goodsReceipts";
import { decidePurchaseIntegrityResolution, listPurchaseIntegrityCases } from "../../purchase/integrityCases";
import { decidePurchaseChargeControl, listPendingPurchaseChargeControls } from "../../purchase/purchaseCharges";
import { decidePurchaseRequisitionControl, listPendingPurchaseRequisitionControls } from "../../purchase/requisitions";
import {
  decidePurchaseReturn,
  decidePurchaseReturnReversal,
  listPendingPurchaseReturnRequests,
  listPendingPurchaseReturnReversalRequests,
} from "../../purchase/returnGovernance";
import { decideSupplierInvoiceApproval, listPendingSupplierInvoiceApprovals } from "../../purchase/supplierInvoices";
import {
  SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY,
  decideSupplierPayment,
  decideSupplierPaymentRefund,
  listPendingSupplierPaymentRefundRequests,
  listPendingSupplierPaymentRequests,
} from "../../purchase/supplierPayments";
import { requireDb } from "../../tx";
import { serviceActor } from "../gate";
import { buildRow, decided, decisionKeyFor, defaultMessage, itemLabel, moneyText, outcomeFor, statusOf, type RowInput } from "../rows";
import type { DecideInput, DecisionActor, DecisionScope, DecisionSource } from "../types";
import {
  branchIdsFor,
  branchNames,
  freshnessFrom,
  ids,
  sodHidden,
  supplierNames,
  unitNames,
  userNames,
  variantLabels,
  type Db,
} from "./common";

const PURCHASES_GATE = { type: "MODULE", moduleKey: "purchases", roles: ["manager", "purchasing"] } as const;
const TREASURY_GATE = { type: "MODULE", moduleKey: "treasury", roles: ["manager", "accountant"] } as const;
const LIST_LIMIT = 200;

/** الحقولُ المشتركة بين مصادر الحوكمة الشرائية: سببٌ إلزاميّ على القرارين (3–500 محرفاً). */
const GOVERNANCE_DEFAULTS = {
  approveReason: "REQUIRED",
  rejectReason: "REQUIRED",
  reasonMinLength: 3,
} as const satisfies Partial<RowInput>;

async function lookups(db: Db, args: { suppliers?: Array<number | null | undefined>; users?: Array<number | null | undefined>; branches?: Array<number | null | undefined> }) {
  const [sup, usr, br] = await Promise.all([
    supplierNames(db, ids(args.suppliers ?? [])),
    userNames(db, ids(args.users ?? [])),
    branchNames(db, ids(args.branches ?? [])),
  ]);
  return { supplier: (id: unknown) => sup.get(Number(id)) ?? null, user: (id: unknown) => usr.get(Number(id)) ?? null, branch: (id: unknown) => br.get(Number(id)) ?? null };
}

/** يجمع صفوفَ دالّةِ سردٍ تأخذ فرعاً واحداً على كلّ فروع النطاق. */
async function perBranch<T>(db: Db, actor: DecisionActor, scope: DecisionScope, fn: (branchId: number) => Promise<T[]>): Promise<T[]> {
  const branchIds = await branchIdsFor(db, actor, scope);
  const chunks = await Promise.all(branchIds.map((b) => fn(b)));
  return chunks.flat();
}

function outcomeMessage(input: DecideInput, res: unknown, subject: string) {
  const outcome = outcomeFor(input.action, statusOf(res));
  return decided(input, outcome, defaultMessage(outcome, subject));
}

// ───────────────────────────── ١) ضبط أمر الشراء ─────────────────────────────

export const purchaseOrderControlSource: DecisionSource = {
  key: "purchase.order.control",
  kinds: ["purchase.order.control"],
  gate: PURCHASES_GATE,
  async list(actor, scope) {
    const db = requireDb();
    const raw = await listPendingPurchaseOrderControls(serviceActor(actor), { limit: LIST_LIMIT });
    const rows = raw.slice(0, LIST_LIMIT).filter((r) => (scope.branchIds ? scope.branchIds.includes(Number(r.branchId)) : true));
    if (!rows.length) return [];
    const poIds = ids(rows.map((r) => r.purchaseOrderId));
    const revisionIds = ids(rows.map((r) => r.revisionId));
    const [orders, revisions, revisionItems, orderItems] = await Promise.all([
      db.select().from(purchaseOrders).where(inArray(purchaseOrders.id, poIds)),
      revisionIds.length ? db.select().from(purchaseOrderRevisions).where(inArray(purchaseOrderRevisions.id, revisionIds)) : Promise.resolve([]),
      revisionIds.length ? db.select().from(purchaseOrderRevisionItems).where(inArray(purchaseOrderRevisionItems.revisionId, revisionIds)) : Promise.resolve([]),
      db.select().from(purchaseOrderItems).where(inArray(purchaseOrderItems.purchaseOrderId, poIds)),
    ]);
    const orderById = new Map(orders.map((o) => [Number(o.id), o]));
    const revisionById = new Map(revisions.map((r) => [Number(r.id), r]));
    const [look, variants, units] = await Promise.all([
      lookups(db, { suppliers: orders.map((o) => o.supplierId), users: rows.map((r) => r.requestedBy), branches: rows.map((r) => r.branchId) }),
      variantLabels(db, ids(orderItems.map((i) => i.variantId))),
      unitNames(db, ids(orderItems.map((i) => i.productUnitId))),
    ]);
    return rows
      .filter((r) => {
        const po = orderById.get(Number(r.purchaseOrderId));
        return !sodHidden({
          blocked: [r.requestedBy, po?.createdBy, po?.lastEditedBy],
          actor,
          trigger: purchaseOrderControlTrigger(r.kind, true),
        });
      })
      .map((r) => {
        const po = orderById.get(Number(r.purchaseOrderId));
        const revision = r.revisionId != null ? revisionById.get(Number(r.revisionId)) : undefined;
        const currency = (revision?.agreedCurrency ?? po?.agreedCurrency ?? "IQD") as "IQD" | "USD";
        const usd = currency === "USD";
        const summaryItems: DecisionSummaryItem[] = revision
          ? revisionItems
              .filter((i) => Number(i.revisionId) === Number(revision.id))
              .map((i) => ({
                label: itemLabel([i.productNameSnapshot, i.variantNameSnapshot]),
                qty: i.quantity,
                unit: i.unitNameSnapshot,
                unitPrice: usd ? i.usdUnitPrice : i.unitPrice,
              }))
          : orderItems
              .filter((i) => Number(i.purchaseOrderId) === Number(r.purchaseOrderId))
              .map((i) => {
                const v = variants.get(Number(i.variantId));
                return {
                  label: itemLabel([v?.productName, v?.variantName]),
                  qty: i.quantity,
                  unit: i.productUnitId == null ? null : (units.get(Number(i.productUnitId)) ?? null),
                  unitPrice: usd ? i.usdUnitPrice : i.unitPrice,
                };
              });
        const amount = usd ? (revision?.usdTotal ?? po?.usdTotal ?? null) : (revision?.total ?? po?.total ?? null);
        return buildRow(
          {
            ...GOVERNANCE_DEFAULTS,
            kind: "purchase.order.control",
            id: Number(r.id),
            title: `${decisionSubkindLabel(r.kind)} · امر شراء ${r.poNumber}`,
            subkind: decisionSubkindLabel(r.kind),
            party: look.supplier(po?.supplierId),
            amount,
            currency,
            branchId: Number(r.branchId),
            branchName: look.branch(r.branchId),
            requestedBy: Number(r.requestedBy),
            requestedByName: r.requestedByName ?? look.user(r.requestedBy),
            requestedAt: r.requestedAt,
            summaryItems,
            reason: r.reason,
            hrefId: Number(r.purchaseOrderId),
            expectedVersion: Number(r.baseOrderVersion),
            confirmations:
              r.kind === "APPROVE_REVISION"
                ? [{ key: "confirmedFullReceipt", label: "اقر بان البضاعة وصلت كاملة ومطابقة للامر — الاعتماد يشغل الاستلام والفاتورة والذمة في معاملة واحدة" }]
                : [],
            trigger: purchaseOrderControlTrigger(r.kind, true),
          },
          scope.now,
        );
      });
  },
  freshness: (id) =>
    freshnessFrom(
      async () => (await requireDb().select({ status: purchaseOrderControlRequests.status }).from(purchaseOrderControlRequests).where(eq(purchaseOrderControlRequests.id, id)).limit(1))[0]?.status,
      ["PENDING"],
    ),
  async decide(input, actor) {
    const res = await decidePurchaseOrderControl(
      {
        requestId: input.id,
        decisionKey: decisionKeyFor(input.clientRequestId),
        approve: input.action === "APPROVE",
        reason: input.reason ?? "",
        confirmedFullReceipt: input.confirmations?.confirmedFullReceipt === true,
      },
      serviceActor(actor),
    );
    return outcomeMessage(input, res, `طلب ضبط امر الشراء رقم ${input.id}`);
  },
};

// ───────────────────────────── ٢) طلب الشراء الداخليّ ─────────────────────────────

export const purchaseRequisitionControlSource: DecisionSource = {
  key: "purchase.requisition.control",
  kinds: ["purchase.requisition.control"],
  gate: PURCHASES_GATE,
  async list(actor, scope) {
    const db = requireDb();
    const raw = await listPendingPurchaseRequisitionControls(serviceActor(actor), { limit: LIST_LIMIT });
    const rows = raw.slice(0, LIST_LIMIT).filter((r) => (scope.branchIds ? scope.branchIds.includes(Number(r.branchId)) : true));
    if (!rows.length) return [];
    const reqIds = ids(rows.map((r) => r.requisitionId));
    const [items, reqs] = await Promise.all([
      db.select().from(purchaseRequisitionItems).where(inArray(purchaseRequisitionItems.requisitionId, reqIds)),
      db.select({ id: purchaseRequisitions.id, purpose: purchaseRequisitions.purpose, neededBy: purchaseRequisitions.neededBy }).from(purchaseRequisitions).where(inArray(purchaseRequisitions.id, reqIds)),
    ]);
    const reqById = new Map(reqs.map((q) => [Number(q.id), q]));
    const [look, variants] = await Promise.all([
      lookups(db, { users: rows.map((r) => r.requestedBy), branches: rows.map((r) => r.branchId), suppliers: items.map((i) => i.preferredSupplierId) }),
      variantLabels(db, ids(items.map((i) => i.variantId))),
    ]);
    return rows
      .filter((r) => !sodHidden({ blocked: [r.requestedBy, r.creatorId, r.submittedBy], actor, ownerExempt: true, trigger: purchaseRequisitionControlTrigger() }))
      .map((r) => {
        const mine = items.filter((i) => Number(i.requisitionId) === Number(r.requisitionId));
        const summaryItems: DecisionSummaryItem[] = mine.map((i) => {
          const v = variants.get(Number(i.variantId));
          return { label: itemLabel([v?.productName, v?.variantName]), qty: i.requestedBaseQuantity, unit: "بالوحدة الأساس", unitPrice: i.estimatedUnitPrice ?? null };
        });
        const estimated = mine.reduce((sum, i) => (i.estimatedUnitPrice ? sum + Number(i.estimatedUnitPrice) * Number(i.requestedBaseQuantity) : sum), 0);
        const preferred = mine.map((i) => look.supplier(i.preferredSupplierId)).find((s) => !!s) ?? null;
        return buildRow(
          {
            ...GOVERNANCE_DEFAULTS,
            kind: "purchase.requisition.control",
            id: Number(r.id),
            title: `${decisionSubkindLabel(r.kind)} · طلب شراء ${r.requisitionNumber}`,
            subkind: decisionSubkindLabel(r.kind),
            party: preferred,
            amount: estimated > 0 ? estimated.toFixed(2) : null,
            branchId: Number(r.branchId),
            branchName: look.branch(r.branchId),
            requestedBy: Number(r.requestedBy),
            requestedByName: look.user(r.requestedBy),
            requestedAt: r.requestedAt,
            summaryItems,
            reason: [r.reason, reqById.get(Number(r.requisitionId))?.purpose].filter(Boolean).join(" — "),
            expectedVersion: Number(r.baseVersion),
            trigger: purchaseRequisitionControlTrigger(),
          },
          scope.now,
        );
      });
  },
  freshness: (id) =>
    freshnessFrom(
      async () => (await requireDb().select({ status: purchaseRequisitionControlRequests.status }).from(purchaseRequisitionControlRequests).where(eq(purchaseRequisitionControlRequests.id, id)).limit(1))[0]?.status,
      ["PENDING"],
    ),
  async decide(input, actor) {
    const res = await decidePurchaseRequisitionControl(
      { requestId: input.id, decisionKey: decisionKeyFor(input.clientRequestId), approve: input.action === "APPROVE", reason: input.reason ?? "" },
      serviceActor(actor),
    );
    return outcomeMessage(input, res, `طلب ضبط طلب الشراء رقم ${input.id}`);
  },
};

// ───────────────────────────── ٣) مصروف الشراء ─────────────────────────────

export const purchaseChargeControlSource: DecisionSource = {
  key: "purchase.charge.control",
  kinds: ["purchase.charge.control"],
  gate: PURCHASES_GATE,
  async list(actor, scope) {
    const db = requireDb();
    const rows = await perBranch(db, actor, scope, (b) => listPendingPurchaseChargeControls(b, serviceActor(actor)));
    if (!rows.length) return [];
    const charges = await db.select().from(purchaseCharges).where(inArray(purchaseCharges.id, ids(rows.map((r) => r.purchaseChargeId))));
    const chargeById = new Map(charges.map((c) => [Number(c.id), c]));
    const look = await lookups(db, { suppliers: charges.map((c) => c.payeeSupplierId), users: rows.map((r) => r.requestedBy), branches: rows.map((r) => r.branchId) });
    return rows
      .filter((r) => !sodHidden({ blocked: [r.requestedBy], actor, ownerExempt: true, trigger: purchaseChargeControlTrigger("APPROVE") }))
      .map((r) => {
        const c = chargeById.get(Number(r.purchaseChargeId));
        return buildRow(
          {
            ...GOVERNANCE_DEFAULTS,
            kind: "purchase.charge.control",
            id: Number(r.id),
            title: `${decisionSubkindLabel(r.kind)} مصروف شراء ${c?.chargeNumber ?? `#${r.purchaseChargeId}`}`,
            subkind: decisionSubkindLabel(r.kind),
            party: look.supplier(c?.payeeSupplierId),
            amount: c?.amount ?? null,
            branchId: Number(r.branchId),
            branchName: look.branch(r.branchId),
            requestedBy: Number(r.requestedBy),
            requestedByName: look.user(r.requestedBy),
            requestedAt: r.requestedAt,
            summaryItems: c
              ? [
                  { label: `نوع المصروف: ${c.chargeType}`, unitPrice: c.amount },
                  { label: `التسوية: ${c.settlement === "PAID" ? "مدفوع" : "ذمة"}${c.paymentMethod ? ` · ${c.paymentMethod}` : ""}` },
                  { label: `الدليل: ${r.evidenceReference}` },
                ]
              : [{ label: `الدليل: ${r.evidenceReference}` }],
            reason: r.reason,
            expectedVersion: Number(r.baseChargeVersion),
            trigger: purchaseChargeControlTrigger("APPROVE"),
          },
          scope.now,
        );
      });
  },
  freshness: (id) =>
    freshnessFrom(
      async () => (await requireDb().select({ status: purchaseChargeControlRequests.status }).from(purchaseChargeControlRequests).where(eq(purchaseChargeControlRequests.id, id)).limit(1))[0]?.status,
      ["PENDING"],
    ),
  async decide(input, actor) {
    const res = await decidePurchaseChargeControl(
      { requestId: input.id, decisionKey: decisionKeyFor(input.clientRequestId), action: input.action === "APPROVE" ? "APPROVE" : "REJECT", reviewReason: input.reason ?? "" },
      serviceActor(actor),
    );
    return outcomeMessage(input, res, `طلب مصروف الشراء رقم ${input.id}`);
  },
};

// ───────────────────────────── ٤) قضايا السلامة ─────────────────────────────

export const purchaseIntegritySource: DecisionSource = {
  key: "purchase.integrity.resolution",
  kinds: ["purchase.integrity.resolution"],
  gate: PURCHASES_GATE,
  async list(actor, scope) {
    const db = requireDb();
    const rows = await perBranch(db, actor, scope, (b) => listPurchaseIntegrityCases({ branchId: b, status: "PENDING_RESOLUTION", limit: LIST_LIMIT }, serviceActor(actor)));
    if (!rows.length) return [];
    const look = await lookups(db, { suppliers: rows.map((r) => r.supplierId), users: rows.map((r) => r.resolutionRequestedBy), branches: rows.map((r) => r.branchId) });
    return rows
      .filter((r) => !sodHidden({ blocked: [r.resolutionRequestedBy], actor, trigger: purchaseIntegrityResolutionTrigger() }))
      .map((r) =>
        buildRow(
          {
            ...GOVERNANCE_DEFAULTS,
            kind: "purchase.integrity.resolution",
            id: Number(r.id),
            title: `حل قضية سلامة ${r.caseNumber} · ${r.title}`,
            subkind: `${r.code} · ${r.severity}`,
            party: look.supplier(r.supplierId),
            amount: r.detectedAmount ?? null,
            branchId: Number(r.branchId),
            branchName: look.branch(r.branchId),
            requestedBy: r.resolutionRequestedBy == null ? null : Number(r.resolutionRequestedBy),
            requestedByName: look.user(r.resolutionRequestedBy),
            requestedAt: r.resolutionRequestedAt ?? r.detectedAt,
            summaryItems: [
              { label: r.description ?? r.title },
              ...(r.resolutionEvidenceReference ? [{ label: `الدليل: ${r.resolutionEvidenceReference}` }] : []),
            ],
            reason: r.resolutionReason ?? null,
            trigger: purchaseIntegrityResolutionTrigger(),
          },
          scope.now,
        ),
      );
  },
  freshness: (id) =>
    freshnessFrom(
      async () => (await requireDb().select({ status: purchaseIntegrityCases.status }).from(purchaseIntegrityCases).where(eq(purchaseIntegrityCases.id, id)).limit(1))[0]?.status,
      ["PENDING_RESOLUTION"],
    ),
  async decide(input, actor) {
    const res = await decidePurchaseIntegrityResolution(
      { caseId: input.id, decisionKey: decisionKeyFor(input.clientRequestId), decision: input.action === "APPROVE" ? "APPROVE_RESOLVED" : "REJECT", reason: input.reason ?? "" },
      serviceActor(actor),
    );
    const outcome = input.action === "APPROVE" ? "EXECUTED" : "REJECTED";
    return decided(input, outcome, `${defaultMessage(outcome, `قضية السلامة رقم ${input.id}`)} الحالة الآن ${res.status}.`);
  },
};

// ───────────────────────────── ٥) مرتجع الشراء ─────────────────────────────

export const purchaseReturnSource: DecisionSource = {
  key: "purchase.return.decide",
  kinds: ["purchase.return.decide"],
  gate: PURCHASES_GATE,
  async list(actor, scope) {
    const db = requireDb();
    const rows = await perBranch(db, actor, scope, (b) => listPendingPurchaseReturnRequests(b, serviceActor(actor)));
    if (!rows.length) return [];
    const items = await db.select().from(purchaseReturnRequestItems).where(inArray(purchaseReturnRequestItems.requestId, ids(rows.map((r) => r.id))));
    const [look, variants] = await Promise.all([
      lookups(db, { suppliers: rows.map((r) => r.supplierId), users: rows.map((r) => r.requestedBy), branches: rows.map((r) => r.branchId) }),
      variantLabels(db, ids(items.map((i) => i.variantId))),
    ]);
    return rows
      .filter((r) => !sodHidden({ blocked: [r.requestedBy], actor, ownerExempt: true, trigger: purchaseReturnTrigger("APPROVE") }))
      .map((r) =>
        buildRow(
          {
            ...GOVERNANCE_DEFAULTS,
            kind: "purchase.return.decide",
            id: Number(r.id),
            title: `مرتجع شراء · ${r.settlement === "CASH" ? `استرداد نقدي (${r.paymentMethod})` : "خصم من ذمة المورد"}`,
            subkind: r.settlement === "CASH" ? "نقدي" : "ذمة",
            party: look.supplier(r.supplierId),
            amount: r.requestedTotalAmount,
            branchId: Number(r.branchId),
            branchName: look.branch(r.branchId),
            requestedBy: Number(r.requestedBy),
            requestedByName: look.user(r.requestedBy),
            requestedAt: r.requestedAt,
            summaryItems: [
              ...items
                .filter((i) => Number(i.requestId) === Number(r.id))
                .map((i) => {
                  const v = variants.get(Number(i.variantId));
                  return { label: itemLabel([v?.productName, v?.variantName]), qty: i.requestedBaseQuantity, unit: "بالوحدة الأساس", unitPrice: i.unitPriceIqd };
                }),
              { label: `الدليل: ${r.evidenceType} — ${r.evidenceReference}` },
            ],
            reason: r.reason,
            hrefId: Number(r.id),
            expectedVersion: Number(r.baseInvoiceVersion),
            trigger: purchaseReturnTrigger("APPROVE"),
          },
          scope.now,
        ),
      );
  },
  freshness: (id) =>
    freshnessFrom(
      async () => (await requireDb().select({ status: purchaseReturnRequests.status }).from(purchaseReturnRequests).where(eq(purchaseReturnRequests.id, id)).limit(1))[0]?.status,
      ["PENDING"],
    ),
  async decide(input, actor) {
    const res = await decidePurchaseReturn(
      { requestId: input.id, decisionKey: decisionKeyFor(input.clientRequestId), action: input.action === "APPROVE" ? "APPROVE" : "REJECT", reviewReason: input.reason ?? "" },
      serviceActor(actor),
    );
    return outcomeMessage(input, res, `طلب مرتجع الشراء رقم ${input.id}`);
  },
};

// ───────────────────────────── ٦) عكس مرتجع الشراء ─────────────────────────────

export const purchaseReturnReversalSource: DecisionSource = {
  key: "purchase.return.reversal",
  kinds: ["purchase.return.reversal"],
  gate: PURCHASES_GATE,
  async list(actor, scope) {
    const db = requireDb();
    const rows = await perBranch(db, actor, scope, (b) => listPendingPurchaseReturnReversalRequests(b, serviceActor(actor)));
    if (!rows.length) return [];
    const [returns, reqItems] = await Promise.all([
      db.select().from(purchaseReturns).where(inArray(purchaseReturns.id, ids(rows.map((r) => r.purchaseReturnId)))),
      db.select().from(purchaseReturnReversalRequestItems).where(inArray(purchaseReturnReversalRequestItems.requestId, ids(rows.map((r) => r.id)))),
    ]);
    const returnItems = reqItems.length
      ? await db.select().from(purchaseReturnItems).where(inArray(purchaseReturnItems.id, ids(reqItems.map((i) => i.purchaseReturnItemId))))
      : [];
    const returnById = new Map(returns.map((x) => [Number(x.id), x]));
    const returnItemById = new Map(returnItems.map((x) => [Number(x.id), x]));
    const look = await lookups(db, { suppliers: returns.map((x) => x.supplierId), users: rows.map((r) => r.requestedBy), branches: rows.map((r) => r.branchId) });
    return rows
      .filter((r) => !sodHidden({ blocked: [r.requestedBy], actor, ownerExempt: true, trigger: purchaseReturnReversalTrigger("APPROVE") }))
      .map((r) => {
        const ret = returnById.get(Number(r.purchaseReturnId));
        const mine = reqItems.filter((i) => Number(i.requestId) === Number(r.id));
        const amount = mine.reduce((sum, i) => {
          const src = returnItemById.get(Number(i.purchaseReturnItemId));
          return src ? sum + Number(src.unitPrice) * Number(i.baseQuantity) : sum;
        }, 0);
        return buildRow(
          {
            ...GOVERNANCE_DEFAULTS,
            kind: "purchase.return.reversal",
            id: Number(r.id),
            title: `عكس مرتجع شراء ${ret?.returnNumber ?? `#${r.purchaseReturnId}`}`,
            party: look.supplier(ret?.supplierId),
            amount: amount > 0 ? amount.toFixed(2) : (ret?.totalAmount ?? null),
            branchId: Number(r.branchId),
            branchName: look.branch(r.branchId),
            requestedBy: Number(r.requestedBy),
            requestedByName: look.user(r.requestedBy),
            requestedAt: r.requestedAt,
            summaryItems: [
              ...mine.map((i) => {
                const src = returnItemById.get(Number(i.purchaseReturnItemId));
                return { label: itemLabel([src?.productNameSnapshot, src?.variantNameSnapshot]), qty: i.baseQuantity, unit: "بالوحدة الأساس", unitPrice: src?.unitPrice ?? null };
              }),
              { label: `الدليل: ${r.evidenceType} — ${r.evidenceReference}` },
            ],
            reason: r.reason,
            hrefId: Number(r.purchaseReturnId),
            expectedVersion: Number(r.baseReturnVersion),
            trigger: purchaseReturnReversalTrigger("APPROVE"),
          },
          scope.now,
        );
      });
  },
  freshness: (id) =>
    freshnessFrom(
      async () => (await requireDb().select({ status: purchaseReturnReversalRequests.status }).from(purchaseReturnReversalRequests).where(eq(purchaseReturnReversalRequests.id, id)).limit(1))[0]?.status,
      ["PENDING"],
    ),
  async decide(input, actor) {
    const res = await decidePurchaseReturnReversal(
      { requestId: input.id, decisionKey: decisionKeyFor(input.clientRequestId), action: input.action === "APPROVE" ? "APPROVE" : "REJECT", reviewReason: input.reason ?? "" },
      serviceActor(actor),
    );
    return outcomeMessage(input, res, `طلب عكس مرتجع الشراء رقم ${input.id}`);
  },
};

// ───────────────────────────── ٧) سداد المورّد ─────────────────────────────

export const supplierPaymentSource: DecisionSource = {
  key: "supplier.payment.decide",
  kinds: ["supplier.payment.decide"],
  gate: TREASURY_GATE,
  async list(actor, scope) {
    const db = requireDb();
    const rows = await perBranch(db, actor, scope, (b) => listPendingSupplierPaymentRequests(b, serviceActor(actor)));
    if (!rows.length) return [];
    const allocations = await db.select().from(supplierPaymentRequestAllocations).where(inArray(supplierPaymentRequestAllocations.requestId, ids(rows.map((r) => r.id))));
    const invoices = allocations.length
      ? await db.select({ id: supplierInvoices.id, invoiceNumber: supplierInvoices.invoiceNumber, externalInvoiceNumber: supplierInvoices.externalInvoiceNumber }).from(supplierInvoices).where(inArray(supplierInvoices.id, ids(allocations.map((a) => a.supplierInvoiceId))))
      : [];
    const invoiceById = new Map(invoices.map((i) => [Number(i.id), i]));
    const look = await lookups(db, { suppliers: rows.map((r) => r.supplierId), users: rows.map((r) => r.requestedBy), branches: rows.map((r) => r.branchId) });
    return rows
      .filter((r) => !sodHidden({ blocked: [r.requestedBy], actor, ownerExempt: true, trigger: supplierPaymentTrigger("APPROVE") }))
      .map((r) => {
        const usd = r.currency === "USD";
        return buildRow(
          {
            ...GOVERNANCE_DEFAULTS,
            kind: "supplier.payment.decide",
            id: Number(r.id),
            title: `سداد مورد · ${r.paymentMethod}${r.externalReference ? ` · ${r.externalReference}` : ""}`,
            subkind: r.paymentMethod,
            party: look.supplier(r.supplierId),
            amount: usd ? r.requestedCurrencyAmount : r.requestedAmount,
            currency: usd ? "USD" : "IQD",
            branchId: Number(r.branchId),
            branchName: look.branch(r.branchId),
            requestedBy: Number(r.requestedBy),
            requestedByName: look.user(r.requestedBy),
            requestedAt: r.requestedAt,
            summaryItems: [
              ...allocations
                .filter((a) => Number(a.requestId) === Number(r.id))
                .map((a) => {
                  const inv = invoiceById.get(Number(a.supplierInvoiceId));
                  return { label: `فاتورة ${inv?.externalInvoiceNumber ?? inv?.invoiceNumber ?? `#${a.supplierInvoiceId}`}`, unitPrice: usd ? a.requestedCurrencyAmount : a.requestedAmount };
                }),
              { label: `الدليل: ${r.evidenceType} — ${r.evidenceReference}` },
            ],
            reason: r.reason,
            trigger: supplierPaymentTrigger("APPROVE"),
          },
          scope.now,
        );
      });
  },
  freshness: (id) =>
    freshnessFrom(
      async () => (await requireDb().select({ status: supplierPaymentRequests.status }).from(supplierPaymentRequests).where(eq(supplierPaymentRequests.id, id)).limit(1))[0]?.status,
      ["PENDING"],
    ),
  async decide(input, actor) {
    const res = await decideSupplierPayment(
      { requestId: input.id, decisionKey: decisionKeyFor(input.clientRequestId), action: input.action === "APPROVE" ? "APPROVE" : "REJECT", reviewReason: input.reason ?? "" },
      serviceActor(actor),
      SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY,
    );
    return outcomeMessage(input, res, `طلب سداد المورد رقم ${input.id}`);
  },
};

// ───────────────────────────── ٨) استرداد سداد المورّد ─────────────────────────────

export const supplierPaymentRefundSource: DecisionSource = {
  key: "supplier.payment.refund",
  kinds: ["supplier.payment.refund"],
  gate: TREASURY_GATE,
  async list(actor, scope) {
    const db = requireDb();
    const pages = await perBranch(db, actor, scope, async (b) => (await listPendingSupplierPaymentRefundRequests({ branchId: b, limit: LIST_LIMIT }, serviceActor(actor))).rows);
    if (!pages.length) return [];
    const payments = await db.select().from(supplierPayments).where(inArray(supplierPayments.id, ids(pages.map((r) => r.supplierPaymentId))));
    const paymentById = new Map(payments.map((p) => [Number(p.id), p]));
    const look = await lookups(db, { suppliers: payments.map((p) => p.supplierId), users: pages.map((r) => r.requestedBy), branches: pages.map((r) => r.branchId) });
    return pages
      .filter((r) => !sodHidden({ blocked: [r.requestedBy], actor, ownerExempt: true, trigger: supplierPaymentRefundTrigger("APPROVE") }))
      .map((r) => {
        const p = paymentById.get(Number(r.supplierPaymentId));
        const usd = p?.currency === "USD";
        return buildRow(
          {
            ...GOVERNANCE_DEFAULTS,
            kind: "supplier.payment.refund",
            id: Number(r.id),
            title: `استرداد سداد مورد ${p?.paymentNumber ?? `#${r.supplierPaymentId}`} · ${r.refundMethod}`,
            subkind: r.refundMethod,
            party: look.supplier(p?.supplierId),
            amount: usd ? r.requestedCurrencyAmount : r.requestedAmount,
            currency: usd ? "USD" : "IQD",
            branchId: Number(r.branchId),
            branchName: look.branch(r.branchId),
            requestedBy: Number(r.requestedBy),
            requestedByName: look.user(r.requestedBy),
            requestedAt: r.requestedAt,
            summaryItems: [
              { label: `الدفعة الاصلية ${p?.paymentNumber ?? ""}`, unitPrice: p ? (usd ? p.currencyAmount : p.amount) : null },
              { label: `الدليل: ${r.evidenceType} — ${r.evidenceReference}` },
            ],
            reason: r.reason,
            expectedVersion: Number(r.basePaymentVersion),
            trigger: supplierPaymentRefundTrigger("APPROVE"),
          },
          scope.now,
        );
      });
  },
  freshness: (id) =>
    freshnessFrom(
      async () => (await requireDb().select({ status: supplierPaymentRefundRequests.status }).from(supplierPaymentRefundRequests).where(eq(supplierPaymentRefundRequests.id, id)).limit(1))[0]?.status,
      ["PENDING"],
    ),
  async decide(input, actor) {
    const res = await decideSupplierPaymentRefund(
      { requestId: input.id, decisionKey: decisionKeyFor(input.clientRequestId), action: input.action === "APPROVE" ? "APPROVE" : "REJECT", reviewReason: input.reason ?? "" },
      serviceActor(actor),
      SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY,
    );
    return outcomeMessage(input, res, `طلب استرداد سداد المورد رقم ${input.id}`);
  },
};

// ───────────────────────────── ٩) عكس استلام البضاعة ─────────────────────────────

export const goodsReceiptReversalSource: DecisionSource = {
  key: "purchase.goodsReceipt.reversal",
  kinds: ["purchase.goodsReceipt.reversal"],
  gate: PURCHASES_GATE,
  async list(actor, scope) {
    const db = requireDb();
    const rows = await perBranch(db, actor, scope, (b) => listPendingGoodsReceiptReversals(b, serviceActor(actor)));
    if (!rows.length) return [];
    const [receipts, reqItems] = await Promise.all([
      db.select().from(goodsReceipts).where(inArray(goodsReceipts.id, ids(rows.map((r) => r.goodsReceiptId)))),
      db.select().from(goodsReceiptReversalRequestItems).where(inArray(goodsReceiptReversalRequestItems.requestId, ids(rows.map((r) => r.id)))),
    ]);
    const receiptItems = reqItems.length
      ? await db.select().from(goodsReceiptItems).where(inArray(goodsReceiptItems.id, ids(reqItems.map((i) => i.goodsReceiptItemId))))
      : [];
    const receiptById = new Map(receipts.map((x) => [Number(x.id), x]));
    const receiptItemById = new Map(receiptItems.map((x) => [Number(x.id), x]));
    const poIds = ids(receipts.map((x) => x.purchaseOrderId));
    const orders = poIds.length ? await db.select({ id: purchaseOrders.id, createdBy: purchaseOrders.createdBy, approvedBy: purchaseOrders.approvedBy }).from(purchaseOrders).where(inArray(purchaseOrders.id, poIds)) : [];
    const orderById = new Map(orders.map((o) => [Number(o.id), o]));
    const [look, variants] = await Promise.all([
      lookups(db, { suppliers: receipts.map((x) => x.supplierId), users: rows.map((r) => r.requestedBy), branches: rows.map((r) => r.branchId) }),
      variantLabels(db, ids(receiptItems.map((i) => i.variantId))),
    ]);
    return rows
      .filter((r) => {
        const receipt = receiptById.get(Number(r.goodsReceiptId));
        const po = receipt ? orderById.get(Number(receipt.purchaseOrderId)) : undefined;
        return !sodHidden({ blocked: [r.requestedBy, receipt?.createdBy, receipt?.postedBy, po?.createdBy, po?.approvedBy], actor, ownerExempt: true, trigger: goodsReceiptReversalTrigger("APPROVE") });
      })
      .map((r) => {
        const receipt = receiptById.get(Number(r.goodsReceiptId));
        const mine = reqItems.filter((i) => Number(i.requestId) === Number(r.id));
        const amount = mine.reduce((sum, i) => {
          const src = receiptItemById.get(Number(i.goodsReceiptItemId));
          return src ? sum + Number(src.unitCostIqd) * Number(i.baseQuantity) : sum;
        }, 0);
        return buildRow(
          {
            ...GOVERNANCE_DEFAULTS,
            kind: "purchase.goodsReceipt.reversal",
            id: Number(r.id),
            title: `عكس استلام بضاعة ${receipt?.receiptNumber ?? `#${r.goodsReceiptId}`}`,
            party: look.supplier(receipt?.supplierId),
            amount: amount > 0 ? amount.toFixed(2) : (receipt?.totalAmount ?? null),
            branchId: Number(r.branchId),
            branchName: look.branch(r.branchId),
            requestedBy: Number(r.requestedBy),
            requestedByName: look.user(r.requestedBy),
            requestedAt: r.requestedAt,
            summaryItems: mine.map((i) => {
              const src = receiptItemById.get(Number(i.goodsReceiptItemId));
              const v = src ? variants.get(Number(src.variantId)) : undefined;
              return { label: itemLabel([v?.productName, v?.variantName]), qty: i.baseQuantity, unit: "بالوحدة الأساس", unitPrice: src?.unitCostIqd ?? null };
            }),
            reason: r.reason,
            expectedVersion: Number(r.baseReceiptVersion),
            trigger: goodsReceiptReversalTrigger("APPROVE"),
          },
          scope.now,
        );
      });
  },
  freshness: (id) =>
    freshnessFrom(
      async () => (await requireDb().select({ status: goodsReceiptReversalRequests.status }).from(goodsReceiptReversalRequests).where(eq(goodsReceiptReversalRequests.id, id)).limit(1))[0]?.status,
      ["PENDING"],
    ),
  async decide(input, actor) {
    const res = await decideGoodsReceiptReversal(
      { requestId: input.id, decisionKey: decisionKeyFor(input.clientRequestId), action: input.action === "APPROVE" ? "APPROVE" : "REJECT", reviewReason: input.reason ?? "" },
      serviceActor(actor),
    );
    return outcomeMessage(input, res, `طلب عكس الاستلام رقم ${input.id}`);
  },
};

// ───────────────────────────── ١٠) عكس فاتورة المورّد ─────────────────────────────

export const supplierInvoiceApprovalSource: DecisionSource = {
  key: "purchase.supplierInvoice.reversal",
  kinds: ["purchase.supplierInvoice.reversal"],
  gate: PURCHASES_GATE,
  async list(actor, scope) {
    const db = requireDb();
    const rows = await perBranch(db, actor, scope, (b) => listPendingSupplierInvoiceApprovals(b, serviceActor(actor)));
    if (!rows.length) return [];
    const invoiceIds = ids(rows.map((r) => r.supplierInvoiceId));
    const [invoices, lines] = await Promise.all([
      db.select().from(supplierInvoices).where(inArray(supplierInvoices.id, invoiceIds)),
      db.select().from(supplierInvoiceLines).where(inArray(supplierInvoiceLines.supplierInvoiceId, invoiceIds)),
    ]);
    const invoiceById = new Map(invoices.map((i) => [Number(i.id), i]));
    const look = await lookups(db, { suppliers: invoices.map((i) => i.supplierId), users: rows.map((r) => r.requestedBy), branches: rows.map((r) => r.branchId) });
    return rows
      .filter((r) => {
        const inv = invoiceById.get(Number(r.supplierInvoiceId));
        return !sodHidden({ blocked: [r.requestedBy, inv?.createdBy], actor, ownerExempt: true, trigger: supplierInvoiceApprovalTrigger(r.kind, "APPROVE") });
      })
      .map((r) => {
        const inv = invoiceById.get(Number(r.supplierInvoiceId));
        const usd = inv?.currency === "USD";
        return buildRow(
          {
            ...GOVERNANCE_DEFAULTS,
            kind: "purchase.supplierInvoice.reversal",
            id: Number(r.id),
            title: `${decisionSubkindLabel(r.kind)} · فاتورة مورد ${inv?.externalInvoiceNumber ?? inv?.invoiceNumber ?? `#${r.supplierInvoiceId}`}`,
            subkind: decisionSubkindLabel(r.kind),
            party: look.supplier(inv?.supplierId),
            amount: usd ? (inv?.usdTotal ?? null) : (inv?.totalAmount ?? null),
            currency: usd ? "USD" : "IQD",
            branchId: Number(r.branchId),
            branchName: look.branch(r.branchId),
            requestedBy: Number(r.requestedBy),
            requestedByName: look.user(r.requestedBy),
            requestedAt: r.requestedAt,
            summaryItems: [
              ...lines
                .filter((l) => Number(l.supplierInvoiceId) === Number(r.supplierInvoiceId))
                .map((l) => ({ label: l.description, qty: l.invoicedBaseQuantity, unit: "بالوحدة الأساس", unitPrice: usd ? l.usdUnitPrice : l.unitPriceIqd })),
              ...(r.evidenceReference ? [{ label: `الدليل: ${r.evidenceType ?? ""} — ${r.evidenceReference}` }] : []),
            ],
            reason: r.reason,
            expectedVersion: Number(r.baseInvoiceVersion),
            trigger: supplierInvoiceApprovalTrigger(r.kind, "APPROVE"),
          },
          scope.now,
        );
      });
  },
  freshness: (id) =>
    freshnessFrom(
      async () => (await requireDb().select({ status: supplierInvoiceApprovalRequests.status }).from(supplierInvoiceApprovalRequests).where(eq(supplierInvoiceApprovalRequests.id, id)).limit(1))[0]?.status,
      ["PENDING"],
    ),
  async decide(input, actor) {
    const res = await decideSupplierInvoiceApproval(
      { requestId: input.id, decisionKey: decisionKeyFor(input.clientRequestId), action: input.action === "APPROVE" ? "APPROVE" : "REJECT", reviewReason: input.reason ?? "" },
      serviceActor(actor),
    );
    return outcomeMessage(input, res, `طلب عكس فاتورة المورد رقم ${input.id}`);
  },
};

export const PURCHASING_SOURCES: readonly DecisionSource[] = [
  purchaseOrderControlSource,
  purchaseRequisitionControlSource,
  purchaseChargeControlSource,
  purchaseIntegritySource,
  purchaseReturnSource,
  purchaseReturnReversalSource,
  supplierPaymentSource,
  supplierPaymentRefundSource,
  goodsReceiptReversalSource,
  supplierInvoiceApprovalSource,
];

/** للاختبار: الأنواع التي يغطّيها هذا الملفّ. */
export const PURCHASING_KINDS: readonly DecisionKind[] = PURCHASING_SOURCES.flatMap((s) => s.kinds);

export { moneyText as _moneyText };
