// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  search: "",
  listeners: new Set<() => void>(),
  scan: vi.fn(),
  source: vi.fn(),
  correction: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("wouter", async () => {
  const React = await import("react");
  return {
    useSearch: () =>
      React.useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => {
            state.listeners.delete(listener);
          };
        },
        () => state.search,
      ),
    useLocation: () => [
      "/delivery",
      (url: string) => {
        state.search = url.split("?")[1] ?? "";
        state.listeners.forEach(listener => listener());
      },
    ],
    Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});
vi.mock("@tanstack/react-query", () => ({ useIsMutating: () => 0 }));
vi.mock("@/hooks/useSessionContext", () => ({
  useSessionBranchInference: () => ({
    branchId: 1,
    canOverride: false,
    branches: [],
  }),
}));
vi.mock("@/hooks/useBarcodeScanner", () => ({ useBarcodeScanner: () => {} }));
vi.mock("@/lib/notify", () => ({
  notify: { err: state.notify, warn: state.notify, ok: state.notify },
}));
vi.mock("@/lib/confirm", () => ({ confirm: vi.fn() }));
vi.mock("@/lib/trpc", () => {
  const utils = {
    delivery: {
      workflow: {
        preview: { fetch: state.scan },
        previewBySource: { fetch: state.source },
      },
    },
    sales: { lookupForCorrection: { fetch: state.correction } },
    workOrders: { getByNumber: { fetch: vi.fn() } },
  };
  const invoice = {
    id: 33494,
    invoiceNumber: "106208",
    status: "PAID",
    total: "17000.00",
    paidAmount: "7000.00",
    invoiceDate: "2026-11-07",
    updatedAt: "2026-11-07",
    canCorrect: true,
  };
  return {
    trpc: {
      useUtils: () => utils,
      auth: {
        me: {
          useQuery: () => ({
            data: { id: 1, role: "admin", isOwner: true, name: "Owner" },
          }),
        },
      },
      shifts: { current: { useQuery: () => ({ data: { id: 7 } }) } },
      delivery: {
        listParties: { useQuery: () => ({ data: [] }) },
        workflow: {
          previewBySource: {
            useQuery: () => ({ data: undefined, isFetching: false }),
          },
        },
      },
      // Retain cached data even when disabled to detect resurrection after reset.
      sales: {
        lookupForCorrection: {
          useQuery: () => ({ data: invoice, isFetching: false }),
        },
      },
    },
  };
});
vi.mock("@/components/delivery/workflow/WorkflowLegacyReturnStation", () => ({
  WorkflowLegacyReturnStation: (props: any) => (
    <div>
      <input
        aria-label="return-code"
        ref={props.inputRef}
        value={props.barcode}
        onChange={(event) => props.onBarcodeChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void props.onLookup(props.barcode);
        }}
      />
      <button onClick={props.onClear}>clear-return</button>
    </div>
  ),
}));
vi.mock("@/components/delivery/workflow/WorkflowReturnSourceCard", () => ({
  WorkflowReturnSourceCard: (props: any) => (
    <div data-testid="return-result">
      {props.preview.source.number}
      <button onClick={props.onClear}>clear-return</button>
    </div>
  ),
}));
vi.mock("@/components/search/UnifiedSearchInput", () => ({
  UnifiedSearchInput: React.forwardRef<HTMLInputElement, any>((props, ref) => (
    <input
      ref={ref}
      aria-label="edit-code"
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") props.onSubmit(props.value);
      }}
    />
  )),
}));
vi.mock("@/components/delivery/workflow/WorkflowDispatchStation", () => ({
  WorkflowDispatchStation: () => null,
}));
vi.mock("@/components/delivery/workflow/WorkflowCollectStation", () => ({
  WorkflowCollectStation: () => null,
}));
vi.mock("@/components/delivery/workflow/WorkflowPrintActions", () => ({
  WorkflowPrintActions: () => null,
}));
vi.mock("@/components/delivery/workflow/WorkflowModeNavigation", () => ({
  WorkflowModeNavigation: () => null,
}));
vi.mock("@/components/delivery/CancelDeliveryAssignmentSection", () => ({
  CancelDeliveryAssignmentSection: () => null,
}));
vi.mock("@/components/delivery/CancelDeliveryAssignmentDialog", () => ({
  CancelDeliveryAssignmentDialog: () => null,
}));
vi.mock("@/components/delivery/DeliveryOperationalIntelligenceBar", () => ({
  DeliveryOperationalIntelligenceBar: () => null,
}));
vi.mock("@/components/delivery/DispatchPreviewCard", () => ({
  DispatchPreviewCard: () => null,
}));
vi.mock("@/components/reception/ReceptionCollectSection", () => ({
  ReceptionCollectSection: () => null,
}));
vi.mock("@/components/PageHeader", () => ({ PageHeader: () => null }));
vi.mock("@/components/ui/AppSelect", () => ({
  AppSelect: ({ children }: any) => <select>{children}</select>,
}));
vi.mock("@/components/form/IntlPhoneInput", () => ({
  IntlPhoneInput: () => null,
}));
vi.mock("@/components/form/MoneyInput", () => ({ MoneyInput: () => null }));
vi.mock("@/components/ui/CardBrandLogos", () => ({
  CardBrandLogos: () => null,
}));
vi.mock("@/lib/printing/printDeliveryDispatchSlip", () => ({
  printDeliveryDispatchSlip: vi.fn(),
}));
vi.mock("@/lib/printing/deliveryDocs", () => ({
  printReadyOrderLabel: vi.fn(),
}));

import DeliveryWorkflowPage from "./ReceptionWorkflowPage";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

describe("workflow page lookup reset", () => {
  let host: HTMLDivElement;
  let root: Root;
  const preview = (kind = "consignment") => ({
    source: {
      kind,
      id: 1787,
      number: "106208",
      canonicalKey: "consignment:1787",
      branchId: 1,
      version: "v1",
    },
    relations: { invoiceId: 33494, consignmentId: 1787 },
    actions: [{ action: "edit", allowed: true }],
  });
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    state.search = "section=return&branchId=1";
    state.scan.mockResolvedValue(preview());
    state.source.mockResolvedValue(preview("invoice"));
    state.correction.mockResolvedValue({ id: 33494 });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  const render = async () => {
    await act(async () => root.render(<DeliveryWorkflowPage />));
  };
  const button = (label: string) =>
    Array.from(host.querySelectorAll("button")).find(
      (element) => element.textContent?.trim() === label,
    )!;
  async function scan(label: string, code: string) {
    const input = host.querySelector<HTMLInputElement>(
      `[aria-label="${label}"]`,
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, code);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
  }
  it("invalidates a pending return preview, refocuses and permits the same barcode again", async () => {
    let resolve!: (value: ReturnType<typeof preview>) => void;
    state.scan.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await render();
    await scan("return-code", "CN-106208");
    expect(state.scan).toHaveBeenCalledTimes(1);
    await act(async () => button("clear-return").click());
    expect(document.activeElement).toBe(
      host.querySelector('[aria-label="return-code"]'),
    );
    await act(async () => resolve(preview()));
    expect(host.querySelector('[data-testid="return-result"]')).toBeNull();
    expect(state.notify).not.toHaveBeenCalled();
    await scan("return-code", "CN-106208");
    expect(state.scan).toHaveBeenCalledTimes(2);
    expect(
      host.querySelector('[data-testid="return-result"]')?.textContent,
    ).toContain("106208");
  });
  it("clears a displayed return result and its input before another scan", async () => {
    await render();
    await scan("return-code", "CN-106208");
    expect(host.querySelector('[data-testid="return-result"]')).not.toBeNull();
    await act(async () => button("clear-return").click());
    expect(host.querySelector('[data-testid="return-result"]')).toBeNull();
    expect(
      host.querySelector<HTMLInputElement>('[aria-label="return-code"]')?.value,
    ).toBe("");
    expect(document.activeElement).toBe(
      host.querySelector('[aria-label="return-code"]'),
    );
    await scan("return-code", "CN-106208");
    expect(state.scan).toHaveBeenCalledTimes(2);
  });
  it("hides retained invoice cache and removes lookup URL identifiers while preserving station and branch", async () => {
    state.search =
      "section=edit&branchId=1&invoice=106208&barcode=INV-106208&raw=106208";
    state.scan.mockResolvedValue(preview("invoice"));
    await render();
    expect(host.textContent).toContain("فاتورة #106208");
    await act(async () => button("مسح الاستعلام").click());
    expect(host.textContent).not.toContain("فاتورة #106208");
    const params = new URLSearchParams(state.search);
    expect(params.get("section")).toBe("edit");
    expect(params.get("branchId")).toBe("1");
    for (const key of ["invoice", "barcode", "raw"])
      expect(params.has(key)).toBe(false);
    expect(document.activeElement).toBe(
      host.querySelector('[aria-label="edit-code"]'),
    );
    await scan("edit-code", "INV-106208");
    expect(host.textContent).toContain("فاتورة #106208");
  });
});
