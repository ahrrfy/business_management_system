import { describe, expect, it } from "vitest";
import {
  ROLE_TEMPLATES,
  SECTION_CASHIER_ROLES,
  STUDIO_ACCESS_ROLES,
  type RoleKey,
} from "../permissions";
import {
  STUDIO_EMPLOYEE_CAPTURE_OPERATIONS,
  operationDecision,
  resolveOperationPolicy,
  summarizeOperationModules,
} from "../operationPermissions";
import { buildDefaultRoleOperationPolicy } from "../roleOperationPresets";

const NON_COURIER_EMPLOYEE_ROLES: RoleKey[] = [
  "admin",
  "manager",
  "accountant",
  "cashier",
  "warehouse",
  "purchasing",
  "print_operator",
  "sales_rep",
  "user",
];

const MANAGER_ONLY_STUDIO_OPERATIONS = [
  "productStudio.approve",
  "productStudio.reject",
  "productStudio.revert",
  "productStudio.cancel",
  "productStudio.assign",
  "productStudio.createCampaign",
  "productStudio.deleteImage",
] as const;

describe("صلاحيات استوديو المنتجات لجميع الموظفين عدا مندوب التوصيل", () => {
  it("تمنح جميع أدوار الموظفين غير المندوبين التصوير والرفع للاعتماد، وتستثني مندوب التوصيل", () => {
    expect(STUDIO_ACCESS_ROLES).not.toContain("courier");
    expect(ROLE_TEMPLATES.courier.productStudio).toBe("NONE");
    expect(ROLE_TEMPLATES.auditor.productStudio).toBe("READ");

    for (const role of NON_COURIER_EMPLOYEE_ROLES) {
      expect(ROLE_TEMPLATES[role].productStudio, role).toBe("FULL");
      const policy = buildDefaultRoleOperationPolicy(role, role, ROLE_TEMPLATES[role]);
      for (const path of STUDIO_EMPLOYEE_CAPTURE_OPERATIONS) {
        expect(
          operationDecision(
            {
              role,
              operationPolicyEnabled: true,
              resolvedOperationPolicy: policy,
            },
            path,
          ).allowed,
          `${role}:${path}`,
        ).toBe(true);
      }
    }
  });

  it("تبقي عمليات الاعتماد والإدارة محصورة بالمدير ولا تمنحها للموظفين العاديين", () => {
    for (const role of NON_COURIER_EMPLOYEE_ROLES.filter((r) => r !== "admin" && r !== "manager")) {
      const policy = buildDefaultRoleOperationPolicy(role, role, ROLE_TEMPLATES[role]);
      for (const path of MANAGER_ONLY_STUDIO_OPERATIONS) {
        expect(
          operationDecision(
            {
              role,
              operationPolicyEnabled: true,
              resolvedOperationPolicy: policy,
            },
            path,
          ).allowed,
          `${role}:${path}`,
        ).toBe(false);
      }
    }
  });

  it("تضمن وصول الموظفين للتصوير حتى مع وجود سياسة دور محفوظة مسبقاً قبل التحديث", () => {
    for (const spec of SECTION_CASHIER_ROLES) {
      const staleSavedRolePolicy = {
        version: 1 as const,
        grants: {
          "operation.sales.create": true,
        },
      };
      const resolved = resolveOperationPolicy(
        spec.baseRole,
        { ...spec.permissions, productStudio: "NONE" },
        staleSavedRolePolicy,
        null,
      );
      for (const path of STUDIO_EMPLOYEE_CAPTURE_OPERATIONS) {
        expect(
          operationDecision(
            {
              role: spec.baseRole,
              operationPolicyEnabled: true,
              resolvedOperationPolicy: resolved,
            },
            path,
          ).allowed,
          `${spec.key}:${path}`,
        ).toBe(true);
      }
      expect(summarizeOperationModules(resolved).productStudio).toBe("FULL");
    }
  });

  it("تبقي مندوب التوصيل والمدقق محكومين بحدودهما حتى مع السياسات المحفوظة", () => {
    const courierPolicy = buildDefaultRoleOperationPolicy("courier", "courier", ROLE_TEMPLATES.courier);
    for (const path of STUDIO_EMPLOYEE_CAPTURE_OPERATIONS.filter((p) => p.startsWith("productStudio."))) {
      expect(
        operationDecision(
          {
            role: "courier",
            operationPolicyEnabled: true,
            resolvedOperationPolicy: courierPolicy,
          },
          path,
        ).allowed,
        `courier:${path}`,
      ).toBe(false);
    }

    const auditorPolicy = buildDefaultRoleOperationPolicy("auditor", "auditor", ROLE_TEMPLATES.auditor);
    expect(
      operationDecision(
        {
          role: "auditor",
          operationPolicyEnabled: true,
          resolvedOperationPolicy: auditorPolicy,
        },
        "productStudio.quickSaveBarcodeProductImage",
      ).allowed,
    ).toBe(false);
  });

  it("تحفظ المنع الفردي الصريح بغضّ النظر عن حجم سياسة المستخدم، وتبقي الحساب ذو الدور المخصّص المعطّل مغلقاً", () => {
    const largeUserGrants: Record<string, boolean> = {};
    for (let i = 0; i < 60; i++) {
      largeUserGrants[`operation.custom.op${i}`] = true;
    }
    largeUserGrants["operation.productStudio.quickSaveBarcodeProductImage"] = false;
    const resolvedLarge = resolveOperationPolicy(
      "cashier",
      ROLE_TEMPLATES.cashier,
      buildDefaultRoleOperationPolicy("cashier", "cashier", ROLE_TEMPLATES.cashier),
      { version: 1, grants: largeUserGrants },
    );
    expect(
      operationDecision(
        {
          role: "cashier",
          operationPolicyEnabled: true,
          resolvedOperationPolicy: resolvedLarge,
        },
        "productStudio.quickSaveBarcodeProductImage",
      ).allowed,
    ).toBe(false);

    // Fail-closed inactive/missing custom role: resolveOperationPolicy("user", {}, { version: 1, grants: {} }, null)
    const failClosed = resolveOperationPolicy("user", {}, { version: 1, grants: {} }, null);
    for (const path of STUDIO_EMPLOYEE_CAPTURE_OPERATIONS) {
      expect(
        operationDecision(
          {
            role: "user",
            operationPolicyEnabled: true,
            resolvedOperationPolicy: failClosed,
          },
          path,
        ).allowed,
        `failClosed:${path}`,
      ).toBe(false);
    }
  });

  it("تمنح عمليات التصوير والمعالجة بالذكاء حتى مع وجود لقطة كتالوج كاملة قديمة (>=500 مفتاح) على حساب الموظف", () => {
    const fullSnapshotGrants: Record<string, boolean> = {};
    for (let i = 0; i < 600; i++) {
      fullSnapshotGrants[`operation.legacy.op${i}`] = i % 2 === 0;
    }
    fullSnapshotGrants["operation.productStudio.quickAiTransform"] = false;
    fullSnapshotGrants["operation.productStudio.quickSaveBarcodeProductImage"] = false;
    fullSnapshotGrants["operation.imageStudio.aiStudioTransform"] = false;

    const resolvedSnapshot = resolveOperationPolicy(
      "cashier",
      ROLE_TEMPLATES.cashier,
      buildDefaultRoleOperationPolicy("cashier", "cashier", ROLE_TEMPLATES.cashier),
      { version: 1, grants: fullSnapshotGrants },
    );

    for (const path of STUDIO_EMPLOYEE_CAPTURE_OPERATIONS) {
      expect(
        operationDecision(
          {
            role: "cashier",
            operationPolicyEnabled: true,
            resolvedOperationPolicy: resolvedSnapshot,
          },
          path,
        ).allowed,
        `snapshot:${path}`,
      ).toBe(true);
    }
  });
});
