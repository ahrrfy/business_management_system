import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { LoadingState } from "@/components/PageState";
import { MoneyInput } from "@/components/form/MoneyInput";
import { ShiftCashReconciliation } from "@/components/financial";
import { fmtDateTime } from "@/lib/date";
import { fmt as fmtMoney } from "@/lib/money";
import { Check } from "lucide-react";
import type { Decimal } from "decimal.js";

const fmtDT = (d: string | number | Date | null | undefined) => fmtDateTime(d);

export interface ShiftCloseDialogProps {
  closingShiftId: number | null;
  closingRowUserName?: string | null;
  isLoading: boolean;
  closeReportData?: {
    invoiceCount?: number;
    salesTotal?: string | number;
  } | null;
  closeReconciliation: any;
  isLegacyNegative: boolean;
  isOwner: boolean;
  closeExpected: Decimal | null;
  closeCounted: string;
  setCloseCounted: (v: string) => void;
  closeDiff: Decimal | null;
  closeHasVariance: boolean;
  varianceCls: (v: string | null) => string;
  legacySourceReceiptId: string;
  setLegacySourceReceiptId: (v: string) => void;
  legacyEvidenceNote: string;
  setLegacyEvidenceNote: (v: string) => void;
  legacyConfirmedZero: boolean;
  setLegacyConfirmedZero: (v: boolean) => void;
  legacyClientRequestId: string;
  isPending: boolean;
  onClose: () => void;
  onSubmit: (params: {
    isLegacyNegative: boolean;
    closingShiftId: number;
    closeExpected: Decimal;
    legacySourceReceiptId: string;
    legacyEvidenceNote: string;
    legacyClientRequestId: string;
    closeCounted: string;
  }) => void;
}

export function ShiftCloseDialog({
  closingShiftId,
  closingRowUserName,
  isLoading,
  closeReportData,
  closeReconciliation,
  isLegacyNegative,
  isOwner,
  closeExpected,
  closeCounted,
  setCloseCounted,
  closeDiff,
  closeHasVariance,
  varianceCls,
  legacySourceReceiptId,
  setLegacySourceReceiptId,
  legacyEvidenceNote,
  setLegacyEvidenceNote,
  legacyConfirmedZero,
  setLegacyConfirmedZero,
  legacyClientRequestId,
  isPending,
  onClose,
  onSubmit,
}: ShiftCloseDialogProps) {
  return (
    <Dialog
      open={closingShiftId != null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle>
            إغلاق وردية #{closingShiftId} — {closingRowUserName ?? ""}
          </DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <LoadingState />
        ) : (
          <>
            <div className="rounded-xl border bg-muted/30 px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold">
                  ملخص الفواتير (للمعلومة فقط)
                </span>
                <span className="tabular-nums" dir="ltr">
                  {closeReportData?.invoiceCount ?? 0} فاتورة ·{" "}
                  {fmtMoney(Number(closeReportData?.salesTotal ?? 0))} د.ع
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                هذا الإجمالي لا يدخل معادلة الإغلاق؛ التسوية أدناه مبنية على
                إيصالات النقد الفعلية لهذه الوردية.
              </p>
            </div>
            <ShiftCashReconciliation
              data={closeReconciliation}
              defaultExpandedKeys={[
                "cashSales",
                "cashReturns",
                "cashExpenses",
                "cashDrops",
              ]}
              formatMoney={(value) =>
                value == null || value === "" ? "—" : fmtMoney(String(value))
              }
              formatDateTime={(value) => fmtDT(value)}
            />
            {isLegacyNegative && isOwner ? (
              <div className="space-y-4 rounded-xl border border-warning/40 bg-warning/5 p-4 text-sm">
                <div>
                  <p className="font-bold">معالجة رصيد سالب موروث — للمالك فقط</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    سيُسحب من الخزنة مبلغ {fmtMoney(closeExpected?.abs().toNumber() ?? 0)} د.ع
                    ويُضاف إلى هذه الوردية بسندَي تصحيح مترابطين، ثم يُثبت الرصيد والمعدود
                    والفرق صفراً وتُغلق الوردية. لن يتغير أي سند تاريخي.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="legacy-source-receipt" className="font-bold">
                    رقم إيصال السحب الموجود في الخزنة (إن وُجد)
                  </label>
                  <Input
                    id="legacy-source-receipt"
                    type="number"
                    min={1}
                    inputMode="numeric"
                    value={legacySourceReceiptId}
                    onChange={(event) => setLegacySourceReceiptId(event.target.value)}
                    placeholder="مثال: 2996"
                  />
                  <p className="text-xs text-muted-foreground">
                    يُستعمل لإثبات سلسلة الحيازة فقط؛ المتبقي منه يبقى في الخزنة.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="legacy-evidence-note" className="font-bold">
                    دليل وسبب المعالجة
                  </label>
                  <Textarea
                    id="legacy-evidence-note"
                    rows={3}
                    maxLength={1000}
                    value={legacyEvidenceNote}
                    onChange={(event) => setLegacyEvidenceNote(event.target.value)}
                    placeholder="اذكر نتيجة المراجعة، مصدر المبلغ، وتوجيه المالك…"
                  />
                </div>
                <label className="flex items-start gap-2 rounded-md border bg-background p-3 font-bold">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4"
                    checked={legacyConfirmedZero}
                    onChange={(event) => setLegacyConfirmedZero(event.target.checked)}
                  />
                  <span>أؤكد أن النقد الموجود فعلياً في درج هذه الوردية معدود ويساوي صفراً.</span>
                </label>
              </div>
            ) : isLegacyNegative ? (
              <div className="rounded-xl border border-destructive/60 bg-destructive/10 p-3 text-xs font-bold text-destructive">
                هذه وردية سالبة موروثة. لا يملك حق تمويلها وتصفيرها وإغلاقها إلا حساب المالك.
              </div>
            ) : (
              <div className="space-y-1.5 rounded-xl border p-4">
                <label
                  htmlFor="close-counted-cash"
                  className="block text-sm font-bold"
                >
                  النقد المعدود (د.ع)
                </label>
                <MoneyInput
                  id="close-counted-cash"
                  value={closeCounted}
                  onChange={setCloseCounted}
                  placeholder="0"
                  ariaLabel="النقد المعدود عند إغلاق الوردية"
                  className="h-11 text-center text-lg font-extrabold"
                />
                {closeDiff != null && (
                  <div
                    className={`flex items-center gap-1 text-sm font-bold ${varianceCls(closeDiff.toFixed(2))}`}
                  >
                    <span>
                      الفرق: {closeDiff.gte(0) ? "+" : ""}
                      {fmtMoney(closeDiff.toNumber())} د.ع
                    </span>
                    {closeDiff.isZero() && (
                      <Check aria-hidden className="size-3.5" />
                    )}
                  </div>
                )}
              </div>
            )}
            {!isLegacyNegative && closeHasVariance && (
              <div className="rounded-xl border border-destructive/60 bg-destructive/10 p-3 text-xs font-bold text-destructive">
                لا يمكن إغلاق الوردية: النقد المعدود لا يساوي الافتتاحي مضافاً
                إليه صافي المبيعات النقدية المسجّلة. راجع الفواتير والمرتجعات
                لهذه الوردية أولاً.
              </div>
            )}
          </>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            إلغاء
          </Button>
          <Button
            disabled={
              isPending ||
              closeExpected == null ||
              (isLegacyNegative
                ? !isOwner ||
                  legacyEvidenceNote.trim().length < 20 ||
                  !legacyConfirmedZero ||
                  !legacyClientRequestId
                : !closeCounted || closeHasVariance)
            }
            onClick={() => {
              if (closingShiftId == null || closeExpected == null) return;
              onSubmit({
                isLegacyNegative,
                closingShiftId,
                closeExpected,
                legacySourceReceiptId,
                legacyEvidenceNote,
                legacyClientRequestId,
                closeCounted,
              });
            }}
          >
            {isPending
              ? "جارٍ التنفيذ…"
              : isLegacyNegative
                ? "تمويل من الخزنة وتصفير وإغلاق"
                : "إغلاق"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
