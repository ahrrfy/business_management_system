// هيكل تقرير موحّد — يمنح كل تقارير المركز مظهراً احترافياً متطابقاً (نمط عالمي):
// رأس (رابط رجوع للمركز + عنوان + وصف + إجراءات) عبر `PageHeader` المشترك ⇒ رأسٌ واحد للنظام
// كلّه لا نسخةٌ خاصة بالتقارير · شريط فلاتر · شريط مؤشّرات ملخّص (KPI) · منطقة المحتوى ·
// شريط أدوات موحّد (تصدير Excel/CSV + طباعة A4). أزرار التصدير/الطباعة تظهر فقط عند تمرير
// المعالِج المقابل ⇒ كل تقرير يكتفي بتمرير onExport/onPrint ويحصل على الأنماط الثلاثة.
import { type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/PageHeader";
import { TONE_TEXT_CLASS, type Tone } from "@/lib/tone";
import { FileSpreadsheet, Info, Printer } from "lucide-react";
import { WorkspaceBar, WorkspaceStatusBar } from "@/components/workspace/OperationalWorkspace";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

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
    <div className="space-y-2" data-report-workspace>
      {/* الرأس — عبر PageHeader المشترك (رابط رجوع + عنوان + وصف)، وأزرار التصدير/الطباعة مباشرة بنقرة واحدة. */}
      <PageHeader
        title={title}
        description={description}
        backHref={backHref ?? undefined}
        backLabel="مركز التقارير"
        variant="workspace"
        className="flex-wrap sm:flex-nowrap [&>div:first-child]:basis-full sm:[&>div:first-child]:basis-auto [&_h1]:shrink"
        actionsClassName="max-sm:min-w-0 max-sm:flex-wrap"
        actions={
          <>
            {note && (
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs text-[var(--sem-warn)] hover:bg-[var(--sem-warn-bg)] print:hidden">
                    <Info aria-hidden className="size-3.5" />
                    ملاحظة التقرير
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-80 text-start text-xs leading-5 border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]">
                  {note}
                </PopoverContent>
              </Popover>
            )}
            {actions}
            {onExportCsv && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                disabled={exportDisabled}
                onClick={() => onExportCsv()}
              >
                <FileSpreadsheet aria-hidden className="size-3.5" />
                تصدير CSV
              </Button>
            )}
            {onExport && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                disabled={exportDisabled}
                onClick={() => onExport()}
              >
                <FileSpreadsheet aria-hidden className="size-3.5" />
                تصدير Excel
              </Button>
            )}
            {onPrint && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                disabled={printDisabled}
                onClick={() => onPrint()}
              >
                <Printer aria-hidden className="size-3.5" />
                طباعة / PDF
              </Button>
            )}
          </>
        }
      />

      {/* شريط الفلاتر */}
      {filters && (
        <WorkspaceBar variant="filters" label="فلاتر التقرير" className="report-filter-bar overflow-x-auto">
          <div className="min-w-max [&>div]:!flex-nowrap">{filters}</div>
        </WorkspaceBar>
      )}

      {/* شريط مؤشرات التقرير الملخص — فوق الجدول مباشرة لقراءة الخلاصة الفورية */}
      {kpis && kpis.length > 0 && (
        <WorkspaceStatusBar label="مؤشرات التقرير" className="gap-0 overflow-x-auto p-0">
          {kpis.map((k, i) => {
            const hint = k.hintNode ?? k.hint;
            return (
              <div key={i} className="min-w-32 flex-1 border-e border-border/70 px-2.5 py-0.5 text-center last:border-e-0">
                <div className="flex items-center justify-center gap-1 text-2xs text-muted-foreground">
                  {/* bidi: تسمياتٌ كثيرةٌ عبر مركز التقارير تحمل مدىً رقمياً بشرطة («0–30 يوم») —
                      بلا dir="ltr" يُعاد ترتيبها بصرياً «30-0» داخل حاويةٍ RTL (أثبتَتْه جولةٌ
                      بصرية بقياس مواضع الأحرف، ٣/٩). لا أثر على تسميةٍ عربيةٍ بحتة. */}
                  <span className="truncate" dir="ltr">{k.label}</span>
                  {hint && (
                    <Popover>
                      <PopoverTrigger asChild>
                        <button type="button" className="grid size-4 shrink-0 place-items-center rounded hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`تفاصيل ${k.label}`}>
                          <Info aria-hidden className="size-3" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent side="top" className="w-72 text-start text-xs leading-5">
                        {hint}
                      </PopoverContent>
                    </Popover>
                  )}
                </div>
                <p className={cn("truncate text-xs font-bold tabular-nums", TONE_TEXT_CLASS[k.tone ?? "default"])} dir="ltr">
                  {k.value}
                </p>
              </div>
            );
          })}
        </WorkspaceStatusBar>
      )}

      {/* تنويه يظهر عند الطباعة فقط؛ على الشاشة يُعرض عبر زر Popover في الرأس */}
      {note && <div className="hidden print:block rounded-md border border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)] px-3 py-2 text-xs text-[var(--sem-warn)]">{note}</div>}

      {/* المحتوى */}
      {children}
    </div>
  );
}
