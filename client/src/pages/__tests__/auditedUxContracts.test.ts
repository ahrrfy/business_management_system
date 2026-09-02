import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readPage = (name: string) =>
  readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

describe("audited public UX contracts", () => {
  it("keeps the jobs marquee semantic once and delegates modal focus to Dialog", () => {
    const source = readPage("JobApply.tsx");

    expect(source).toContain('<ul className="sr-only">');
    expect(source).toContain('<div className="cj-track" aria-hidden="true">');
    expect(source).toContain("<DialogContent");
    expect(source).toContain("onOpenAutoFocus=");
    expect(source).toContain("<DialogClose asChild>");
    expect(source).not.toContain('role="dialog"');
  });

  it("keeps delivery settlement navigation reactive on the same route", () => {
    const source = readPage("DeliveryHub.tsx");
    const hub = source.slice(
      source.indexOf("export default function DeliveryHub()"),
      source.indexOf("// ───────────────────────── تبويب: جاهز للإرسال"),
    );

    expect(hub).toContain("const search = useSearch();");
    expect(hub).toContain("setTab(readTabFromSearch(search));");
    expect(hub).toContain("}, [search]);");
    expect(source).toContain(
      "href={`/delivery?tab=settle&party=${r.partyId}`}",
    );
  });

  it("distinguishes an empty catalog from an empty filtered result", () => {
    const source = readPage("Storefront.tsx");

    expect(source).toContain("const isEmptyCatalog =");
    expect(source).toContain("لا توجد منتجات معروضة حالياً");
    expect(source).toContain("لا توجد نتائج مطابقة للبحث أو الفلاتر");
    expect(source).toContain("مسح البحث والفلاتر");
  });

  it("does not advertise an unsupported purchase-return draft", () => {
    const legacyEntry = readPage("PurchaseReturnNew.tsx");
    const governance = readPage("PurchaseReturnsGovernance.tsx");

    expect(legacyEntry).toContain(
      '<Redirect to="/purchases/returns-governance" />',
    );
    expect(legacyEntry).not.toContain("PURCHASE_RETURN_ACTIONS");
    expect(legacyEntry).not.toContain("trpc.purchaseReturns.create");
    expect(legacyEntry).not.toContain("handleSaveDraft");
    expect(governance).toContain(
      "trpc.purchaseReturnGovernance.requestReturn.useMutation",
    );
    expect(governance).toContain(
      "trpc.purchaseReturnGovernance.decideReturn.useMutation",
    );
    expect(governance).toContain(
      'description="طلب المرتجع وعكسه، اعتماد مستقل، وأثر مخزون وذمة موثّق بعد القرار فقط."',
    );
  });

  it("keeps full favorites controls keyboard-focusable and explains their disabled state", () => {
    const source = readFileSync(
      new URL("../../components/AppLayout.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      "aria-disabled={!favorite && favoritesFull ? true : undefined}",
    );
    expect(source).toContain(
      "? `لا يمكن إضافة ${m.label} إلى المفضلة؛ بلغت الحد الأقصى`",
    );
    expect(source).not.toContain("disabled={!favorite && favoritesFull}");
  });

  it("locks restore controls once a destructive upload starts", () => {
    const source = readPage("Settings.tsx");

    expect(source).not.toContain("AbortController");
    expect(source).not.toContain("cancelRestoreUpload");
    expect(source).not.toContain("onCancelPending=");
    expect(source).toContain("setRestoreUploadStreaming(true)");
    expect(source).toContain("setRestoreUploadStreaming(false)");
  });

  it("keeps today's actionable reminder count in the same branch scope as its queue", () => {
    const dashboard = readPage("Dashboard.tsx");
    const morningBrief = dashboard.slice(
      dashboard.indexOf("function MorningBrief({"),
      dashboard.indexOf("const PromiseIco"),
    );
    const reminders = readPage("ARReminders.tsx");

    expect(dashboard).toContain('aria-label="نطاق فرع الشاشة الرئيسية"');
    expect(morningBrief).toContain(
      "enabled: elevated && branchScope !== undefined",
    );
    expect(morningBrief).not.toContain("branches.data?.[0]?.id");
    expect(morningBrief).toContain(
      "href={`/reports/ar-reminders?branch=${branchScope}`}",
    );
    expect(morningBrief).toContain(
      "href={`/work-orders?branch=${branchScope}`}",
    );
    expect(reminders).toContain(
      "requestedBranchId ?? accountBranchId ?? branches.data?.[0]?.id",
    );
  });

  it("uses unbounded server aggregates for dashboard sales and personal tasks", () => {
    const dashboard = readPage("Dashboard.tsx");
    const metricsBar = dashboard.slice(
      dashboard.indexOf("function MetricsBar("),
      dashboard.indexOf("/* ═══════════ ACTION BUTTON"),
    );
    const tasksBrief = dashboard.slice(
      dashboard.indexOf("function TasksBrief("),
      dashboard.indexOf("/* ═══════════ مساحة عمل الكاشير"),
    );

    expect(metricsBar).toContain("metrics.data?.todaySales");
    expect(metricsBar).toContain("includeTodaySales: true");
    expect(metricsBar).not.toContain("trpc.sales.list.useQuery");
    expect(tasksBrief).toContain("metrics.data?.morningBrief.myOpenTasks");
    expect(tasksBrief).not.toContain("trpc.tasks.list.useQuery");
  });

  it("starts both receivable and payable action queues in the account branch", () => {
    const ar = readPage("ARReminders.tsx");
    const ap = readPage("APReminders.tsx");

    for (const source of [ar, ap]) {
      expect(source).toContain("dashboardActionBranchId(me.data?.branchId)");
      expect(source).toContain("accountBranchId ?? branches.data?.[0]?.id");
      expect(source).not.toContain(
        "«برنامج اليوم» ولوحة التحكم تجمعان كل الفروع",
      );
    }
  });

  it("does not offer a cross-branch work-order filter to a branch manager", () => {
    const source = readPage("WorkOrders.tsx");

    expect(source).toContain(
      'const canCrossBranches = me.data?.role === "admin"',
    );
    expect(source).toContain("{canCrossBranches && (");
    expect(source).toContain(
      'branchId: canCrossBranches && f.branch !== "all"',
    );
  });

  it("does not offer cross-branch task reads or writes to a branch manager", () => {
    const source = readPage("TasksHub.tsx");

    expect(source).toContain('const canCrossBranches = role === "admin"');
    expect(source).toContain("<ListTab isElevated={canCrossBranches}");
    expect(source).toContain("isElevated={canCrossBranches}");
  });

  it("keeps aging and stocktake destination filters within manager branch authority", () => {
    const aging = readPage("ARAging.tsx");
    const stocktakes = readPage("Stocktakes.tsx");

    expect(aging).toContain(
      'const canCrossBranches = me.data?.role === "admin"',
    );
    expect(aging).toContain("{canCrossBranches && (");
    expect(stocktakes).toContain("{isAdmin && (");
    expect(stocktakes).toContain("enabled: isAdmin");
  });

  it("integrates MobileBottomNav and responsive card view in AppLayout and Invoices", () => {
    const appLayoutSource = readFileSync(
      new URL("../../components/AppLayout.tsx", import.meta.url),
      "utf8",
    );
    expect(appLayoutSource).toContain("<MobileBottomNav");
    expect(appLayoutSource).toContain("pb-24 lg:pb-6");

    const invoicesSource = readPage("Invoices.tsx");
    expect(invoicesSource).toContain("mobileCardRenderer=");
    expect(invoicesSource).toContain("<MobileDataCard");

    const dataTableSource = readFileSync(
      new URL("../../components/data-table/DataTable.tsx", import.meta.url),
      "utf8",
    );
    expect(dataTableSource).toContain(
      "mobileCardRenderer?: (row: T, index: number) => React.ReactNode",
    );
    expect(dataTableSource).toContain("md:hidden space-y-2.5");
  });

  it("keeps report catalog navigation consolidated around the canonical hubs", () => {
    const reportsCenter = readPage("ReportsCenter.tsx");

    expect(reportsCenter).toContain('href: "/reports/sales-hub"');
    expect(reportsCenter).toContain('href: "/reports/profitability"');
    expect(reportsCenter).not.toContain('href: "/sales-report"');
    expect(reportsCenter).not.toContain('href: "/reports/sales-register"');
    expect(reportsCenter).not.toContain('href: "/reports/sales-by-dimension"');

    expect(reportsCenter).toContain('href: "/reports/aging-hub"');
    expect(reportsCenter).not.toContain('href: "/ar-aging"');
    expect(reportsCenter).not.toContain('href: "/ap-aging"');
    expect(reportsCenter).not.toContain('href: "/reports/aging-detail"');
  });

  it("keeps report tabs aligned with reportViewerProcedure", () => {
    for (const page of ["SalesHub.tsx", "SuppliersHub.tsx", "CrmHub.tsx", "ReportsHub.tsx"]) {
      const source = readPage(page);
      const gate = source.slice(
        source.indexOf("const REPORT_VIEWER_GATE"),
        source.indexOf("const TABS"),
      );
      expect(gate, page).toContain('roles: ["manager", "accountant", "auditor"]');
      expect(gate, page).toContain('module: "reports"');
      expect(gate, page).toContain('level: "READ"');
      expect(source, page).toContain("gate: REPORT_VIEWER_GATE");
    }
  });
});
