/**
 * **منتقي درج الاسترداد النقديّ** — الحقلُ الذي كانت رسالةُ الخادم تطلبه ولا وجودَ له.
 *
 * الاستعمالُ خطّافٌ لا مكوّنٌ وحده: الشاشةُ تحتاج **الاثنين معاً** — أن تعرض المنتقي، وأن
 * تُعطّل زرَّها بسببٍ **مقروء** قبل الضغط. فصلُهما كان يُنتج زرّاً مفعَّلاً يُرفَض خادمياً.
 *
 * **مبدأُ التصميم (نصّ المالك ٣١/٨): «لا يتوقّف المعالِج بحائطٍ دون إنهاء العملية.»**
 * فلكلّ فرعٍ هنا مَخرجٌ معلَن:
 *  · تعدّدُ الأدراج ⇒ منتقٍ **يُظهر نقدَ كلّ درج** فلا يُختار درجٌ لا يكفي.
 *  · انعدامُ الأدراج ⇒ رابطٌ مباشر لفتح وردية (لا «تعذّر» صمّاء).
 *  · عجزُ الدرج المختار ⇒ **تحذيرٌ لا حجب** + بديلان مذكوران (درجٌ آخر / تمويلٌ من الخزينة).
 *
 * المنطقُ الخالص في [`lib/refundDrawer`](../../lib/refundDrawer.ts) ومُختبَرٌ وحدَه.
 */
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, ExternalLink, Wallet } from "lucide-react";
import { Label } from "@/components/ui/label";
import { fmtAr } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import {
  drawerShortfallWarning,
  pickDefaultRefundDrawer,
  refundDrawerBlockReason,
  type RefundDrawerOption,
} from "@/lib/refundDrawer";
import type { RefundPreflight } from "@shared/refundPreflight";

export interface UseRefundDrawerArgs {
  /**
   * تمهيدُ الخادم — **مصدرُ الحقيقة الوحيد**. `null` ⇒ لم يصل بعد (لا حجب، لا وعد).
   *
   * ⛔ لا تُشتقّ الحاجةُ ولا المبلغُ ولا الأدراج في الشاشة: التخمينُ العميليّ أنتج ثلاثةَ
   * حوائطَ أمسكتها مراجعة Codex (بطاقةٌ كاملة تُعطَّل · طردٌ بلا نقدٍ يُعطَّل · عربونُ مسوّدةٍ
   * يُخفي المنتقي). التفصيل في [`shared/refundPreflight.ts`](../../../../shared/refundPreflight.ts).
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

/** حالةُ درج الاسترداد + الافتراضُ التلقائيّ. */
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
 * عرضُ المنتقي — يظهر حين يخرج نقدٌ **ويتعدّد** الدرج، أو حين لا درجَ أصلاً، أو حين
 * لا يكفي الدرجُ الوحيد. درجٌ واحدٌ كافٍ مُختارٌ تلقائياً لا يستحقّ حقلاً يُربك الموظّف.
 */
export function RefundDrawerPicker({
  state,
  needed,
  hint,
}: {
  state: RefundDrawerState;
  needed: boolean;
  /** جملةٌ تشرح **لماذا** يخرج نقدٌ الآن. */
  hint?: string;
}) {
  if (!needed) return null;
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
          افتح وردية استقبال من الخزينة
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
          <select
            aria-label="درج الاسترداد النقدي"
            className="h-9 w-full rounded-md border bg-card px-2 text-xs font-bold"
            value={refundShiftId != null ? String(refundShiftId) : ""}
            onChange={(e) => setRefundShiftId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">اختر الدرج…</option>
            {drawers.map((sh) => (
              <option key={sh.shiftId} value={String(sh.shiftId)}>
                {sh.userName} — وردية #{sh.shiftId}
                {sh.expectedCash != null ? ` · نقدٌ متاح ${fmtAr(sh.expectedCash)} د.ع` : ""}
              </option>
            ))}
          </select>
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
