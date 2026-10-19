import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readPage = (name: string) =>
  readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

const readComponent = (relative: string) =>
  readFileSync(new URL(`../../components/${relative}`, import.meta.url), "utf8");

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
      '<Redirect to="/returns?tab=purchases" />',
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
      new URL("../../components/navigation/HybridSidebarNav.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      "aria-disabled={!favorite && favoritesFull ? true : undefined}",
    );
    expect(source).toContain(
      "? `لا يمكن إضافة ${module.label} إلى المفضلة؛ بلغت الحد الأقصى`",
    );
    expect(source).not.toContain("disabled={!favorite && favoritesFull}");
  });

  it("locks restore controls once a destructive upload starts", () => {
    const source = readPage("Settings.tsx");
    const start = source.indexOf("async function handleDangerConfirm(");
    const end = source.indexOf("  const c = info.data?.counts;", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const restoreHandler = source.slice(start, end);

    // A cancellable read-only backup download shares this page. Destructive
    // restore uploads must still run to completion once the server starts.
    expect(restoreHandler).not.toContain("AbortController");
    expect(restoreHandler).not.toContain("AbortSignal");
    expect(restoreHandler).not.toMatch(/\bsignal\s*:/);
    expect(source).not.toContain("cancelRestoreUpload");
    expect(source).not.toContain("onCancelPending=");
    expect(restoreHandler).toContain("setRestoreUploadStreaming(true)");
    expect(restoreHandler).toContain("setRestoreUploadStreaming(false)");
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
      "enabled: canViewBrief && branchScope !== undefined",
    );
    expect(morningBrief).not.toContain("branches.data?.[0]?.id");
    expect(morningBrief).toContain(
      "`/reports/ar-reminders?branch=${branchScope}`",
    );
    expect(morningBrief).toContain(
      "href={`${workOrdersHref}?branch=${branchScope}`}",
    );
    expect(reminders).toContain(
      "requestedBranchId ?? accountBranchId ?? branches.data?.[0]?.id",
    );
  });

  it("uses unbounded server aggregates for dashboard sales", () => {
    const dashboard = readPage("Dashboard.tsx");
    const metricsBar = dashboard.slice(
      dashboard.indexOf("function MetricsBar("),
      dashboard.indexOf("/* ═══════════ ACTION BUTTON"),
    );

    expect(metricsBar).toContain("metrics.data?.todaySales");
    expect(metricsBar).toContain("includeTodaySales: true");
    expect(metricsBar).not.toContain("trpc.sales.list.useQuery");
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

describe("سلة البطاقات والمنتجات الموحّدة في POS", () => {
  const source =
    readPage("POS.tsx") + "\n" + readComponent("pos/usePOSCatalogSearch.ts");

  it("يقبل المنتجات والبطاقات في نيّة موحّدة بدلاً من فصل السلتين", () => {
    expect(source).not.toContain("DIGITAL_CART_BLOCKS_REGULAR_MESSAGE");
    expect(source).not.toContain("REGULAR_CART_BLOCKS_DIGITAL_MESSAGE");
    expect(source).toContain("regularLines: cart.filter((c) => !c.digital)");
    expect(source).toContain("providerBasketKey: c.digital!.providerBasketKey");
  });

  it("يبقي الاتصال مطلوباً ويضيف المجموعة كاملةً مع مرجع واحد", () => {
    expect(source).toContain("cardsDisabled={offline}");
    expect(source).toContain("onPickBasket={addDigitalBasket}");
    expect(source).toContain("existingCardCount={digitalLines.length}");
  });

  it("يسمح بمسح المنتجات بعد إضافة البطاقات دون حارس فصل قديم", () => {
    const lookupBarcode = source.slice(
      source.indexOf("const lookupBarcode = useCallback"),
      source.indexOf("const { handleKeyDown: handleScanKeyDown }"),
    );
    const addRow = source.slice(
      source.indexOf("function addRow("),
      source.indexOf("function changeQty("),
    );

    expect(source).toContain("useBarcodeScanner(handleHidScan");
    expect(lookupBarcode).not.toContain("if (cartHasDigitalRef.current)");
    expect(lookupBarcode).toContain("else addRow(row as PosRow)");
    expect(addRow).not.toContain("if (cartHasDigitalRef.current)");
  });

  it("يوضح شروط الدفع ويطبع الأسطر المحفوظة من الخادم", () => {
    expect(source).toContain('data-testid="pos-cart-mode-guard"');
    expect(source).toContain("البطاقات والمنتجات في فاتورة واحدة");
    expect(source).toContain("digitalCheckoutReceiptLines(r.receiptLines)");
  });
});

describe("حزمة استمارة التوظيف والتعيين الكاملة", () => {
  it("تقسم الاسم العربي الكامل إلى الأول والأب والجد واللقب بدقة لجميع الحالات", async () => {
    const { splitFullArabicName } = await import("../../../../shared/hr");

    expect(splitFullArabicName("")).toEqual({
      firstName: "",
      fatherName: "",
      grandfatherName: "",
      lastName: "",
    });
    expect(splitFullArabicName("   ")).toEqual({
      firstName: "",
      fatherName: "",
      grandfatherName: "",
      lastName: "",
    });
    expect(splitFullArabicName("أحمد")).toEqual({
      firstName: "أحمد",
      fatherName: "",
      grandfatherName: "",
      lastName: "",
    });
    expect(splitFullArabicName("أحمد علي")).toEqual({
      firstName: "أحمد",
      fatherName: "علي",
      grandfatherName: "",
      lastName: "",
    });
    expect(splitFullArabicName("أحمد علي حسن")).toEqual({
      firstName: "أحمد",
      fatherName: "علي",
      grandfatherName: "حسن",
      lastName: "",
    });
    expect(splitFullArabicName("أحمد علي حسن الشمري")).toEqual({
      firstName: "أحمد",
      fatherName: "علي",
      grandfatherName: "حسن",
      lastName: "الشمري",
    });
    expect(splitFullArabicName("أحمد   علي   حسن   جاسم   الشمري")).toEqual({
      firstName: "أحمد",
      fatherName: "علي",
      grandfatherName: "حسن",
      lastName: "جاسم الشمري",
    });
    expect(splitFullArabicName("عبد الرحمن سعد الدين محمد العبيدي")).toEqual({
      firstName: "عبد الرحمن",
      fatherName: "سعد الدين",
      grandfatherName: "محمد",
      lastName: "العبيدي",
    });
    expect(splitFullArabicName("أبو بكر عبد الله جاسم آل ياسين")).toEqual({
      firstName: "أبو بكر",
      fatherName: "عبد الله",
      grandfatherName: "جاسم",
      lastName: "آل ياسين",
    });
  });

  it("يطبع رقم الهاتف العراقي مع دعم الأرقام العربية المشرقية واللصق واللواصق الدولية", async () => {
    const { normalizeIraqiPhone, IRAQI_MOBILE_RE } = await import("../../../../shared/hr");

    expect(normalizeIraqiPhone("", true)).toBe("");
    expect(normalizeIraqiPhone("+964", true)).toBe("");
    expect(normalizeIraqiPhone("+964")).toBe("+964");
    expect(normalizeIraqiPhone("٠٧٧٠١٢٣٤٥٦٧")).toBe("+9647701234567");
    expect(normalizeIraqiPhone("+96407701234567")).toBe("+9647701234567");
    expect(normalizeIraqiPhone("00964 780 123 4567")).toBe("+9647801234567");
    expect(normalizeIraqiPhone("077012345678")).toBe("+96477012345678");
    expect(IRAQI_MOBILE_RE.test(normalizeIraqiPhone("077012345678"))).toBe(false);
  });

  it("يعرض البريد الإلكتروني والحقول الكاملة في استمارة التقديم العامة والورقية وربط التعيين", () => {
    const jobApply = readPage("JobApply.tsx");
    const recruitment = readPage("Recruitment.tsx");
    const dialogs = readComponent("hr/RecruitmentApplicantDialogs.tsx");
    const employeeNew = readPage("EmployeeNew.tsx");

    // استمارة التقديم العامة (/apply)
    expect(jobApply).toContain("email: email.trim() || undefined");
    expect(jobApply).toContain("whatsappPhone: whatsappPhone.trim() || undefined");
    expect(jobApply).toContain("governorate: governorate.trim() || undefined");
    expect(jobApply).toContain("degree: (degree || undefined) as never");
    expect(jobApply).toContain("availabilityStatus: (availabilityStatus || undefined) as never");
    expect(jobApply).toContain("preferredBranch: preferredBranch.trim() || undefined");
    expect(jobApply).toContain("(APPLICANT_PREFERRED_BRANCHES as readonly string[]).includes(vacancy.location)");
    expect(jobApply).toContain("shiftPreference: (shiftPreference || undefined) as never");
    expect(jobApply).toContain("expectedSalary:");

    // لوحة التوظيف وحوارات المتقدمين
    expect(recruitment).toContain("exportApplicants");
    expect(recruitment).toContain("تعيين كموظف");
    expect(recruitment).toContain("trpc.employees.formOptions.useQuery");
    expect(recruitment).toContain("canChooseCompanyWide");
    expect(dialogs).toContain("trpc.recruitment.setRating.useMutation");
    expect(dialogs).toContain("saveReview.mutate({ id: a.id, rating: r })");
    expect(dialogs).toContain("convertedEmployeeId");
    expect(dialogs).toContain("canChooseCompanyWide");
    expect(dialogs).toContain("vacancyId: vacancyId ? Number(vacancyId) : undefined");
    expect(dialogs).toContain("branchId: branchId ? Number(branchId) : undefined");
    expect(dialogs).toContain("appliedDate: appliedDate.trim() || undefined");
    expect(dialogs.split(/\r?\n/).length).toBeLessThanOrEqual(400);

    // صفحة إضافة موظف جديد مع التعبئة التلقائية من طلب التوظيف والتحويل الذرّي
    expect(employeeNew).toContain("applicantId");
    expect(employeeNew).toContain("useSearch");
    expect(employeeNew).toContain("prefilledApplicantIdRef");
    expect(employeeNew).toContain("applicantId: !isEdit && applicantId ? applicantId : undefined");
    expect(employeeNew).toContain("utils.recruitment.get.invalidate({ id: applicantId })");
    expect(employeeNew).toContain("alreadyConvertedEmployeeId");
    expect(employeeNew).not.toContain("markApplicantAcceptedIfNeeded");
    expect(employeeNew).not.toContain("emergencyContactPhone: a.whatsappPhone");
    expect(employeeNew).not.toContain('degree: a.degree || "بكالوريوس"');
    expect(employeeNew).not.toContain("Number(a.expectedSalary)");
    expect(employeeNew).toContain("trpc.recruitment.get.useQuery");
    expect(employeeNew).toContain("splitFullArabicName");
  });
});


