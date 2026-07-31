// «جرّب خطتك» — مثال تعليمي حيّ داخل حوار خطة العمولات.
//
// يأخذ المستويات كما يكتبها المستخدم لحظتها ويعرض ماذا سيستحق موظف افتراضي، خطوةً بخطوة،
// بنفس منطق محرّك الخادم (client/src/lib/commissions/example.ts — مُختبَر ضدّ المحرّك).
// عرضٌ فقط: لا شيء هنا يُحفَظ ولا يُرسَل.
import { useState } from "react";
import { MoneyInput } from "@/components/form/MoneyInput";
import { computeExample, type ExampleTier, type TierMode } from "@/lib/commissions/example";
import { iqd } from "@/lib/hr/ui";
import { Lightbulb } from "lucide-react";

export function TierPlayground({ tierMode, tiers }: { tierMode: TierMode; tiers: ExampleTier[] }) {
  const [target, setTarget] = useState("10000000");
  const [sales, setSales] = useState("8000000");

  const r = computeExample({ tierMode, tiers, sales, target });
  const rank = r.tierRank;

  return (
    <div className="rounded-md border border-primary/30 bg-accent/20 p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <Lightbulb className="size-4 shrink-0 text-primary" aria-hidden />
        مثال تعليمي — جرّب خطتك قبل الحفظ
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        أدخل أرقاماً افتراضية لموظف، وسيريك النظام كيف يحتسب عمولته بهذه المستويات بالضبط. لا شيء هنا يُحفَظ.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        {tierMode === "TARGET_PCT" && (
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">هدف الموظف الشهري (د.ع)</label>
            <MoneyInput value={target} onChange={setTarget} decimals={0} className="h-8" ariaLabel="هدف المثال" />
          </div>
        )}
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">صافي مبيعاته في الشهر بعد المرتجعات (د.ع)</label>
          <MoneyInput value={sales} onChange={setSales} decimals={0} className="h-8" ariaLabel="مبيعات المثال" />
        </div>
      </div>

      <ol className="mt-3 space-y-1 text-xs">
        {tierMode === "TARGET_PCT" && (
          <li>
            <span className="text-muted-foreground">نسبة تحقيق الهدف = </span>
            {r.noTarget ? (
              <span className="text-destructive">لا هدف — خطة «نسبة تحقيق الهدف» بلا هدف تعطي صفراً</span>
            ) : (
              <span className="tabular-nums" dir="ltr">
                {iqd(r.base)} ÷ {iqd(target)} = {r.achievementPct}%
              </span>
            )}
          </li>
        )}
        <li>
          <span className="text-muted-foreground">المستوى المطبَّق = </span>
          {rank != null && r.tier ? (
            <span>
              المستوى {rank} (من{" "}
              <span className="tabular-nums" dir="ltr">
                {tierMode === "TARGET_PCT" ? `${r.tier.threshold}%` : iqd(r.tier.threshold)}
              </span>
              ) ⇒ <span className="tabular-nums" dir="ltr">{r.tier.ratePct}%</span>
              {Number(r.fixedBonus) > 0 ? (
                <>
                  {" + مكافأة ثابتة "}
                  <span className="tabular-nums" dir="ltr">{iqd(r.fixedBonus)}</span>
                </>
              ) : null}
            </span>
          ) : (
            <span className="text-destructive">لم يبلغ أي مستوى ⇒ لا عمولة</span>
          )}
        </li>
        <li className="border-t pt-1">
          <span className="text-muted-foreground">العمولة المستحقّة = </span>
          {rank != null ? (
            <span className="tabular-nums" dir="ltr">
              {iqd(r.base)} × {r.tier?.ratePct}%
              {Number(r.fixedBonus) > 0 ? ` = ${iqd(r.ratePart)} + ${iqd(r.fixedBonus)}` : ""} ={" "}
              <span className="font-bold text-money-positive">{iqd(r.commission)}</span>
            </span>
          ) : (
            <span className="font-bold tabular-nums text-money-positive" dir="ltr">0</span>
          )}
          <span className="text-muted-foreground"> د.ع</span>
        </li>
      </ol>
    </div>
  );
}
