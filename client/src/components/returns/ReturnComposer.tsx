/**
 * ReturnComposer — **المكوّن المرجعيّ الوحيد للمرتجع** (بلاغ المالك ١٧/٨/٢٦).
 *
 * لماذا وُحِّد: كان للمرتجع شاشتان بمنطقين مختلفين (`/returns` نموذجٌ مديريّ،
 * و`/sales-returns/new` محرّرٌ كامل)، وكلتاهما تحسب سقوف الاسترداد **محلياً** بمنطقٍ يخالف
 * الخادم ⇒ يملأ الموظف كل شيء ثمّ يُرفض الطلب برسالة سقفٍ غامضة. والمرتجع عمليةٌ يوميّةٌ
 * متكرّرة (نصّ المالك: «الزبائن مزاجهم متقلّب ويطلبون مرتجع كثيراً») فوجب أن تكون بمألوفيّة
 * شاشة البيع وأن تكون **غير قابلة للخطأ بالبناء**.
 *
 * مبدأ التصميم الحاكم هنا: **لا خيار على الشاشة إلّا وقد أذِن به الخادم**.
 * كل الرافدين والسقوف والأدراج تأتي من `returns.getInvoice` (المحسوبة بنفس دالّة
 * `loadRefundCaps` التي ستحكم على الطلب) ⇒ ما تعراه الشاشة = ما يقبله الخادم بالتعريف.
 * لا تُعِد حساب سقفٍ هنا ولا تُضِف رافداً بنصٍّ ثابت — تلك بالضبط العلّة التي أُصلحت.
 *
 * قرارات المالك المُجسَّدة (١٧/٨/٢٦):
 *  · رافدا الردّ **نقدٌ أو بطاقة فقط** مهما كان رافد القبض (بطاقة/نقد/تحويل/رصيد زين).
 *  · النقد يخرج من **وردية المنفّذ المفتوحة** افتراضاً، أو يختار وردية مفتوحة أخرى صراحةً.
 *  · الردّ بالبطاقة يُنفَّذ على الجهاز ثمّ يُوثَّق بمرجعه (إثباتٌ لا إقفال).
 */
import { AlertTriangle, CreditCard, Wallet } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { LoadingState } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/form/MoneyInput";
import { AppSelect } from "@/components/ui/AppSelect";
import { confirm } from "@/lib/confirm";
import { D, fmt, round2 } from "@/lib/money";
import { computeReturnTotal } from "@/lib/returnTotal";
import { trpc } from "@/lib/trpc";

type RefundRail = "CASH" | "CARD";

const RAIL_LABEL: Record<RefundRail, string> = { CASH: "نقداً من الدرج", CARD: "على البطاقة" };
const RAIL_HINT: Record<RefundRail, string> = {
  CASH: "يستلم الزبون المبلغ الآن من درج الوردية المحدّدة",
  CARD: "نفّذ الاسترداد على جهاز الدفع ثمّ أدخِل مرجع العملية",
};

function shiftTypeLabel(t: string): string {
  return t === "RECEPTION" ? "استقبال" : t === "PRINT_SERVICES" ? "خدمات طباعة" : "تجزئة";
}

/** «٢ درزن (٢٤ قطعة)» — وللوحدة الأساس أو الكسور: «٢٤ قطعة». */
function unitsLabel(base: number, factor: number, unitName: string): string {
  if (base <= 0) return "0";
  if (factor <= 1) return `${base} ${unitName || "قطعة"}`;
  if (base % factor !== 0) return `${base} قطعة`;
  return `${base / factor} ${unitName} (${base} قطعة)`;
}

export interface ReturnComposerProps {
  invoiceId: number;
  /** يُستدعى بعد نجاح المرتجع (تحديث قوائم الصفحة المضيفة/التنقّل). */
  onDone?: (result: { fullyReturned: boolean; returnedTotal: string }) => void;
  /** رابط رجوعٍ اختياريّ تعرضه الصفحة المضيفة أسفل الإجراءات. */
  footer?: React.ReactNode;
}

export function ReturnComposer({ invoiceId, onDone, footer }: ReturnComposerProps) {
  const utils = trpc.useUtils();
  const detail = trpc.returns.getInvoice.useQuery({ invoiceId }, { enabled: invoiceId > 0 });

  const [qty, setQty] = useState<Record<number, number>>({});
  const [restock, setRestock] = useState(true);
  const [rail, setRail] = useState<RefundRail>("CASH");
  const [manualAmount, setManualAmount] = useState<string | null>(null);
  const [shiftId, setShiftId] = useState<number | null>(null);
  const [cardReference, setCardReference] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  // idempotency: مفتاحٌ ثابتٌ للمحاولة، يتجدّد عند تبديل الفاتورة وبعد كل نجاح — نقرةٌ مزدوجة
  // أو إعادة إرسالٍ على شبكةٍ متذبذبة لا تُنشئ مرتجعاً ثانياً ولا تُخرج النقد مرّتين.
  const [clientRequestId, setClientRequestId] = useState(() => crypto.randomUUID());

  // تبديل الفاتورة يصفّر كل قرارٍ سابق (وإلّا سُجّل مرتجعٌ بكميّات فاتورةٍ أخرى).
  useEffect(() => {
    setQty({});
    setRestock(true);
    setRail("CASH");
    setManualAmount(null);
    setShiftId(null);
    setCardReference("");
    setError("");
    setDone("");
    setClientRequestId(crypto.randomUUID());
  }, [invoiceId]);

  const inv = detail.data;
  const items = inv?.items ?? [];
  const shifts = inv?.refundShifts ?? [];

  /** قيمة المرتجع — الصيغة في `lib/returnTotal` (مطابقةٌ لفرع الإرجاع الجزئيّ خادمياً، ومُختبَرة وحدها). */
  const returnValue = useMemo(
    () => (inv ? D(computeReturnTotal(inv.items, qty, inv)) : D(0)),
    [inv, qty],
  );

  const options = inv?.refundOptions ?? [];
  const activeOption = options.find((o) => o.method === rail);
  /** السقف الفعليّ = الأقلّ من قيمة المرتجع وسقف الرافد — **نفس معادلة الخادم حرفياً**. */
  const railCap = useMemo(() => {
    const cap = D(activeOption?.cap ?? "0");
    return returnValue.lte(cap) ? returnValue : cap;
  }, [activeOption?.cap, returnValue]);

  /**
   * المستحقّ للزبون فعلاً = ما دفعه فوق ما يبقى عليه **بعد** هذا المرتجع.
   * السقف وحده لا يكفي: هو يحرس «لا نردّ أكثر ممّا قبضنا» ولا يحرس «لا نردّ ما هو مستحقٌّ لنا».
   * فاتورةٌ آجلة بعربونٍ ٤٠٪ يُرجَع منها صنفٌ كان السقف يعرض ردّاً نقدياً كاملاً بنقرة، والعميل
   * ما زال مديناً — نُعطي نقداً لمن يدين لنا. الافتراضيّ صار الأقلّ منهما.
   */
  const customerOwedBack = useMemo(() => {
    const netAfter = D(inv?.total ?? "0")
      .minus(D(inv?.returnedTotal ?? "0"))
      .minus(returnValue);
    const over = D(inv?.paidAmount ?? "0").minus(netAfter);
    return over.gt(0) ? over : D(0);
  }, [inv?.total, inv?.returnedTotal, inv?.paidAmount, returnValue]);

  /** الوجه المقابل: ما يبقى على العميل بعد المرتجع (صفرٌ إن صار دائناً). */
  const customerStillOwes = useMemo(() => {
    const netAfter = D(inv?.total ?? "0")
      .minus(D(inv?.returnedTotal ?? "0"))
      .minus(returnValue);
    const owes = netAfter.minus(D(inv?.paidAmount ?? "0"));
    return owes.gt(0) ? owes : D(0);
  }, [inv?.total, inv?.returnedTotal, inv?.paidAmount, returnValue]);

  /** الافتراضيّ = الأقلّ من سقف الرافد والمستحقّ للزبون. التحرير يبقى متاحاً حتى السقف. */
  const suggestedRefund = useMemo(
    () => (customerOwedBack.lt(railCap) ? customerOwedBack : railCap),
    [customerOwedBack, railCap],
  );
  const refundAmount = manualAmount ?? (suggestedRefund.gt(0) ? suggestedRefund.toFixed(2) : "");
  const refundD = /^\d+(\.\d+)?$/.test(refundAmount.trim()) ? D(refundAmount.trim()) : D(0);
  const overCap = refundD.gt(railCap);

  // الرافد الافتراضيّ: النقد ما دام ممكناً، وإلّا أوّل رافدٍ غير محجوب — فلا يبدأ الموظف
  // على خيارٍ سيُرفض. يُعاد التقييم كلّما تغيّرت السقوف (تحميل/تحديث بعد مرتجعٍ جزئيّ).
  useEffect(() => {
    if (!options.length) return;
    const usable = options.find((o) => !o.blockedReason);
    if (activeOption?.blockedReason && usable) setRail(usable.method as RefundRail);
  }, [options, activeOption?.blockedReason]);

  // الدرج الافتراضيّ: درج المنفّذ نفسه إن كان مفتوحاً (قرار المالك)، وإلّا الوحيد المفتوح.
  useEffect(() => {
    if (shiftId != null || !shifts.length) return;
    const mine = shifts.find((s) => s.isMine);
    if (mine) setShiftId(mine.shiftId);
    else if (shifts.length === 1) setShiftId(shifts[0].shiftId);
  }, [shifts, shiftId]);

  const selectedLines = useMemo(
    () => Object.entries(qty)
      .map(([id, q]) => ({ invoiceItemId: Number(id), baseQuantity: q }))
      .filter((l) => l.baseQuantity > 0),
    [qty],
  );

  const create = trpc.returns.create.useMutation({
    onSuccess: async (res) => {
      setDone(
        res.fullyReturned
          ? "تمّ تسجيل المرتجع — الفاتورة مرتجعة بالكامل."
          : "تمّ تسجيل المرتجع بنجاح.",
      );
      setQty({});
      setManualAmount(null);
      setCardReference("");
      setClientRequestId(crypto.randomUUID());
      await Promise.all([
        utils.returns.getInvoice.invalidate({ invoiceId }),
        utils.sales.list.invalidate(),
        utils.sales.listPage.invalidate(),
      ]);
      onDone?.({ fullyReturned: res.fullyReturned, returnedTotal: res.returnedTotal });
    },
    onError: (e) => setError(e.message),
  });

  function setQtyClamped(itemId: number, next: number, remaining: number) {
    const v = Math.max(0, Math.min(remaining, Math.trunc(next)));
    setQty((prev) => ({ ...prev, [itemId]: v }));
    setManualAmount(null); // تغيّرت قيمة المرتجع ⇒ يعود المبلغ للحساب التلقائيّ.
    setError("");
    setDone("");
  }

  function fillAll() {
    const next: Record<number, number> = {};
    for (const it of items) if (it.remaining > 0) next[it.invoiceItemId] = it.remaining;
    setQty(next);
    setManualAmount(null);
    setError("");
    setDone("");
  }

  const isLocked = inv?.status === "RETURNED" || inv?.status === "CANCELLED";
  const needsShift = rail === "CASH" && refundD.gt(0);
  const needsReference = rail === "CARD" && refundD.gt(0);

  /** سببُ تعطيل الحفظ — نصٌّ واحدٌ يُعرَض دائماً بدل رفضٍ متأخّر من الخادم. */
  const blockReason = useMemo(() => {
    if (isLocked) return "هذه الفاتورة مرتجعة/ملغاة — لا يمكن تسجيل مرتجع جديد.";
    if (!selectedLines.length) return "حدّد كمية إرجاع واحدة على الأقل.";
    if (activeOption?.blockedReason) return activeOption.blockedReason;
    if (overCap) return `المبلغ يتجاوز المسموح (${fmt(railCap.toFixed(2))} د.ع).`;
    if (needsShift && !shifts.length) return "لا توجد وردية مفتوحة في هذا الفرع — افتح وردية أو استردّ على البطاقة.";
    if (needsShift && shiftId == null) return "حدّد الدرج الذي سيخرج منه النقد فعلياً.";
    if (needsReference && !cardReference.trim()) return "أدخِل مرجع عملية الاسترداد من جهاز الدفع.";
    return null;
  }, [isLocked, selectedLines.length, activeOption?.blockedReason, overCap, railCap, needsShift, shifts.length, shiftId, needsReference, cardReference]);

  async function submit() {
    setError("");
    setDone("");
    if (!inv || blockReason) return;

    const refund = refundD.gt(0)
      ? {
          amount: round2(refundD).toFixed(2),
          method: rail,
          ...(rail === "CASH" ? { shiftId: shiftId! } : {}),
          ...(rail === "CARD" ? { reference: cardReference.trim() } : {}),
        }
      : undefined;

    const pieces = selectedLines.reduce((s, l) => s + l.baseQuantity, 0);
    const moneySentence = refund
      ? `يستلم الزبون ${fmt(refund.amount)} د.ع ${RAIL_LABEL[rail]}`
      : "بلا إرجاع نقود (تُخصَم من ذمّة العميل فقط)";
    const stockSentence = restock ? "والبضاعة تعود للرفّ" : "والبضاعة تالفة لا تعود للمخزون";

    if (
      !(await confirm({
        variant: "danger",
        title: `مرتجع الفاتورة ${inv.invoiceNumber}`,
        description: `ترجع ${selectedLines.length === 1 ? "صنفٌ واحد" : `${selectedLines.length} أصناف`} (${pieces} قطعة) — ${moneySentence}، ${stockSentence}. متابعة؟`,
        confirmText: "تسجيل المرتجع",
      }))
    ) return;

    create.mutate({ invoiceId: inv.id, lines: selectedLines, refund, restock, clientRequestId });
  }

  if (detail.isLoading) return <LoadingState message="جارٍ تحميل بنود الفاتورة…" />;
  if (!inv) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        الفاتورة غير موجودة أو لا تخصّ فرعك.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ① رأس الفاتورة — نفس لغة شاشة الفاتورة المتقدّمة: الحقائق أولاً، بلا قرار. */}
      <Card>
        <CardContent className="grid grid-cols-2 gap-3 p-4 text-sm md:grid-cols-3 xl:grid-cols-5">
          <div><div className="text-xs text-muted-foreground">رقم الفاتورة</div><div className="font-mono font-bold" dir="ltr">{inv.invoiceNumber}</div></div>
          <div><div className="text-xs text-muted-foreground">العميل</div><div>{inv.customerName ?? "عميل نقدي"}</div></div>
          <div><div className="text-xs text-muted-foreground">الإجمالي</div><div className="tabular-nums" dir="ltr">{fmt(inv.total)}</div></div>
          <div><div className="text-xs text-muted-foreground">المقبوض</div><div className="tabular-nums" dir="ltr">{fmt(inv.paidAmount)}</div></div>
          <div>
            <div className="text-xs text-muted-foreground">المتاح للاسترداد</div>
            <div className="font-bold tabular-nums text-money-positive" dir="ltr">{fmt(inv.refundPool)}</div>
          </div>
          {/* الرقم الذي كان غائباً عن الشاشة: بدونه لا يملك الموظّف ما يمنعه من ردّ نقدٍ لمدين. */}
          <div>
            <div className="text-xs text-muted-foreground">المتبقّي على العميل بعد المرتجع</div>
            <div
              className={`font-bold tabular-nums ${customerStillOwes.gt(0) ? "text-money-negative" : "text-muted-foreground"}`}
              dir="ltr"
            >
              {fmt(customerStillOwes.toFixed(2))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ② ماذا يرجع — جدولٌ بأزرار ±، خطوته وحدة البيع فلا يحسب الموظف الوحدة الأساس ذهنياً. */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">ماذا يرجع؟</CardTitle>
          <Button size="sm" variant="outline" onClick={fillAll} disabled={isLocked || items.every((it) => it.remaining <= 0)}>
            إرجاع كامل الفاتورة
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-start">المنتج</th>
                  <th className="p-2 text-center">المُباع</th>
                  <th className="p-2 text-center">أُرجع سابقاً</th>
                  <th className="p-2 text-right">السعر</th>
                  <th className="w-56 p-2 text-center">يرجع الآن</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => {
                  const v = qty[it.invoiceItemId] ?? 0;
                  const step = it.conversionFactor > 1 ? it.conversionFactor : 1;
                  return (
                    <tr key={it.invoiceItemId} className={`border-t ${v > 0 ? "bg-[var(--sem-info-bg)]/40" : ""}`}>
                      <td className="p-2">
                        {it.productName}{it.variantLabel ? ` — ${it.variantLabel}` : ""}
                        {it.conversionFactor > 1 && (
                          <div className="text-[11px] text-muted-foreground">١ {it.unitName} = {it.conversionFactor} قطعة</div>
                        )}
                      </td>
                      <td className="p-2 text-center">{unitsLabel(it.baseQuantity, it.conversionFactor, it.unitName)}</td>
                      <td className="p-2 text-center">{it.returnedBaseQuantity > 0 ? unitsLabel(it.returnedBaseQuantity, it.conversionFactor, it.unitName) : "—"}</td>
                      <td className="p-2 text-right tabular-nums" dir="ltr">{fmt(it.unitPrice)}</td>
                      <td className="p-2">
                        {it.remaining <= 0 ? (
                          <div className="text-center text-xs text-muted-foreground">أُرجع بالكامل</div>
                        ) : (
                          <div className="flex items-center justify-center gap-1" dir="ltr">
                            <Button size="sm" variant="outline" className="h-8 w-8 p-0 font-black" aria-label="أنقص كمية الإرجاع"
                              disabled={isLocked || v <= 0} onClick={() => setQtyClamped(it.invoiceItemId, v - step, it.remaining)}>−</Button>
                            <Input dir="ltr" inputMode="numeric" className="h-8 w-16 text-center font-bold tabular-nums"
                              value={v > 0 ? String(v) : ""} placeholder="0" disabled={isLocked}
                              aria-label={`كمية إرجاع ${it.productName} بالقطعة`}
                              onChange={(e) => {
                                const raw = e.target.value.replace(/[^\d]/g, "");
                                setQtyClamped(it.invoiceItemId, raw ? parseInt(raw, 10) : 0, it.remaining);
                              }} />
                            <Button size="sm" variant="outline" className="h-8 w-8 p-0 font-black" aria-label="زد كمية الإرجاع"
                              disabled={isLocked || v >= it.remaining} onClick={() => setQtyClamped(it.invoiceItemId, v + step, it.remaining)}>+</Button>
                            <Button size="sm" variant="ghost" className="h-8 px-2 text-[11px] font-bold"
                              disabled={isLocked || v >= it.remaining} onClick={() => setQtyClamped(it.invoiceItemId, it.remaining, it.remaining)}>الكل</Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* ③ حالة البضاعة — قرارٌ يجب أن يُرى ببطاقتين، لا checkbox صغيراً يُسهى عنه. */}
      <Card>
        <CardHeader><CardTitle className="text-base">حالة البضاعة العائدة</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="حالة البضاعة العائدة">
            <button type="button" role="radio" aria-checked={restock} disabled={isLocked} onClick={() => setRestock(true)}
              className={`rounded-lg border-2 p-3 text-start text-sm font-bold ${restock ? "border-primary bg-primary/5" : "bg-card hover:bg-muted"}`}>
              سليمة — تعود للرفّ
              <div className="mt-0.5 text-[11px] font-normal text-muted-foreground">تُضاف الكمية للمخزون وتُباع مجدداً</div>
            </button>
            <button type="button" role="radio" aria-checked={!restock} disabled={isLocked} onClick={() => setRestock(false)}
              className={`rounded-lg border-2 p-3 text-start text-sm font-bold ${!restock ? "border-[var(--sem-warn)] bg-[var(--sem-warn-bg)]" : "bg-card hover:bg-muted"}`}>
              تالفة — لا تعود للمخزون
              <div className="mt-0.5 text-[11px] font-normal text-muted-foreground">خسارةٌ على المكتبة، لا تُضاف للرفّ</div>
            </button>
          </div>
        </CardContent>
      </Card>

      {/* ④ كيف يستلم الزبون ماله — رافدان فقط، سقفُ كلٍّ من الخادم، والمحجوب معطَّلٌ بسببه ظاهراً. */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">كيف يستلم الزبون ماله؟</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="طريقة الاسترداد">
            {options.map((o) => {
              const m = o.method as RefundRail;
              const picked = rail === m;
              const blocked = !!o.blockedReason;
              const Icon = m === "CASH" ? Wallet : CreditCard;
              return (
                <button key={m} type="button" role="radio" aria-checked={picked} disabled={blocked || isLocked}
                  onClick={() => { setRail(m); setManualAmount(null); setError(""); }}
                  className={`rounded-lg border-2 p-3 text-start text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50 ${picked && !blocked ? "border-primary bg-primary/5" : "bg-card hover:bg-muted"}`}>
                  <span className="flex items-center gap-1.5"><Icon aria-hidden className="size-4" />{RAIL_LABEL[m]}</span>
                  <div className="mt-0.5 text-[11px] font-normal text-muted-foreground">
                    {blocked ? o.blockedReason : RAIL_HINT[m]}
                  </div>
                  <div className="mt-1 text-[11px] font-bold tabular-nums text-muted-foreground" dir="ltr">
                    حتى {fmt(o.cap)} د.ع
                  </div>
                </button>
              );
            })}
          </div>

          <div className="rounded-lg border bg-muted/30 p-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="text-sm">
                <span className="font-bold">يُعاد للزبون: </span>
                <span className="text-lg font-black tabular-nums" dir="ltr">{fmt(refundAmount || "0")}</span>
                <span className="ms-1 text-sm font-bold">د.ع — {RAIL_LABEL[rail]}</span>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  قيمة المرتجع {fmt(returnValue.toFixed(2))} · المسموح {fmt(railCap.toFixed(2))}
                </div>
              </div>
              <div className="w-44 space-y-1">
                <Label htmlFor="ret-amount" className="text-xs">تعديل المبلغ (اختياري)</Label>
                <MoneyInput
                  id="ret-amount"
                  value={refundAmount}
                  onChange={setManualAmount}
                  ariaLabel="مبلغ الاسترداد"
                  disabled={isLocked}
                  expectedRange={{ max: Number(railCap.toFixed(2)) }}
                />
              </div>
            </div>
            {overCap && (
              <p className="mt-2 text-xs font-bold text-destructive">
                المبلغ يتجاوز المسموح — الحدّ {fmt(railCap.toFixed(2))} د.ع.
              </p>
            )}
          </div>

          {/* الدرج مورد فرعٍ لا مستخدم — يُحدَّد أيّ درجٍ يخرج منه النقد فعلياً قبل الحفظ. */}
          {needsShift && (
            <div className="space-y-1 rounded-lg border bg-muted/30 p-3 text-xs">
              <div className="mb-1.5 font-bold text-foreground">من أيّ درج يخرج النقد؟</div>
              {shifts.length === 0 ? (
                <div className="badge-stock-low flex items-start gap-2 rounded-md border px-2.5 py-2">
                  <AlertTriangle aria-hidden className="size-3.5 shrink-0" />
                  <span>لا توجد وردية مفتوحة في هذا الفرع — افتح وردية، أو استردّ على البطاقة.</span>
                </div>
              ) : (
                <AppSelect size="sm" className="text-xs" aria-label="درج الاسترداد"
                  value={shiftId != null ? String(shiftId) : ""}
                  onValueChange={(v) => setShiftId(v ? Number(v) : null)} placeholder="اختر الدرج…">
                  {shifts.map((s) => (
                    <option key={s.shiftId} value={String(s.shiftId)}>
                      {s.isMine ? "درجي — " : ""}{s.userName} — {shiftTypeLabel(s.shiftType)} (نقد {fmt(s.expectedCash)})
                    </option>
                  ))}
                </AppSelect>
              )}
            </div>
          )}

          {/* الردّ بالبطاقة: إثباتٌ لا إقفال — مرجع الجهاز يفرضه الخادم أيضاً، لا الشاشة وحدها. */}
          {needsReference && (
            <div className="space-y-1 rounded-lg border bg-muted/30 p-3">
              <Label htmlFor="ret-card-ref" className="text-xs">مرجع عملية الاسترداد من جهاز الدفع</Label>
              <Input id="ret-card-ref" dir="ltr" value={cardReference} maxLength={100}
                onChange={(e) => { setCardReference(e.target.value); setError(""); }}
                placeholder="رقم العملية / كود الموافقة" />
              <p className="text-[11px] text-muted-foreground">
                نفّذ الاسترداد على الجهاز أولاً ثمّ أدخِل مرجعه — هو الأثر الذي يربط المبلغ بمستنده.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {blockReason && !error && <p className="text-sm text-muted-foreground">{blockReason}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {done && <p className="text-sm text-money-positive">{done}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={submit} disabled={!!blockReason || create.isPending}>
          {create.isPending ? "جارٍ التسجيل…" : "تأكيد المرتجع"}
        </Button>
        <Button variant="outline" onClick={() => { setQty({}); setManualAmount(null); setCardReference(""); setError(""); setDone(""); }}>
          إعادة ضبط
        </Button>
        {footer}
      </div>
    </div>
  );
}

export default ReturnComposer;
