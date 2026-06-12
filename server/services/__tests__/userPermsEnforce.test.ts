/**
 * اختبارات إنفاذ الصلاحيات — نموذج الأدوار العشرة.
 * يتحقق من: قوالب الأدوار الجديدة + التوافق الخلفي للخمسة القديمة + override + canSeeCost.
 */
import { describe, expect, it } from "vitest";
import {
  ROLE_TEMPLATES,
  resolvePermissions,
  diffFromTemplate,
  canSeeCost,
  ALL_ROLES,
  type RoleKey,
} from "../../../shared/permissions";

describe("قوالب الأدوار الخمسة القديمة — توافق خلفي", () => {
  it("admin: كل الوحدات FULL", () => {
    const t = ROLE_TEMPLATES.admin;
    expect(t.pos).toBe("FULL");
    expect(t.users).toBe("FULL");
    expect(t.settings).toBe("FULL");
  });
  it("manager: يرى كل شيء عدا users/settings (READ)", () => {
    const t = ROLE_TEMPLATES.manager;
    expect(t.pos).toBe("FULL");
    expect(t.users).toBe("READ");
    expect(t.settings).toBe("READ");
  });
  it("cashier: pos+sales+customers+expenses FULL، purchases/reports NONE", () => {
    const t = ROLE_TEMPLATES.cashier;
    expect(t.pos).toBe("FULL");
    expect(t.sales).toBe("FULL");
    expect(t.purchases).toBe("NONE");
    expect(t.reports).toBe("NONE");
  });
  it("warehouse: purchases+inventory+suppliers FULL، pos NONE", () => {
    const t = ROLE_TEMPLATES.warehouse;
    expect(t.purchases).toBe("FULL");
    expect(t.inventory).toBe("FULL");
    expect(t.pos).toBe("NONE");
  });
  it("user: كل شيء READ أو NONE — لا FULL", () => {
    const t = ROLE_TEMPLATES.user;
    expect(Object.values(t).every((v) => v !== "FULL")).toBe(true);
  });
});

describe("قوالب الأدوار الجديدة", () => {
  it("accountant: reports+expenses FULL، pos NONE، purchases READ", () => {
    const t = ROLE_TEMPLATES.accountant;
    expect(t.reports).toBe("FULL");
    expect(t.expenses).toBe("FULL");
    expect(t.pos).toBe("NONE");
    expect(t.purchases).toBe("READ");
    expect(t.users).toBe("NONE");
  });
  it("print_operator: workorders FULL فقط، pos NONE", () => {
    const t = ROLE_TEMPLATES.print_operator;
    expect(t.workorders).toBe("FULL");
    expect(t.pos).toBe("NONE");
    expect(t.sales).toBe("NONE");
    expect(t.purchases).toBe("NONE");
    expect(t.expenses).toBe("NONE");
  });
  it("sales_rep: customers FULL، pos NONE، purchases NONE", () => {
    const t = ROLE_TEMPLATES.sales_rep;
    expect(t.customers).toBe("FULL");
    expect(t.pos).toBe("NONE");
    expect(t.purchases).toBe("NONE");
    expect(t.expenses).toBe("NONE");
  });
  it("purchasing: purchases+suppliers FULL، inventory READ، pos NONE", () => {
    const t = ROLE_TEMPLATES.purchasing;
    expect(t.purchases).toBe("FULL");
    expect(t.suppliers).toBe("FULL");
    expect(t.inventory).toBe("READ");
    expect(t.pos).toBe("NONE");
    expect(t.workorders).toBe("NONE");
  });
  it("auditor: كل الوحدات READ — لا FULL ولا NONE", () => {
    const t = ROLE_TEMPLATES.auditor;
    expect(Object.values(t).every((v) => v === "READ")).toBe(true);
  });
});

describe("resolvePermissions — override يُطبَّق فوق القالب", () => {
  it("بلا override → يعيد القالب كما هو", () => {
    const p = resolvePermissions("cashier", null);
    expect(p).toEqual(ROLE_TEMPLATES.cashier);
  });
  it("override يرفع صلاحية وحدة", () => {
    const p = resolvePermissions("cashier", { purchases: "READ" });
    expect(p.purchases).toBe("READ");
    expect(p.pos).toBe("FULL"); // بقية القالب سليمة
  });
  it("override يلغي صلاحية كاملة", () => {
    const p = resolvePermissions("manager", { pos: "NONE" });
    expect(p.pos).toBe("NONE");
    expect(p.reports).toBe("FULL"); // بقية القالب سليمة
  });
  it("override بقيم غير صالحة يُتجاهل", () => {
    const p = resolvePermissions("cashier", { pos: "INVALID" as any });
    expect(p.pos).toBe("FULL"); // القالب الأصلي
  });
});

describe("diffFromTemplate — يستخرج الانحراف فقط", () => {
  it("بلا تغيير → null", () => {
    expect(diffFromTemplate("cashier", ROLE_TEMPLATES.cashier)).toBeNull();
  });
  it("تغيير وحدة واحدة → diff يحتوي تلك الوحدة فقط", () => {
    const modified = { ...ROLE_TEMPLATES.cashier, purchases: "READ" as const };
    const diff = diffFromTemplate("cashier", modified);
    expect(diff).toEqual({ purchases: "READ" });
  });
});

describe("canSeeCost — أدوار ترى التكلفة", () => {
  it("admin, manager, accountant يرون التكلفة", () => {
    expect(canSeeCost("admin")).toBe(true);
    expect(canSeeCost("manager")).toBe(true);
    expect(canSeeCost("accountant")).toBe(true);
  });
  it("cashier, warehouse, print_operator لا يرون التكلفة", () => {
    expect(canSeeCost("cashier")).toBe(false);
    expect(canSeeCost("warehouse")).toBe(false);
    expect(canSeeCost("print_operator")).toBe(false);
    expect(canSeeCost("sales_rep")).toBe(false);
    expect(canSeeCost("auditor")).toBe(false);
    expect(canSeeCost("user")).toBe(false);
  });
});

describe("ALL_ROLES — تغطية كاملة", () => {
  it("يحتوي على العشرة أدوار", () => {
    expect(ALL_ROLES).toHaveLength(10);
  });
  it("كل دور له قالب في ROLE_TEMPLATES", () => {
    for (const r of ALL_ROLES) {
      expect(ROLE_TEMPLATES[r as RoleKey]).toBeDefined();
    }
  });
});
