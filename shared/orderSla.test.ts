import { describe, it, expect } from "vitest";
import {
  WORK_ORDER_SLA_MINUTES,
  computeStateAgeMinutes,
  slaLevel,
  formatAgeShort,
  slaLevelChipClass,
} from "./orderSla";

const NOW = new Date("2026-08-28T15:00:00Z"); // مرجعٌ حتميّ لكلّ الاختبارات.

describe("computeStateAgeMinutes — عمر الحالة بالدقائق (حتميّ، بدون Date.now خفيّة)", () => {
  it("RECEIVED: يقيس من createdAt", () => {
    const r = { status: "RECEIVED", createdAt: new Date("2026-08-28T14:30:00Z") };
    expect(computeStateAgeMinutes(r, NOW)).toBe(30);
  });

  it("RECEIVED: createdAt غائب ⇒ null (لا رمي)", () => {
    expect(computeStateAgeMinutes({ status: "RECEIVED", createdAt: null }, NOW)).toBe(null);
  });

  it("IN_PROGRESS: يقيس من workStartedAt (لا createdAt)", () => {
    const r = {
      status: "IN_PROGRESS",
      createdAt: new Date("2026-08-28T10:00:00Z"),
      workStartedAt: new Date("2026-08-28T14:00:00Z"),
    };
    expect(computeStateAgeMinutes(r, NOW)).toBe(60);
  });

  it("IN_PROGRESS: workStartedAt غائب ⇒ null", () => {
    const r = {
      status: "IN_PROGRESS",
      createdAt: new Date("2026-08-28T10:00:00Z"),
      workStartedAt: null,
    };
    expect(computeStateAgeMinutes(r, NOW)).toBe(null);
  });

  it("READY: يقيس من (workStartedAt + workSeconds)", () => {
    const r = {
      status: "READY",
      createdAt: new Date("2026-08-28T10:00:00Z"),
      workStartedAt: new Date("2026-08-28T13:00:00Z"), // بدأ ٢س قبل الجاهزيّة
      workSeconds: 60 * 60, // ساعة تنفيذ ⇒ صار READY في 14:00Z ⇒ عمر READY = 60د حتى NOW
    };
    expect(computeStateAgeMinutes(r, NOW)).toBe(60);
  });

  it("READY: workSeconds كنصّ (من MySQL decimal) ⇒ يُحلَّل رقماً", () => {
    const r = {
      status: "READY",
      workStartedAt: new Date("2026-08-28T14:00:00Z"),
      workSeconds: "1800", // 30د
    };
    // صار READY في 14:30 ⇒ عمر READY = 30د
    expect(computeStateAgeMinutes(r, NOW)).toBe(30);
  });

  it("READY: أيٌّ من workStartedAt أو workSeconds غائبٌ ⇒ null", () => {
    expect(computeStateAgeMinutes({ status: "READY", workStartedAt: null, workSeconds: 60 }, NOW)).toBe(null);
    expect(computeStateAgeMinutes({ status: "READY", workStartedAt: new Date("2026-08-28T14:00:00Z"), workSeconds: null }, NOW)).toBe(null);
  });

  it("DELIVERED/CANCELLED: بلا مؤقّت (null)", () => {
    expect(computeStateAgeMinutes({ status: "DELIVERED", createdAt: new Date("2026-08-01T00:00:00Z") }, NOW)).toBe(null);
    expect(computeStateAgeMinutes({ status: "CANCELLED", createdAt: new Date("2026-08-01T00:00:00Z") }, NOW)).toBe(null);
  });

  it("عمرٌ سالب (ساعة DB متأخّرة) ⇒ يُحدَّد بصفر لا يُرجع سالباً", () => {
    const r = { status: "RECEIVED", createdAt: new Date("2026-08-28T16:00:00Z") };
    expect(computeStateAgeMinutes(r, NOW)).toBe(0);
  });
});

describe("slaLevel — تصنيف OK/WARNING/BREACHED/UNKNOWN", () => {
  it("RECEIVED: <60د = OK، 60-179د = WARNING، ≥180د = BREACHED", () => {
    expect(slaLevel("RECEIVED", 30)).toBe("OK");
    expect(slaLevel("RECEIVED", 59)).toBe("OK");
    expect(slaLevel("RECEIVED", 60)).toBe("WARNING");
    expect(slaLevel("RECEIVED", 179)).toBe("WARNING");
    expect(slaLevel("RECEIVED", 180)).toBe("BREACHED");
    expect(slaLevel("RECEIVED", 1000)).toBe("BREACHED");
  });

  it("READY: <30د = OK، 30-119د = WARNING، ≥120د = BREACHED", () => {
    expect(slaLevel("READY", 15)).toBe("OK");
    expect(slaLevel("READY", 30)).toBe("WARNING");
    expect(slaLevel("READY", 120)).toBe("BREACHED");
  });

  it("عمرٌ null ⇒ UNKNOWN (لا نُصنّف بلا بيانات)", () => {
    expect(slaLevel("RECEIVED", null)).toBe("UNKNOWN");
  });

  it("حالةٌ غير معرَّفة في SLA ⇒ UNKNOWN (لا رمي)", () => {
    expect(slaLevel("MYSTERY_STATUS", 100)).toBe("UNKNOWN");
    expect(slaLevel(null, 100)).toBe("UNKNOWN");
    expect(slaLevel("DELIVERED", 100)).toBe("UNKNOWN"); // نهائيّ ⇒ لا في القاموس
  });
});

describe("formatAgeShort — تسميةُ مدّةٍ عربية موجزة", () => {
  it("<60د ⇒ «Nد»", () => {
    expect(formatAgeShort(5)).toBe("5د");
    expect(formatAgeShort(59)).toBe("59د");
  });

  it("≥60د ⇒ «Hس» أو «Hس Mد»", () => {
    expect(formatAgeShort(60)).toBe("1س");
    expect(formatAgeShort(90)).toBe("1س 30د");
    expect(formatAgeShort(750)).toBe("12س 30د");
  });

  it("null ⇒ «—»", () => {
    expect(formatAgeShort(null)).toBe("—");
  });
});

describe("slaLevelChipClass — توكنز دلاليّة لا ألوان خام (يُلائم check:colors)", () => {
  it("كلّ مستوى يُرجع فئةً بـ--sem-* (أو muted للمجهول)", () => {
    expect(slaLevelChipClass("OK")).toContain("--sem-pos");
    expect(slaLevelChipClass("WARNING")).toContain("--sem-warn");
    expect(slaLevelChipClass("BREACHED")).toContain("--sem-neg");
    expect(slaLevelChipClass("UNKNOWN")).toContain("muted");
  });
});

describe("عقد الثبات (guard against drift)", () => {
  it("RECEIVED/IN_PROGRESS/READY كلّها مُعرَّفة في WORK_ORDER_SLA_MINUTES", () => {
    expect(WORK_ORDER_SLA_MINUTES.RECEIVED).toBeDefined();
    expect(WORK_ORDER_SLA_MINUTES.IN_PROGRESS).toBeDefined();
    expect(WORK_ORDER_SLA_MINUTES.READY).toBeDefined();
  });

  it("warnAfter < breachAfter لكلّ حالة", () => {
    for (const [status, rule] of Object.entries(WORK_ORDER_SLA_MINUTES)) {
      expect(rule.warnAfter, `${status}: warnAfter لا يقلّ عن breachAfter`).toBeLessThan(rule.breachAfter);
    }
  });
});
