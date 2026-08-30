import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildAutomaticAuditData } from "../auditService";

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

  it("يجعل auditedProcedure الجذر الوحيد لكل إجراءات tRPC", () => {
    const source = readFileSync("server/trpc.ts", "utf8");
    expect(source.match(/t\.procedure/g)).toHaveLength(1);
    expect(source).toContain("t.procedure.use(auditSuccessfulMutation)");
    expect(source).toContain("withMutationAuditScope(() => next())");
    expect(source).toContain("await getRawInput()");
    expect(source).toContain("!specializedAuditWritten");
  });
});
