/**
 * اختبار وحدة نقيّ (بلا قاعدة) لبوّابة RBAC في البحث الشامل — `canSeeType`.
 *
 * يثبّت إصلاح تسريب PII (مراجعة عدائية): رؤية الموظفين تُحكَم بخريطة صلاحيات HR
 * المحسوبة (قالب الدور + permissionsOverride) لا باسم الدور الأساس — مطابِقةً تماماً
 * لـ requireModule("hr","READ")، وإدارة المستخدمين للأدمن فقط.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canSeeType } from "../globalSearchService";
import type {
  OperationPolicy,
  OperationUser,
} from "@shared/operationPermissions";

const searchMocks = vi.hoisted(() => ({
  db: {},
  getDb: vi.fn(),
  searchEmployees: vi.fn(),
  searchInvoices: vi.fn().mockResolvedValue([]),
  searchExpenses: vi.fn().mockResolvedValue([]),
  searchSuppliers: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../db", () => ({ getDb: searchMocks.getDb }));
vi.mock("../globalSearch/searchHr", () => ({
  searchEmployees: searchMocks.searchEmployees,
  searchUsers: vi.fn().mockResolvedValue([]),
}));
vi.mock("../globalSearch/searchMasterData", () => ({
  searchProducts: vi.fn().mockResolvedValue([]),
  searchCustomers: vi.fn().mockResolvedValue([]),
  searchSuppliers: searchMocks.searchSuppliers,
}));
vi.mock("../globalSearch/searchDocuments", () => ({
  searchInvoices: searchMocks.searchInvoices,
  searchQuotations: vi.fn().mockResolvedValue([]),
  searchWorkOrders: vi.fn().mockResolvedValue([]),
  searchPurchaseOrders: vi.fn().mockResolvedValue([]),
  searchExpenses: searchMocks.searchExpenses,
}));

import { globalSearch } from "../globalSearch/orchestrator";

function canonicalSearchUser(
  grants: Record<string, boolean>,
  recordScopes?: OperationPolicy["recordScopes"],
): OperationUser & { id: number } {
  return {
    id: 31,
    role: "warehouse",
    operationPolicyEnabled: true,
    resolvedOperationPolicy: { version: 1, grants, recordScopes },
  };
}

describe("global search — exact canonical source grants", () => {
  it("يطابق OWN وBRANCH لكل مدير وأدمن عادي وكاشير دون تغيير باختلاف الدور", async () => {
    searchMocks.getDb.mockReturnValue(searchMocks.db);
    const grants = {
      "operation.globalSearch.search": true,
      "operation.sales.get": true,
      "operation.expenses.list": true,
    };
    for (const role of ["manager", "admin", "cashier"]) {
      for (const scope of ["OWN", "BRANCH"] as const) {
        const user = {
          ...canonicalSearchUser(grants, {
            "operation.sales.get": scope,
            "operation.expenses.list": scope,
          }),
          role,
          isOwner: false,
        };
        await globalSearch({
          query: "INV",
          role,
          branchId: 7,
          operationUser: user,
          scopes: ["INVOICE", "EXPENSE"],
        });
        const expectedOwner = scope === "OWN" ? 31 : null;
        const expectedBranch = role === "admin" ? null : 7;
        expect(searchMocks.searchInvoices).toHaveBeenLastCalledWith(
          searchMocks.db,
          "DOC_NUMBER",
          "INV",
          6,
          expectedBranch,
          expectedOwner,
        );
        expect(searchMocks.searchExpenses).toHaveBeenLastCalledWith(
          searchMocks.db,
          "DOC_NUMBER",
          "INV",
          6,
          expectedBranch,
          expectedOwner,
        );
      }
    }
  });

  it("يحفظ عبور فروع الأدمن مع OWN ويعفي المالك الحقيقي وحده من قيد السجل", async () => {
    searchMocks.getDb.mockReturnValue(searchMocks.db);
    const grants = {
      "operation.globalSearch.search": true,
      "operation.sales.get": true,
    };
    const user = {
      ...canonicalSearchUser(grants),
      role: "admin",
      isOwner: false,
    };
    await globalSearch({
      query: "INV",
      role: "admin",
      branchId: null,
      operationUser: user,
      scopes: ["INVOICE"],
    });
    expect(searchMocks.searchInvoices).toHaveBeenLastCalledWith(
      searchMocks.db,
      "DOC_NUMBER",
      "INV",
      6,
      null,
      31,
    );
    await globalSearch({
      query: "INV",
      role: "admin",
      branchId: 7,
      operationUser: { ...user, isOwner: true },
      scopes: ["INVOICE"],
    });
    expect(searchMocks.searchInvoices).toHaveBeenLastCalledWith(
      searchMocks.db,
      "DOC_NUMBER",
      "INV",
      6,
      null,
      null,
    );
  });

  it("يفتح المورد والشراء والمصروف بالتفويض الفعلي دون شرط اسم الدور", () => {
    for (const [type, path] of [
      ["SUPPLIER", "suppliers.get"],
      ["PURCHASE_ORDER", "purchases.get"],
      ["EXPENSE", "expenses.list"],
    ] as const) {
      const user = canonicalSearchUser({
        "operation.globalSearch.search": true,
        [`operation.${path}`]: true,
      });
      expect(canSeeType(user.role, type, null, user)).toBe(true);
      expect(
        canSeeType(
          user.role,
          type,
          { suppliers: "FULL", purchases: "FULL", expenses: "FULL" },
          canonicalSearchUser({ "operation.globalSearch.search": true }),
        ),
      ).toBe(false);
      expect(
        canSeeType(
          user.role,
          type,
          null,
          canonicalSearchUser({ [`operation.${path}`]: true }),
        ),
      ).toBe(false);
    }
  });

  it("لا يحول منح تعديل المصدر أو منع البحث إلى تفويض قراءة", () => {
    expect(
      canSeeType(
        "warehouse",
        "SUPPLIER",
        { suppliers: "FULL" },
        canonicalSearchUser({
          "operation.globalSearch.search": true,
          "operation.suppliers.update": true,
        }),
      ),
    ).toBe(false);
    expect(
      canSeeType("warehouse", "SUPPLIER", { suppliers: "FULL" }, null),
    ).toBe(false);
    const deniedAdmin = { ...canonicalSearchUser({}), role: "admin" };
    expect(canSeeType("admin", "SUPPLIER", null, deniedAdmin)).toBe(false);
    expect(
      canSeeType(
        "warehouse",
        "USER",
        null,
        canonicalSearchUser({ "operation.globalSearch.search": true }),
      ),
    ).toBe(false);
  });

  it("يمرر OWN للمصادر المقيدة ويترك BRANCH في الفرع المسند", async () => {
    searchMocks.getDb.mockReturnValue(searchMocks.db);
    const grants = {
      "operation.globalSearch.search": true,
      "operation.sales.get": true,
      "operation.expenses.list": true,
    };
    const user = canonicalSearchUser(grants);
    await globalSearch({
      query: "INV",
      role: user.role,
      branchId: 7,
      operationUser: user,
      scopes: ["INVOICE", "EXPENSE"],
    });
    expect(searchMocks.searchInvoices).toHaveBeenLastCalledWith(
      searchMocks.db,
      "DOC_NUMBER",
      "INV",
      6,
      7,
      31,
    );
    expect(searchMocks.searchExpenses).toHaveBeenLastCalledWith(
      searchMocks.db,
      "DOC_NUMBER",
      "INV",
      6,
      7,
      31,
    );
    await globalSearch({
      query: "INV",
      role: user.role,
      branchId: 7,
      operationUser: canonicalSearchUser(grants, {
        "operation.sales.get": "BRANCH",
        "operation.expenses.list": "BRANCH",
      }),
      scopes: ["INVOICE", "EXPENSE"],
    });
    expect(searchMocks.searchInvoices).toHaveBeenLastCalledWith(
      searchMocks.db,
      "DOC_NUMBER",
      "INV",
      6,
      7,
      null,
    );
    expect(searchMocks.searchExpenses).toHaveBeenLastCalledWith(
      searchMocks.db,
      "DOC_NUMBER",
      "INV",
      6,
      7,
      null,
    );
  });
});

describe("canSeeType — RBAC للموظف/المستخدم (يحلّ permissionsOverride)", () => {
  it("الأدمن يرى كل شيء", () => {
    expect(canSeeType("admin", "EMPLOYEE")).toBe(true);
    expect(canSeeType("admin", "USER")).toBe(true);
  });

  it("إدارة المستخدمين (USER) للأدمن فقط", () => {
    for (const role of [
      "manager",
      "accountant",
      "auditor",
      "cashier",
      "warehouse",
      "user",
    ]) {
      expect(canSeeType(role, "USER")).toBe(false);
    }
  });

  it("الموظفون يُحكَمون بوحدة hr المحسوبة (FULL أو READ) لا باسم الدور", () => {
    expect(canSeeType("manager", "EMPLOYEE")).toBe(true); // hr: FULL
    expect(canSeeType("accountant", "EMPLOYEE")).toBe(true); // hr: READ
    expect(canSeeType("auditor", "EMPLOYEE")).toBe(true); // hr: READ
    expect(canSeeType("cashier", "EMPLOYEE")).toBe(false); // hr: NONE
    expect(canSeeType("warehouse", "EMPLOYEE")).toBe(false); // hr: NONE
    expect(canSeeType("user", "EMPLOYEE")).toBe(false); // hr: NONE
  });

  it("override يَجبّ القالب: مدير أُلغِيت عنه hr لا يرى الموظفين (سدّ تسريب PII)", () => {
    expect(canSeeType("manager", "EMPLOYEE", { hr: "NONE" })).toBe(false);
  });

  it("override يَمنح: كاشير مُنح hr=FULL يرى الموظفين (لا حجب خاطئ)", () => {
    expect(canSeeType("cashier", "EMPLOYEE", { hr: "FULL" })).toBe(true);
  });

  it("سلوك الأنواع الأخرى غير متأثّر: الكاشير يرى المنتجات لا الموردين/المشتريات/المصاريف", () => {
    expect(canSeeType("cashier", "PRODUCT")).toBe(true);
    expect(canSeeType("cashier", "SUPPLIER")).toBe(false);
    expect(canSeeType("cashier", "PURCHASE_ORDER")).toBe(false);
    expect(canSeeType("cashier", "EXPENSE")).toBe(false);
  });
});

describe("canSeeType — بوّابة الوحدة لكل نوع بحث (يطابق requireModule؛ إصلاح تسريب تدقيق ٢٧/٧)", () => {
  // البوّابة الأساس صارت خريطة الصلاحيات المحلولة (قالب + override) على وحدة كل نوع عبر
  // hasModuleAccess — لا نموذج أدوار خشن. كان دورٌ سُحبت عنه الوحدة يظلّ يرى النوع (تسريب PII/وثائق).

  it("سحب الوحدة عبر override يُخفي النوع من البحث الشامل (سدّ التسريب الأساسي لكل نوع تشغيليّ)", () => {
    expect(canSeeType("cashier", "CUSTOMER", { crm: "NONE" })).toBe(false); // crm=FULL افتراضاً
    expect(canSeeType("cashier", "INVOICE", { sales: "NONE" })).toBe(false);
    expect(canSeeType("cashier", "QUOTATION", { sales: "NONE" })).toBe(false);
    expect(canSeeType("cashier", "PRODUCT", { products: "NONE" })).toBe(false);
    expect(canSeeType("cashier", "WORK_ORDER", { workorders: "NONE" })).toBe(
      false,
    );
  });

  it("النوع مربوطٌ بوحدة راوتره بالضبط: CUSTOMER→crm لا «customers» المهجورة", () => {
    // منح مفتاح «customers» المهجور لا يفتح البحث (البوّابة الحقيقية crm) — يطابق customersReadProcedure.
    expect(
      canSeeType("warehouse", "CUSTOMER", { crm: "NONE", customers: "FULL" }),
    ).toBe(false);
    expect(canSeeType("warehouse", "CUSTOMER")).toBe(true); // warehouse crm=READ
  });

  it("المحاسب يُحكَم بوحدته: يرى العميل/الفاتورة (crm/sales READ) ولا يرى المنتج (products=NONE)", () => {
    expect(canSeeType("accountant", "CUSTOMER")).toBe(true);
    expect(canSeeType("accountant", "INVOICE")).toBe(true);
    expect(canSeeType("accountant", "PRODUCT")).toBe(false); // كان يتسرّب (short-circuit) قبل الإصلاح
  });

  it("منحٌ صريحٌ عبر override يفتح النوع (لا حجب خاطئ): purchasing مُنِح sales=READ يرى الفواتير", () => {
    expect(canSeeType("purchasing", "INVOICE")).toBe(false); // sales=NONE افتراضاً
    expect(canSeeType("purchasing", "INVOICE", { sales: "READ" })).toBe(true);
  });

  it("الكاشير القالبيّ يرى ما تتيحه وحداته: العميل والفاتورة وأمر الشغل والمنتج", () => {
    expect(canSeeType("cashier", "CUSTOMER")).toBe(true); // crm: FULL
    expect(canSeeType("cashier", "INVOICE")).toBe(true); // sales: FULL
    expect(canSeeType("cashier", "WORK_ORDER")).toBe(true); // workorders: FULL
    expect(canSeeType("cashier", "PRODUCT")).toBe(true); // products: READ
  });
});

describe("globalSearch — نطاق فرع الموظفين", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchMocks.getDb.mockReturnValue(searchMocks.db);
    searchMocks.searchEmployees.mockResolvedValue([]);
  });

  it("يرفض المستخدم غير العابر عندما لا يكون له فرع", async () => {
    await expect(
      globalSearch({
        query: "موظف",
        branchId: null,
        role: "manager",
        scopes: ["EMPLOYEE"],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(searchMocks.searchEmployees).not.toHaveBeenCalled();
  });

  it("يمرر فرع المدير إلى بحث الموظفين", async () => {
    await globalSearch({
      query: "موظف",
      branchId: 17,
      role: "manager",
      scopes: ["EMPLOYEE"],
    });
    expect(searchMocks.searchEmployees).toHaveBeenCalledWith(
      searchMocks.db,
      "TEXT",
      "موظف",
      6,
      17,
    );
  });

  it("يبقي الأدمن عابر الفروع", async () => {
    await globalSearch({
      query: "موظف",
      branchId: null,
      role: "admin",
      scopes: ["EMPLOYEE"],
    });
    expect(searchMocks.searchEmployees).toHaveBeenCalledWith(
      searchMocks.db,
      "TEXT",
      "موظف",
      6,
      null,
    );
  });
});
