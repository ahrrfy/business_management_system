// تصدير أي صفوف إلى Excel أو CSV — للمالك/المحاسب (§٢ تقليل الجهد).
// استُبدل xlsx@0.18.5 المهجور (CVE-2023-30533: Prototype Pollution + ReDoS) بـexceljs المُصان.
// الاستعمال:
//   exportRows(rows, { filename: "الفواتير", columns: [
//     { key: "invoiceNumber", header: "رقم الفاتورة" },
//     { key: "total", header: "الإجمالي", map: (r) => Number(r.total) },
//   ]});
import ExcelJS from "exceljs";

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

/** قسم خلية CSV واحدة وفق RFC4180: علامتا اقتباس مزدوجتان، والاقتباس المُضاعَف داخل النصّ. */
function csvCell(v: string | number): string {
  const s = typeof v === "number" ? String(v) : v;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function matrixToCsv(matrix: (string | number)[][]): string {
  return matrix.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

/** يُصدّر صفوفاً إلى ملف Excel/CSV. التوقيع void (لا Promise) للحفاظ على عقد كل المستدعين القائمين
 *  (~٢٠ نقطة استدعاء بلا await) — writeBuffer غير المتزامن يُدار داخلياً ويُسجَّل خطؤه فقط. */
export function exportRows<T>(rows: T[], opts: ExportOptions<T>): void {
  const matrix = toMatrix(rows, opts.columns);
  const fmt = opts.format ?? "xlsx";
  const stamp = new Date().toISOString().slice(0, 10);

  if (fmt === "csv") {
    // BOM لضمان قراءة العربية صحيحة في Excel.
    const csv = "﻿" + matrixToCsv(matrix);
    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${opts.filename}-${stamp}.csv`);
    return;
  }

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(opts.sheetName ?? "بيانات");
  for (const row of matrix) ws.addRow(row);
  void (async () => {
    try {
      const buf = await wb.xlsx.writeBuffer();
      downloadBlob(
        new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
        `${opts.filename}-${stamp}.xlsx`,
      );
    } catch (e) {
      // فشل التصدير لا يُعطّل صفحة المستخدم — يُسجَّل وحسب.
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
