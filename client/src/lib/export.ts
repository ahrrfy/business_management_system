// تصدير أي صفوف إلى Excel أو CSV — للمالك/المحاسب (§٢ تقليل الجهد).
// استُبدل xlsx@0.18.5 المهجور (CVE-2023-30533: Prototype Pollution + ReDoS) بـexceljs المُصان.
//
// «أين أحفظ؟» (طلب المالك ١٢/٧): حوار «حفظ باسم» حقيقي عبر File System Access API
// (Chrome/Edge) يسأل المستخدم المكانَ والاسم. **يجب** فتح الحوار متزامناً داخل إيماءة
// النقر (transient activation) قبل أي await — لذلك تقبل exportRows/exportSheets دالةَ
// جلبٍ بدل المصفوفة (القوائم المُصفّحة): الحوار يُفتح فوراً والجلب يجري بالتوازي.
// المتصفحات غير الداعمة (Firefox/Safari) تسقط تلقائياً للتنزيل التقليدي (مجلد التنزيلات)،
// وإلغاء المستخدم للحوار يُلغي التصدير بصمت (لا تنزيل خلفياً).
//
// Excel احترافي (ترقية ٢٧/٦): رأس عناوين عريض ملوّن + تجميد + اتجاه RTL للورقة + عرض أعمدة
// تلقائي + تنسيق مالي رقمي (#,##0 ⇒ مجاميع Excel تعمل) + كتلة ترويسة (عنوان/فلاتر) + صفّ مجاميع.
// كلّها اختيارية ⇒ متوافق رجعياً مع كل المستدعين القائمين.
//
// الاستعمال:
//   exportRows(rows, { filename: "الفواتير", title: "تقرير الفواتير", columns: [
//     { key: "invoiceNumber", header: "رقم الفاتورة" },
//     { key: "total", header: "الإجمالي", money: true, map: (r) => Number(r.total) },
//   ], totalsRow: { invoiceNumber: "الإجمالي", total: 1000 }});
//   exportSheets("التقرير-الشهري", [{ sheetName: "أرباح", columns, rows }, ...]);  // متعدّد الأوراق
// نوع فقط (يُمحى عند الترجمة) — مكتبة exceljs (~936KB) تُحمَّل **ديناميكياً** عند التصدير فقط
// (انظر exportRows/exportSheets). كانت import استاتيكية ⇒ كل صفحة تستورد هذا الملف (وكثيرٌ منها
// عبر ListToolbar/DataTable) تجلب 936KB eager بلا داعٍ — مساهمٌ كبير في بطء فتح الصفحات.
import type ExcelJS from "exceljs";
import { notify } from "@/lib/notify";

export type ExportColumn<T> = {
  key: keyof T | string;
  header: string;
  /** تحويل اختياري للقيمة قبل التصدير (مثلاً تنسيق رقم أو تاريخ). */
  map?: (row: T) => string | number | null | undefined;
  /** عمود مالي ⇒ يُنسَّق رقمياً (#,##0) ومحاذاة يسار في Excel. */
  money?: boolean;
};

type SheetMeta = { label: string; value: string };

export type SheetSpec<T = Record<string, unknown>> = {
  sheetName?: string;
  /** عنوان التقرير أعلى الورقة (صفّ مدمج عريض). */
  title?: string;
  /** أسطر وصفية (الفترة/الفرع/الفلاتر) تحت العنوان. */
  meta?: SheetMeta[];
  columns: ExportColumn<T>[];
  rows: T[];
  /** صفّ مجاميع أسفل الجدول (قيم جزئية بمفتاح العمود). */
  totalsRow?: Record<string, string | number>;
};

type ExportOptions<T> = Omit<SheetSpec<T>, "rows"> & {
  filename: string;
  format?: "xlsx" | "csv";
};

// ── لوحة ألوان الهوية للتصدير ──
const HEADER_FILL = "FF1E3A5F"; // أزرق عميق — رأس العناوين
const HEADER_TEXT = "FFFFFFFF";
const TOTALS_FILL = "FFF1F5F9"; // رمادي فاتح — صفّ المجاميع
const META_TEXT = "FF64748B";
const MONEY_FMT = "#,##0";

// ── طباعة A4 + خطّ واضح كبير نسبياً (خصوصاً للتقارير والكشوفات) ──
// خطّ Arial: واضح ويدعم العربية في Excel على كل الأنظمة (Cairo غير مضمون التثبيت لدى المستلِم).
const BASE_FONT = "Arial";
const BODY_SIZE = 12; // جسم الجدول — أكبر من افتراضي Excel (11) لوضوح أعلى عند الطباعة
const HEADER_SIZE = 12; // رأس العناوين
const TITLE_SIZE = 16; // عنوان التقرير
const META_SIZE = 11; // أسطر الفلاتر/الفترة
const GRID = "FFCBD5E1"; // حدّ رمادي فاتح — شبكة الجدول المطبوع
const thin = { style: "thin" as const, color: { argb: GRID } };
const cellBorder = { top: thin, left: thin, bottom: thin, right: thin };

function cellValue<T>(row: T, col: ExportColumn<T>): string | number {
  const raw = col.map ? col.map(row) : (row as Record<string, unknown>)[col.key as string];
  if (raw === null || raw === undefined) return "";
  return typeof raw === "number" ? raw : String(raw);
}

/* ============================ CSV (مبسّط، بلا تنسيق) ============================ */

function csvCell(v: string | number): string {
  const s = typeof v === "number" ? String(v) : v;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv<T>(rows: T[], columns: ExportColumn<T>[]): string {
  const header = columns.map((c) => c.header);
  const body = rows.map((row) => columns.map((c) => cellValue(row, c)));
  return [header, ...body].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

/* ============================ Excel (احترافي) ============================ */

/** يبني ورقة منسّقة (رأس عريض + RTL + تنسيق مالي + مجاميع + عرض تلقائي + تجميد). */
function buildSheet<T>(wb: ExcelJS.Workbook, spec: SheetSpec<T>): void {
  const cols = spec.columns;
  const ws = wb.addWorksheet(spec.sheetName ?? "بيانات", { views: [{ rightToLeft: true }] });
  let r = 1;

  if (spec.title) {
    ws.mergeCells(r, 1, r, cols.length);
    const c = ws.getCell(r, 1);
    c.value = spec.title;
    c.font = { name: BASE_FONT, bold: true, size: TITLE_SIZE };
    c.alignment = { horizontal: "right" };
    ws.getRow(r).height = 26;
    r++;
  }
  for (const m of spec.meta ?? []) {
    ws.mergeCells(r, 1, r, cols.length);
    const c = ws.getCell(r, 1);
    c.value = `${m.label}: ${m.value}`;
    c.font = { name: BASE_FONT, size: META_SIZE, color: { argb: META_TEXT } };
    c.alignment = { horizontal: "right" };
    r++;
  }
  if (spec.title || (spec.meta && spec.meta.length)) r++; // سطر فاصل

  // رأس العناوين
  const headerRowIdx = r;
  const hr = ws.getRow(r);
  hr.values = cols.map((c) => c.header);
  hr.eachCell((cell) => {
    cell.font = { name: BASE_FONT, bold: true, size: HEADER_SIZE, color: { argb: HEADER_TEXT } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
    cell.alignment = { horizontal: "right", vertical: "middle", wrapText: true };
    cell.border = cellBorder;
  });
  hr.height = 24;
  r++;

  // الصفوف — خطّ واضح + حدود شبكة + التفاف النصّ الطويل (يُبقي الأعمدة ضيّقة فيكبر الخط على A4).
  for (const row of spec.rows) {
    const xr = ws.getRow(r);
    xr.values = cols.map((c) => cellValue(row, c));
    cols.forEach((c, i) => {
      const cell = xr.getCell(i + 1);
      cell.font = { name: BASE_FONT, size: BODY_SIZE };
      cell.border = cellBorder;
      cell.alignment = { vertical: "middle", horizontal: c.money ? "left" : "right", wrapText: true };
      if (c.money) cell.numFmt = MONEY_FMT;
    });
    xr.height = 20;
    r++;
  }

  // صفّ المجاميع
  if (spec.totalsRow) {
    const tr = ws.getRow(r);
    tr.values = cols.map((c) => spec.totalsRow![c.key as string] ?? "");
    tr.eachCell((cell, i) => {
      cell.font = { name: BASE_FONT, bold: true, size: BODY_SIZE };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TOTALS_FILL } };
      cell.border = cellBorder;
      cell.alignment = { vertical: "middle", horizontal: cols[i - 1]?.money ? "left" : "right" };
      if (cols[i - 1]?.money) cell.numFmt = MONEY_FMT;
    });
    tr.height = 22;
    r++;
  }

  // عرض الأعمدة (تلقائي بحسب أطول محتوى، بحدّ أعلى أضيق ٣٢ ⇒ يبقى الخطّ كبيراً عند ضبط A4).
  cols.forEach((c, i) => {
    let max = c.header.length;
    for (const row of spec.rows) {
      const v = cellValue(row, c);
      const len = (typeof v === "number" ? v.toLocaleString() : v).length;
      if (len > max) max = len;
    }
    ws.getColumn(i + 1).width = Math.min(Math.max(max + 2, 12), 32);
  });

  // تجميد الرأس
  ws.views = [{ state: "frozen", ySplit: headerRowIdx, rightToLeft: true }];

  // ── ضبط الطباعة A4: عمودي للجداول الضيّقة وأفقي للعريضة (>٦ أعمدة) ليتّسع على A4،
  // ملاءمة العرض لصفحة واحدة، تكرار صفّ الرأس على كل صفحة مطبوعة، وترقيم الصفحات في التذييل.
  ws.pageSetup = {
    paperSize: 9, // A4
    orientation: cols.length > 6 ? "landscape" : "portrait",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    horizontalCentered: true,
    margins: { left: 0.4, right: 0.4, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 },
    printTitlesRow: `${headerRowIdx}:${headerRowIdx}`,
  };
  ws.headerFooter = { oddFooter: "&C&P / &N", evenFooter: "&C&P / &N" };
}

/* ──────────── مصرف الحفظ: حوار «حفظ باسم» (Chrome/Edge) أو التنزيل التقليدي ──────────── */

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// أنواع محلية دنيا لـFile System Access API (غير مكتملة في lib.dom).
type SaveWritable = { write(data: Blob): Promise<void>; close(): Promise<void> };
type SaveFileHandle = { createWritable(): Promise<SaveWritable> };
type SavePickerOptions = { suggestedName?: string; types?: Array<{ description?: string; accept: Record<string, string[]> }> };
type SaveSink = { kind: "picker"; handle: Promise<SaveFileHandle> } | { kind: "anchor" };

/**
 * يفتح حوار «حفظ باسم» — **متزامناً داخل إيماءة النقر** (بعد await يرفضه المتصفح بـSecurityError
 * فيسقط للتنزيل التقليدي داخل writeToSink). غير الداعم (Firefox/Safari) ⇒ anchor مباشرة.
 */
function acquireSaveSink(filename: string, description: string, mime: string, ext: string): SaveSink {
  const w = window as unknown as { showSaveFilePicker?: (o: SavePickerOptions) => Promise<SaveFileHandle> };
  if (typeof w.showSaveFilePicker !== "function") return { kind: "anchor" };
  const handle = w.showSaveFilePicker({
    suggestedName: filename,
    types: [{ description, accept: { [mime]: [ext] } }],
  });
  handle.catch(() => {}); // يمنع unhandledrejection إن ألغى المستخدم الحوار قبل جاهزية البيانات
  return { kind: "picker", handle };
}

/** يكتب الملف في المصرف: اختيار المستخدم (مع توست تأكيد) أو التنزيل التقليدي عند التعذّر. */
async function writeToSink(sink: SaveSink, blob: Blob, filename: string): Promise<void> {
  if (sink.kind === "picker") {
    try {
      const handle = await sink.handle;
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      notify.ok(`حُفظ الملف: ${filename}`);
      return;
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") return; // المستخدم ألغى — لا تنزيل خلفياً
      // SecurityError (انتهاء إيماءة النقر) أو فشل كتابة ⇒ سقوط للتنزيل التقليدي.
      console.warn("[export] save picker unavailable, falling back to download:", e);
    }
  }
  downloadBlob(blob, filename);
}

/**
 * يُصدّر صفوفاً إلى Excel (منسّق) أو CSV. void (لا Promise) للحفاظ على عقد المستدعين القائمين.
 * تقبل مصفوفةً جاهزة أو **دالة جلب** (القوائم المُصفّحة): مرّر الدالة نفسها لا نتيجتها —
 * حوار الحفظ يُفتح فوراً داخل إيماءة النقر بينما يجري الجلب بالتوازي.
 */
export function exportRows<T>(rowsOrFetch: T[] | (() => Promise<T[]>), opts: ExportOptions<T>): void {
  const stamp = new Date().toISOString().slice(0, 10);
  const format = opts.format ?? "xlsx";
  const filename = `${opts.filename}-${stamp}.${format}`;
  const sink =
    format === "csv"
      ? acquireSaveSink(filename, "CSV", "text/csv", ".csv")
      : acquireSaveSink(filename, "Excel", XLSX_MIME, ".xlsx");

  void (async () => {
    try {
      const rows = typeof rowsOrFetch === "function" ? await (rowsOrFetch as () => Promise<T[]>)() : rowsOrFetch;
      if (typeof rowsOrFetch === "function" && rows.length === 0) {
        notify.err("لا بيانات للتصدير");
        return;
      }
      if (format === "csv") {
        const csv = "﻿" + toCsv(rows, opts.columns); // BOM لقراءة العربية في Excel
        await writeToSink(sink, new Blob([csv], { type: "text/csv;charset=utf-8" }), filename);
        return;
      }
      // تحميل exceljs ديناميكياً عند التصدير فقط (حُزمة منفصلة لا تُثقل فتح الصفحات).
      const { default: ExcelJS } = await import("exceljs");
      const wb = new ExcelJS.Workbook();
      buildSheet(wb, { ...opts, rows });
      const buf = await wb.xlsx.writeBuffer();
      await writeToSink(sink, new Blob([buf], { type: XLSX_MIME }), filename);
    } catch (e) {
      console.error("[export] failed:", e);
      notify.err(e);
    }
  })();
}

/** يُصدّر عدّة أوراق في مصنّف واحد (حزمة المحاسب الشهرية). كل عنصر ورقة منسّقة مستقلّة. */
export function exportSheets(filename: string, sheetsOrFetch: SheetSpec[] | (() => Promise<SheetSpec[]>)): void {
  const stamp = new Date().toISOString().slice(0, 10);
  const full = `${filename}-${stamp}.xlsx`;
  const sink = acquireSaveSink(full, "Excel", XLSX_MIME, ".xlsx");
  void (async () => {
    try {
      const sheets = typeof sheetsOrFetch === "function" ? await sheetsOrFetch() : sheetsOrFetch;
      // تحميل exceljs ديناميكياً عند التصدير فقط.
      const { default: ExcelJS } = await import("exceljs");
      const wb = new ExcelJS.Workbook();
      if (!sheets.length) wb.addWorksheet("فارغة");
      for (const sheet of sheets) buildSheet(wb, sheet);
      const buf = await wb.xlsx.writeBuffer();
      await writeToSink(sink, new Blob([buf], { type: XLSX_MIME }), full);
    } catch (e) {
      console.error("[export.xlsx] failed:", e);
      notify.err(e);
    }
  })();
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
