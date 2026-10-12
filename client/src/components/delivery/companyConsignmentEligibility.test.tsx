// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CompanyConsignmentActions,
  CompanyConsignmentDriver,
} from "./companyConsignmentColumns";

vi.mock("@/components/ui/AppSelect", () => ({
  AppSelect: ({
    children,
    onValueChange,
    ...props
  }: React.ComponentProps<"select"> & {
    onValueChange?: (value: string) => void;
  }) => (
    <select
      {...props}
      onChange={(event) => onValueChange?.(event.currentTarget.value)}
    >
      {children}
    </select>
  ),
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    size,
    variant,
    ...props
  }: React.ComponentProps<"button"> & { size?: string; variant?: string }) => (
    <button {...props}>{children}</button>
  ),
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Row = React.ComponentProps<typeof CompanyConsignmentActions>["c"];
const healthy = {
  id: 1,
  consignmentNumber: "CN-1",
  status: "DISPATCHED",
  parcelStatus: "ASSIGNED",
  moneyStatus: "UNSETTLED",
  remainingDue: "1000.00",
  collectedAmount: "0.00",
  counterSettledAmount: "0.00",
  shortfallAssigned: "0.00",
  returnDeclaredAt: null,
} as Row;

describe("company consignment operational eligibility", () => {
  let host: HTMLDivElement;
  let root: Root;
  const options = {
    canEdit: true,
    canSettle: true,
    partyId: 1,
    drivers: [],
    reassignM: { isPending: false, mutate: vi.fn() },
    setCollectConsignmentTarget: vi.fn(),
    setCancelConsignmentTarget: vi.fn(),
    setTimelineId: vi.fn(),
    setReturnTarget: vi.fn(),
  };
  beforeEach(() => {
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  function render(c: Row) {
    act(() =>
      root.render(
        <>
          <CompanyConsignmentActions {...options} c={c} />
          <CompanyConsignmentDriver {...options} c={c} />
        </>,
      ),
    );
  }

  it("offers reassignment and cancellation for a healthy open parcel", () => {
    render(healthy);
    expect(host.querySelector("select")).not.toBeNull();
    expect(host.textContent).toContain("إلغاء الإسناد");
  });
  it.each(["ASSIGNED", "OUT_FOR_DELIVERY", "FAILED"] as const)(
    "return pending %s retains details and receive-return only",
    (parcelStatus) => {
      render({
        ...healthy,
        parcelStatus,
        returnDeclaredAt: new Date("2026-10-12T08:00:00Z"),
      });
      expect(host.querySelector("select")).toBeNull();
      expect(host.textContent).not.toContain("إلغاء الإسناد");
      expect(host.textContent).not.toContain("سجّل التحصيل");
      expect(host.textContent).toContain("استلام المرتجع");
      const buttons = Array.from(host.querySelectorAll("button"));
      act(() =>
        buttons.find((button) => button.textContent === "التفاصيل")!.click(),
      );
      act(() =>
        buttons
          .find((button) => button.textContent === "استلام المرتجع")!
          .click(),
      );
      expect(options.setTimelineId).toHaveBeenCalledWith(1);
      expect(options.setReturnTarget).toHaveBeenCalledWith({
        consignmentId: 1,
        label: "CN-1",
      });
    },
  );
  it.each(["DELIVERED", "CANCELLED", "RETURNED", "WRITTEN_OFF"] as const)(
    "closed %s exposes details without operational actions",
    (status) => {
      render({
        ...healthy,
        status,
        parcelStatus: "FAILED",
        returnDeclaredAt: new Date(),
      });
      expect(host.querySelector("select")).toBeNull();
      expect(
        Array.from(
          host.querySelectorAll("button"),
          (button) => button.textContent,
        ),
      ).toEqual(["التفاصيل"]);
      render({ ...healthy, status, parcelStatus: "DELIVERED" });
      expect(
        Array.from(
          host.querySelectorAll("button"),
          (button) => button.textContent,
        ),
      ).toEqual(["التفاصيل"]);
    },
  );
  it("keeps settlement available for an open physically delivered parcel", () => {
    render({ ...healthy, parcelStatus: "DELIVERED" });
    expect(host.textContent).toContain("سجّل التحصيل");
    expect(host.querySelector("select")).toBeNull();
  });
});
