import { useState } from "react";
import { Loader2 } from "lucide-react";
import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { confirm } from "@/lib/confirm";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { INBOUND_METHOD_OPTIONS } from "@/lib/paymentMethod";
import { trpc } from "@/lib/trpc";
import type { InboundEnabledPaymentMethod } from "@shared/inboundPaymentPolicy";
import { FUNDING_META, fundingKindOf, type ExpenseRow } from "./expenseView";

/**
 * حوار تصحيح مصدر المصروف المستحق — استُخرج من Expenses.tsx بمنظومته الكاملة (حالة + استعلام
 * السجلّ + أربع طفرات + مشتقّات). المنطق المالي يبقى خادميّاً: التصحيح يلزمه دليلٌ واعتماد
 * مالكٍ آخر وإثباتُ استرداد فعليّ. المكوّن يعرض ويستدعي فقط.
 */
export function ExpenseCorrectionDialog({
  target,
  onClose,
}: {
  target: ExpenseRow | null;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const [correctionReason, setCorrectionReason] = useState("");
  const [correctionEvidence, setCorrectionEvidence] = useState("");
  const [correctionAttachment, setCorrectionAttachment] = useState<ImageItem[]>(
    [],
  );
  const [correctionRefundMethod, setCorrectionRefundMethod] =
    useState<InboundEnabledPaymentMethod>("CASH");
  const [correctionRefundBucket, setCorrectionRefundBucket] = useState<
    "DRAWER" | "TREASURY"
  >("TREASURY");
  const [correctionRefundReference, setCorrectionRefundReference] =
    useState("");
  const [correctionRefundCardTail, setCorrectionRefundCardTail] = useState("");
  const [correctionReviewReason, setCorrectionReviewReason] = useState("");
  const [correctionClientRequestId, setCorrectionClientRequestId] = useState(
    () => crypto.randomUUID(),
  );

  const correctionHistory = trpc.expenses.accrualCorrections.useQuery(
    { obligationId: Number(target?.accrualObligationId ?? 0) },
    { enabled: Number(target?.accrualObligationId ?? 0) > 0 },
  );

  const requestCorrection = trpc.expenses.requestAccrualCorrection.useMutation({
    onSuccess: async () => {
      notify.ok("سُجل طلب تصحيح المصدر بلا عكس أو قبض تلقائي");
      setCorrectionClientRequestId(crypto.randomUUID());
      setCorrectionReason("");
      setCorrectionEvidence("");
      setCorrectionAttachment([]);
      await Promise.all([
        utils.expenses.list.invalidate(),
        correctionHistory.refetch(),
      ]);
    },
    onError: (error) => notify.err(error),
  });
  const approveCorrection = trpc.expenses.approveAccrualCorrection.useMutation({
    onSuccess: async () => {
      notify.ok("اعتمد التصحيح وعُكس الاعتراف بقيد مستقل");
      await Promise.all([
        utils.expenses.list.invalidate(),
        correctionHistory.refetch(),
      ]);
    },
    onError: (error) => notify.err(error),
  });
  const rejectCorrection = trpc.expenses.rejectAccrualCorrection.useMutation({
    onSuccess: async () => {
      notify.ok("رُفض التصحيح وبقي الاستحقاق الأصلي قائماً");
      setCorrectionReviewReason("");
      await Promise.all([
        utils.expenses.list.invalidate(),
        correctionHistory.refetch(),
      ]);
    },
    onError: (error) => notify.err(error),
  });
  const retryCorrectionRefund =
    trpc.expenses.retryAccrualCorrectionRefund.useMutation({
      onSuccess: async () => {
        notify.ok("أُعيد تقديم طلب قبض الاسترداد، وينتظر اعتماد مالك آخر");
        setCorrectionClientRequestId(crypto.randomUUID());
        await Promise.all([
          utils.expenses.list.invalidate(),
          correctionHistory.refetch(),
        ]);
      },
      onError: (error) => notify.err(error),
    });

  const activeCorrection =
    correctionHistory.data?.find((item) => item.status === "PENDING") ?? null;
  const retryableRefundCorrection =
    correctionHistory.data?.find(
      (item) =>
        item.status === "REJECTED" && item.previousObligationStatus === "PAID",
    ) ?? null;
  const correctionRequiresRefund = target?.settlementStatus === "PAID";

  const busy =
    requestCorrection.isPending ||
    approveCorrection.isPending ||
    rejectCorrection.isPending ||
    retryCorrectionRefund.isPending;
  // إعادةُ ضبطٍ كاملةٌ عند الإغلاق: المكوّن دائمُ التركيب، فبلا هذا تتسرّب مسودّةُ مصروفٍ
  // إلى آخرَ (دليلٌ/سببٌ/مرفقٌ يُرسَل ضدّ التزامٍ خاطئ — مراجعة Codex على #1147).
  const handleClose = () => {
    onClose();
    setCorrectionReason("");
    setCorrectionEvidence("");
    setCorrectionAttachment([]);
    setCorrectionReviewReason("");
    setCorrectionRefundMethod("CASH");
    setCorrectionRefundBucket("TREASURY");
    setCorrectionRefundReference("");
    setCorrectionRefundCardTail("");
  };

  return (
    <Dialog
      open={target != null}
      onOpenChange={(open) => {
        if (!open && !busy) handleClose();
      }}
    >
      <DialogContent dir="rtl" className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>تصحيح مصدر المصروف المستحق</DialogTitle>
          <DialogDescription>
            التصحيح يحفظ المصروف الأصلي ويضيف طلباً وحدثاً وعكساً مستقلاً.
            المصروف المدفوع يتطلب استرداداً فعلياً موثقاً واعتماد مالك آخر.
          </DialogDescription>
        </DialogHeader>
        {target && (
          <div className="space-y-3">
            <div className="rounded-md border p-3 text-sm">
              <div className="font-medium">
                EXP#{Number(target.id)} · {fmt(target.amount)} د.ع
              </div>
              <div className="mt-1 text-muted-foreground">
                {target.accrualBeneficiaryName ??
                  target.payee ??
                  "مستفيد غير موثق"}{" "}
                · {FUNDING_META[fundingKindOf(target)].short}
              </div>
              <div className="mt-1 text-xs" dir="ltr">
                {target.accrualEvidenceReference ?? "—"}
              </div>
            </div>

            {correctionHistory.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 aria-hidden className="size-4 animate-spin" /> جارٍ
                تحميل سجل التصحيح…
              </div>
            ) : activeCorrection ? (
              <div className="space-y-3 rounded-md border badge-status-pending p-3 text-sm">
                <div className="font-medium">
                  طلب تصحيح #{activeCorrection.id} بانتظار الاعتماد
                </div>
                <p>{activeCorrection.reason}</p>
                <p className="text-xs" dir="ltr">
                  {activeCorrection.externalEvidenceReference}
                </p>
                {activeCorrection.previousObligationStatus === "PAID" ? (
                  <p>
                    أُنشئ طلب قبض استرداد معلّق بلا أثر نقدي. تتم المراجعة من
                    شاشة سندات القبض لمطابقة دليل المزود قبل أي قيد.
                  </p>
                ) : me.data?.isOwner === true &&
                  Number(activeCorrection.requestedBy) !==
                    Number(me.data.id) ? (
                  <div className="space-y-2 border-t pt-3">
                    <Label htmlFor="expense-correction-review-reason">
                      سبب الرفض عند الرفض
                    </Label>
                    <Input
                      id="expense-correction-review-reason"
                      value={correctionReviewReason}
                      onChange={(event) =>
                        setCorrectionReviewReason(event.target.value)
                      }
                      placeholder="يُترك فارغاً عند الاعتماد"
                    />
                    <div className="flex gap-2">
                      <Button
                        disabled={
                          approveCorrection.isPending ||
                          rejectCorrection.isPending
                        }
                        onClick={async () => {
                          if (
                            !(await confirm({
                              variant: "warning",
                              title: "اعتماد تصحيح المصدر",
                              description:
                                "سيُغلق المصدر التشغيلي ويُعكس قيد الاعتراف بقيد append-only مستقل.",
                              confirmText: "اعتماد التصحيح",
                            }))
                          )
                            return;
                          approveCorrection.mutate({
                            correctionRequestId: Number(activeCorrection.id),
                          });
                        }}
                      >
                        اعتماد التصحيح
                      </Button>
                      <Button
                        variant="destructive"
                        disabled={
                          correctionReviewReason.trim().length < 3 ||
                          approveCorrection.isPending ||
                          rejectCorrection.isPending
                        }
                        onClick={() =>
                          rejectCorrection.mutate({
                            correctionRequestId: Number(activeCorrection.id),
                            reason: correctionReviewReason.trim(),
                          })
                        }
                      >
                        رفض التصحيح
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="text-muted-foreground">
                    ينتظر مالكاً آخر؛ لا يستطيع منشئ الطلب اعتماده أو رفضه.
                  </p>
                )}
              </div>
            ) : retryableRefundCorrection ? (
              <div className="space-y-3 rounded-md border badge-status-rejected p-3 text-sm">
                <div className="font-medium">
                  رُفض طلب قبض الاسترداد المرتبط بالتصحيح #
                  {retryableRefundCorrection.id}
                </div>
                <p>
                  {retryableRefundCorrection.rejectionReason ??
                    "لم يُسجّل سبب الرفض."}
                </p>
                <p className="text-muted-foreground">
                  يحتفظ النظام بالطلب المرفوض وسلسلة التدقيق. يمكن لمنشئ طلب
                  التصحيح وحده إصدار طلب قبض بديل بمفتاح مستقل، ثم يعتمد مالك
                  آخر الطلب الجديد.
                </p>
                {Number(retryableRefundCorrection.requestedBy) ===
                Number(me.data?.id) ? (
                  <Button
                    disabled={retryCorrectionRefund.isPending}
                    onClick={() =>
                      retryCorrectionRefund.mutate({
                        correctionRequestId: Number(
                          retryableRefundCorrection.id,
                        ),
                        clientRequestId: correctionClientRequestId,
                      })
                    }
                  >
                    {retryCorrectionRefund.isPending ? (
                      <Loader2 aria-hidden className="size-4 animate-spin" />
                    ) : null}
                    إعادة تقديم طلب قبض الاسترداد
                  </Button>
                ) : (
                  <p className="text-muted-foreground">
                    إعادة التقديم محصورة بمنشئ طلب التصحيح الأصلي.
                  </p>
                )}
              </div>
            ) : (
              <>
                <div className="space-y-1">
                  <Label htmlFor="expense-correction-reason">
                    سبب التصحيح *
                  </Label>
                  <Textarea
                    id="expense-correction-reason"
                    rows={3}
                    value={correctionReason}
                    onChange={(event) => setCorrectionReason(event.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="expense-correction-evidence">
                    مرجع الدليل الخارجي *
                  </Label>
                  <Input
                    id="expense-correction-evidence"
                    dir="ltr"
                    value={correctionEvidence}
                    onChange={(event) =>
                      setCorrectionEvidence(event.target.value)
                    }
                  />
                </div>
                <ImageUploader
                  value={correctionAttachment}
                  onChange={setCorrectionAttachment}
                  maxItems={1}
                  singlePrimary={false}
                  hint="مرفق فاتورة التصحيح/الإشعار الدائن إلزامي."
                />
                {correctionRequiresRefund && (
                  <div className="space-y-3 rounded-md border p-3">
                    <p className="font-medium">دليل الاسترداد الفعلي</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label>الطريقة</Label>
                        <AppSelect
                          className="h-9"
                          value={correctionRefundMethod}
                          onValueChange={(value) =>
                            setCorrectionRefundMethod(
                              value as typeof correctionRefundMethod,
                            )
                          }
                        >
                          {/* مشتقّة من سياسة القبض المشتركة — «صك» كان معروضاً ويرفضه الخادم
                              في سند الاسترداد (`assertInboundPaymentMethodEnabled`) ⇒ صفر مسار نجاح. */}
                          {INBOUND_METHOD_OPTIONS.map((m) => (
                            <option key={m.v} value={m.v}>{m.label}</option>
                          ))}
                        </AppSelect>
                      </div>
                      {correctionRefundMethod === "CASH" ? (
                        <div className="space-y-1">
                          <Label>وجهة النقد</Label>
                          <AppSelect
                            className="h-9"
                            value={correctionRefundBucket}
                            onValueChange={(value) =>
                              setCorrectionRefundBucket(
                                value as typeof correctionRefundBucket,
                              )
                            }
                          >
                            <option value="TREASURY">الخزينة الإدارية</option>
                            <option value="DRAWER">درج الوردية</option>
                          </AppSelect>
                        </div>
                      ) : (
                        <div className="space-y-1">
                          <Label>مرجع مزود الاسترداد</Label>
                          <Input
                            dir="ltr"
                            value={correctionRefundReference}
                            onChange={(event) =>
                              setCorrectionRefundReference(event.target.value)
                            }
                          />
                        </div>
                      )}
                      {correctionRefundMethod === "CARD" && (
                        <div className="space-y-1">
                          <Label>آخر أربعة أرقام</Label>
                          <Input
                            dir="ltr"
                            maxLength={4}
                            value={correctionRefundCardTail}
                            onChange={(event) =>
                              setCorrectionRefundCardTail(
                                event.target.value
                                  .replace(/\D/g, "")
                                  .slice(0, 4),
                              )
                            }
                          />
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={busy}>
            إغلاق
          </Button>
          {!activeCorrection && !retryableRefundCorrection && target && (
            <Button
              variant="destructive"
              disabled={
                correctionHistory.isLoading ||
                requestCorrection.isPending ||
                correctionReason.trim().length < 3 ||
                !correctionEvidence.trim() ||
                !correctionAttachment[0]?.dataUrl ||
                (correctionRequiresRefund &&
                  correctionRefundMethod !== "CASH" &&
                  !correctionRefundReference.trim()) ||
                (correctionRequiresRefund &&
                  correctionRefundMethod === "CARD" &&
                  !/^\d{4}$/.test(correctionRefundCardTail))
              }
              onClick={() =>
                requestCorrection.mutate({
                  obligationId: Number(target.accrualObligationId),
                  reason: correctionReason.trim(),
                  externalEvidenceReference: correctionEvidence.trim(),
                  attachmentUrl: correctionAttachment[0]!.dataUrl,
                  refundPaymentMethod: correctionRequiresRefund
                    ? correctionRefundMethod
                    : null,
                  refundCashBucket:
                    correctionRequiresRefund &&
                    correctionRefundMethod === "CASH"
                      ? correctionRefundBucket
                      : null,
                  refundReferenceNumber:
                    correctionRequiresRefund &&
                    correctionRefundMethod !== "CASH"
                      ? correctionRefundReference.trim()
                      : null,
                  refundCardLastFour:
                    correctionRequiresRefund &&
                    correctionRefundMethod === "CARD"
                      ? correctionRefundCardTail
                      : null,
                  clientRequestId: correctionClientRequestId,
                })
              }
            >
              {requestCorrection.isPending ? (
                <Loader2 aria-hidden className="size-4 animate-spin" />
              ) : null}
              تسجيل طلب التصحيح
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
