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
import ExcelJS from "exceljs";

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
    c.font = { bold: true, size: 14 };
    c.alignment = { horizontal: "right" };
    r++;
  }
  for (const m of spec.meta ?? []) {
    ws.mergeCells(r, 1, r, cols.length);
    const c = ws.getCell(r, 1);
    c.value = `${m.label}: ${m.value}`;
    c.font = { size: 10, color: { argb: META_TEXT } };
    c.alignment = { horizontal: "right" };
    r++;
  }
  if (spec.title || (spec.meta && spec.meta.length)) r++; // سطر فاصل

  // رأس العناوين
  const headerRowIdx = r;
  const hr = ws.getRow(r);
  hr.values = cols.map((c) => c.header);
  hr.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: HEADER_TEXT } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
    cell.alignment = { horizontal: "right", vertical: "middle" };
  });
  hr.height = 20;
  r++;

  // الصفوف
  for (const row of spec.rows) {
    const xr = ws.getRow(r);
    xr.values = cols.map((c) => cellValue(row, c));
    cols.forEach((c, i) => {
      const cell = xr.getCell(i + 1);
      if (c.money) {
        cell.numFmt = MONEY_FMT;
        cell.alignment = { horizontal: "left" };
      }
    });
    r++;
  }

  // صفّ المجاميع
  if (spec.totalsRow) {
    const tr = ws.getRow(r);
    tr.values = cols.map((c) => spec.totalsRow![c.key as string] ?? "");
    tr.eachCell((cell, i) => {
      cell.font = { bold: true };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TOTALS_FILL } };
      if (cols[i - 1]?.money) { cell.numFmt = MONEY_FMT; cell.alignment = { horizontal: "left" }; }
    });
    r++;
  }

  // عرض الأعمدة (تلقائي بحسب أطول محتوى، بحدود معقولة)
  cols.forEach((c, i) => {
    let max = c.header.length;
    for (const row of spec.rows) {
      const v = cellValue(row, c);
      const len = (typeof v === "number" ? v.toLocaleString() : v).length;
      if (len > max) max = len;
    }
    ws.getColumn(i + 1).width = Math.min(Math.max(max + 2, 10), 40);
  });

  // تجميد الرأس
  ws.views = [{ state: "frozen", ySplit: headerRowIdx, rightToLeft: true }];
}

function downloadWorkbook(wb: ExcelJS.Workbook, filename: string): void {
  void (async () => {
    try {
      const buf = await wb.xlsx.writeBuffer();
      downloadBlob(
        new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
        filename,
      );
    } catch (e) {
      console.error("[export.xlsx] failed:", e);
    }
  })();
}

/** يُصدّر صفوفاً إلى Excel (منسّق) أو CSV. void (لا Promise) للحفاظ على عقد المستدعين القائمين. */
export function exportRows<T>(rows: T[], opts: ExportOptions<T>): void {
  const stamp = new Date().toISOString().slice(0, 10);

  if ((opts.format ?? "xlsx") === "csv") {
    const csv = "﻿" + toCsv(rows, opts.columns); // BOM لقراءة العربية في Excel
    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${opts.filename}-${stamp}.csv`);
    return;
  }

  const wb = new ExcelJS.Workbook();
  buildSheet(wb, { ...opts, rows });
  downloadWorkbook(wb, `${opts.filename}-${stamp}.xlsx`);
}

/** يُصدّر عدّة أوراق في مصنّف واحد (حزمة المحاسب الشهرية). كل عنصر ورقة منسّقة مستقلّة. */
export function exportSheets(filename: string, sheets: SheetSpec[]): void {
  const stamp = new Date().toISOString().slice(0, 10);
  const wb = new ExcelJS.Workbook();
  if (!sheets.length) wb.addWorksheet("فارغة");
  for (const sheet of sheets) buildSheet(wb, sheet);
  downloadWorkbook(wb, `${filename}-${stamp}.xlsx`);
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
