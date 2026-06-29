// تصدير أي صفوف إلى Excel أو CSV — للمالك/المحاسب (§٢ تقليل الجهد).
// استُبدل xlsx@0.18.5 المهجور (CVE-2023-30533: Prototype Pollution + ReDoS) بـexceljs المُصان.
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

async function downloadWorkbook(wb: ExcelJS.Workbook, filename: string): Promise<void> {
  const buf = await wb.xlsx.writeBuffer();
  downloadBlob(
    new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    filename,
  );
}

/** يُصدّر صفوفاً إلى Excel (منسّق) أو CSV. void (لا Promise) للحفاظ على عقد المستدعين القائمين. */
export function exportRows<T>(rows: T[], opts: ExportOptions<T>): void {
  const stamp = new Date().toISOString().slice(0, 10);

  if ((opts.format ?? "xlsx") === "csv") {
    const csv = "﻿" + toCsv(rows, opts.columns); // BOM لقراءة العربية في Excel
    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${opts.filename}-${stamp}.csv`);
    return;
  }

  // تحميل exceljs ديناميكياً عند التصدير فقط (حُزمة منفصلة لا تُثقل فتح الصفحات).
  void (async () => {
    try {
      const { default: ExcelJS } = await import("exceljs");
      const wb = new ExcelJS.Workbook();
      buildSheet(wb, { ...opts, rows });
      await downloadWorkbook(wb, `${opts.filename}-${stamp}.xlsx`);
    } catch (e) {
      console.error("[export.xlsx] failed:", e);
    }
  })();
}

/** يُصدّر عدّة أوراق في مصنّف واحد (حزمة المحاسب الشهرية). كل عنصر ورقة منسّقة مستقلّة. */
export function exportSheets(filename: string, sheets: SheetSpec[]): void {
  const stamp = new Date().toISOString().slice(0, 10);
  // تحميل exceljs ديناميكياً عند التصدير فقط.
  void (async () => {
    try {
      const { default: ExcelJS } = await import("exceljs");
      const wb = new ExcelJS.Workbook();
      if (!sheets.length) wb.addWorksheet("فارغة");
      for (const sheet of sheets) buildSheet(wb, sheet);
      await downloadWorkbook(wb, `${filename}-${stamp}.xlsx`);
    } catch (e) {
      console.error("[export.xlsx] failed:", e);
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
