/**
 * واجهة الفلاتر القانونية لمساحات العمل: شريط أفقي بارتفاع 40px للفلاتر السريعة
 * وملخص الفلاتر المفعّلة، ولوحة جانبية للفلاتر الثانوية. لا تفتح اللوحة تلقائياً كي
 * يبقى جدول البيانات ثابت الموضع؛ الملخص الظاهر يمنع وجود تصفية خفية.
 *
 * ⛔ توكنز فقط، وخصائص اتّجاهٍ منطقية (RTL)، وأيقونات `lucide-react`.
 */
import { useState } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { WorkspaceBar } from "@/components/workspace/OperationalWorkspace";

export interface FilterChip {
  /** مفتاحٌ فريد — يُستعمل للإزالة. */
  key: string;
  /** اسم الحقل («الحالة») — يُعرض خافتاً قبل القيمة. */
  field: string;
  /** القيمة المقروءة («مدفوعة»). */
  value: string;
  onClear: () => void;
}

export default function FilterPanel({
  chips,
  onResetAll,
  children,
  /** يُعرض بجوار العنوان — مثلاً منتقي الفترة السريع (الأكثر استعمالاً يبقى ظاهراً). */
  quickSlot,
}: {
  chips: FilterChip[];
  onResetAll: () => void;
  children: ReactNode;
  quickSlot?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const hasChips = chips.length > 0;
  const summary = chips.map((chip) => `${chip.field}: ${chip.value}`).join(" · ");

  return (
    <WorkspaceBar variant="filters" label="فلاتر البيانات" className="overflow-hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="h-8 shrink-0 gap-1.5">
            <SlidersHorizontal aria-hidden className="size-3.5" />
            الفلاتر
            {hasChips && <span className="rounded bg-primary px-1.5 text-2xs font-bold text-primary-foreground">{chips.length.toLocaleString("ar-IQ-u-nu-latn")}</span>}
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-[min(92vw,34rem)] sm:max-w-lg">
          <SheetHeader className="border-b">
            <SheetTitle>الفلاتر المتقدمة</SheetTitle>
            <SheetDescription>اضبط الفلاتر الثانوية ثم أغلق اللوحة للعودة إلى مساحة البيانات.</SheetDescription>
          </SheetHeader>
          {hasChips && (
            <div className="flex flex-wrap gap-1.5 border-b px-4 pb-3">
              {chips.map((chip) => (
                <button
                  key={chip.key}
                  type="button"
                  onClick={chip.onClear}
                  className="inline-flex items-center gap-1 rounded-md border bg-muted/50 px-2 py-1 text-2xs font-semibold hover:bg-muted"
                  aria-label={`إزالة فلتر ${chip.field}`}
                >
                  <span className="text-muted-foreground">{chip.field}:</span>
                  {chip.value}
                  <X aria-hidden className="size-3" />
                </button>
              ))}
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
          <SheetFooter className="flex-row border-t">
            {hasChips && (
              <Button type="button" variant="ghost" onClick={onResetAll}>
                مسح الكل
              </Button>
            )}
            <SheetClose asChild>
              <Button type="button" className="ms-auto">
                عرض النتائج
              </Button>
            </SheetClose>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <div className="min-w-0 flex-1 overflow-x-auto [&>div]:!flex-nowrap">{quickSlot}</div>

      {hasChips && (
        <span className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground lg:block" title={summary}>
          {summary}
        </span>
      )}
      {hasChips && (
        <Button type="button" variant="ghost" size="sm" onClick={onResetAll} className="h-8 shrink-0 text-muted-foreground">
          <X aria-hidden className="size-3.5" />
          مسح
        </Button>
      )}
    </WorkspaceBar>
  );
}
