/**
 * مصادرُ المبيعات وأوامر الشغل: ضبطُ البيع، طلباتُ المرتجع، ضبطُ أمر الشغل، ردُّ عربون الإلغاء.
 */
import { and, eq, inArray } from "drizzle-orm";
import { decisionSubkindLabel } from "@shared/decisionRegistry";
import { SALES_CONTROL_TYPE_LABELS, type SalesControlType } from "@shared/salesControl";
import { invoices, receipts, returnRequests, salesControlRequests, workOrderControlRequests, workOrders } from "../../../../drizzle/schema";
import { listReturnRequests, rejectReturnRequest } from "../../returns/requests";
import { approveSalesControlRequest, listSalesControlRequests, rejectSalesControlRequest } from "../../sale/controlRequests";
import { requireDb } from "../../tx";
import { approveWorkOrderCancellationRefund, listPendingWorkOrderCancellationRefunds } from "../../workOrder/cancel";
import { approveWorkOrderControlRequest, listPendingWorkOrderControls, rejectWorkOrderControlRequest } from "../../workOrder/controlRequests";
import { serviceActor } from "../gate";
import { buildRow, decided, defaultMessage, outcomeFor, statusOf } from "../rows";
import type { DecisionSource } from "../types";
import { branchNames, customerNames, freshnessFrom, ids, scopeBranch, sodHidden } from "./common";

const SALES_GATE = { type: "MODULE", moduleKey: "sales", roles: ["manager"] } as const;
const WORKORDERS_GATE = { type: "MODULE", moduleKey: "workorders", roles: ["manager"] } as const;

type RefundLine = { productName?: string; name?: string; quantity?: number | string; unitPrice?: string; total?: string };

/** بنودُ طلبٍ مخزَّنة JSON — نعرض ما نجد فيها بلا افتراض شكلٍ صارم. */
function linesOf(payload: unknown): RefundLine[] {
  if (!payload || typeof payload !== "object") return [];
  const p = payload as { lines?: unknown };
  const lines = Array.isArray(payload) ? payload : Array.isArray(p.lines) ? p.lines : [];
  return lines.filter((l): l is RefundLine => !!l && typeof l === "object");
}

// ───────────────────────────── ١) ضبط البيع ─────────────────────────────

/**
 * [`salesControlRouter.ts:124`](../../../routers/salesControlRouter.ts) ⇐ `approveSalesControlRequest`.
 * فصلُ المهام في الخدمة **بلا استثناء للأدمن**: الطالبُ ومنشئُ الفاتورة لا يراجعان.
 */
export const salesControlSource: DecisionSource = {
  key: "sales.control",
  kinds: ["sales.control.approve", "sales.control.reject"],
  gate: SALES_GATE,
  async list(actor, scope) {
    const db = requireDb();
    const raw = await listSalesControlRequests(serviceActor(actor), { status: "PENDING" });
    const rows = raw.filter((r) => (scope.branchIds ? scope.branchIds.includes(Number(r.branchId)) : true));
    if (!rows.length) return [];
    const invoiceRows = await db
      .select({ id: invoices.id, customerId: invoices.customerId, contactName: invoices.contactName })
      .from(invoices)
      .where(inArray(invoices.id, ids(rows.map((r) => r.invoiceId))));
    const invoiceById = new Map(invoiceRows.map((i) => [Number(i.id), i]));
    const [customers, branches] = await Promise.all([
      customerNames(db, ids(invoiceRows.map((i) => i.customerId))),
      branchNames(db, ids(rows.map((r) => r.branchId))),
    ]);
    return rows
      .filter((r) => !sodHidden({ blocked: [r.requestedBy, r.invoiceCreatedBy], actor, trigger: "ERASE_EFFECT" }))
      .map((r) => {
        const inv = invoiceById.get(Number(r.invoiceId));
        const label = SALES_CONTROL_TYPE_LABELS[r.requestType as SalesControlType] ?? r.requestType;
        return buildRow(
          {
            kind: "sales.control.approve",
            id: Number(r.id),
            title: `${label} · فاتورة ${r.invoiceNumber ?? `#${r.invoiceId}`}`,
            subkind: label,
            party: (inv?.customerId != null ? customers.get(Number(inv.customerId)) : null) ?? inv?.contactName ?? null,
            amount: r.invoiceTotal,
            branchId: Number(r.branchId),
            branchName: branches.get(Number(r.branchId)) ?? null,
            requestedBy: Number(r.requestedBy),
            requestedByName: r.requestedByName ?? null,
            requestedAt: r.createdAt,
            summaryItems: linesOf(r.payload).map((l) => ({ label: l.productName ?? l.name ?? "بند", qty: l.quantity ?? null, unitPrice: l.unitPrice ?? l.total ?? null })),
            reason: r.reason,
            hrefId: Number(r.invoiceId),
            trigger: "ERASE_EFFECT",
          },
          scope.now,
        );
      });
  },
  freshness: (id) =>
    freshnessFrom(
      async () => (await requireDb().select({ status: salesControlRequests.status }).from(salesControlRequests).where(eq(salesControlRequests.id, id)).limit(1))[0]?.status,
      ["PENDING"],
    ),
  async decide(input, actor) {
    const subject = `طلب ضبط البيع رقم ${input.id}`;
    if (input.action === "REJECT") {
      await rejectSalesControlRequest(input.id, input.reason ?? "", serviceActor(actor));
      return decided(input, "REJECTED", defaultMessage("REJECTED", subject));
    }
    const res = await approveSalesControlRequest(input.id, serviceActor(actor), input.reason ?? null, null);
    const outcome = outcomeFor("APPROVE", statusOf(res));
    return decided(input, outcome, defaultMessage(outcome, subject));
  },
};

// ───────────────────────────── ٢) طلبات المرتجع ─────────────────────────────

/**
 * [`returnRouter.ts:258`](../../../routers/returnRouter.ts). الاعتمادُ يحتاج قرارَ **رافد الردّ**
 * (نقد/بطاقة/ذمّة) والدرج والمرجع من المعتمِد لحظةَ الاعتماد — مدخلٌ لا يحمله الصفّ، فيُفتح
 * من شاشته؛ والرفضُ بسببه يقع هنا.
 */
export const returnRequestSource: DecisionSource = {
  key: "sales.returnRequest",
  kinds: ["sales.returnRequest.approve", "sales.returnRequest.reject"],
  gate: SALES_GATE,
  async list(actor, scope) {
    const branchId = scopeBranch(actor, scope);
    if (branchId === "NONE") return [];
    const db = requireDb();
    const rows = await listReturnRequests({ branchId, status: "PENDING_APPROVAL" });
    const [customers, branches] = await Promise.all([customerNames(db, ids(rows.map((r) => r.customerId))), branchNames(db, ids(rows.map((r) => r.branchId)))]);
    return rows
      .filter((r) => !sodHidden({ blocked: [r.createdBy], actor, trigger: "MONEY_OUT" }))
      .map((r) =>
        buildRow(
          {
            kind: "sales.returnRequest.approve",
            id: Number(r.id),
            title: `طلب مرتجع بيع · فاتورة ${r.invoiceNumber ?? `#${r.invoiceId}`}`,
            party: r.customerId != null ? (customers.get(Number(r.customerId)) ?? null) : null,
            amount: r.invoiceTotal,
            branchId: Number(r.branchId),
            branchName: branches.get(Number(r.branchId)) ?? null,
            requestedBy: Number(r.createdBy),
            requestedByName: r.createdByName ?? null,
            requestedAt: r.createdAt,
            summaryItems: linesOf(r.linesJson).map((l) => ({ label: l.productName ?? l.name ?? "بند", qty: l.quantity ?? null, unitPrice: l.unitPrice ?? l.total ?? null })),
            reason: r.reason,
            hrefId: Number(r.invoiceId),
            allowedActions: ["REJECT"],
            approveBlockedReason: "اعتماد المرتجع يحتاج اختيار رافد الرد (نقد/بطاقة/ذمة) والدرج والمرجع — يقع من شاشة الفاتورة",
            trigger: "MONEY_OUT",
          },
          scope.now,
        ),
      );
  },
  freshness: (id) =>
    freshnessFrom(
      async () => (await requireDb().select({ status: returnRequests.status }).from(returnRequests).where(eq(returnRequests.id, id)).limit(1))[0]?.status,
      ["PENDING_APPROVAL"],
    ),
  async decide(input, actor) {
    if (input.action !== "REJECT") {
      throw Object.assign(new Error("اعتماد المرتجع يقع من شاشة الفاتورة (يلزم اختيار رافد الرد)"), { code: "BAD_REQUEST" });
    }
    await rejectReturnRequest(input.id, input.reason ?? "", serviceActor(actor));
    return decided(input, "REJECTED", defaultMessage("REJECTED", `طلب المرتجع رقم ${input.id}`));
  },
};

// ───────────────────────────── ٣) ضبط أمر الشغل ─────────────────────────────

/**
 * [`workOrderRouter.ts:534`](../../../routers/workOrderRouter.ts) ⇐ `approveWorkOrderControlRequest`.
 * فصلُ المهام في الخدمة: الطالبُ لا يعتمد؛ وعلى الإلغاء/الخامات/عكس التسليم لا يعتمد منشئُ
 * الأمر ولا المُسنَد إليه. رافدُ الردّ (إن لزم) قرارُ المعتمِد لحظةَ الاعتماد — يُترك للخدمة
 * اشتقاقُه، فإن رفضت لغيابه أعادت رسالتها كما هي (لا «نجاح» كاذب).
 */
export const workOrderControlSource: DecisionSource = {
  key: "workOrder.control",
  kinds: ["workOrder.control.approve", "workOrder.control.reject"],
  gate: WORKORDERS_GATE,
  async list(actor, scope) {
    const db = requireDb();
    const raw = await listPendingWorkOrderControls(serviceActor(actor));
    const rows = raw.filter((r) => (scope.branchIds ? scope.branchIds.includes(Number(r.branchId)) : true));
    if (!rows.length) return [];
    const woRows = await db
      .select({ id: workOrders.id, customerId: workOrders.customerId, contactName: workOrders.contactName, salePrice: workOrders.salePrice, deposit: workOrders.deposit })
      .from(workOrders)
      .where(inArray(workOrders.id, ids(rows.map((r) => r.workOrderId))));
    const woById = new Map(woRows.map((w) => [Number(w.id), w]));
    const [customers, branches] = await Promise.all([customerNames(db, ids(woRows.map((w) => w.customerId))), branchNames(db, ids(rows.map((r) => r.branchId)))]);
    return rows
      .filter((r) => {
        const guardsDocument = r.requestType === "CANCEL" || r.requestType === "MATERIAL_ADJUST" || r.requestType === "REVERSE_DELIVERY";
        return !sodHidden({ blocked: [r.requestedBy, ...(guardsDocument ? [r.createdBy, r.assignedTo] : [])], actor, trigger: "ERASE_EFFECT" });
      })
      .map((r) => {
        const wo = woById.get(Number(r.workOrderId));
        const label = decisionSubkindLabel(r.requestType) ?? r.requestType;
        return buildRow(
          {
            kind: "workOrder.control.approve",
            id: Number(r.id),
            title: `${label} · امر شغل ${r.orderNumber}${r.title ? ` · ${r.title}` : ""}`,
            subkind: label,
            party: (wo?.customerId != null ? customers.get(Number(wo.customerId)) : null) ?? wo?.contactName ?? null,
            amount: r.requestType === "CANCEL" ? (wo?.deposit ?? null) : (wo?.salePrice ?? null),
            branchId: Number(r.branchId),
            branchName: branches.get(Number(r.branchId)) ?? null,
            requestedBy: Number(r.requestedBy),
            requestedByName: r.requestedByName ?? null,
            requestedAt: r.createdAt,
            summaryItems: [
              ...(wo?.salePrice ? [{ label: "سعر البيع", unitPrice: wo.salePrice }] : []),
              ...(wo?.deposit && Number(wo.deposit) > 0 ? [{ label: "العربون المقبوض", unitPrice: wo.deposit }] : []),
            ],
            reason: r.reason,
            hrefId: Number(r.workOrderId),
            expectedVersion: Number(r.baseVersion),
            trigger: r.requestType === "COMMERCIAL_EDIT" ? null : "ERASE_EFFECT",
          },
          scope.now,
        );
      });
  },
  freshness: (id) =>
    freshnessFrom(
      async () => (await requireDb().select({ status: workOrderControlRequests.status }).from(workOrderControlRequests).where(eq(workOrderControlRequests.id, id)).limit(1))[0]?.status,
      ["PENDING"],
    ),
  async decide(input, actor) {
    const subject = `طلب ضبط امر الشغل رقم ${input.id}`;
    if (input.action === "REJECT") {
      await rejectWorkOrderControlRequest(input.id, serviceActor(actor), input.reason ?? "");
      return decided(input, "REJECTED", defaultMessage("REJECTED", subject));
    }
    const res = await approveWorkOrderControlRequest(input.id, serviceActor(actor), input.reason ?? null, { refundRail: null, refundShiftId: null, refundReference: null });
    if (res && typeof res === "object" && "stale" in res) return decided(input, "STALE", defaultMessage("STALE", subject));
    const outcome = outcomeFor("APPROVE", statusOf(res));
    return decided(input, outcome, defaultMessage(outcome, subject));
  },
};

// ───────────────────────────── ٤) ردّ عربون إلغاء أمر الشغل ─────────────────────────────

/**
 * [`workOrderRouter.ts:1841`](../../../routers/workOrderRouter.ts) ⇐ `approveWorkOrderCancellationRefund`
 * (ownerProcedure). الاعتمادُ يلزمه **مرجعُ تنفيذ الاسترداد الخارجيّ** (3–100 محرفاً) — دليلٌ
 * على أنّ المال خرج من الحساب لا من الشاشة. لا رفضَ في مكانه: مسارُ الإلغاء يُدار من الأمر.
 */
export const workOrderCancellationRefundSource: DecisionSource = {
  key: "workOrder.cancellationRefund",
  kinds: ["workOrder.cancellationRefund.approve"],
  gate: { type: "OWNER" },
  async list(actor, scope) {
    const rows = await listPendingWorkOrderCancellationRefunds(serviceActor(actor));
    const db = requireDb();
    const woRows = rows.length
      ? await db.select({ id: workOrders.id, branchId: workOrders.branchId }).from(workOrders).where(inArray(workOrders.id, ids(rows.map((r) => r.workOrderId))))
      : [];
    const branchByWo = new Map(woRows.map((w) => [Number(w.id), Number(w.branchId)]));
    const branches = await branchNames(db, ids(woRows.map((w) => w.branchId)));
    return rows
      .filter((r) => {
        const b = branchByWo.get(Number(r.workOrderId));
        return scope.branchIds ? b != null && scope.branchIds.includes(b) : true;
      })
      .map((r) => {
        const branchId = branchByWo.get(Number(r.workOrderId)) ?? null;
        return buildRow(
          {
            kind: "workOrder.cancellationRefund.approve",
            id: Number(r.receiptId),
            title: `رد عربون الغاء امر شغل ${r.orderNumber} · ${r.paymentMethod}`,
            subkind: r.paymentMethod,
            party: r.customerName,
            amount: r.amount,
            branchId,
            branchName: branchId == null ? null : (branches.get(branchId) ?? null),
            requestedBy: r.createdBy == null ? null : Number(r.createdBy),
            requestedByName: r.creatorName ?? null,
            requestedAt: r.createdAt,
            summaryItems: [{ label: r.description ?? "رد عربون", unitPrice: r.amount }],
            reason: r.description,
            hrefId: Number(r.receiptId),
            allowedActions: ["APPROVE"],
            rejectReason: "NOT_SUPPORTED",
            requiredReference: { key: "confirmationReference", label: "مرجع تنفيذ الاسترداد الخارجي (جهاز الدفع/البنك)", minLength: 3 },
            trigger: "MONEY_OUT",
          },
          scope.now,
        );
      });
  },
  async freshness(id) {
    const [row] = await requireDb().select({ status: receipts.status, approvalStatus: receipts.approvalStatus }).from(receipts).where(and(eq(receipts.id, id), eq(receipts.direction, "OUT"))).limit(1);
    if (!row) return "GONE";
    return row.status === "PENDING" && row.approvalStatus === "PENDING_APPROVAL" ? "PENDING" : "DECIDED";
  },
  async decide(input, actor, options) {
    const audit = options.audit as Parameters<typeof approveWorkOrderCancellationRefund>[3] | undefined;
    if (!audit) throw new Error("audit context required for cancellation refund approval");
    await approveWorkOrderCancellationRefund(input.id, serviceActor(actor), input.reference ?? "", audit);
    return decided(input, "EXECUTED", `رد العربون (ايصال ${input.id}): اعتُمد بمرجع التنفيذ الخارجي وسُجّل صرفه.`);
  },
};

export const SALES_SOURCES: readonly DecisionSource[] = [salesControlSource, returnRequestSource, workOrderControlSource, workOrderCancellationRefundSource];
