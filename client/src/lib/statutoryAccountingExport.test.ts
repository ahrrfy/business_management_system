import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildBalanceStatementRows,
  buildIncomeStatementRows,
  buildStatutoryHashMaterial,
  reconstructStatutoryHashPayload,
  requireCompleteStatutoryExport,
} from "./statutoryAccountingExport";

const source = {
  profileId: 1,
  profileVersion: 2,
  accountId: 10,
  code: "110",
  name: "الصندوق",
  amount: "100.00",
};

describe("statutory accounting export", () => {
  it("يرفض ملفاً مبتوراً ويسمح بالنتيجة المكتملة", () => {
    expect(() => requireCompleteStatutoryExport({ rows: [1], export: { complete: false, rowLimit: 10_000 } }, "اليومية")).toThrow(/10,000 سطر/);
    expect(requireCompleteStatutoryExport({ rows: [1], export: { complete: true, rowLimit: 10_000 } }, "اليومية")).toEqual([1]);
  });

  it("يبني صفوف المركز المالي المرئية والمصدرة من مصدر واحد شامل", () => {
    const rows = buildBalanceStatementRows({
      assets: [source],
      liabilities: [{ ...source, accountId: 20, code: "211", name: "ذمم الموردين", amount: "15.00" }],
      equity: [{ ...source, accountId: 30, code: "311", name: "رأس المال", amount: "85.00" }],
      totals: {
        assets: "100.00",
        liabilities: "0.00",
        equity: "80.00",
        unclosedResult: "20.00",
        liabilitiesAndEquity: "100.00",
        difference: "0.00",
      },
    });
    expect(rows.find((row) => row.name === "الصندوق")).toMatchObject({ version: "2", amount: "100.00" });
    expect(rows.find((row) => row.name === "ذمم الموردين")).toMatchObject({ section: "الالتزامات", version: "2", code: "211", amount: "15.00" });
    expect(rows.find((row) => row.name === "رأس المال")).toMatchObject({ section: "حقوق الملكية", version: "2", code: "311", amount: "85.00" });
    expect(rows.map((row) => row.name)).toEqual(expect.arrayContaining([
      "إجمالي الأصول",
      "إجمالي الالتزامات",
      "إجمالي حقوق الملكية",
      "نتيجة النشاط غير المقفلة",
      "الالتزامات وحقوق الملكية",
      "فرق المعادلة",
    ]));
  });

  it("يبني إجماليات قائمة الدخل وصافي النتيجة", () => {
    const rows = buildIncomeStatementRows({
      revenues: [source],
      expenses: [{ ...source, accountId: 40, code: "511", name: "مصروف تشغيلي", amount: "20.00" }],
      totals: { revenue: "100.00", expenses: "20.00", netIncome: "80.00" },
    });
    expect(rows.find((row) => row.name === "مصروف تشغيلي")).toMatchObject({ section: "المصروفات", version: "2", code: "511", amount: "20.00" });
    expect(rows.at(-1)).toMatchObject({ name: "صافي نتيجة النشاط", amount: "80.00" });
  });

  it("يحفظ حمولة البصمة كـJSON قانوني قابلة لإعادة SHA-256 دون ضياع null أو Boolean", () => {
    const accounts = [
      { code: "01", name: "الأصول", type: "ASSET", normalBalance: "DEBIT", parentId: null, isPosting: false, sortOrder: 0 },
      { code: "0101", name: "الصندوق", type: "ASSET", normalBalance: "DEBIT", parentId: 7, isPosting: true, sortOrder: 1 },
    ];
    const mappings = [{ internalCode: "001", role: "CASH", statutoryCode: "0101" }];
    const payload = JSON.stringify({ accounts, mappings });
    const contentHash = createHash("sha256").update(payload).digest("hex");
    const rows = buildStatutoryHashMaterial([{
      profile: { id: 17, profileKey: "IRAQ-PRIVATE", version: 1, contentHash },
      approvedAccounts: accounts,
      approvedMappings: mappings,
    }]);

    expect(rows.map((row) => row.canonicalJson)).toEqual([
      '{"code":"01","name":"الأصول","type":"ASSET","normalBalance":"DEBIT","parentId":null,"isPosting":false,"sortOrder":0}',
      '{"code":"0101","name":"الصندوق","type":"ASSET","normalBalance":"DEBIT","parentId":7,"isPosting":true,"sortOrder":1}',
      '{"internalCode":"001","role":"CASH","statutoryCode":"0101"}',
    ]);
    expect(
      createHash("sha256")
        .update(reconstructStatutoryHashPayload(rows, 17))
        .digest("hex"),
    ).toBe(contentHash);
  });
});
