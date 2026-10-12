import { useState } from "react";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { exportSheets, saveFileAs, type ExportColumn } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { notify } from "@/lib/notify";
import {
  buildDeliveryCsv,
  withDeliveryExportScope,
} from "@/lib/deliveryWorkspace";
import { fmt } from "@/lib/money";
import { ACTION_LABELS } from "@shared/actionLabels";

type ExportRecord = Record<string, string>;
const metadataColumns: ExportColumn<ExportRecord>[] = [
  { key: "exportCompany", header: "الجهة", text: true },
  { key: "exportBranch", header: "نطاق الفرع", text: true },
  { key: "exportFilters", header: "الفلاتر", text: true },
  { key: "exportScope", header: "نطاق التصدير", text: true },
  { key: "exportTime", header: "وقت التصدير", text: true },
  { key: "exportCount", header: "عدد السجلات", text: true },
  { key: "exportTotals", header: "مجاميع التقرير", text: true },
];

/** The toolbar requests the full server scope; loaded rows are never treated as a full report. */
export function DeliveryWorkspaceExport({
  title,
  company,
  branch,
  filters,
  columns,
  load,
  totals,
  ready = true,
  selectedCount = 0,
  loadSelected,
}: {
  title: string;
  company: string;
  branch: string;
  filters: string;
  columns: ExportColumn<ExportRecord>[];
  load: () => Promise<ExportRecord[]>;
  totals: (rows: ExportRecord[]) => Record<string, string>;
  ready?: boolean;
  selectedCount?: number;
  loadSelected?: () => Promise<ExportRecord[]>;
}) {
  const [busy, setBusy] = useState(false);
  const data = async (selected: boolean) => {
    setBusy(true);
    try {
      const rows = await (selected && loadSelected ? loadSelected() : load());
      return withDeliveryExportScope(
        rows,
        {
          company,
          branch,
          filters,
          scope: selected
            ? `الصفوف المحددة (${selectedCount})`
            : "جميع النتائج المطابقة للفلاتر",
        },
        totals(rows),
      );
    } finally {
      setBusy(false);
    }
  };
  const save = (format: "xlsx" | "csv", selected = false) => {
    if (format === "xlsx") {
      exportSheets(title, async () => {
        const rows = await data(selected);
        return [
          {
            title,
            rows,
            columns: columns.map((column) => ({
              ...column,
              map: (row: Record<string, unknown>) => {
                const value = column.map
                  ? column.map(row as ExportRecord)
                  : String(row[String(column.key)] ?? "");
                return column.money && value !== "" && value != null
                  ? Number(value)
                  : value;
              },
            })),
            meta: [
              { label: "الجهة", value: company },
              { label: "نطاق الفرع", value: branch },
              { label: "الفلاتر", value: filters },
              {
                label: "النطاق",
                value: selected ? "المحدد" : "جميع النتائج المطابقة",
              },
              { label: "العدد", value: String(rows.length) },
              { label: "وقت الإصدار", value: new Date().toISOString() },
              ...Object.entries(totals(rows)).map(([label, value]) => ({
                label,
                value: `${value} د.ع`,
              })),
            ],
          },
        ];
      });
      return;
    }
    saveFileAs(
      async () => {
        const rows = await data(selected);
        const allColumns = [...columns, ...metadataColumns];
        const meta = [
          ["الجهة", company],
          ["نطاق الفرع", branch],
          ["الفلاتر", filters],
          ["النطاق", selected ? "المحدد" : "جميع النتائج المطابقة"],
          ["العدد", String(rows.length)],
          ["وقت الإصدار", new Date().toISOString()],
          ...Object.entries(totals(rows)),
        ];
        return new Blob(
          [
            buildDeliveryCsv(
              rows,
              allColumns.map((column) => ({
                ...column,
                key: String(column.key),
              })),
              meta,
            ),
          ],
          { type: "text/csv;charset=utf-8" },
        );
      },
      {
        filename: `${title}-${new Date().toISOString().slice(0, 10)}.csv`,
        description: "CSV",
        mime: "text/csv",
      },
    );
  };
  const print = async (selected = false) => {
    try {
      const rows = await data(selected);
      printReportDoc({
        title,
        orientation: "landscape",
        headerExtra: [
          { label: "الجهة", value: company },
          { label: "نطاق الفرع", value: branch },
          { label: "الفلاتر", value: filters },
          {
            label: "النطاق",
            value: selected ? "جميع الصفوف المحددة" : "جميع النتائج المطابقة",
          },
          { label: "العدد", value: String(rows.length) },
          { label: "وقت الإصدار", value: new Date().toISOString() },
        ],
        columns: columns.map((column) => ({
          key: String(column.key),
          label: column.header,
        })),
        rows: rows.map((row) =>
          Object.fromEntries(
            columns.map((column) => [
              String(column.key),
              String(
                column.map
                  ? (column.map(row) ?? "")
                  : (row[String(column.key)] ?? ""),
              ),
            ]),
          ),
        ),
        summary: Object.entries(totals(rows)).map(([label, value]) => ({
          label,
          value: `${fmt(value)} د.ع`,
        })),
      });
    } catch (error) {
      notify.err(error);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={busy || !ready}
        onClick={() => save("xlsx")}
      >
        Excel · جميع النتائج
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={busy || !ready}
        onClick={() => save("csv")}
      >
        CSV · جميع النتائج
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={busy || !ready}
        onClick={() => void print()}
      >
        <Printer aria-hidden className="size-3.5" /> طباعة جميع النتائج
      </Button>
      {loadSelected && selectedCount > 0 && (
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !ready}
            onClick={() => save("xlsx", true)}
          >
            Excel · المحدد ({selectedCount})
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !ready}
            onClick={() => save("csv", true)}
          >
            CSV · المحدد
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !ready}
            onClick={() => void print(true)}
          >
            طباعة المحدد ({selectedCount})
          </Button>
        </>
      )}
      {busy && (
        <span role="status" className="text-xs text-muted-foreground">
          {ACTION_LABELS.loading}
        </span>
      )}
    </div>
  );
}
