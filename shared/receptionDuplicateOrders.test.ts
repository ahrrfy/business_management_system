import { describe, expect, it } from "vitest";
import {
  compareReceptionDuplicateContents as compare,
  type ResolvedDuplicateLine,
} from "./receptionDuplicateOrders";

const goods = (
  variantId: number,
  quantity = "1",
  extra: Partial<ResolvedDuplicateLine> = {},
): ResolvedDuplicateLine => ({
  variantId,
  quantity,
  lineKind: "GOODS",
  ...extra,
});

describe("reception duplicate content evidence", () => {
  it("compares converted base quantities and merges repeated lines", () => {
    expect(
      compare(
        [goods(1, "1", { conversionFactor: "12" })],
        [goods(1, "6"), goods(1, "6")],
        "1500",
        "1400",
      ),
    ).toMatchObject({
      matchLevel: "EXACT",
      contentsMatch: true,
      quantityMatch: true,
      matchedLines: 1,
      currentLines: 1,
      candidateLines: 1,
      valueDifference: "100.00",
    });
  });
  it("uses historical base quantity rather than today's conversion factor", () => {
    expect(
      compare(
        [goods(1, "1", { conversionFactor: "10" })],
        [goods(1, "1", { baseQuantity: "10", conversionFactor: "12" })],
      )?.quantityMatch,
    ).toBe(true);
  });
  it("does not conflate color/size variants or accept equal invoice values alone", () => {
    expect(compare([goods(1)], [goods(2)], "1000", "1000")).toBeNull();
  });
  it("reports additions and quantity changes as partial, never exact", () => {
    expect(compare([goods(1), goods(2)], [goods(1, "2")])).toMatchObject({
      matchLevel: "PARTIAL",
      matchedLines: 1,
      currentLines: 2,
      candidateLines: 1,
      contentsMatch: false,
      quantityMatch: false,
    });
  });
  it("rejects a lone common item in a larger basket", () => {
    expect(compare([goods(1), goods(2), goods(3)], [goods(1)])).toBeNull();
  });
  it("does not match a generic free service or print product without production details", () => {
    const free = { quantity: "1", lineKind: "CUSTOM" as const, title: "طباعة" };
    expect(compare([free], [free])).toBeNull();
    expect(
      compare(
        [goods(1, "1", { isService: true })],
        [goods(1, "1", { isService: true })],
      ),
    ).toBeNull();
    expect(
      compare(
        [goods(1, "1", { lineKind: "PRINT" })],
        [goods(1, "1", { lineKind: "PRINT" })],
      ),
    ).toBeNull();
  });
  it("retains exact customer customization and material/size", () => {
    const custom = {
      quantity: "1",
      lineKind: "CUSTOM" as const,
      title: "ختم",
      customizationText: "[المقاس] A4\n[الخامة] ورق\nعمار",
    };
    expect(
      compare(
        [custom],
        [
          {
            ...custom,
            customizationText: custom.customizationText.replace("عمار", "عماد"),
          },
        ],
      ),
    ).toBeNull();
    expect(
      compare(
        [custom],
        [
          {
            ...custom,
            customizationText: custom.customizationText.replace("A4", "A3"),
          },
        ],
      ),
    ).toBeNull();
    expect(
      compare(
        [custom],
        [
          {
            ...custom,
            customizationText: `${custom.customizationText}\n[توصيل] البصرة`,
          },
        ],
      )?.matchLevel,
    ).toBe("EXACT");
  });
  it("uses production data in printSpec without matching price/priority defaults", () => {
    const custom = {
      quantity: "1",
      lineKind: "CUSTOM" as const,
      title: "ملصق",
      printSpec: JSON.stringify({
        size: "A4",
        material: "ورق",
        customizationText: "عمار",
        priority: "URGENT",
        unitPrice: "5000",
      }),
    };
    expect(
      compare(
        [custom],
        [
          {
            ...custom,
            printSpec: JSON.stringify({
              size: "A4",
              material: "ورق",
              customizationText: "عمار",
              unitPrice: "2000",
            }),
          },
        ],
      )?.matchLevel,
    ).toBe("EXACT");
    expect(
      compare([{ ...custom, printSpec: "{" }], [{ ...custom, printSpec: "{" }]),
    ).toBeNull();
    expect(
      compare(
        [
          {
            ...custom,
            printSpec: JSON.stringify({
              priority: "NORMAL",
              unitPrice: "1000",
            }),
          },
        ],
        [
          {
            ...custom,
            printSpec: JSON.stringify({
              priority: "NORMAL",
              unitPrice: "1000",
            }),
          },
        ],
      ),
    ).toBeNull();
    expect(
      compare(
        [{ ...custom, customizationText: "عمار" }],
        [
          {
            ...custom,
            customizationText: "عمار",
            printSpec: JSON.stringify({
              size: "A3",
              material: "ورق",
              customizationText: "عمار",
            }),
          },
        ],
      ),
    ).toBeNull();
  });
  it("retains storefront template identity and exact field values", () => {
    const line = goods(1, "1", {
      customizationSnapshot: {
        templateId: 10,
        values: [
          { fieldKey: "name", value: "عمار" },
          { fieldKey: "size", value: "A4" },
        ],
      },
    });
    expect(
      compare(
        [line],
        [
          {
            ...line,
            customizationSnapshot: {
              ...line.customizationSnapshot!,
              values: [...line.customizationSnapshot!.values].reverse(),
            },
          },
        ],
      )?.matchLevel,
    ).toBe("EXACT");
    expect(
      compare(
        [line],
        [
          {
            ...line,
            customizationSnapshot: {
              templateId: 10,
              values: [
                { fieldKey: "name", value: "عماد" },
                { fieldKey: "size", value: "A4" },
              ],
            },
          },
        ],
      ),
    ).toBeNull();
  });
  it("flags verified storefront fields versus reception production text for review, never exact", () => {
    const online = goods(3, "1", {
      isService: true,
      customizationSnapshot: {
        templateId: 10,
        values: [
          {
            fieldKey: "name",
            label: "الاسم",
            value: "عمار",
            displayValue: "عمار",
          },
          {
            fieldKey: "size",
            label: "المقاس",
            value: "A4",
            displayValue: "A4",
          },
          {
            fieldKey: "material",
            label: "الخامة",
            value: "paper",
            displayValue: "ورق",
          },
        ],
      },
    });
    const reception = goods(3, "1", {
      lineKind: "CUSTOM",
      customizationText: "[المقاس] A4\n[الخامة] ورق\nعمار",
    });
    expect(compare([online], [reception])).toMatchObject({
      matchLevel: "PARTIAL",
      contentsMatch: false,
      quantityMatch: true,
      matchedLines: 1,
      customizationNeedsReview: true,
    });
    expect(compare([reception], [online])).toMatchObject({
      matchLevel: "PARTIAL",
      customizationNeedsReview: true,
    });
    expect(
      compare(
        [online],
        [
          {
            ...reception,
            customizationText: "المقاس: A4\nالخامة: ورق\nالاسم: عمار",
          },
        ],
      ),
    ).toMatchObject({ customizationNeedsReview: true });
    expect(compare([online], [{ ...online }])).toMatchObject({
      matchLevel: "EXACT",
      customizationNeedsReview: false,
    });
  });
  it("rejects different, incomplete, unknown, or ambiguous cross-format specifications", () => {
    const snapshot = {
      templateId: 10,
      values: [
        {
          fieldKey: "name",
          label: "الاسم",
          value: "عمار",
          displayValue: "عمار",
        },
        { fieldKey: "size", label: "المقاس", value: "A4", displayValue: "A4" },
      ],
    };
    const online = goods(3, "1", { customizationSnapshot: snapshot });
    const reception = goods(3, "1", {
      lineKind: "CUSTOM",
      customizationText: "[المقاس] A4\nعمار",
    });
    for (const customizationText of [
      "[المقاس] A3\nعمار",
      "[المقاس] A4\nعماد",
      "[المقاس] A4",
      "[المقاس] A4\nمحمد عمار",
      "[المقاس] A4\nعمار\nللمناسبة الثانية",
      "[الخامة] A4\nعمار",
      "طباعة",
    ]) {
      expect(
        compare([online], [{ ...reception, customizationText }]),
      ).toBeNull();
    }
    expect(compare([online], [{ ...reception, variantId: 4 }])).toBeNull();
    expect(
      compare(
        [
          {
            ...online,
            customizationSnapshot: {
              ...snapshot,
              values: snapshot.values.map((v) => ({
                ...v,
                displayValue: undefined,
              })),
            },
          },
        ],
        [reception],
      ),
    ).toBeNull();
    expect(
      compare(
        [{ ...online, customizationSnapshot: { templateId: 10, values: [] } }],
        [reception],
      ),
    ).toBeNull();
    const ambiguous = {
      ...online,
      customizationSnapshot: {
        templateId: 10,
        values: [
          { fieldKey: "a", label: "أ", value: "1", displayValue: "1" },
          { fieldKey: "b", label: "ب", value: "1", displayValue: "1" },
        ],
      },
    };
    expect(
      compare([ambiguous], [{ ...reception, customizationText: "1\n1" }]),
    ).toBeNull();
    expect(
      compare(
        [
          online,
          { ...online, customizationSnapshot: { ...snapshot, templateId: 11 } },
        ],
        [reception],
      ),
    ).toBeNull();
  });
  it("aggregates units and repeated cross-format customizations without multiplying matches", () => {
    const online = goods(3, "2", {
      conversionFactor: "12",
      customizationSnapshot: {
        templateId: 10,
        values: [
          {
            fieldKey: "name",
            label: "الاسم",
            value: "عمار",
            displayValue: "عمار",
          },
        ],
      },
    });
    const reception = goods(3, "12", {
      lineKind: "CUSTOM",
      customizationText: "عمار",
    });
    expect(compare([online], [reception, reception])).toMatchObject({
      matchedLines: 1,
      currentLines: 1,
      candidateLines: 1,
      quantityMatch: true,
      matchLevel: "PARTIAL",
      customizationNeedsReview: true,
    });
  });
  it("does not equate different bundle units where factor is zero", () => {
    expect(
      compare(
        [goods(1, "1", { productUnitId: 10, conversionFactor: "0" })],
        [goods(1, "1", { productUnitId: 11, conversionFactor: "0" })],
      ),
    ).toBeNull();
  });
  it("never represents missing/invalid totals as equal", () => {
    expect(compare([goods(1)], [goods(1)])?.valueDifference).toBeNull();
    expect(
      compare([goods(1)], [goods(1)], "invalid", "10")?.valueDifference,
    ).toBeNull();
    expect(
      compare(
        [goods(1)],
        [goods(1)],
        "9007199254740993.10",
        "9007199254740993.00",
      )?.valueDifference,
    ).toBe("0.10");
  });
  it("unresolved or invalid lines cannot cause full-content claims", () => {
    expect(
      compare([goods(1), { quantity: "1" }], [goods(1)])?.contentsMatch,
    ).toBe(false);
    expect(compare([goods(1, "0")], [goods(1)])).toBeNull();
    expect(compare([goods(1, "NaN")], [goods(1)])).toBeNull();
  });
});
