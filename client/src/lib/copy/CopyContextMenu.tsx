// قائِمة سِياق على نَقرة يَمين لِخَلايا الجَدول — ثَلاث خَيارات نَسخ:
//   ١) نَسخ القيمة         (نَصّ الخَلية الحالية)
//   ٢) نَسخ الصَفّ كَ TSV  (تَرويسة + قِيَم الصَفّ مَفصولة بِتاب)
//   ٣) نَسخ العَمود كَ TSV (تَرويسة العَمود + كل قِيَمه الظاهِرة)
//
// تَحَفُّظ مَقصود: لا نَمنَع قائِمة المُتَصَفِّح الافتِراضية إذا لم يَكُن في الخَلية شَيء قابِل لِلنَسخ
// (لا value ولا row ولا column) ⇒ نَعرِض الأَطفال كَما هُم بِلا غِلاف ContextMenu، فَيَعمَل النِقرة اليُمنى المُتَصَفِّحية.
//
// يَستَخدِم formatTableAsTSV/formatRowAsTSV مِن lib/copy/formatters لِتَفادي تَكرار مَنطِق التَنسيق.
import * as React from "react";
import { Copy, Rows3, Columns3 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useClipboard } from "@/hooks/useClipboard";
import { formatRowAsTSV, formatTableAsTSV } from "@/lib/copy/formatters";

export type CopyContextMenuProps = {
  /** أَطفال الخَلية (المُحتَوى المَرئي). */
  children: React.ReactNode;
  /** قيمة الخَلية الحالية كَنَصّ — لو غابَت يُخفى خَيار «نَسخ القيمة». */
  value?: string | number | null | undefined;
  /** تَرويسات الجَدول بِالتَرتيب (لِبِناء صَفّ TSV / جَدول TSV). */
  rowHeaders?: string[];
  /** قِيَم الصَفّ الحالي (نَفس تَرتيب rowHeaders). */
  rowValues?: (string | number | null | undefined)[];
  /** تَرويسة العَمود (لِجَدول TSV عَمودي). */
  columnHeader?: string;
  /** كل قِيَم العَمود الظاهِرة بِالتَرتيب. */
  columnValues?: (string | number | null | undefined)[];
  /** تَعطيل تامّ — يَعرِض الأَطفال بِلا قائِمة سِياق (يَدَع نِقرة يَمين المُتَصَفِّح). */
  disabled?: boolean;
  /** صَفّ يُلَفّ تَريغر العَنصُر — افتِراضي «block» يُحافِظ على تَخطيط td. */
  triggerClassName?: string;
};

/** هَل قيمَتُنا «قابِلة لِلنَسخ» — لَيسَت null/undefined/فارِغة بَعد الـtrim. */
function hasValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  return String(v).trim().length > 0;
}

export function CopyContextMenu({
  children,
  value,
  rowHeaders,
  rowValues,
  columnHeader,
  columnValues,
  disabled,
  triggerClassName,
}: CopyContextMenuProps) {
  const { copy } = useClipboard();

  const canCopyValue = hasValue(value);
  const canCopyRow = !!rowHeaders && rowHeaders.length > 0 && !!rowValues && rowValues.length > 0;
  const canCopyColumn = !!columnHeader && !!columnValues && columnValues.length > 0;

  // لا شَيء نَنسَخه ⇒ اعرِض الأَطفال بِلا غِلاف، اترُك قائِمة المُتَصَفِّح تَعمَل.
  if (disabled || (!canCopyValue && !canCopyRow && !canCopyColumn)) {
    return <>{children}</>;
  }

  const handleCopyValue = () => {
    if (value === null || value === undefined) return;
    void copy(String(value));
  };

  const handleCopyRow = () => {
    if (!rowHeaders || !rowValues) return;
    void copy(formatRowAsTSV(rowHeaders, rowValues));
  };

  const handleCopyColumn = () => {
    if (!columnHeader || !columnValues) return;
    // نَستَعمِل formatTableAsTSV بِعَمود واحِد لِضَمان تَوحيد مَنطِق tsvCell.
    const rows = columnValues.map((v) => ({ [columnHeader]: v }));
    void copy(formatTableAsTSV([columnHeader], rows));
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <span className={triggerClassName ?? "block"}>{children}</span>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-[12rem]">
        {canCopyValue && (
          <ContextMenuItem onSelect={handleCopyValue} className="gap-2">
            <Copy aria-hidden className="size-4" />
            <span>نَسخ القيمة</span>
          </ContextMenuItem>
        )}
        {canCopyValue && (canCopyRow || canCopyColumn) && <ContextMenuSeparator />}
        {canCopyRow && (
          <ContextMenuItem onSelect={handleCopyRow} className="gap-2">
            <Rows3 aria-hidden className="size-4" />
            <span>نَسخ الصَفّ كَ TSV</span>
          </ContextMenuItem>
        )}
        {canCopyColumn && (
          <ContextMenuItem onSelect={handleCopyColumn} className="gap-2">
            <Columns3 aria-hidden className="size-4" />
            <span>نَسخ العَمود كَ TSV</span>
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
