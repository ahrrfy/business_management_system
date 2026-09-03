/**
 * **رافدُ الردّ عند الاعتماد** — بلاغ المالك (٢/٩/٢٦) على الأمر 5033/#171.
 *
 * الطالبُ يختار الرافدَ ساعةَ الطلب، والمعتمِدُ يُطبّقه ساعةَ الاعتماد — وبينهما ساعات. فُرِّغ
 * الدرجُ بالبيع، فوقف المديرُ أمام «رصيد الدرج المتاح 25٬000 د.ع أقل من المطلوب 70٬000 د.ع»
 * وحمولةُ الطلب **مبصومةٌ لا تُعدَّل**: لا يعتمد ولا يُغيّر، والرسالةُ تقول ما الخطأ ولا تقول
 * ما العمل. بابٌ مسدودٌ على مالِ زبونٍ محتجَز.
 *
 * فهنا يرى المعتمِدُ **الأرصدة الحيّة قبل الضغط** ويختار من أين يخرج المال فعلاً.
 *
 * ⚠️ **ملاحظة بنيويّة مقصودة:** رقائقُ الروافد مكتوبةٌ هنا ولا تُعاد استعمالها من
 * `CancelWorkOrderDialog`. المنطقُ كلُّه مشترَكٌ فعلاً (`@shared/refundRail` +
 * `RefundDrawerPicker`)، والمكرَّرُ عرضٌ محض. والسببُ صريح: حالةُ الرافد هناك صُلِّبت بثلاث
 * مراجعاتٍ متتابعة (ترتيبُ المؤثّرات · تصفيرُ البطاقة · تصفيرُ المرجع بين المحاولات)،
 * وإعادةُ تركيبها في خطّاف مشترك تُخاطر بإرجاع أعطابٍ أُغلقت للتوّ. الاستخراجُ يستحقّ شريحتَه.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Wallet } from "lucide-react";
import {
  REFUND_RAILS,
  REFUND_RAIL_HINT,
  REFUND_RAIL_LABEL,
  refundRailNeedsReference,
  refundRailNeedsShift,
  type RefundRail,
} from "@shared/refundRail";
import type { RefundPreflight } from "@shared/refundPreflight";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RefundDrawerPicker, useRefundDrawer } from "@/components/workorder/RefundDrawerPicker";
import { fmtAr } from "@/lib/money";

export interface ApprovalRefundChoice {
  rail: RefundRail;
  shiftId: number | undefined;
  reference: string;
  /** سببُ الحجب المقروء، أو `null` حين يجوز الاعتماد. */
  blockReason: string | null;
  /** هل يختلف الاختيارُ عمّا اقترحه الطالب؟ (يُرسَل التجاوزُ عندئذٍ وحده). */
  changed: boolean;
  setRail: (rail: RefundRail) => void;
  setReference: (value: string) => void;
  drawer: ReturnType<typeof useRefundDrawer>;
}

export function useApprovalRefundChoice(args: {
  open: boolean;
  preflight: RefundPreflight | null;
  /** ما اقترحه الطالبُ في حمولة الطلب. */
  requestedRail: RefundRail | null;
  requestedShiftId: number | null;
  requestedReference: string | null;
}): ApprovalRefundChoice {
  const { open, preflight, requestedRail, requestedShiftId, requestedReference } = args;
  const needsCash = preflight?.needsCashDrawer === true;
  const [rail, setRail] = useState<RefundRail>(requestedRail ?? "DRAWER");
  const [reference, setReference] = useState(requestedReference ?? "");
  const drawer = useRefundDrawer({ preflight: open ? preflight : null, emptyLabel: "وردية استقبال" });

  // فتحٌ جديد ⇒ نبدأ من اقتراح الطالب لا من قيمةٍ عالقة.
  useEffect(() => {
    if (!open) return;
    setRail(requestedRail ?? "DRAWER");
    // ⚠️ **مرجعُ البطاقة يُبذَر من الطلب** (مراجعة Codex P2): طلبٌ يقترح `CARD` يحمل مرجعاً
    // مُتحقَّقاً منه سلفاً؛ تفريغُه كان يحجب الاعتماد حتى يُعيد المديرُ كتابتَه، ويَعُدّ ما
    // يكتبه **تجاوزاً** — فيستحيل اعتمادُ الطلب كما قُدِّم رغم أنّ الخادم يقبله.
    setReference(requestedReference ?? "");
    drawer.reset();
  }, [open, requestedRail, requestedReference]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * ⭐⛔ **درجُ الطالب يُصان** (مراجعة Codex P1): `drawer.reset()` يُفرّغ الاختيار، فيختار
   * `pickDefaultRefundDrawer` **درجَ المعتمِد نفسه** متى كان مفتوحاً. النتيجة: نقدٌ يخرج من
   * درجٍ لم يُقصَد، و`changed` يصير صحيحاً فيُرسَل تجاوزٌ لم يطلبه أحد — وتنكسر تسويةُ درجَين
   * معاً (§٥: لكلّ دينارٍ مسارٌ منسوبٌ لفاعله). فنُعيد بذرَ درج الطلب **ما دام مؤهَّلاً**،
   * ولا نسقط إلى اختيارٍ جديد إلّا إن أُغلق أو لم يعد صالحاً.
   */
  const drawerSeededRef = useRef(false);
  useEffect(() => { if (!open) drawerSeededRef.current = false; }, [open]);
  useEffect(() => {
    if (!open || !preflight || drawerSeededRef.current) return;
    drawerSeededRef.current = true;
    if (requestedShiftId != null && preflight.drawers.some((d) => d.shiftId === requestedShiftId)) {
      drawer.setRefundShiftId(requestedShiftId);
    }
  }, [open, preflight, requestedShiftId]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * ⭐ **جوهرُ الإصلاح**: إن كان رافدُ الطالب لا يغطّي المبلغَ الآن وتغطّيه الخزينة، نبدأ على
   * الخزينة. مرّةً واحدةً عند الفتح — فلا تُطمَس نقرةُ المدير اليدويّة بعدها (الكفايةُ إرشادٌ
   * لا حجب: الرصيدُ حيّ وقد يتغيّر، والخادمُ هو الحَكَم).
   */
  const [autoDefaulted, setAutoDefaulted] = useState(false);
  useEffect(() => { if (!open) setAutoDefaulted(false); }, [open]);
  useEffect(() => {
    if (!open || !needsCash || !preflight || autoDefaulted) return;
    setAutoDefaulted(true);
    const proposed = requestedRail ?? "DRAWER";
    const proposedFits =
      proposed === "TREASURY" ? preflight.treasurySufficient
      : proposed === "DRAWER" ? preflight.drawers.some((d) => d.sufficient)
      : true;
    if (!proposedFits && preflight.treasurySufficient) setRail("TREASURY");
  }, [open, needsCash, preflight, autoDefaulted, requestedRail]);

  const shiftId = needsCash && refundRailNeedsShift(rail) ? drawer.refundShiftId : undefined;

  const blockReason = !needsCash
    ? null
    : refundRailNeedsShift(rail)
      ? drawer.blockReason
      : refundRailNeedsReference(rail) && reference.trim().length < 3
        ? "أدخِل مرجع تنفيذ الاسترداد من جهاز الدفع (٣ محارف على الأقل)."
        : null;

  const changed = useMemo(() => {
    if (!needsCash) return false;
    if (rail !== (requestedRail ?? "DRAWER")) return true;
    if (refundRailNeedsShift(rail) && (shiftId ?? null) !== (requestedShiftId ?? null)) return true;
    // المرجعُ تجاوزٌ حين **يختلف** عمّا قدّمه الطالب — لا لمجرّد وجوده.
    return refundRailNeedsReference(rail)
      && reference.trim() !== (requestedReference ?? "").trim();
  }, [needsCash, rail, requestedRail, shiftId, requestedShiftId, reference, requestedReference]);

  return { rail, shiftId, reference, blockReason, changed, setRail, setReference, drawer };
}

export function ApprovalRefundRailPicker({
  preflight,
  choice,
}: {
  preflight: RefundPreflight | null;
  choice: ApprovalRefundChoice;
}) {
  if (preflight?.needsCashDrawer !== true) return null;
  const { drawer, setRail: onRailChange, setReference: onReferenceChange } = choice;

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className="inline-flex items-center gap-1.5 text-xs font-bold">
          <Wallet aria-hidden className="size-3.5" /> من أين يخرج المال؟
        </Label>
        <span className="text-2xs text-muted-foreground">
          المطلوب{" "}
          <span dir="ltr" className="font-bold tabular-nums">{fmtAr(preflight.estimatedCashOut)}</span> د.ع
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {REFUND_RAILS
          .filter((r) => r !== "CARD" || preflight.cardRefundAllowed === true)
          .map((r) => {
            const fits = r === "TREASURY"
              ? preflight.treasurySufficient
              : r === "DRAWER"
                ? preflight.drawers.some((d) => d.sufficient)
                : true;
            return (
              <button
                key={r}
                type="button"
                onClick={() => onRailChange(r)}
                className={`rounded-full border px-2.5 py-1 text-2xs font-bold transition-colors ${
                  choice.rail === r ? "border-transparent bg-primary text-primary-foreground" : "hover:bg-muted"
                }`}
              >
                {REFUND_RAIL_LABEL[r]}
                {/* «قد لا يكفي» إرشادٌ لا حجب — الرصيدُ حيّ والخادمُ هو الحَكَم. */}
                {fits === false ? " — قد لا يكفي" : ""}
              </button>
            );
          })}
      </div>
      <p className="text-2xs text-muted-foreground">{REFUND_RAIL_HINT[choice.rail]}</p>

      {refundRailNeedsShift(choice.rail) && (
        <div className="space-y-1">
          <Label className="text-2xs font-bold">درج ردّ النقد</Label>
          <RefundDrawerPicker
            state={drawer}
            needed
            hint="وردية قبض العربون قد تكون أُغلقت — النقد يخرج من درجٍ مفتوحٍ الآن."
          />
        </div>
      )}

      {choice.rail === "TREASURY" && preflight.treasuryCash != null && (
        <p className="text-2xs text-muted-foreground">
          نقدُ الخزينة المتاح:{" "}
          <span dir="ltr" className="font-bold tabular-nums">{fmtAr(preflight.treasuryCash)}</span> د.ع
        </p>
      )}

      {refundRailNeedsReference(choice.rail) && (
        <div className="space-y-1">
          <Label htmlFor="approval-refund-reference" className="text-2xs font-bold">
            مرجع تنفيذ الاسترداد الخارجيّ
          </Label>
          <Input
            id="approval-refund-reference"
            value={choice.reference}
            onChange={(event) => onReferenceChange(event.target.value)}
            maxLength={100}
            placeholder="رقم عملية الاسترداد على جهاز الدفع"
            className="text-sm"
          />
        </div>
      )}

      {choice.changed && (
        <p className="text-2xs font-bold text-[var(--sem-warn)]">
          غيّرتَ رافدَ الردّ عمّا اقترحه الطالب — يُسجَّل التغييرُ وفاعلُه في سجلّ الأمر.
        </p>
      )}
    </div>
  );
}
