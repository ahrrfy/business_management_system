import { describe, expect, it } from "vitest";
import {
  buildDeliveryStatement,
  deliveryTotals,
  fetchAllDeliveryPages,
  withDeliveryExportScope,
  buildDeliveryCsv,
  requireDeliverySelection,
  deliveryStatementReport,
} from "./deliveryWorkspace";

describe("delivery company export and statements", () => {
  it("exports fresh opening and closing totals even when a period has no movements", () => {
    const report = deliveryStatementReport({
      entries: [],
      openingBalance: "250.10",
      closingBalance: "250.10",
      debitTotal: "0.00",
      creditTotal: "0.00",
    });
    expect(report.rows).toEqual([]);
    expect(report.totals).toEqual({
      "افتتاح الفترة": "250.10",
      "مدين الفترة": "0.00",
      "دائن الفترة": "0.00",
      "ختام الفترة": "250.10",
    });
  });
  it("refuses to silently drop a selected row that left the active state", () => {
    expect(() =>
      requireDeliverySelection([{ id: 1 }], new Set([1, 2]), (row) => row.id),
    ).toThrow("لم يُصدر التقرير");
    expect(
      requireDeliverySelection(
        [{ id: 2 }, { id: 1 }],
        new Set([1]),
        (row) => row.id,
      ),
    ).toEqual([{ id: 1 }]);
  });
  it("writes CSV text cells with leading zeros and neutralizes formulas", () => {
    const csv = buildDeliveryCsv(
      [
        {
          phone: "07701234567",
          tracking: "000012",
          name: '=HYPERLINK("unsafe")',
          due: "-1.20",
        },
      ],
      [
        { key: "phone", header: "الهاتف", text: true },
        { key: "tracking", header: "التتبع", text: true },
        { key: "name", header: "الاسم" },
        { key: "due", header: "المبلغ" },
      ],
      [["العدد", "1"]],
    );
    expect(csv).toContain('"\'07701234567","\'000012"');
    expect(csv).toContain('"\'=HYPERLINK(""unsafe"")"');
    expect(csv).toContain('"-1.20"');
  });
  it("requests every cursor page beyond the visible first page", async () => {
    const calls: Array<number | undefined> = [];
    const rows = await fetchAllDeliveryPages(async (cursor) => {
      calls.push(cursor);
      return cursor == null
        ? { rows: [3, 2], hasMore: true, nextCursor: 2 }
        : { rows: [1], hasMore: false, nextCursor: null };
    });
    expect(rows).toEqual([3, 2, 1]);
    expect(calls).toEqual([undefined, 2]);
  });
  it("refuses truncated export if the server repeats or omits the next cursor", async () => {
    await expect(
      fetchAllDeliveryPages(async () => ({
        rows: [1],
        hasMore: true,
        nextCursor: 1,
      })),
    ).rejects.toThrow("لم يُحفظ تقرير ناقص");
    await expect(
      fetchAllDeliveryPages(async () => ({
        rows: [1],
        hasMore: true,
        nextCursor: null,
      })),
    ).rejects.toThrow("لم يُحفظ تقرير ناقص");
  });
  it("keeps pre-period custody and ignores fee disclosures in running balance", () => {
    const statement = buildDeliveryStatement(
      [
        {
          id: 1,
          type: "DELIVERY_DISPATCH",
          amount: "0.20",
          entryDate: "2026-10-12",
        },
        {
          id: 2,
          type: "DELIVERY_FEE",
          amount: "10.00",
          entryDate: "2026-10-12",
        },
        {
          id: 3,
          type: "DELIVERY_REMIT",
          amount: "20.10",
          entryDate: "2026-10-12",
        },
        {
          id: 4,
          type: "DELIVERY_WRITEOFF",
          amount: "-5.00",
          entryDate: "2026-10-12",
        },
      ],
      "100.10",
    );
    expect(statement.rows.map((row) => row.carry)).toEqual([
      "100.30",
      "100.30",
      "80.20",
      "85.20",
    ]);
    expect(statement.rows[1].balance).toBeNull();
    expect(statement.rows[3].debit).toBe("5.00");
    expect(statement.closingBalance).toBe("85.20");
  });
  it("preserves exact decimals, telephone and tracking text with CSV scope metadata", () => {
    const rows = [
      { due: "0.10", phone: "07701234567", tracking: "000012" },
      { due: "0.20", phone: "+9647701234567", tracking: "A-002" },
    ];
    const totals = deliveryTotals(rows, ["due"]);
    expect(totals.due).toBe("0.30");
    const exported = withDeliveryExportScope(
      rows,
      {
        company: "شركة",
        branch: "الفرع #2",
        filters: "بالطريق",
        scope: "كل النتائج",
      },
      totals,
    );
    expect(exported[0].phone).toBe("07701234567");
    expect(exported[0].tracking).toBe("000012");
    expect(exported[0].exportCount).toBe("2");
    expect(exported[0].exportTotals).toBe("due: 0.30");
    expect(exported[0].exportBranch).toBe("الفرع #2");
  });
});
