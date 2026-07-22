/* ============================================================================
 * خدمة المكوّنات القانونية العراقية للرواتب — البند ④ (server/services/payrollLegalService.ts)
 * إعدادات مفردة (singleton id=1، نمط taxSettings/openingModeSettings) + دوالّ احتساب نقيّة.
 *
 * ثلاثة مكوّنات، كلٌّ بمفتاح تفعيل مستقلّ **معطَّل افتراضياً**:
 *   ١) الضمان الاجتماعي: نسبة الموظف (تُخصَم) + نسبة رب العمل (كلفة على الشركة) + وعاء (أساسيّ/إجماليّ).
 *   ٢) ضريبة الدخل المستقطعة: شرائح تصاعدية حدّية قابلة للضبط + إعفاء شخصيّ/عائليّ.
 *      الوعاء الضريبيّ = الإجماليّ − حصّة الموظف من الضمان − الإعفاء.
 *   ٣) مكافأة نهاية الخدمة: استحقاق متراكم يُحسب/يُعرَض (لا يُخصَم ولا يُصرَف هنا — الصرف عند الفصل).
 *
 * ⚠️ **مبدأ الأمان الحاكم:** ما لم يُفعِّل المالك المكوّن ⇒ صفر أثر على الرواتب (net/deductions كما هي
 *    اليوم بالضبط). كل الدوالّ تُعيد صفراً عند التعطيل. أُثبِت هذا باختبار انحدار صريح.
 * ⚠️ النِّسب/الشرائح **إعداداتٌ يضبطها المالك مع محاسبه القانونيّ** — لا تُثبَّت في الكود، والقيم
 *    الافتراضية صفر/معطَّلة (توضيحيّ لا معتمَد). كل المبالغ عبر decimal.js + money.ts (لا parseFloat).
 * ========================================================================== */
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import { payrollLegalSettings, type IncomeTaxBracket } from "../../drizzle/schema";
import type { Tx } from "../db";
import { money, round2 } from "./money";
import { requireDb, withTx, type Actor } from "./tx";

export type { IncomeTaxBracket };

/** أدنى مُشغّل قراءة (db أو tx) — يُتيح القراءة داخل معاملة توليد المسيّر أو خارجها. */
type Runner = Pick<Tx, "select">;

const MONTHS_PER_YEAR = 12;
const MAX_DAYS_PER_YEAR = 365;
const PCT_RE = /^\d+(\.\d{1,2})?$/;
const MONEY_RE = /^\d+(\.\d{1,2})?$/;

/* ─────────────────────────── العرض والافتراضات ─────────────────────────── */

export interface PayrollLegalSettingsView {
  socialSecurityEnabled: boolean;
  /** نسبة مئوية (سلسلة) — حصّة الموظف. */
  socialSecurityEmployeeRate: string;
  /** نسبة مئوية (سلسلة) — حصّة رب العمل. */
  socialSecurityEmployerRate: string;
  socialSecurityBase: "basic" | "gross";
  incomeTaxEnabled: boolean;
  /** شرائح تصاعدية (قد تكون [] إن لم تُضبط بعد). */
  incomeTaxBrackets: IncomeTaxBracket[];
  /** إعفاء شهريّ (سلسلة مالية). */
  incomeTaxExemption: string;
  endOfServiceEnabled: boolean;
  /** أيام آخر راتب لكل سنة خدمة (سلسلة). */
  endOfServiceDaysPerYear: string;
  updatedBy: number | null;
  updatedAt: string | null;
}

/** كل المكوّنات معطَّلة وصفرية ابتداءً — الحالة الافتراضية حين لا صفّ إعدادات (صفر أثر). */
export const PAYROLL_LEGAL_DEFAULTS: PayrollLegalSettingsView = {
  socialSecurityEnabled: false,
  socialSecurityEmployeeRate: "0",
  socialSecurityEmployerRate: "0",
  socialSecurityBase: "basic",
  incomeTaxEnabled: false,
  incomeTaxBrackets: [],
  incomeTaxExemption: "0",
  endOfServiceEnabled: false,
  endOfServiceDaysPerYear: "0",
  updatedBy: null,
  updatedAt: null,
};

function normalizeBrackets(raw: unknown): IncomeTaxBracket[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((b): b is IncomeTaxBracket => !!b && typeof b === "object")
    .map((b) => ({
      upTo: b.upTo == null ? null : String(b.upTo),
      rate: String(b.rate ?? "0"),
    }));
}

function toView(row: typeof payrollLegalSettings.$inferSelect | undefined): PayrollLegalSettingsView {
  if (!row) return { ...PAYROLL_LEGAL_DEFAULTS };
  return {
    socialSecurityEnabled: row.socialSecurityEnabled,
    socialSecurityEmployeeRate: String(row.socialSecurityEmployeeRate),
    socialSecurityEmployerRate: String(row.socialSecurityEmployerRate),
    socialSecurityBase: row.socialSecurityBase,
    incomeTaxEnabled: row.incomeTaxEnabled,
    incomeTaxBrackets: normalizeBrackets(row.incomeTaxBrackets),
    incomeTaxExemption: String(row.incomeTaxExemption),
    endOfServiceEnabled: row.endOfServiceEnabled,
    endOfServiceDaysPerYear: String(row.endOfServiceDaysPerYear),
    updatedBy: row.updatedBy ?? null,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

/** يقرأ إعدادات المكوّنات القانونية (get-or-default — لا يكتب شيئاً). يقبل tx ليُقرأ داخل معاملة. */
export async function getPayrollLegalSettings(runner?: Runner): Promise<PayrollLegalSettingsView> {
  const db = runner ?? requireDb();
  const rows = await db.select().from(payrollLegalSettings).where(eq(payrollLegalSettings.id, 1)).limit(1);
  return toView(rows[0]);
}

/* ─────────────────────────── الاحتساب النقيّ (قابل للاختبار) ─────────────────────────── */

export interface LegalComputeInputs {
  /** الوعاء الأساسيّ (الراتب الأساس للشهريّ، أو أجر الفترة للساعيّ). */
  basic: Decimal;
  /** الإجماليّ (أساسيّ + مخصّصات للشهريّ، أو أجر الحضور للساعيّ). */
  gross: Decimal;
  /** المعدّل اليوميّ (الأساسيّ ÷ ٣٠) — لاستحقاق نهاية الخدمة. */
  dailyRate: Decimal;
}

export interface LegalComponents {
  /** حصّة الموظف من الضمان — **تُضاف إلى deductions** (تُنقص net). */
  socialSecurityEmployee: Decimal;
  /** حصّة رب العمل من الضمان — كلفة على الشركة (لا تُخصَم، خارج net). */
  socialSecurityEmployer: Decimal;
  /** ضريبة الدخل المستقطعة — **تُضاف إلى deductions** (تُنقص net). */
  incomeTax: Decimal;
  /** استحقاق مكافأة نهاية الخدمة المتراكم لهذا الشهر — التزام يُعرَض (لا يُخصَم، خارج net). */
  endOfServiceAccrual: Decimal;
}

const ZERO_COMPONENTS = (): LegalComponents => ({
  socialSecurityEmployee: new Decimal(0),
  socialSecurityEmployer: new Decimal(0),
  incomeTax: new Decimal(0),
  endOfServiceAccrual: new Decimal(0),
});

/** ضريبة تصاعدية حدّية: كل جزء من الوعاء ضمن شريحته يُضرَب بنسبتها. الشرائح تُرتَّب تصاعدياً بحدّها
 *  الأعلى (null = الشريحة المفتوحة العليا «فما فوق» ⇒ ∞). ما فوق أعلى حدٍّ رقميٍّ بلا شريحة مفتوحة =
 *  لا يُضرَّب (اختيار المالك). يُعيد round2. */
export function computeProgressiveTax(brackets: IncomeTaxBracket[], taxable: Decimal): Decimal {
  if (taxable.lte(0) || brackets.length === 0) return new Decimal(0);
  // ترتيب تصاعديّ بالحدّ الأعلى؛ null (مفتوح) في الآخر.
  const sorted = [...brackets].sort((a, b) => {
    const ax = a.upTo == null ? Infinity : Number(a.upTo);
    const bx = b.upTo == null ? Infinity : Number(b.upTo);
    return ax - bx;
  });
  let tax = new Decimal(0);
  let lower = new Decimal(0);
  for (const b of sorted) {
    if (lower.gte(taxable)) break;
    const upper = b.upTo == null ? taxable : Decimal.min(money(b.upTo), taxable);
    const slice = upper.minus(lower);
    if (slice.gt(0)) tax = tax.plus(slice.times(money(b.rate)).div(100));
    lower = b.upTo == null ? taxable : money(b.upTo);
  }
  return round2(tax);
}

/** يحسب المكوّنات القانونية لموظف واحد وفق الإعدادات. كل مكوّن معطَّل ⇒ صفر ⇒ صفر أثر. نقيّة وحتمية. */
export function computeLegalComponents(s: PayrollLegalSettingsView, inp: LegalComputeInputs): LegalComponents {
  const out = ZERO_COMPONENTS();

  // ١) الضمان الاجتماعي — على الوعاء المختار (أساسيّ/إجماليّ).
  if (s.socialSecurityEnabled) {
    const ssBase = s.socialSecurityBase === "gross" ? inp.gross : inp.basic;
    out.socialSecurityEmployee = round2(ssBase.times(money(s.socialSecurityEmployeeRate)).div(100));
    out.socialSecurityEmployer = round2(ssBase.times(money(s.socialSecurityEmployerRate)).div(100));
  }

  // ٢) ضريبة الدخل — الوعاء الضريبيّ = الإجماليّ − حصّة الموظف من الضمان − الإعفاء (لا يقلّ عن صفر).
  if (s.incomeTaxEnabled) {
    const taxable = Decimal.max(0, inp.gross.minus(out.socialSecurityEmployee).minus(money(s.incomeTaxExemption)));
    out.incomeTax = computeProgressiveTax(s.incomeTaxBrackets, taxable);
  }

  // ٣) مكافأة نهاية الخدمة — الاستحقاق الشهريّ المتراكم = (المعدّل اليوميّ × أيام/سنة) ÷ ١٢.
  if (s.endOfServiceEnabled) {
    out.endOfServiceAccrual = round2(inp.dailyRate.times(money(s.endOfServiceDaysPerYear)).div(MONTHS_PER_YEAR));
  }

  return out;
}

/* ─────────────────────────── التحديث (محصور بالمدير/الأدمن في الراوتر) ─────────────────────────── */

export interface UpdatePayrollLegalInput {
  socialSecurityEnabled: boolean;
  socialSecurityEmployeeRate: string;
  socialSecurityEmployerRate: string;
  socialSecurityBase: "basic" | "gross";
  incomeTaxEnabled: boolean;
  incomeTaxBrackets: IncomeTaxBracket[];
  incomeTaxExemption: string;
  endOfServiceEnabled: boolean;
  endOfServiceDaysPerYear: string;
}

export interface UpdatePayrollLegalResult {
  before: PayrollLegalSettingsView;
  after: PayrollLegalSettingsView;
}

function assertPct(v: string, label: string): void {
  if (!PCT_RE.test(v) || money(v).gt(100)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `${label} يجب أن تكون نسبة مئوية بين ٠ و١٠٠` });
  }
}

/** يتحقّق من الشرائح ويُعيدها مرتّبة تصاعدياً: كل نسبة [٠،١٠٠]، الحدود الرقمية موجبة ومتزايدة قطعاً،
 *  وشريحة مفتوحة (null) واحدة على الأكثر (تمثّل «فما فوق»). عند تفعيل الضريبة تُطلَب شريحة واحدة فأكثر. */
function validateAndSortBrackets(raw: IncomeTaxBracket[], taxEnabled: boolean): IncomeTaxBracket[] {
  const brackets = normalizeBrackets(raw);
  if (taxEnabled && brackets.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "تفعيل ضريبة الدخل يتطلّب ضبط شريحة واحدة على الأقل" });
  }
  let openCount = 0;
  for (const b of brackets) {
    assertPct(b.rate, "نسبة الشريحة");
    if (b.upTo == null) {
      openCount += 1;
    } else if (!MONEY_RE.test(b.upTo) || money(b.upTo).lte(0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "حدّ الشريحة يجب أن يكون مبلغاً موجباً" });
    }
  }
  if (openCount > 1) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "لا تُسمح إلّا شريحة مفتوحة واحدة («فما فوق»)" });
  }
  const numeric = brackets.filter((b) => b.upTo != null).sort((a, b) => Number(a.upTo) - Number(b.upTo));
  for (let i = 1; i < numeric.length; i++) {
    if (money(numeric[i].upTo!).lte(money(numeric[i - 1].upTo!))) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "حدود الشرائح يجب أن تكون متزايدة قطعاً" });
    }
  }
  const open = brackets.filter((b) => b.upTo == null);
  return [...numeric, ...open];
}

export async function updatePayrollLegalSettings(
  input: UpdatePayrollLegalInput,
  actor: Actor,
): Promise<UpdatePayrollLegalResult> {
  // تحقّق دفاعيّ (الراوتر يتحقّق أيضاً بـzod — دفاع في العمق).
  assertPct(input.socialSecurityEmployeeRate, "نسبة حصّة الموظف");
  assertPct(input.socialSecurityEmployerRate, "نسبة حصّة رب العمل");
  if (input.socialSecurityBase !== "basic" && input.socialSecurityBase !== "gross") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "وعاء الضمان يجب أن يكون الأساسيّ أو الإجماليّ" });
  }
  if (!MONEY_RE.test(input.incomeTaxExemption)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الإعفاء يجب أن يكون مبلغاً غير سالب" });
  }
  if (!MONEY_RE.test(input.endOfServiceDaysPerYear) || money(input.endOfServiceDaysPerYear).gt(MAX_DAYS_PER_YEAR)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `أيام نهاية الخدمة/سنة يجب أن تكون بين ٠ و${MAX_DAYS_PER_YEAR}` });
  }
  const sortedBrackets = validateAndSortBrackets(input.incomeTaxBrackets, input.incomeTaxEnabled);

  return withTx(async (tx) => {
    const beforeRows = await tx.select().from(payrollLegalSettings).where(eq(payrollLegalSettings.id, 1)).limit(1);
    const before = toView(beforeRows[0]);

    // ensure-row ثم تحديث (نمط taxSettings/openingModeSettings) — يعمل حتى لو لم تُقرأ الإعدادات من قبل.
    await tx
      .insert(payrollLegalSettings)
      .values({ id: 1 })
      .onDuplicateKeyUpdate({ set: { id: 1 } });

    await tx
      .update(payrollLegalSettings)
      .set({
        socialSecurityEnabled: input.socialSecurityEnabled,
        socialSecurityEmployeeRate: input.socialSecurityEmployeeRate,
        socialSecurityEmployerRate: input.socialSecurityEmployerRate,
        socialSecurityBase: input.socialSecurityBase,
        incomeTaxEnabled: input.incomeTaxEnabled,
        incomeTaxBrackets: sortedBrackets,
        incomeTaxExemption: input.incomeTaxExemption,
        endOfServiceEnabled: input.endOfServiceEnabled,
        endOfServiceDaysPerYear: input.endOfServiceDaysPerYear,
        updatedBy: actor.userId,
      })
      .where(eq(payrollLegalSettings.id, 1));

    const rows = await tx.select().from(payrollLegalSettings).where(eq(payrollLegalSettings.id, 1)).limit(1);
    if (!rows[0]) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر تحديث إعدادات المكوّنات القانونية" });
    return { before, after: toView(rows[0]) };
  });
}
