/**
 * ForensicTraceContract & ReturnsHub Integration Tests
 *
 * يتحقق من:
 * ١) تصدير إجراءات التحري الجنائي والمسح الكوني في returnRouter.
 * ٢) حماية الإجراءات بـ salesReadProcedure المناسبة للكاشير والمدير معاً.
 * ٣) تكامل القائمة البيضاء للكاشير CASHIER_NAV_PATHS مع /returns.
 * ٤) تسجيل وحدة بوابة المرتجعات في APPLICATION_MODULES بخصائصها الصحيحة.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CASHIER_NAV_PATHS } from "../../../client/src/lib/navVisibility";
import { APPLICATION_MODULES } from "../../../client/src/lib/moduleRegistry";

const readServer = (rel: string) =>
  readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

describe("عقد إجراءات التحري الجنائي والمسح الشامل", () => {
  const routerSrc = readServer("routers/returnRouter.ts");

  it("returnRouter يصدّر forensicTrace و universalScan", () => {
    expect(routerSrc).toContain("forensicTrace: salesReadProcedure");
    expect(routerSrc).toContain("universalScan: salesReadProcedure");
    expect(routerSrc).toContain('from "../services/returns/forensicTraceService"');
  });

  it("البوّابة تسمح للكاشير والمدير بقراءة فواتير التحري الجنائي", () => {
    // salesReadProcedure تتيح لـ cashier و manager و admin الوصول للاستعلام
    expect(routerSrc).toMatch(/salesReadProcedure\s*\.input\(/);
  });
});

describe("تكامل بوابة المرتجعات في واجهة النظام", () => {
  it("القائمة البيضاء للكاشير تشمل /returns", () => {
    expect(CASHIER_NAV_PATHS).toContain("/returns");
  });

  it("سجل الوحدات APPLICATION_MODULES يوثّق بوابة المرتجعات", () => {
    const returnsMod = APPLICATION_MODULES.find((m) => m.id === "returns");
    expect(returnsMod).toBeDefined();
    expect(returnsMod?.href).toBe("/returns");
    expect(returnsMod?.label).toBe("بوابة المرتجعات");
    expect(returnsMod?.section).toBe(1);
    expect(returnsMod?.roles).toContain("cashier");
    expect(returnsMod?.roles).toContain("manager");
    expect(returnsMod?.roles).toContain("admin");
  });
});
