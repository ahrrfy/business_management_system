import { beforeEach, describe, expect, it, vi } from "vitest";
import { printExpenseRows } from "@/lib/expenseListPrint";
const state = vi.hoisted(() => ({ print: vi.fn(() => true) }));
vi.mock("@/lib/printing/reportDoc", () => ({ printReportDoc: state.print }));
beforeEach(() => state.print.mockClear());
describe("Expenses filtered report metadata", () => {
  it.each([
    ["DESCRIPTION", "بلا شرح"],
    ["PAYEE", "بلا مستفيد"],
    ["SOURCE", "مصدر أو إيصال غير متطابق"],
    ["DRAWER", "درج أو وردية ناقصة"],
  ] as const)(
    "prints the effective %s restriction and gives focus precedence over audit-only",
    (auditFocus, label) => {
      printExpenseRows([], "الفرع: الرئيسي", { auditFocus, auditOnly: true });
      expect(state.print).toHaveBeenCalledWith(
        expect.objectContaining({
          headerExtra: [
            { label: "الفلاتر", value: `الفرع: الرئيسي · استثناء: ${label}` },
          ],
        }),
      );
    },
  );
  it("prints the audit-only restriction when no focus is selected", () => {
    printExpenseRows([], "", { auditFocus: null, auditOnly: true });
    expect(state.print).toHaveBeenCalledWith(
      expect.objectContaining({
        headerExtra: [{ label: "الفلاتر", value: "يحتاج تدقيقاً" }],
      }),
    );
  });
  it("does not invent a restriction for the unfiltered report", () => {
    printExpenseRows([], "", { auditFocus: null, auditOnly: false });
    expect(state.print).toHaveBeenCalledWith(
      expect.objectContaining({ headerExtra: [] }),
    );
  });
});
