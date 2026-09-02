import type { Column, ColumnDef } from "@tanstack/react-table";

export type TableColumnKind = "text" | "number" | "money" | "date" | "datetime" | "code" | "phone" | "status" | "actor" | "actions";
export type TableColumnAlign = "start" | "center" | "end";
export type TableColumnWidth = "id" | "date" | "money" | "status" | "actor" | "actions" | "wide";

declare module "@tanstack/react-table" {
  interface ColumnMeta<TData, TValue> {
    kind?: TableColumnKind;
    align?: TableColumnAlign;
    width?: TableColumnWidth;
    wrap?: boolean;
  }
}

const KIND_ALIGN: Partial<Record<TableColumnKind, TableColumnAlign>> = {
  number: "end",
  money: "end",
  date: "center",
  datetime: "center",
  status: "center",
  actions: "center",
};

const KIND_WIDTH: Partial<Record<TableColumnKind, TableColumnWidth>> = {
  money: "money",
  date: "date",
  datetime: "date",
  status: "status",
  actor: "actor",
  actions: "actions",
};

const ALIGN_CLASS: Record<TableColumnAlign, string> = {
  start: "text-start",
  center: "text-center",
  end: "text-end",
};

const WIDTH_CLASS: Record<TableColumnWidth, string> = {
  id: "w-20 min-w-20",
  date: "w-36 min-w-36",
  money: "w-32 min-w-32",
  status: "w-32 min-w-32",
  actor: "w-40 min-w-40",
  actions: "w-28 min-w-28",
  wide: "min-w-64",
};

export type ResolvedColumnPresentation = {
  kind: TableColumnKind;
  align: TableColumnAlign;
  width?: TableColumnWidth;
  wrap: boolean;
};

/** يستنتج العرض من meta؛ الافتراضي نص RTL عند البداية، بلا تخمين من اسم الحقل. */
export function resolveColumnPresentation<T>(column: Column<T, unknown>): ResolvedColumnPresentation {
  const meta = column.columnDef.meta;
  const kind = meta?.kind ?? "text";
  return {
    kind,
    align: meta?.align ?? KIND_ALIGN[kind] ?? "start",
    width: meta?.width ?? KIND_WIDTH[kind],
    wrap: meta?.wrap ?? false,
  };
}

export function columnPresentationClass<T>(column: Column<T, unknown>): string {
  const presentation = resolveColumnPresentation(column);
  return [
    ALIGN_CLASS[presentation.align],
    presentation.width ? WIDTH_CLASS[presentation.width] : "",
    presentation.wrap ? "whitespace-normal [overflow-wrap:anywhere]" : "whitespace-nowrap",
    presentation.kind === "number" || presentation.kind === "money" ? "tabular-nums" : "",
    presentation.kind === "code" ? "font-mono" : "",
  ].filter(Boolean).join(" ");
}

export function columnUsesLtrIsolate<T>(column: Column<T, unknown>): boolean {
  const { kind } = resolveColumnPresentation(column);
  return kind === "number" || kind === "money" || kind === "date" || kind === "datetime" || kind === "code" || kind === "phone";
}

export function withColumnPresentation<T>(
  column: ColumnDef<T, unknown>,
  meta: NonNullable<ColumnDef<T, unknown>["meta"]>,
): ColumnDef<T, unknown> {
  return { ...column, meta: { ...column.meta, ...meta } };
}

/**
 * ⭐ فرزُ الأعمدة المُنسَّقة — يُشتقّ من `meta.kind` لا يُكتَب في كل شاشة.
 *
 * المشكلة (مراجعةٌ عدائية، ٢/٩/٢٦): العمود يمرّر للنسخ قيمةً **معروضة** — «1,234 د.ع»
 * أو «2024-01-08» — و`accessorFn` هو نفسه مصدرُ الفرز. فالفرزُ يصير **نصّياً**:
 * «1,234» يسبق «999»، و«٣ أيام» تسبق «١٠ أيام». المدير يفرز عمودَ المبالغ ليرى الأكبر
 * فيرى ترتيباً مقلوباً **بلا أيّ إشارة على الخطأ** — وهو أسوأ من غياب الفرز.
 * أُحصي ١١٧ عموداً في ٣٧ شاشة تحمل هذا العطب.
 *
 * الحلّ في المكوّن لا في الشاشات: `kind` يعرف طبيعة العمود أصلاً، فمنه نشتقّ المقارنة.
 * وتبقى للشاشة الكلمةُ الأخيرة: `sortingFn` صريحٌ على العمود يتقدّم على هذا الاشتقاق.
 */

/** يستخرج عدداً من نصٍّ معروض (فواصل آلاف · رموز عملة · علامة سالب · نسبة). */
function numericFromDisplay(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  /*
   * ⚠️ **تطبيعُ إشارة السالب أوّلاً** (مراجعة Codex على PR #946): شاشاتٌ تعرض السالب
   * بالمحرف الطباعيّ «−» (U+2212) لا بالشرطة اللاتينية — مثل `CommissionRuns` و
   * `StocktakeReport`. والتنقيةُ أدناه تُسقط ما ليس رقماً ولا نقطةً ولا شرطةً لاتينية،
   * فكان «−1,000» يصير «1000» ⇒ **يُفرَز موجباً** فيقع في الجهة الخاطئة تماماً من
   * الترتيب، صعوداً وهبوطاً. تحويلُه قبل التنقية يُبقي الإشارة.
   */
  const normalized = value.replace(/−/g, "-");
  // نُبقي الأرقام والفاصلة العشرية والسالب فقط — الفواصل والرموز والوحدات تُطرَح.
  const cleaned = normalized.replace(/[^\d.\-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** مقارنةٌ رقمية تُبقي الفارغَ في الذيل دائماً (لا يتصدّر «—» قائمةَ الأكبر). */
export function compareNumericDisplay(a: unknown, b: unknown): number {
  const x = numericFromDisplay(a);
  const y = numericFromDisplay(b);
  if (x === null && y === null) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return x - y;
}

/**
 * مقارنةُ تواريخ.
 *
 * ⚠️ **لا يُعتمد `Date.parse` على النصّ المعروض** (مراجعة Codex على PR #946): تنسيقُ
 * العرض في المشروع `DD/MM/YYYY` (انظر `fmtDate` في `client/src/lib/date.ts`)، و
 * `Date.parse` يقرأه **أمريكياً**: «02/09/2026» تصير ٩ فبراير، و«25/09/2026» تصير
 * `Invalid Date` فتسقط إلى مقارنةٍ نصّية. فالنتيجة ترتيبٌ غيرُ زمنيّ في كلّ عمود تاريخٍ
 * يُغذّى بـ`fmtDate`/`fmtDateTime` — وهو نقضٌ لغرض هذا الملفّ نفسه.
 * لذلك يُحلَّل التنسيقُ المعروض **صراحةً** أوّلاً، ثمّ يمرّ الباقي على `Date.parse`
 * (وهو يفهم ISO بدقّة)، ويبقى تحتهما السقوطُ إلى المقارنة النصّية.
 */
export function compareDateDisplay(a: unknown, b: unknown): number {
  const parse = (v: unknown): number | null => {
    if (v instanceof Date) return v.getTime();
    if (typeof v === "number") return v;
    if (typeof v !== "string" || v.trim() === "") return null;
    const text = v.trim();
    // تنسيقُ العرض: DD/MM/YYYY ويتبعه اختياراً «، HH:mm» (فاصلة عربية أو لاتينية).
    const shown = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s*[،,]\s*(\d{1,2}):(\d{2}))?/);
    if (shown) {
      const [, dd, mm, yyyy, hh, mi] = shown;
      const ms = new Date(
        Number(yyyy),
        Number(mm) - 1,
        Number(dd),
        hh ? Number(hh) : 0,
        mi ? Number(mi) : 0,
      ).getTime();
      return Number.isNaN(ms) ? null : ms;
    }
    const t = Date.parse(text);
    return Number.isNaN(t) ? null : t;
  };
  const x = parse(a);
  const y = parse(b);
  if (x === null && y === null) return String(a ?? "").localeCompare(String(b ?? ""), "ar");
  if (x === null) return 1;
  if (y === null) return -1;
  return x - y;
}

/** الأنواع التي تلزمها مقارنةٌ مشتقّة بدل المقارنة النصّية الافتراضية. */
export function sortingFnForKind(kind: TableColumnKind): "auto" | ((rowA: { getValue: (id: string) => unknown }, rowB: { getValue: (id: string) => unknown }, id: string) => number) {
  if (kind === "money" || kind === "number") {
    return (rowA, rowB, id) => compareNumericDisplay(rowA.getValue(id), rowB.getValue(id));
  }
  if (kind === "date" || kind === "datetime") {
    return (rowA, rowB, id) => compareDateDisplay(rowA.getValue(id), rowB.getValue(id));
  }
  return "auto";
}
