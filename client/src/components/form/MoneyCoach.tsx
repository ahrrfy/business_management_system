/**
 * MoneyCoach.tsx — «مرافقٌ حيّ» أسفل حقل التكلفة/السعر يعرض ثلاث معلومات ديناميكية:
 *   ١) هامش الربح المتوقّع (أخضر ≥١٠٪، كهرمانيّ ٠-١٠٪، أحمر سالب).
 *   ٢) نسبة التكلفة إلى سعر البيع (كنص «1.20×»).
 *   ٣) مقارنة بمعيار الفئة إن أُعطي (مدى نموذجيّ لمنتجات نفس الفئة).
 *
 * **الغاية:** يتحدّى الرقم *لحظة* كتابته، قبل أن يستقرّ في القاعدة. الحارس الحاليّ (priceSanity)
 * رافضٌ عند الحفظ فقط ⇒ المستخدم يفاجأ. المرافق يُلمّح باستمرار فيتصحّح ذاتياً قبل الوصول لـsave.
 *
 * **بلا تدخّل عند غياب البيانات:** لا cost أو لا retail ⇒ يخفي نفسه. حصر مساحة العرض في سطرٍ
 * صغيرٍ (`text-[11px]`) — لا يزعج الشاشة الكثيفة.
 */
import { cn } from "@/lib/utils";

export interface MoneyCoachProps {
  /** التكلفة الأساس (لكل وحدة الأساس). */
  cost: string | number | null | undefined;
  /** سعر البيع للمرجع (يمكن أن يكون سعر مفرد الوحدة الأساس، أو سعر الفئة المرجعي). */
  retail: string | number | null | undefined;
  /** إحصاءات الفئة الاختيارية للمقارنة الذكية. */
  categoryStats?: {
    /** أقلّ تكلفة معتادة في الفئة. */
    minCost?: number;
    /** أعلى تكلفة معتادة في الفئة. */
    maxCost?: number;
    /** الوسيط (Median) للتكلفة. */
    medianCost?: number;
    /** عدد المنتجات في الفئة (نبيّن اللبس إن كان صغيراً). */
    n?: number;
  };
  className?: string;
}

function toNum(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const s = typeof v === "string" ? v.trim() : String(v);
  if (s === "" || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function MoneyCoach({ cost, retail, categoryStats, className }: MoneyCoachProps) {
  const costN = toNum(cost);
  const retailN = toNum(retail);
  const minC = categoryStats?.minCost;
  const maxC = categoryStats?.maxCost;
  const n = categoryStats?.n ?? 0;
  const hasCatStats = minC != null && maxC != null && n >= 5;

  // إن لا شيء منها ⇒ لا نعرض شيئاً.
  if (costN == null && !hasCatStats) return null;

  const marginPct =
    costN != null && retailN != null && retailN > 0
      ? ((retailN - costN) / retailN) * 100
      : null;
  const ratio = costN != null && retailN != null && retailN > 0 ? costN / retailN : null;

  const marginLevel: "good" | "warn" | "bad" | "none" =
    marginPct == null ? "none" : marginPct < 0 ? "bad" : marginPct < 10 ? "warn" : "good";

  const marginColor =
    marginLevel === "good"
      ? "text-emerald-600 dark:text-emerald-400"
      : marginLevel === "warn"
      ? "text-amber-600 dark:text-amber-400"
      : marginLevel === "bad"
      ? "text-red-600 dark:text-red-400 font-semibold"
      : "text-muted-foreground";

  const outOfCatRange =
    hasCatStats && costN != null && (costN < (minC as number) * 0.5 || costN > (maxC as number) * 2);

  return (
    <div
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] mt-1", className)}
      aria-live="polite"
    >
      {marginPct != null && (
        <span className={cn("tabular-nums", marginColor)}>
          الهامش: {marginPct.toFixed(1)}٪
          {ratio != null && <span className="text-muted-foreground/70 ms-1">({ratio.toFixed(2)}×)</span>}
        </span>
      )}
      {hasCatStats && (
        <span className={cn("tabular-nums", outOfCatRange ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
          الفئة: <span className="font-mono" dir="ltr">{fmt(minC as number)}–{fmt(maxC as number)}</span>
          <span className="text-muted-foreground/70 ms-1">(n={n})</span>
          {outOfCatRange && <span className="ms-1 text-[10px]">— خارج المدى</span>}
        </span>
      )}
    </div>
  );
}
