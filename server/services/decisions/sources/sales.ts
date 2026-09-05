/**
 * مصادرُ المبيعات وأوامر الشغل: ضبطُ البيع، طلباتُ المرتجع، ضبطُ أمر الشغل، ردُّ عربون الإلغاء.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { decisionSpec, decisionSubkindLabel, type DecisionSummaryItem } from "@shared/decisionRegistry";
import { appErrorMessage } from "@shared/errors";
import { SALES_CONTROL_TYPE_LABELS, type SalesControlType } from "@shared/salesControl";
import { salesControlFacts, type SalesControlFactsType } from "@shared/salesControlFacts";
import {
  invoiceItems,
  invoices,
  receipts,
  returnRequests,
  salesControlRequests,
  shifts,
  workOrderControlRequests,
  workOrders,
} from "../../../../drizzle/schema";
import { MATERIALIZED_RECEIPT_STATUSES } from "../../cash/cashAvailability";
import { money } from "../../money";
import { listReturnRequests, rejectReturnRequest } from "../../returns/requests";
import { recordGovernedReturnExecution } from "../../sale/controlAudit";
import { approveSalesControlRequest, listSalesControlRequests, rejectSalesControlRequest } from "../../sale/controlRequests";
import { requireDb } from "../../tx";
import { approveWorkOrderCancellationRefund, listPendingWorkOrderCancellationRefunds } from "../../workOrder/cancel";
import { approveWorkOrderControlRequest, listPendingWorkOrderControls, rejectWorkOrderControlRequest } from "../../workOrder/controlRequests";
import { serviceActor } from "../gate";
import { buildRow, decided, defaultMessage, itemLabel, outcomeFor, statusOf } from "../rows";
import type { DecisionSource } from "../types";
import { branchNames, customerNames, freshnessFrom, ids, scopeBranch, sodHidden, variantLabels, type Db } from "./common";
import { salesControlAffectedAmount, salesControlInlineBlock, salesControlShiftIds, type SalesControlItemView } from "./salesControlView";

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

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});

// ───────────────────────────── ١) ضبط البيع ─────────────────────────────

/** حالاتُ الأدراج التي تحملها حمولاتُ المرتجعات — ليُعرَف أيُّها أُقفل بعد الطلب. */
async function shiftStatuses(db: Db, payloads: unknown[]): Promise<Map<number, string | null>> {
  const shiftIds = ids(payloads.flatMap((p) => salesControlShiftIds(p)));
  if (!shiftIds.length) return new Map();
  const rows = await db.select({ id: shifts.id, status: shifts.status }).from(shifts).where(inArray(shifts.id, shiftIds));
  return new Map(rows.map((s) => [Number(s.id), s.status ?? null]));
}

/**
 * المقبوضُ القابل للردّ لكلّ فاتورة = إيصالاتُ القبض المُتحقّقة − ما رُدّ منها — الأساسُ نفسه الذي
 * يحسب به `cancelSaleInTx` مبلغَ الاسترداد (لا `paidAmount` وحده: سندُ قبضٍ مربوطٌ بفاتورة يُنقص
 * ذمّة العميل ولا يرفع `paidAmount`).
 */
async function refundableByInvoice(db: Db, invoiceIds: number[]): Promise<Map<number, string>> {
  if (!invoiceIds.length) return new Map();
  const rows = await db
    .select({ invoiceId: receipts.invoiceId, direction: receipts.direction, amount: receipts.amount })
    .from(receipts)
    .where(and(inArray(receipts.invoiceId, invoiceIds), inArray(receipts.status, [...MATERIALIZED_RECEIPT_STATUSES]), eq(receipts.approvalStatus, "APPROVED")));
  const sums = new Map<number, ReturnType<typeof money>>();
  for (const r of rows) {
    const key = Number(r.invoiceId);
    const current = sums.get(key) ?? money(0);
    sums.set(key, r.direction === "IN" ? current.plus(money(r.amount)) : current.minus(money(r.amount)));
  }
  return new Map(Array.from(sums, ([k, v]) => [k, v.toFixed(2)]));
}

/**
 * إنفاذُ حاجز الاعتماد السطريّ **خادمياً** — إخفاءُ الزرّ في الشاشة لا يكفي (الطلبُ قد يصل من
 * أيّ عميل). التنفيذُ بلا `cashRouting` فاشلٌ حتماً لهذه الحالات، فيُرفَض قبل أن يبلغ الخدمة.
 */
async function assertInlineApprovable(requestId: number, subject: string): Promise<void> {
  const db = requireDb();
  const [req] = await db
    .select({ requestType: salesControlRequests.requestType, payload: salesControlRequests.payload })
    .from(salesControlRequests)
    .where(eq(salesControlRequests.id, requestId))
    .limit(1);
  if (!req) return; // الخدمةُ ترفع NOT_FOUND بنفسها.
  const block = salesControlInlineBlock(req.requestType, req.payload, await shiftStatuses(db, [req.payload]));
  if (!block) return;
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: appErrorMessage({
      what: `تعذّر اعتماد ${subject} من الصندوق`,
      why: block,
      doThis: `افتح شاشة طلبات ضبط البيع (${decisionSpec("sales.control.approve")?.href(requestId) ?? "/invoices?tab=controls"}) واعتمده منها بتوجيه النقد`,
    }),
  });
}

/**
 * [`salesControlRouter.ts:124`](../../../routers/salesControlRouter.ts) ⇐ `approveSalesControlRequest`.
 * فصلُ المهام في الخدمة **بلا استثناء للأدمن**: الطالبُ ومنشئُ الفاتورة لا يراجعان.
 *
 *  · **المبلغُ = ما يمسّه القرار** لا إجماليَّ الفاتورة (`salesControlAffectedAmount`).
 *  · **الاعتمادُ السطريّ يُحجَب** حين يلزم توجيهُ نقدٍ لحظةَ الاعتماد (`salesControlInlineBlock`)
 *    — الصفُّ يحمل السبب ورابطَ الشاشة الكاملة، والحسمُ يُنفِذه خادمياً أيضاً.
 *  · اعتمادُ مرتجعٍ يكتب `RETURN_EXECUTED_AUDIT_ACTION` عبر المسار المشترك مع الراوتر.
 */
export const salesControlSource: DecisionSource = {
  key: "sales.control",
  kinds: ["sales.control.approve", "sales.control.reject"],
  gate: SALES_GATE,
  supportedActions: ["APPROVE", "REJECT"],
  async list(actor, scope) {
    const db = requireDb();
    const raw = await listSalesControlRequests(serviceActor(actor), { status: "PENDING", order: "ASC" });
    const rows = raw.filter((r) => (scope.branchIds ? scope.branchIds.includes(Number(r.branchId)) : true));
    if (!rows.length) return [];
    const invoiceIds = ids(rows.map((r) => r.invoiceId));
    const [invoiceRows, itemRows, refundable, shiftStatus] = await Promise.all([
      db
        .select({ id: invoices.id, customerId: invoices.customerId, contactName: invoices.contactName, total: invoices.total, paidAmount: invoices.paidAmount, returnedTotal: invoices.returnedTotal })
        .from(invoices)
        .where(inArray(invoices.id, invoiceIds)),
      db
        .select({ id: invoiceItems.id, invoiceId: invoiceItems.invoiceId, variantId: invoiceItems.variantId, total: invoiceItems.total, baseQuantity: invoiceItems.baseQuantity, unitPrice: invoiceItems.unitPrice })
        .from(invoiceItems)
        .where(inArray(invoiceItems.invoiceId, invoiceIds)),
      refundableByInvoice(db, invoiceIds),
      shiftStatuses(db, rows.map((r) => r.payload)),
    ]);
    const invoiceById = new Map(invoiceRows.map((i) => [Number(i.id), i]));
    const itemsByInvoice = new Map<number, typeof itemRows>();
    for (const it of itemRows) {
      const key = Number(it.invoiceId);
      itemsByInvoice.set(key, [...(itemsByInvoice.get(key) ?? []), it]);
    }
    const itemById = new Map(itemRows.map((i) => [Number(i.id), i]));
    const reissueVariantIds = rows.flatMap((r) => (r.requestType === "SALES_REISSUE" || r.requestType === "SALES_EXCHANGE" ? linesOf(r.payload).map((l) => Number(asRecord(l).variantId)) : []));
    const [customers, branches, variants] = await Promise.all([
      customerNames(db, ids(invoiceRows.map((i) => i.customerId))),
      branchNames(db, ids(rows.map((r) => r.branchId))),
      variantLabels(db, ids([...itemRows.map((i) => i.variantId), ...reissueVariantIds])),
    ]);
    return rows
      .filter((r) => !sodHidden({ blocked: [r.requestedBy, r.invoiceCreatedBy], actor, trigger: "ERASE_EFFECT" }))
      .map((r) => {
        const invoiceId = Number(r.invoiceId);
        const inv = invoiceById.get(invoiceId);
        const type = r.requestType as SalesControlType;
        const label = SALES_CONTROL_TYPE_LABELS[type] ?? r.requestType;
        const items: SalesControlItemView[] = (itemsByInvoice.get(invoiceId) ?? []).map((i) => ({ id: Number(i.id), total: i.total, baseQuantity: Number(i.baseQuantity) }));
        const affected = salesControlAffectedAmount({ requestType: r.requestType, payload: r.payload, invoice: inv, items, refundable: refundable.get(invoiceId) ?? "0" });
        // أسطرُ الأصناف: للمرتجع بندُ الفاتورة (بالوحدة الأساس)، ولإعادة الإصدار/الاستبدال أسطرُ الفاتورة البديلة.
        const productLines: DecisionSummaryItem[] =
          type === "SALES_RETURN"
            ? linesOf(r.payload).map((l) => {
                const line = asRecord(l);
                const item = itemById.get(Number(line.invoiceItemId));
                const v = item ? variants.get(Number(item.variantId)) : undefined;
                return { label: itemLabel([v?.productName, v?.variantName]) || `بند #${String(line.invoiceItemId ?? "?")}`, qty: line.baseQuantity == null ? null : Number(line.baseQuantity), unit: "بالوحدة الأساس", unitPrice: item?.unitPrice ?? null };
              })
            : type === "SALES_REISSUE" || type === "SALES_EXCHANGE"
              ? linesOf(r.payload).map((l) => {
                  const line = asRecord(l);
                  const v = variants.get(Number(line.variantId));
                  return { label: itemLabel([v?.productName, v?.variantName]) || `صنف #${String(line.variantId ?? "?")}`, qty: line.quantity == null ? null : String(line.quantity), unitPrice: line.unitPriceOverride == null ? null : String(line.unitPriceOverride) };
                })
              : [];
        const facts = salesControlFacts(type as SalesControlFactsType, r.payload).map((f) => ({ label: `${f.label}: ${f.value}` }));
        const block = salesControlInlineBlock(r.requestType, r.payload, shiftStatus);
        return buildRow(
          {
            kind: "sales.control.approve",
            id: Number(r.id),
            title: `${label} · فاتورة ${r.invoiceNumber ?? `#${r.invoiceId}`}`,
            subkind: label,
            party: (inv?.customerId != null ? customers.get(Number(inv.customerId)) : null) ?? inv?.contactName ?? null,
            amount: affected.amount,
            branchId: Number(r.branchId),
            branchName: branches.get(Number(r.branchId)) ?? null,
            requestedBy: Number(r.requestedBy),
            requestedByName: r.requestedByName ?? null,
            requestedAt: r.createdAt,
            summaryItems: [
              ...productLines,
              { label: affected.label, unitPrice: affected.amount },
              { label: "اجمالي الفاتورة (للسياق)", unitPrice: inv?.total ?? r.invoiceTotal ?? null },
              ...facts,
            ],
            reason: r.reason,
            hrefId: Number(r.invoiceId),
            approveBlockedReason: block,
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
  async decide(input, actor, options) {
    const subject = `طلب ضبط البيع رقم ${input.id}`;
    if (input.action === "REJECT") {
      await rejectSalesControlRequest(input.id, input.reason ?? "", serviceActor(actor));
      return decided(input, "REJECTED", defaultMessage("REJECTED", subject));
    }
    await assertInlineApprovable(input.id, subject);
    const res = await approveSalesControlRequest(input.id, serviceActor(actor), input.reason ?? null, null);
    // حدثُ تنفيذ المرتجع الذي يقرؤه رقيبُ الشذوذ — المسارُ نفسه الذي يكتبه الراوتر الأصليّ.
    await recordGovernedReturnExecution(options.audit ?? { userId: actor.userId, branchId: actor.branchId }, { requestId: input.id, result: res, cashRouting: null });
    const outcome = outcomeFor("APPROVE", statusOf(res));
    return decided(input, outcome, defaultMessage(outcome, subject));
  },
};

// ───────────────────────────── ٢) طلبات المرتجع ─────────────────────────────

/**
 * [`returnRouter.ts:258`](../../../routers/returnRouter.ts). الاعتمادُ يحتاج قرارَ **رافد الردّ**
 * (نقد/بطاقة/ذمّة) والدرج والمرجع من المعتمِد لحظةَ الاعتماد — مدخلٌ لا يحمله الصفّ، فيُفتح
 * من شاشته؛ والرفضُ بسببه يقع هنا. الأقدمُ أوّلاً قبل قصّ الخدمة (200).
 */
export const returnRequestSource: DecisionSource = {
  key: "sales.returnRequest",
  kinds: ["sales.returnRequest.approve", "sales.returnRequest.reject"],
  gate: SALES_GATE,
  supportedActions: ["REJECT"],
  async list(actor, scope) {
    const branchId = scopeBranch(actor, scope);
    if (branchId === "NONE") return [];
    const db = requireDb();
    const rows = await listReturnRequests({ branchId, status: "PENDING_APPROVAL", order: "ASC" });
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
      // يحرسه `supportedActions` قبل الوصول؛ يبقى دفاعاً ثانياً لا يعتمد بالخطأ.
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({ what: "تعذّر اعتماد طلب المرتجع من الصندوق", why: "اعتماد المرتجع يقع من شاشة الفاتورة (يلزم اختيار رافد الرد)", doThis: "افتح الفاتورة واعتمد المرتجع منها بعد اختيار الرافد والدرج والمرجع" }),
      });
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
  supportedActions: ["APPROVE", "REJECT"],
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
  supportedActions: ["APPROVE"],
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
