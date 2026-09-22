import { describe, expect, it } from "vitest";
import { APPLICATION_MODULES } from "./moduleRegistry";
import {
  findSidebarModule,
  groupSidebarModules,
  isSidebarHrefActive,
} from "./sidebarNavigation";

describe("sidebarNavigation", () => {
  it("يفصل المداخل ذات المسار نفسه حسب tab", () => {
    expect(isSidebarHrefActive("/crm", "tab=inbox", "/crm?tab=inbox")).toBe(true);
    expect(isSidebarHrefActive("/crm", "tab=pipeline", "/crm?tab=inbox")).toBe(false);
    expect(isSidebarHrefActive("/crm/customer/7", "tab=inbox", "/crm?tab=inbox")).toBe(true);
  });

  it("يعامل /pos بلا mode كتجزئة ولا يخلطه بمحطتي الطباعة والاستقبال", () => {
    expect(isSidebarHrefActive("/pos", "", "/pos?mode=RETAIL")).toBe(true);
    expect(isSidebarHrefActive("/pos", "", "/pos?mode=PRINT_SERVICES")).toBe(false);
    expect(isSidebarHrefActive("/pos", "mode=RECEPTION", "/pos?mode=RECEPTION")).toBe(true);
    expect(isSidebarHrefActive("/pos", "mode=RECEPTION", "/pos?mode=RETAIL")).toBe(false);
  });

  it("يحافظ على مطابقة جذر الوحدة للشاشات التفصيلية", () => {
    expect(isSidebarHrefActive("/invoices/91", "print=1", "/invoices")).toBe(true);
    expect(isSidebarHrefActive("/inventory-movements", "", "/inventory")).toBe(false);
  });

  it("يجمع الوحدات بترتيب الأقسام المستقر من دون فقد وحدة", () => {
    const groups = groupSidebarModules(APPLICATION_MODULES);
    expect(groups.map((group) => group.id)).toEqual([1, 2, 3, 4, 5]);
    expect(groups.flatMap((group) => group.modules)).toHaveLength(APPLICATION_MODULES.length);
    for (const group of groups) {
      expect(group.modules).toEqual(
        APPLICATION_MODULES.filter((module) => module.section === group.id),
      );
    }
  });

  it("يحل مدخل workspace إلى أقرب جذر وحدة", () => {
    expect(findSidebarModule("/purchases/new", APPLICATION_MODULES)?.id).toBe("purchases");
    expect(findSidebarModule("/crm?tab=quotations", APPLICATION_MODULES)?.id).toBe("crm");
    expect(findSidebarModule("/my-stocktake", APPLICATION_MODULES)).toBeNull();
  });
});
