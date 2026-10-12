import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../db";
import { deliveryReportDates } from "../delivery/reportDates";
import {
  getDeliveryPartyStatement,
  listConsignmentsForParty,
  listPartyRemittances,
} from "../delivery/queries";

vi.mock("../../db", () => ({ getDb: vi.fn(() => null) }));

const readers = [
  [
    "consignments",
    (from?: string, to?: string) =>
      listConsignmentsForParty(1, false, { from, to }),
  ],
  [
    "remittances",
    (from?: string, to?: string) => listPartyRemittances(1, { from, to }),
  ],
  [
    "statement",
    (from?: string, to?: string) => getDeliveryPartyStatement(1, from, to),
  ],
] as const;

describe("delivery report dates", () => {
  beforeEach(() => vi.clearAllMocks());

  for (const [name, read] of readers) {
    describe(name, () => {
      it("rejects a reversed reporting period before accessing the database", async () => {
        await expect(read("2026-10-13", "2026-10-01")).rejects.toMatchObject({
          code: "BAD_REQUEST",
          message: expect.stringContaining("تاريخ النهاية يسبق تاريخ البداية"),
        });
        expect(getDb).not.toHaveBeenCalled();
      });

      it.each([
        ["2026-02-29", undefined],
        [undefined, "2026-02-31"],
        ["2026-13-01", "2026-10-01"],
        ["2026-1-01", undefined],
        [undefined, "invalid"],
      ])(
        "rejects invalid calendar dates %s / %s without querying",
        async (from, to) => {
          await expect(read(from, to)).rejects.toMatchObject({
            code: "BAD_REQUEST",
            message: expect.stringContaining("غير صالح"),
          });
          expect(getDb).not.toHaveBeenCalled();
        },
      );

      it.each([
        ["2028-02-29", "2028-02-29"],
        ["2026-10-01", "2026-10-01"],
        ["2026-10-01", "2026-10-13"],
        ["2026-10-01", undefined],
        [undefined, "2026-10-13"],
        [undefined, undefined],
      ])(
        "accepts valid same-day, leap-day and open-ended periods %s / %s",
        async (from, to) => {
          await expect(read(from, to)).resolves.toBeDefined();
          expect(getDb).toHaveBeenCalledOnce();
        },
      );
    });
  }

  it("uses midnight UTC and an exclusive next-day boundary across leap-day", () => {
    const dates = deliveryReportDates("2028-02-29", "2028-02-29");
    expect(dates.start?.toISOString()).toBe("2028-02-29T00:00:00.000Z");
    expect(dates.endExclusive?.toISOString()).toBe("2028-03-01T00:00:00.000Z");
  });

  it("keeps omitted bounds open and advances the last day of the year correctly", () => {
    expect(deliveryReportDates()).toEqual({
      start: undefined,
      endExclusive: undefined,
    });
    expect(
      deliveryReportDates(undefined, "2026-12-31").endExclusive?.toISOString(),
    ).toBe("2027-01-01T00:00:00.000Z");
  });
});
