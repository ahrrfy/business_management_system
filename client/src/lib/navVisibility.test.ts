// canSeeGate — بوّابة رؤية التنقّل/التبويبات (تدقيق ١٧/٧، خطر #11).
// الخلل المُعالَج: بوّابة module-only كانت تعيد true فراغياً (roleOk صحيح فراغياً بلا قيود دور)
// فتُظهر التبويب لكل الأدوار وإن رفضها الخادم بـ403؛ ولم تكن تستشير قالب الدور (المنح الصريح فقط).
import { describe, expect, it } from "vitest";
import { getMobileBottomNavItems } from "@/components/MobileBottomNav";
import { OPERATION_PERMISSIONS, type OperationPolicy } from "@shared/operationPermissions";
import { visibleApplicationModules } from "./moduleRegistry";
import { canSeeGate, CLOSING_ENTRY_GATE, EDITOR_OPERATION_GATES, INVOICE_CORRECTION_GATE, RECONCILE_CONTROL_GATE } from "./navVisibility";

describe("canonical operation navigation", () => {
  const policy = (grants: Record<string, boolean>): OperationPolicy => ({ version: 1, grants });
  it("an own-shift grant does not open corporate treasury or exchange", () => {
    const ownShift = policy({ "operation.shifts.current": true });
    expect(canSeeGate({ module: "treasury" }, "cashier", null, ownShift)).toBe(false);
    const hrefs = visibleApplicationModules("cashier", null, ownShift).map((entry) => entry.href);
    expect(hrefs).not.toContain("/treasury");
    expect(hrefs).not.toContain("/exchange");
  });
  it.each(["cashTransfers.list", "vouchers.list", "shifts.list"])("keeps the hosted treasury workflow reachable for %s", (path) => {
    expect(canSeeGate({ module: "treasury" }, "accountant", null, policy({ [`operation.${path}`]: true }))).toBe(true);
  });
  it("a dashboard helper does not open unrelated financial reporting", () => {
    expect(canSeeGate({ module: "reports" }, "cashier", null, policy({ "operation.reports.dashboardMetrics": true }))).toBe(false);
  });
  it("treasury authority does not grant exchange and one report does not grant unrelated accounting pages", () => {
    const treasuryHrefs = visibleApplicationModules("manager", null, policy({ "operation.treasury.getDashboard": true })).map((entry) => entry.href);
    expect(treasuryHrefs).not.toContain("/exchange");
    const reportHrefs = visibleApplicationModules("manager", null, policy({ "operation.reports.salesReport": true })).map((entry) => entry.href);
    for (const href of ["/card-account", "/chart-of-accounts", "/statutory-accounting", "/closing"])
      expect(reportHrefs).not.toContain(href);
  });
  it("a credit list grant does not open the closing workflow's create screen", () => {
    const hrefs = visibleApplicationModules("manager", null, policy({ "operation.creditApproval.list": true })).map(entry => entry.href);
    expect(hrefs).not.toContain("/closing");
  });
  it("preserves the independent credit create workflow with its required selectors", () => {
    const complete = policy(Object.fromEntries(["create", "customerOptions", "listForCustomer"].map(action => [`operation.creditApproval.${action}`, true])));
    expect(canSeeGate(CLOSING_ENTRY_GATE, "manager", null, complete)).toBe(true);
    expect(canSeeGate(CLOSING_ENTRY_GATE, "manager", null, policy({ "operation.creditApproval.create": true }))).toBe(false);
    expect(visibleApplicationModules("manager", null, complete).map(entry => entry.href)).toContain("/closing");
  });
  it("focused canonical cashiers retain only their station navigation", () => {
    const hrefs = visibleApplicationModules("cashier", null, policy({ "operation.assets.list": true, "operation.treasury.getDashboard": true }), true).map((entry) => entry.href);
    expect(hrefs).not.toContain("/assets");
    expect(hrefs).not.toContain("/treasury");
  });
  it("requires both product retrieval and editing instead of opening an unusable editor", () => {
    for (const grants of [
      { "operation.catalog.updateProductVariants": true },
      { "operation.catalog.getForVariantEdit": true },
    ]) expect(canSeeGate(EDITOR_OPERATION_GATES.product, "warehouse", null, policy(grants))).toBe(false);
    expect(canSeeGate(EDITOR_OPERATION_GATES.product, "warehouse", null, { ...policy({
      "operation.catalog.updateProductVariants": true,
      "operation.catalog.getForVariantEdit": true,
    }), dataVisibility: { purchaseCost: true, profitMargin: true } })).toBe(true);
  });
  it("shows individually delegated operations regardless of the old role template", () => {
    expect(canSeeGate({ roles: ["manager"], module: "store", operations: ["delivery.dispatch"] }, "user", null,
      policy({ "operation.delivery.dispatch": true }))).toBe(true);
  });
  it("denies the selected operation even when another operation in the same module is allowed", () => {
    expect(canSeeGate({ module: "store", operations: ["delivery.dispatch"] }, "manager", null,
      policy({ "operation.delivery.dispatch": false, "operation.delivery.manualProof": true }))).toBe(false);
  });
  it("a module does not reuse template grants after canonical delegation is enabled", () => {
    expect(canSeeGate({ roles: ["manager"], module: "store" }, "manager", { store: "FULL" }, policy({}))).toBe(false);
  });
  it("keeps administration gates reserved", () => {
    expect(canSeeGate({ adminOnly: true, operations: ["delivery.dispatch"] }, "user", null,
      policy({ "operation.delivery.dispatch": true }))).toBe(false);
  });
  it("requires actual combined cost visibility before showing an unmasked query", () => {
    const operation = OPERATION_PERMISSIONS.find((entry) => entry.delegable && entry.requiresCostVisibility);
    expect(operation).toBeDefined();
    const allowed = policy({ [operation!.key]: true });
    expect(canSeeGate({ operations: [operation!.path] }, "manager", null, allowed)).toBe(false);
    allowed.dataVisibility = { purchaseCost: true, profitMargin: true };
    expect(canSeeGate({ operations: [operation!.path] }, "user", null, allowed)).toBe(true);
  });
  it("uses reader navigation metadata and lets a query open an old FULL shell", () => {
    const operation = OPERATION_PERMISSIONS.find((entry) => entry.delegable && entry.kind === "query" && entry.navigationModule && entry.navigationModule !== entry.module)!;
    expect(operation).toBeDefined();
    expect(canSeeGate({ operations: [operation.path], module: operation.navigationModule!, level: "FULL" }, "user", null,
      { ...policy({ [operation.key]: true }), dataVisibility: { purchaseCost: true, profitMargin: true } })).toBe(true);
  });
  it("delegation bypasses focused cashier and courier sidebars without reusing template permissions", () => {
    const allowed = policy({ "operation.assets.list": true });
    for (const role of ["cashier", "courier"]) {
      const hrefs = visibleApplicationModules(role, null, allowed, true).map((entry) => entry.href);
      expect(hrefs.includes("/assets")).toBe(role !== "cashier");
      expect(hrefs).not.toContain("/my-deliveries");
    }
  });
  it("mobile generic candidates show independently delegated modules for focused base roles", () => {
    for (const role of ["cashier", "courier"]) {
      const hrefs = getMobileBottomNavItems(role, null, policy({ "operation.assets.list": true })).flatMap((entry) => entry.href ?? []);
      expect(hrefs.includes("/assets")).toBe(role !== "cashier");
      expect(hrefs).not.toContain("/my-deliveries");
    }
  });
  it("audit delegation is visible in both menus without requiring the auditor template", () => {
    const allowed = { ...policy({ "operation.audit.list": true, "operation.audit.facets": true }), dataVisibility: { purchaseCost: true, profitMargin: true } };
    expect(visibleApplicationModules("user", null, allowed, true).map((entry) => entry.href)).toContain("/audit");
    expect(getMobileBottomNavItems("courier", null, allowed).flatMap((entry) => entry.href ?? [])).toContain("/audit");
    expect(visibleApplicationModules("user", null, policy({}), true).map((entry) => entry.href)).not.toContain("/audit");
  });
  it("prioritizes explicitly delegated pages before broad module links and public defaults when mobile slots are full", () => {
    const allowed = {
      ...policy({ "operation.audit.list": true, "operation.assets.list": true, "operation.delivery.inTransit": true }),
      dataVisibility: { purchaseCost: true, profitMargin: true },
    };
    const hrefs = getMobileBottomNavItems("courier", null, allowed).flatMap((entry) => entry.href ?? []);
    expect(hrefs).toHaveLength(4);
    expect(hrefs[0]).toBe("/audit");
    expect(hrefs).not.toContain("/");
    expect(hrefs).not.toContain("/my-work");
  });
});

function mobileHrefs(
  role: string,
  permissionsOverride: Record<string, "NONE" | "READ" | "FULL"> | null = null,
) {
  return getMobileBottomNavItems(role, permissionsOverride).flatMap(
    (item) => item.href ?? [],
  );
}

describe("MobileBottomNav — عقود صلاحيات الأدوار", () => {
  it("لا يعرض للمندوب إلا توصيلاته قالبياً", () => {
    expect(mobileHrefs("courier")).toEqual(["/my-deliveries"]);
  });

  it("يحترم المنع الصريح لوحدات أمين المخزن", () => {
    expect(
      mobileHrefs("warehouse", {
        inventory: "NONE",
        purchases: "READ",
      }),
    ).toEqual(["/my-stocktake", "/purchases"]);
  });

  it("يرشّح شريط الكاشير المخصّص قبل حدّ العناصر الأربعة", () => {
    expect(
      mobileHrefs("cashier", {
        pos: "NONE",
        sales: "NONE",
        workorders: "FULL",
      }),
    ).toEqual(["/pos", "/invoices", "/work-orders", "/delivery"]);
  });

  it("يخفي التوصيل عند المنع الصريح لوحدة المتجر", () => {
    expect(mobileHrefs("cashier", { store: "NONE" })).not.toContain("/delivery");
  });

  it("لا يعرض الخزينة أو المطبعة للأدوار العامة التي لا تملك وحداتهما", () => {
    expect(mobileHrefs("print_operator")).toEqual([
      "/",
      "/invoices",
      "/work-orders",
    ]);
    expect(mobileHrefs("purchasing")).toEqual(["/"]);
  });

  it("يحترم المنع الصريح حتى للدور الإداري واسع الصلاحيات", () => {
    expect(
      mobileHrefs("manager", {
        sales: "NONE",
        workorders: "NONE",
        pos: "NONE",
        treasury: "NONE",
      }),
    ).toEqual(["/"]);
  });
});

describe("canSeeGate — قيود الدور", () => {
  it("بلا بوّابة ⇒ مرئي للكل", () => {
    expect(canSeeGate(undefined, "cashier", null)).toBe(true);
  });
  it("adminOnly: admin فقط، ولا يُفتح بمنح وحدة", () => {
    expect(canSeeGate({ adminOnly: true }, "admin", null)).toBe(true);
    expect(canSeeGate({ adminOnly: true }, "manager", null)).toBe(false);
    expect(canSeeGate({ adminOnly: true, module: "users" }, "cashier", { users: "FULL" })).toBe(false);
  });
  it("managerOnly: admin/manager فقط", () => {
    expect(canSeeGate({ managerOnly: true }, "manager", null)).toBe(true);
    expect(canSeeGate({ managerOnly: true }, "cashier", null)).toBe(false);
  });
  it("roles: الدور ضمن القائمة أو admin", () => {
    expect(canSeeGate({ roles: ["accountant"] }, "accountant", null)).toBe(true);
    expect(canSeeGate({ roles: ["accountant"] }, "admin", null)).toBe(true);
    expect(canSeeGate({ roles: ["accountant"] }, "cashier", null)).toBe(false);
  });
});

describe("canSeeGate — بوّابة الوحدة (الإصلاح الجوهريّ)", () => {
  it("module-only: دورٌ بلا القالب ولا منح صريح ⇒ محجوب (كان مرئياً فراغياً)", () => {
    // الكاشير reports=NONE قالبياً ⇒ تبويب تقارير module-only يجب أن يُحجب.
    expect(canSeeGate({ module: "reports" }, "cashier", null)).toBe(false);
  });
  it("module-only: دورٌ يملك القالب ⇒ مرئي (لا إفراط في الحجب)", () => {
    // الكاشير crm=FULL قالبياً ⇒ تبويب crm module-only يبقى مرئياً.
    expect(canSeeGate({ module: "crm" }, "cashier", null)).toBe(true);
  });
  it("module-only: admin يمرّ دائماً", () => {
    expect(canSeeGate({ module: "reports" }, "admin", null)).toBe(true);
  });
  it("module-only: منح صريح (override) يفتح رغم القالب NONE", () => {
    expect(canSeeGate({ module: "reports", level: "READ" }, "cashier", { reports: "READ" })).toBe(true);
  });
});

describe("canSeeGate — {roles + module}: مرآة requireModuleGate", () => {
  it("دورٌ خارج القائمة بقالبٍ يملك الوحدة لكن بلا منح صريح ⇒ محجوب (يطابق 403 الخادم)", () => {
    // الكاشير collections=READ قالبياً لكنه خارج [manager] ⇒ requireModuleGate يرفضه بلا منح صريح.
    expect(canSeeGate({ roles: ["manager"], module: "collections", level: "READ" }, "cashier", null)).toBe(false);
  });
  it("منح صريح للدور خارج القائمة ⇒ مرئي", () => {
    expect(
      canSeeGate({ roles: ["manager"], module: "collections", level: "READ" }, "cashier", { collections: "READ" }),
    ).toBe(true);
  });
  it("دورٌ ضمن القائمة بقالبٍ كافٍ ⇒ مرئي", () => {
    expect(canSeeGate({ roles: ["manager"], module: "collections", level: "READ" }, "manager", null)).toBe(true);
  });
  it("المنع الفردي يُنفّذ حتى على دور مسموح به", () => {
    expect(
      canSeeGate(
        { roles: ["manager", "accountant", "auditor"], module: "reports", level: "READ" },
        "manager",
        { reports: "NONE" },
      ),
    ).toBe(false);
  });
});

describe("تدقيق الدفتر المزدوج — مطابق لبوابة الخادم", () => {
  it("يظهر للأدمن فقط ولا تفتحه صلاحية reports أو دور manager", () => {
    expect(canSeeGate(RECONCILE_CONTROL_GATE, "admin", null)).toBe(true);
    expect(canSeeGate(RECONCILE_CONTROL_GATE, "manager", { reports: "FULL" })).toBe(false);
    expect(canSeeGate(RECONCILE_CONTROL_GATE, "accountant", { reports: "FULL" })).toBe(false);
    expect(canSeeGate(RECONCILE_CONTROL_GATE, "auditor", { reports: "FULL" })).toBe(false);
  });
});

describe("بوابة تعديل الفاتورة", () => {
  it("تتطلب قراءة المنتجات مع مبيعات كاملة أو استقبال كامل", () => {
    expect(canSeeGate(INVOICE_CORRECTION_GATE, "cashier", { workorders: "FULL", products: "NONE" })).toBe(false);
    expect(canSeeGate(INVOICE_CORRECTION_GATE, "cashier", { workorders: "FULL", products: "READ" })).toBe(true);
    expect(canSeeGate(INVOICE_CORRECTION_GATE, "manager", { sales: "FULL", products: "NONE" })).toBe(false);
    expect(canSeeGate(INVOICE_CORRECTION_GATE, "manager", { sales: "FULL", products: "READ" })).toBe(true);
    expect(canSeeGate(INVOICE_CORRECTION_GATE, "admin", null)).toBe(true);
  });
});
