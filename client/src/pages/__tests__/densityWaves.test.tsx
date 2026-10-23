// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";

const state = vi.hoisted(() => ({
  total: 241,
  calls: [] as { path: string; input: any; options: any }[],
  partiesError: false,
  draftPages: 1,
  nextPage: vi.fn(),
}));
vi.mock("@/lib/trpc", () => {
  const result = (path: string, input: any, options: any) => {
    state.calls.push({ path, input, options });
    const product = {
      productId: input?.offset ?? 0,
      name: "منتج اختبار",
      variants: [],
      readinessReasons: [],
      publishable: true,
      inStock: false,
    };
    const data =
      path === "auth.me"
        ? { id: 1, role: "admin", branchId: 2 }
        : path === "storeAdmin.catalog.list"
          ? {
              total: state.total,
              rows: (input?.offset ?? 0) < state.total ? [product] : [],
              publishableTotal: state.total,
            }
          : path === "storeAdmin.orders.parties"
            ? []
            : path === "branches.list"
              ? [{ id: 2, name: "الفرع" }]
              : path === "storeAdmin.notifications.list"
                ? [1, 2].map((id) => ({
                    id,
                    name: `حملة ${id}`,
                    title: "إشعار",
                    status: "APPROVED",
                    kind: "MARKETING",
                    destination: "/",
                  }))
                : path === "digitalCards.dashboard.topOfferings"
                  ? []
                  : undefined;
    return {
      data,
      isLoading: false,
      isFetching: false,
      isError: path === "storeAdmin.orders.parties" && state.partiesError,
      error: { message: "تعذر تحميل الجهات" },
      refetch: vi.fn(),
    };
  };
  const node = (parts: string[]): any =>
    new Proxy(() => {}, {
      get: (_, key) =>
        key === "useQuery"
          ? (input: any, options: any) =>
              result(parts.join("."), input, options)
          : key === "useInfiniteQuery"
            ? (input: any, options: any) => {
                state.calls.push({ path: parts.join("."), input, options });
                const row = (id: number) => ({
                  id,
                  draftNumber: `DR-${id}`,
                  status: "OPEN",
                  createdAt: new Date().toISOString(),
                  heldTotal: "0",
                  total: "10",
                  header: {},
                  lineCount: 1,
                });
                return {
                  data: {
                    pages: Array.from(
                      { length: state.draftPages },
                      (_, index) => ({
                        rows: [row(index + 1)],
                        hasMore: true,
                        nextCursor: index + 1,
                      }),
                    ),
                  },
                  hasNextPage: true,
                  fetchNextPage: state.nextPage,
                  isLoading: false,
                  isFetching: false,
                  isFetchingNextPage: false,
                  isError: false,
                  refetch: vi.fn(),
                };
              }
            : key === "useMutation"
              ? () => ({
                  mutate: (input: any) =>
                    state.calls.push({
                      path: parts.join("."),
                      input,
                      options: { mutation: true },
                    }),
                  isPending: false,
                })
              : key === "useUtils"
                ? () => node([])
                : key === "invalidate"
                  ? vi.fn()
                  : node([...parts, String(key)]),
    });
  return { trpc: node([]) };
});
vi.mock("@/lib/digitalGiftOperationAccess", () => ({
  useDigitalGiftOperationAccess: () => ({
    can: () => true,
    query: (_: string, q: unknown) => q,
    costVisible: () => false,
  }),
}));
vi.mock("@/components/data-table/DataTable", () => ({
  DataTable: ({ data }: any) => <div data-table-count={data?.length ?? 0} />,
}));
vi.mock("@/components/ui/AppSelect", () => ({
  AppSelect: ({ children, onValueChange, ...props }: any) => (
    <select {...props} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
}));
vi.mock("@/components/ui/dialog", () => ({
  useDialogComposition: () => ({
    setComposing: () => {},
    markCompositionEnd: () => {},
    isComposing: () => false,
    justEndedComposing: () => false,
  }),
  Dialog: ({ children, open }: any) =>
    open === false ? null : <div>{children}</div>,
  DialogContent: ({ children }: any) => <div role="dialog">{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
}));
import StoreCatalog from "../store/StoreCatalog";
import DigitalDashboard from "../digitalCards/DigitalDashboard";
import StorePushCampaignManager from "../store/StorePushCampaignManager";
import ReceptionDraftsPage from "../reception/ReceptionDraftsPage";
import { OrderDispatchDialog } from "@/components/store/OrderDispatchDialog";
import {
  canPrintFixedCoupon,
  couponDiscountLabel,
} from "@/components/crm/customerCoupon";
import { poItemColumns } from "@/components/purchases/purchaseDetailColumns";
import { ReviewDecisionCell } from "@/components/stocktake/ReviewDecisionCell";

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("React", React);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  state.calls = [];
  state.total = 241;
  state.partiesError = false;
  state.draftPages = 1;
  state.nextPage.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function click(text: string) {
  const buttons = [...container.querySelectorAll("button")];
  const button =
    buttons.find((button) => button.textContent === text) ??
    buttons.find((button) => button.textContent?.includes(text));
  expect(button, text).toBeDefined();
  act(() => button!.click());
}
function change(input: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype =
    input instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
  act(() => {
    input.dispatchEvent(
      new Event(input instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}

describe("operational wave regressions", () => {
  it("preserves stocktake decision and reason callbacks after extraction", () => {
    const row = {variantId: 7, rawCount: 12, diff: 2, overThreshold: true, decision: null, reviewApproved: null} as any;
    const actions = {s: {directUnderThreshold: false}, isOperational: true, canOperation: () => true, decide: {isPending: false}, onDecide: vi.fn(), openRecount: vi.fn(), onReasonChange: vi.fn()} as any;
    act(() => root.render(<table><tbody><tr><ReviewDecisionCell r={row} actions={actions} reason="UNSPECIFIED" /></tr></tbody></table>));
    click("تسوية"); expect(actions.onDecide).toHaveBeenCalledWith(row, "ADJUST");
    change(container.querySelector('select[aria-label="سبب الفرق"]')!, "DAMAGE");
    expect(actions.onReasonChange).toHaveBeenCalledWith(row, "DAMAGE");
    click("إعادة عدّ"); expect(actions.openRecount).toHaveBeenCalledWith(row);
  });
  it("retains stocktake permission gates and finalized-row locks", () => {
    const row = {variantId: 7, rawCount: 12, diff: 2, overThreshold: true, decision: null, reviewApproved: {isCurrent: true}} as any;
    const actions = {s: {directUnderThreshold: false}, isOperational: true, canOperation: () => false, decide: {isPending: false}} as any;
    act(() => root.render(<table><tbody><tr><ReviewDecisionCell r={row} actions={actions} reason="DAMAGE" /></tr></tbody></table>));
    expect(container.querySelector('select[aria-label="سبب الفرق"]')?.disabled).toBe(true);
    expect([...container.querySelectorAll('button')].some(button => button.textContent === "تسوية")).toBe(false);
  });
  it("keeps catalog requests within the API cap after the fifth page and resets filters", () => {
    act(() => root.render(<StoreCatalog />));
    for (let page = 0; page < 6; page++) click("الصفحة التالية");
    let last = state.calls
      .filter((call) => call.path === "storeAdmin.catalog.list")
      .at(-1)!;
    expect(last.input).toMatchObject({ limit: 40, offset: 240 });
    expect(
      state.calls
        .filter((call) => call.path === "storeAdmin.catalog.list")
        .every((call) => call.input.limit <= 200),
    ).toBe(true);
    click("المميّزة");
    last = state.calls
      .filter((call) => call.path === "storeAdmin.catalog.list")
      .at(-1)!;
    expect(last.input).toMatchObject({ offset: 0, featuredOnly: true });
  });
  it("keeps recovery navigation when the last page becomes empty", () => {
    state.total = 41;
    act(() => root.render(<StoreCatalog />));
    click("الصفحة التالية");
    state.total = 40;
    act(() => root.render(<StoreCatalog />));
    click("الصفحة السابقة");
    expect(
      state.calls
        .filter((call) => call.path === "storeAdmin.catalog.list")
        .at(-1)!.input.offset,
    ).toBe(0);
  });
  it("continues draft cursors and retains loaded drafts", () => {
    act(() => root.render(<ReceptionDraftsPage />));
    const call = state.calls
      .filter((call) => call.path === "reception.draftList")
      .at(-1)!;
    expect(
      call.options.getNextPageParam({ hasMore: true, nextCursor: 50 }),
    ).toBe(50);
    expect(
      call.options.getNextPageParam({ hasMore: false, nextCursor: null }),
    ).toBeUndefined();
    click("عرض المزيد من المسودات");
    expect(state.nextPage).toHaveBeenCalledOnce();
    state.draftPages = 2;
    act(() => root.render(<ReceptionDraftsPage />));
    expect(container.textContent).toContain("DR-1");
    expect(container.textContent).toContain("DR-2");
    click("المعلقة");
    expect(
      state.calls.filter((call) => call.path === "reception.draftList").at(-1)!
        .input.staleOnly,
    ).toBe(true);
  });
  it("requires a separate explicit schedule for each selected campaign", () => {
    act(() => root.render(<StorePushCampaignManager />));
    expect(container.querySelector('input[type="datetime-local"]')).toBeNull();
    click("جدولة");
    expect(container.textContent).toContain("جدولة الحملة: حملة 1");
    const submit = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "تأكيد الجدولة",
    )!;
    expect(submit.disabled).toBe(true);
    change(
      container.querySelector('input[type="datetime-local"]')!,
      "2099-01-01T09:00",
    );
    click("تأكيد الجدولة");
    const sent = state.calls.find(
      (call) => call.path === "storeAdmin.notifications.schedule",
    );
    expect(sent?.input).toEqual({
      campaignId: 1,
      scheduledAt: "2099-01-01T09:00:00.000Z",
    });
  });
  it("honors explicit all-branch selection and safely disables incomplete date queries", () => {
    act(() => root.render(<DigitalDashboard />));
    change(container.querySelector('select[aria-label="الفرع"]')!, "");
    expect(
      state.calls
        .filter((call) => call.path === "digitalCards.dashboard.summary")
        .at(-1)!.input.branchId,
    ).toBeUndefined();
    change(container.querySelector('select[aria-label="الفترة"]')!, "custom");
    change(container.querySelector('input[aria-label="إلى تاريخ"]')!, "");
    const summary = state.calls
      .filter((call) => call.path === "digitalCards.dashboard.summary")
      .at(-1)!;
    expect(summary.options.enabled).toBe(false);
    expect(container.textContent).toContain("أدخل تاريخ بداية ونهاية صالحين");
  });
  it("reports an unavailable dispatch query instead of calling it an empty directory", () => {
    state.partiesError = true;
    act(() =>
      root.render(
        <OrderDispatchDialog
          order={{
            id: 1,
            orderNumber: "ORD-1",
            total: "100",
            customerName: "عميل",
          }}
          pending={false}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />,
      ),
    );
    expect(container.textContent).toContain("تعذر تحميل الجهات");
    expect(container.textContent).not.toContain("لا توجد جهة توصيل نشطة");
    expect(
      [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("تأكيد الإرسال"),
      )?.disabled,
    ).toBe(true);
  });
  it("retains four USD unit-price decimals in the purchase approval view", () => {
    const usd = poItemColumns(true).find(
      (column) => column.id === "unitPrice",
    ) as any;
    const iqd = poItemColumns(false).find(
      (column) => column.id === "unitPrice",
    ) as any;
    expect(usd.accessorFn({ usdUnitPrice: "3.4566" })).toContain("3.4566");
    expect(iqd.accessorFn({ unitPrice: "1234.56" })).toContain("234.56");
  });
  it.each(["0.00", null])(
    "never invents a cash value for percentage coupons (%s)",
    (discountAmount) => {
      const coupon = {
        code: "P20",
        discountType: "PERCENT",
        discountPercent: "20",
        discountAmount,
      };
      expect(couponDiscountLabel(coupon)).toBe("20%");
      expect(canPrintFixedCoupon(coupon)).toBe(false);
    },
  );
  it("permits a real fixed coupon and refuses a missing face value", () => {
    expect(
      canPrintFixedCoupon({
        code: "F",
        discountType: "FIXED",
        discountAmount: "15000",
      }),
    ).toBe(true);
    expect(
      canPrintFixedCoupon({
        code: "F",
        discountType: "FIXED",
        discountAmount: null,
      }),
    ).toBe(false);
  });
});
