import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * عقدُ **خليّة السعر** في محرّر الفواتير (بلاغ المالك ١٧/٨/٢٦).
 *
 * البلاغ: «سعر الشراء لا يمكن أن يكون 1,450.99، وبالدولار لا يقبل 3.4566 ⇒ لا يمكن إتمام الشراء
 * أو البيع، ويحدث في الفاتورة الآجلة أو الذمم». والشاشات المعنيّة كلّها تشترك في `ProductTable`
 * (شراء/تعديل شراء/مرتجع شراء/عرض سعر/فاتورة البيع الآجلة) — لذا يُثبَّت العقد على المكوّن نفسه.
 *
 * اختبارُ مصدرٍ لا رسمٍ: الحزمة تعمل في بيئة node بلا DOM (نمط `auditedUxContracts.test.ts`)،
 * والمقصود هنا منعُ **عودة** المُحلّل الخام لا محاكاةُ الكتابة.
 */
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("invoice price cell — precision & input normalization contract", () => {
  const productTable = read("../ProductTable.tsx");

  it("لا يعود المُحلّل الخام الذي كان يبتلع «1,450.99» صامتاً", () => {
    // الجذر: `Number(v)` على نصّ فيه فاصلة ألوف/أرقام هندية ⇒ NaN ⇒ الضغطة تُهمَل بلا إشعار،
    // فيبدو الحقل مرفوضاً. لا `<Input>` خام في خليّة الأرقام، ولا فحص isFinite بديلاً عن التطبيع.
    expect(productTable).toContain("<MoneyInput");
    expect(productTable).not.toContain("if (Number.isFinite(n)) {");
    expect(productTable).not.toContain("String(Math.min(max, Math.max(0, n)))");
  });

  it("دقّة السعر تُشتقّ من عملة المستند لا من ثابتٍ محلّي", () => {
    expect(productTable).toContain('import { priceDecimalsFor } from "@shared/moneyPrecision"');
    expect(productTable).toContain("const linePriceDecimals = priceDecimalsFor(isPurchase ? purchaseCurrency : \"IQD\")");
    expect(productTable).toContain("decimals={linePriceDecimals}");
  });

  it("لا قصّ صامت لسعر الدولار عند مغادرة الحقل (كان يحوّل 3.4566 إلى 3.46)", () => {
    expect(productTable).not.toContain("normalizeUsdPurchasePrice");
    expect(productTable).not.toContain("onBlur={");
  });

  it("سقف نسبة الخصم يُقصّ عند التجاوز فقط فيبقى الكسر قابلاً للكتابة", () => {
    // `String(Number(raw))` عند كل ضغطة كان يمسح النقطة («12.» ⇒ «12») فيتعذّر خصمٌ كسريّ.
    expect(productTable).toContain("Number.isFinite(n) && n > max ? String(max) : raw");
  });

  it("نسبة ضريبة الفاتورة تمرّ بالحقل الموحّد لا بحقلٍ خام", () => {
    const totals = read("../TotalsPanel.tsx");
    expect(totals).toContain('ariaLabel="نسبة الضريبة"');
    expect(totals).not.toContain('import { Input } from "@/components/ui/input"');
  });
});

describe("purchase payload — سعر الوحدة يُرسَل بدقّة عملته", () => {
  for (const page of ["PurchaseNew.tsx", "PurchaseEdit.tsx"]) {
    it(`${page}: يستعمل toUnitPriceStr ولا يقصّ السعر بـround2`, () => {
      const source = read(`../../../pages/${page}`);
      expect(source).toContain("unitPrice: toUnitPriceStr(l.price, state.currency)");
      expect(source).not.toContain("unitPrice: round2(D(l.price)).toFixed(2)");
      // مرآة حارس الخادم على الشاشة: رسالةٌ صريحة بدل قصٍّ صامت أو رحلة ذهابٍ وإياب.
      expect(source).toContain("isWithinPriceDecimals(l.price, state.currency)");
      expect(source).toContain("priceDecimalsMessage(state.currency, l.name, l.price)");
    });
  }
});
