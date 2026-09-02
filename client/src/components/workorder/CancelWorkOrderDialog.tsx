/**
 * **حوارُ إلغاء أمر الشغل** — سببٌ صريح ومصيرُ خامةٍ صادق (ش٤، ١٩/٨).
 *
 * كان الإلغاء نافذةَ تأكيدٍ نصّية تَعِد بأنّ «المواد تُعاد للمخزون» — وتعيدها **كاملةً دائماً**
 * ولو أُتلف نصفُها فعلاً. فيدخل المخزونَ ورقٌ محروقٌ ما زال يُحسَب أصلاً بقيمته، ويظهر ربحٌ
 * لم يقع. والسببُ كان يذوب: لا عمود يحمله ولا تقرير يُظهره.
 *
 * فهنا سطرٌ لكلّ خامة: **راجع** و**تالف**، مجموعُهما = المستهلَك (يفرضه الخادم أيضاً)، وقيمةُ
 * الهدر تظهر **قبل** التأكيد — لا امتصاصَ خفيّ (§٥).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, PackageX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fmtAr } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";
import type { RefundPreflight } from "@shared/refundPreflight";
import { RefundDrawerPicker, useRefundDrawer } from "./RefundDrawerPicker";
import {
  REFUND_RAILS,
  REFUND_RAIL_HINT,
  REFUND_RAIL_LABEL,
  refundRailNeedsReference,
  refundRailNeedsShift,
  type RefundRail,
} from "@shared/refundRail";

export interface CancelMaterialRow {
  id: number;
  name: string;
  baseQuantity: number;
  unitCost: string | null;
}

/**
 * **غلافٌ يجلب التفاصيل بالمعرّف** — للشاشات التي تملك المعرّف وحده (لوحة الطلبات).
 *
 * كانت اللوحة تُلغي بـ`confirm()` نصّية: بلا سببٍ يُكتب (والعمود موجودٌ منذ 0237)، وبلا
 * قرارِ هدرٍ للخامة (فتعود محروقةً أصلاً صالحة)، وبلا درجِ ردٍّ — **ثلاثةُ حوائطَ في نافذةٍ
 * واحدة**. توحيدُها على الحوار نفسه يُغلقها معاً ويجعل سلوكَ الإلغاء واحداً في الشاشتين.
 */
export function CancelWorkOrderDialogById({
  workOrderId,
  onOpenChange,
  pending,
  onConfirm,
}: {
  /** `null` ⇒ مغلق. */
  workOrderId: number | null;
  onOpenChange: (v: boolean) => void;
  pending?: boolean;
  onConfirm: (d: CancelDecision) => void;
}) {
  const q = trpc.workOrders.get.useQuery(
    { workOrderId: workOrderId ?? 0 },
    { enabled: workOrderId != null },
  );
  const d = q.data;
  if (workOrderId == null) return null;
  /**
   * **نقرةٌ لا تُنتج شيئاً ليست خياراً.** كان الغلافُ يُرجع `null` ريثما تصل التفاصيل، فالضغط
   * على «إلغاء الأمر» في اللوحة يبدو بلا أثرٍ إطلاقاً على أوّل فتحٍ (قبل تخبئة الاستعلام) —
   * فيُعيد الموظّف الضغطَ ظانّاً أنّ الزرّ معطوب. نُظهر قشرةَ الحوار بحالتها الصادقة بدلاً منها.
   */
  if (!d) {
    return (
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PackageX aria-hidden className="size-4" /> إلغاء طلب الخدمة
            </DialogTitle>
            <DialogDescription>
              {q.isError ? "تعذّر تحميل تفاصيل الطلب — أغلِق الحوار وأعد المحاولة." : ACTION_LABELS.loading}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>إغلاق</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <CancelWorkOrderDialog
      open
      onOpenChange={onOpenChange}
      workOrderId={workOrderId}
      orderNumber={d.orderNumber}
      title={d.title}
      // نفسُ شرط شاشة التفاصيل: الخامة تُعرَض بعد البدء فقط — قبله لا استهلاك.
      materials={
        d.status === "IN_PROGRESS" || d.status === "READY"
          ? (d.materials ?? []).map((m) => ({
              id: Number(m.id),
              name: [m.productName, m.variantName].filter(Boolean).join(" — ") || m.sku || `#${m.variantId}`,
              baseQuantity: Number(m.baseQuantity),
              unitCost: m.unitCost ?? null,
            }))
          : []
      }
      pending={pending}
      onConfirm={onConfirm}
    />
  );
}

export interface CancelDecision {
  reason: string;
  materials: Array<{ workOrderMaterialId: number; returnBase: number; wasteBase: number }> | undefined;
  /** درجُ الاسترداد النقديّ — يُرسَل فقط حين يخرج نقدٌ فعلاً من **درج**. */
  refundShiftId: number | undefined;
  /** رافدُ الردّ — `undefined` ⇒ لا نقدَ يخرج (فلا رافد). */
  refundRail: RefundRail | undefined;
  /** مرجعُ التنفيذ الخارجيّ — لرافد البطاقة وحده. */
  refundReference: string | undefined;
}

/** أسبابٌ جاهزة — نقرةٌ بدل كتابة، والحقلُ الحرّ يبقى لما لا يُحصى. */
const REASONS = [
  "لم يحضر العميل لاستلام الطلب",
  "العميل ألغى الطلب",
  "خطأ في إدخال الطلب",
  "تعذّر التنفيذ فنّياً",
  "الخامة غير متوفّرة",
];

export default function CancelWorkOrderDialog({
  open,
  onOpenChange,
  workOrderId,
  orderNumber,
  title,
  /** أسطر الخامة المستهلَكة — فارغةٌ إن لم يبدأ التنفيذ (فلا جدولَ ولا هدر). */
  materials,
  requiresApproval = false,
  refundPreflight,
  refundPreflightPending = false,
  refundPreflightError = false,
  onRetryRefundPreflight,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workOrderId: number;
  orderNumber: string;
  title: string;
  materials: CancelMaterialRow[];
  requiresApproval?: boolean;
  /**
   * مسارُ الموافقة يملك تمهيداً من `controlPreflight` المتاح للكاشير. غيابُ الخاصية فقط
   * يعني أنّ الإلغاء مباشر، وعندها نجلب التمهيد الإداري الدقيق من `refundPreflight`.
   */
  refundPreflight?: RefundPreflight | null;
  refundPreflightPending?: boolean;
  refundPreflightError?: boolean;
  onRetryRefundPreflight?: () => void;
  pending?: boolean;
  onConfirm: (d: CancelDecision) => void;
}) {
  const [reason, setReason] = useState("");
  const [waste, setWaste] = useState<Record<number, number>>({});

  /**
   * **التمهيدُ الخادميّ** بدل تخمين العربون: يشمل حصصَ العربون المطبَّقة من مسوّدة الاستقبال
   * (`orderPayments`) وأمانةَ أجرة التوصيل معاً — وهما ما كان التخمينُ يعميه، فيُخفي المنتقي
   * على أمرٍ يطلب الخادمُ درجَه (مراجعة Codex P1).
   */
  const preflightQ = trpc.workOrders.refundPreflight.useQuery(
    { workOrderId, operation: "CANCEL" },
    { enabled: open && refundPreflight === undefined, staleTime: 0 },
  );
  const effectivePreflight = refundPreflight === undefined
    ? preflightQ.data ?? null
    : refundPreflight;
  const preflightPending = refundPreflight === undefined
    ? preflightQ.isLoading || preflightQ.isFetching
    : refundPreflightPending;
  const preflightFailed = refundPreflight === undefined
    ? preflightQ.isError
    : refundPreflightError;
  const drawer = useRefundDrawer({
    preflight: open ? effectivePreflight : null,
    emptyLabel: "وردية استقبال",
  });
  const { refundShiftId: pickedShiftId } = drawer;
  const needsCashDrawer = effectivePreflight?.needsCashDrawer === true;
  const [rail, setRail] = useState<RefundRail>("DRAWER");
  const [refundReference, setRefundReference] = useState("");

  /**
   * **بطاقةٌ مختارةٌ ثمّ تبيّن أنّها ممنوعة (حصصٌ/أمانة) ⇒ اردُد للدرج** — تفاعليٌّ مع الرافد
   * لتصحيح أيّ اختيارٍ لاحقٍ يصير غيرَ صالح، لا مرّةً واحدة.
   */
  useEffect(() => {
    if (!open || !needsCashDrawer || !effectivePreflight) return;
    if (rail === "CARD" && effectivePreflight.cardRefundAllowed !== true) setRail("DRAWER");
  }, [open, needsCashDrawer, effectivePreflight, rail]);

  // مرجعُ «حُسم الافتراضُ» يُصفَّر مع كلّ فتح؛ والافتراضُ نفسُه (إلى الخزينة) يقع في مؤثّرٍ **بعد**
  // إعادة ضبط الفتح أدناه ليكون آخرَ تحديثٍ للرافد (مراجعة Codex P2 على #930).
  const railAutoDefaultedRef = useRef(false);
  useEffect(() => {
    railAutoDefaultedRef.current = false;
  }, [open]);

  /**
   * سببُ الحجب **بحسب الرافد**: الدرجُ وحده يلزمه اختيارُ وردية، والبطاقةُ وحدها مرجعٌ خارجيّ.
   * (بلا هذا كان حجبُ الدرج يسري على الخزينة فيمنع مساراً لا يحتاج درجاً إطلاقاً.)
   */
  /**
   * صارت الحمولةُ تحمل الرافد، فلا فرقَ بين المسارين (مراجعة Codex P1 على #928): حصرُ الروافد
   * في المسار المباشر كان يُغيّبها عن **كلّ إلغاءٍ يحتاج ردّاً** — `controlRequired.cancel`
   * صحيحٌ لأيّ أمرٍ بعربونٍ أو حصصٍ أو أمانةٍ أو خامة.
   */
  const effectiveRail: RefundRail = rail;
  /**
   * الدرجُ المُرسَل — **لرافد الدرج وحده**. الخزينةُ والبطاقةُ لا وردية لهما، وإرسالُ درجٍ معهما
   * يخلط مصدرَ المال في البصمة والتدقيق.
   */
  const refundShiftId = needsCashDrawer && refundRailNeedsShift(effectiveRail) ? pickedShiftId : undefined;

  const railBlockReason = !needsCashDrawer
    ? null
    : refundRailNeedsShift(effectiveRail)
      ? drawer.blockReason
      : refundRailNeedsReference(effectiveRail) && refundReference.trim().length < 3
        ? "أدخِل مرجع تنفيذ الاسترداد من جهاز الدفع (٣ محارف على الأقل)."
        : null;

  // فتحٌ جديد ⇒ حالةٌ نظيفة: سببٌ قديم أو درجٌ أُغلق بينهما يُنتجان تأكيداً يكذب.
  useEffect(() => {
    if (!open) return;
    setReason("");
    setWaste({});
    drawer.reset();
    // الرافدُ والمرجعُ يُصفَّران كذلك: مرجعُ بطاقةٍ بقي من محاولةٍ أُغلقت بلا تأكيد كان
    // يُرسَل مع محاولةٍ جديدة ⇒ **إثباتٌ ماليٌّ كاذب** على استردادٍ لم يقع (مراجعة Codex).
    setRail("DRAWER");
    setRefundReference("");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * **الافتراضُ إلى الخزينة مرّةً واحدةً** (بلاغ المالك ١/٩): بدءُ الحوار على «الدرج» بابٌ مسدودٌ
   * حين لا يكفي أيُّ درجٍ وتكفي الخزينة. ⚠️ **يقع بعد إعادة ضبط الفتح أعلاه** (مراجعة Codex P2 على
   * #930): لو سبقها لَطمَسَ `setRail("DRAWER")` اللاحقُ الخزينةَ، والمرجعُ يمنع إعادةَ المحاولة،
   * فيُفتَح على درجٍ لا يكفي — خاصّةً في مسار الاعتماد حيث يصل التمهيدُ محمَّلاً مع الفتح. وبلا
   * `rail` في التبعيّات: كفايةُ الدرج إرشاديّةٌ لا حاجزة (الرصيدُ الحيّ قد تغيّر)، فلا تُطمَس نقرةُ
   * الموظّف اليدويّة على «الدرج».
   */
  useEffect(() => {
    if (!open || !needsCashDrawer || !effectivePreflight || railAutoDefaultedRef.current) return;
    railAutoDefaultedRef.current = true;
    const anyDrawerFits = effectivePreflight.drawers.some((d) => d.sufficient);
    if (!anyDrawerFits && effectivePreflight.treasurySufficient) setRail("TREASURY");
  }, [open, needsCashDrawer, effectivePreflight]);

  const hasMaterials = materials.length > 0;
  const anyWaste = materials.some((m) => (waste[m.id] ?? 0) > 0);
  /**
   * **الكلفة محجوبةٌ عن بعض الأدوار** (`redactPosCost` — الكاشير يرى الكمّيات لا الأسعار)
   * فتصل `unitCost = null`. و`Number(null ?? 0)` كان يُنتج **صفراً يُعرَض رقماً حقيقياً**:
   * «يُسجَّل هدرٌ بقيمة ٠» على أربع قطعٍ تالفة — كذبةٌ تُطمئن الموظّف إلى أنّ إتلافه بلا ثمن.
   * فحين تُحجَب كلفةُ **أيّ** سطرٍ مُهدَر لا نَدّعي قيمةً إطلاقاً: نُظهر الكمّية ونقول إنّ
   * القيمة غير مرئيّة لهذا الدور. والخادم يحسبها من كلفته الحقيقيّة في كلّ الأحوال.
   */
  const wastedLines = materials.filter((m) => (waste[m.id] ?? 0) > 0);
  const costVisible = wastedLines.length > 0 && wastedLines.every((m) => m.unitCost != null);
  const wastedValue = useMemo(
    () => materials.reduce((sum, m) => sum + (waste[m.id] ?? 0) * Number(m.unitCost ?? 0), 0),
    [materials, waste],
  );
  const wastedPieces = wastedLines.reduce((n, m) => n + (waste[m.id] ?? 0), 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PackageX aria-hidden className="size-4" /> إلغاء طلب الخدمة
          </DialogTitle>
          <DialogDescription>
            «{title}» — <span dir="ltr" className="font-mono">{orderNumber}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label className="text-xs font-bold">سبب الإلغاء</Label>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {REASONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setReason(r)}
                  className={`rounded-full border px-2.5 py-1 text-2xs font-bold transition-colors ${
                    reason === r ? "border-transparent bg-primary text-primary-foreground" : "hover:bg-muted"
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="أو اكتب السبب…"
              className="mt-2"
              maxLength={500}
            />
          </div>

          {hasMaterials ? (
            <div>
              <Label className="text-xs font-bold">مصير الخامة المستهلَكة</Label>
              <p className="mt-1 text-2xs text-muted-foreground">
                افتراضياً يعود كلُّ شيء للمخزون. سجّل التالف فعلاً — يُحمَّل خسارةً ولا يعود صنفاً صالحاً.
              </p>
              <div className="mt-2 overflow-x-auto rounded-md border">
                <table className="w-full text-2xs">
                  <thead className="bg-muted/60 text-muted-foreground">
                    <tr>
                      <th className="p-2 text-start font-bold">الخامة</th>
                      <th className="p-2 text-center font-bold">مستهلَك</th>
                      <th className="p-2 text-center font-bold">تالف</th>
                      <th className="p-2 text-center font-bold">يعود للمخزون</th>
                      <th className="p-2 text-end font-bold">قيمة الهدر</th>
                    </tr>
                  </thead>
                  <tbody>
                    {materials.map((m) => {
                      const w = waste[m.id] ?? 0;
                      return (
                        <tr key={m.id} className="border-t">
                          <td className="p-2">{m.name}</td>
                          <td className="p-2 text-center tabular-nums">{m.baseQuantity}</td>
                          <td className="p-2 text-center">
                            <Input
                              type="number"
                              min={0}
                              max={m.baseQuantity}
                              value={String(w)}
                              onChange={(e) => {
                                const v = Math.max(0, Math.min(m.baseQuantity, Math.floor(Number(e.target.value) || 0)));
                                setWaste((prev) => ({ ...prev, [m.id]: v }));
                              }}
                              className="mx-auto h-7 w-20 text-center"
                            />
                          </td>
                          <td className="p-2 text-center font-bold tabular-nums">{m.baseQuantity - w}</td>
                          <td className="p-2 text-end tabular-nums" dir="ltr">
                            {w > 0 ? (m.unitCost != null ? fmtAr(String(w * Number(m.unitCost))) : "—") : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {anyWaste && (
                <p className="mt-2 flex items-center gap-1.5 rounded-md bg-[var(--sem-warn-bg)] p-2 text-2xs font-bold text-[var(--sem-warn)]">
                  <AlertTriangle aria-hidden className="size-3.5 shrink-0" />
                  {costVisible ? (
                    <span>
                      يُسجَّل هدرٌ بقيمة <span dir="ltr" className="tabular-nums">{fmtAr(String(wastedValue))}</span> خسارةً على المكتبة — ولا يعود للمخزون.
                    </span>
                  ) : (
                    <span>
                      يُسجَّل إتلافُ <span dir="ltr" className="tabular-nums">{wastedPieces}</span> وحدة خسارةً على المكتبة — ولا تعود للمخزون.
                      قيمتُها لا تظهر لدورك، ويحسبها النظام بكلفة الشراء المختومة.
                    </span>
                  )}
                </p>
              )}
            </div>
          ) : (
            <p className="rounded-md bg-muted/50 p-2 text-2xs text-muted-foreground">
              لم يبدأ التنفيذ — لا خامة مستهلَكة، ولا أثر على المخزون.
            </p>
          )}

          {preflightPending ? (
            <p className="rounded-md border p-3 text-sm text-muted-foreground">جارٍ التحقق من النقد والورديات المفتوحة…</p>
          ) : preflightFailed ? (
            <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              <p>تعذّر التحقق من وردية ردّ المبلغ؛ أُوقف الإلغاء حتى نجاح التحقق.</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => {
                  if (refundPreflight === undefined) void preflightQ.refetch();
                  else onRetryRefundPreflight?.();
                }}
              >
                إعادة المحاولة
              </Button>
            </div>
          ) : null}

          <p className="text-2xs text-muted-foreground">
            {requiresApproval
              ? "الإرسال هنا ينشئ طلباً معلّقاً بلا أثر مالي أو مخزني؛ مدير مستقل يراجعه ويعتمده أو يرفضه."
              : "العربون المقبوض (إن وُجد) يُردّ بطريقة قبضه، وأمانة أجرة التوصيل تُردّ كذلك."}
          </p>

          {/*
            درجُ الردّ — الحقلُ الذي كانت رسالةُ الخادم تطلبه ولا وجودَ له، فيصير أمرٌ بعربونٍ
            نقديّ غيرَ قابلٍ للإلغاء كلّما فُتحت ورديتان. ويظهر خصوصاً في الإلغاء **بعد أيّام**:
            وردية القبض مُغلقةٌ يقيناً، فالنقد يخرج من درج اليوم.
          */}
          {needsCashDrawer && (
            <div className="space-y-2">
              <Label className="text-xs font-bold">من أين يُردّ المبلغ؟</Label>
              {/*
                ثلاثةُ روافد لأنّ الدرجَ وحده بابٌ مسدودٌ واقعيّ: بلاغُ المالك (١/٩) كان
                عربوناً ٧٠٬٠٠٠ وأوسعُ درجٍ مفتوح ٥٦٬٠٠٠ — لا اختيارَ يُصلح نقصَ المصدر.
              */}
              <div className="flex flex-wrap gap-1.5">
                {REFUND_RAILS
                  // البطاقةُ تُخفى حين يوجد جزءٌ نقديٌّ لا يقبلها (حصصٌ/أمانة) — وإلّا أنشأ
                  // اختيارُها طلبَ تحكّمٍ يستحيل اعتمادُه (مراجعة Codex P2 على #930).
                  .filter((r) => r !== "CARD" || effectivePreflight?.cardRefundAllowed === true)
                  .map((r) => {
                  const fits = r === "TREASURY"
                    ? effectivePreflight?.treasurySufficient
                    : r === "DRAWER"
                      ? effectivePreflight?.drawers.some((d) => d.sufficient)
                      : true;
                  return (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setRail(r)}
                      className={`rounded-full border px-2.5 py-1 text-2xs font-bold transition-colors ${
                        rail === r ? "border-transparent bg-primary text-primary-foreground" : "hover:bg-muted"
                      }`}
                    >
                      {REFUND_RAIL_LABEL[r]}
                      {/* «لا يكفي» إرشادٌ لا حجب — الخادمُ هو الحَكَم، وقد يتغيّر الرصيد. */}
                      {fits === false ? " — قد لا يكفي" : ""}
                    </button>
                  );
                })}
              </div>
              <p className="text-2xs text-muted-foreground">{REFUND_RAIL_HINT[rail]}</p>

              {refundRailNeedsShift(rail) && (
                <div className="space-y-1">
                  <Label className="text-2xs font-bold">درج ردّ النقد</Label>
                  <RefundDrawerPicker
                    state={drawer}
                    needed
                    hint="وردية قبض العربون قد تكون أُغلقت — النقد يخرج من درجٍ مفتوحٍ الآن."
                  />
                </div>
              )}

              {rail === "TREASURY" && effectivePreflight?.treasuryCash != null && (
                <p className="text-2xs text-muted-foreground">
                  نقدُ الخزينة المتاح:{" "}
                  <span dir="ltr" className="tabular-nums font-bold">{fmtAr(effectivePreflight.treasuryCash)}</span> د.ع
                </p>
              )}

              {refundRailNeedsReference(rail) && (
                <div className="space-y-1">
                  <Label className="text-2xs font-bold text-[var(--sem-warn)]">
                    مرجع تنفيذ الاسترداد من جهاز الدفع
                  </Label>
                  <Input
                    value={refundReference}
                    onChange={(e) => setRefundReference(e.target.value)}
                    placeholder="رقم عملية الاسترداد…"
                    maxLength={100}
                  />
                  <p className="text-2xs text-muted-foreground">
                    نفّذ الاسترداد على الجهاز أولاً، ثم أدخِل مرجعه هنا. لا يخرج مال ولا يُسجَّل
                    قيد حتى يعتمده المالك.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            {/* سببُ التعطيل مقروءٌ دائماً — زرٌّ معطَّلٌ بلا سبب هو نصفُ البابِ المسدود. */}
            {(preflightPending || preflightFailed || railBlockReason || reason.trim().length < 3) && (
              <span className="text-2xs font-bold text-[var(--sem-warn)] sm:me-auto">
                {preflightPending
                  ? "جارٍ التحقق من النقد والورديات المفتوحة…"
                  : preflightFailed
                    ? "تعذّر التحقق من وردية ردّ المبلغ."
                    : reason.trim().length < 3
                      ? "اكتب سبب الإلغاء (٣ أحرف على الأقل)."
                      : railBlockReason}
              </span>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>تراجع</Button>
              <Button
                variant="destructive"
                disabled={pending || preflightPending || preflightFailed || reason.trim().length < 3 || railBlockReason != null}
                onClick={() =>
                  onConfirm({
                    reason: reason.trim(),
                    // بلا هدرٍ ⇒ لا نُرسل الحقل إطلاقاً: العقد يقرأ غيابه «رجوعٌ كامل» — أقصرُ
                    // حمولةً وأصدقُ نيّةً من إرسال أصفارٍ صريحة.
                    materials: anyWaste
                      ? materials.map((m) => ({
                          workOrderMaterialId: m.id,
                          wasteBase: waste[m.id] ?? 0,
                          returnBase: m.baseQuantity - (waste[m.id] ?? 0),
                        }))
                      : undefined,
                    // الدرجُ يُرسَل لرافد الدرج وحده — الخزينةُ والبطاقةُ لا وردية لهما.
                    refundShiftId: refundShiftId ?? undefined,
                    refundRail: needsCashDrawer ? effectiveRail : undefined,
                    refundReference: needsCashDrawer && refundRailNeedsReference(effectiveRail)
                      ? refundReference.trim()
                      : undefined,
                  })
                }
              >
                {pending
                  ? (<><Loader2 aria-hidden className="size-3.5 me-1 animate-spin" /> جارٍ…</>)
                  : requiresApproval ? "إرسال طلب الإلغاء" : "أكّد الإلغاء"}
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
