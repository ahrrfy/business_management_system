import type { Column, ColumnDef, SortingState } from "@tanstack/react-table";

export type TableColumnKind = "text" | "number" | "money" | "date" | "datetime" | "code" | "phone" | "status" | "actor" | "actions";
export type TableColumnAlign = "start" | "center" | "end";
export type TableColumnWidth = "id" | "date" | "money" | "status" | "actor" | "actions" | "wide" | "stacked";

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
  stacked: "w-52 min-w-44",
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

/** يستخرج عدداً من نصٍّ معروض (فواصل آلاف · رموز عملة · علامة سالب · نسبة · أقواس محاسبية). */
export function numericFromDisplay(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "—" || trimmed === "-" || trimmed === "–") return null;

  // تطبيع الأرقام الهندية/العربية (١٢٣ -> 123)
  const arabicIndicDigits = "٠١٢٣٤٥٦٧٨٩";
  let normalized = trimmed.replace(/[٠-٩]/g, (d) => String(arabicIndicDigits.indexOf(d)));

  // تطبيع فواصل الآلاف والفواصل العشرية العربية
  // U+066B (فاصلة عشرية عربية ٫) -> .
  // U+066C (فاصلة آلاف عربية ٬) -> ,
  // U+060C (فاصلة عربية ،) -> ,
  normalized = normalized
    .replace(/\u066B/g, ".")
    .replace(/[\u066C\u060C]/g, ",");

  // تطبيع إشارات السالب المختلفة (المحرف الطباعي U+2212، الوصلة U+2013، الشرطة U+2014)
  normalized = normalized.replace(/[−–—]/g, "-");

  // نلتقط أوّل رمزٍ عدديّ بما في ذلك الأعداد التي تبدأ بفاصلة عشرية مثل .5 أو ٫٥
  const match = normalized.match(/(?:\d[\d,]*(?:\.\d+)?|\.\d+)/);
  if (!match || match.index === undefined) return null;

  const prefix = normalized.slice(0, match.index);
  const suffix = normalized.slice(match.index + match[0].length);

  // 1. الأقواس المحاسبية للأرصدة السالبة مثل (1,500) أو (1,500 د.ع) أو ($1,500) أو الرصيد: (1,500)
  // ⚠️ يجب أن تحيط الأقواس بالمبلغ الأساسي نفسه، ولا تطابق الملاحظات اللاحقة مثل "1,000.50 (مدفوع: 200.25)"
  const isAccountingParen = (() => {
    const lastOpenParen = prefix.lastIndexOf("(");
    if (lastOpenParen === -1) return false;
    const lastCloseParenInPrefix = prefix.lastIndexOf(")");
    if (lastCloseParenInPrefix > lastOpenParen) return false;

    const firstCloseParen = suffix.indexOf(")");
    if (firstCloseParen === -1) return false;
    const firstOpenParenInSuffix = suffix.indexOf("(");
    if (firstOpenParenInSuffix !== -1 && firstOpenParenInSuffix < firstCloseParen) return false;

    const betweenOpenAndNum = prefix.slice(lastOpenParen + 1).trim();
    const betweenNumAndClose = suffix.slice(0, firstCloseParen).trim();

    // داخل القوسين: لا يُسمح بأرقام أخرى ولا بنقطتين رأسيتين
    if (/\d/.test(betweenNumAndClose)) return false;
    if (/[:=]/.test(betweenOpenAndNum) || /[:=]/.test(betweenNumAndClose)) return false;

    // ما يسبق العدد داخل القوسين: إما فارغ أو رموز/كلمات عملة أو إشارة
    if (
      betweenOpenAndNum !== "" &&
      !/^[\s$€£¥+-]*$/.test(betweenOpenAndNum) &&
      !/^(?:د\.ع|ر\.س|ج\.م|د\.ك|د\.إ|USD|IQD|SAR|EUR|GBP)$/i.test(betweenOpenAndNum)
    ) {
      return false;
    }

    // ما بين العدد والقوس المغلق: لا يُسمح بنصوص طويلة أو علامات ترقيم شاذة
    if (betweenNumAndClose.length > 15 || /[;!?/\\]/.test(betweenNumAndClose)) return false;

    // الجزء الذي يسبق القوس المفتوح: إما فارغ أو رمز/كلمة عملة أو نص ينتهي بنقطتين مثل "الرصيد:"
    const beforeOpenParen = prefix.slice(0, lastOpenParen).trim();
    if (
      beforeOpenParen !== "" &&
      !/[:=]\s*$/.test(beforeOpenParen) &&
      !/^[\s$€£¥+-]*$/.test(beforeOpenParen) &&
      !/^(?:د\.ع|ر\.س|ج\.م|د\.ك|د\.إ|USD|IQD|SAR|EUR|GBP)$/i.test(beforeOpenParen)
    ) {
      return false;
    }

    return true;
  })();

  // 2. إشارة سالب سابقة (prefix minus) مباشرة قبل العدد الأول دون أن تُسبق بحرف أو رقم
  // ⚠️ لا تُعتبر سالباً إن سُبقت بحرف لاتيني/عربي (مثل معرّف INV-123 أو INV - 123) أو رقم (مثل مدى 100 - 200)
  const hasPrefixMinus = (() => {
    const lastMinusIndex = prefix.lastIndexOf("-");
    if (lastMinusIndex === -1) return false;
    const beforeMinus = prefix.slice(0, lastMinusIndex).trim();
    if (beforeMinus === "" || /^[\s(]*[^\w\u0600-\u06FF\d\s]*$/.test(beforeMinus)) {
      return true;
    }
    if (/[:=]\s*$/.test(beforeMinus)) {
      return true;
    }
    return false;
  })();

  // 3. إشارة سالب لاحقة (suffix minus) في نصوص RTL عند نهاية المبلغ أو النص (مثل 1,500- أو 1,500 د.ع -)
  // ⚠️ لا تُعتبر سالباً إن تلاها رقم (مدى: 100 - 200) أو نص وصفي (مثل: 1,500 د.ع - رصيد افتتاحي)
  const hasSuffixMinus = /^(?:[^\d\w\s-]*|\s+[\u0600-\u06FFa-zA-Z]+)*\s*-\s*$/.test(suffix);

  const isNegative = isAccountingParen || hasPrefixMinus || hasSuffixMinus;

  const cleaned = match[0].replace(/\s+/g, "").replace(/,/g, "");
  if (cleaned === "" || cleaned === ".") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;

  const result = isNegative ? -Math.abs(n) : Math.abs(n);
  return result === 0 ? 0 : result;
}

/** مقارنةٌ رقمية رياضية حقيقية تُبقي الفارغَ في الذيل دائماً في كلا الاتجاهين الصاعد والهابط. */
export function compareNumericDisplay(a: unknown, b: unknown, isDesc = false): number {
  const x = numericFromDisplay(a);
  const y = numericFromDisplay(b);
  if (x === null && y === null) return 0;
  if (x === null) return isDesc ? -1 : 1;
  if (y === null) return isDesc ? 1 : -1;
  return x - y;
}

/** يستخرج طابعاً زمنياً (timestamp) من تاريخ معروض أو قيمة تاريخ. */
export function parseDateDisplay(v: unknown): number | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || v.trim() === "") return null;

  const text = v.trim();
  if (text === "—" || text === "-" || text === "–") return null;

  // تطبيع الأرقام الهندية/العربية
  const arabicIndicDigits = "٠١٢٣٤٥٦٧٨٩";
  const normalized = text.replace(/[٠-٩]/g, (d) => String(arabicIndicDigits.indexOf(d)));

  // إذا كان النص يحمل علامة المنطقة الزمنية الصريحة بعد وقت (مثل T...Z أو HH:mm+03:00) فهو طابع زمني دقيق يُحلّل مباشرة
  // ⚠️ يجب اشتراط وجود وحدة وقت قبل الإشارة كي لا تُفسَّر السنة في مثل "02-09-2026" كـ offset سالب
  if (/(?:T|\d{1,2}:\d{2})\s*(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)) {
    const t = Date.parse(normalized);
    if (!Number.isNaN(t)) return t;
  }

  // 1. تنسيق ISO: YYYY-MM-DD أو YYYY/MM/DD أو YYYY.MM.DD (تفسير محلي يمنع انزياح اليوم مع التوقيت العربي +3)
  const isoMatch = normalized.match(
    /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})(?:[\s,،T]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(ص|صباحاً|م|مساءً|am|pm|a\.m\.|p\.m\.))?)?/i,
  );
  if (isoMatch) {
    const [, yyyy, mm, dd, rawHh, mi, ss, ampm] = isoMatch;
    let hh = rawHh ? Number(rawHh) : 0;
    if (ampm) {
      const isPm = /^(م|مساءً|pm|p\.m\.)$/i.test(ampm.trim());
      const isAm = /^(ص|صباحاً|am|a\.m\.)$/i.test(ampm.trim());
      if (isPm && hh < 12) {
        hh += 12;
      } else if (isAm && hh === 12) {
        hh = 0;
      }
    }
    const ms = new Date(
      Number(yyyy),
      Number(mm) - 1,
      Number(dd),
      hh,
      mi ? Number(mi) : 0,
      ss ? Number(ss) : 0,
    ).getTime();
    return Number.isNaN(ms) ? null : ms;
  }

  // 2. تنسيقُ العرض المحلي: DD/MM/YYYY أو DD-MM-YYYY أو DD.MM.YYYY ويتبعه اختياراً الوقت (HH:mm أو HH:mm:ss) وعلامة ص/م/AM/PM
  const shown = normalized.match(
    /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[\s,،]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(ص|صباحاً|م|مساءً|am|pm|a\.m\.|p\.m\.))?)?/i,
  );
  if (shown) {
    const [, dd, mm, yyyy, rawHh, mi, ss, ampm] = shown;
    let hh = rawHh ? Number(rawHh) : 0;
    if (ampm) {
      const isPm = /^(م|مساءً|pm|p\.m\.)$/i.test(ampm.trim());
      const isAm = /^(ص|صباحاً|am|a\.m\.)$/i.test(ampm.trim());
      if (isPm && hh < 12) {
        hh += 12;
      } else if (isAm && hh === 12) {
        hh = 0;
      }
    }
    const ms = new Date(
      Number(yyyy),
      Number(mm) - 1,
      Number(dd),
      hh,
      mi ? Number(mi) : 0,
      ss ? Number(ss) : 0,
    ).getTime();
    return Number.isNaN(ms) ? null : ms;
  }

  const t = Date.parse(normalized);
  return Number.isNaN(t) ? null : t;
}

/** مقارنةُ تواريخ زمنية حقيقية تُبقي الفارغَ في الذيل دائماً في كلا الاتجاهين الصاعد والهابط. */
export function compareDateDisplay(a: unknown, b: unknown, isDesc = false): number {
  const x = parseDateDisplay(a);
  const y = parseDateDisplay(b);
  const isPlaceholder = (v: unknown): boolean => {
    if (v === null || v === undefined) return true;
    if (typeof v === "string") {
      const t = v.trim();
      return t === "" || t === "—" || t === "-" || t === "–";
    }
    return false;
  };
  if (x === null && y === null) {
    if (isPlaceholder(a) && isPlaceholder(b)) return 0;
    return String(a ?? "").localeCompare(String(b ?? ""), "ar");
  }
  if (x === null) return isDesc ? -1 : 1;
  if (y === null) return isDesc ? 1 : -1;
  return x - y;
}

/** مقارنةٌ نصية عربية متوافقة مع RTL وتُبقي القيم الفارغة في الذيل دائماً وتدعم الفرز الأبجدي الرقمي الطبيعي. */
export function compareTextDisplay(a: unknown, b: unknown, isDesc = false): number {
  const isValueEmpty = (v: unknown): boolean => {
    if (v === null || v === undefined) return true;
    if (typeof v === "string") {
      const t = v.trim();
      return t === "" || t === "—" || t === "-" || t === "–";
    }
    return false;
  };
  const xEmpty = isValueEmpty(a);
  const yEmpty = isValueEmpty(b);
  if (xEmpty && yEmpty) return 0;
  if (xEmpty) return isDesc ? -1 : 1;
  if (yEmpty) return isDesc ? 1 : -1;
  return String(a ?? "").trim().localeCompare(String(b ?? "").trim(), "ar", { numeric: true });
}

/** الأنواع التي تلزمها مقارنةٌ مشتقّة بدل المقارنة النصّية الافتراضية. */
export function sortingFnForKind(
  kind: TableColumnKind,
  getSorting?: () => SortingState | undefined,
): "auto" | ((rowA: { getValue: (id: string) => unknown }, rowB: { getValue: (id: string) => unknown }, id: string) => number) {
  if (kind === "money" || kind === "number") {
    return (rowA, rowB, id) => {
      const isDesc = getSorting?.()?.find((s) => s.id === id)?.desc ?? false;
      return compareNumericDisplay(rowA.getValue(id), rowB.getValue(id), isDesc);
    };
  }
  if (kind === "date" || kind === "datetime") {
    return (rowA, rowB, id) => {
      const isDesc = getSorting?.()?.find((s) => s.id === id)?.desc ?? false;
      return compareDateDisplay(rowA.getValue(id), rowB.getValue(id), isDesc);
    };
  }
  if (kind === "text" || kind === "code" || kind === "status" || kind === "phone") {
    return (rowA, rowB, id) => {
      const isDesc = getSorting?.()?.find((s) => s.id === id)?.desc ?? false;
      return compareTextDisplay(rowA.getValue(id), rowB.getValue(id), isDesc);
    };
  }
  return "auto";
}
