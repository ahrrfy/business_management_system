// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { TRPCClientError } from "@trpc/client";
import { afterEach, expect, it, vi } from "vitest";
import type { SettlementPreview } from "./dailySettlement";

const boardApi = vi.hoisted(() => ({
  mutate: vi.fn(),
  refetch: vi.fn(),
  invalidate: vi.fn(),
  preview: null as unknown,
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ delivery: Object.fromEntries([
      "partyBoard", "listParties", "obligations", "staleParties", "inTransit", "openConsignments", "remittances", "settlementPreview",
    ].map((name) => [name, { invalidate: boardApi.invalidate }])) }),
    auth: { me: { useQuery: () => ({ data: { role: "manager", branchId: 1 } }) } },
    delivery: {
      deliveryUiFlags: { useQuery: () => ({ data: {} }) },
      partyBoard: { useQuery: () => ({ data: [], isLoading: false, isError: false, refetch: boardApi.refetch }) },
      settlementPreview: { useQuery: () => ({ data: boardApi.preview, isLoading: false, isError: false, refetch: boardApi.refetch }) },
      settleDaily: { useMutation: () => ({ mutateAsync: boardApi.mutate }) },
    },
  },
}));
vi.mock("@/lib/realtime", () => ({ useRealtimeEvent: vi.fn() }));
vi.mock("@/lib/lifecycleActionPermission", () => ({ lifecycleActionAllowed: () => true }));
vi.mock("wouter", () => ({ useLocation: () => ["/delivery", vi.fn()] }));
vi.mock("./PartyBoard", () => ({
  PartyBoard: ({ onSettleToday }: { onSettleToday?: (row: { partyId: number; partyName: string }) => void }) =>
    <button onClick={() => onSettleToday?.({ partyId: 3, partyName: "الجهة" })}>فتح التسوية</button>,
}));
vi.mock("@/lib/notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify")>()),
  notify: { ok: vi.fn(), warn: vi.fn() },
}));
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
import { PartyBoardSection } from "./PartyBoardSection";
import { notify } from "@/lib/notify";

const preview: SettlementPreview = {
  partyId: 3, branchId: 1, expectedCash: "100.00", feeDue: "0.00", deductions: "0.00", net: "100.00",
  returnsAwaitingReceipt: 0,
  lines: [{ consignmentId: 11, consignmentNumber: "CN-11", invoiceNumber: "INV-11", customerName: "عميل",
    codAmount: "100.00", collectedAmount: "0.00", remaining: "100.00", parcelStatus: "DELIVERED" }],
};

let host: HTMLDivElement | null = null;
afterEach(() => { host?.remove(); host = null; });

it("releases a definite server rejection from the board and allows a reviewed updated preview", async () => {
  Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  boardApi.preview = preview;
  boardApi.mutate.mockReset();
  boardApi.refetch.mockReset();
  boardApi.invalidate.mockReset().mockResolvedValue(undefined);
  const rejected = new TRPCClientError("خطأ في البيانات");
  Object.assign(rejected, { data: { httpStatus: 412, zodError: { fieldErrors: { expectedLines: ["تغيّرت المعاينة؛ حدّثها"] } } } });
  boardApi.mutate.mockRejectedValueOnce(rejected).mockResolvedValueOnce({
    remittanceId: 1, remittanceNumber: "DR-1", status: "BALANCED", shortfallTotal: "0.00", receiptId: 2,
  });
  await act(async () => root.render(<PartyBoardSection />));
  const button = (text: string) => Array.from(host!.querySelectorAll("button")).find((item) => item.textContent?.includes(text))!;
  await act(async () => button("فتح التسوية").click());
  await act(async () => button("إقفال").click());
  expect(host.textContent).toContain("تغيّرت المعاينة؛ حدّثها");
  expect(host.textContent).not.toContain("نتيجة التوريد غير مؤكدة");
  expect(button("إلغاء").disabled).toBe(false);
  await act(async () => button("تحديث المعاينة").click());
  expect(boardApi.refetch).toHaveBeenCalledTimes(1);
  boardApi.preview = { ...preview, expectedCash: "120.00", net: "120.00", lines: [
    { ...preview.lines[0], consignmentId: 99, codAmount: "120.00", remaining: "120.00" },
  ] };
  await act(async () => root.render(<PartyBoardSection />));
  await act(async () => button("تحديث الصافي ومراجعته").click());
  await act(async () => button("إقفال").click());
  expect(boardApi.mutate).toHaveBeenCalledTimes(2);
  expect(boardApi.mutate.mock.calls[1][0]).toMatchObject({
    branchId: 1, countedCash: "120.00", expectedLines: [{ consignmentId: 99, remaining: "120.00" }],
  });
  await act(async () => root.unmount());
});

it("keeps the original request through the board after an uncertain network failure", async () => {
  Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  boardApi.preview = preview;
  boardApi.mutate.mockReset().mockRejectedValue(new TRPCClientError("انقطع الاتصال"));
  await act(async () => root.render(<PartyBoardSection />));
  const button = (text: string) => Array.from(host!.querySelectorAll("button")).find((item) => item.textContent?.includes(text))!;
  await act(async () => button("فتح التسوية").click());
  await act(async () => button("إقفال").click());
  expect(button("إلغاء").disabled).toBe(true);
  expect(host.textContent).not.toContain("تحديث المعاينة");
  const original = boardApi.mutate.mock.calls[0][0];
  boardApi.preview = { ...preview, lines: [{ ...preview.lines[0], consignmentId: 99 }] };
  await act(async () => root.render(<PartyBoardSection />));
  await act(async () => button("استعادة نتيجة التوريد").click());
  expect(boardApi.mutate).toHaveBeenCalledTimes(2);
  expect(boardApi.mutate.mock.calls[1][0]).toEqual(original);
  await act(async () => root.unmount());
});

it("keeps a successful settlement when refreshing the board subsequently fails", async () => {
  Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  boardApi.preview = preview;
  boardApi.mutate.mockReset().mockResolvedValue({
    remittanceId: 1, remittanceNumber: "DR-1", status: "BALANCED", shortfallTotal: "0.00", receiptId: 2,
  });
  const refreshError = new TRPCClientError("تعذر تحديث اللوحة");
  Object.assign(refreshError, { data: { httpStatus: 412 } });
  boardApi.invalidate.mockReset().mockResolvedValue(undefined).mockRejectedValueOnce(refreshError);
  await act(async () => root.render(<PartyBoardSection />));
  const button = (text: string) => Array.from(host!.querySelectorAll("button")).find((item) => item.textContent?.includes(text))!;
  await act(async () => button("فتح التسوية").click());
  await act(async () => button("إقفال").click());
  expect(host.textContent).toContain("أُقفل اليوم مطابقاً");
  expect(host.textContent).not.toContain("استعادة نتيجة التوريد");
  expect(button("إغلاق").disabled).toBe(false);
  expect(boardApi.mutate).toHaveBeenCalledTimes(1);
  expect(notify.warn).toHaveBeenCalledWith("تم التوريد وتعذّر تحديث اللوحة", "أعد تحميل الصفحة لعرض الأرصدة المحدّثة.");
  await act(async () => root.unmount());
});

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
