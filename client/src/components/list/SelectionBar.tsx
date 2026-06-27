// التحديد المتعدّد + شريط الإجراءات الجماعية — تصدير/طباعة المحدَّد فقط (بلا حذف جماعي، قرار المالك).
//   const sel = useRowSelection<number>();
//   <input type="checkbox" checked={sel.isSelected(id)} onChange={() => sel.toggle(id)} />
//   <SelectionBar count={sel.count} onClear={sel.clear} onExport={…} onPrint={…} />
import * as React from "react";
import { Download, Printer, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function useRowSelection<K extends string | number>() {
  const [selected, setSelected] = React.useState<Set<K>>(() => new Set<K>());

  const toggle = React.useCallback((id: K) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setMany = React.useCallback((ids: K[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const clear = React.useCallback(() => setSelected(new Set<K>()), []);
  const isSelected = React.useCallback((id: K) => selected.has(id), [selected]);

  return { selected, count: selected.size, toggle, setMany, clear, isSelected };
}

export type SelectionBarProps = {
  count: number;
  onClear: () => void;
  onExport?: () => void;
  onPrint?: () => void;
  exportLabel?: string;
  printLabel?: string;
  /** إجراءات جماعية إضافية (أزرار) تُعرض قبل التصدير/الطباعة — مثل «نقل إلى فئة». */
  actions?: React.ReactNode;
  className?: string;
};

/**
 * شريط عائم يظهر عند تحديد صفوف — تصدير/طباعة المحدَّد + إجراءات إضافية اختيارية.
 *
 * positioning: `fixed bottom-4` بدل `sticky bottom-3` — يَضمن الظهور بصرياً في كل الحالات
 * (محتوى قصير، scroll containers متشعّبة، صفحات بـpagination ذيلي). كان قبلها يَضيع
 * كقرص شبه شفّاف عند أسفل المحتوى عند بعض الحالات (٢٧/٦).
 *
 * ألوان مُتباينة + ظلّ قوي + شارة عدّاد بارزة + slide-in animation ⇒ لا يَفوت العين.
 */
export function SelectionBar({
  count,
  onClear,
  onExport,
  onPrint,
  exportLabel = "تصدير المحدَّد",
  printLabel = "طباعة المحدَّد",
  actions,
  className,
}: SelectionBarProps) {
  if (count <= 0) return null;
  return (
    <div
      role="region"
      aria-label="شريط إجراءات التحديد"
      className={cn(
        // fixed: ثابت على viewport bottom ⇒ يَظهر دائماً مهما كان طول المحتوى/الـscroll.
        "fixed bottom-4 z-50",
        // RTL-aware centering: عمل left-1/2 -translate-x-1/2 يَعمل في الاتجاهين.
        "left-1/2 -translate-x-1/2",
        // تَخطيط داخلي: gap + padding مُريح + حدود حادّة
        "flex items-center gap-2 rounded-2xl px-3 py-2",
        // ألوان متباينة بقوّة: خلفية بطاقة + إطار primary + ظلّ ضخم.
        "border-2 border-primary bg-card shadow-2xl",
        // backdrop-blur للحفاظ على قراءة الجدول خلفه عند الشفافية الجزئية.
        "backdrop-blur supports-[backdrop-filter]:bg-card/95",
        // حركة دخول لطيفة ⇒ تَشدّ الانتباه عند ظهور الشريط.
        "animate-in fade-in slide-in-from-bottom-4 duration-200",
        className,
      )}
    >
      {/* شارة العدّاد البارزة — لون primary مُعكوس ⇒ يَلفت النظر فوراً. */}
      <div className="flex items-center gap-2 rounded-xl bg-primary px-3 py-1 text-primary-foreground">
        <span className="text-lg font-extrabold tabular-nums" dir="ltr">
          {count.toLocaleString("ar-IQ-u-nu-latn")}
        </span>
        <span className="text-xs font-bold">محدَّد</span>
      </div>
      <div className="h-6 w-px bg-border" />
      {actions}
      {onExport && (
        <Button variant="outline" size="sm" onClick={onExport} className="gap-1.5">
          <Download className="size-4" />
          {exportLabel}
        </Button>
      )}
      {onPrint && (
        <Button variant="outline" size="sm" onClick={onPrint} className="gap-1.5">
          <Printer className="size-4" />
          {printLabel}
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onClear}
        aria-label="إلغاء التحديد"
        title="إلغاء التحديد"
        className="text-muted-foreground hover:text-foreground"
      >
        <X />
      </Button>
    </div>
  );
}
