// ScrollTableShell — حاوية جدول بارتفاع مقيّد بحجم الشاشة + ترويسة لاصقة + تمرير داخلي.
//
// لماذا: كانت صفحات القوائم تعرض الجدول كاملاً فتطول الصفحة ويُمرَّر المستند كلّه (يغيب
// رأس الجدول عند النزول، ويصعب الوصول لشريط الأدوات/الترقيم). هذه الحاوية تحبس الجدول في
// صندوق ارتفاعه نسبةٌ من الشاشة (الافتراضي ≈ ما بعد الترويسة والشريط)، فيُمرَّر **داخلها**
// والترويسة (thead th) تلتصق أعلاها دائماً. RTL آمنة (تمرير منطقي).
//
// الاستعمال: لُفّ أي <table> بها بدل <div className="overflow-x-auto rounded-md border">:
//   <ScrollTableShell><table>…</table></ScrollTableShell>
// تُطبَّق الترويسة اللاصقة على أي thead th بالوراثة (لا حاجة لتعديل thead كل صفحة).
import * as React from "react";
import { cn } from "@/lib/utils";
import { TableColumnVisibility } from "@/components/table/TableColumnVisibility";

export function ScrollTableShell({
  children,
  className,
  /** صنف الارتفاع الأقصى — الافتراضي يترك مكاناً للترويسة وشريط الأدوات والترقيم. */
  maxHeightClass = "max-h-[calc(100dvh-15rem)]",
  /** حدّ + زوايا مُدوَّرة. اجعلها false حين تكون الحاوية داخل بطاقة (Card) لها حدّها أصلاً. */
  bordered = true,
  /** تعطّلها DataTable لأنه يملك قائمة أعمدة مرتبطة بحالة TanStack الخاصة به. */
  showColumnVisibility = true,
}: {
  children: React.ReactNode;
  className?: string;
  maxHeightClass?: string;
  bordered?: boolean;
  showColumnVisibility?: boolean;
}) {
  const tableRef = React.useRef<HTMLDivElement>(null);
  return (
    <div className={cn("space-y-2", className)}>
      {showColumnVisibility && <TableColumnVisibility containerRef={tableRef} />}
      <div
        ref={tableRef}
        data-column-visibility-host
        className={cn(
          "print-table-shell relative overflow-auto bg-card [scrollbar-gutter:stable]",
          bordered && "rounded-md border",
          maxHeightClass,
          // ترويسة لاصقة: أي thead th داخل الحاوية يلتصق أعلى التمرير بخلفية معتمة فوق الصفوف.
          "[&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-10 [&_thead_th]:bg-muted [&_thead_th]:shadow-[0_1px_0_hsl(var(--border))]",
          "[&_tbody_tr:nth-child(even):not([data-selected=true])]:bg-muted/20 [&_tbody_tr]:transition-colors [&_tbody_tr:not([data-selected=true]):hover]:bg-accent/35",
          "data-[table-density=compact]:[&_th]:!py-1.5 data-[table-density=compact]:[&_td]:!py-1.5 data-[table-density=compact]:[&_tbody_tr]:text-xs",
        )}
      >
        {children}
      </div>
    </div>
  );
}
