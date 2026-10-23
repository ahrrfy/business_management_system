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
import { ACTION_LABELS } from "@shared/actionLabels";
import { nf } from "./ReviewDisplay";
type Review = RouterOutputs["stocktakes"]["review"];
type Row = Review["rows"][number];
type Target = { variantId: number; label: string } | null;
type Pending = { isPending: boolean };
import { variantDisplayName } from "@shared/variantDisplay";
import { RefreshCw } from "lucide-react";
interface Props {
  conflictRow: Row | undefined;
  setConflictFor: (value: number | null) => void;
  canOperation: (path: string) => boolean;
  resolveConflict: Pick<
    ReturnType<typeof trpc.stocktakes.resolveConflict.useMutation>,
    "mutate" | "isPending"
  >;
  isOperational: boolean;
  sessionId: number;
  openRecount: (row: Row) => void;
  reopenFor: Target;
  setReopenFor: (target: Target) => void;
  reopenReason: string;
  setReopenReason: (value: string) => void;
  submitReopen: () => void;
  reopenItemReview: Pending;
  recountFor: Target;
  setRecountFor: (target: Target) => void;
  recountReason: string;
  setRecountReason: (value: string) => void;
  submitRecount: () => void;
  requestRecount: Pending;
}
export function ReviewDecisionDialogs({
  conflictRow,
  setConflictFor,
  canOperation,
  resolveConflict,
  isOperational,
  sessionId,
  openRecount,
  reopenFor,
  setReopenFor,
  reopenReason,
  setReopenReason,
  submitReopen,
  reopenItemReview,
  recountFor,
  setRecountFor,
  recountReason,
  setRecountReason,
  submitRecount,
  requestRecount,
}: Props) {
  return (
    <>
      {/* حوار فصل تعارض العدَّين */}
      <Dialog
        open={conflictRow != null}
        onOpenChange={(o) => {
          if (!o) setConflictFor(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>الفصل في تعارض عدَّين</DialogTitle>
            <DialogDescription>
              {conflictRow && (
                <>
                  المنتج{" "}
                  <b className="text-foreground">
                    {variantDisplayName(conflictRow)}
                  </b>{" "}
                  عُدّ مرتين بكميتين مختلفتين. اعتمد أحد العدَّين أو اطلب عدّاً
                  ثالثاً حاسماً — العدّان يبقيان موثّقَين في السجلّ أياً كان
                  القرار.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {conflictRow?.conflict && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2 text-center text-sm">
                <div className="rounded-lg border bg-muted/40 p-3">
                  <p className="text-xs text-muted-foreground">
                    العدّ الأول — {conflictRow.conflict.by1}
                  </p>
                  <p
                    className="font-mono text-2xl font-bold tabular-nums"
                    dir="ltr"
                  >
                    {nf(conflictRow.conflict.qty1)}
                  </p>
                </div>
                <div className="rounded-lg border bg-muted/40 p-3">
                  <p className="text-xs text-muted-foreground">
                    العدّ التحقّقي — {conflictRow.conflict.by2}
                  </p>
                  <p
                    className="font-mono text-2xl font-bold tabular-nums"
                    dir="ltr"
                  >
                    {nf(conflictRow.conflict.qty2)}
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  disabled={
                    !canOperation("stocktakes.resolveConflict") ||
                    resolveConflict.isPending ||
                    !isOperational ||
                    !!conflictRow.reviewApproved
                  }
                  onClick={() =>
                    canOperation("stocktakes.resolveConflict") &&
                    resolveConflict.mutate({
                      sessionId,
                      variantId: conflictRow.variantId,
                      pick: "FIRST",
                    })
                  }
                >
                  اعتماد عدّ {conflictRow.conflict.by1}
                </Button>
                <Button
                  variant="outline"
                  disabled={
                    !canOperation("stocktakes.resolveConflict") ||
                    resolveConflict.isPending ||
                    !isOperational ||
                    !!conflictRow.reviewApproved
                  }
                  onClick={() =>
                    canOperation("stocktakes.resolveConflict") &&
                    resolveConflict.mutate({
                      sessionId,
                      variantId: conflictRow.variantId,
                      pick: "VERIFY",
                    })
                  }
                >
                  اعتماد عدّ {conflictRow.conflict.by2}
                </Button>
              </div>
              <Button
                variant="ghost"
                className="w-full text-violet-700"
                disabled={
                  !canOperation("stocktakes.requestRecount") ||
                  !isOperational ||
                  !!conflictRow.reviewApproved
                }
                onClick={() => {
                  const r = conflictRow;
                  setConflictFor(null);
                  openRecount(r);
                }}
              >
                <RefreshCw aria-hidden className="size-4" /> طلب عدّ ثالث حاسم
                (يمسح التعارض ويحلّ محلّ العدَّين)
              </Button>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConflictFor(null)}>
              إغلاق
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* حوار إلغاء الاعتماد المرحلي — لا تعديل صامت لصف سبق توقيعه */}
      <Dialog
        open={reopenFor != null}
        onOpenChange={(o) => {
          if (!o) setReopenFor(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>إلغاء الاعتماد المرحلي وإعادة الفتح</DialogTitle>
            <DialogDescription>
              سيعود المنتج <b className="text-foreground">{reopenFor?.label}</b>{" "}
              إلى قائمة المراجعة ويمكن بعدها تغيير القرار. لن يُنشأ طلب إعادة
              عدّ تلقائياً؛ استخدم «إعادة عدّ» إذا كانت الكمية نفسها موضع شك.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>سبب إعادة الفتح (إلزامي — محفوظ داخل معاملة الجرد)</Label>
            <Textarea
              rows={2}
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
              placeholder="مثال: اكتشاف مستند استلام يحتاج إعادة فحص القرار"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setReopenFor(null)}>
              إلغاء
            </Button>
            <Button
              variant="destructive"
              onClick={submitReopen}
              disabled={
                !canOperation("stocktakes.reopenItemReview") ||
                reopenItemReview.isPending
              }
            >
              {reopenItemReview.isPending
                ? "جارٍ إعادة الفتح…"
                : "إلغاء الاعتماد وإعادة الفتح"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* حوار طلب إعادة العدّ — سبب إلزامي */}
      <Dialog
        open={recountFor != null}
        onOpenChange={(o) => {
          if (!o) setRecountFor(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>طلب إعادة عدّ ثانية</DialogTitle>
            <DialogDescription>
              سيظهر المنتج{" "}
              <b className="text-foreground">{recountFor?.label}</b> كمهمة إعادة
              عدّ في شاشة العامل، دون كشف الرصيد الدفتري أو سبب الفرق له. عدّ
              الإعادة يحلّ محلّ العدّ الأول في الحساب.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>سبب الطلب (إلزامي — يُسجَّل في سجلّ التدقيق)</Label>
            <Textarea
              rows={2}
              value={recountReason}
              onChange={(e) => setRecountReason(e.target.value)}
              placeholder="مثال: فرق عالي القيمة — تأكيد العدّ"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRecountFor(null)}>
              إلغاء
            </Button>
            <Button
              onClick={submitRecount}
              disabled={
                !canOperation("stocktakes.requestRecount") ||
                requestRecount.isPending
              }
            >
              {requestRecount.isPending
                ? ACTION_LABELS.sending
                : "إرسال الطلب للعامل"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
