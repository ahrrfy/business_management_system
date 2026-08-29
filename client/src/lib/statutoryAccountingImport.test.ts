import { describe, expect, it } from "vitest";
import {
  MAX_STATUTORY_IMPORT_BYTES,
  normalizeStatutoryAccountRows,
  parseStatutoryAccountsFile,
  suggestStatutoryMappings,
} from "./statutoryAccountingImport";

describe("statutory accounting import", () => {
  it("يطبع الحقول العربية والإنجليزية مع افتراضات آمنة", () => {
    const rows = normalizeStatutoryAccountRows([
      {
        code: "1",
        name: "الأصول",
        type: "أصول",
        normalBalance: "مدين",
        isPosting: "لا",
      },
      {
        code: "111",
        name: "ذمم العملاء",
        type: "ASSET",
        normalBalance: "DEBIT",
        parentCode: "1",
      },
    ]);

    expect(rows).toEqual([
      {
        code: "1",
        name: "الأصول",
        type: "ASSET",
        normalBalance: "DEBIT",
        parentCode: null,
        isPosting: false,
        sortOrder: 0,
        notes: null,
      },
      {
        code: "111",
        name: "ذمم العملاء",
        type: "ASSET",
        normalBalance: "DEBIT",
        parentCode: "1",
        isPosting: true,
        sortOrder: 1,
        notes: null,
      },
    ]);
  });

  it("يرفض التكرار والأب غير المتوافق قبل الإرسال", () => {
    expect(() =>
      normalizeStatutoryAccountRows([
        { code: "1", name: "الأصول", type: "ASSET", normalBalance: "DEBIT" },
        { code: "1", name: "نسخة", type: "ASSET", normalBalance: "DEBIT" },
      ]),
    ).toThrow(/مكرر/);

    expect(() =>
      normalizeStatutoryAccountRows([
        { code: "1", name: "الأصول", type: "ASSET", normalBalance: "DEBIT" },
        { code: "41", name: "إيراد", type: "REVENUE", normalBalance: "CREDIT", parentCode: "1" },
      ]),
    ).toThrow(/لا يطابق نوع أبيه/);
  });

  it("يقترح المطابقة الفريدة فقط ولا يلمس الربط الموجود", () => {
    const suggestions = suggestStatutoryMappings(
      [
        { internalAccountId: 1, internalCode: "111", internalName: "ذمم العملاء", internalType: "ASSET", statutoryAccountId: null },
        { internalAccountId: 2, internalCode: "999", internalName: "الصندوق", internalType: "ASSET", statutoryAccountId: null },
        { internalAccountId: 3, internalCode: "4100", internalName: "المبيعات", internalType: "REVENUE", statutoryAccountId: 30 },
        { internalAccountId: 4, internalCode: "998", internalName: "نقد", internalType: "ASSET", statutoryAccountId: null },
      ],
      [
        { id: 10, code: "111", name: "العملاء", type: "ASSET", isPosting: true },
        { id: 20, code: "120", name: "الصندوق", type: "ASSET", isPosting: true },
        { id: 21, code: "121", name: "الصندوق", type: "ASSET", isPosting: true },
        { id: 30, code: "4100", name: "المبيعات", type: "REVENUE", isPosting: true },
        { id: 40, code: "130", name: "نقد", type: "ASSET", isPosting: false },
      ],
    );

    expect(suggestions).toEqual({ 1: 10 });
  });

  it("يقرأ JSON وCSV فعليين عبر مسار الملف", async () => {
    const json = new File(
      [JSON.stringify([{ code: "1", name: "الأصول", type: "ASSET", normalBalance: "DEBIT" }])],
      "accounts.json",
      { type: "application/json" },
    );
    await expect(parseStatutoryAccountsFile(json)).resolves.toMatchObject([
      { code: "1", name: "الأصول", type: "ASSET", normalBalance: "DEBIT" },
    ]);

    const csv = new File(
      ["رمز الحساب,اسم الحساب,نوع الحساب,طبيعة الرصيد\n4,الإيرادات,REVENUE,CREDIT"],
      "accounts.csv",
      { type: "text/csv" },
    );
    await expect(parseStatutoryAccountsFile(csv)).resolves.toMatchObject([
      { code: "4", name: "الإيرادات", type: "REVENUE", normalBalance: "CREDIT" },
    ]);
  });

  it("يرفض الصيغ والأعمدة والحجوم غير الآمنة برسائل عربية", async () => {
    await expect(
      parseStatutoryAccountsFile(new File(["{"], "broken.json")),
    ).rejects.toThrow(/JSON غير صالح/);
    await expect(
      parseStatutoryAccountsFile(new File(["x"], "accounts.txt")),
    ).rejects.toThrow(/الصيغة غير مدعومة/);
    await expect(
      parseStatutoryAccountsFile(new File(["الرمز,الحساب\n1,الأصول"], "missing.csv")),
    ).rejects.toThrow(/أعمدة مطلوبة/);
    await expect(
      parseStatutoryAccountsFile({
        name: "large.csv",
        size: MAX_STATUTORY_IMPORT_BYTES + 1,
      } as File),
    ).rejects.toThrow(/10 ميغابايت/);
  });

  it("يقرأ ملف XLSX حقيقياً", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("الحسابات");
    sheet.addRow(["رمز الحساب", "اسم الحساب", "نوع الحساب", "طبيعة الرصيد"]);
    sheet.addRow(["5", "المصروفات", "EXPENSE", "DEBIT"]);
    const buffer = await workbook.xlsx.writeBuffer();
    const file = new File([new Uint8Array(buffer)], "accounts.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    await expect(parseStatutoryAccountsFile(file)).resolves.toMatchObject([
      { code: "5", name: "المصروفات", type: "EXPENSE", normalBalance: "DEBIT" },
    ]);
  }, 15_000);

  it("يثبت حد الصفوف وحواجز شجرة الحسابات", () => {
    const row = (index: number) => ({
      code: String(index + 1),
      name: `حساب ${index + 1}`,
      type: "ASSET",
      normalBalance: "DEBIT",
    });
    expect(normalizeStatutoryAccountRows(Array.from({ length: 1500 }, (_, index) => row(index)))).toHaveLength(1500);
    expect(() => normalizeStatutoryAccountRows(Array.from({ length: 1501 }, (_, index) => row(index)))).toThrow(/1500 حساب/);
    expect(() => normalizeStatutoryAccountRows([
      { ...row(0), parentCode: "404" },
    ])).toThrow(/أب غير صالح/);
    expect(() => normalizeStatutoryAccountRows([
      { ...row(0), parentCode: "1" },
    ])).toThrow(/أب غير صالح/);
    expect(() => normalizeStatutoryAccountRows([
      { ...row(0), parentCode: "2" },
      { ...row(1), parentCode: "1" },
    ])).toThrow(/دورة أبوّة/);
  });
});
