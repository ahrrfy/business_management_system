/**
 * shared/wageDiff.ts — وصفُ الفرق بين بصمتين أجريتين، مشتركٌ بين الخادم والعميل.
 *
 * سببُ وجوده: المعتمِد الثاني هو **كلُّ** ما تستند إليه حوكمة الأجر، فإن رأى «حزمة أجر»
 * بلا قيمٍ قبل/بعد فقد اعتَمد ما لم يره — وتصير البوّابة مسرحاً. وشاشةُ الترقيات تعرض
 * الفرق، والخادم يسمّي الحقول في رسالة المنع وفي سجلّ التدقيق ⇒ صياغةٌ واحدة لا اثنتان
 * تنحرفان. نقيٌّ بلا اعتمادية (لا decimal.js ولا drizzle) ليصلح للطرفين.
 */

/** أيام الأسبوع بترتيب getDay (الأحد=0) — مكرّرة هنا عمداً لإبقاء الوحدة بلا اعتمادية. */
const DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"] as const;

/** يومٌ في الجدول بعد التطبيع: ساعاته (صفر = راحة) وسعرُ ساعته الصريح (null = مُشتقّ). */
export interface WageDayShape {
  hours: number;
  rate: number | null;
}

/** شكلُ البصمة الأجرية كما يُنتجها `server/services/hr/wageProfile.ts`. */
export interface WageProfileShape {
  payType: string;
  salary: string | null;
  allowances: string;
  attendanceExempt: boolean;
  dayRates: Record<string, number>;
  workSchedule: Record<string, WageDayShape>;
}

/** تسميات عربية للحقول — مصدرُ حقيقةٍ واحد لرسالة المنع وسجلّ التدقيق وشاشة الاعتماد. */
export const WAGE_FIELD_LABELS: Record<keyof WageProfileShape, string> = {
  payType: "طريقة الأجر",
  salary: "الراتب الأساس",
  allowances: "البدلات",
  attendanceExempt: "الإعفاء من الحضور (راتب ثابت)",
  dayRates: "أسعار ساعات الأيام",
  workSchedule: "جدول الدوام الأسبوعيّ",
};

/**
 * يُطبّع جدول دوامٍ مخزّناً إلى **سبعة أيامٍ بشكلٍ واحد**، بنفس دلالة `attendancePay.dayOf`:
 *   • غيرُ كائنٍ (null/قيمة تالفة) ⇒ يُطبَّع `fallback` بدله (احتياطُ الكائن كلّه، كما يفعل
 *     `payrollService` — لا دمجٌ يوميّ مع الافتراضي).
 *   • الشكل القديم (رقمٌ = ساعات) مقبول، وسعرُه مُشتقّ (null).
 *   • يومٌ ناقصٌ داخل جدولٍ موجود = **راحة (صفر)** لا ثمانيَ ساعاتٍ افتراضية.
 *   • ساعاتٌ/سعرٌ غير موجب ⇒ صفر/null (سعرٌ غير موجب يعني «يُشتقّ من الراتب»).
 *
 * مشتركٌ بين الخادم (بوّابة المقارنة) والعميل (المحرّر): كان للعميل نسخةٌ ساذجة تُمرّر
 * الشكل القديم كما هو، فيُعرَض جدولٌ مثل `{"الأحد": 8}` أصفاراً ويُرسَل أرقاماً خاماً
 * يرفضها تحقّقُ الموجّه ⇒ انسدادُ المسار الوحيد لغير الأدمن (مراجعة Codex P1، PR #449).
 */
export function normalizeScheduleShape(
  raw: unknown,
  // السعر اختياريّ في المُدخَل (محرّرُ الواجهة يتركه غير مُعرَّف) ومحسومٌ في المُخرَج.
  fallback: Record<string, { hours: number; rate?: number | null }>,
): Record<string, WageDayShape> {
  const src = (raw && typeof raw === "object" ? raw : fallback) as Record<string, unknown>;
  const out: Record<string, WageDayShape> = {};
  for (const d of DAYS) {
    const v = src[d] as { hours?: unknown; rate?: unknown } | number | undefined;
    const hours = Number(typeof v === "number" ? v : v?.hours);
    const rate = typeof v === "number" || v == null || v.rate == null ? Number.NaN : Number(v.rate);
    out[d] = {
      hours: Number.isFinite(hours) && hours > 0 ? hours : 0,
      rate: Number.isFinite(rate) && rate > 0 ? rate : null,
    };
  }
  return out;
}

/** سطرُ فرقٍ واحد جاهزٌ للعرض: ماذا تغيّر، من أيّ قيمة، إلى أيّ قيمة. */
export interface WageDiffRow {
  key: keyof WageProfileShape;
  label: string;
  before: string;
  after: string;
}

const num = (v: unknown): string => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "0";
};
const payTypeText = (k: string) => (k === "hourly" ? "بالساعة" : "راتب شهري");

/** «٨ ساعات بسعر ٥٬٠٠٠» / «راحة» / «٨ ساعات بسعرٍ مُشتقّ». */
function dayText(d: WageDayShape | undefined): string {
  const hours = Number(d?.hours ?? 0);
  if (!(hours > 0)) return "راحة";
  return d?.rate != null ? `${num(hours)} ساعة بسعر ${num(d.rate)}` : `${num(hours)} ساعة بسعرٍ مُشتقّ`;
}

/**
 * الفرق بين بصمتين، سطراً لكل حقلٍ تغيّر. الجدولُ وأسعارُ الأيام يُفصَّلان **باليوم
 * الذي تغيّر وحده** — عرضُ الأيام السبعة كلّها يُغرِق التغييرَ الحقيقيّ في ضجيج.
 */
export function describeWageDiff(from: WageProfileShape | null, to: WageProfileShape | null): WageDiffRow[] {
  if (!from || !to) return [];
  const rows: WageDiffRow[] = [];
  const push = (key: keyof WageProfileShape, before: string, after: string) =>
    rows.push({ key, label: WAGE_FIELD_LABELS[key], before, after });

  if (from.payType !== to.payType) push("payType", payTypeText(from.payType), payTypeText(to.payType));
  if ((from.salary ?? "") !== (to.salary ?? "")) {
    push("salary", from.salary != null ? num(from.salary) : "—", to.salary != null ? num(to.salary) : "—");
  }
  if (from.allowances !== to.allowances) push("allowances", num(from.allowances), num(to.allowances));
  if (from.attendanceExempt !== to.attendanceExempt) {
    push("attendanceExempt", from.attendanceExempt ? "معفى" : "خاضع للحضور", to.attendanceExempt ? "معفى" : "خاضع للحضور");
  }

  const rateDays = DAYS.filter((d) => Number(from.dayRates?.[d] ?? 0) !== Number(to.dayRates?.[d] ?? 0));
  for (const d of rateDays) {
    rows.push({
      key: "dayRates",
      label: `${WAGE_FIELD_LABELS.dayRates} — ${d}`,
      before: num(from.dayRates?.[d]),
      after: num(to.dayRates?.[d]),
    });
  }

  const schedDays = DAYS.filter((d) => {
    const a = from.workSchedule?.[d];
    const b = to.workSchedule?.[d];
    return Number(a?.hours ?? 0) !== Number(b?.hours ?? 0) || (a?.rate ?? null) !== (b?.rate ?? null);
  });
  for (const d of schedDays) {
    rows.push({
      key: "workSchedule",
      label: `${WAGE_FIELD_LABELS.workSchedule} — ${d}`,
      before: dayText(from.workSchedule?.[d]),
      after: dayText(to.workSchedule?.[d]),
    });
  }

  return rows;
}

/** أسماء الحقول المتغيّرة (بلا تفصيل الأيام) — للرسائل المختصرة وسجلّ التدقيق. */
export function changedWageFields(from: WageProfileShape | null, to: WageProfileShape | null): (keyof WageProfileShape)[] {
  const seen: (keyof WageProfileShape)[] = [];
  for (const r of describeWageDiff(from, to)) if (!seen.includes(r.key)) seen.push(r.key);
  return seen;
}
