// هيكل تقرير موحّد — يمنح كل تقارير المركز مظهراً احترافياً متطابقاً (نمط عالمي):
// رأس (رابط رجوع للمركز + عنوان + وصف + إجراءات) عبر `PageHeader` المشترك ⇒ رأسٌ واحد للنظام
// كلّه لا نسخةٌ خاصة بالتقارير · شريط فلاتر · شريط مؤشّرات ملخّص (KPI) · منطقة المحتوى ·
// شريط أدوات موحّد (تصدير Excel/CSV + طباعة A4). أزرار التصدير/الطباعة تظهر فقط عند تمرير
// المعالِج المقابل ⇒ كل تقرير يكتفي بتمرير onExport/onPrint ويحصل على الأنماط الثلاثة.
import { type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/PageHeader";
import { TONE_TEXT_CLASS, type Tone } from "@/lib/tone";

/** نبرة مؤشّر — مُعاد تصديرها من `@/lib/tone` (مصدرٌ واحد مشترك مع StatCard). */
export type KpiTone = Tone;

export interface KpiItem {
  label: string;
  value: ReactNode;
  /** نَصّ تَلميح خام — يُحفَظ سَلسِلة لِلتَصدير/الطِباعة (Excel/PDF). */
  hint?: string;
  /** عُقدة عَرض غَنية (JSX/Lucide) لِلشاشة فَقَط. تَلغي `hint` بَصَرياً لكِنّ `hint` يَبقى لِلتَصدير. */
  hintNode?: ReactNode;
  tone?: KpiTone;
}

export function ReportShell({
  title,
  description,
  backHref = "/reports",
  filters,
  kpis,
  actions,
  onExport,
  onExportCsv,
  onPrint,
  exportDisabled,
  printDisabled,
  note,
  children,
}: {
  title: string;
  description?: string;
  /** رابط الرجوع لمركز التقارير (افتراضي /reports). مرّر null لإخفائه. */
  backHref?: string | null;
  filters?: ReactNode;
  kpis?: KpiItem[];
  /** إجراءات إضافية في الرأس (روابط drill-through مثلاً). */
  actions?: ReactNode;
  onExport?: () => void;
  onExportCsv?: () => void;
  onPrint?: () => void;
  exportDisabled?: boolean;
  printDisabled?: boolean;
  /** تنويه/افتراضات يظهر أعلى المحتوى (للقوائم المالية المبسّطة). */
  note?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-4">
      {/* الرأس — عبر PageHeader المشترك (رابط رجوع + عنوان + وصف)، وأزرار التصدير/الطباعة في منطقة الإجراءات. */}
      <PageHeader
        title={title}
        description={description}
        backHref={backHref ?? undefined}
        backLabel="مركز التقارير"
        actions={
          <>
            {actions}
            {onExportCsv && (
              <Button variant="outline" size="sm" disabled={exportDisabled} onClick={onExportCsv}>
                تصدير CSV
              </Button>
            )}
            {onExport && (
              <Button variant="outline" size="sm" disabled={exportDisabled} onClick={onExport}>
                تصدير Excel
              </Button>
            )}
            {onPrint && (
              <Button variant="outline" size="sm" disabled={printDisabled} onClick={onPrint}>
                طباعة / PDF
              </Button>
            )}
          </>
        }
      />

      {/* شريط الفلاتر */}
      {filters && (
        <Card>
          <CardContent className="pt-4 pb-3">{filters}</CardContent>
        </Card>
      )}

      {/* تنويه */}
      {note && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
          {note}
        </div>
      )}

      {/* شريط المؤشّرات */}
      {kpis && kpis.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {kpis.map((k, i) => (
            <Card key={i}>
              <CardContent className="pt-4 pb-3 text-center">
                <p className="text-xs text-muted-foreground">{k.label}</p>
                <p className={cn("text-xl font-bold tabular-nums", TONE_TEXT_CLASS[k.tone ?? "default"])} dir="ltr">
                  {k.value}
                </p>
                {(k.hintNode ?? k.hint) && <p className="mt-0.5 text-[10px] text-muted-foreground">{k.hintNode ?? k.hint}</p>}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* المحتوى */}
      {children}
    </div>
  );
}
