// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExpenseTracePanel } from "./ExpenseTracePanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  meUseQuery: vi.fn(),
  traceUseQuery: vi.fn(),
  traceDetails: vi.fn(),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    auth: { me: { useQuery: mocks.meUseQuery } },
    expenses: {
      trace: { useQuery: mocks.traceUseQuery },
    },
  },
}));

vi.mock("@/components/financial/FinancialTraceDetails", () => ({
  FinancialTraceDetails: (props: unknown) => {
    mocks.traceDetails(props);
    return <div data-testid="financial-trace" />;
  },
}));

describe("ExpenseTracePanel — فصل المنشئ عن منفذ الحركة", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    mocks.traceDetails.mockClear();
    mocks.meUseQuery.mockReturnValue({ data: { role: "manager" } });
    mocks.traceUseQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        expense: {
          id: 91,
          branchName: "الفرع الرئيسي",
          status: "ACTIVE",
          approvalStatus: "APPROVED",
          paymentMethod: "CASH",
          source: "CASH",
          cashBucket: "TREASURY",
          amount: "75000.00",
          category: "OTHER",
          description: "مصروف تدقيقي",
          expenseDate: "2026-10-03",
          createdAt: "2026-10-03T09:00:00.000Z",
          createdBy: 2,
          createdByName: "منشئ الطلب",
          executedBy: 3,
          executedByName: "منفذ الدفع",
          executedAt: "2026-10-03T11:00:00.000Z",
          approvedByName: "المعتمد",
          receiptId: 701,
          receiptStatus: "COMPLETED",
          integrityWarnings: [],
        },
        obligationEvents: [],
        ledgerEntries: [],
        reversalReceipts: [],
        auditTrail: [],
        correctionRequests: [],
      },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("يمرر اسم المنشئ للتسجيل واسم executedByName للتنفيذ دون خلطهما", async () => {
    await act(async () => root.render(<ExpenseTracePanel expenseId={91} />));

    const props = mocks.traceDetails.mock.calls.at(-1)?.[0] as {
      parties: {
        recordedBy: { name: string; id: number };
        executedBy: { name: string; id: number; at?: string };
      };
    };
    expect(props.parties.recordedBy).toMatchObject({
      name: "منشئ الطلب",
      id: 2,
    });
    expect(props.parties.executedBy).toMatchObject({
      name: "منفذ الدفع",
      id: 3,
    });
  });

  it("يمنع القراءة والعرض عند سحب تفويض التتبع ولو بقيت نتيجة مخزنة", async () => {
    mocks.meUseQuery.mockReturnValue({ data: { role: "manager", operationPolicyEnabled: true, resolvedOperationPolicy: { version: 1, grants: { "operation.expenses.trace": false } } } });
    await act(async () => root.render(<ExpenseTracePanel expenseId={91} />));
    expect(mocks.traceUseQuery).toHaveBeenLastCalledWith({ expenseId: 91 }, { enabled: false });
    expect(mocks.traceDetails).not.toHaveBeenCalled();
    expect(host.textContent).toBe("");
  });

  it("يعرض دليل تسوية الشحن النقدي بعد انتقال المصروف من الاستحقاق إلى الدفع", async () => {
    const current = mocks.traceUseQuery.getMockImplementation()!();
    current.data.obligationEvents = [{ id: 9, eventType: "PAYMENT_SETTLED", accountingEntryId: 42,
      receiptId: 701, amount: "75000.00", createdAt: "2026-10-03T11:00:00.000Z" }];
    mocks.traceUseQuery.mockReturnValue(current);
    await act(async () => root.render(<ExpenseTracePanel expenseId={91} />));
    const props = mocks.traceDetails.mock.calls.at(-1)?.[0] as { linkChain: { label: string; value: string }[] };
    expect(props.linkChain).toContainEqual(expect.objectContaining({ label: "التسوية الفعلية", value: "JE#42" }));
  });
});
