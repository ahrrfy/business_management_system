import { Button } from "@/components/ui/button";
import { AppSelect } from "@/components/ui/AppSelect";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { MoneyInput } from "@/components/form/MoneyInput";
import { fmt, D } from "@/lib/money";
import type { Decimal } from "decimal.js";
import type { Dispatch, SetStateAction } from "react";

const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export interface FundingSourceItem {
  receiptId: number | string;
  sourceShiftId?: number | null;
  sourceUserName?: string | null;
  referenceNumber?: string | null;
  amount: string;
}

export interface ShiftFundingDialogProps {
  fundingShiftId: number | null;
  fundingRowUserName?: string | null;
  fundingReportLoading: boolean;
  fundingExpected: Decimal | null;
  fundingSources: FundingSourceItem[];
  fundingSourcesLoading: boolean;
  fundingSourcesNextCursor?: number | null;
  fundingSourceReceiptId: string;
  setFundingSourceReceiptId: (v: string) => void;
  fundingAmount: string;
  setFundingAmount: (v: string) => void;
  fundingNote: string;
  setFundingNote: (v: string) => void;
  fundingSourceCursor: number | null;
  setFundingSourceCursor: (v: number | null) => void;
  fundingSourceCursorHistory: Array<number | null>;
  setFundingSourceCursorHistory: Dispatch<SetStateAction<Array<number | null>>>;
  fundingClientRequestId: string;
  isPending: boolean;
  onClose: () => void;
  onSubmit: () => void;
}

export function ShiftFundingDialog({
  fundingShiftId,
  fundingRowUserName,
  fundingReportLoading,
  fundingExpected,
  fundingSources,
  fundingSourcesLoading,
  fundingSourcesNextCursor,
  fundingSourceReceiptId,
  setFundingSourceReceiptId,
  fundingAmount,
  setFundingAmount,
  fundingNote,
  setFundingNote,
  fundingSourceCursor,
  setFundingSourceCursor,
  fundingSourceCursorHistory,
  setFundingSourceCursorHistory,
  fundingClientRequestId,
  isPending,
  onClose,
  onSubmit,
}: ShiftFundingDialogProps) {
  return (
    <Dialog
      open={fundingShiftId != null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            تمويل إضافي للوردية #{fundingShiftId} — {fundingRowUserName ?? ""}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
            هذا طلب تسليم فقط: لا تُخصم الخزنة ولا يزيد الدرج حتى يستلم صاحب الوردية النقد فعلياً
            ويؤكد الاستلام. الرصيد المتوقع الحي: {fundingReportLoading ? "جارٍ الحساب…" : fundingExpected == null ? "—" : `${fmt(fundingExpected.toString())} د.ع`}.
          </div>
          {fundingExpected?.lt(0) && (
            <div className="rounded-lg border border-destructive/60 bg-destructive/10 p-3 text-xs font-bold text-destructive">
              هذه الوردية سالبة؛ لا يجوز إخفاء العجز بتمويل إضافي. عالج المستند المسبب أو استخدم مسار التصحيح التاريخي.
            </div>
          )}
          <div className="space-y-1.5">
            <label htmlFor="shift-funding-source" className="text-sm font-bold">
              سحب الوردية المصدر
            </label>
            <AppSelect
              id="shift-funding-source"
              className={`${selectCls} h-10 w-full`}
              value={fundingSourceReceiptId}
              disabled={fundingSourcesLoading}
              onValueChange={(value) => {
                const nextId = value;
                setFundingSourceReceiptId(nextId);
                const selected = fundingSources.find(
                  (source) => Number(source.receiptId) === Number(nextId),
                );
                setFundingAmount(selected?.amount ?? "");
              }}
            >
              <option value="">اختر سحباً نقدياً مقبولاً وغير مستخدم</option>
              {fundingSources.map((source) => (
                <option key={source.receiptId} value={source.receiptId}>
                  {source.referenceNumber} — وردية #{source.sourceShiftId} {source.sourceUserName ?? ""} — {fmt(source.amount)} د.ع
                </option>
              ))}
            </AppSelect>
            <p className="text-xs text-muted-foreground">
              إلزامي: يجب أن يكون سحباً مقبولاً من وردية أخرى وبنفس المبلغ، ولا يمكن استعماله مرتين. من دون سحبٍ فعلي أغلق الوردية وافتح وردية جديدة بعهدة من الخزينة.
            </p>
            {!fundingSourcesLoading && fundingSources.length === 0 && (
              <p className="text-xs font-bold text-warning">
                {fundingSourcesNextCursor != null
                  ? "لا يوجد مصدر صالح في هذه الصفحة؛ اعرض المصادر الأقدم."
                  : "لا يوجد سحب وردية مقبول متاح لهذا الفرع. نفّذ السحب واستلمه في الخزينة أولاً."}
              </p>
            )}
            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={fundingSourcesLoading || fundingSourceCursorHistory.length === 0}
                onClick={() => {
                  setFundingSourceReceiptId("");
                  setFundingAmount("");
                  setFundingSourceCursorHistory((history) => {
                    const previous = history[history.length - 1] ?? null;
                    setFundingSourceCursor(previous);
                    return history.slice(0, -1);
                  });
                }}
              >
                الأحدث
              </Button>
              <span className="text-xs text-muted-foreground">50 مصدراً في الصفحة كحد أقصى</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={fundingSourcesLoading || fundingSourcesNextCursor == null}
                onClick={() => {
                  if (fundingSourcesNextCursor == null) return;
                  setFundingSourceReceiptId("");
                  setFundingAmount("");
                  setFundingSourceCursorHistory((history) => [...history, fundingSourceCursor]);
                  setFundingSourceCursor(fundingSourcesNextCursor);
                }}
              >
                الأقدم
              </Button>
            </div>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="shift-funding-amount" className="text-sm font-bold">
              المبلغ المطابق للسحب
            </label>
            <MoneyInput
              id="shift-funding-amount"
              value={fundingAmount}
              onChange={setFundingAmount}
              placeholder="0"
              ariaLabel="مبلغ التمويل الإضافي للوردية"
              disabled
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="shift-funding-note" className="text-sm font-bold">
              سبب الحاجة للنقد
            </label>
            <Textarea
              id="shift-funding-note"
              rows={3}
              maxLength={500}
              value={fundingNote}
              onChange={(event) => setFundingNote(event.target.value)}
              placeholder="مثال: عهدة لتسديد مصروفات تشغيلية متوقعة خلال الوردية"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            إلغاء
          </Button>
          <Button
            disabled={
              isPending ||
              fundingReportLoading ||
              fundingExpected == null ||
              fundingExpected.lt(0) ||
              !fundingAmount ||
              !fundingSourceReceiptId ||
              D(fundingAmount || 0).lte(0) ||
              fundingNote.trim().length < 10 ||
              !fundingClientRequestId
            }
            onClick={onSubmit}
          >
            {isPending ? "جارٍ إنشاء العهدة…" : "إنشاء طلب التسليم"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
