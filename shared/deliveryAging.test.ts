/**
 * سلّم عمر الطرد — اختبارٌ نصّيّ يحرس العتبات والصيغة (نمط `workOrderDeliveryState.test.ts`).
 * الغرض: أيّ تحريكٍ للعتبات قرارٌ واعٍ ظاهرٌ في diff الاختبار، لا انجرافَ شاشةٍ صامتاً —
 * فتنبيه `delivery-stuck` والكنّاس والشاشة تقرأ كلُّها نفسَ الأرقام.
 */
import { describe, expect, it } from "vitest";
import {
  DELIVERY_AGE_CLS,
  DELIVERY_AGE_DANGER_HOURS,
  DELIVERY_AGE_ESCALATE_HOURS,
  DELIVERY_AGE_WARN_HOURS,
  deliveryAgeLevel,
  formatDeliveryAge,
} from "./deliveryAging";

describe("deliveryAging — العتبات", () => {
  it("العتبات الثلاث مثبَّتة: 24 / 48 / 72 ساعة — تغييرها يمرّ من هنا", () => {
    expect(DELIVERY_AGE_WARN_HOURS).toBe(24);
    expect(DELIVERY_AGE_DANGER_HOURS).toBe(48);
    expect(DELIVERY_AGE_ESCALATE_HOURS).toBe(72);
  });

  it("سلّم متصاعد: تحذير < خطر < تصعيد (الكنّاس لا يسبق التنبيه)", () => {
    expect(DELIVERY_AGE_WARN_HOURS).toBeLessThan(DELIVERY_AGE_DANGER_HOURS);
    expect(DELIVERY_AGE_DANGER_HOURS).toBeLessThan(DELIVERY_AGE_ESCALATE_HOURS);
  });
});

describe("deliveryAgeLevel", () => {
  it("دون 24 ساعة ⇒ ok (طبيعيّ — الطرد خرج اليوم)", () => {
    expect(deliveryAgeLevel(0)).toBe("ok");
    expect(deliveryAgeLevel(23)).toBe("ok");
  });

  it("العتبة نفسها تُشعِل الدرجة (>= لا >): 24 ⇒ warn و48 ⇒ danger", () => {
    expect(deliveryAgeLevel(24)).toBe("warn");
    expect(deliveryAgeLevel(47)).toBe("warn");
    expect(deliveryAgeLevel(48)).toBe("danger");
    expect(deliveryAgeLevel(312)).toBe("danger");
  });

  it("قيمة معطوبة (NaN/سالب) لا تُفزِع كذباً ⇒ ok", () => {
    expect(deliveryAgeLevel(Number.NaN)).toBe("ok");
    expect(deliveryAgeLevel(-5)).toBe("ok");
  });
});

describe("formatDeliveryAge — رقم لاتينيّ ووحدة عربية", () => {
  it("بالساعات حتى 48", () => {
    expect(formatDeliveryAge(0)).toBe("0 س");
    expect(formatDeliveryAge(37)).toBe("37 س");
    expect(formatDeliveryAge(48)).toBe("48 س");
  });

  it("بالأيام بعدها — بصرفٍ عربيّ صحيح (مثنّى ثم جمع قلّة ثم تمييز منصوب)", () => {
    expect(formatDeliveryAge(49)).toBe("يومان"); // floor(49/24) = 2
    expect(formatDeliveryAge(72)).toBe("3 أيام");
    expect(formatDeliveryAge(240)).toBe("10 أيام");
    expect(formatDeliveryAge(264)).toBe("11 يوماً");
    // الحالة الإنتاجية التي أطلقت الحملة: طرود جامدة ١٣ يوماً.
    expect(formatDeliveryAge(13 * 24)).toBe("13 يوماً");
  });

  it("الكسور تُطوى لأسفل والقيم المعطوبة تصير صفراً", () => {
    expect(formatDeliveryAge(37.9)).toBe("37 س");
    expect(formatDeliveryAge(-3)).toBe("0 س");
    expect(formatDeliveryAge(Number.NaN)).toBe("0 س");
  });
});

describe("DELIVERY_AGE_CLS", () => {
  it("لكل درجةٍ توكن دلاليّ (لا لون خامّ) — وتغطية كاملة بلا زيادة", () => {
    expect(Object.keys(DELIVERY_AGE_CLS).sort()).toEqual(["danger", "ok", "warn"]);
    for (const cls of Object.values(DELIVERY_AGE_CLS)) {
      expect(cls).toContain("var(--sem-");
    }
  });
});
