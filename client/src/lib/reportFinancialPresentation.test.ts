import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  inventoryValuationDescription,
  monthlyAttendanceExportRows,
} from "./reportFinancialPresentation";

describe("financial report presentation contracts", () => {
  it("keeps the saved inventory source distinct from a live historical estimate", () => {
    expect(
      inventoryValuationDescription({
        source: "SNAPSHOT",
        cutoffDate: "2026-09-30",
      }),
    ).toBe("لقطة رسمية بتاريخ 2026-09-30");
    expect(
      inventoryValuationDescription({
        source: "LIVE",
        cutoffDate: "2026-09-30",
      }),
    ).toBe("تقديريّ من المخزون الحالي — لا لقطة رسمية لتاريخ 2026-09-30");
    expect(
      inventoryValuationDescription({ source: "LIVE", cutoffDate: null }),
    ).toBe("المخزون الحالي (قراءة حيّة)");
  });

  it("writes monthly wage details as numeric Excel cells without changing service money", async () => {
    const source = [
      {
        employeeName: "أ",
        hourlyRate: "1250.50",
        basePay: "10000.25",
        overtimePay: "1500.50",
        totalDue: "11500.75",
      },
      {
        employeeName: "ب",
        hourlyRate: "2500.00",
        basePay: "5000.00",
        overtimePay: "0.00",
        totalDue: "5000.00",
      },
    ];
    const rows = monthlyAttendanceExportRows(source);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("الأجر");
    for (const row of rows)
      sheet.addRow([
        row.hourlyRate,
        row.basePay,
        row.overtimePay,
        row.totalDue,
      ]);
    const reopened = new ExcelJS.Workbook();
    await reopened.xlsx.load(await workbook.xlsx.writeBuffer());
    const saved = reopened.getWorksheet("الأجر")!;
    for (const row of [1, 2])
      for (const column of [1, 2, 3, 4]) {
        expect(saved.getCell(row, column).type).toBe(ExcelJS.ValueType.Number);
      }
    expect(rows.reduce((total, row) => total + row.totalDue, 0)).toBe(16500.75);
    expect(source[0].totalDue).toBe("11500.75");
    expect(source[1].overtimePay).toBe("0.00");
  });

  it("rejects values that would lose money precision in Excel", () => {
    expect(() =>
      monthlyAttendanceExportRows([
        {
          hourlyRate: "1.00",
          basePay: "1.00",
          overtimePay: "0.00",
          totalDue: "90071992547410.00",
        },
      ]),
    ).toThrow(/النطاق الرقمي الآمن/);
  });
});
