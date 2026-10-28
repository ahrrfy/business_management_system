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
  treasuryAvailable?: string;
  fundingSourcesError?: string;
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
  treasuryAvailable,
  fundingSourcesError,
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
      <DialogContent className="grid-cols-1 sm:max-w-lg" aria-describedby="shift-funding-summary">
        <DialogHeader>
          <DialogTitle>
            تمويل إضافي للوردية #{fundingShiftId} — {fundingRowUserName ?? ""}
          </DialogTitle>
        </DialogHeader>
        <div className="min-w-0 space-y-4">
          <div id="shift-funding-summary" className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
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
              مصدر التمويل
            </label>
            <AppSelect
              id="shift-funding-source"
              className={`${selectCls} h-10 min-w-0 w-full [&>span]:block [&>span]:truncate`}
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
              <option value="">اختر مصدر التمويل</option>
              <option value="TREASURY">خزينة الفرع — {treasuryAvailable == null ? "—" : fmt(treasuryAvailable)} د.ع متاح</option>
              {fundingSources.map((source) => (
                <option key={source.receiptId} value={source.receiptId}>
                  {source.referenceNumber} — سحب من درج نشط #{source.sourceShiftId} {source.sourceUserName ?? ""} — {fmt(source.amount)} د.ع
                </option>
              ))}
            </AppSelect>
            <p className="text-xs text-muted-foreground">
              اختر الخزينة وأدخل المبلغ، أو سحباً نقدياً فعلياً من درج وردية نشطة أخرى بعد قبول الخزينة له. السحب يُستخدم مرة واحدة وبمبلغه الكامل؛ أموال الورديات المغلقة تُموّل من الخزينة.
            </p>
            <p className="text-xs text-muted-foreground">الرصيد المعروض غير محجوز، ويُفحص مجدداً عند الاستلام. لا يُسحب نقد جديد من درج المصدر عند قبول التمويل.</p>
            {fundingSourcesError && <p role="alert" className="text-xs text-destructive">تعذّر تحميل مصادر التمويل: {fundingSourcesError}</p>}
            {!fundingSourcesLoading && fundingSourceReceiptId !== "TREASURY" && fundingSources.length === 0 && (
              <p className="text-xs font-bold text-warning">
                {fundingSourcesNextCursor != null
                  ? "لا يوجد مصدر صالح في هذه الصفحة؛ اعرض المصادر الأقدم."
                  : "لا يوجد سحب مقبول من درج نشط. يمكنك التمويل من خزينة الفرع أو تنفيذ سحب واستلامه في الخزينة أولاً."}
              </p>
            )}
            {(fundingSourcesNextCursor != null || fundingSourceCursorHistory.length > 0) && <div className="flex items-center justify-between gap-2">
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
            </div>}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="shift-funding-amount" className="text-sm font-bold">
              {fundingSourceReceiptId === "TREASURY" ? "مبلغ التمويل من الخزينة" : "المبلغ المطابق للسحب"}
            </label>
            <MoneyInput
              id="shift-funding-amount"
              value={fundingAmount}
              onChange={setFundingAmount}
              placeholder="0"
              ariaLabel="مبلغ التمويل الإضافي للوردية"
              disabled={fundingSourceReceiptId !== "TREASURY" || isPending}
            />
            {fundingSourceReceiptId === "TREASURY" && treasuryAvailable != null && D(fundingAmount || 0).gt(treasuryAvailable) && (
              <p role="alert" className="text-xs text-destructive">المبلغ يتجاوز رصيد الخزينة المتاح: {fmt(treasuryAvailable)} د.ع.</p>
            )}
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
              fundingSourcesLoading ||
              !!fundingSourcesError ||
              fundingReportLoading ||
              fundingExpected == null ||
              fundingExpected.lt(0) ||
              !fundingAmount ||
              !fundingSourceReceiptId ||
              D(fundingAmount || 0).lte(0) ||
              (fundingSourceReceiptId === "TREASURY" && (treasuryAvailable == null || D(fundingAmount || 0).gt(treasuryAvailable))) ||
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
