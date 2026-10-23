// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnlineOrderLifecycle } from "@shared/onlineOrderLifecycle";
import { OrderLifecycleStatus } from "./OrderLifecycleStatus";
import { OrderQuickViewDrawer } from "./OrderQuickViewDrawer";

const mocks = vi.hoisted(() => ({ detail: vi.fn(), timeline: vi.fn() }));
vi.mock("@/lib/trpc", () => ({
  trpc: { storeAdmin: { orders: { detail: { useQuery: mocks.detail } } } },
}));
vi.mock("@/components/reception/ReceptionDuplicateAlert", () => ({
  ReceptionDuplicateAlert: () => null,
}));
vi.mock("@/components/delivery/ConsignmentTimelineDrawer", () => ({
  ConsignmentTimelineDrawer: (props: { consignmentId: number }) => {
    mocks.timeline(props);
    return <div>خط زمن الإرسالية {props.consignmentId}</div>;
  },
}));
vi.mock("@/components/ui/sheet", () => {
  const Box = ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  );
  return { Sheet: Box, SheetContent: Box, SheetHeader: Box, SheetTitle: Box };
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as typeof globalThis & { React: typeof React }).React = React;

const delivered: OnlineOrderLifecycle = {
  label: "تم التسليم والتحصيل",
  collectionLabel: "تم التحصيل",
  remittanceLabel: "بانتظار التوريد",
  consignmentId: 71,
  consignmentNumber: "CN-71",
  deliveryPartyName: "شركة التوصيل",
  latestEvent: {
    label: "تأكيد التسليم",
    occurredAt: "2026-10-18T08:30:00Z",
    actorName: "الموظف المختص",
  },
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  mocks.timeline.mockClear();
  mocks.detail.mockReturnValue({
    isLoading: false,
    isError: false,
    data: {
      id: 9,
      branchId: 2,
      orderNumber: "ORD-9",
      status: "DELIVERED",
      lifecycle: delivered,
      items: [],
      subtotal: "10000",
      deliveryFee: "0",
      total: "10000",
    },
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("order lifecycle display", () => {
  it("uses factual delivery and collection labels while keeping pending remittance visible", () => {
    act(() =>
      root.render(
        <OrderLifecycleStatus
          status="SHIPPED"
          lifecycle={delivered}
          showLatestMovement
        />,
      ),
    );
    expect(host.textContent).toContain("تم التسليم والتحصيل");
    expect(host.textContent).toContain("بانتظار التوريد");
    expect(host.textContent).not.toContain("مع المندوب");
    expect(host.textContent).not.toContain("تم التوريد");
    expect(host.textContent).toContain("آخر حركة: تأكيد التسليم");
    expect(host.textContent).toContain("18/10/2026");
    expect(host.textContent).toContain("الموظف المختص");
  });

  it("updates the latest movement and remittance after a refreshed order arrives", () => {
    act(() =>
      root.render(
        <OrderLifecycleStatus
          status="DELIVERED"
          lifecycle={delivered}
          showLatestMovement
        />,
      ),
    );
    act(() =>
      root.render(
        <OrderLifecycleStatus
          status="DELIVERED"
          lifecycle={{
            ...delivered,
            remittanceLabel: "تم التوريد",
            latestEvent: {
              label: "توريد نقد التحصيل",
              occurredAt: new Date("2026-10-18T09:00:00Z"),
              actorName: null,
            },
          }}
          showLatestMovement
        />,
      ),
    );
    expect(host.textContent).toContain("تم التوريد");
    expect(host.textContent).toContain("آخر حركة: توريد نقد التحصيل");
    expect(host.textContent).not.toContain("بانتظار التوريد");
    expect(host.textContent).not.toContain("الموظف المختص");
  });

  it("keeps the shared coarse status for orders without a delivery projection", () => {
    act(() =>
      root.render(
        <OrderLifecycleStatus
          status="CONFIRMED"
          lifecycle={null}
          showLatestMovement
        />,
      ),
    );
    expect(host.textContent).toBe("مثبَّت");
  });

  it("hides the timeline action and makes no delivery read without permission", () => {
    act(() =>
      root.render(
        <OrderQuickViewDrawer orderId={9} open onOpenChange={() => {}} />,
      ),
    );
    expect(host.textContent).toContain("تم التسليم والتحصيل");
    expect(host.textContent).toContain("شركة التوصيل");
    expect(host.textContent).not.toContain("سجل التوصيل والتحصيل والتوريد");
    expect(mocks.timeline).not.toHaveBeenCalled();
  });

  it("opens the correct consignment timeline for an authorized user", async () => {
    act(() =>
      root.render(
        <OrderQuickViewDrawer
          orderId={9}
          open
          canReadDeliveryTimeline
          onOpenChange={() => {}}
        />,
      ),
    );
    const button = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("سجل التوصيل والتحصيل والتوريد"),
    );
    expect(button).toBeDefined();
    await act(async () => {
      button!.click();
      await vi.dynamicImportSettled();
    });
    expect(mocks.timeline).toHaveBeenCalledWith(
      expect.objectContaining({ consignmentId: 71 }),
    );
    expect(host.textContent).toContain("خط زمن الإرسالية 71");
  });
});

it("shows the fee obligation after customer collection and shop remittance", () => {
  act(() =>
    root.render(
      <OrderLifecycleStatus
        status="DELIVERED"
        lifecycle={{
          ...delivered,
          remittanceLabel: "تم التوريد",
          feeLabel: "أجرة الجهة متبقية: 1500 د.ع",
          financialComplete: false,
        }}
      />,
    ),
  );
  expect(host.textContent).toContain("تم التوريد");
  expect(host.textContent).toContain("أجرة الجهة متبقية: 1500 د.ع");
});
