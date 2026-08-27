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
import { FileSpreadsheet, MoreHorizontal, Printer } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { WorkspaceBar, WorkspaceStatusBar } from "@/components/workspace/OperationalWorkspace";

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
    <div className="space-y-2.5" data-report-workspace>
      {/* الرأس — عبر PageHeader المشترك (رابط رجوع + عنوان + وصف)، وأزرار التصدير/الطباعة في منطقة الإجراءات. */}
      <PageHeader
        title={title}
        description={description}
        backHref={backHref ?? undefined}
        backLabel="مركز التقارير"
        variant="workspace"
        actions={
          <>
            {actions}
            {(onExportCsv || onExport || onPrint) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8">
                    <MoreHorizontal aria-hidden className="size-4" />
                    إجراءات التقرير
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-52">
                  <DropdownMenuLabel>التصدير والطباعة</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {onExportCsv && (
                    <DropdownMenuItem disabled={exportDisabled} onSelect={() => onExportCsv()}>
                      <FileSpreadsheet aria-hidden className="size-4" />
                      تصدير CSV
                    </DropdownMenuItem>
                  )}
                  {onExport && (
                    <DropdownMenuItem disabled={exportDisabled} onSelect={() => onExport()}>
                      <FileSpreadsheet aria-hidden className="size-4" />
                      تصدير Excel
                    </DropdownMenuItem>
                  )}
                  {onPrint && (
                    <DropdownMenuItem disabled={printDisabled} onSelect={() => onPrint()}>
                      <Printer aria-hidden className="size-4" />
                      طباعة / PDF
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
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

      {/* تنويه */}
      {note && <div className="rounded-md border border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)] px-3 py-2 text-xs text-[var(--sem-warn)]">{note}</div>}

      {/* المحتوى */}
      {children}

      {/* مؤشرات التقرير شريط حالة سفلي: تبقى البيانات أولاً ولا تُزاح من أعلى الشاشة. */}
      {kpis && kpis.length > 0 && (
        <WorkspaceStatusBar label="مؤشرات التقرير" className="gap-0 overflow-x-auto p-0">
          {kpis.map((k, i) => (
            <div key={i} className="min-w-36 flex-1 border-e border-border/70 px-3 py-0.5 text-center last:border-e-0" title={typeof k.hint === "string" ? k.hint : undefined}>
              <p className="truncate text-2xs text-muted-foreground">{k.label}</p>
              <p className={cn("truncate text-sm font-bold tabular-nums", TONE_TEXT_CLASS[k.tone ?? "default"])} dir="ltr">
                {k.value}
              </p>
              {(k.hintNode ?? k.hint) && <span className="sr-only">{k.hintNode ?? k.hint}</span>}
            </div>
          ))}
        </WorkspaceStatusBar>
      )}
    </div>
  );
}
