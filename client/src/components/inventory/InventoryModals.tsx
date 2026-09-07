import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MoneyInput } from "@/components/form/MoneyInput";
import { AppSelect } from "@/components/ui/AppSelect";
import { D, fmt, fmtInt } from "@/lib/money";
import { Scale, XCircle } from "lucide-react";
import type { Decimal } from "decimal.js";

export interface InventoryModalsProps {
  // Reject Adjustment Dialog
  rejectTarget: number | null;
  setRejectTarget: (id: number | null) => void;
  rejectReason: string;
  setRejectReason: (reason: string) => void;
  rejectAdjIsPending: boolean;
  onRejectAdj: () => void;

  // Revaluation Request Dialog
  revalFor: { variantId: number; label: string } | null;
  setRevalFor: (val: { variantId: number; label: string } | null) => void;
  revalPreview: {
    isLoading: boolean;
    data?: {
      costPrice: string;
      totalQuantity: number;
      branches: Array<{ branchId: number; branchName?: string | null; quantity: number }>;
    };
  };
  revalCost: string;
  setRevalCost: (val: string) => void;
  revalPurpose: "CORRECTION" | "IMPAIRMENT";
  setRevalPurpose: (val: "CORRECTION" | "IMPAIRMENT") => void;
  revalDelta: Decimal | null;
  revalReason: string;
  setRevalReason: (val: string) => void;
  revalCostOk: boolean;
  revalReasonOk: boolean;
  requestRevalIsPending: boolean;
  onRequestReval: () => void;

  // Revaluation Reject Dialog
  revalRejectTarget: number | null;
  setRevalRejectTarget: (id: number | null) => void;
  revalRejectReason: string;
  setRevalRejectReason: (reason: string) => void;
  rejectRevalIsPending: boolean;
  onRejectReval: () => void;
}

export function InventoryModals({
  rejectTarget,
  setRejectTarget,
  rejectReason,
  setRejectReason,
  rejectAdjIsPending,
  onRejectAdj,

  revalFor,
  setRevalFor,
  revalPreview,
  revalCost,
  setRevalCost,
  revalPurpose,
  setRevalPurpose,
  revalDelta,
  revalReason,
  setRevalReason,
  revalCostOk,
  revalReasonOk,
  requestRevalIsPending,
  onRequestReval,

  revalRejectTarget,
  setRevalRejectTarget,
  revalRejectReason,
  setRevalRejectReason,
  rejectRevalIsPending,
  onRejectReval,
}: InventoryModalsProps) {
  return (
    <>
      {/* حوار رفض طلب التسوية — بديل window.prompt: سبب إلزامي يُكتب للسجل التدقيقي. */}
      <Dialog
        open={rejectTarget != null}
        onOpenChange={(o) => {
          if (!o) setRejectTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>رفض طلب التسوية</DialogTitle>
            <DialogDescription>
              اذكر سبب الرفض — يُسجَّل في السجل التدقيقي ويظهر لمُنشئ الطلب.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1 py-1">
            <Label htmlFor="reject-reason">سبب الرفض</Label>
            <Textarea
              id="reject-reason"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="مثال: الرصيد الحالي صحيح — لا حاجة للتسوية"
              rows={3}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setRejectTarget(null)}
              disabled={rejectAdjIsPending}
            >
              إلغاء
            </Button>
            <Button
              variant="destructive"
              disabled={rejectAdjIsPending || !rejectReason.trim()}
              onClick={onRejectAdj}
            >
              <XCircle aria-hidden className="size-4 ml-1" /> رفض الطلب
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* طلب إعادة تقييم التكلفة — أثر القيمة يُعرَض قبل الإرسال، ولا يقع شيء حتى يعتمده مديرٌ ثانٍ. */}
      <Dialog
        open={revalFor != null}
        onOpenChange={(o) => {
          if (!o) setRevalFor(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>إعادة تقييم التكلفة — {revalFor?.label}</DialogTitle>
            <DialogDescription>
              تغيير التكلفة يحرّك قيمة المخزون في الميزانية، فيلزمه غرضٌ محاسبيّ
              وسببٌ مكتوب واعتماد مديرٍ آخر. يُرحَّل عند الاعتماد قيدٌ بقيمة فرق
              التكلفة × الكمية لكل فرعٍ له رصيد.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-1">
            {revalPreview.isLoading && (
              <p className="text-sm text-muted-foreground">
                جارٍ قراءة التكلفة والأرصدة…
              </p>
            )}
            {revalPreview.data && (
              <>
                <div className="rounded-md border p-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">التكلفة الحالية</span>
                    <span className="tabular-nums">
                      {fmt(revalPreview.data.costPrice)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      إجمالي الكمية المملوكة
                    </span>
                    <span className="tabular-nums">
                      {fmtInt(revalPreview.data.totalQuantity)}
                    </span>
                  </div>
                  {revalPreview.data.branches.length > 1 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      موزّعة على:{" "}
                      {revalPreview.data.branches
                        .map(
                          (b) =>
                            `${b.branchName ?? `#${b.branchId}`} (${fmtInt(b.quantity)})`,
                        )
                        .join(" · ")}
                    </p>
                  )}
                  {revalPreview.data.totalQuantity === 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      لا رصيد لهذا الصنف — تُصحَّح التكلفة بلا قيدٍ محاسبيّ.
                    </p>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="reval-cost">التكلفة الجديدة</Label>
                    <MoneyInput
                      id="reval-cost"
                      value={revalCost}
                      onChange={setRevalCost}
                      placeholder="0"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="reval-purpose">الغرض المحاسبيّ</Label>
                    <AppSelect
                      id="reval-purpose"
                      value={revalPurpose}
                      onValueChange={(v) =>
                        setRevalPurpose(v as "CORRECTION" | "IMPAIRMENT")
                      }
                    >
                      <option value="CORRECTION">تصحيح تكلفة خاطئة</option>
                      <option value="IMPAIRMENT">
                        هبوط قيمة / تقادم (نزولاً فقط)
                      </option>
                    </AppSelect>
                  </div>
                </div>

                {revalDelta != null && !revalDelta.isZero() && (
                  <p className="text-sm">
                    أثر القيمة على المخزون:{" "}
                    <span
                      className={`tabular-nums ${revalDelta.isNegative() ? "text-money-negative" : "text-money-positive"}`}
                    >
                      {fmt(revalDelta.toFixed(2))}
                    </span>
                  </p>
                )}
                {revalPurpose === "IMPAIRMENT" &&
                  revalCost.trim() !== "" &&
                  D(revalCost).gte(D(revalPreview.data.costPrice)) && (
                    <p className="text-sm text-destructive">
                      هبوط القيمة لا يرفع التكلفة — اختر «تصحيح تكلفة خاطئة» إن
                      كان رفعاً مقصوداً.
                    </p>
                  )}

                <div className="space-y-1">
                  <Label htmlFor="reval-reason">
                    سبب إعادة التقييم (10 محارف على الأقلّ)
                  </Label>
                  <Textarea
                    id="reval-reason"
                    value={revalReason}
                    onChange={(e) => setRevalReason(e.target.value)}
                    placeholder="مثال: أُدخلت تكلفة الكرتون بدل تكلفة القطعة عند الاستلام"
                    rows={3}
                  />
                </div>
              </>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setRevalFor(null)}
              disabled={requestRevalIsPending}
            >
              إلغاء
            </Button>
            <Button
              disabled={
                requestRevalIsPending || !revalCostOk || !revalReasonOk
              }
              onClick={onRequestReval}
            >
              <Scale aria-hidden className="size-4 ml-1" /> إرسال الطلب
              للاعتماد
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* رفض طلب إعادة التقييم — سببٌ إلزاميّ يظهر لمُنشئ الطلب. */}
      <Dialog
        open={revalRejectTarget != null}
        onOpenChange={(o) => {
          if (!o) setRevalRejectTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>رفض طلب إعادة التقييم</DialogTitle>
            <DialogDescription>
              اذكر سبب الرفض — يُسجَّل ويظهر لمُنشئ الطلب.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1 py-1">
            <Label htmlFor="reval-reject-reason">سبب الرفض</Label>
            <Textarea
              id="reval-reject-reason"
              value={revalRejectReason}
              onChange={(e) => setRevalRejectReason(e.target.value)}
              placeholder="مثال: التكلفة الحالية مطابقة لفاتورة المورّد"
              rows={3}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setRevalRejectTarget(null)}
              disabled={rejectRevalIsPending}
            >
              إلغاء
            </Button>
            <Button
              variant="destructive"
              disabled={rejectRevalIsPending || !revalRejectReason.trim()}
              onClick={onRejectReval}
            >
              <XCircle aria-hidden className="size-4 ml-1" /> رفض الطلب
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
