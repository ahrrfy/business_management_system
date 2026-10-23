import { describe, expect, it } from "vitest";
import {
  filterOperationalRows,
  mergeDisplayedSelection,
  manifestCanPrint,
  previewStatementImport,
  readStatementImportFile,
} from "./deliveryOperations";

const candidates = [
  {
    id: 1,
    consignmentNumber: "CN-1",
    externalTrackingRef: "00111",
    codAmount: "100.10",
    collectedAmount: "0",
    customerName: "أحمد السلامي",
    recipientPhone: "07801234567",
  },
  {
    id: 2,
    consignmentNumber: "CN-2",
    externalTrackingRef: "222",
    codAmount: "20",
    collectedAmount: "0",
    customerName: "محمد",
    recipientPhone: "07701234567",
  },
];
describe("delivery operational scope", () => {
  it("requires every Arabic search term and matches Iraqi phone formats", () => {
    expect(
      filterOperationalRows(candidates, "احمد سلامي 9647801234567").map(
        (r) => r.id,
      ),
    ).toEqual([1]);
    expect(filterOperationalRows(candidates, "احمد محمد")).toEqual([]);
    expect(filterOperationalRows(candidates, "CN-2").map((r) => r.id)).toEqual([
      2,
    ]);
  });
  it("selects only displayed rows and preserves hidden selections and manual amounts", () => {
    const current = {
      1: { selected: true, amount: "0.10" },
      3: { selected: true, amount: "55.99" },
    };
    expect(
      mergeDisplayedSelection(current, [{ id: 2 }], () => ({
        selected: true,
        amount: "20",
      })),
    ).toEqual({ ...current, 2: { selected: true, amount: "20" } });
    expect(
      mergeDisplayedSelection(current, [{ id: 1 }], () => ({
        selected: false,
        amount: "0",
      }))[3],
    ).toEqual(current[3]);
  });
  it("blocks signature-ready printing on page failure, active fetch, empty or incomplete explicit selection", () => {
    const complete = {
      isLoading: false,
      isFetching: false,
      isError: false,
      hasNextPage: false,
      availableIds: [1, 2],
    };
    expect(manifestCanPrint(complete)).toBe(true);
    for (const patch of [
      { isError: true },
      { isFetching: true },
      { hasNextPage: true },
      { requestedIds: [] },
      { requestedIds: [1, 3] },
    ])
      expect(manifestCanPrint({ ...complete, ...patch })).toBe(false);
    expect(manifestCanPrint({ ...complete, requestedIds: [2] })).toBe(true);
  });
});
describe("company statement preview", () => {
  const preview = (
    rows: Parameters<typeof previewStatementImport>[0],
    selected = new Set<number>(),
  ) => previewStatementImport(rows, candidates, 7, selected);
  it("resolves exact IDs/tracking, preserves leading zeros, zero proof and exact Decimal amounts", () => {
    expect(
      preview([{ externalTrackingRef: "00111", collectedAmount: "٠٫١٠" }])[0],
    ).toMatchObject({
      verdict: "READY",
      candidate: { id: 1 },
      collectedAmount: "0.10",
    });
    expect(
      preview([{ consignmentId: 2, collectedAmount: "0" }])[0],
    ).toMatchObject({ verdict: "READY", collectedAmount: "0.00" });
    expect(
      preview([{ externalTrackingRef: "111", collectedAmount: "1" }])[0]
        .verdict,
    ).toBe("UNMATCHED");
    expect(preview([{ consignmentId: 1, collectedAmount: ".5" }])[0].collectedAmount).toBe("0.50");
  });
  it("never interprets file references as scanner HID keys or AIM barcode prefixes", () => {
    for (const tracking of ["ش", "]C1123", "00123"]) {
      expect(
        previewStatementImport(
          [{ externalTrackingRef: tracking, collectedAmount: "1" }],
          [
            {
              ...candidates[0],
              externalTrackingRef: tracking === "ش" ? "a" : "123",
            },
          ],
          7,
          new Set(),
        )[0].verdict,
      ).toBe("UNMATCHED");
    }
    expect(
      preview([{ externalTrackingRef: 111, collectedAmount: "1" }])[0].verdict,
    ).toBe("INVALID_REFERENCE");
  });
  it("discloses wrong-party, missing, conflicting, ambiguous and already selected identities", () => {
    expect(
      preview([{ consignmentId: 1, partyId: 8, collectedAmount: "1" }])[0]
        .verdict,
    ).toBe("WRONG_PARTY");
    expect(
      preview([{ consignmentId: 9, collectedAmount: "1" }])[0].verdict,
    ).toBe("UNMATCHED");
    expect(
      preview([
        { consignmentId: 1, externalTrackingRef: "222", collectedAmount: "1" },
      ])[0].verdict,
    ).toBe("IDENTIFIER_CONFLICT");
    expect(
      preview([{ consignmentId: 1, collectedAmount: "1" }], new Set([1]))[0]
        .verdict,
    ).toBe("ALREADY_SELECTED");
    expect(
      previewStatementImport(
        [{ externalTrackingRef: "00111", collectedAmount: "1" }],
        [...candidates, { ...candidates[0], id: 3 }],
        7,
        new Set(),
      )[0].verdict,
    ).toBe("AMBIGUOUS");
  });
  it("rejects all duplicate rows instead of silently choosing the first amount", () => {
    expect(
      preview([
        { consignmentId: 1, collectedAmount: "0.10" },
        { externalTrackingRef: "00111", collectedAmount: "1.00" },
      ]).map((r) => r.verdict),
    ).toEqual(["DUPLICATE", "DUPLICATE"]);
  });
  it("allocates one tracking total across shipment balances without duplicating money", () => {
    const shipment = candidates.map((row) => ({
      ...row,
      shipmentLeaderConsignmentId: 1,
      shipmentInvoiceCount: 2,
      externalTrackingRef: row.id === 1 ? "00111" : null,
    }));
    const result = previewStatementImport([{ externalTrackingRef: "00111", collectedAmount: "120.10" }], shipment, 7, new Set())[0];
    expect(result).toMatchObject({ verdict: "READY", collectedAmount: "120.10", allocations: [
      { consignmentId: 1, collectedAmount: "100.10" },
      { consignmentId: 2, collectedAmount: "20.00" },
    ] });
    expect(previewStatementImport([{ externalTrackingRef: "00111", collectedAmount: "120.11" }], shipment, 7, new Set())[0].verdict).toBe("EXCESS_AMOUNT");
    expect(previewStatementImport([{ externalTrackingRef: "00111", collectedAmount: "100.11" }], shipment, 7, new Set())[0]).toMatchObject({
      verdict: "READY", allocations: [{ consignmentId: 1, collectedAmount: "100.10" }, { consignmentId: 2, collectedAmount: "0.01" }],
    });
    expect(previewStatementImport([{ externalTrackingRef: "00111", collectedAmount: "120.10" }], shipment, 7, new Set([2]))[0].verdict).toBe("ALREADY_SELECTED");
    expect(previewStatementImport([{ externalTrackingRef: "00111", collectedAmount: "120.10" }], shipment.slice(0, 1), 7, new Set())[0].verdict).toBe("INCOMPLETE_SHIPMENT");
    expect(previewStatementImport([
      { externalTrackingRef: "00111", collectedAmount: "120.10" },
      { consignmentId: 2, collectedAmount: "20.00" },
    ], shipment, 7, new Set()).map((row) => row.verdict)).toEqual(["DUPLICATE", "DUPLICATE"]);
  });
  it("keeps explicit consignment amounts per invoice when a file lists shipment members separately", () => {
    const shipment = candidates.map((row) => ({ ...row, shipmentLeaderConsignmentId: 1, shipmentInvoiceCount: 2 }));
    expect(previewStatementImport([{ consignmentId: 1, collectedAmount: "100.10" }, { consignmentId: 2, collectedAmount: "20.00" }], shipment, 7, new Set()).map((row) => row.verdict)).toEqual(["READY", "READY"]);
  });
  it("rejects malformed money, excess precision, unsafe IDs and oversized money without coercion", () => {
    for (const value of [
      "",
      "-1",
      "NaN",
      "Infinity",
      "1e3",
      "1,000",
      "1.001",
      "text10",
      "10000000000000",
    ])
      expect(
        preview([{ consignmentId: 1, collectedAmount: value }])[0].verdict,
      ).toBe("INVALID_AMOUNT");
    expect(
      preview([{ consignmentId: "1x", collectedAmount: "1" }])[0].verdict,
    ).toBe("INVALID_ID");
    expect(
      preview([{ consignmentId: 1, collectedAmount: "100.11" }])[0].verdict,
    ).toBe("EXCESS_AMOUNT");
  });
});

describe("strict company statement file reader", () => {
  const csv = (text: string) =>
    ({
      name: "statement.csv",
      arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    }) as File;
  it("keeps CSV tracking zeros and physical row numbers, without executing selections", async () => {
    const sheet = await readStatementImportFile(
      csv("externalTrackingRef,collectedAmount\n\n00111,0.10\n"),
    );
    expect(sheet).toEqual({
      rows: [{ externalTrackingRef: "00111", collectedAmount: "0.10" }],
      rowNumbers: [3],
    });
  });
  it("rejects unmatched quote, extra cells, missing cells and duplicate header corruption", async () => {
    for (const source of [
      'externalTrackingRef,collectedAmount\n123,"1',
      "externalTrackingRef,collectedAmount\n123,1,999",
      "externalTrackingRef,collectedAmount\n123",
      "externalTrackingRef,collectedAmount,collectedAmount\n123,1,2",
    ]) {
      await expect(readStatementImportFile(csv(source))).rejects.toThrow();
    }
  });
  it("preserves XLSX textual tracking and refuses numeric tracking despite zero-padded display", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook(),
      sheet = workbook.addWorksheet("Statement");
    sheet.addRow(["externalTrackingRef", "collectedAmount"]);
    sheet.addRow(["00111", 0.1]);
    sheet.addRow([111, 1]);
    sheet.getCell("A3").numFmt = "00000";
    const bytes = await workbook.xlsx.writeBuffer();
    const parsed = await readStatementImportFile({
      name: "statement.xlsx",
      arrayBuffer: async () => bytes,
    } as File);
    expect(
      previewStatementImport(parsed.rows, candidates, 7, new Set()).map(
        (row) => row.verdict,
      ),
    ).toEqual(["READY", "INVALID_REFERENCE"]);
  });
  it("rejects XLSX formula identities even when a cached result could match", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook(),
      sheet = workbook.addWorksheet("Statement");
    sheet.addRow(["externalTrackingRef", "collectedAmount"]);
    sheet.addRow([{ formula: '"00111"', result: "00111" }, "0.10"]);
    const bytes = await workbook.xlsx.writeBuffer();
    await expect(
      readStatementImportFile({
        name: "statement.xlsx",
        arrayBuffer: async () => bytes,
      } as File),
    ).rejects.toThrow();
  });
});
