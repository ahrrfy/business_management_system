// أدوات مشتركة لحزمة الرواتب (يستهلكها generate.ts وupdate.ts وlifecycle.ts): التحقّق من صيغة
// الشهر، تاريخ أول القيد، صافي البند، إعادة حساب مجاميع المسيّر، وحساب أيام/فترات الإجازة بلا راتب.
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import { payrollItems, payrollRuns } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { daysBetween } from "../hr/attendancePay";
import { money, round2, toDbMoney } from "../money";

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function assertPeriod(period: string): string {
  const p = period?.trim();
  if (!p || !PERIOD_RE.test(p)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الشهر يجب أن يكون بصيغة YYYY-MM" });
  }
  return p;
}

/** أول يوم من الشهر (YYYY-MM-01) — يُستعمل entryDate للقيود ولا تأثير له على dedupe. */
export function periodEntryDate(period: string): string {
  return `${period}-01`;
}

/** صافي البند = الإجمالي + الإضافي + العمولة − الاستقطاع (لا يقلّ عن الصفر منطقياً، لكن لا نقصّ —
 *  قد يكون الاستقطاع أكبر فعلاً (سلفة)؛ نتركه كما هو ليعكس الواقع، والواجهة تعرضه بدقّة).
 *  commissions (٦/٧/٢٦): العمولة تُلتقط من تشغيلة العمولات المعتمدة لنفس الشهر عند التوليد —
 *  موجبة دائماً (السالب لا يخصم من الراتب؛ يبقى مرحَّلاً في سلسلة التشغيلات). */
export function computeNet(gross: Decimal, overtime: Decimal, commission: Decimal, deductions: Decimal): Decimal {
  return round2(gross.plus(overtime).plus(commission).minus(deductions));
}

/** يجمع بنود المسيّر (داخل tx) ويحدّث رأس المسيّر بالمجاميع وعدد الموظفين. */
export async function recomputeRunTotals(tx: Tx, runId: number): Promise<void> {
  const items = await tx
    .select({
      gross: payrollItems.gross,
      overtime: payrollItems.overtime,
      commission: payrollItems.commission,
      deductions: payrollItems.deductions,
      net: payrollItems.net,
      // المكوّنات القانونية (البند ④) — 0 عند التعطيل ⇒ مجاميعها 0 ⇒ صفر انحدار.
      ssEmployee: payrollItems.socialSecurityEmployee,
      incomeTax: payrollItems.incomeTax,
      ssEmployer: payrollItems.socialSecurityEmployer,
      eosAccrual: payrollItems.endOfServiceAccrual,
    })
    .from(payrollItems)
    .where(eq(payrollItems.runId, runId));
  let g = new Decimal(0);
  let ot = new Decimal(0);
  let com = new Decimal(0);
  let ded = new Decimal(0);
  let net = new Decimal(0);
  let sse = new Decimal(0);
  let tax = new Decimal(0);
  let ssr = new Decimal(0);
  let eos = new Decimal(0);
  for (const it of items) {
    g = g.plus(money(it.gross));
    ot = ot.plus(money(it.overtime));
    com = com.plus(money(it.commission));
    ded = ded.plus(money(it.deductions));
    net = net.plus(money(it.net));
    sse = sse.plus(money(it.ssEmployee));
    tax = tax.plus(money(it.incomeTax));
    ssr = ssr.plus(money(it.ssEmployer));
    eos = eos.plus(money(it.eosAccrual));
  }
  await tx
    .update(payrollRuns)
    .set({
      employeeCount: items.length,
      totalGross: toDbMoney(g),
      totalOvertime: toDbMoney(ot),
      totalCommission: toDbMoney(com),
      totalDeductions: toDbMoney(ded),
      totalNet: toDbMoney(net),
      totalSocialSecurityEmployee: toDbMoney(sse),
      totalIncomeTax: toDbMoney(tax),
      totalSocialSecurityEmployer: toDbMoney(ssr),
      totalEndOfServiceAccrual: toDbMoney(eos),
    })
    .where(eq(payrollRuns.id, runId));
}

/**
 * عدد الأيام التقويمية التي تقع فيها الفترات ضمن نافذة [windowFrom..windowTo] شاملةً.
 * تُطبَّق على أيام الإجازة بلا راتب لتُقصّ عند نافذة عمل الموظف (تعيين/فصل في منتصف الشهر)
 * فلا تُخصم مرّتين: مرّةً بالتناسب الوظيفيّ ومرّةً كإجازة. الفترات المتداخلة تُوحَّد
 * فلا يُحتسب اليوم الواحد مرّتين لو تداخل طلبان.
 */
export function countDaysWithin(
  spans: Array<{ from: string; to: string }>,
  windowFrom: string,
  windowTo: string,
): number {
  if (windowTo < windowFrom) return 0;
  const clipped = spans
    .map((s) => ({ from: s.from > windowFrom ? s.from : windowFrom, to: s.to < windowTo ? s.to : windowTo }))
    .filter((s) => s.to >= s.from)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  let days = 0;
  let cursor: string | null = null; // آخر يوم مُحتسَب (لتوحيد التداخل)
  for (const s of clipped) {
    const start = cursor != null && s.from <= cursor ? nextDay(cursor) : s.from;
    if (start > s.to) continue;
    days += Math.floor((Date.parse(`${s.to}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
    cursor = s.to > (cursor ?? "") ? s.to : cursor;
  }
  return days;
}

function nextDay(ymd: string): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** يفرد فترات الإجازة إلى مجموعة تواريخ مقصوصة عند نافذة العمل (لنموذج الحضور). */
export function expandSpans(spans: Array<{ from: string; to: string }>, windowFrom: string, windowTo: string): Set<string> {
  const out = new Set<string>();
  for (const s of spans) {
    const from = s.from > windowFrom ? s.from : windowFrom;
    const to = s.to < windowTo ? s.to : windowTo;
    for (const d of daysBetween(from, to)) out.add(d);
  }
  return out;
}
