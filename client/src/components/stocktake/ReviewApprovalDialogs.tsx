import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { RouterOutputs, trpc } from "@/lib/trpc";

import { nf, money, dt } from "./ReviewDisplay";
type Review = RouterOutputs["stocktakes"]["review"];
type Row = Review["rows"][number];
type Target = { variantId: number; label: string } | null;
type Pending = { isPending: boolean };
import { AlertTriangle, Pen } from "lucide-react";
import { NegativeSettlementBanner } from "./NegativeSettlementUi";
interface Props {
  valuationRefreshOpen: boolean;
  setValuationRefreshOpen: (open: boolean) => void;
  valuationIntegrity: Review["valuationIntegrity"];
  valuationRefreshReason: string;
  setValuationRefreshReason: (value: string) => void;
  refreshOpeningValuation: Pending;
  submitValuationRefresh: () => void;
  canOperation: (path: string) => boolean;
  confirmOpen: boolean;
  setConfirmOpen: (open: boolean) => void;
  isOpening: boolean;
  s: Review["session"];
  autoCount: number;
  adjustExplicit: number;
  keepCount: number;
  totals: Review["totals"];
  hasShort: boolean;
  hasOver: boolean;
  ledgerPreview: Review["ledgerPreview"];
  noReasonCount: number;
  negativeSettleCount: number;
  barriers: Review["barriers"];
  actorName: string | null | undefined;
  approve: Pick<
    ReturnType<typeof trpc.stocktakes.approve.useMutation>,
    "mutate" | "isPending"
  >;
  sessionId: number;
}
export function ReviewApprovalDialogs({
  valuationRefreshOpen,
  setValuationRefreshOpen,
  valuationIntegrity,
  valuationRefreshReason,
  setValuationRefreshReason,
  refreshOpeningValuation,
  submitValuationRefresh,
  canOperation,
  confirmOpen,
  setConfirmOpen,
  isOpening,
  s,
  autoCount,
  adjustExplicit,
  keepCount,
  totals,
  hasShort,
  hasOver,
  ledgerPreview,
  noReasonCount,
  negativeSettleCount,
  barriers,
  actorName,
  approve,
  sessionId,
}: Props) {
  return (
    <>
      {/* حوار إنقاذ أساس التكلفة — أدمن فقط، لا يقبل سعراً من العميل */}
      <Dialog
        open={valuationRefreshOpen}
        onOpenChange={setValuationRefreshOpen}
      >
        <DialogContent className="max-h-[88vh] overflow-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>إنقاذ أساس تقييم الجرد الافتتاحي</DialogTitle>
            <DialogDescription>
              سيعيد الخادم اشتقاق تكاليف كل الصفوف المختلفة من تكلفة وحدة الأساس
              الحالية تحت الأقفال، ثم يقارن بصمة المعاينة قبل أي كتابة. لا يمكن
              إرسال سعر أو اختيار جزء من الصفوف من هذه الشاشة.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-md bg-money-negative/10 p-3">
                <p className="text-xs text-money-negative">التقييم المسجل</p>
                <p
                  className="font-bold tabular-nums text-money-negative"
                  dir="ltr"
                >
                  {money(valuationIntegrity.snapshotNetValue)}
                </p>
              </div>
              <div className="rounded-md bg-money-positive/10 p-3">
                <p className="text-xs text-money-positive">
                  بكلفة الأساس الحالية
                </p>
                <p
                  className="font-bold tabular-nums text-money-positive"
                  dir="ltr"
                >
                  {money(valuationIntegrity.currentBaseNetValue)}
                </p>
              </div>
              <div className="rounded-md bg-muted p-3">
                <p className="text-xs text-muted-foreground">فرق التضخم</p>
                <p className="font-bold tabular-nums" dir="ltr">
                  {money(valuationIntegrity.inflationDelta)}
                </p>
              </div>
            </div>
            <ul className="space-y-1 rounded-md border p-3 text-xs">
              <li>لا تتغير أي كمية معدودة أو رصيد مخزني.</li>
              <li>لا تُنشأ حركة مخزون أو قيد دفتر أو قبض أو صرف.</li>
              <li>تُفتح اعتمادات الصفوف المتغيرة ويُبطل التوقيع السابق.</li>
              <li>فشل أي خطوة أو تغير البصمة يلغي العملية كاملة.</li>
            </ul>
            <div className="space-y-1.5">
              <Label htmlFor="valuation-refresh-reason">
                سبب التصحيح ومصدر التحقق
              </Label>
              <Textarea
                id="valuation-refresh-reason"
                value={valuationRefreshReason}
                onChange={(e) => setValuationRefreshReason(e.target.value)}
                maxLength={500}
                placeholder="مثال: ثُبت من وحدة اللتر عامل 12,500 ومن الكتالوج أن 0.92 هي تكلفة وحدة الأساس"
              />
              <p className="text-[11px] text-muted-foreground">
                يُحفظ السبب والإجماليان وأكبر الفروقات في سجل تدقيق ذري.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setValuationRefreshOpen(false)}
            >
              رجوع بلا تغيير
            </Button>
            <Button
              variant="destructive"
              disabled={
                !canOperation("stocktakes.refreshOpeningValuationBasis") ||
                valuationRefreshReason.trim().length < 10 ||
                refreshOpeningValuation.isPending
              }
              onClick={submitValuationRefresh}
            >
              {refreshOpeningValuation.isPending
                ? "جارٍ التحقق والتنفيذ…"
                : "تنفيذ الإنقاذ وفتح الاعتمادات المتأثرة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* حوار تأكيد الاعتماد وتنفيذ التسوية */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-h-[88vh] overflow-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {isOpening
                ? "تأكيد اعتماد وتثبيت الأرصدة الافتتاحية"
                : "تأكيد اعتماد الجلسة وتنفيذ التسوية"}
            </DialogTitle>
            <DialogDescription>
              {isOpening
                ? "ستُثبَّت الأرصدة التالية"
                : "سيُنفَّذ التالي فور التأكيد"}{" "}
              — بمعاملة ذرّية واحدة بمرجع{" "}
              <span className="font-mono font-bold text-foreground" dir="ltr">
                {s.code}
              </span>
              :
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <ul className="space-y-1.5">
              <li className="flex justify-between rounded-md bg-muted/60 px-3 py-2">
                <span>
                  {isOpening
                    ? "أرصدة افتتاحية ستُثبت تلقائياً"
                    : "تسويات تلقائية (ضمن الحدّ)"}
                </span>
                <span className="font-bold tabular-nums" dir="ltr">
                  {nf(autoCount)}
                </span>
              </li>
              <li className="flex justify-between rounded-md bg-muted/60 px-3 py-2">
                <span>
                  {isOpening ? "أرصدة بقرار صريح" : "تسويات بقرار صريح"}
                </span>
                <span className="font-bold tabular-nums" dir="ltr">
                  {nf(adjustExplicit)}
                </span>
              </li>
              <li className="flex justify-between rounded-md bg-muted/60 px-3 py-2">
                <span>منتجات أُبقي رصيدها الدفتري</span>
                <span className="font-bold tabular-nums" dir="ltr">
                  {nf(keepCount)}
                </span>
              </li>
              <li className="flex justify-between rounded-md bg-money-negative/10 px-3 py-2 font-bold text-money-negative">
                <span>
                  {isOpening
                    ? "قيمة التغيير الافتتاحي بالتكلفة"
                    : "صافي قيمة التسوية"}
                </span>
                <span className="tabular-nums" dir="ltr">
                  {money(totals.netValue)}
                </span>
              </li>
            </ul>

            {/* معاينة القيد المحاسبي */}
            {isOpening ? (
              <div className="rounded-lg border border-money-positive/40 bg-money-positive/10 p-3 text-xs text-money-positive">
                <p className="font-bold">الأثر المحاسبي والنقدي: صفر</p>
                <p className="mt-1">
                  لا قيد عجز أو زيادة، ولا قبض أو صرف، ولا حركة صندوق أو مصرف أو
                  ذمم. العملية تثبت كميات المخزون فقط بحركات OPENING موثقة.
                </p>
              </div>
            ) : (
              <div className="rounded-lg border bg-muted/40 p-3">
                <p className="mb-1.5 text-xs font-bold">
                  القيد المحاسبي الآلي في الدفتر (مرجع{" "}
                  <span className="font-mono" dir="ltr">
                    {s.code}
                  </span>
                  ):
                </p>
                <div className="space-y-1 text-xs">
                  {hasShort && (
                    <p className="flex justify-between">
                      <span>مصروف عجز مخزون (مدين)</span>
                      <span
                        className="font-mono font-bold tabular-nums text-money-negative"
                        dir="ltr"
                      >
                        {money(ledgerPreview.shortExpense)}
                      </span>
                    </p>
                  )}
                  {hasOver && (
                    <p className="flex justify-between">
                      <span>تسوية زيادة مخزون (دائن)</span>
                      <span
                        className="font-mono font-bold tabular-nums text-money-positive"
                        dir="ltr"
                      >
                        {money(ledgerPreview.overGain)}
                      </span>
                    </p>
                  )}
                  {!hasShort && !hasOver && (
                    <p className="text-muted-foreground">
                      لا قيد — لا تسويات ذات قيمة.
                    </p>
                  )}
                </div>
              </div>
            )}

            {noReasonCount > 0 && (
              <p className="flex items-start gap-1.5 rounded-md bg-[var(--sem-warn-bg)] px-3 py-2 text-xs text-[var(--sem-warn)]">
                <AlertTriangle
                  aria-hidden
                  className="mt-0.5 size-3.5 shrink-0"
                />
                <span>
                  {nf(noReasonCount)} فرق بلا سبب محدد — يُنصح بتصنيفها
                  (تلف/فقدان/خطأ إدخال) ليصدق تقرير الانكماش السنوي. يمكنك
                  المتابعة على أي حال.
                </span>
              </p>
            )}
            <NegativeSettlementBanner count={negativeSettleCount} />
            {barriers.requiresDualSign && s.firstSign && (
              <p className="flex items-start gap-1.5 rounded-md bg-violet-50 px-3 py-2 text-xs text-violet-800">
                <Pen aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  اعتماد مزدوج: التوقيع الأول {s.firstSign.byName} ·{" "}
                  {dt(s.firstSign.at)} — توقيعك الآن هو النهائي.
                </span>
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              تُكتب حركات التسوية في سجلّ حركات المخزون وتُحدَّث الأرصدة تحت
              قفل، ويُقفل تعديل الجلسة نهائياً. الاعتماد باسم:{" "}
              <span className="font-bold text-foreground">{actorName}</span>.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              رجوع
            </Button>
            <Button
              className="bg-[var(--money-positive)] text-white hover:opacity-90"
              disabled={
                !canOperation("stocktakes.approve") || approve.isPending
              }
              onClick={() =>
                canOperation("stocktakes.approve") &&
                approve.mutate({ sessionId })
              }
            >
              {approve.isPending
                ? "جارٍ التنفيذ…"
                : isOpening
                  ? "تأكيد تثبيت الأرصدة"
                  : "تأكيد الاعتماد والتنفيذ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
