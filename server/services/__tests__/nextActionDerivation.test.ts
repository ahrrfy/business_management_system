import { describe, expect, it } from "vitest";
import {
  deriveInvoiceNextAction,
  deriveWorkOrderNextActionFromRow,
  derivePurchaseOrderNextActionFromRow,
  __testing,
} from "../nextActionDerivation";
import { nextActionTerminalReason } from "@shared/nextAction";

/**
 * الاختبارُ يفحص **جسر الأعمدة إلى العقد**، لا العقدَ نفسه (يفحصه اختبارُ العقد المشترك).
 * كلُّ حالةٍ هنا تُثبت انتقالاً عابراً لمنطقة كانت تسقط فيها الشاشاتُ إلى تخمينٍ محلّيّ.
 */

const NOW = new Date("2026-09-03T09:00:00.000Z"); // Constant test clock — no midnight rollover.

describe("nextActionDerivation — SALE_INVOICE", () => {
  it("PENDING بلا استحقاق ⇒ خطوةُ الكاشير بلا سقف", () => {
    const na = deriveInvoiceNextAction(
      {
        invoiceId: 42,
        status: "PENDING",
        hasLiveConsignment: false,
        deliveryPartyLabel: null,
        replacementInvoiceId: null,
        dueDate: null,
      },
      NOW,
    );
    expect(na).not.toBeNull();
    expect(na?.owner).toEqual({ kind: "ROLE", role: "cashier" });
    expect(na?.href).toBe("/invoices/42");
    expect(na?.slaHours).toBeUndefined();
  });

  it("PENDING مع استحقاقٍ متأخّرٍ ⇒ سقفٌ صفريّ (فوراً)", () => {
    const na = deriveInvoiceNextAction(
      {
        invoiceId: 7,
        status: "PENDING",
        hasLiveConsignment: false,
        deliveryPartyLabel: null,
        replacementInvoiceId: null,
        dueDate: new Date("2026-08-30T09:00:00.000Z"), // Overdue by 4 days.
      },
      NOW,
    );
    expect(na?.slaHours).toBe(0);
  });

  it("PARTIALLY_PAID مع طردٍ حيّ ⇒ صاحبُ الخطوة جهة التوصيل (COUNTERPARTY)", () => {
    const na = deriveInvoiceNextAction(
      {
        invoiceId: 88,
        status: "PARTIALLY_PAID",
        hasLiveConsignment: true,
        deliveryPartyLabel: "  فارس السرعة  ",
        replacementInvoiceId: null,
        dueDate: null,
      },
      NOW,
    );
    expect(na?.owner).toEqual({ kind: "COUNTERPARTY", label: "فارس السرعة" });
    expect(na?.href).toBe("/delivery");
  });

  it("SUPERSEDED مع بديلٍ ⇒ الرابط يقود إلى الفاتورة البديلة بلا حجب", () => {
    const na = deriveInvoiceNextAction(
      {
        invoiceId: 101,
        status: "SUPERSEDED",
        hasLiveConsignment: false,
        deliveryPartyLabel: null,
        replacementInvoiceId: 202,
        dueDate: null,
      },
      NOW,
    );
    expect(na?.href).toBe("/invoices/202");
    expect(na?.blockedBy).toBeUndefined();
  });

  it("PAID بلا طردٍ حيّ ⇒ نهائيّة، والسببُ مُعلَنٌ لا فراغ", () => {
    const na = deriveInvoiceNextAction(
      {
        invoiceId: 5,
        status: "PAID",
        hasLiveConsignment: false,
        deliveryPartyLabel: null,
        replacementInvoiceId: null,
        dueDate: null,
      },
      NOW,
    );
    expect(na).toBeNull();
    // القرين: كلّ `null` يلزمه سببٌ نصّيّ في القاموس المشترك.
    expect(nextActionTerminalReason("SALE_INVOICE", "PAID")).not.toBeNull();
  });
});

describe("nextActionDerivation — WORK_ORDER", () => {
  it("RECEIVED مع فنّيٍّ مُسنَد ⇒ صاحبُ الخطوة USER بشخصه (لا الدور)", () => {
    const na = deriveWorkOrderNextActionFromRow({
      workOrderId: 71,
      status: "RECEIVED",
      assignedToUserId: 13,
      hasDelivery: false,
      consignmentId: null,
      courierDeliveredAt: null,
      kanbanState: "NORMAL",
      blockedReason: null,
      blockingTaskLabel: null,
    });
    expect(na?.owner).toEqual({ kind: "USER", userId: 13 });
    expect(na?.href).toBe("/work-orders/71");
  });

  it("IN_PROGRESS مع BLOCKED ⇒ سببُ التعطّل يظهر في blockedBy", () => {
    const na = deriveWorkOrderNextActionFromRow({
      workOrderId: 71,
      status: "IN_PROGRESS",
      assignedToUserId: null,
      hasDelivery: false,
      consignmentId: null,
      courierDeliveredAt: null,
      kanbanState: "BLOCKED",
      blockedReason: "بانتظار الفنّيّ الآخر",
      blockingTaskLabel: null,
    });
    expect(na?.blockedBy?.[0]).toBe("بانتظار الفنّيّ الآخر");
  });

  it("READY مع إسنادٍ لمندوب ⇒ صاحبُ الخطوة جهةُ التوصيل، لا الكاشير", () => {
    const na = deriveWorkOrderNextActionFromRow({
      workOrderId: 71,
      status: "READY",
      assignedToUserId: 13,
      hasDelivery: true,
      consignmentId: 501,
      courierDeliveredAt: null,
      kanbanState: "READY",
      blockedReason: null,
      blockingTaskLabel: null,
    });
    expect(na?.owner.kind).toBe("COUNTERPARTY");
    expect(na?.href).toBe("/delivery");
  });

  it("CANCELLED ⇒ نهائيّة بسببٍ مُعلَن", () => {
    const na = deriveWorkOrderNextActionFromRow({
      workOrderId: 71,
      status: "CANCELLED",
      assignedToUserId: null,
      hasDelivery: false,
      consignmentId: null,
      courierDeliveredAt: null,
      kanbanState: null,
      blockedReason: null,
      blockingTaskLabel: null,
    });
    expect(na).toBeNull();
    expect(nextActionTerminalReason("WORK_ORDER", "CANCELLED")).not.toBeNull();
  });
});

describe("nextActionDerivation — PURCHASE_ORDER", () => {
  it("DRAFT بلا مراجعةٍ ثابتة ⇒ blockedBy يقول ذلك", () => {
    const na = derivePurchaseOrderNextActionFromRow(
      {
        purchaseOrderId: 900,
        status: "DRAFT",
        currentRevisionId: null,
        hasUnpaidBalance: false,
        approvalRequest: "NONE",
        requireRequisition: false,
        expectedDeliveryDate: null,
      },
      NOW,
    );
    expect(na).not.toBeNull();
    expect(na?.blockedBy?.some((b) => b.includes("مراجعة ثابتة"))).toBe(true);
  });

  it("SENT مع طلب اعتمادٍ PENDING ⇒ صاحبُ الخطوة manager", () => {
    const na = derivePurchaseOrderNextActionFromRow(
      {
        purchaseOrderId: 900,
        status: "SENT",
        currentRevisionId: 12,
        hasUnpaidBalance: false,
        approvalRequest: "PENDING",
        requireRequisition: true,
        expectedDeliveryDate: null,
      },
      NOW,
    );
    expect(na?.owner).toEqual({ kind: "ROLE", role: "manager" });
  });

  it("RECEIVED مع سدادٍ متبقٍّ ⇒ توجيهٌ إلى شاشة سدادات المورّد، لا purchases.pay المُغلَق", () => {
    const na = derivePurchaseOrderNextActionFromRow(
      {
        purchaseOrderId: 900,
        status: "RECEIVED",
        currentRevisionId: 12,
        hasUnpaidBalance: true,
        approvalRequest: "NONE",
        requireRequisition: false,
        expectedDeliveryDate: null,
      },
      NOW,
    );
    expect(na?.href).toBe("/purchases/supplier-payments");
  });

  it("SENT مع طلب STALE ⇒ رسالةٌ صريحة أنّ الطلب السابق لاغٍ", () => {
    const na = derivePurchaseOrderNextActionFromRow(
      {
        purchaseOrderId: 900,
        status: "SENT",
        currentRevisionId: 12,
        hasUnpaidBalance: false,
        approvalRequest: "STALE",
        requireRequisition: false,
        expectedDeliveryDate: null,
      },
      NOW,
    );
    expect(na?.blockedBy?.some((b) => b.includes("لاغ"))).toBe(true);
  });

  it("CANCELLED ⇒ نهائيّة ولا سببَ صمّاء", () => {
    const na = derivePurchaseOrderNextActionFromRow(
      {
        purchaseOrderId: 900,
        status: "CANCELLED",
        currentRevisionId: 12,
        hasUnpaidBalance: false,
        approvalRequest: "NONE",
        requireRequisition: false,
        expectedDeliveryDate: null,
      },
      NOW,
    );
    expect(na).toBeNull();
    expect(nextActionTerminalReason("PURCHASE_ORDER", "CANCELLED")).not.toBeNull();
  });
});

describe("nextActionDerivation — hoursFromNowUntil", () => {
  it("`null` مسموحٌ ويعود null (لا 0 مخترَع)", () => {
    expect(__testing.hoursFromNowUntil(NOW, null)).toBeNull();
  });

  it("قيمةٌ مستقبليّةٌ بـ24س ⇒ 24، وسلبيّةٌ ⇒ سالبٌ (تجاوزَ الموعد)", () => {
    const future = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const past = new Date(NOW.getTime() - 3 * 60 * 60 * 1000);
    expect(__testing.hoursFromNowUntil(NOW, future)).toBe(24);
    expect(__testing.hoursFromNowUntil(NOW, past)).toBe(-3);
  });
});
