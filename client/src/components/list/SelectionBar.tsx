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
  className?: string;
};

/** شريط عائم يظهر عند تحديد صفوف — تصدير/طباعة المحدَّد. */
export function SelectionBar({
  count,
  onClear,
  onExport,
  onPrint,
  exportLabel = "تصدير المحدَّد",
  printLabel = "طباعة المحدَّد",
  className,
}: SelectionBarProps) {
  if (count <= 0) return null;
  return (
    <div
      className={cn(
        "sticky bottom-3 z-20 mx-auto flex w-fit items-center gap-2 rounded-full border bg-background/95 px-3 py-1.5 shadow-lg backdrop-blur",
        className,
      )}
    >
      <span className="text-sm font-medium">
        المحدَّد: {count.toLocaleString("ar-IQ-u-nu-latn")}
      </span>
      <div className="h-4 w-px bg-border" />
      {onExport && (
        <Button variant="outline" size="sm" onClick={onExport}>
          <Download className="size-4" />
          {exportLabel}
        </Button>
      )}
      {onPrint && (
        <Button variant="outline" size="sm" onClick={onPrint}>
          <Printer className="size-4" />
          {printLabel}
        </Button>
      )}
      <Button variant="ghost" size="icon-sm" onClick={onClear} aria-label="إلغاء التحديد">
        <X />
      </Button>
    </div>
  );
}
