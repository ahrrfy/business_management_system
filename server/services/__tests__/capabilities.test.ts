/**
 * ش٥ — نموذج القدرات الدقيقة (module:action). النموذج مؤجَّل التفعيل خلف علَم معطَّل (صفر أثر سلوكيّ
 * على الإنفاذ)، لكن منطقه النقيّ يُختبَر كاملاً هنا كي يكون جاهزاً للتفعيل الواعي لاحقاً.
 */
import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  SOD_CONFLICTS,
  capabilitiesEnabled,
  detectSodConflicts,
  hasCapability,
  resolveCapabilities,
} from "@shared/capabilities";
import { ROLE_TEMPLATES } from "@shared/permissions";

describe("resolveCapabilities — الاشتقاق والفشل المغلق", () => {
  it("FULL على الوحدة يمنح قدراتها **غير الحسّاسة** تلقائياً، لا الحسّاسة", () => {
    const caps = resolveCapabilities({ sales: "FULL" });
    expect(caps.has("sales:sell")).toBe(true);   // غير حسّاسة ⇒ مشتقّة
    expect(caps.has("sales:return")).toBe(true);
    expect(caps.has("sales:pay")).toBe(true);
    expect(caps.has("sales:void")).toBe(false);  // حسّاسة ⇒ تتطلّب منحاً صريحاً (فشلٌ مغلق)
  });

  it("READ يمنح العرض فقط لا الكتابة", () => {
    const caps = resolveCapabilities({ sales: "READ" });
    expect(caps.has("sales:view")).toBe(true);
    expect(caps.has("sales:sell")).toBe(false);
  });

  it("منحٌ صريح يفتح قدرةً حسّاسة (بيعٌ **مع** إلغاء)", () => {
    const caps = resolveCapabilities({ sales: "FULL" }, { allow: ["sales:void"] });
    expect(caps.has("sales:void")).toBe(true);
  });

  it("منحُ قدرةٍ حسّاسة فوق وحدةٍ محجوبة (NONE) لا يفتحها (لا منح فوق العدم)", () => {
    const caps = resolveCapabilities({ sales: "NONE" }, { allow: ["sales:void"] });
    expect(caps.has("sales:void")).toBe(false);
  });

  it("DENY يتجاوز الاشتقاق و allow معاً (بيعٌ **بلا** إرجاع)", () => {
    const caps = resolveCapabilities({ sales: "FULL" }, { deny: ["sales:return"] });
    expect(caps.has("sales:sell")).toBe(true);
    expect(caps.has("sales:return")).toBe(false);
    // deny يتجاوز allow صريح أيضاً.
    const caps2 = resolveCapabilities({ sales: "FULL" }, { allow: ["sales:void"], deny: ["sales:void"] });
    expect(caps2.has("sales:void")).toBe(false);
  });

  it("دورٌ «غير مُهاجَر» (grants=null) ⇒ الحسّاس مغلق كليّاً حتى مع FULL على كل الوحدات", () => {
    const allFull = Object.fromEntries(CAPABILITIES.map((c) => [c.module, "FULL" as const]));
    const caps = resolveCapabilities(allFull, null);
    for (const c of CAPABILITIES.filter((x) => x.sensitive)) {
      expect(caps.has(c.key), c.key).toBe(false);
    }
    // وغير الحسّاسة مشتقّة بالكامل.
    expect(caps.has("sales:sell")).toBe(true);
  });
});

describe("SoD — كشف التوليفات السامّة", () => {
  it("منح المنشئ والمعتمِد معاً في دورٍ واحد يُكشَف لكل زوجٍ حرِج", () => {
    for (const [a, b] of SOD_CONFLICTS) {
      const modA = a.split(":")[0];
      const modB = b.split(":")[0];
      const caps = resolveCapabilities({ [modA]: "FULL", [modB]: "FULL" }, { allow: [a, b] });
      const conflicts = detectSodConflicts(caps);
      expect(conflicts.some(([x, y]) => x === a && y === b), `${a}+${b}`).toBe(true);
    }
  });

  it("منح المنشئ وحده (بلا معتمِد) لا يُعدّ تعارضاً", () => {
    const caps = resolveCapabilities({ treasury: "FULL" }, { allow: ["treasury:voucher.create"] });
    expect(detectSodConflicts(caps)).toEqual([]);
  });

  it("hasCapability يطابق resolveCapabilities", () => {
    const map = { pos: "FULL" as const };
    expect(hasCapability(map, null, "pos:sell")).toBe(true);
    expect(hasCapability(map, null, "sales:sell")).toBe(false);
  });
});

describe("العلَم — معطَّل افتراضياً (صفر أثر)", () => {
  it("capabilitiesEnabled=false بلا ضبط، true عند RBAC_CAPABILITIES=1", () => {
    expect(capabilitiesEnabled({})).toBe(false);
    expect(capabilitiesEnabled({ RBAC_CAPABILITIES: "0" })).toBe(false);
    expect(capabilitiesEnabled({ RBAC_CAPABILITIES: "1" })).toBe(true);
    expect(capabilitiesEnabled({ RBAC_CAPABILITIES: "true" })).toBe(true);
  });

  it("قوالب الأدوار الحقيقية تشتقّ قدراتٍ متّسقة (كاشير تجزئة ⇒ sell بلا void)", () => {
    // كاشير تجزئة = قالب cashier مع sales=FULL, pos=NONE — يبيع تجزئةً بلا إلغاء (المستحيل اليوم).
    const retail = { ...ROLE_TEMPLATES.cashier, pos: "NONE" as const, workorders: "NONE" as const };
    const caps = resolveCapabilities(retail);
    expect(caps.has("sales:sell")).toBe(true);
    expect(caps.has("sales:void")).toBe(false);
    expect(caps.has("pos:sell")).toBe(false);
  });
});
