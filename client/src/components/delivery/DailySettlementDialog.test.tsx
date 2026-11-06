// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { SettlementPreview } from "./dailySettlement";

vi.mock("@/components/ui/dialog", () => ({
  useDialogComposition: () => ({ justEndedComposing: () => false, setComposing: vi.fn(), markCompositionEnd: vi.fn() }),
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/lib/printing/print", () => ({ preopenDocumentWindow: () => null }));
vi.mock("./printRemittanceReceipt", () => ({ printRemittanceReceipt: vi.fn() }));

import { DailySettlementDialog } from "./DailySettlementDialog";

const preview: SettlementPreview = {
  partyId: 3, branchId: 1, expectedCash: "100.00", feeDue: "0.00", deductions: "0.00", net: "100.00",
  returnsAwaitingReceipt: 0,
  lines: [{ consignmentId: 11, consignmentNumber: "CN-11", invoiceNumber: "INV-11", customerName: "عميل",
    codAmount: "100.00", collectedAmount: "0.00", remaining: "100.00", parcelStatus: "DELIVERED" }],
};

let host: HTMLDivElement | null = null;
afterEach(() => { host?.remove(); host = null; });

it("retries the exact reviewed shipment after a lost response even if the live preview changes", async () => {
  Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const onSettle = vi.fn().mockRejectedValueOnce(new Error("connection lost")).mockResolvedValueOnce({
    remittanceId: 1, remittanceNumber: "DR-1", status: "BALANCED", shortfallTotal: "0.00", receiptId: 2,
  });
  const onClose = vi.fn();
  const render = async (value: SettlementPreview) => act(async () => root.render(<DailySettlementDialog
    party={{ id: 3, name: "الجهة" }} open onOpenChange={onClose} preview={value} previewLoading={false}
    previewError={null} onRetryPreview={vi.fn()} shiftType="RECEPTION" onSettle={onSettle} />));
  await render(preview);
  expect(host.querySelector<HTMLInputElement>('[aria-label="النقد المعدود فعلاً"]')?.disabled).toBe(true);
  const button = (text: string) => Array.from(host!.querySelectorAll("button")).find((item) => item.textContent?.includes(text))!;
  await act(async () => button("إقفال").click());
  expect(onSettle).toHaveBeenCalledTimes(1);
  const original = onSettle.mock.calls[0][0];
  expect(original.expectedLines).toEqual([{ consignmentId: 11, remaining: "100.00" }]);
  expect(button("إلغاء").disabled).toBe(true);
  await render({ ...preview, lines: [{ ...preview.lines[0], consignmentId: 99 }] });
  await act(async () => button("استعادة نتيجة التوريد").click());
  expect(onSettle).toHaveBeenCalledTimes(2);
  expect(onSettle.mock.calls[1][0]).toEqual(original);
  await act(async () => root.unmount());
});
