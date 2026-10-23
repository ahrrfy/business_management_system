import { AlertTriangle, Clock, Info } from "lucide-react";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { fmt } from "@/lib/money";
import { ACTION_LABELS } from "@shared/actionLabels";
import type { ReturnComposerModel } from "./useReturnComposer";
type Props = Pick<
  ReturnComposerModel,
  | "approvingRequestId"
  | "requestDetail"
  | "pending"
  | "canWithdrawPending"
  | "withdrawPending"
  | "withdrawing"
  | "create"
  | "approve"
  | "detail"
  | "isLocked"
> & { inv: NonNullable<ReturnComposerModel["inv"]> };
export function ReturnComposerStatusBanners({
  approvingRequestId,
  requestDetail,
  pending,
  canWithdrawPending,
  withdrawPending,
  withdrawing,
  create,
  approve,
  detail,
  isLocked,
  inv,
}: Props) {
  return (
    <>
      {" "}
      {approvingRequestId && requestDetail.data && (
        <Card className="border-[var(--sem-info)]/45 bg-[var(--sem-info-bg)]/35">
          <CardContent className="flex items-start gap-2 p-3 text-xs">
            <Info
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-[var(--sem-info)]"
            />
            <div className="space-y-0.5">
              <p className="font-bold text-[var(--sem-info)]">
                مراجعة طلب الإرجاع #{requestDetail.data.id} — البنود والكميات
                والسبب مقفلة من الطلب الأصلي.
              </p>
              <p className="text-muted-foreground">
                طلبه{" "}
                {requestDetail.data.createdByName ??
                  `المستخدم ${requestDetail.data.createdBy}`}
                ؛ السبب: {requestDetail.data.reason}.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
      {/* الطلب المعلق إن وجد */}
      {pending && !approvingRequestId && (
        <Card className="border-[var(--sem-warn)]/50 bg-[var(--sem-warn-bg)]/30">
          <CardContent className="flex items-start gap-2 p-3 text-xs">
            <Clock
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-[var(--sem-warn)]"
            />
            <div className="space-y-1">
              <p className="font-bold text-[var(--sem-warn)]">
                على هذه الفاتورة طلبٌ معلّق #{pending.id} بانتظار مراجعٍ مستقل —
                لم يتغيّر المخزون ولا المال بعد.
              </p>
              <p className="text-muted-foreground">
                طلبه{" "}
                {pending.requestedByName ?? `المستخدم ${pending.requestedBy}`}
                {pending.isMine ? " (أنت)" : ""}؛ السبب: {pending.reason}.
              </p>
              <p className="text-muted-foreground">
                {pending.isMine
                  ? "اسحب طلبك السابق صراحةً لإعادة إعداد المرتجع. السحب لا ينفّذ المرتجع ولا يصرف مالاً."
                  : "يبقى الطلب محفوظاً لصاحبه ومراجعه؛ لا يُستبدل تلقائياً بمرتجع آخر."}
              </p>
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {canWithdrawPending && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void withdrawPending()}
                    disabled={
                      withdrawing || create.isPending || approve.isPending
                    }
                  >
                    {withdrawing
                      ? ACTION_LABELS.sending
                      : "سحب طلبي وإعادة إعداد المرتجع"}
                  </Button>
                )}
                {pending.canReviewIt && (
                  <Button asChild type="button" size="sm" variant="outline">
                    <Link
                      href={
                        pending.source === "CONTROL"
                          ? "/invoices?tab=controls"
                          : `/returns?requestId=${pending.id}`
                      }
                    >
                      مراجعة الطلب
                    </Link>
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => void detail.refetch()}
                  disabled={detail.isFetching}
                >
                  {ACTION_LABELS.refresh}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
      {isLocked && (
        <Card className="border-[var(--sem-warn)]/50 bg-[var(--sem-warn-bg)]/30">
          <CardContent className="flex items-start gap-2 p-3 text-xs">
            <AlertTriangle
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-[var(--sem-warn)]"
            />
            <div className="space-y-0.5">
              <p className="font-bold text-[var(--sem-warn)]">
                {inv.status === "RETURNED"
                  ? "هذه الفاتورة تم استرجاعها بالكامل مسبقاً — لا يمكن تسجيل أي مرتجع جديد عليها."
                  : "هذه الفاتورة ملغاة مسبقاً — لا يمكن تسجيل أي مرتجع جديد عليها."}
              </p>
              <p className="text-xs text-muted-foreground">
                إجمالي ما أُرجع: {fmt(inv.returnedTotal ?? "0")} د.ع من أصل{" "}
                {fmt(inv.total)} د.ع.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}
