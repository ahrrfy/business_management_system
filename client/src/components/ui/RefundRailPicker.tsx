/**
 * **`<RefundRailPicker>` — منتقي روافد الردّ الموحَّد** (م٢ ق١٠، ٣/٩/٢٦).
 *
 * مكوّنٌ واحدٌ يُغلق «ثمانية سلوكيات في ثمانية مواضع»: يعرف الأبُ **نوعَ المستند ومعرّفَه**
 * فحسب، ويسأل هذا المنتقي راوترَ `refundRails.preflight` — والباقي كلُّه محسومٌ خادمياً
 * ومعروضٌ بلا تخمين.
 *
 * ⛔ **لا يُستهلَك في مسار ماليٍّ اليوم — بعدُ.** الاستعمالُ الحيّ يأتي في شريحةٍ لاحقة
 * (م٢ ق١٠ب) حين تُقلَب المستهلكاتُ الثمانية (كاشير، مسوّدة استقبال، إلغاء أمر شغل، عكس
 * تسليم، إرجاع إرسالية، مرتجع بيع…) إلى استعمال هذا المكوّن. الشريحةُ الحاليّة تبني الأنابيب
 * وتبرهنها بمسبار مرجعيّ في هذا الملفّ (`RefundRailPickerReferenceProbe`).
 *
 * ⭐ **الفارقُ عن `ApprovalRefundRailPicker`:**
 *  · هذا المكوّن **يقود الاستعلامَ** بنفسه (`useQuery` داخل المكوّن) — الأبُ يمرّر السياقَ فقط.
 *  · لا يقرأ حالةَ اعتمادٍ أو حمولةَ طلبٍ — يُعيد `RefundRailSelection` نظيفة.
 *  · صالحٌ لأنواع مستنداتٍ متعدّدة بلا شرطٍ محلّيّ (النوعُ هو المُدخل).
 *  · يُبقي `ApprovalRefundRailPicker` كما هو — تدفّقُ الاعتماد له حالةٌ خاصة (`changed`،
 *    مقارنةٌ بحمولةِ الطلب) لا مكان لها هنا. توحيدُها استخراجٌ يستحقّ شريحتَه.
 */
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRightLeft, Loader2, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fmtAr } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { RefundDrawerPicker, useRefundDrawer } from "@/components/workorder/RefundDrawerPicker";
import { ACTION_LABELS } from "@shared/actionLabels";
import type { RefundPreflight } from "@shared/refundPreflight";
import {
  CARD_REFERENCE_MAX_LENGTH,
  CARD_REFERENCE_MIN_LENGTH,
  REFUND_RAILS,
  REFUND_RAIL_HINT,
  REFUND_RAIL_LABEL,
  REFUND_SOURCE_DOC_LABEL,
  cardReferenceIsMissing,
  refundRailNeedsReference,
  refundRailNeedsShift,
  type RefundRail,
  type RefundRailContext,
  type RefundRailSelection,
} from "@shared/refundRails";

export interface RefundRailPickerProps {
  /**
   * **سياقُ الاستفتاء** — النوعُ والمعرّف يكفيان؛ المبلغُ يحسبه الخادم.
   *
   * تغيُّرُ السياق يُعيد استعلامَ التمهيد بلا تدخّل — استعمل نفس المكوّن لمستنداتٍ متعدّدة
   * (لوحةُ اعتماداتٍ متعدّدة الصفوف مثلاً) بلا إعادة تركيب.
   */
  context: RefundRailContext;
  /**
   * حين تُختار الرافدةُ ويكتمل شرطُها (درجٌ محدَّد لِـ`DRAWER`، مرجعٌ كافٍ لِـ`CARD`) يُنادى
   * هذا مع الاختيار كاملاً. **لا يُنادى قبل الاكتمال** — لا اختيارٌ نصف ماليّ.
   */
  onSelect: (selection: RefundRailSelection) => void;
  /**
   * إلغاءُ العملية — يُنادى حين يضغط الفاعلُ زرَّ «إلغاء». الأبُ يقرّر إغلاقَ الحوار.
   */
  onCancel?: () => void;
  /** حالةُ العملية الأمّ (مثلاً `mutation.isPending`) — لتعطيل الزرَّين عند التقدّم. */
  submitting?: boolean;
}

export function RefundRailPicker({ context, onSelect, onCancel, submitting = false }: RefundRailPickerProps) {
  const preflightQ = trpc.refundRails.preflight.useQuery(context, {
    // كلُّ فتحةٍ للحوار تُعيد الاستفتاء — الأرصدةُ حيّة وقد تتغيّر بين فتحتَين.
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  return (
    <RefundRailPickerView
      context={context}
      preflight={preflightQ.data ?? null}
      loading={preflightQ.isLoading || preflightQ.isFetching}
      error={preflightQ.isError ? preflightQ.error?.message ?? "" : null}
      onRetry={() => void preflightQ.refetch()}
      onSelect={onSelect}
      onCancel={onCancel}
      submitting={submitting}
    />
  );
}

/**
 * **صيغةُ العرضِ الخالصة** — بلا استعلام، ملائمةٌ للاختبار والقصص والاستعمال من محرّرٍ يملك
 * التمهيدَ سلفاً (مثلاً `ApprovalRefundRailPicker` مستقبلاً حين يوحَّد).
 */
export function RefundRailPickerView({
  context,
  preflight,
  loading,
  error,
  onRetry,
  onSelect,
  onCancel,
  submitting = false,
}: {
  context: RefundRailContext;
  preflight: RefundPreflight | null;
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
  onSelect: (selection: RefundRailSelection) => void;
  onCancel?: () => void;
  submitting?: boolean;
}) {
  const [rail, setRail] = useState<RefundRail>("DRAWER");
  const [cardReference, setCardReference] = useState("");
  const drawer = useRefundDrawer({
    preflight,
    emptyLabel: context.sourceDocType === "CONSIGNMENT_RETURN" ? "وردية مفتوحة" : "وردية استقبال",
  });

  const needsCash = preflight?.needsCashDrawer === true;
  const cardAllowed = preflight?.cardRefundAllowed === true;

  /**
   * الرافدُ المتاحُ الأوّل عند وصول التمهيد — لا نطلب اختياراً يدوياً افتراضياً. حين تكون
   * البطاقةُ ممنوعةً (حصصٌ نقديّة أو أمانةُ أجرة) نُبقي `DRAWER` كما كانت.
   */
  useEffect(() => {
    if (!preflight || !cardAllowed) return;
    // لا نُغيّر ما اختاره الفاعلُ يدوياً — التبديلُ إلى `CARD` قرارُه لا افتراض.
  }, [preflight, cardAllowed]);

  const availableRails = useMemo(
    () => REFUND_RAILS.filter((r) => (r === "CARD" ? cardAllowed : true)),
    [cardAllowed],
  );

  // ─── تشخيصُ اكتمال الاختيار — يُعرَض قبل الضغط لا بعده ───
  const blockReason = computeBlockReason({
    needsCash,
    rail,
    drawerBlockReason: drawer.blockReason,
    cardReference,
  });

  const handleConfirm = () => {
    if (!needsCash) {
      // لا نقد ⇒ لا اختيارَ ماديّ — نُعيد اختياراً صورياً بلا رقاقات (الأب لا يستعمله ماليّاً).
      onSelect({ rail: "DRAWER" });
      return;
    }
    if (blockReason) return;
    const selection: RefundRailSelection = { rail };
    if (refundRailNeedsShift(rail) && drawer.refundShiftId != null) {
      selection.refundShiftId = drawer.refundShiftId;
    }
    if (refundRailNeedsReference(rail)) {
      selection.cardReference = cardReference.trim();
    }
    onSelect(selection);
  };

  // ─── حالاتُ التحميل والخطأ — لا شاشةٌ فارغةٌ تُلبس المستخدمَ حائطاً ───
  if (loading && !preflight) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-md border p-6 text-xs text-muted-foreground">
        <Loader2 aria-hidden className="size-4 animate-spin" />
        <span>{ACTION_LABELS.loading}</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className="space-y-2 rounded-md border border-[var(--sem-danger)] bg-[var(--sem-danger-bg)] p-3 text-xs text-[var(--sem-danger)]">
        <p className="flex items-start gap-2 font-bold">
          <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>تعذّر تحميل بيانات ردّ المال — {error}</span>
        </p>
        <div className="flex gap-2">
          {onRetry ? (
            <Button size="sm" variant="outline" onClick={onRetry}>
              أعِد المحاولة
            </Button>
          ) : null}
          {onCancel ? (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              إلغاء
            </Button>
          ) : null}
        </div>
      </div>
    );
  }
  if (!preflight) return null;

  return (
    <div className="space-y-3 rounded-md border p-3">
      {/* ─── الرأس: كم يخرج ومن أيّ مستند ─── */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className="inline-flex items-center gap-1.5 text-xs font-bold">
          <Wallet aria-hidden className="size-3.5" />
          من أين يخرج المال؟
        </Label>
        <span className="text-2xs text-muted-foreground">
          {REFUND_SOURCE_DOC_LABEL[context.sourceDocType]}
          {needsCash ? (
            <>
              {" · المطلوب "}
              <span dir="ltr" className="font-bold tabular-nums">
                {fmtAr(preflight.estimatedCashOut)}
              </span>{" "}
              د.ع
            </>
          ) : null}
        </span>
      </div>

      {/* ─── لا نقد يخرج ⇒ الفاعلُ يعرف ذلك صراحةً ─── */}
      {!needsCash ? (
        <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          هذا المستند لا يُخرج نقداً — تابع العمليةَ من الحوار الأمّ.
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={handleConfirm} disabled={submitting}>
              متابعة
            </Button>
            {onCancel ? (
              <Button size="sm" variant="ghost" onClick={onCancel} disabled={submitting}>
                إلغاء
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <>
          {/* ─── رقائقُ الروافد — البطاقةُ تختفي حين يكون فيه جزءٌ نقديٌّ لا يقبلها ─── */}
          <div className="flex flex-wrap gap-1.5">
            {availableRails.map((r) => {
              const fits =
                r === "TREASURY"
                  ? preflight.treasurySufficient
                  : r === "DRAWER"
                    ? preflight.drawers.some((d) => d.sufficient)
                    : true;
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRail(r)}
                  disabled={submitting}
                  className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-2xs font-bold transition-colors ${
                    rail === r
                      ? "border-transparent bg-primary text-primary-foreground"
                      : "hover:bg-muted"
                  }`}
                >
                  <ArrowRightLeft aria-hidden className="size-3" />
                  {REFUND_RAIL_LABEL[r]}
                  {fits === false ? " — قد لا يكفي" : ""}
                </button>
              );
            })}
          </div>
          <p className="text-2xs text-muted-foreground">{REFUND_RAIL_HINT[rail]}</p>

          {/* ─── منتقي الدرج — يظهر لِـDRAWER وحده ─── */}
          {refundRailNeedsShift(rail) && (
            <div className="space-y-1">
              <Label className="text-2xs font-bold">درج ردّ النقد</Label>
              <RefundDrawerPicker
                state={drawer}
                needed
                hint="النقدُ يخرج فوراً من الدرج المختار — تأكّد أنّه المناسب."
              />
            </div>
          )}

          {/* ─── رصيد الخزينة إن أُبيح — رقمٌ إعلاميّ لمالك `treasury:READ` ─── */}
          {rail === "TREASURY" && preflight.treasuryCash != null && (
            <p className="text-2xs text-muted-foreground">
              نقدُ الخزينة المتاح:{" "}
              <span dir="ltr" className="font-bold tabular-nums">
                {fmtAr(preflight.treasuryCash)}
              </span>{" "}
              د.ع
            </p>
          )}

          {/* ─── مرجع البطاقة — لِـCARD وحده ─── */}
          {refundRailNeedsReference(rail) && (
            <div className="space-y-1">
              <Label htmlFor={`refund-rail-card-ref-${context.sourceDocType}-${context.sourceDocId}`} className="text-2xs font-bold">
                مرجع تنفيذ الاسترداد على جهاز الدفع
              </Label>
              <Input
                id={`refund-rail-card-ref-${context.sourceDocType}-${context.sourceDocId}`}
                value={cardReference}
                onChange={(e) => setCardReference(e.target.value)}
                maxLength={CARD_REFERENCE_MAX_LENGTH}
                minLength={CARD_REFERENCE_MIN_LENGTH}
                placeholder="رقم عملية الاسترداد على جهاز الدفع"
                className="text-sm"
                disabled={submitting}
              />
            </div>
          )}

          {/* ─── سببُ التعطيل — يُقال قبل الضغط لا بعده ─── */}
          {blockReason ? (
            <p className="flex items-start gap-2 rounded-md bg-[var(--sem-warn-bg)] px-2.5 py-2 text-2xs font-bold text-[var(--sem-warn)]">
              <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span>{blockReason}</span>
            </p>
          ) : null}

          <div className="flex gap-2 pt-1">
            <Button size="sm" onClick={handleConfirm} disabled={submitting || blockReason != null}>
              تأكيدُ رافد الردّ
            </Button>
            {onCancel ? (
              <Button size="sm" variant="ghost" onClick={onCancel} disabled={submitting}>
                إلغاء
              </Button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * **تشخيصُ الاكتمال** — «ماذا حدث · لماذا · ماذا تفعل الآن» (§٥). خارجيٌّ ليَختبَره الاختبار.
 */
export function computeBlockReason(args: {
  needsCash: boolean;
  rail: RefundRail;
  drawerBlockReason: string | null;
  cardReference: string;
}): string | null {
  if (!args.needsCash) return null;
  if (refundRailNeedsShift(args.rail)) return args.drawerBlockReason;
  if (cardReferenceIsMissing(args.rail, args.cardReference)) {
    return "أدخِل مرجع تنفيذ الاسترداد من جهاز الدفع (٣ محارف على الأقل).";
  }
  return null;
}

/**
 * ══════════════════════ مسبارٌ مرجعيٌّ — دليلُ نجاح الشريحة ══════════════════════
 *
 * استعمالٌ نموذجيّ من داخل حوار «إلغاء طلب خدمة». لا يُستعمَل في أيّ شاشةٍ إنتاجيّة بعد
 * (شريحةُ التوصيل م٢ ق١٠ب)، لكنّه تركيبٌ حقيقيٌّ يُبرهن أنّ الأنبوب كاملٌ من الشاشة إلى
 * الخدمة والعودة:
 *
 * ```tsx
 * import { RefundRailPicker } from "@/components/ui/RefundRailPicker";
 * import type { RefundRailSelection } from "@shared/refundRails";
 *
 * function ExampleCancelDialog({ workOrderId }: { workOrderId: number }) {
 *   const [rail, setRail] = useState<RefundRailSelection | null>(null);
 *   return (
 *     <RefundRailPicker
 *       context={{ sourceDocType: "WORKORDER_CANCEL", sourceDocId: workOrderId }}
 *       onSelect={setRail}
 *       onCancel={() => setRail(null)}
 *     />
 *   );
 * }
 * ```
 */
