/**
 * تكافؤ طرفَي مسند «الرصيد المفتوح»: تعبيرُ SQL ⇄ الحساب بـdecimal.js.
 *
 * **لماذا هكذا لا بـ«اختبارِ قيمٍ متوقَّعة» لكلّ طرف على حدة:** طرفان يُختبَران بأرقامٍ كتبتُها
 * بيدي ينجرفان معاً بلا أن يحمرّ شيء — يكفي أن أُخطئ نفسَ الخطأ في التوقّع. المطلوب إثباتُ أنّ
 * **الطرفين يُنتجان الرقم نفسه**، لا أنّ كلاًّ منهما يطابق ظنّي.
 *
 * الآلة: نُصيّر تعبيرَ drizzle نصَّ SQL فعلياً (`MySqlDialect.sqlToQuery` — بلا قاعدة بيانات،
 * فيبقى الاختبار وحدةً منطقيّة في `vitest.unit.config.ts`)، ثمّ نُقيّم ذلك النصّ بمُقيّمٍ صغير
 * يُنفّذ دلالة MySQL للعمليات الثلاث المستعمَلة وحدها: `CAST(… AS DECIMAL(p,s))` و`GREATEST`
 * والطرح. المُقيّم **يرمي على أيّ رمزٍ لا يعرفه** ⇒ لو تغيّر شكلُ التعبير المولَّد يسقط
 * الاختبار بدل أن يمرّ فارغاً (أخضرٌ كاذب).
 *
 * ⚠️ المُقيّم ليس MySQL: هو عقدٌ ضيّقٌ على العمليات الثلاث فقط. توسيعُ `openBalanceExpr`
 * بدالّةٍ رابعة يوجب توسيعَه هنا عمداً — وهذا مقصود.
 */
import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import {
  openBalanceExpr,
  openBalanceOf,
  hasOpenBalance,
  isOpenBalanceExcludedStatus,
  OPEN_BALANCE_CLAMPED,
  OPEN_BALANCE_MODES,
  OPEN_BALANCE_DEFAULT_MODE,
  OPEN_BALANCE_EXCLUDED_STATUSES,
  OPEN_BALANCE_SCALE,
  type OpenBalanceMode,
} from "./openBalance";

// ————————————————————————————————————————————————————————————————
// مُقيّمُ SQL المصغَّر (دلالة MySQL للعمليات الثلاث المستعمَلة)
// ————————————————————————————————————————————————————————————————

const TOKEN_RE = /\s*(GREATEST|CAST|AS|DECIMAL|\?|\d+(?:\.\d+)?|[(),-])/giy;

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  TOKEN_RE.lastIndex = 0;
  while (TOKEN_RE.lastIndex < text.length) {
    const m = TOKEN_RE.exec(text);
    if (!m) throw new Error(`رمزٌ لا يعرفه المُقيّم عند الموضع ${TOKEN_RE.lastIndex}: ${text.slice(TOKEN_RE.lastIndex)}`);
    tokens.push(m[1].toUpperCase() === m[1] ? m[1] : m[1].toUpperCase());
  }
  return tokens;
}

/** يُنفّذ نصّ SQL المولَّد بقيم `params` مكان علامات `?` — ويرمي على أيّ بنيةٍ خارج العقد. */
function evalMysqlExpr(text: string, params: unknown[]): Decimal {
  const tokens = tokenize(text);
  const binds = [...params];
  let i = 0;

  const peek = () => tokens[i];
  const eat = (expected?: string) => {
    const t = tokens[i++];
    if (t === undefined) throw new Error("نهايةٌ مبكّرة لتعبير SQL");
    if (expected && t !== expected) throw new Error(`توقّعتُ «${expected}» فوجدتُ «${t}»`);
    return t;
  };

  function parseExpr(): Decimal {
    let acc = parsePrimary();
    while (peek() === "-") {
      eat("-");
      acc = acc.minus(parsePrimary());
    }
    return acc;
  }

  function parsePrimary(): Decimal {
    const t = peek();
    if (t === "GREATEST") {
      eat("GREATEST");
      eat("(");
      const a = parseExpr();
      eat(",");
      const b = parseExpr();
      eat(")");
      return Decimal.max(a, b);
    }
    if (t === "CAST") {
      eat("CAST");
      eat("(");
      const value = parseExpr();
      eat("AS");
      eat("DECIMAL");
      eat("(");
      eat(); // precision — لا أثر له على قيمٍ ضمن المدى
      eat(",");
      const scale = Number(eat());
      eat(")");
      eat(")");
      // CAST في MySQL يقرّب HALF_UP (بعيداً عن الصفر) إلى عدد المنازل المطلوب.
      return value.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP);
    }
    if (t === "(") {
      eat("(");
      const v = parseExpr();
      eat(")");
      return v;
    }
    if (t === "?") {
      eat("?");
      if (binds.length === 0) throw new Error("علامةُ ? بلا قيمةٍ مرتبطة");
      return new Decimal(String(binds.shift()));
    }
    if (t !== undefined && /^\d/.test(t)) return new Decimal(eat());
    throw new Error(`رمزٌ خارج عقد المُقيّم: «${String(t)}»`);
  }

  const result = parseExpr();
  if (i !== tokens.length) throw new Error(`بقيةٌ غير مُستهلَكة من التعبير: ${tokens.slice(i).join(" ")}`);
  if (binds.length !== 0) throw new Error(`قيمٌ مرتبطة لم تُستهلَك: ${binds.length}`);
  return result;
}

const dialect = new MySqlDialect();

/** يبني التعبير بقيم الحالة مربوطةً مكان الأعمدة، ثمّ يُصيّره ويُقيّمه — «ما ينفّذه MySQL». */
function evalOpenBalanceSql(
  row: { total: string | number; paidAmount: string | number; returnedTotal: string | number },
  mode: OpenBalanceMode,
): Decimal {
  const expr = openBalanceExpr(
    {
      total: sql`${String(row.total)}`,
      paidAmount: sql`${String(row.paidAmount)}`,
      returnedTotal: sql`${String(row.returnedTotal)}`,
    },
    mode,
  );
  const query = dialect.sqlToQuery(expr);
  return evalMysqlExpr(query.sql, query.params);
}

// ————————————————————————————————————————————————————————————————
// الحالات الحدّية
// ————————————————————————————————————————————————————————————————

type Case = {
  name: string;
  total: string;
  paidAmount: string;
  returnedTotal: string;
  /** القيمة المتوقَّعة في وضع `SIGNED` (المقصوصة تُشتقّ منها بالقصّ عند الصفر). */
  signed: string;
};

const CASES: Case[] = [
  { name: "أصفارٌ كاملة", total: "0.00", paidAmount: "0.00", returnedTotal: "0.00", signed: "0.00" },
  { name: "آجلةٌ لم يُقبض منها شيء", total: "120000.00", paidAmount: "0.00", returnedTotal: "0.00", signed: "120000.00" },
  { name: "مدفوعةٌ بالكامل", total: "120000.00", paidAmount: "120000.00", returnedTotal: "0.00", signed: "0.00" },
  { name: "مدفوعةٌ جزئياً", total: "120000.00", paidAmount: "45000.00", returnedTotal: "0.00", signed: "75000.00" },
  { name: "مرتجعٌ كامل بلا قبض", total: "120000.00", paidAmount: "0.00", returnedTotal: "120000.00", signed: "0.00" },
  {
    // الحالةُ التي يفترق فيها الوضعان: قُبِض المال ثمّ أُرجعت البضاعة كاملةً ⇒ المكتبة مدينة.
    name: "مرتجعٌ كامل بعد قبضٍ كامل (المكتبة مدينة)",
    total: "120000.00", paidAmount: "120000.00", returnedTotal: "120000.00", signed: "-120000.00",
  },
  { name: "مرتجعٌ جزئيّ مع قبضٍ جزئيّ", total: "120000.00", paidAmount: "30000.00", returnedTotal: "50000.00", signed: "40000.00" },
  { name: "دفعٌ زائد (مسموحٌ في هذا النظام)", total: "100000.00", paidAmount: "130000.00", returnedTotal: "0.00", signed: "-30000.00" },
  { name: "دفعٌ زائدٌ بدينارٍ واحد", total: "100000.00", paidAmount: "100001.00", returnedTotal: "0.00", signed: "-1.00" },
  { name: "منزلتان — الصافي صفرٌ بالضبط", total: "100.00", paidAmount: "99.99", returnedTotal: "0.01", signed: "0.00" },
  { name: "منزلتان — كسورٌ لا تُقرَّب", total: "1000.55", paidAmount: "250.25", returnedTotal: "100.10", signed: "650.20" },
  { name: "مبلغٌ كبيرٌ قرب سقف decimal(15,2)", total: "9999999999999.99", paidAmount: "0.01", returnedTotal: "0.00", signed: "9999999999999.98" },
];

const clampedOf = (signed: string) => {
  const d = new Decimal(signed);
  return d.isNegative() ? "0.00" : d.toFixed(OPEN_BALANCE_SCALE);
};

// ————————————————————————————————————————————————————————————————

describe("تكافؤ الصيغتين: تعبير SQL ⇄ حساب decimal.js", () => {
  for (const mode of OPEN_BALANCE_MODES) {
    for (const c of CASES) {
      it(`[${mode}] ${c.name}`, () => {
        const fromSql = evalOpenBalanceSql(c, mode);
        const fromTs = openBalanceOf(c, mode);
        expect(fromTs.toFixed(OPEN_BALANCE_SCALE)).toBe(fromSql.toFixed(OPEN_BALANCE_SCALE));
        // ومطابقةُ القيمة المرجعيّة أيضاً — التكافؤ وحده لا يمنع أن ينحرف الطرفان معاً.
        const expected = mode === "SIGNED" ? new Decimal(c.signed).toFixed(OPEN_BALANCE_SCALE) : clampedOf(c.signed);
        expect(fromTs.toFixed(OPEN_BALANCE_SCALE)).toBe(expected);
      });
    }
  }

  it("الوضعان يفترقان فعلاً حيث يجب (وإلّا كان اختبارُ التكافؤ بلا معنى)", () => {
    const overpaid = { total: "100000.00", paidAmount: "130000.00", returnedTotal: "0.00" };
    expect(openBalanceOf(overpaid, "SIGNED").toFixed(2)).toBe("-30000.00");
    expect(openBalanceOf(overpaid, "COLLECTIBLE").toFixed(2)).toBe("0.00");
  });

  it("المدخل الرقميّ يساوي المدخل النصّيّ (mysql2 يُرجع نصّاً، والاختبارات تكتب أرقاماً)", () => {
    expect(openBalanceOf({ total: 1000.55, paidAmount: 250.25, returnedTotal: 100.1 }).toFixed(2)).toBe("650.20");
    expect(openBalanceOf({ total: "1000.55", paidAmount: "250.25", returnedTotal: "0100.100" }).toFixed(2)).toBe("650.20");
  });

  it("`returnedTotal` الغائب يُعامَل صفراً (أقدمُ الصفوف قبل العمود)", () => {
    expect(openBalanceOf({ total: "500.00", paidAmount: "200.00" }).toFixed(2)).toBe("300.00");
    expect(openBalanceOf({ total: "500.00", paidAmount: "200.00", returnedTotal: null }).toFixed(2)).toBe("300.00");
  });

  it("القيمةُ غير الصالحة تُرفَض برسالةٍ عربية بدل أن تصير NaN صامتة", () => {
    expect(() => openBalanceOf({ total: "غير رقم", paidAmount: "0", returnedTotal: "0" })).toThrow(/قيمة مالية غير صالحة/);
    expect(() => openBalanceOf({ total: Infinity, paidAmount: "0", returnedTotal: "0" })).toThrow(/قيمة مالية غير صالحة/);
  });

  it("`hasOpenBalance` يقارن بصفرٍ لا بالسالب", () => {
    expect(hasOpenBalance({ total: "100.00", paidAmount: "100.00", returnedTotal: "0.00" })).toBe(false);
    expect(hasOpenBalance({ total: "100.00", paidAmount: "130.00", returnedTotal: "0.00" }, "SIGNED")).toBe(false);
    expect(hasOpenBalance({ total: "100.00", paidAmount: "1.00", returnedTotal: "0.00" })).toBe(true);
  });
});

describe("شكلُ SQL المولَّد — مُثبَّتٌ حرفياً", () => {
  const cols = {
    total: sql.raw("i.total"),
    paidAmount: sql.raw("i.paidAmount"),
    returnedTotal: sql.raw("i.returnedTotal"),
  };

  it("COLLECTIBLE يلفّ بـGREATEST(…, 0)", () => {
    expect(dialect.sqlToQuery(openBalanceExpr(cols, "COLLECTIBLE")).sql).toBe(
      "GREATEST(CAST(i.total AS DECIMAL(15,2)) - CAST(i.paidAmount AS DECIMAL(15,2)) - CAST(i.returnedTotal AS DECIMAL(15,2)), 0)",
    );
  });

  it("SIGNED بلا لفّ", () => {
    expect(dialect.sqlToQuery(openBalanceExpr(cols, "SIGNED")).sql).toBe(
      "CAST(i.total AS DECIMAL(15,2)) - CAST(i.paidAmount AS DECIMAL(15,2)) - CAST(i.returnedTotal AS DECIMAL(15,2))",
    );
  });

  it("الافتراضيّ = COLLECTIBLE (وضعُ التقارير والدلاء)", () => {
    expect(OPEN_BALANCE_DEFAULT_MODE).toBe("COLLECTIBLE");
    expect(dialect.sqlToQuery(openBalanceExpr(cols)).sql).toBe(
      dialect.sqlToQuery(openBalanceExpr(cols, "COLLECTIBLE")).sql,
    );
  });

  it("لا COALESCE داخل التعبير — انتشارُ NULL يبقى كما تعتمده المواضع القائمة", () => {
    expect(dialect.sqlToQuery(openBalanceExpr(cols)).sql).not.toMatch(/COALESCE/i);
  });

  it("ترتيبُ الطرح ثابت: total ثمّ paidAmount ثمّ returnedTotal", () => {
    const text = dialect.sqlToQuery(openBalanceExpr(cols)).sql;
    expect(text.indexOf("i.total")).toBeLessThan(text.indexOf("i.paidAmount"));
    expect(text.indexOf("i.paidAmount")).toBeLessThan(text.indexOf("i.returnedTotal"));
  });
});

describe("الثابتُ المُصرَّح: القصُّ ومجموعةُ الحالات المرافقة", () => {
  it("القصّ مُعلَنٌ لكلّ وضع", () => {
    expect(OPEN_BALANCE_CLAMPED.COLLECTIBLE).toBe(true);
    expect(OPEN_BALANCE_CLAMPED.SIGNED).toBe(false);
  });

  it("COLLECTIBLE ⇒ الحالات الميتة الثلاث", () => {
    expect([...OPEN_BALANCE_EXCLUDED_STATUSES.COLLECTIBLE].sort()).toEqual(
      ["CANCELLED", "RETURNED", "SUPERSEDED"].sort(),
    );
  });

  it("SIGNED ⇒ المُبطَلتان فقط — و`RETURNED` ليست منهما", () => {
    expect([...OPEN_BALANCE_EXCLUDED_STATUSES.SIGNED].sort()).toEqual(["CANCELLED", "SUPERSEDED"].sort());
    expect(OPEN_BALANCE_EXCLUDED_STATUSES.SIGNED).not.toContain("RETURNED");
  });

  it("الفارقُ بين المجموعتين هو `RETURNED` وحدها (خلطُهما عطبٌ ماليّ موثَّق)", () => {
    const diff = OPEN_BALANCE_EXCLUDED_STATUSES.COLLECTIBLE.filter(
      (s) => !OPEN_BALANCE_EXCLUDED_STATUSES.SIGNED.includes(s),
    );
    expect(diff).toEqual(["RETURNED"]);
  });

  it("`isOpenBalanceExcludedStatus` يتبع الوضع لا الحدس", () => {
    expect(isOpenBalanceExcludedStatus("RETURNED", "COLLECTIBLE")).toBe(true);
    expect(isOpenBalanceExcludedStatus("RETURNED", "SIGNED")).toBe(false);
    expect(isOpenBalanceExcludedStatus("SUPERSEDED", "COLLECTIBLE")).toBe(true);
    expect(isOpenBalanceExcludedStatus("SUPERSEDED", "SIGNED")).toBe(true);
    expect(isOpenBalanceExcludedStatus("PARTIALLY_PAID")).toBe(false);
    expect(isOpenBalanceExcludedStatus(null)).toBe(false);
  });

  it("استبعادُ RETURNED في الوضع الموقَّع كان سيُسقِط ذمّةً دائنةً للعميل", () => {
    // فاتورةٌ قُبِضت كاملةً ثمّ أُرجِعت كاملةً: حالتُها RETURNED ورصيدُها الموقَّع −المقبوض.
    const returnedPaid = { total: "120000.00", paidAmount: "120000.00", returnedTotal: "120000.00" };
    expect(openBalanceOf(returnedPaid, "SIGNED").toFixed(2)).toBe("-120000.00");
    expect(isOpenBalanceExcludedStatus("RETURNED", "SIGNED")).toBe(false);
  });
});

describe("مُقيّمُ SQL نفسه — كي لا يمرّ الاختبار فارغاً", () => {
  it("يحسب GREATEST وCAST والطرح كما يفعل MySQL", () => {
    expect(evalMysqlExpr("GREATEST(CAST(? AS DECIMAL(15,2)) - ?, 0)", ["10.005", "1"]).toFixed(2)).toBe("9.01");
    expect(evalMysqlExpr("GREATEST(? - ?, 0)", ["1", "5"]).toFixed(2)).toBe("0.00");
  });

  it("يرمي على دالّةٍ خارج العقد بدل أن يُخضِرّ كذباً", () => {
    expect(() => evalMysqlExpr("LEAST(?, 0)", ["1"])).toThrow();
  });

  it("يرمي على بقيّةٍ غير مُستهلَكة أو قيمٍ زائدة", () => {
    expect(() => evalMysqlExpr("? ?", ["1", "2"])).toThrow(/غير مُستهلَكة/);
    expect(() => evalMysqlExpr("?", ["1", "2"])).toThrow(/لم تُستهلَك/);
  });
});
