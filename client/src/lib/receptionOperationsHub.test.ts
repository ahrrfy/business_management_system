/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import path from "node:path";
import * as React from "react";
import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { PageTabs, type HubTab } from "@/components/PageTabs";
import { canSeeGate } from "@/lib/navVisibility";
import {
  RECEPTION_INVOICES_GATE,
  RECEPTION_OPERATION_TAB_DEFINITIONS,
  RECEPTION_STATION_GATE,
  visibleReceptionOperationTabs,
} from "@/lib/receptionOperationsHub";

const browser = vi.hoisted(() => ({
  location: "/reception/operations",
  search: "",
  navigate: vi.fn(),
}));

vi.mock("wouter", () => ({
  useLocation: () => [browser.location, browser.navigate],
  useSearch: () => browser.search,
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    auth: {
      me: {
        useQuery: () => ({
          data: { role: "cashier", permissionsOverride: null },
        }),
      },
    },
  },
}));

// إعداد unit الحالي لا يحمّل vite-react؛ صفحات المشروع تعتمد JSX runtime الذي
// يوفّره Vite إنتاجياً، فنوفّر React عالمياً لهذا الاختبار السلوكي المعزول.
(globalThis as typeof globalThis & { React: typeof React }).React = React;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const source = readFileSync(
  path.resolve(process.cwd(), "client/src/pages/ReceptionOperationsHub.tsx"),
  "utf8",
);
const pageTabsSource = readFileSync(
  path.resolve(process.cwd(), "client/src/components/PageTabs.tsx"),
  "utf8",
);
const appSource = readFileSync(
  path.resolve(process.cwd(), "client/src/App.tsx"),
  "utf8",
);
const cashierHomeSource = readFileSync(
  path.resolve(process.cwd(), "client/src/components/dashboard/CashierHome.tsx"),
  "utf8",
);

const visibleFor = (
  role: Parameters<typeof canSeeGate>[1],
  override: Parameters<typeof canSeeGate>[2] = null,
) =>
  visibleReceptionOperationTabs({
    hasBranch: true,
    role,
    permissionsOverride: override,
  });

describe("ReceptionOperationsHub", () => {
  it("يثبت ترتيب التبويبات وعقد الرابط الافتراضي", () => {
    expect(RECEPTION_OPERATION_TAB_DEFINITIONS.map((tab) => tab.value)).toEqual(
      ["orders", "invoices", "workflow", "handover"],
    );
    expect(RECEPTION_OPERATION_TAB_DEFINITIONS[0]?.value).toBe("orders");
  });

  it("يغلق المركز على workorders FULL ولا توسع بوابة الفواتير الوصول", () => {
    expect(canSeeGate(RECEPTION_STATION_GATE, "cashier", null)).toBe(true);
    expect(
      canSeeGate(RECEPTION_STATION_GATE, "cashier", { workorders: "READ" }),
    ).toBe(false);
    expect(canSeeGate(RECEPTION_STATION_GATE, "accountant", null)).toBe(false);

    // sales_rep يمر من نطاق الفواتير العام، لكنه لا يمر من محطة الاستقبال.
    expect(canSeeGate(RECEPTION_INVOICES_GATE, "sales_rep", null)).toBe(false);
    expect(canSeeGate(RECEPTION_INVOICES_GATE, "cashier", null)).toBe(true);
  });

  it("يعرض لكل دور التبويبات التي تقبلها قدراته فقط", () => {
    expect(visibleFor("manager")).toEqual([
      "orders",
      "invoices",
      "workflow",
      "handover",
    ]);
    expect(visibleFor("cashier")).toEqual(["orders", "invoices", "handover"]);
    expect(visibleFor("print_operator")).toEqual(["orders"]);
    expect(visibleFor("accountant")).toEqual([]);
    expect(visibleFor("cashier", { treasury: "NONE" })).toEqual(["orders"]);
    expect(visibleFor("cashier", { store: "READ" })).toEqual([
      "orders",
      "handover",
    ]);
    expect(visibleFor("cashier", { products: "NONE" })).toEqual(["orders"]);
    expect(
      visibleReceptionOperationTabs({
        hasBranch: false,
        role: "manager",
        permissionsOverride: null,
      }),
    ).toEqual([]);
  });

  it("يحمل الصفحات الأربع كسولاً ولا يستورد أياً منها استيراداً eager", () => {
    const pageModules = [
      "ReceptionOrdersPage",
      "ReceptionInvoicesPage",
      "ReceptionWorkflowPage",
      "ReceptionHandoverPage",
    ];

    for (const page of pageModules) {
      expect(source).toMatch(
        new RegExp(
          `lazy\\(\\s*\\(\\) => import\\("@/pages/reception/${page}"\\),?\\s*\\)`,
        ),
      );
    }
    expect(source).not.toMatch(
      /^import\s+.+\s+from\s+["']@\/pages\/reception\/Reception(?:Orders|Invoices|Workflow|Handover)Page["'];?$/m,
    );
    expect(source).toContain("const me = trpc.auth.me.useQuery()");
    expect(source).toContain("if (me.data.branchId == null)");
    expect(source).toContain("<PageTabs tabs={TABS}");

    // PageTabs يصفّي قبل اختيار المكوّن، ويسقط للرأس المرئي، ولا يجبر panels
    // المخفية على التركيب؛ لذا لا تنفّذ React.lazy import ولا استعلامات الصفحة.
    expect(pageTabsSource).toContain(
      "const visible = tabs.filter((t) => canSeeGate(t.gate, role, permsOverride))",
    );
    expect(pageTabsSource).toContain(
      "const active = visible.find((t) => t.value === requested) ?? visible[0]",
    );
    expect(pageTabsSource).not.toContain("forceMount");
  });

  it("يبقي محطة إنشاء الطلب منفصلة ويوجه المسارات القديمة إلى المركز مع حفظ query", () => {
    expect(appSource).toContain('<Route path="/reception">');
    expect(appSource).toContain('<Redirect to="/pos?mode=RECEPTION" />');
    expect(appSource).toContain('<Route path="/reception/operations">');
    for (const tab of ["orders", "invoices", "workflow", "handover"]) {
      expect(appSource).toContain(
        `<RedirectKeepQuery to="/reception/operations?tab=${tab}" />`,
      );
      expect(cashierHomeSource).toContain(
        `href: "/reception/operations?tab=${tab}"`,
      );
    }
  });

  it("يتبع رابط URL، يسقط من الممنوع، ولا يركب المحتوى المخفي", async () => {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    window.requestAnimationFrame = (callback) => {
      callback(0);
      return 1;
    };
    window.cancelAnimationFrame = vi.fn();

    const mounts = { orders: 0, restricted: 0, workflow: 0 };
    const probe =
      (name: keyof typeof mounts): ComponentType =>
      () => {
        mounts[name] += 1;
        return createElement("div", null, `panel:${name}`);
      };
    const tabs: HubTab[] = [
      { value: "orders", label: "الطلبات", Component: probe("orders") },
      {
        value: "restricted",
        label: "ممنوع",
        gate: { managerOnly: true },
        Component: probe("restricted"),
      },
      { value: "workflow", label: "المعالجة", Component: probe("workflow") },
    ];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      // رابط ممنوع/قديم: PageTabs يعرض أول تبويب مرئي ولا يركّب الممنوع أو الخفي.
      browser.search = "tab=restricted";
      await act(async () => {
        root.render(
          createElement(PageTabs, {
            tabs,
            ariaLabel: "اختبار عمليات الاستقبال",
          }),
        );
      });
      expect(container.textContent).toContain("panel:orders");
      expect(container.textContent).not.toContain("panel:restricted");
      expect(container.textContent).not.toContain("panel:workflow");
      expect(mounts).toEqual({ orders: 1, restricted: 0, workflow: 0 });

      // refresh/back ممثلان بإعادة التصيير من قيمة URL نفسها؛ المصدر هو URL لا state محلي.
      browser.search = "tab=workflow";
      await act(async () => {
        root.render(
          createElement(PageTabs, {
            tabs,
            ariaLabel: "اختبار عمليات الاستقبال",
          }),
        );
      });
      expect(container.textContent).toContain("panel:workflow");
      expect(container.textContent).not.toContain("panel:orders");
      expect(mounts.restricted).toBe(0);

      browser.navigate.mockClear();
      const ordersTrigger = Array.from(
        container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
      ).find((element) => element.textContent === "الطلبات");
      expect(ordersTrigger).toBeDefined();
      await act(async () => {
        ordersTrigger?.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true, button: 0 }),
        );
      });
      expect(browser.navigate).toHaveBeenCalledWith("/reception/operations");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      browser.search = "";
      browser.navigate.mockReset();
    }
  });
});
