import React, { useEffect, useMemo, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/data-table/DataTable";
import { D, fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import {
  previewStatementImport,
  readStatementImportFile,
  STATEMENT_IMPORT_REASON,
  type StatementImportSource,
} from "@/lib/deliveryOperations";
import type { CompanyStatementQueueCandidate } from "./companyStatementQueue";

export function CompanyStatementImport({
  partyId,
  candidates,
  selectedIds,
  disabled,
  onApply,
}: {
  partyId: number;
  candidates: readonly CompanyStatementQueueCandidate[];
  selectedIds: readonly number[];
  disabled: boolean;
  onApply: (
    lines: Array<{ consignmentId: number; collectedAmount: string }>,
  ) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);
  useEffect(
    () => () => {
      requestRef.current += 1;
    },
    [],
  );
  const [reading, setReading] = useState(false);
  const [source, setSource] = useState<{
    partyId: number;
    filename: string;
    rows: StatementImportSource[];
    rowNumbers: number[];
  } | null>(null);
  const preview = useMemo(
    () =>
      source?.partyId === partyId
        ? previewStatementImport(
            source.rows,
            candidates,
            partyId,
            new Set(selectedIds),
          ).map((row, index) => ({
            ...row,
            rowNumber: source.rowNumbers[index] ?? row.rowNumber,
          }))
        : [],
    [source, candidates, partyId, selectedIds],
  );
  const ready = preview.filter((row) => row.verdict === "READY");
  const total = ready.reduce(
    (sum, row) => sum.plus(D(row.collectedAmount)),
    D(0),
  );
  const clear = () => {
    requestRef.current += 1;
    setSource(null);
    setReading(false);
  };
  async function read(file: File) {
    const request = ++requestRef.current;
    setSource(null);
    if (!/\.(csv|xlsx)$/i.test(file.name) || file.size > 5 * 1024 * 1024) {
      notify.err("اختر CSV أو XLSX بحجم لا يتجاوز 5 MB");
      return;
    }
    setReading(true);
    try {
      const sheet = await readStatementImportFile(file);
      if (request !== requestRef.current) return;
      setSource({
        partyId,
        filename: file.name,
        rows: sheet.rows,
        rowNumbers: sheet.rowNumbers,
      });
    } catch (error) {
      if (request === requestRef.current)
        notify.err(error, "تعذّرت قراءة كشف الشركة");
    } finally {
      if (request === requestRef.current) setReading(false);
    }
  }
  return (
    <div className="space-y-3 rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || reading}
          onClick={() => fileRef.current?.click()}
        >
          <Upload aria-hidden className="size-4" />
          {reading ? "قراءة الملف…" : "معاينة كشف CSV / XLSX"}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.xlsx"
          className="hidden"
          aria-label="ملف كشف الشركة"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void read(file);
          }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        الأعمدة: collectedAmount (مبلغ بلا فواصل آلاف)، وconsignmentId (معرّف
        الإرسالية) أو externalTrackingRef (البوليصة كنص للحفاظ على الأصفار).
        partyId اختياري للتحقق من الجهة. تُقرأ الورقة الأولى؛ لا يتغير التحديد
        قبل مراجعة المعاينة.
      </p>
      {preview.length > 0 && (
        <>
          <p className="text-xs font-bold">
            {source?.filename} — جاهز: {ready.length} · مستبعد:{" "}
            {preview.length - ready.length} · مجموع الجاهز:{" "}
            {fmt(total.toFixed(2))} د.ع
          </p>
          <DataTable
            data={preview}
            columns={[
              { accessorKey: "rowNumber", header: "السطر" },
              { accessorKey: "reference", header: "المرجع" },
              {
                id: "invoice",
                header: "الفاتورة",
                accessorFn: (row) => row.candidate?.invoiceNumber ?? "—",
              },
              {
                id: "amount",
                header: "مبلغ الكشف",
            accessorFn: (row) => (row.collectedAmount ?? row.sourceCollectedAmount) || "—",
              },
              {
                id: "verdict",
                header: "نتيجة المطابقة",
                accessorFn: (row) => STATEMENT_IMPORT_REASON[row.verdict],
              },
            ]}
            searchable={false}
            pageSize={25}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={disabled || !ready.length}
              onClick={() => {
                onApply(
                  ready.flatMap((row) =>
                    row.candidate && row.collectedAmount != null
                      ? [
                          {
                            consignmentId: row.candidate.id,
                            collectedAmount: row.collectedAmount,
                          },
                        ]
                      : [],
                  ),
                );
                notify.ok(
                  `أُضيف ${ready.length} سطراً إلى التحديد`,
                  "راجع المبالغ والتحديد ثم أكد التسوية من زرها المعتاد.",
                );
                clear();
              }}
            >
              إضافة الجاهز إلى التحديد ({ready.length})
            </Button>
            <Button type="button" variant="ghost" onClick={clear}>
              إغلاق المعاينة
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
