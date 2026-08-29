import { describe, it, expect } from "vitest";
import {
  WORK_ORDER_EVENT_TYPES,
  WORK_ORDER_EVENT_LABEL,
  workOrderEventLabel,
  buildWorkOrderEventKey,
} from "./workOrderEventType";

describe("قاموس أحداث أمر الشغل — مصدر الحقيقة", () => {
  it("كلّ قيمة enum لها تعريب عربيّ", () => {
    for (const t of WORK_ORDER_EVENT_TYPES) {
      const label = WORK_ORDER_EVENT_LABEL[t];
      expect(label, `${t} بلا تعريب`).toBeTruthy();
      expect(label).toMatch(/[؀-ۿ]/);
    }
  });

  it("workOrderEventLabel: null/فارغ ⇒ «—»", () => {
    expect(workOrderEventLabel(null)).toBe("—");
    expect(workOrderEventLabel(undefined)).toBe("—");
    expect(workOrderEventLabel("")).toBe("—");
  });

  it("workOrderEventLabel: قيمة مجهولة ⇒ تعود كما هي", () => {
    expect(workOrderEventLabel("MYSTERY_EVENT")).toBe("MYSTERY_EVENT");
  });
});

describe("buildWorkOrderEventKey — اصطلاح المفتاح الفريد", () => {
  it("بلا seq ⇒ `wo:<id>:<type>` (للأحداث الأحاديّة)", () => {
    expect(buildWorkOrderEventKey(42, "STARTED")).toBe("wo:42:STARTED");
    expect(buildWorkOrderEventKey(1, "MARKED_READY")).toBe("wo:1:MARKED_READY");
  });

  it("مع seq رقميّ ⇒ `wo:<id>:<type>:<seq>` (للأحداث المتكرّرة)", () => {
    expect(buildWorkOrderEventKey(42, "ASSIGNED", 1)).toBe("wo:42:ASSIGNED:1");
    expect(buildWorkOrderEventKey(42, "ASSIGNED", 2)).toBe("wo:42:ASSIGNED:2");
  });

  it("مع seq نصّيّ (hash) ⇒ يعمل بلا تحويل", () => {
    expect(buildWorkOrderEventKey(42, "MATERIALS_UPDATED", "abc123")).toBe(
      "wo:42:MATERIALS_UPDATED:abc123",
    );
  });

  it("seq=0 يُقبل رقماً صريحاً لا يُلتقط بـ`!seq`", () => {
    expect(buildWorkOrderEventKey(42, "ASSIGNED", 0)).toBe("wo:42:ASSIGNED:0");
  });

  it("seq=null/undefined يُنتج المفتاح الأحاديّ", () => {
    expect(buildWorkOrderEventKey(42, "STARTED", null)).toBe("wo:42:STARTED");
    expect(buildWorkOrderEventKey(42, "STARTED", undefined)).toBe("wo:42:STARTED");
  });
});

describe("عقد الثبات (guard against drift)", () => {
  it("الأحداث الأحاديّة الأساسيّة كلّها معرَّفة", () => {
    for (const t of ["CREATED", "STARTED", "MARKED_READY", "DELIVERED", "CANCELLED"] as const) {
      expect(WORK_ORDER_EVENT_TYPES).toContain(t);
    }
  });

  it("لا قيمةَ enum بلا تعريب (منع سهو المُضيف)", () => {
    // كلّ قيمةٍ في enum يجب أن تظهر في LABEL — يفشل إن أُضيفت قيمةٌ ولم يُعرَّب.
    for (const t of WORK_ORDER_EVENT_TYPES) {
      expect(Object.keys(WORK_ORDER_EVENT_LABEL)).toContain(t);
    }
  });
});
