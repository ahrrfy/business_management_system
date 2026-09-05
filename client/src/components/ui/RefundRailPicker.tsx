/**
 * **`<RefundRailPicker>` — منتقي روافد الردّ الموحَّد** (م٢ ق١٠، ٣/٩/٢٦ — عُمِّم في م٢ ذيل ٥/٩/٢٦).
 *
 * مكوّنٌ واحدٌ يُغلق «ثمانية سلوكيات في ثمانية مواضع»: يعرف الأبُ **نوعَ المستند ومعرّفَه**
 * فحسب، ويسأل هذا المنتقي راوترَ `refundRails.preflight` — والباقي كلُّه محسومٌ خادمياً
 * ومعروضٌ بلا تخمين:
 *  ① هل يخرج نقد؟ ② كم؟ ③ أيُّ الأدراج/الخزينة تكفي؟ ④ **أيُّ الروافد يقبله الفعلُ أصلاً ولِمَ لا**
 *  (`rails`) — الرافدُ غيرُ المتاح يظهر بسببه لا يُخفى صامتاً: كانت «الخزينة» رقاقةً معروضةً
 *  لعكس التسليم وإرجاع الإرسالية بينما فعلُهما لا يقبلها (نهاية مسدودة بثوبٍ جديد).
 *
 * **وضعان:**
 *  · `standalone` — بزرَّي تأكيد/إلغاء، يُسلّم الاختيارَ عبر `onSelect` حين يكتمل.
 *  · `embedded` — **داخل حوارٍ له زرُّه** (إلغاء أمر شغل · إرجاع إرسالية · عكس تسليم · مرتجع):
 *    بلا أزرار، ويُبلّغ الأبَ بكلّ تغيّرٍ عبر `onStateChange` (الاختيارُ + سببُ الحجب + التمهيد)
 *    فيقرأها زرُّ الأب ويُعطَّل بسببٍ مقروء. وهذا ما يُغلق «رقمُ ورديةٍ يُكتَب يدوياً».
 *
 * ⭐ **الفارقُ عن `ApprovalRefundRailPicker`:** هذا المكوّن يقود الاستعلامَ بنفسه أو يقبل تمهيداً
 * جاهزاً (`RefundRailPickerView` لمسار الاعتماد الذي يملك تمهيدَه من `controlPreflight`)، ولا
 * يقرأ حالةَ اعتماد — يُعيد `RefundRailSelection` نظيفة. تدفّقُ الاعتماد له حالتُه (`changed`)
 * في مكوّنه، وتوحيدُهما استخراجٌ يستحقّ شريحتَه.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, ArrowRightLeft, ExternalLink, Loader2, Wallet } from "lucide-react";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fmtAr } from "@/lib/money";
import {
  drawerShortfallWarning,
  pickDefaultRefundDrawer,
  refundDrawerBlockReason,
  type RefundDrawerOption,
} from "@/lib/refundDrawer";
import { trpc } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";
import type { RefundPreflight } from "@shared/refundPreflight";
import {
  CARD_REFERENCE_MAX_LENGTH,
  CARD_REFERENCE_MIN_LENGTH,
  REFUND_RAILS,
  REFUND_RAIL_HINT,
  REFUND_RAIL_LABEL,
  REFUND_SOURCE_DOC_LABEL,
  availableRefundRails,
  cardReferenceIsMissing,
  refundRailAvailability,
  refundRailNeedsReference,
  refundRailNeedsShift,
  type RefundRail,
  type RefundRailAvailabilityMap,
  type RefundRailContext,
  type RefundRailPreflightResult,
  type RefundRailSelection,
} from "@shared/refundRails";


// ═══════════════════ منتقي الدرج — الحقلُ الذي كانت رسالةُ الخادم تطلبه ولا وجودَ له ═══════════════════
//
// كان مكوّناً مستقلاً في `components/workorder/RefundDrawerPicker.tsx` تستورده أربعةُ حوارات كلٌّ
// بسلوكه؛ صار جزءاً من المنتقي الموحَّد وحده (م٢ ق١٠ب): الشاشةُ لا ترى درجاً إلّا من هنا.
//
// **مبدأُ التصميم (نصّ المالك ٣١/٨): «لا يتوقّف المعالِج بحائطٍ دون إنهاء العملية.»** فلكلّ فرعٍ مخرجٌ معلَن:
//  · تعدّدُ الأدراج ⇒ منتقٍ **يُظهر نقدَ كلّ درج** فلا يُختار درجٌ لا يكفي.
//  · انعدامُ الأدراج ⇒ رابطٌ مباشر لفتح وردية (لا «تعذّر» صمّاء).
//  · عجزُ الدرج المختار ⇒ **تحذيرٌ لا حجب** + بديلان مذكوران (درجٌ آخر / تمويلٌ من الخزينة).
// المنطقُ الخالص في [`lib/refundDrawer`](../../lib/refundDrawer.ts) ومُختبَرٌ وحدَه.

export interface UseRefundDrawerArgs {
  /**
   * تمهيدُ الخادم — **مصدرُ الحقيقة الوحيد**. `null` ⇒ لم يصل بعد (لا حجب، لا وعد).
   * ⛔ لا تُشتقّ الحاجةُ ولا المبلغُ ولا الأدراج في الشاشة (`shared/refundPreflight.ts`).
   */
  preflight: RefundPreflight | null;
  /** وصفُ الدرج في رسالة «لا يوجد» — مثلاً «وردية استقبال». */
  emptyLabel: string;
}

export interface RefundDrawerState {
  /** يُمرَّر كـ`refundShiftId` — `undefined` حين لا نقدَ يخرج. */
  refundShiftId: number | undefined;
  /** سببُ الحجب المقروء، أو `null` حين يجوز الإرسال. */
  blockReason: string | null;
  /** عجزٌ متوقَّع في الدرج المختار — تحذيرٌ فقط. */
  shortfall: ReturnType<typeof drawerShortfallWarning>;
  drawers: RefundDrawerOption[];
  setRefundShiftId: (id: number | null) => void;
  /** أعِد الحالة للافتراض عند فتح الحوار من جديد. */
  reset: () => void;
}

/** حالةُ درج الاسترداد + الافتراضُ التلقائيّ (درجُ المنفِّذ إن كان مفتوحاً، وإلّا الوحيدُ المفتوح). */
export function useRefundDrawer(args: UseRefundDrawerArgs): RefundDrawerState {
  const { preflight, emptyLabel } = args;
  const [refundShiftId, setRefundShiftId] = useState<number | null>(null);

  const needed = preflight?.needsCashDrawer === true;
  const me = trpc.auth.me.useQuery(undefined, { enabled: needed });
  // الأدراجُ تأتي مُصفّاةً بالفرع والنوع من الخادم — لا تصفيةَ ولا استعلامَ خزينةٍ هنا.
  const drawers = preflight?.drawers ?? [];

  // الافتراضُ يُعاد تقييمه كلّما تغيّرت القائمة (تحميلٌ أوّل، أو إغلاقُ درجٍ أثناء الفتح).
  useEffect(() => {
    if (!needed || refundShiftId != null || drawers.length === 0) return;
    const preset = pickDefaultRefundDrawer(drawers, me.data?.id);
    if (preset != null) setRefundShiftId(preset);
  }, [needed, refundShiftId, drawers, me.data?.id]);

  return {
    refundShiftId: needed ? refundShiftId ?? undefined : undefined,
    blockReason: refundDrawerBlockReason({ needed, drawers, selectedShiftId: refundShiftId, emptyLabel }),
    shortfall: drawerShortfallWarning({ drawers, selectedShiftId: refundShiftId, estimatedAmount: preflight?.estimatedCashOut ?? null }),
    drawers,
    setRefundShiftId,
    reset: () => setRefundShiftId(null),
  };
}

/**
 * حقلُ الدرج — يظهر حين يخرج نقدٌ **ويتعدّد** الدرج، أو حين لا درجَ أصلاً، أو حين لا يكفي
 * الدرجُ الوحيد. درجٌ واحدٌ كافٍ مُختارٌ تلقائياً لا يستحقّ حقلاً يُربك الموظّف.
 */
export function RefundDrawerField({
  state,
  hint,
  disabled = false,
}: {
  state: RefundDrawerState;
  /** جملةٌ تشرح **لماذا** يخرج نقدٌ الآن. */
  hint?: string;
  disabled?: boolean;
}) {
  const { drawers, refundShiftId, setRefundShiftId, shortfall } = state;

  // لا درجَ مفتوح — المخرجُ رابطٌ مباشر، لا رسالةٌ صمّاء تُوقف المعالِج.
  if (drawers.length === 0) {
    return (
      <div className="space-y-2 rounded-md border border-[var(--sem-warn)] bg-[var(--sem-warn-bg)] px-2.5 py-2 text-xs text-[var(--sem-warn)]">
        <p className="flex items-start gap-2 font-bold">
          <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>{state.blockReason}</span>
        </p>
        <Link
          href="/treasury?tab=shifts"
          className="inline-flex items-center gap-1 font-bold underline underline-offset-2"
        >
          <ExternalLink aria-hidden className="size-3" />
          افتح وردية من الخزينة
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {drawers.length > 1 && (
        <>
          <Label className="text-[11px] font-bold text-[var(--sem-warn)]">
            أكثر من درجٍ مفتوح — من أيّ درجٍ يخرج النقد؟
          </Label>
          {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
          <AppSelect
            size="sm"
            className="text-xs font-bold"
            aria-label="درج الاسترداد النقدي"
            value={refundShiftId != null ? String(refundShiftId) : ""}
            onValueChange={(v) => setRefundShiftId(v ? Number(v) : null)}
            placeholder="اختر الدرج…"
            disabled={disabled}
          >
            <option value="">اختر الدرج…</option>
            {drawers.map((sh) => (
              <option key={sh.shiftId} value={String(sh.shiftId)}>
                {sh.userName} — وردية #{sh.shiftId}
                {sh.expectedCash != null ? ` · نقدٌ متاح ${fmtAr(sh.expectedCash)} د.ع` : ""}
              </option>
            ))}
          </AppSelect>
        </>
      )}

      {/* عجزٌ متوقَّع — يُقال قبل الضغط مع بديلَيه، ولا يحجب (الخادم هو الحَكَم). */}
      {shortfall && (
        <p className="flex items-start gap-2 rounded-md bg-[var(--sem-warn-bg)] px-2.5 py-2 text-[11px] font-bold text-[var(--sem-warn)]">
          <Wallet aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>
            الدرج المختار يحمل{" "}
            <span dir="ltr" className="tabular-nums">{fmtAr(shortfall.availableCash)}</span> د.ع
            والمطلوب نحو{" "}
            <span dir="ltr" className="tabular-nums">{fmtAr(shortfall.needed)}</span> د.ع —
            {drawers.length > 1 ? " اختر درجاً أوسع، أو" : ""} موّل الدرج من الخزينة قبل التأكيد.
          </span>
        </p>
      )}
    </div>
  );
}

/** ما يُبلَّغ به الأبُ في الوضع المضمَّن — كلُّ ما يحتاجه زرُّه ليقرّر ويقول لِمَ. */
export interface RefundRailPickerState {
  preflight: RefundRailPreflightResult | null;
  loading: boolean;
  error: string | null;
  /** هل يخرج نقدٌ أصلاً؟ (`false` ⇒ الاختيارُ صوريّ ولا حجب). */
  needsCash: boolean;
  /** الاختيارُ المكتمل، أو `null` حين يحجبه `blockReason`. */
  selection: RefundRailSelection | null;
  /** سببُ الحجب المقروء — يُعرَض بجانب زرّ الأب. */
  blockReason: string | null;
}

export interface RefundRailPickerProps {
  /**
   * **سياقُ الاستفتاء** — النوعُ والمعرّف (والمبلغُ لمرتجع البيع). تغيُّرُه يُعيد الاستعلام.
   */
  context: RefundRailContext;
  mode?: "standalone" | "embedded";
  /** الوضعُ المستقلّ: يُنادى مع الاختيار كاملاً عند التأكيد. **لا يُنادى قبل الاكتمال.** */
  onSelect?: (selection: RefundRailSelection) => void;
  onCancel?: () => void;
  /** الوضعُ المضمَّن: يُنادى مع كلّ تغيّر — الأبُ يقرأ منه الاختيارَ وسببَ الحجب. */
  onStateChange?: (state: RefundRailPickerState) => void;
  /** اختيارٌ ابتدائيّ (استعادةُ محاولةٍ محفوظة) — يُطبَّق مرّةً عند وصول التمهيد. */
  initialSelection?: RefundRailSelection | null;
  /** تسميةُ حقل الدرج — الافتراض «درج ردّ النقد». */
  drawerLabel?: string;
  /** جملةٌ تحت منتقي الدرج تشرح لماذا يخرج النقد الآن. */
  drawerHint?: string;
  /** حالةُ العملية الأمّ (مثلاً `mutation.isPending`) — لتعطيل الأزرار عند التقدّم. */
  submitting?: boolean;
}

export function RefundRailPicker({ context, ...rest }: RefundRailPickerProps) {
  const preflightQ = trpc.refundRails.preflight.useQuery(context, {
    // كلُّ فتحةٍ للحوار تُعيد الاستفتاء — الأرصدةُ حيّة وقد تتغيّر بين فتحتَين.
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  return (
    <RefundRailPickerView
      context={context}
      preflight={(preflightQ.data as RefundRailPreflightResult | undefined) ?? null}
      loading={preflightQ.isLoading || preflightQ.isFetching}
      error={preflightQ.isError ? preflightQ.error?.message ?? "" : null}
      onRetry={() => void preflightQ.refetch()}
      {...rest}
    />
  );
}

/**
 * يُكمل تمهيداً بلا خريطة روافد (مسارُ الاعتماد يمرّر تمهيدَ `controlPreflight`) بالدالّة
 * النقيّة المشتركة نفسها التي يستعملها الخادم — لا تعريفٌ ثانٍ ينجرف.
 */
export function withRailAvailability(
  sourceDocType: RefundRailContext["sourceDocType"],
  preflight: RefundPreflight | RefundRailPreflightResult | null,
  actorMayUseTreasury = true,
): RefundRailPreflightResult | null {
  if (!preflight) return null;
  if ("rails" in preflight && preflight.rails) return preflight as RefundRailPreflightResult;
  return { ...preflight, rails: refundRailAvailability(sourceDocType, preflight, actorMayUseTreasury) };
}

/**
 * **صيغةُ العرضِ الخالصة** — بلا استعلام، ملائمةٌ للاختبار وللمسار الذي يملك التمهيدَ سلفاً.
 */
export function RefundRailPickerView({
  context,
  preflight: rawPreflight,
  loading,
  error,
  onRetry,
  mode = "standalone",
  onSelect,
  onCancel,
  onStateChange,
  initialSelection,
  drawerLabel = "درج ردّ النقد",
  drawerHint,
  submitting = false,
}: RefundRailPickerProps & {
  preflight: RefundPreflight | RefundRailPreflightResult | null;
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
}) {
  const preflight = useMemo(() => withRailAvailability(context.sourceDocType, rawPreflight), [context.sourceDocType, rawPreflight]);
  const rails: RefundRailAvailabilityMap | null = preflight?.rails ?? null;
  const available = useMemo(() => (rails ? availableRefundRails(rails) : []), [rails]);
  const [rail, setRail] = useState<RefundRail>("DRAWER");
  const [cardReference, setCardReference] = useState("");
  const drawer = useRefundDrawer({
    preflight,
    emptyLabel: context.sourceDocType === "CONSIGNMENT_RETURN" || context.sourceDocType === "SALE_RETURN" ? "وردية مفتوحة" : "وردية استقبال",
  });

  // Codex #960: يُعاد ضبطُ الاختيار عند تبدّل المستند — المنتقي مصمَّمٌ للاستمرار بلا remount.
  const seededRef = useRef<string | null>(null);
  useEffect(() => {
    setRail("DRAWER");
    setCardReference("");
    drawer.reset();
    seededRef.current = null;
    // `drawer` مرجعُ hook متغيّر كلّ render — الرسالةُ الحاكمة هي تبدّلُ هويّة المستند.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.sourceDocType, context.sourceDocId]);

  const needsCash = preflight?.needsCashDrawer === true;

  /**
   * الافتراضُ عند وصول التمهيد (مرّةً لكلّ مستند): الاختيارُ الابتدائيّ إن كان متاحاً، وإلّا
   * أوّلُ رافدٍ متاح؛ وحين لا يكفي أيُّ درجٍ وتكفي الخزينةُ المتاحة نبدأ عليها (بلاغ المالك ١/٩).
   * بعدها لا تُطمَس نقرةُ الموظّف اليدويّة — الكفايةُ إرشادٌ لا حجب (الخادم هو الحَكَم).
   */
  useEffect(() => {
    if (!preflight || !needsCash || !rails) return;
    const key = `${context.sourceDocType}:${context.sourceDocId}`;
    if (seededRef.current === key) return;
    seededRef.current = key;
    const initial = initialSelection?.rail && rails[initialSelection.rail].available ? initialSelection.rail : null;
    let next: RefundRail | null = initial ?? available[0] ?? null;
    // درجٌ لا يكفي (سواءٌ اقترحه الطالبُ ساعةَ الطلب أم كان الافتراض) وتكفي الخزينةُ المتاحة ⇒ نبدأ
    // عليها (بلاغ المالك ١/٩ + مراجعة Codex P1 على #930: «جوهر الإصلاح» في مسار الاعتماد).
    if (next === "DRAWER") {
      const anyDrawerFits = preflight.drawers.some((d) => d.sufficient);
      if (!anyDrawerFits && rails.TREASURY.available && preflight.treasurySufficient) next = "TREASURY";
    }
    if (next) setRail(next);
    if (initialSelection?.cardReference) setCardReference(initialSelection.cardReference);
    if (initialSelection?.refundShiftId != null && preflight.drawers.some((d) => d.shiftId === initialSelection.refundShiftId)) {
      drawer.setRefundShiftId(initialSelection.refundShiftId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preflight, needsCash, rails, available, context.sourceDocType, context.sourceDocId, initialSelection]);

  // ─── تشخيصُ اكتمال الاختيار — يُعرَض قبل الضغط لا بعده ───
  const blockReason = computeBlockReason({
    needsCash,
    rail,
    rails,
    drawerBlockReason: drawer.blockReason,
    cardReference,
  });

  const selection: RefundRailSelection | null = useMemo(() => {
    if (!preflight) return null;
    if (!needsCash) return { rail: "DRAWER" };
    if (blockReason) return null;
    const out: RefundRailSelection = { rail };
    if (refundRailNeedsShift(rail) && drawer.refundShiftId != null) out.refundShiftId = drawer.refundShiftId;
    if (refundRailNeedsReference(rail)) out.cardReference = cardReference.trim();
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preflight, needsCash, blockReason, rail, drawer.refundShiftId, cardReference]);

  // ─── الوضعُ المضمَّن: الأبُ يعرف كلَّ شيءٍ لحظياً ───
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  useEffect(() => {
    onStateChangeRef.current?.({
      preflight,
      loading,
      error,
      needsCash,
      selection,
      blockReason: preflight && !loading && !error ? blockReason : null,
    });
  }, [preflight, loading, error, needsCash, selection, blockReason]);

  const handleConfirm = () => {
    if (!selection) return;
    onSelect?.(selection);
  };

  // ─── حالاتُ التحميل والخطأ — لا شاشةٌ فارغةٌ تُلبس المستخدمَ حائطاً ───
  if (loading && !preflight) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-md border p-4 text-xs text-muted-foreground">
        <Loader2 aria-hidden className="size-4 animate-spin" />
        <span>{ACTION_LABELS.loading}</span>
      </div>
    );
  }
  if (error) {
    return (
      <div role="alert" className="space-y-2 rounded-md border border-[var(--sem-danger)] bg-[var(--sem-danger-bg)] p-3 text-xs text-[var(--sem-danger)]">
        <p className="flex items-start gap-2 font-bold">
          <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>تعذّر تحميل بيانات ردّ المال — {error}</span>
        </p>
        <div className="flex gap-2">
          {onRetry ? (
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>
              أعِد المحاولة
            </Button>
          ) : null}
          {mode === "standalone" && onCancel ? (
            <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
              إلغاء
            </Button>
          ) : null}
        </div>
      </div>
    );
  }
  if (!preflight || !rails) return null;

  const unavailable = REFUND_RAILS.filter((r) => !rails[r].available);

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
          هذا المستند لا يُخرج نقداً — {mode === "embedded" ? "تابع من زرّ الحوار." : "تابع العمليةَ من الحوار الأمّ."}
          {mode === "standalone" ? (
            <div className="mt-2 flex gap-2">
              <Button type="button" size="sm" onClick={handleConfirm} disabled={submitting}>
                متابعة
              </Button>
              {onCancel ? (
                <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={submitting}>
                  إلغاء
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <>
          {/* ─── رقائقُ الروافد المتاحة — «قد لا يكفي» إرشادٌ لا حجب ─── */}
          {available.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {available.map((r) => {
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
                    aria-pressed={rail === r}
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
          ) : null}
          {available.includes(rail) ? (
            <p className="text-2xs text-muted-foreground">{REFUND_RAIL_HINT[rail]}</p>
          ) : null}

          {/* ─── الروافدُ غيرُ المتاحة تُذكَر بسببها — لا تُخفى صامتةً ─── */}
          {unavailable.length > 0 ? (
            <ul className="space-y-0.5 text-2xs text-muted-foreground">
              {unavailable.map((r) => (
                <li key={r} className="flex items-start gap-1.5">
                  <AlertTriangle aria-hidden className="mt-0.5 size-3 shrink-0" />
                  <span>
                    <span className="font-bold">{REFUND_RAIL_LABEL[r]}</span>: {rails[r].reason}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {/* ─── منتقي الدرج — يظهر لِـDRAWER وحده ─── */}
          {available.includes(rail) && refundRailNeedsShift(rail) && (
            <div className="space-y-1">
              <Label className="text-2xs font-bold">{drawerLabel}</Label>
              <RefundDrawerField
                state={drawer}
                hint={drawerHint ?? "النقدُ يخرج فوراً من الدرج المختار — تأكّد أنّه المناسب."}
                disabled={submitting}
              />
            </div>
          )}

          {/* ─── رصيد الخزينة إن أُبيح — رقمٌ إعلاميّ لمالك `treasury:READ` ─── */}
          {rail === "TREASURY" && rails.TREASURY.available && preflight.treasuryCash != null && (
            <p className="text-2xs text-muted-foreground">
              نقدُ الخزينة المتاح:{" "}
              <span dir="ltr" className="font-bold tabular-nums">
                {fmtAr(preflight.treasuryCash)}
              </span>{" "}
              د.ع
            </p>
          )}

          {/* ─── مرجع البطاقة — لِـCARD وحده ─── */}
          {available.includes(rail) && refundRailNeedsReference(rail) && (
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

          {/* ─── سببُ التعطيل — يُقال قبل الضغط لا بعده (الوضعُ المستقلّ؛ المضمَّن يعرضه الأب) ─── */}
          {mode === "standalone" && blockReason ? (
            <p className="flex items-start gap-2 rounded-md bg-[var(--sem-warn-bg)] px-2.5 py-2 text-2xs font-bold text-[var(--sem-warn)]">
              <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span>{blockReason}</span>
            </p>
          ) : null}

          {mode === "standalone" ? (
            <div className="flex gap-2 pt-1">
              <Button type="button" size="sm" onClick={handleConfirm} disabled={submitting || blockReason != null}>
                تأكيدُ رافد الردّ
              </Button>
              {onCancel ? (
                <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={submitting}>
                  إلغاء
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * **تشخيصُ الاكتمال** — «ماذا حدث · لماذا · ماذا تفعل الآن» (§٥). خارجيٌّ ليَختبَره الاختبار.
 * الرافدُ غيرُ المتاح يُحجَب بسببه المعلَن؛ وانعدامُ كلّ الروافد يُقال بمخارجه لا بصمت.
 */
export function computeBlockReason(args: {
  needsCash: boolean;
  rail: RefundRail;
  rails: RefundRailAvailabilityMap | null;
  drawerBlockReason: string | null;
  cardReference: string;
}): string | null {
  if (!args.needsCash) return null;
  if (args.rails) {
    const open = availableRefundRails(args.rails);
    if (open.length === 0) {
      const reasons = REFUND_RAILS.map((r) => `${REFUND_RAIL_LABEL[r]}: ${args.rails![r].reason ?? ""}`).join(" · ");
      return `لا رافدَ متاحاً لردّ المال على هذا المستند — ${reasons}`;
    }
    if (!args.rails[args.rail].available) {
      return `${REFUND_RAIL_LABEL[args.rail]} غير متاح هنا — ${args.rails[args.rail].reason ?? ""} اختر رافداً آخر.`;
    }
  }
  if (refundRailNeedsShift(args.rail)) return args.drawerBlockReason;
  if (cardReferenceIsMissing(args.rail, args.cardReference)) {
    return "أدخِل مرجع تنفيذ الاسترداد من جهاز الدفع (٣ محارف على الأقل).";
  }
  return null;
}
