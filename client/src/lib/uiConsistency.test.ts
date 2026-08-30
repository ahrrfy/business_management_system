import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { actorLabel } from "@/components/data-table/ActorCell";
import { DISPLAY_SCALES, isDisplayScale } from "@/lib/displayScale";
import { APPLICATION_MODULES } from "@/lib/moduleRegistry";

describe("سجل وحدات التطبيق", () => {
  it("لا يكرر المعرّفات أو المسارات", () => {
    expect(new Set(APPLICATION_MODULES.map((module) => module.id)).size).toBe(APPLICATION_MODULES.length);
    expect(new Set(APPLICATION_MODULES.map((module) => module.href)).size).toBe(APPLICATION_MODULES.length);
  });

  it("يوثّق كل بطاقة بما يلزم لإضافتها تلقائياً إلى الرئيسية", () => {
    for (const module of APPLICATION_MODULES) {
      expect(module.label.trim()).not.toBe("");
      expect(module.description.trim()).not.toBe("");
      expect(module.section).toBeGreaterThanOrEqual(1);
      expect(module.section).toBeLessThanOrEqual(5);
      expect(module.icon).toBeTruthy();
    }
  });

  it("يشمل الوحدات التي كانت مفقودة من بطاقات الرئيسية", () => {
    const ids = new Set(APPLICATION_MODULES.map((module) => module.id));
    for (const id of ["priceChecker", "myDeliveries", "gifts", "digitalCards", "chartOfAccounts"]) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it("يغذّي القائمة والرئيسية من السجل نفسه", () => {
    const layout = readFileSync("client/src/components/AppLayout.tsx", "utf8");
    const dashboard = readFileSync("client/src/pages/Dashboard.tsx", "utf8");
    expect(layout).toContain("APPLICATION_MODULES as NAV_LINKS");
    expect(dashboard).toContain("APPLICATION_MODULES.filter");
    expect(dashboard).toContain("withRegisteredGate");
  });
});

describe("بيان منفّذ العملية", () => {
  it("لا يعرض شرطة مبهمة للسجلات القديمة أو النظام", () => {
    expect(actorLabel(undefined)).toBe("غير موثّق");
    expect(actorLabel({ source: "legacy" })).toBe("بيانات قديمة");
    expect(actorLabel({ source: "system" })).toBe("النظام");
    expect(actorLabel({ userId: 42 })).toBe("مستخدم #42");
    expect(actorLabel({ userId: 42, name: "  أحمد  " })).toBe("أحمد");
  });
});

describe("مقياس العرض الآمن", () => {
  it("لا يقبل قيمة خارج الحدود المعرفة", () => {
    for (const scale of DISPLAY_SCALES) expect(isDisplayScale(scale)).toBe(true);
    expect(isDisplayScale("200%")).toBe(false);
    expect(isDisplayScale(1.5)).toBe(false);
  });
});
