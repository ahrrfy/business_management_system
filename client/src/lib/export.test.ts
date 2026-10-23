import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportRows } from "./export";

vi.mock("@/lib/notify", () => ({ notify: { ok: vi.fn(), err: vi.fn() } }));

let saved: Blob | undefined;
beforeEach(() => {
  saved = undefined;
  vi.stubGlobal("window", {
    showSaveFilePicker: vi.fn(async () => ({
      createWritable: async () => ({
        write: async (blob: Blob) => {
          saved = blob;
        },
        close: async () => {},
      }),
    })),
  });
});
afterEach(() => vi.unstubAllGlobals());

async function savedBlob() {
  await vi.waitFor(() => expect(saved).toBeDefined());
  if (!saved) throw new Error("Export was not saved");
  return saved;
}

describe("shared spreadsheet exports", () => {
  it("neutralizes spreadsheet formulas in text while retaining CSV quoting, Arabic and numeric negatives", async () => {
    exportRows(
      [
        { text: "=1+1", amount: -2.5 },
        { text: "+SUM(1,2)", amount: 0 },
        { text: " \t@SUM(A1)", amount: 12.25 },
        { text: "-2+3", amount: -1 },
        { text: 'سارة، اسم "مميز"\nسطر ثان', amount: 1 },
      ],
      {
        filename: "synthetic",
        format: "csv",
        columns: [
          { key: "text", header: "البيان" },
          { key: "amount", header: "المبلغ" },
        ],
      },
    );
    const blob = await savedBlob();
    expect([...new Uint8Array(await blob.arrayBuffer()).slice(0, 3)]).toEqual([
      0xef, 0xbb, 0xbf,
    ]);
    expect(await blob.text()).toBe(
      'البيان,المبلغ\r\n\'=1+1,-2.5\r\n"\'+SUM(1,2)",0\r\n\' \t@SUM(A1),12.25\r\n\'-2+3,-1\r\n"سارة، اسم ""مميز""\nسطر ثان",1',
    );
  });

  it("includes scoped report metadata and totals only when CSV report mode is requested", async () => {
    exportRows([{ name: "سارة", amount: 0.3 }], {
      filename: "synthetic",
      format: "csv",
      csvReport: true,
      title: "كشف مفلتر",
      meta: [{ label: "البحث", value: "سارة" }],
      columns: [
        { key: "name", header: "الاسم" },
        { key: "amount", header: "الرصيد" },
      ],
      totalsRow: { name: "الإجمالي", amount: 0.3 },
    });
    expect(await (await savedBlob()).text()).toBe(
      "كشف مفلتر\r\nالبحث,سارة\r\n\r\nالاسم,الرصيد\r\nسارة,0.3\r\nالإجمالي,0.3",
    );
  });

  it("keeps IQD integer formatting and USD cents in both numeric body and totals cells", async () => {
    exportRows([{ iqd: 1000, usd: 100.25 }], {
      filename: "synthetic",
      columns: [
        { key: "iqd", header: "د.ع", money: true },
        { key: "usd", header: "USD", money: true, moneyPrecision: 2 },
      ],
      totalsRow: { iqd: 1000, usd: 100.25 },
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await (await savedBlob()).arrayBuffer());
    const sheet = wb.worksheets[0];
    expect(sheet.views[0].rightToLeft).toBe(true);
    expect(sheet.getCell("A2").numFmt).toBe("#,##0");
    expect(sheet.getCell("A3").numFmt).toBe("#,##0");
    for (const address of ["B2", "B3"]) {
      expect(sheet.getCell(address).value).toBe(100.25);
      expect(sheet.getCell(address).numFmt).toBe("#,##0.00");
    }
  });
});
