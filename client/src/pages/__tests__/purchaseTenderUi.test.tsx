// @vitest-environment jsdom
import React, { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PurchaseTenderField,
  usePurchaseTenderState,
} from "@/components/purchases/PurchaseTenderField";
import type { PurchaseTenderInput } from "@shared/purchaseTender";

const mock = vi.hoisted(() => ({
  cash: {
    data: { drawers: [{ id: 41, shiftType: "SALES" }], canUseTreasury: true },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  sources: {
    data: {
      cardAccount: { id: 8, code: "CARD_BANK", name: "بطاقة الشركة" } as {
        id: number;
        code: string;
        name: string;
      } | null,
      previousPayments: [
        {
          id: 71,
          voucherNumber: "PAY-71",
          amount: "150",
          availableAmount: "150",
          paymentMethod: "CASH",
          date: "2026-10-26",
        },
      ],
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    supplierPayments: { cashSources: { useQuery: () => mock.cash } },
    purchases: { paymentSources: { useQuery: () => mock.sources } },
  },
}));
vi.mock("@/components/ui/AppSelect", () => ({
  AppSelect: ({
    value,
    onValueChange,
    children,
    ...props
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: React.ReactNode;
  }) => (
    <select
      {...props}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
}));

let root: Root;
let container: HTMLDivElement;
let current: ReturnType<typeof usePurchaseTenderState>;
let savedPayload: PurchaseTenderInput | undefined;
function Workspace({
  supplierId = 2,
  branchId = 1,
  saved,
  isCreator = true,
  enabled = true,
}: {
  supplierId?: number;
  branchId?: number;
  saved?: PurchaseTenderInput;
  isCreator?: boolean;
  enabled?: boolean;
}) {
  current = usePurchaseTenderState({
    branchId,
    supplierId,
    enabled,
    context: saved ? "edit" : "create",
    isCreator,
    total: "100",
  });
  useEffect(() => {
    if (saved) current.reset(saved);
  }, [saved]);
  return (
    <>
      <PurchaseTenderField
        idPrefix="test"
        state={current}
        paymentTerms={enabled ? "CASH" : "CREDIT"}
        currency="IQD"
      />
      <button
        data-save="true"
        onClick={() => {
          if (!current.isActionBlocked) savedPayload = current.payload;
        }}
      >
        حفظ
      </button>
    </>
  );
}
async function mount(props: React.ComponentProps<typeof Workspace> = {}) {
  await act(async () => root.render(<Workspace {...props} />));
}
async function choose(label: string, value: string) {
  const field = container.querySelector<HTMLSelectElement>(
    `select[aria-label="${label}"]`,
  )!;
  await act(async () => {
    field.value = value;
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function change(key: "referenceNumber" | "cardLastFour", value: string) {
  await act(async () => current.change(key, value));
}
async function save() {
  await act(async () =>
    container
      .querySelector("button[data-save]")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  mock.cash.data = {
    drawers: [{ id: 41, shiftType: "SALES" }],
    canUseTreasury: true,
  };
  mock.cash.isError = false;
  mock.sources.isError = false;
  mock.sources.data.previousPayments[0]!.availableAmount = "150";
  mock.sources.data.cardAccount = {
    id: 8,
    code: "CARD_BANK",
    name: "بطاقة الشركة",
  };
  savedPayload = undefined;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("purchase tender creation and saved revision", () => {
  it("shows a single drawer without another chooser and saves its explicit identity", async () => {
    await mount();
    expect(container.textContent).toContain("#41");
    expect(container.querySelector('[aria-label="وردية الدافع"]')).toBeNull();
    await save();
    expect(savedPayload).toEqual({ mode: "DRAWER", shiftId: 41 });
  });
  it("requires documentary card reference and four digits before saving CARD", async () => {
    await mount();
    await choose("مصدر السداد", "CARD");
    expect(container.textContent).toContain("مرجع عملية بطاقة الشركة");
    await save();
    expect(savedPayload).toBeUndefined();
    await change("referenceNumber", "PAYMENT-123");
    await change("cardLastFour", "123");
    expect(current.validationError).toContain("أربعة أرقام");
    await change("cardLastFour", "1234");
    await save();
    expect(savedPayload).toEqual({
      mode: "CARD",
      accountId: 8,
      referenceNumber: "PAYMENT-123",
      cardLastFour: "1234",
    });
  });
  it("links only an explicitly selected prior receipt and previews its unused balance", async () => {
    mock.cash.data.drawers = [];
    await mount();
    expect(current.draft.mode).toBe("DRAWER");
    expect(current.isActionBlocked).toBe(true);
    await choose("دفعة سابقة معتمدة", "71");
    expect(container.textContent).toContain("لا يوجد صرف جديد");
    expect(current.amounts.applied.toString()).toBe("100");
    expect(current.amounts.unused.toString()).toBe("50");
    await save();
    expect(savedPayload).toEqual({ mode: "DRAWER", previousReceiptId: 71 });
  });
  it("restores a saved card revision and returns the same input on save", async () => {
    const saved: PurchaseTenderInput = {
      mode: "CARD",
      accountId: 8,
      cardLastFour: "9876",
      referenceNumber: "BANK-88",
      previousReceiptId: 71,
    };
    await mount({ saved, isCreator: false });
    expect(
      container.querySelector<HTMLInputElement>(
        '[aria-label="مرجع عملية البطاقة"]',
      )?.value,
    ).toBe("BANK-88");
    await save();
    expect(savedPayload).toEqual(saved);
  });
  it("retains the declared creator drawer when another editor has a different open drawer", async () => {
    const saved: PurchaseTenderInput = { mode: "DRAWER", shiftId: 92 };
    await mount({ saved, isCreator: false });
    expect(current.draft.shiftId).toBe("92");
    expect(current.isActionBlocked).toBe(false);
    await save();
    expect(savedPayload).toEqual(saved);
  });
  it("clears prior receipt and card evidence when supplier or branch changes", async () => {
    await mount();
    await choose("مصدر السداد", "CARD");
    await choose("دفعة سابقة معتمدة", "71");
    await change("referenceNumber", "PAY-1");
    await change("cardLastFour", "1234");
    await mount({ supplierId: 3, branchId: 2 });
    expect(current.draft.previousReceiptId).toBe("");
    expect(current.draft.referenceNumber).toBe("");
    expect(current.draft.cardLastFour).toBe("");
    expect(current.isActionBlocked).toBe(true);
  });
  it("blocks saving when tender sources fail and never fabricates a card account", async () => {
    mock.sources.isError = true;
    await mount();
    expect(current.validationError).toContain("تعذر التحقق");
    await save();
    expect(savedPayload).toBeUndefined();
    mock.sources.isError = false;
    mock.sources.data.cardAccount = null;
    await choose("مصدر السداد", "CARD");
    expect(current.validationError).toContain("حساب بطاقة الشركة غير متاح");
    expect(current.payload).toBeUndefined();
  });
  it("keeps saved fully prepaid drawer intent without filling the editor's current drawer", async () => {
    const saved: PurchaseTenderInput = {
      mode: "DRAWER",
      previousReceiptId: 71,
    };
    await mount({ saved });
    expect(current.draft.shiftId).toBe("");
    await save();
    expect(savedPayload).toEqual(saved);
  });
  it("requires an available source for a prior payment that covers only part of the invoice", async () => {
    mock.sources.data.previousPayments[0]!.availableAmount = "60";
    mock.cash.data.drawers = [];
    await mount();
    await choose("دفعة سابقة معتمدة", "71");
    expect(current.amounts.remainder.toString()).toBe("40");
    expect(current.isActionBlocked).toBe(true);
    await choose("مصدر السداد", "TREASURY");
    await save();
    expect(savedPayload).toEqual({ mode: "TREASURY", previousReceiptId: 71 });
  });
  it("omits tender for CREDIT after a CASH selection", async () => {
    await mount();
    await mount({ enabled: false });
    expect(current.payload).toBeUndefined();
    expect(current.isActionBlocked).toBe(false);
  });
});
