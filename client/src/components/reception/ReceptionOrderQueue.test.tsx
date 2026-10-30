import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canSeeGate } from "@/lib/navVisibility";
import type { OperationUser } from "@shared/operationPermissions";
import ReceptionOrderQueue from "./ReceptionOrderQueue";
import { WorkOrderDeliverySection } from "@/components/delivery/WorkOrderDeliverySection";

const state = vi.hoisted(() => ({
  user: null as OperationUser | null,
  rows: [] as Record<string, unknown>[],
}));
function mutation() {
  return { isPending: false, mutate: vi.fn(), mutateAsync: vi.fn() };
}
vi.mock("@/lib/trpc", () => ({
  trpc: {
    auth: { me: { useQuery: () => ({ data: state.user, isLoading: false }) } },
    useUtils: () => ({}),
    workOrders: {
      list: {
        useQuery: (input: { statuses: string[] }) => ({
          data: input.statuses.includes("DELIVERED") ? [] : state.rows,
          isLoading: false,
          isError: false,
          refetch: vi.fn(),
        }),
      },
      deliver: { useMutation: mutation },
      setDeliveryMethod: { useMutation: mutation },
      autoClearReady: { useMutation: mutation },
    },
    delivery: {
      listParties: {
        useQuery: (_: unknown, options: { enabled: boolean }) => ({
          data: options.enabled ? [{ id: 1, name: "مندوب" }] : undefined,
          isSuccess: options.enabled,
          isLoading: false,
          isError: false,
          refetch: vi.fn(),
        }),
      },
      dispatch: { useMutation: mutation },
    },
  },
}));
vi.mock("@/lib/realtime", () => ({ useRealtimeEvent: () => undefined }));
vi.mock("wouter", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href }, children),
}));
vi.mock("@/components/list", () => ({
  RowActions: ({
    actions,
  }: {
    actions: {
      key: string;
      label: string;
      hidden?: boolean;
      disabled?: boolean;
      gate?: Parameters<typeof canSeeGate>[0];
    }[];
  }) =>
    React.createElement(
      "div",
      {},
      actions
        .filter(
          (a) =>
            !a.hidden &&
            canSeeGate(
              a.gate,
              state.user?.role,
              null,
              state.user?.roleOperationPolicy,
            ),
        )
        .map((a) =>
          React.createElement(
            "button",
            { key: a.key, disabled: a.disabled, "data-action": a.key },
            a.label,
          ),
        ),
    ),
}));
vi.mock("@/components/reception/ReceptionCommandAlert", () => ({
  ReceptionCommandAlert: () => null,
}));
vi.mock("@/components/commission/LiveCelebrationOverlay", () => ({
  LiveCelebrationOverlay: () => null,
}));
vi.mock("@/components/delivery/DispatchDialog", () => ({
  DispatchDialog: () => null,
}));
vi.mock("@/components/delivery/DeliveryDepartureOverlay", () => ({
  DeliveryDepartureOverlay: () => null,
}));
vi.mock("@/components/delivery/MarkPickedUpDialog", () => ({
  MarkPickedUpDialog: () => null,
}));
vi.mock("@/components/workorder/ReclassifyDeliveryDialog", () => ({
  ReclassifyDeliveryDialog: () => null,
}));
vi.mock("@/components/reception/ManagerApprovalDialog", () => ({
  ManagerApprovalDialog: () => null,
}));
vi.mock("@/components/delivery/CollectConsignmentDialog", () => ({
  CollectConsignmentDialog: () => null,
}));
vi.mock("@/components/delivery/CancelDeliveryAssignmentDialog", () => ({
  CancelDeliveryAssignmentDialog: () => null,
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open?: boolean; children?: React.ReactNode }) =>
    open ? React.createElement("div", { "data-dialog": "open" }, children) : null,
  DialogContent: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", {}, children),
  DialogHeader: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", {}, children),
  DialogTitle: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", {}, children),
  DialogDescription: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", {}, children),
  DialogFooter: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", {}, children),
}));
vi.mock("@/lib/printing/deliveryDocs", () => ({
  printDeliverySlip: vi.fn(),
  printReadyOrderLabel: vi.fn(),
}));

(globalThis as typeof globalThis & { React: typeof React }).React = React;
const grants = (...paths: string[]): OperationUser => ({
  role: "sales_rep",
  operationPolicyEnabled: true,
  roleOperationPolicy: {
    version: 1,
    grants: Object.fromEntries(
      paths.map((path) => [`operation.${path}`, true]),
    ),
  },
});
const readyRow = {
  id: 21,
  orderNumber: "WO21",
  status: "READY",
  title: "طلب",
  salePrice: "5000",
  deposit: "0",
  hasDelivery: false,
  consignmentStatus: null,
  parcelStatus: null,
};
const queue = (initialShelfAuditMode = false) =>
  renderToStaticMarkup(
    <ReceptionOrderQueue branchId={4} initialShelfAuditMode={initialShelfAuditMode} />,
  );
const delivery = (parcelStatus = "ASSIGNED", role = "manager") =>
  renderToStaticMarkup(
    <WorkOrderDeliverySection
      data={{
        id: 21,
        orderNumber: "WO21",
        hasDelivery: true,
        consignmentId: 9,
        parcelStatus,
        salePrice: "5000",
        deposit: "0",
      }}
      role={role}
      onInvalidate={() => undefined}
    />,
  );

beforeEach(() => {
  state.rows = [readyRow];
  state.user = grants("workOrders.list");
});

describe("reception queue independent action grants", () => {
  it("delegates changing delivery method without granting direct handover", () => {
    state.user = grants("workOrders.list", "workOrders.setDeliveryMethod");
    const html = queue();
    expect(html).toContain('data-action="reclassify"');
    expect(html).not.toContain('data-action="pickup"');
  });
  it("delegates direct handover without granting reclassification", () => {
    state.user = grants("workOrders.list", "workOrders.deliver");
    const html = queue();
    expect(html).toContain('data-action="pickup"');
    expect(html).not.toContain('data-action="reclassify"');
  });
  it("delegates courier dispatch without requiring the direct-handover grant", () => {
    state.user = grants(
      "workOrders.list",
      "delivery.dispatch",
      "delivery.listParties",
    );
    state.rows = [{ ...readyRow, hasDelivery: true }];
    expect(queue()).toContain('data-action="dispatch"');
  });
  it("keeps dispatch visible but disabled without permission to load the party selector", () => {
    state.user = grants("workOrders.list", "delivery.dispatch");
    state.rows = [{ ...readyRow, hasDelivery: true }];
    expect(queue()).toContain('disabled="" data-action="dispatch"');
  });
  it("does not let legacy module FULL bypass a canonical action denial", () => {
    state.user = {
      ...grants("workOrders.list"),
      role: "manager",
      permissionsOverride: { workorders: "FULL", store: "FULL" },
    };
    const html = queue();
    expect(html).not.toContain('data-action="pickup"');
    expect(html).not.toContain('data-action="reclassify"');
    expect(html).not.toContain('data-action="dispatch"');
  });
  it("preserves readiness and existing-consignment restrictions with full action grants", () => {
    state.user = grants(
      "workOrders.list",
      "workOrders.deliver",
      "workOrders.setDeliveryMethod",
      "delivery.dispatch",
      "delivery.listParties",
    );
    state.rows = [
      { ...readyRow, status: "IN_PROGRESS", hasDelivery: true },
      {
        ...readyRow,
        id: 22,
        hasDelivery: true,
        consignmentStatus: "DISPATCHED",
        parcelStatus: "ASSIGNED",
      },
    ];
    const html = queue();
    expect(html).not.toContain('data-action="pickup"');
    expect(html).not.toContain('data-action="dispatch"');
  });
});

describe("shelf audit mode governance", () => {
  const paidPickupRow = {
    ...readyRow,
    id: 31,
    orderNumber: "WO31",
    title: "مطبوع مدفوع",
    salePrice: "5000",
    deposit: "5000",
    hasDelivery: false,
  };

  it("hides shelf audit toggle and controls from cashier even with eligible paid ready orders", () => {
    state.user = { role: "cashier" };
    state.rows = [paidPickupRow];
    const html = queue(true);
    expect(html).not.toMatch(/جرد الرفّ/);
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toMatch(/توزيع إجباري عادل/);
  });

  it("shows shelf audit toggle for manager without any select-all button and renders per-order checkboxes only for eligible rows", () => {
    state.user = { role: "manager" };
    state.rows = [
      paidPickupRow,
      { ...readyRow, id: 32, orderNumber: "WO32", deposit: "1000", salePrice: "5000" },
      { ...readyRow, id: 33, orderNumber: "WO33", deposit: "5000", salePrice: "5000", hasDelivery: true },
    ];
    const closedHtml = queue(false);
    expect(closedHtml).toContain("جرد الرفّ");
    expect(closedHtml).not.toMatch(/تحديد الكل/);
    expect(closedHtml).not.toMatch(/توزيع إجباري عادل/);

    const activeHtml = queue(true);
    expect(activeHtml).toContain("تحديد فردي يدوي بعد مراجعة الرفّ — لا يوجد تحديد للكل");
    expect(activeHtml).toContain("تصفية المحدّد كجرد رفّ");
    expect(activeHtml).not.toMatch(/تحديد الكل/);
    expect(activeHtml).toContain("WO31");
    const checkboxMatches = activeHtml.match(/type="checkbox"/g) ?? [];
    expect(checkboxMatches).toHaveLength(1);
  });

  it("treats returned/cancelled-dispatch orders settled on their linked invoice as eligible for shelf audit", () => {
    state.user = { role: "manager" };
    state.rows = [
      {
        ...readyRow,
        id: 34,
        orderNumber: "WO34",
        title: "طلب مسدد عبر الفاتورة المرتبطة",
        salePrice: "5000",
        deposit: "0",
        effectiveSalePrice: "5000.00",
        effectiveDeposit: "5000.00",
        hasDelivery: false,
        consignmentStatus: "RETURNED",
        parcelStatus: "RETURNED",
      },
      {
        ...readyRow,
        id: 35,
        orderNumber: "WO35",
        title: "طلب متبقٍ على الفاتورة المرتبطة",
        salePrice: "5000",
        deposit: "5000",
        effectiveSalePrice: "5000.00",
        effectiveDeposit: "2000.00",
        hasDelivery: false,
      },
    ];

    const closedHtml = queue(false);
    expect(closedHtml).toContain("جرد الرفّ (1)");

    const activeHtml = queue(true);
    expect(activeHtml).toContain("WO34");
    const checkboxMatches = activeHtml.match(/type="checkbox"/g) ?? [];
    expect(checkboxMatches).toHaveLength(1);
    expect(activeHtml).toContain('aria-label="تحديد الطلب WO34 (طلب مسدد عبر الفاتورة المرتبطة) ضمن جرد الرفّ"');
  });
});

describe("work-order delivery section", () => {
  it("shows independently delegated cancellation and transit access for another baseline role", () => {
    state.user = grants("delivery.cancelAssignment", "delivery.inTransit");
    const html = delivery("ASSIGNED", "sales_rep");
    expect(html).toContain("إلغاء إسناد المندوب");
    expect(html).toContain("/delivery?tab=transit");
    expect(html).not.toContain("قبض وتحصيل التوصيل");
  });
  it("preserves the old legacy controls and the delivered-parcel cancellation restriction", () => {
    state.user = { role: "cashier" };
    const html = delivery("DELIVERED", "cashier");
    expect(html).not.toContain("إلغاء إسناد المندوب");
    expect(html).toContain("قبض وتحصيل التوصيل");
    expect(html).toContain("/delivery?tab=transit");
  });
  it("does not show transit access or mutations for a canonical policy with no grants", () => {
    state.user = { ...grants(), role: "manager" };
    const html = delivery();
    expect(html).not.toContain("إلغاء إسناد المندوب");
    expect(html).not.toContain("قبض وتحصيل التوصيل");
    expect(html).not.toContain("/delivery?tab=transit");
  });
});
