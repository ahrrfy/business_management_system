// تصدير أي صفوف إلى Excel أو CSV — للمالك/المحاسب (§٢ تقليل الجهد).
// يعتمد xlsx المُثبَّت. الاستعمال:
//   exportRows(rows, { filename: "الفواتير", columns: [
//     { key: "invoiceNumber", header: "رقم الفاتورة" },
//     { key: "total", header: "الإجمالي", map: (r) => Number(r.total) },
//   ]});
import * as XLSX from "xlsx";

export type ExportColumn<T> = {
  key: keyof T | string;
  header: string;
  /** تحويل اختياري للقيمة قبل التصدير (مثلاً تنسيق رقم أو تاريخ). */
  map?: (row: T) => string | number | null | undefined;
};

type ExportOptions<T> = {
  filename: string;
  columns: ExportColumn<T>[];
  sheetName?: string;
  format?: "xlsx" | "csv";
};

function toMatrix<T>(rows: T[], columns: ExportColumn<T>[]): (string | number)[][] {
  const header = columns.map((c) => c.header);
  const body = rows.map((row) =>
    columns.map((c) => {
      const raw = c.map ? c.map(row) : (row as Record<string, unknown>)[c.key as string];
      if (raw === null || raw === undefined) return "";
      return typeof raw === "number" ? raw : String(raw);
    })
  );
  return [header, ...body];
}

export function exportRows<T>(rows: T[], opts: ExportOptions<T>): void {
  const matrix = toMatrix(rows, opts.columns);
  const ws = XLSX.utils.aoa_to_sheet(matrix);
  const fmt = opts.format ?? "xlsx";
  const stamp = new Date().toISOString().slice(0, 10);

  if (fmt === "csv") {
    // BOM لضمان قراءة العربية صحيحة في Excel.
    const csv = "﻿" + XLSX.utils.sheet_to_csv(ws);
    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${opts.filename}-${stamp}.csv`);
    return;
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, opts.sheetName ?? "بيانات");
  XLSX.writeFile(wb, `${opts.filename}-${stamp}.xlsx`);
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
