// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ReceptionDuplicateInput,
  ReceptionDuplicateMatch,
  ReceptionDuplicateResult,
} from "@shared/receptionDuplicateOrders";
import type { RealtimeEvent } from "@shared/realtimeEvents";
import {
  ReceptionDuplicateAlert,
  ReceptionDuplicateAlertView,
} from "./ReceptionDuplicateAlert";
import { ReceptionCartDuplicateAlert } from "./ReceptionCartDuplicateAlert";
import type { CartLine } from "./cartMath";

vi.mock("@/components/CustomizationDialog", () => ({
  composeCustomizationText: vi.fn(),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  me: vi.fn(),
  refetch: vi.fn(),
  invalidate: vi.fn(),
  realtime: vi.fn(),
  connection: "online",
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    auth: { me: { useQuery: mocks.me } },
    reception: { duplicateOrders: { useQuery: mocks.query } },
    useUtils: () => ({
      reception: { duplicateOrders: { invalidate: mocks.invalidate } },
    }),
  },
}));
vi.mock("@/lib/realtime", () => ({ useRealtimeEvent: mocks.realtime }));
vi.mock("@/lib/offline/connectivity", () => ({
  useConnectivity: () => mocks.connection,
  isDisconnected: (state: string) =>
    state === "offline" || state === "reconnecting",
}));

let host: HTMLDivElement;
let root: Root;

function candidate(
  overrides: Partial<ReceptionDuplicateMatch> = {},
): ReceptionDuplicateMatch {
  return {
    key: "ONLINE:18",
    kind: "ONLINE",
    id: 18,
    number: "WEB-018",
    channel: "STORE",
    createdAt: "2026-10-10T09:00:00.000Z",
    statusLabel: "قيد التجهيز",
    total: "45000.00",
    invoice: { id: 91, number: "INV-091", total: "45000.00", status: "PAID" },
    matchedLines: 3,
    currentLines: 3,
    candidateLines: 3,
    quantityMatch: true,
    contentsMatch: true,
    customizationNeedsReview: false,
    matchLevel: "EXACT",
    valueDifference: "0.00",
    href: "/store-admin?tab=orders&orderId=18",
    ...overrides,
  };
}
function result(matches = [candidate()]): ReceptionDuplicateResult {
  return { checked: true, matches, truncated: false };
}
const cart: ReceptionDuplicateInput = {
  branchId: 2,
  channel: "WHATSAPP",
  phone: "07701234567",
  total: "45000.00",
  lines: [{ lineKind: "GOODS", variantId: 4, productUnitId: 8, quantity: "1" }],
};
function render(element: React.ReactNode) {
  act(() => root.render(element));
}
function click(label: string) {
  const button = [...host.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(label),
  );
  expect(button, `Missing action ${label}`).toBeDefined();
  act(() => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}
function latestQueryOptions() {
  return mocks.query.mock.lastCall?.[1] as {
    enabled: boolean;
    staleTime: number;
    retry: boolean;
    refetchOnWindowFocus: boolean;
  };
}
function advance(milliseconds: number) {
  act(() => vi.advanceTimersByTime(milliseconds));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.connection = "online";
  mocks.me.mockReturnValue({
    data: { role: "cashier", permissionsOverride: null },
  });
  mocks.query.mockReturnValue({
    data: result(),
    isError: false,
    isFetching: false,
    refetch: mocks.refetch,
  });
  mocks.invalidate.mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("reception duplicate alert decisions and evidence", () => {
  it("renders real channel, comparison evidence and linked invoice without a customer input", () => {
    render(<ReceptionDuplicateAlertView result={result()} />);
    expect(host.querySelector("section")?.getAttribute("dir")).toBe("rtl");
    expect(host.textContent).toContain("الهاتف مطابق");
    expect(host.textContent).toContain("البنود متطابقة");
    expect(host.textContent).toContain("القيمة متطابقة");
    expect(host.textContent).toContain("المتجر");
    expect(host.textContent).toContain("45,000");
    expect(host.textContent).toContain("قيد التجهيز");
    expect(host.querySelectorAll("input")).toHaveLength(0);
    const invoice = host.querySelector<HTMLAnchorElement>(
      'a[href="/invoices/91"]',
    )!;
    expect(invoice.textContent).toContain("INV-091");
    expect(invoice.target).toBe("_blank");
    expect(invoice.rel).toContain("noopener");
    const order = host.querySelector<HTMLAnchorElement>(
      'a[href="/store-admin?tab=orders&orderId=18"]',
    )!;
    expect(order.textContent).toContain("WEB-018");
    expect(order.rel).toContain("noreferrer");
  });

  it("explains partial overlap, quantity and value differences without labeling them duplicates", () => {
    render(
      <ReceptionDuplicateAlertView
        result={result([
          candidate({
            channel: "INSTAGRAM",
            matchedLines: 3,
            currentLines: 4,
            candidateLines: 5,
            contentsMatch: false,
            customizationNeedsReview: true,
            quantityMatch: false,
            matchLevel: "PARTIAL",
            valueDifference: "5000.00",
            invoice: null,
          }),
        ])}
      />,
    );
    expect(host.textContent).toContain("إنستغرام");
    expect(host.textContent).toContain(
      "3 بنود مشتركة من 4 حالية و5 في الطلب المشابه",
    );
    expect(host.textContent).toContain("توجد فروق في الكميات");
    expect(host.textContent).toContain("تفاصيل التخصيص تحتاج مراجعة");
    expect(host.textContent).toContain("أعلى بمقدار 5,000");
    expect(host.textContent).toContain("لم تصدر فاتورة بعد");
    expect(host.textContent).not.toContain("طلب مكرر مؤكد");
    expect(host.querySelector('a[href^="/invoices/"]')).toBeNull();
    render(
      <ReceptionDuplicateAlertView
        result={result([candidate({ valueDifference: "-250.50" })])}
      />,
    );
    expect(host.textContent).toContain("أقل بمقدار 250.5");
    render(
      <ReceptionDuplicateAlertView
        result={result([candidate({ valueDifference: null })])}
      />,
    );
    expect(host.textContent).toContain("القيمة غير مكتملة للمقارنة");
    expect(host.textContent).not.toContain("القيمة متطابقة");
  });

  it("leaves the preparation decision to the employee and resets it on changed evidence", () => {
    const onContinue = vi.fn();
    const onVerify = vi.fn();
    const initial = result();
    render(
      <ReceptionDuplicateAlertView
        result={initial}
        inputKey="cart-v1"
        onContinue={onContinue}
        onVerify={onVerify}
      />,
    );
    click("التأكد أولاً");
    expect(onVerify).toHaveBeenCalledOnce();
    expect(onContinue).not.toHaveBeenCalled();
    expect(host.textContent).toContain(
      "راجع الطلب المشابه قبل اتخاذ قرار التجهيز",
    );
    expect(host.textContent).not.toContain("تم تعليق");
    click("إكمال التجهيز");
    expect(onContinue).toHaveBeenCalledOnce();
    expect(host.querySelector("section")).toBeNull();
    render(
      <ReceptionDuplicateAlertView
        result={initial}
        inputKey="cart-v2"
        onContinue={onContinue}
      />,
    );
    expect(host.querySelector("section")).not.toBeNull();
    click("إكمال التجهيز");
    render(
      <ReceptionDuplicateAlertView
        result={result([
          candidate({ total: "46000.00", valueDifference: "-1000.00" }),
        ])}
        inputKey="cart-v2"
      />,
    );
    expect(host.querySelector("section")).not.toBeNull();
    expect(host.textContent).toContain("46,000");
  });

  it("supports local choices without callbacks and displays at most three candidates", () => {
    const multiple = result(
      [1, 2, 3, 4].map((id) =>
        candidate({ id, key: `ONLINE:${id}`, number: `WEB-${id}` }),
      ),
    );
    render(<ReceptionDuplicateAlertView result={multiple} />);
    expect(host.querySelectorAll("li")).toHaveLength(3);
    expect(host.textContent).toContain(
      "الفحص محدود؛ اعرض الطلبات المحفوظة للتأكد من بقية النتائج.",
    );
    click("التأكد أولاً");
    expect(host.querySelectorAll("li")).toHaveLength(3);
    click("إكمال التجهيز");
    expect(host.textContent).toBe("");
    render(
      <ReceptionDuplicateAlertView
        result={{ checked: false, matches: [], truncated: true }}
      />,
    );
    expect(host.textContent).toBe("");
    render(<ReceptionDuplicateAlertView result={result()} />);
    expect(host.querySelector("section")).not.toBeNull();
  });

  it("never renders unchecked, empty or no-longer-matching results", () => {
    render(
      <ReceptionDuplicateAlertView
        result={{ checked: false, matches: [candidate()], truncated: false }}
      />,
    );
    expect(host.textContent).toBe("");
    render(<ReceptionDuplicateAlertView result={result()} />);
    expect(host.querySelector("section")).not.toBeNull();
    render(<ReceptionDuplicateAlertView result={result([])} />);
    expect(host.textContent).toBe("");
  });

  it("allows the employee to choose when the search is limited without a confirmed match", () => {
    const onContinue = vi.fn();
    const onVerify = vi.fn();
    render(
      <ReceptionDuplicateAlertView
        result={{ checked: true, matches: [], truncated: true }}
        onContinue={onContinue}
        onVerify={onVerify}
      />,
    );
    expect(host.querySelector("section")).not.toBeNull();
    expect(host.querySelectorAll("li")).toHaveLength(0);
    expect(host.textContent).toContain("الفحص محدود؛ راجع الطلب قبل التجهيز");
    expect(host.textContent).not.toContain(
      "طلب مشابه؛ قرار التجهيز لموظف الاستقبال",
    );
    expect(host.textContent).toContain(
      "الفحص محدود؛ اعرض الطلبات المحفوظة للتأكد من بقية النتائج.",
    );
    expect(host.textContent).not.toContain("الهاتف مطابق");
    click("التأكد أولاً");
    expect(onVerify).toHaveBeenCalledOnce();
    expect(onContinue).not.toHaveBeenCalled();
    click("إكمال التجهيز");
    expect(onContinue).toHaveBeenCalledOnce();
    expect(host.querySelector("section")).toBeNull();
  });

  it("animates only the decorative sprite for two cycles with reduced-motion and print protections", () => {
    render(<ReceptionDuplicateAlertView result={result()} />);
    expect(
      host
        .querySelector(".reception-duplicate-sprite")
        ?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(
      host.querySelectorAll(".reception-duplicate-sprite-track"),
    ).toHaveLength(1);
    expect(host.querySelectorAll('p[class*="animate"]')).toHaveLength(0);
    const css = readFileSync(
      path.resolve(import.meta.dirname, "ReceptionDuplicateAlert.css"),
      "utf8",
    );
    expect(css).toMatch(
      /animation:\s*reception-duplicate-scan\s+900ms\s+steps\(3,\s*end\)\s+2\s*;/,
    );
    expect(css).not.toContain("infinite");
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?animation:\s*none/,
    );
    expect(css).toMatch(/@media\s+print[\s\S]*?animation:\s*none/);
  });
});

describe("bounded duplicate requests", () => {
  it("debounces carts, hides the previous basket evidence immediately and uses a bounded cache", () => {
    render(<ReceptionDuplicateAlert input={cart} />);
    expect(latestQueryOptions().enabled).toBe(false);
    expect(host.querySelector("section")).toBeNull();
    advance(599);
    expect(latestQueryOptions().enabled).toBe(false);
    advance(1);
    expect(latestQueryOptions()).toMatchObject({
      enabled: true,
      staleTime: 15000,
      retry: false,
      refetchOnWindowFocus: false,
    });
    expect(host.querySelector("section")).not.toBeNull();
    const changed = { ...cart, phone: "07801234567" };
    render(<ReceptionDuplicateAlert input={changed} />);
    expect(latestQueryOptions().enabled).toBe(false);
    expect(host.querySelector("section")).toBeNull();
    render(
      <ReceptionDuplicateAlert input={{ ...changed, total: "47000.00" }} />,
    );
    advance(600);
    expect(mocks.query.mock.lastCall?.[0]).toMatchObject({
      phone: "07801234567",
      total: "47000.00",
    });
    expect(latestQueryOptions().enabled).toBe(true);
  });

  it("checks saved references immediately without asking for a phone, but never checks walk-in carts", () => {
    render(
      <ReceptionDuplicateAlert
        input={{ branchId: 2, reference: { kind: "DRAFT", id: 9 } }}
      />,
    );
    expect(latestQueryOptions().enabled).toBe(true);
    expect(mocks.query.mock.lastCall?.[0]).toEqual({
      branchId: 2,
      reference: { kind: "DRAFT", id: 9 },
    });
    render(<ReceptionDuplicateAlert input={{ ...cart, channel: "WALK_IN" }} />);
    advance(600);
    expect(latestQueryOptions().enabled).toBe(false);
    expect(host.textContent).toBe("");
    render(<ReceptionDuplicateAlert input={{ ...cart, phone: "123" }} />);
    advance(600);
    expect(latestQueryOptions().enabled).toBe(false);
  });

  it("uses cached permission gates and skips a second request for supplied preflight results", () => {
    mocks.me.mockReturnValue({
      data: {
        role: "sales_rep",
        permissionsOverride: { store: "NONE", workorders: "NONE" },
      },
    });
    render(<ReceptionDuplicateAlert input={cart} />);
    advance(600);
    expect(latestQueryOptions().enabled).toBe(false);
    expect(mocks.me.mock.lastCall?.[1]).toEqual({ enabled: false });
    expect(host.textContent).toBe("");
    render(<ReceptionDuplicateAlert input={cart} result={result()} />);
    expect(latestQueryOptions().enabled).toBe(false);
    expect(host.textContent).toContain("الهاتف مطابق");
    mocks.me.mockReturnValue({
      data: { role: "sales_rep", permissionsOverride: { workorders: "FULL" } },
    });
    render(<ReceptionDuplicateAlert input={cart} />);
    advance(600);
    expect(latestQueryOptions().enabled).toBe(true);
  });

  it("checks online orders for store-only preparers without a second identity request", () => {
    mocks.me.mockReturnValue({
      data: { role: "sales_rep", permissionsOverride: null },
    });
    render(
      <ReceptionDuplicateAlert
        input={{ branchId: 2, reference: { kind: "ONLINE", id: 18 } }}
      />,
    );
    expect(latestQueryOptions().enabled).toBe(true);
    expect(mocks.me.mock.lastCall?.[1]).toEqual({ enabled: false });
    expect(host.textContent).toContain("الهاتف مطابق");
    mocks.me.mockReturnValue({
      data: {
        role: "sales_rep",
        permissionsOverride: { store: "READ", workorders: "NONE" },
      },
    });
    render(
      <ReceptionDuplicateAlert
        input={{ branchId: 2, reference: { kind: "ONLINE", id: 18 } }}
      />,
    );
    expect(latestQueryOptions().enabled).toBe(false);
    expect(host.textContent).toBe("");
  });

  it("retains the remote cart's unavailable warning offline and keeps walk-in carts silent", () => {
    mocks.connection = "offline";
    const lines: CartLine[] = [
      {
        key: "goods-4",
        qty: 1,
        row: {
          variantId: 4,
          productUnitId: 8,
          productName: "دفتر",
          isPrintService: false,
        } as CartLine["row"],
      },
    ];
    const props = {
      branchId: 2,
      phone: cart.phone!,
      cart: lines,
      total: "45000.00",
      disabled: false,
      onVerify: vi.fn(),
    };
    render(<ReceptionCartDuplicateAlert {...props} channel="WHATSAPP" />);
    advance(600);
    expect(latestQueryOptions().enabled).toBe(false);
    expect(host.textContent).toContain("تعذّر فحص التشابه");
    expect(host.textContent).not.toContain("الهاتف مطابق");
    render(<ReceptionCartDuplicateAlert {...props} channel="WALK_IN" />);
    advance(600);
    expect(latestQueryOptions().enabled).toBe(false);
    expect(host.textContent).toBe("");
  });

  it("shows a nonblocking failure with a working retry and hides cached matches when offline", () => {
    mocks.query.mockReturnValue({
      data: result(),
      isError: true,
      isFetching: false,
      refetch: mocks.refetch,
    });
    const reference: ReceptionDuplicateInput = {
      branchId: 2,
      reference: { kind: "ONLINE", id: 18 },
    };
    render(<ReceptionDuplicateAlert input={reference} />);
    expect(host.textContent).toContain(
      "تعذّر فحص التشابه؛ يمكنك المتابعة أو إعادة الفحص",
    );
    expect(host.textContent).not.toContain("الهاتف مطابق");
    click("إعادة الفحص");
    expect(mocks.refetch).toHaveBeenCalledOnce();
    mocks.connection = "offline";
    mocks.query.mockReturnValue({
      data: result(),
      isError: false,
      isFetching: false,
      refetch: mocks.refetch,
    });
    render(<ReceptionDuplicateAlert input={reference} />);
    expect(latestQueryOptions().enabled).toBe(false);
    expect(host.textContent).not.toContain("الهاتف مطابق");
    expect(host.querySelector("button")?.disabled).toBe(true);
    render(<ReceptionDuplicateAlert input={reference} result={result()} />);
    expect(host.textContent).not.toContain("الهاتف مطابق");
    expect(host.textContent).toContain("تعذّر فحص التشابه");
  });

  it("coalesces relevant branch events and cancels pending refreshes when the current input changes", () => {
    const reference: ReceptionDuplicateInput = {
      branchId: 2,
      reference: { kind: "ONLINE", id: 18 },
    };
    render(<ReceptionDuplicateAlert input={reference} />);
    const handler = mocks.realtime.mock.lastCall?.[1] as (
      event: RealtimeEvent,
    ) => void;
    const event = (branchId: number): RealtimeEvent => ({
      id: "event",
      timestamp: 1,
      type: "RECEPTION_QUEUE_UPDATED",
      payload: {},
      scope: { branchId },
    });
    handler(event(7));
    advance(600);
    expect(mocks.invalidate).not.toHaveBeenCalled();
    handler(event(2));
    handler(event(2));
    advance(600);
    expect(mocks.invalidate).toHaveBeenCalledOnce();
    expect(mocks.invalidate).toHaveBeenCalledWith(reference);
    handler(event(2));
    render(
      <ReceptionDuplicateAlert
        input={{ branchId: 2, reference: { kind: "ONLINE", id: 19 } }}
      />,
    );
    advance(600);
    expect(mocks.invalidate).toHaveBeenCalledOnce();
  });
});
