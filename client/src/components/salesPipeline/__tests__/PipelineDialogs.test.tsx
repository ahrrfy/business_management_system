// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  LeadFormDialog,
  OpportunityFormDialog,
  PipelineHistoryDialog,
  PipelineTransitionDialog,
} from "../PipelineDialogs";
import { dateOnly } from "../pipelineFormSession";
import type { LeadRow, OpportunityRow, PipelineOptions } from "../types";

vi.mock("@/components/ui/dialog", () => ({
  useDialogComposition: () => ({
    isComposing: () => false,
    justEndedComposing: () => false,
    setComposing: vi.fn(),
    markCompositionEnd: vi.fn(),
  }),
  Dialog: ({ open, children }: any) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <header>{children}</header>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
  DialogFooter: ({ children }: any) => <footer>{children}</footer>,
}));
vi.mock("@/components/ui/AppSelect", () => ({
  AppSelect: ({ onValueChange, children, ...props }: any) => (
    <select {...props} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
}));
vi.mock("@/components/form/MoneyInput", () => ({
  MoneyInput: ({ onChange, ariaLabel, ...props }: any) => (
    <input
      {...props}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
vi.mock("@/components/form/IntlPhoneInput", () => ({
  IntlPhoneInput: ({ onChange, ...props }: any) => (
    <input {...props} onChange={(event) => onChange(event.target.value)} />
  ),
}));

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("React", React);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const options: PipelineOptions = {
  selectedBranchId: 1,
  branches: [
    { id: 1, name: "الرئيسي" },
    { id: 2, name: "المبيعات" },
  ],
  owners: [{ id: 10, name: "المسؤول", role: "sales" }],
  customers: [
    { id: 20, name: "العميل الأول", phone: null },
    { id: 21, name: "العميل الثاني", phone: null },
  ],
  quotations: [
    {
      id: 30,
      quoteNumber: "Q30",
      customerId: 20,
      total: "100",
      status: "SENT",
    },
  ],
  invoices: [],
};
const callbacks = () => ({
  onOpenChange: vi.fn(),
  onBranchChange: vi.fn(),
  onSubmit: vi.fn(),
  pending: false,
});
function render(node: React.ReactNode) {
  act(() => root.render(node));
}
function value(id: string) {
  return container.querySelector<HTMLInputElement>(`#${id}`)!.value;
}
function change(id: string, value: string) {
  const element = container.querySelector<HTMLInputElement | HTMLSelectElement>(
    `#${id}`,
  )!;
  act(() => {
    Object.getOwnPropertyDescriptor(
      element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype,
      "value",
    )!.set!.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}
function save() {
  act(() =>
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "حفظ")!
      .click(),
  );
}

it("preserves the lead draft while branch options refresh", () => {
  const props = callbacks();
  render(<LeadFormDialog open options={options} {...props} />);
  change("lead-name", "اسم مكتوب");
  change("lead-branch", "2");
  render(
    <LeadFormDialog
      open
      options={{ ...options, selectedBranchId: 2 }}
      {...props}
    />,
  );
  expect(value("lead-name")).toBe("اسم مكتوب");
  expect(value("lead-branch")).toBe("2");
});

it("resets a closed lead session but preserves a draft across equivalent record objects", () => {
  const props = callbacks();
  const initial = { id: 4, branchId: 1, contactName: "اسم محفوظ" } as LeadRow;
  render(
    <LeadFormDialog open initial={initial} options={options} {...props} />,
  );
  change("lead-name", "تعديل محلي");
  render(
    <LeadFormDialog
      open
      initial={{ ...initial }}
      options={options}
      {...props}
    />,
  );
  expect(value("lead-name")).toBe("تعديل محلي");
  render(
    <LeadFormDialog
      open={false}
      initial={initial}
      options={options}
      {...props}
    />,
  );
  render(
    <LeadFormDialog open initial={initial} options={options} {...props} />,
  );
  expect(value("lead-name")).toBe("اسم محفوظ");
});

it("clears branch-scoped owner and quotation without erasing opportunity content", () => {
  const props = callbacks();
  render(<OpportunityFormDialog open options={options} {...props} />);
  change("opp-title", "فرصة محفوظة");
  change("opp-customer", "20");
  change("opp-owner", "10");
  change("opp-quote", "30");
  change("opp-value", "100");
  change("opp-close", "2026-11-25");
  change("opp-branch", "2");
  save();
  expect(props.onSubmit).not.toHaveBeenCalled();
  render(
    <OpportunityFormDialog
      open
      options={{ ...options, selectedBranchId: 2, owners: [], quotations: [] }}
      {...props}
    />,
  );
  save();
  expect(props.onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({
      branchId: 2,
      customerId: 20,
      ownerId: null,
      quotationId: null,
      title: "فرصة محفوظة",
      expectedValue: "100",
    }),
  );
});

it("preserves conversion identity and its required reason", () => {
  const props = callbacks();
  const lead = {
    id: 6,
    branchId: 1,
    customerId: 20,
    ownerId: 10,
    contactName: "عميل محول",
  } as LeadRow;
  render(
    <OpportunityFormDialog open lead={lead} options={options} {...props} />,
  );
  change("opp-value", "250");
  change("opp-close", "2026-11-25");
  save();
  expect(props.onSubmit).not.toHaveBeenCalled();
  change("opp-reason", "مؤهل للشراء");
  save();
  expect(props.onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({
      branchId: 1,
      customerId: 20,
      ownerId: 10,
      reason: "مؤهل للشراء",
      title: "فرصة — عميل محول",
    }),
  );
});

it("keeps the winning transition gated by its invoice and reason", () => {
  const submit = vi.fn();
  render(
    <PipelineTransitionDialog
      open
      kind="OPPORTUNITY"
      branchId={1}
      opportunityStage="WON"
      customerId={20}
      options={{
        ...options,
        invoices: [
          {
            id: 90,
            invoiceNumber: "INV90",
            customerId: 20,
            total: "100",
            status: "PAID",
          },
        ],
      }}
      pending={false}
      onOpenChange={vi.fn()}
      onSubmit={submit}
    />,
  );
  change("transition-reason", "اكتمال البيع");
  const button = () =>
    Array.from(container.querySelectorAll("button")).find(
      (node) => node.textContent === "تأكيد الانتقال",
    )!;
  act(() => button().click());
  expect(submit).not.toHaveBeenCalled();
  change("transition-invoice", "90");
  act(() => button().click());
  expect(submit).toHaveBeenCalledWith({
    reason: "اكتمال البيع",
    invoiceId: 90,
  });
});

it("waits for invoices from the opportunity branch before allowing a winning transition", () => {
  const props = {
    open: true,
    kind: "OPPORTUNITY" as const,
    opportunityStage: "WON" as const,
    branchId: 2,
    customerId: 20,
    pending: false,
    onOpenChange: vi.fn(),
    onSubmit: vi.fn(),
  };
  render(
    <PipelineTransitionDialog
      {...props}
      options={{
        ...options,
        invoices: [
          {
            id: 90,
            invoiceNumber: "OTHER-BRANCH",
            customerId: 20,
            total: "100",
            status: "PAID",
          },
        ],
      }}
    />,
  );
  expect(
    container.querySelector<HTMLSelectElement>("#transition-invoice")!.disabled,
  ).toBe(true);
  expect(container.textContent).not.toContain("OTHER-BRANCH");
  render(
    <PipelineTransitionDialog
      {...props}
      options={{
        ...options,
        selectedBranchId: 2,
        invoices: [
          {
            id: 91,
            invoiceNumber: "CORRECT-BRANCH",
            customerId: 20,
            total: "100",
            status: "PAID",
          },
        ],
      }}
    />,
  );
  change("transition-invoice", "91");
  change("transition-reason", "بيع موثق");
  act(() =>
    Array.from(container.querySelectorAll("button"))
      .find((node) => node.textContent === "تأكيد الانتقال")!
      .click(),
  );
  expect(props.onSubmit).toHaveBeenCalledWith({
    invoiceId: 91,
    reason: "بيع موثق",
  });
});

it("retains history error recovery after splitting the dialogs", () => {
  const retry = vi.fn();
  render(
    <PipelineHistoryDialog
      open
      title="الفرصة"
      loading={false}
      error
      onRetry={retry}
      events={[]}
      onOpenChange={vi.fn()}
    />,
  );
  act(() => container.querySelector("button")!.click());
  expect(retry).toHaveBeenCalledOnce();
});

it("offers retry when loading invoices for the opportunity branch fails", () => {
  const retry = vi.fn();
  render(
    <PipelineTransitionDialog
      open
      kind="OPPORTUNITY"
      branchId={2}
      opportunityStage="WON"
      options={options}
      optionsError
      onRetryOptions={retry}
      pending={false}
      onOpenChange={vi.fn()}
      onSubmit={vi.fn()}
    />,
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "تعذر تحميل",
  );
  act(() =>
    Array.from(container.querySelectorAll("button"))
      .find((node) => node.textContent === "إعادة المحاولة")!
      .click(),
  );
  expect(retry).toHaveBeenCalledOnce();
});

it("does not treat cached matching-branch invoices as fresh after a query error", () => {
  render(
    <PipelineTransitionDialog
      open
      kind="OPPORTUNITY"
      branchId={1}
      opportunityStage="WON"
      options={{
        ...options,
        invoices: [
          {
            id: 90,
            invoiceNumber: "CACHED90",
            customerId: 20,
            total: "100",
            status: "PAID",
          },
        ],
      }}
      optionsError
      onRetryOptions={vi.fn()}
      pending={false}
      onOpenChange={vi.fn()}
      onSubmit={vi.fn()}
    />,
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "تعذر تحميل",
  );
  expect(
    container.querySelector<HTMLSelectElement>("#transition-invoice")!.disabled,
  ).toBe(true);
  expect(container.textContent).not.toContain("CACHED90");
});

it.each([
  ["2026-11-25", "2026-11-25"],
  ["2026-11-25T00:00:00Z", "2026-11-25"],
  ["invalid", ""],
  [new Date(NaN), ""],
])(
  "preserves calendar dates and rejects invalid date inputs %s",
  (date, expected) => {
    expect(dateOnly(date)).toBe(expected);
  },
);

it("adopts late options without erasing text entered while loading", () => {
  const props = callbacks();
  render(
    <LeadFormDialog
      open
      options={{ ...options, selectedBranchId: null, branches: [], owners: [] }}
      {...props}
    />,
  );
  change("lead-name", "قبل التحميل");
  render(<LeadFormDialog open options={options} {...props} />);
  expect(value("lead-name")).toBe("قبل التحميل");
  expect(value("lead-branch")).toBe("1");
});

it("fills an existing opportunity date from a Date value", () => {
  const initial = {
    id: 44,
    branchId: 1,
    customerId: 20,
    title: "فرصة قائمة",
    expectedValue: "120",
    probability: "25",
    expectedCloseDate: new Date("2026-11-25T00:00:00Z"),
  } as OpportunityRow;
  render(
    <OpportunityFormDialog
      open
      initial={initial}
      options={options}
      {...callbacks()}
    />,
  );
  expect(value("opp-close")).toBe("2026-11-25");
});

it("preserves an opportunity draft while branch options refresh", () => {
  const props = callbacks();
  render(<OpportunityFormDialog open options={options} {...props} />);
  change("opp-title", "فرصة مكتوبة");
  change("opp-branch", "2");
  render(
    <OpportunityFormDialog
      open
      options={{ ...options, selectedBranchId: 2 }}
      {...props}
    />,
  );
  expect(value("opp-title")).toBe("فرصة مكتوبة");
  expect(value("opp-branch")).toBe("2");
});

it("clears a quotation that belongs to the previous customer before saving", () => {
  const props = callbacks();
  render(<OpportunityFormDialog open options={options} {...props} />);
  change("opp-title", "فرصة");
  change("opp-customer", "20");
  change("opp-quote", "30");
  change("opp-value", "100");
  change("opp-close", "2026-11-25");
  change("opp-customer", "21");
  save();
  expect(props.onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ customerId: 21, quotationId: null }),
  );
});
