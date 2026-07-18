// businessDay — مصدر الحقيقة الواحد لحدود اليوم التجاريّ (UTC حتميّ). تدقيق ١٧/٧، مخاطرة جهازية #٧.
import { describe, expect, it } from "vitest";
import { utcDayStart, utcNextDayStart, utcDayRange, todayUtcDate, baghdadToday, parseBusinessYmd } from "../businessDay";
import { localDayStart, localNextDayStart } from "../dateRange";

describe("businessDay — حدود UTC حتمية", () => {
  it("utcDayStart = منتصف ليل UTC", () => {
    expect(utcDayStart("2026-07-17").toISOString()).toBe("2026-07-17T00:00:00.000Z");
    expect(utcDayStart("2026-01-01").toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("utcNextDayStart = منتصف ليل اليوم التالي UTC (يطبّع نهاية الشهر/السنة)", () => {
    expect(utcNextDayStart("2026-07-17").toISOString()).toBe("2026-07-18T00:00:00.000Z");
    expect(utcNextDayStart("2026-07-31").toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(utcNextDayStart("2026-12-31").toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(utcNextDayStart("2024-02-29").toISOString()).toBe("2024-03-01T00:00:00.000Z");
  });

  it("utcDayRange نصف مفتوح [from, to+يوم)", () => {
    const { start, endExclusive } = utcDayRange("2026-07-01", "2026-07-31");
    expect(start.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(endExclusive.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("يرفض الصيغة/التاريخ غير الصالح", () => {
    expect(() => parseBusinessYmd("2026-13-01")).toThrow();
    expect(() => parseBusinessYmd("2026-02-31")).toThrow();
    expect(() => parseBusinessYmd("2026-7-1")).toThrow();
    expect(() => parseBusinessYmd("bad")).toThrow();
  });

  it("dateRange (localDayStart/localNextDayStart) يفوّض لـbusinessDay — نفس الناتج بالضبط", () => {
    for (const ymd of ["2026-01-10", "2026-07-17", "2026-12-31"]) {
      expect(localDayStart(ymd).getTime()).toBe(utcDayStart(ymd).getTime());
      expect(localNextDayStart(ymd).getTime()).toBe(utcNextDayStart(ymd).getTime());
    }
  });

  it("todayUtcDate صيغة YYYY-MM-DD، وbaghdadToday قد يسبق UTC بيوم قرب منتصف الليل", () => {
    expect(todayUtcDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(baghdadToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // بغداد (+03:00) ≥ يوم UTC دائماً (لا يسبقه أبداً).
    expect(baghdadToday() >= todayUtcDate()).toBe(true);
  });
});
