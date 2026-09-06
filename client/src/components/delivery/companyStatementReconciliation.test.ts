import { describe, expect, it } from "vitest";
import {
  STATEMENT_VERDICT_LABEL_AR,
  reconcileCompanyStatement,
  verdictNumbers,
  type StatementReconcileLine,
} from "./companyStatementReconciliation";

const line = (over: Partial<StatementReconcileLine> & { consignmentId: number }): StatementReconcileLine => ({
  consignmentNumber: `CN-${over.consignmentId}`,
  remaining: "1000.00",
  selected: false,
  collected: "0",
  ...over,
});

describe("مطابقة كشف شركة التوصيل — مطابق/مختلف/مفقود", () => {
  it("يصنّف كلّ سطر: المحدَّد بمبلغٍ = المتبقّي مطابق، والمخالف مختلف بفرقٍ موقَّع، وغير المحدَّد مفقود", () => {
    const rec = reconcileCompanyStatement([
      line({ consignmentId: 1, selected: true, collected: "1000" }),
      line({ consignmentId: 2, selected: true, collected: "750.5" }),
      line({ consignmentId: 3, selected: true, collected: "1200" }),
      line({ consignmentId: 4 }),
    ]);
    expect(rec.matched).toBe(1);
    expect(rec.mismatch).toBe(2);
    expect(rec.missing).toBe(1);
    expect(rec.lines.map((l) => l.verdict)).toEqual(["MATCHED", "MISMATCH", "MISMATCH", "MISSING"]);
    expect(rec.lines[1].diff).toBe("-249.50");
    expect(rec.lines[2].diff).toBe("200.00");
    expect(rec.lines[3]).toMatchObject({ collected: "0.00", diff: "0.00", remaining: "1000.00" });
  });

  it("إثبات التسليم بلا نقد (متبقٍّ صفر + مبلغ صفر) مطابقٌ لا مختلف، والفرق دون نصف قرشٍ يُهمَل", () => {
    const rec = reconcileCompanyStatement([
      line({ consignmentId: 1, remaining: "0.00", selected: true, collected: "0" }),
      line({ consignmentId: 2, remaining: "99.999", selected: true, collected: "100" }),
    ]);
    expect(rec.matched).toBe(2);
    expect(rec.mismatch).toBe(0);
  });

  it("قائمةٌ فارغة ⇒ أصفار بلا أسطر، والمدخلات التالفة تُقرأ صفراً لا NaN", () => {
    expect(reconcileCompanyStatement([])).toEqual({ matched: 0, mismatch: 0, missing: 0, lines: [] });
    const rec = reconcileCompanyStatement([line({ consignmentId: 1, selected: true, collected: "abc" })]);
    expect(rec.lines[0].verdict).toBe("MISMATCH");
    expect(rec.lines[0].collected).toBe("0.00");
  });

  it("أرقام الطرود لفئةٍ مختصرةٌ بحدّ ثمّ «+n»", () => {
    const rec = reconcileCompanyStatement([1, 2, 3, 4, 5, 6, 7].map((id) => line({ consignmentId: id })));
    const v = verdictNumbers(rec, "MISSING", 5);
    expect(v.shown).toEqual(["CN-1", "CN-2", "CN-3", "CN-4", "CN-5"]);
    expect(v.more).toBe(2);
    expect(verdictNumbers(rec, "MATCHED")).toEqual({ shown: [], more: 0 });
  });

  it("التسميات الثلاث عربيّة وموحّدة", () => {
    expect(Object.values(STATEMENT_VERDICT_LABEL_AR)).toEqual(["مطابق", "مختلف", "مفقود"]);
  });
});
