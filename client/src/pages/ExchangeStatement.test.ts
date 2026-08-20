import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./ExchangeStatement.tsx", import.meta.url), "utf8");

describe("ExchangeStatement financial presentation", () => {
  it("يفصل control الشركة عن حيازة الدولار الفعلية حسب الفرع", () => {
    expect(source).toContain("حساب الصيرفة — دولار");
    expect(source).toContain("قيمة control الدفترية");
    expect(source).toContain("النقد الدولاري الفعلي حسب الفرع");
    expect(source).toContain("physicalUsdByBranch");
    expect(source).not.toContain("صافي التعرّض الموحَّد");
    expect(source).not.toContain("netExposureIqd");
  });

  it("يعرض مجاميع شراء وسحب الدولار ولا يقدّم WAVG كمصدر دفتر", () => {
    expect(source).toContain("إجمالي الدولار المشترى");
    expect(source).toContain("إجمالي السحب (دينار)");
    expect(source).toContain("إجمالي السحب (دولار)");
    expect(source).toContain("متوسط الكلفة للعرض");
    expect(source).toContain("ليست نقداً فعلياً");
    expect(source).toContain("مبلغ ديناري / قيمة دفترية (د.ع)");
  });

  it("يعرض المورد والمنفذ ويسجل طلب طباعة الصيرفة", () => {
    expect(source).toContain('header: "المورد / الطرف"');
    expect(source).toContain('accessorKey: "createdByName"');
    expect(source).toContain('documentType: "EXCHANGE_TRANSACTION"');
    expect(source).toContain("printRequestedAt");
  });
});
