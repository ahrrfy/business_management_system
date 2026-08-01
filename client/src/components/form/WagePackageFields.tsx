/* ============================================================================
 * حزمة الأجر — محرّرٌ واحد لكل الحقول الحاملة للأجر
 * (client/src/components/form/WagePackageFields.tsx)
 *
 * يُستعمل في مكانين اثنين لا ثالث لهما: نموذج الموظف (إضافةً، وتعديلاً للأدمن) وشاشة
 * الترقيات (المسار المزدوج الاعتماد لتغييرها بعد التعيين). استُخرج ليمنع انحرافَ
 * محرّرين لنفس البيانات — فالخادم يقارن **بصمةً واحدة** (`hr/wageProfile.ts`) وأيّ
 * اختلافٍ في القيم الافتراضية بين شاشتين كان سيُنتج «تغييراً» وهمياً يُرفض بلا سبب مفهوم.
 * ========================================================================== */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/form/MoneyInput";
import { notify } from "@/lib/notify";
import { DAY_RATES_DEFAULT, WEEK_DAYS } from "@shared/hr";
import { normalizeScheduleShape } from "@shared/wageDiff";

/** يومٌ في الجدول: ساعاته (صفر = راحة) وسعرُ ساعته الصريح (فارغ = يُشتقّ من الراتب). */
export interface WageDayValue {
  hours: number;
  rate?: number | null;
}

/** القيم التي يحرّرها هذا المكوّن — مطابقةٌ حقلاً بحقلٍ للبصمة الأجرية الخادمية. */
export interface WagePackageValue {
  payType: "monthly" | "hourly";
  salary: string;
  allowances: string;
  attendanceExempt: boolean;
  dayRates: Record<string, number>;
  schedule: Record<string, WageDayValue>;
}

/** الجدول الافتراضي للنموذج — يطابق `DEFAULT_WORK_SCHEDULE` الخادميّ (الجمعة راحة). */
export const defaultWageSchedule = (): Record<string, WageDayValue> =>
  Object.fromEntries(WEEK_DAYS.map((d) => [d, { hours: d === "الجمعة" ? 0 : 8, rate: null }]));

/**
 * قيمُ البداية من صفّ موظف — نقطةُ التطبيع الوحيدة للشاشتين، وتستعمل **نفس** مُطبِّع
 * الخادم (`@shared/wageDiff`) فلا يُنتج اختلافُ قراءةٍ «تغييراً» وهمياً يرفضه الحارس.
 */
export function wageValueFromEmployee(e: {
  payType?: string | null;
  salary?: unknown;
  allowances?: unknown;
  attendanceExempt?: unknown;
  dayRates?: unknown;
  workSchedule?: unknown;
} | null | undefined): WagePackageValue {
  return {
    payType: (e?.payType as "monthly" | "hourly") ?? "monthly",
    salary: e?.salary != null ? String(e.salary) : "",
    allowances: e?.allowances != null ? String(e.allowances) : "0",
    attendanceExempt: !!e?.attendanceExempt,
    // أسعار الأيام: احتياطٌ لكل يومٍ على حدة (مطابقٌ لـattendanceService.rateForDay).
    dayRates: { ...DAY_RATES_DEFAULT, ...((e?.dayRates as Record<string, number>) ?? {}) },
    // الجدول: احتياطٌ للكائن كلّه (مطابقٌ لـpayrollService) لا دمجٌ يومياً، مع قبول
    // الشكل القديم (رقمٌ = ساعات) وإكمال الأيام الناقصة راحةً.
    schedule: normalizeScheduleShape(e?.workSchedule, defaultWageSchedule()),
  };
}

/** مقام سعر الساعة: ساعات أول ٣٠ يوماً من الشهر الجاري وفق الجدول (مطابقٌ للنواة الخادمية). */
function standardHours(schedule: Record<string, WageDayValue>): number {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  let std = 0;
  for (let i = 0; i < 30; i++) {
    const d = new Date(first.getTime() + i * 86_400_000);
    std += Number(schedule[WEEK_DAYS[d.getUTCDay()]]?.hours) || 0;
  }
  return std;
}

export interface WagePackageFieldsProps {
  value: WagePackageValue;
  onChange: (patch: Partial<WagePackageValue>) => void;
  /** للعرض فقط (تعديلُ موظفٍ بيد غير الأدمن — التغيير يمرّ بالترقيات). */
  disabled?: boolean;
}

export function WagePackageFields({ value, onChange, disabled = false }: WagePackageFieldsProps) {
  const { payType, schedule, dayRates } = value;
  const setSchedule = (patch: (prev: Record<string, WageDayValue>) => Record<string, WageDayValue>) =>
    onChange({ schedule: patch(schedule) });

  return (
    <div className="md:col-span-3 grid grid-cols-1 md:grid-cols-3 gap-4">
      {payType === "monthly" ? (
        <>
          <div className="space-y-1">
            <Label htmlFor="wp-sal">الراتب الأساس (د.ع) *</Label>
            <MoneyInput id="wp-sal" value={value.salary} onChange={(salary) => onChange({ salary })} decimals={0} placeholder="1,000,000" disabled={disabled} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="wp-allw">البدلات (د.ع)</Label>
            <MoneyInput id="wp-allw" value={value.allowances} onChange={(allowances) => onChange({ allowances })} decimals={0} placeholder="0" disabled={disabled} />
          </div>
          <div className="hidden md:block" aria-hidden />
        </>
      ) : (
        <div className="md:col-span-3 space-y-1">
          <Label>سعر الساعة لكل يوم (د.ع)</Label>
          <div className="grid grid-cols-2 md:grid-cols-7 gap-2">
            {WEEK_DAYS.map((d) => (
              <div key={d} className="space-y-1">
                <span className="text-xs text-muted-foreground">{d}</span>
                <Input
                  dir="ltr"
                  inputMode="numeric"
                  disabled={disabled}
                  aria-label={`سعر ساعة ${d}`}
                  value={String(dayRates[d] ?? 0)}
                  onChange={(e) => onChange({ dayRates: { ...dayRates, [d]: Number(e.target.value.replace(/\D/g, "")) || 0 } })}
                />
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">أجر اليوم = ساعات العمل × سعر ساعة ذلك اليوم.</p>
        </div>
      )}

      {/* إعفاءٌ من الحضور — راتبٌ ثابت (قرار المالك ٣١/٧). للشهريّ وحده: الساعيّ
          يُدفع له من سجلّ الحضور دائماً، فتأشيرُه كان يَعِد براتبٍ ثابتٍ لا يُصرف. */}
      {payType === "monthly" && (
        <div className="md:col-span-3 border-t pt-3">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="size-4 mt-0.5"
              disabled={disabled}
              checked={value.attendanceExempt}
              onChange={(ev) => onChange({ attendanceExempt: ev.target.checked })}
            />
            <span>
              <span className="font-medium">راتب ثابت — لا يخضع للحضور</span>
              <span className="block text-xs text-muted-foreground mt-0.5 leading-relaxed">
                للمُلّاك ولمن لا جهاز بصمة له. يُصرف راتبه ومخصّصاته كاملةً بلا احتساب ساعات،
                ولا يظهر في تنبيهات «غير مربوط بجهاز». والإجازات والسلف والعمولات تبقى تعمل كالمعتاد.
                <span className="block mt-0.5">
                  بلا هذا التأشير ومع تفعيل الأجر بالحضور، موظفٌ بلا بصمات يُحتسب شهراً كاملاً غياباً.
                </span>
              </span>
            </span>
          </label>
        </div>
      )}

      {/* جدول الدوام الأسبوعيّ — كل قيمة صريحة بيد المالك (قرار ٣١/٧). */}
      <div className={`md:col-span-3 space-y-2 border-t pt-3 ${value.attendanceExempt ? "opacity-50" : ""}`}>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <Label>جدول الدوام الأسبوعيّ — ساعات كل يوم وسعر ساعته</Label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => {
              // المقام = ساعات أول ٣٠ يوماً من الشهر الجاري وفق جدوله (مطابق للنواة
              // الخادمية حرفياً). كان يستعمل متوسّط «٤٫٣٤٥ أسبوعاً» فينحرف حتى ٢٧ ألفاً
              // في شباط — والمالك يشترط «الراتب بالضبط دون نقصان ديناراً واحداً».
              const std = standardHours(schedule);
              const sal = Number(String(value.salary).replace(/[^\d.]/g, "")) || 0;
              if (!std || !sal) {
                notify.warn("أدخل الراتب وساعات الأيام أولاً ليُحسب سعر الساعة.");
                return;
              }
              const r = Math.round((sal / std) * 100) / 100;
              onChange({
                schedule: Object.fromEntries(
                  WEEK_DAYS.map((d) => [d, { hours: schedule[d]?.hours ?? 0, rate: (schedule[d]?.hours ?? 0) > 0 ? r : null }]),
                ),
              });
            }}
          >
            احسب الأسعار من الراتب
          </Button>
        </div>
        <div className="rounded-md border divide-y">
          <div className="grid grid-cols-3 gap-2 bg-muted/50 px-2 py-1 text-[11px] font-medium">
            <span>اليوم</span><span className="text-center">ساعات الدوام</span><span className="text-center">سعر الساعة (د.ع)</span>
          </div>
          {WEEK_DAYS.map((d) => (
            <div key={d} className="grid grid-cols-3 gap-2 items-center px-2 py-1.5">
              <span className="text-xs">{d}</span>
              <Input
                type="number" min={0} max={24} step="0.5" dir="ltr" className="h-8 text-center"
                disabled={disabled}
                aria-label={`ساعات دوام ${d}`}
                value={schedule[d]?.hours ?? 0}
                onChange={(ev) => setSchedule((prev) => ({ ...prev, [d]: { ...(prev[d] ?? {}), hours: Number(ev.target.value) } }))}
              />
              <Input
                type="number" min={0} step="250" dir="ltr" className="h-8 text-center"
                placeholder="—"
                aria-label={`سعر ساعة ${d}`}
                disabled={disabled || !(schedule[d]?.hours > 0)}
                value={schedule[d]?.rate ?? ""}
                onChange={(ev) => setSchedule((prev) => ({ ...prev, [d]: { ...(prev[d] ?? { hours: 0 }), rate: ev.target.value === "" ? null : Number(ev.target.value) } }))}
              />
            </div>
          ))}
          <div className="grid grid-cols-3 gap-2 px-2 py-1.5 text-[11px] bg-muted/30">
            <span className="font-medium">مجموع الأسبوع</span>
            <span className="text-center tabular-nums font-medium" dir="ltr">
              {WEEK_DAYS.reduce((t, d) => t + (Number(schedule[d]?.hours) || 0), 0)} ساعة
            </span>
            <span />
          </div>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          <span className="font-medium">صفر ساعة = يوم راحة.</span> وأجر اليوم = ساعاته المحتسَبة × سعره،
          والراتب المستحقّ = مجموع أيام الشهر تراكمياً. الساعات فوق المقرَّر اليوميّ تُحتسب
          <span className="font-medium"> أوفر تايم</span> ببندٍ مستقلّ بسعر اليوم نفسه.
          <span className="font-medium">تركُ السعر فارغاً هو الأدقّ:</span> يُحسب شهرياً من
          (الراتب ÷ ساعات أول ٣٠ يوماً) فيطابق الراتب بالضبط دون نقصان دينار — وشهرُ ٣١ يوماً
          يُدفع بيومه الإضافيّ، والشهر الأقصر (٢٨/٢٩) يُكمَّل إلى ٣٠. وتثبيتُ سعرٍ يدويّ
          يجعل المجموع يتبع السعر لا الراتب.
        </p>
      </div>
    </div>
  );
}
