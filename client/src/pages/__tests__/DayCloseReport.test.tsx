import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { moduleAccessAllowed } from "@shared/permissions";

const readPage = (name: string) =>
  readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const readCashService = () =>
  readFileSync(new URL("../../../../server/services/cashDailyReconciliationService.ts", import.meta.url), "utf8");
const readDayCloseService = () =>
  readFileSync(new URL("../../../../server/services/reportsDayCloseService.ts", import.meta.url), "utf8");
const readTreasuryRouter = () =>
  readFileSync(new URL("../../../../server/routers/treasuryRouter.ts", import.meta.url), "utf8");

describe("عقد صلاحيات وحالات تحميل المطابقة اليومية والعهد", () => {
  it("يعرض الحل بسند تصحيح كحالة تاريخية صادقة لا كمطابقة", () => {
    const source = readPage("DayCloseReport.tsx");
    expect(source).toContain('saved.status === "RESOLVED_WITH_ADJUSTMENT"');
    expect(source).toContain("محلول بسند تصحيح");
    expect(source).toContain("رقم قضية فرق النقد");
  });

  it("يطابق زر إدارة المطابقة بوابة الخادم ويدعم المنح الصريح", () => {
    const source = readPage("DayCloseReport.tsx");

    expect(source).toContain("const canManageDaily = moduleAccessAllowed(");
    expect(source).toContain('["manager", "accountant"]');
    expect(
      moduleAccessAllowed(
        "auditor",
        { treasury: "FULL" },
        "treasury",
        "FULL",
        ["manager", "accountant"],
      ),
    ).toBe(true);
    expect(
      moduleAccessAllowed(
        "accountant",
        { treasury: "NONE" },
        "treasury",
        "FULL",
        ["manager", "accountant"],
      ),
    ).toBe(false);
  });

  it("يرسل إعادة الفتح بنسخة متوقعة ومفتاح ثابت لا يدوّر إلا بعد النجاح", () => {
    const source = readPage("DayCloseReport.tsx");

    expect(source).toContain("const [reopenRequestId, setReopenRequestId] = useState(newClientRequestId)");
    expect(source).toContain("expectedVersion: Number(saved.version)");
    expect(source).toContain("clientRequestId: reopenRequestId");
    expect(source).toContain("reopenReason.trim().length < 10 || !reopenRequestId");
    expect(source).toContain("setReopenRequestId(newClientRequestId());");
  });

  it("يقفل إعادة الفتح على الحالة والنسخة ويفحص idempotency بعد القفل", () => {
    const source = readCashService();
    const routerSource = readTreasuryRouter();
    const routerContract = routerSource.slice(
      routerSource.indexOf("reopenDailyCashReconciliation:"),
      routerSource.indexOf("pendingHandoverReceipts:"),
    );

    expect(routerContract).toContain("expectedVersion: z.number().int().positive()");
    expect(routerContract).toContain("clientRequestId: z.string().trim().min(1).max(64)");
    expect(source).toContain("checkReopenIdempotencyCurrentTx(");
    expect(source).toContain('eq(cashDailyReconciliations.status, "CLOSED")');
    expect(source).toContain("eq(cashDailyReconciliations.version, input.expectedVersion)");
    expect(source).toContain("if (affectedRows !== 1)");
    expect(source).toContain("await recordIdempotencyKey(");
    expect(source).toContain("reopenedVersion: input.expectedVersion + 1");
  });

  it("لا يخفي فشل تحميل طابور العهد أو العهد الشخصية أو قائمة المستلمين", () => {
    const treasurySource = readPage("Treasury.tsx");
    const handoversSectionSource = readFileSync(
      new URL("../../components/treasury/PendingHandoversSection.tsx", import.meta.url),
      "utf8",
    );
    const source = `${treasurySource}\n${handoversSectionSource}`;

    for (const query of ["pendingQueue", "pendingHandovers", "handoverRecipients"]) {
      expect(source).toContain(`${query}.isLoading`);
      expect(source).toContain(`${query}.isError`);
      expect(source).toContain(`${query}.refetch()`);
    }
    expect(source).toContain("لا يمكن افتراض عدم وجود عهد");
    expect(source).toContain("أُوقفت إعادة الإسناد لحين نجاح التحميل");
    expect(source).toContain("const canGovernHandovers = moduleAccessAllowed(");
    expect(source).toContain("enabled: canGovernHandovers");
    expect(source).not.toContain("enabled: isAdmin || isManager");
  });

  it("يعرض التدفقات النقدية المباشرة (DirectOperationsPanel) ولا يخفي النقد عند عدم وجود ورديات", () => {
    const source = readPage("DayCloseReport.tsx");

    expect(source).toContain("import { DirectOperationsPanel } from");
    expect(source).toContain("dc.shifts.length === 0 && dc.directOperations.receiptCount === 0");
    expect(source).toContain("<DirectOperationsPanel direct={dc.directOperations}");
    expect(source).toContain("fmtAr(dc.totals.closedExpected)");
    expect(source).toContain("حركة نقدية مباشرة (خارج الأدراج)");
  });

  it("يشمل التدفقات النقدية المباشرة في التصدير والطباعة لمنع تداول تقرير ناقص", () => {
    const source = readPage("DayCloseReport.tsx");

    expect(source).toContain("dc.directOperations.receiptCount > 0");
    expect(source).toContain('shiftId: "مباشر"');
    expect(source).toContain('userName: "الخزينة المباشرة (خارج الأدراج)"');
    expect(source).toContain("صافي المقبوضات المباشرة (الخزينة)");
    expect(source).toContain("محصلة حركة اليوم (ليست الرصيد النهائي)");
    expect(source).toContain("الرقم النهائي المتوقع");
  });

  it("يفصل موضع النقد النهائي عن حجم حركة اليوم ولا يجمع المغلق مع الخزينة مرتين", () => {
    const source = readPage("DayCloseReport.tsx");
    const service = readDayCloseService();

    expect(source).toMatch(/الموقف النقدي النهائي\s*للـ?فرع/);
    expect(source).toContain("الخزينة + الأدراج المفتوحة + النقد بالطريق");
    expect(source).not.toContain("D(dc.totals.physicalDrawerCash).plus(saved.countedTreasuryCash)");
    expect(service).toContain("expectedCashOnHand");
    expect(service).toMatch(/expectedTreasuryCash\s*\.plus\(expectedDrawersCash\)/);
    expect(service).toContain("closedByCutoff");
    expect(service).toContain("lt(eventAt, endExclusive)");
    expect(source).toContain('blocker.code === "STALE_EVIDENCE"');
    expect(source).toContain('saved?.status !== "REOPENED"');
    expect(source).toContain("D(saved.countedTreasuryCash).minus(position.expectedCashOnHand).toFixed(2)");
  });
});
