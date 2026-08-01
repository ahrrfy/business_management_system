import * as React from "react";
import { Columns3, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type TableColumn = { index: number; label: string };
type TableConfig = { key: string; columns: TableColumn[]; hidden: Record<number, boolean> };

const MIN_COLUMNS_FOR_MENU = 6;

function tableKey(labels: string[]): string {
  const input = `${window.location.pathname}|${labels.join("|")}`;
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  return `table-columns:v1:${hash >>> 0}`;
}

function readHidden(key: string): Record<number, boolean> {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([index, hidden]) => /^\d+$/.test(index) && hidden === true)
        .map(([index]) => [Number(index), true]),
    );
  } catch {
    return {};
  }
}

function storeHidden(key: string, hidden: Record<number, boolean>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(hidden));
  } catch {
    // وضع الخصوصية أو مساحة تخزين ممتلئة لا يجب أن يعطّل إخفاء العمود في الجلسة الحالية.
  }
}

/**
 * قائمة أعمدة عامة للجداول اليدوية. تستخرج تسميات رؤوس الجدول وتطبق الاختيار
 * على الصفوف نفسها، لذلك لا تحتاج كل شاشة إلى إدارة حالة أعمدة منفصلة.
 */
export function TableColumnVisibility({
  containerRef,
  suppressIfInsideManagedTable = false,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  /** مكوّن Table قد يكون داخل ScrollTableShell؛ عندها يكفي الزر الخارجي الواحد. */
  suppressIfInsideManagedTable?: boolean;
}) {
  const [config, setConfig] = React.useState<TableConfig | null>(null);

  const inspectTable = React.useCallback(() => {
    if (suppressIfInsideManagedTable && containerRef.current?.parentElement?.closest("[data-column-visibility-host]")) {
      setConfig(null);
      return;
    }
    const table = containerRef.current?.querySelector("table");
    const headerRow = table?.tHead?.rows.item((table.tHead?.rows.length ?? 1) - 1);
    if (!table || !headerRow) return;

    const columns = Array.from(headerRow.cells).map((cell, index) => ({
      index,
      label: cell.textContent?.replace(/\s+/g, " ").trim() || `العمود ${index + 1}`,
    }));
    if (columns.length < MIN_COLUMNS_FOR_MENU) {
      setConfig(null);
      return;
    }

    const key = tableKey(columns.map((column) => column.label));
    setConfig((previous) => {
      if (
        previous?.key === key &&
        previous.columns.length === columns.length &&
        previous.columns.every((column, index) => column.label === columns[index].label)
      ) {
        return previous;
      }
      return { key, columns, hidden: readHidden(key) };
    });
  }, [containerRef, suppressIfInsideManagedTable]);

  React.useLayoutEffect(() => {
    inspectTable();
    const container = containerRef.current;
    if (!container) return;
    const observer = new MutationObserver(inspectTable);
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [containerRef, inspectTable]);

  React.useEffect(() => {
    const table = containerRef.current?.querySelector("table");
    if (!table || !config) return;

    const apply = () => {
      for (const row of Array.from(table.rows)) {
        for (const cell of Array.from(row.cells)) {
          cell.toggleAttribute("data-column-hidden", config.hidden[cell.cellIndex] === true);
        }
      }
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(table, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [config, containerRef]);

  if (!config) return null;

  const visibleCount = config.columns.filter((column) => !config.hidden[column.index]).length;
  const setVisible = (index: number, visible: boolean) => {
    if (!visible && visibleCount === 1) return;
    setConfig((previous) => {
      if (!previous) return previous;
      const hidden = { ...previous.hidden };
      if (visible) delete hidden[index];
      else hidden[index] = true;
      storeHidden(previous.key, hidden);
      return { ...previous, hidden };
    });
  };

  const reset = () => {
    setConfig((previous) => {
      if (!previous) return previous;
      storeHidden(previous.key, {});
      return { ...previous, hidden: {} };
    });
  };

  return (
    <div className="table-column-visibility print:hidden flex justify-end">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="gap-2">
            <Columns3 aria-hidden className="size-4" />
            الأعمدة
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 min-w-52 overflow-y-auto text-right">
          <DropdownMenuLabel>إظهار تفاصيل الجدول</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {config.columns.map((column) => {
            const visible = !config.hidden[column.index];
            return (
              <DropdownMenuCheckboxItem
                key={column.index}
                checked={visible}
                disabled={visible && visibleCount === 1}
                onCheckedChange={(value) => setVisible(column.index, Boolean(value))}
                onSelect={(event) => event.preventDefault()}
              >
                {column.label}
              </DropdownMenuCheckboxItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={reset}>
            <RotateCcw aria-hidden className="size-4" />
            إعادة ضبط الأعمدة
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
