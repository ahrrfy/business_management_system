import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  auditScreenPath,
  automaticActorForProcedure,
  buildAutomaticAuditData,
} from "../auditService";
import { backgroundOperationEffectCount } from "../../tenancy/backgroundTenants";

describe("العقد العام لتتبّع الحركات", () => {
  it("ينسب الحركة إلى هدف النتيجة قبل معرّفات الأطراف في الإدخال", () => {
    const audit = buildAutomaticAuditData(
      "purchases.create",
      { supplierId: 8, branchId: 2, password: "لا يجوز تسجيلها" },
      { id: 91, purchaseNumber: "PO-91" },
    );

    expect(audit).toMatchObject({
      action: "rpc.purchases.create",
      entityType: "purchases",
      entityId: "91",
      newValue: {
        _auditContract: "operation.v1",
        procedure: "purchases.create",
        outcome: "SUCCESS",
      },
    });
    expect(JSON.stringify(audit)).not.toContain("لا يجوز تسجيلها");
    expect(JSON.stringify(audit)).not.toContain("supplierId");
  });

  it("يحفظ معرّف الهدف من الإدخال عند التعديل ولا يخلطه بهوية المنفّذ", () => {
    expect(
      buildAutomaticAuditData(
        "users.update",
        { userId: 42, branchId: 3 },
        undefined,
      ).entityId,
    ).toBe("42");
    expect(
      buildAutomaticAuditData(
        "tasks.assign",
        { taskId: 17, assignedTo: 42 },
        undefined,
      ).entityId,
    ).toBe("17");
  });

  it("يحترم حدود أعمدة السجل ويحفظ المسار الكامل داخل الحمولة الآمنة", () => {
    const path = `inventory.${"nested".repeat(30)}.update`;
    const audit = buildAutomaticAuditData(path, { id: 1 }, { ok: true });
    expect(audit.action.length).toBeLessThanOrEqual(100);
    expect((audit.newValue as { procedure: string }).procedure).toBe(path);
  });

  it("يميّز الفشل والقنوات العامة والأجهزة من دون اختلاق مستخدم", () => {
    const failed = buildAutomaticAuditData("storefront.createOrder", { id: 9 }, undefined, {
      outcome: "FAILURE",
      actor: automaticActorForProcedure("storefront.createOrder", false),
    });
    expect(failed).toMatchObject({
      outcome: "FAILURE",
      actor: { source: "external", label: "قناة عامة غير مؤكدة" },
      newValue: { outcome: "FAILURE" },
    });
    expect(automaticActorForProcedure("countPortal.submit", false)).toEqual({ source: "external", label: "قناة عامة غير مؤكدة" });
    expect(automaticActorForProcedure("sales.create", true)).toEqual({ source: "user" });
  });

  it("يحفظ مسار الشاشة فقط ويختصر أثر العامل إلى عدد آمن", () => {
    expect(auditScreenPath({ headers: { "x-erp-screen-path": "/invoices?secret=1" } } as never)).toBe("/invoices");
    expect(auditScreenPath({ headers: { host: "erp.local", referer: "https://erp.local/sales?customerPhone=secret" } } as never)).toBe("/sales");
    expect(auditScreenPath({ headers: { host: "erp.local", referer: "https://evil.local/sales" } } as never)).toBeNull();
    expect(backgroundOperationEffectCount({ claimed: 2, sent: 2, candidates: 50, error: "لا يُسجّل" })).toBe(2);
    expect(backgroundOperationEffectCount({ balanced: true, findingCount: 9 })).toBe(0);
  });

  it("يجعل auditedProcedure الجذر الوحيد لكل إجراءات tRPC", () => {
    const source = readFileSync("server/trpc.ts", "utf8");
    const auditSource = readFileSync("server/services/auditService.ts", "utf8");
    const backgroundSource = readFileSync("server/tenancy/backgroundTenants.ts", "utf8");
    expect(source.match(/t\.procedure/g)).toHaveLength(1);
    expect(source).toContain("t.procedure.use(auditMutationOperation)");
    expect(source).toContain("withMutationAuditScope(() => next())");
    expect(source).toContain("await getRawInput()");
    expect(source).toContain("const shouldWriteAutomatic = result.ok ? !specializedAuditWritten : ctx.user != null");
    expect(source).toContain('outcome = result.ok ? "SUCCESS" : "FAILURE"');
    expect(source).not.toContain('type !== "mutation" || !ctx.user');
    expect(auditSource).toContain("newValue: redactAuditValue(data.newValue)");
    expect(auditSource).toContain("screenPath: operation.screenPath ?? null");
    expect(auditSource.slice(auditSource.indexOf("export async function logAuditTx"))).toContain("ipAddress: ip,");
    expect(backgroundSource).toContain("auditBackgroundFailure");
    expect(backgroundSource).toContain('outcome: "FAILURE"');
  });
});
