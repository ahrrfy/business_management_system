import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { moduleAccessAllowed } from "@shared/permissions";

const readPage = (name: string) =>
  readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const readCashService = () =>
  readFileSync(new URL("../../../../server/services/cashDailyReconciliationService.ts", import.meta.url), "utf8");
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
    const source = readPage("Treasury.tsx");

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
});
