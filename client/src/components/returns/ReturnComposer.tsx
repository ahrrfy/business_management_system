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
 * السقوف تأتي من `returns.getInvoice` (المحسوبة بنفس دالّة `loadRefundCaps` التي ستحكم على
 * الطلب)، **والروافدُ والأدراجُ من المنتقي الموحَّد `<RefundRailPicker>`** (م٢ ق١٠) الذي يستفتي
 * `refundRails.preflight` بالمبلغ المطلوب ⇒ ما تعراه الشاشة = ما يقبله الخادم بالتعريف.
 * لا تُعِد حساب سقفٍ هنا ولا تُضِف رافداً بنصٍّ ثابت — تلك بالضبط العلّة التي أُصلحت.
 *
 * قرارات المالك المُجسَّدة (١٧/٨/٢٦):
 *  · رافدا الردّ **نقدٌ أو بطاقة فقط** مهما كان رافد القبض (بطاقة/نقد/تحويل/رصيد زين).
 *  · النقد يخرج من **وردية المنفّذ المفتوحة** افتراضاً، أو يختار وردية مفتوحة أخرى صراحةً؛
 *    وبلا وردية مفتوحة يخرج من **الخزينة** للإداريّ (استثناءٌ مصنَّف خادمياً — الخادم يعلنه رافداً).
 *  · الردّ بالبطاقة يُنفَّذ على الجهاز ثمّ يُوثَّق بمرجعه (إثباتٌ لا إقفال).
 */
import { AlertTriangle, CheckCircle2, Clock, Info, RotateCcw, ScanLine, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { LoadingState } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/form/MoneyInput";
import { RefundRailPicker, type RefundRailPickerState } from "@/components/ui/RefundRailPicker";
import { confirm } from "@/lib/confirm";
import { D, fmt, round2 } from "@/lib/money";
import { paymentMethodLabel } from "@/lib/paymentMethod";
import { computeReturnTotal } from "@/lib/returnTotal";
import { trpc } from "@/lib/trpc";
import { allocateOfflineReceiptNumber, assertCanCapture, enqueueOfflineReturn, isOfflineSaleEnabled } from "@/lib/offline/outbox";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { ACTION_LABELS } from "@shared/actionLabels";
import { REFUND_RAIL_LABEL } from "@shared/refundRails";

/** خيارات الأسباب السريعة الذكية لتقليص الطباعة اليدوية والنقرات */
const QUICK_REASONS = [
  "تراجع العميل عن الشراء",
  "عيب مصنعي أو خلل",
  "استبدال بصنف آخر",
  "غير مطابق للمواصفات",
  "تلف أو كسر بالبضاعة",
];

/** «٢ درزن (٢٤ قطعة)» — وللوحدة الأساس أو الكسور: «٢٤ قطعة». */
function unitsLabel(base: number, factor: number, unitName: string): string {
  if (base <= 0) return "0";
  if (factor <= 1) return `${base} ${unitName || "قطعة"}`;
  if (base % factor !== 0) return `${base} قطعة`;
  return `${base / factor} ${unitName} (${base} قطعة)`;
}

export interface ReturnComposerProps {
  invoiceId: number;
  /**
   * اعتمادُ **طلب إرجاعٍ** من موظّف المحطة بدل مرتجعٍ مباشر (١٩/٨).
   * الفارق كلّه في الإجراء المُستدعى: `approveRequest` يفرض فصل المهام واللقطة التفاؤلية
   * ثمّ يُنفّذ **نفس** المسار الماليّ — فلا نسخةَ منطقٍ ثانية ولا شاشةَ اعتمادٍ موازية.
   */
  approvingRequestId?: number | null;
  /** باركود صنف مُمرّر من شريط المسح الخارجي للمعالجة المباشرة */
  scannedBarcode?: string | null;
  /** استدعاء عند معالجة الباركود الخارجي بنجاح */
  onBarcodeHandled?: () => void;
  /** يُستدعى بعد نجاح المرتجع (تحديث قوائم الصفحة المضيفة/التنقّل). */
  onDone?: (result: { fullyReturned: boolean; returnedTotal: string }) => void;
  /** رابط رجوعٍ اختياريّ تعرضه الصفحة المضيفة أسفل الإجراءات. */
  footer?: React.ReactNode;
}

export function ReturnComposer({
  invoiceId,
  approvingRequestId,
  scannedBarcode,
  onBarcodeHandled,
  onDone,
  footer,
}: ReturnComposerProps) {
  const utils = trpc.useUtils();
  const detail = trpc.returns.getInvoice.useQuery({ invoiceId }, { enabled: invoiceId > 0 });
  /** المالك والإداريون والكاشير ينفّذون المرتجع فوراً (محرك المرتجعات الفوري الذري) — الشاشة تعرف ذلك قبل التأكيد لا بعده. */
  const me = trpc.auth.me.useQuery();
  const executesImmediately = me.data?.isOwner === true || ["admin", "manager", "cashier"].includes(me.data?.role ?? "");
  /**
   * ⭐ في وضع الاعتماد نُحمّل **بنود الطلب** — هي التي سينفّذها الخادم، لا ما يُدخله المدير.
   * كان الجدول يُفتَح فارغاً فيُدخل المدير كمّياتٍ يُقسم بها حوارُ التأكيد ثمّ يتجاهلها
   * `approveRequest` (يقرأ `linesJson`). مراجعٌ لا يرى ما يراجعه ليس مراجعاً.
   */
  const requestDetail = trpc.returns.getRequest.useQuery(
    { requestId: approvingRequestId ?? 0 },
    { enabled: !!approvingRequestId && approvingRequestId > 0 },
  );

  const [qty, setQty] = useState<Record<number, number>>({});
  const [fastBarcode, setFastBarcode] = useState("");
  const [restock, setRestock] = useState(true);
  const [manualAmount, setManualAmount] = useState<string | null>(null);
  /**
   * **حالةُ منتقي الروافد الموحَّد** — الرافدُ والدرجُ ومرجعُ البطاقة وسببُ الحجب، كلُّها من
   * الخادم (`refundRails.preflight` بنوع `SALE_RETURN` والمبلغ المطلوب). كانت الشاشة تحمل
   * `rail`/`shiftId`/`cardReference` وقائمةَ أدراجٍ محلّية وقاموسَ تسمياتٍ خاصّاً بها.
   */
  const [railState, setRailState] = useState<RefundRailPickerState | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  // idempotency: مفتاحٌ ثابتٌ للمحاولة، يتجدّد عند تبديل الفاتورة وبعد كل نجاح — نقرةٌ مزدوجة
  // أو إعادة إرسالٍ على شبكةٍ متذبذبة لا تُنشئ مرتجعاً ثانياً ولا تُخرج النقد مرّتين.
  const [clientRequestId, setClientRequestId] = useState(() => crypto.randomUUID());

  // تبديل الفاتورة يصفّر كل قرارٍ سابق (وإلّا سُجّل مرتجعٌ بكميّات فاتورةٍ أخرى).
  useEffect(() => {
    setQty({});
    setFastBarcode("");
    setRestock(true);
    setManualAmount(null);
    setRailState(null);
    setReason("");
    setError("");
    setDone("");
    setClientRequestId(crypto.randomUUID());
  }, [invoiceId]);

  /** بنود الطلب المعلَّق (وضع الاعتماد) — مصدر الحقيقة للكمّيات، تُقفَل ضدّ التعديل. */
  const lockedLines = approvingRequestId ? requestDetail.data?.lines ?? null : null;
  // تُملأ الكمّيات من الطلب مرّةً عند وصولها، فتحسب الشاشة (القيمة/السقف/الحوار) على ما سيُنفَّذ.
  useEffect(() => {
    if (!lockedLines) return;
    const next: Record<number, number> = {};
    for (const l of lockedLines) next[l.invoiceItemId] = l.baseQuantity;
    setQty(next);
  }, [lockedLines]);

  const inv = detail.data;
  const isWalkIn = !!inv?.walkInResolutionPolicy;
  const items = inv?.items ?? [];

  /** قيمة المرتجع — الصيغة في `lib/returnTotal` (مطابقةٌ لفرع الإرجاع الجزئيّ خادمياً، ومُختبَرة وحدها). */
  const returnValue = useMemo(
    () => (inv ? D(computeReturnTotal(inv.items, qty, inv)) : D(0)),
    [inv, qty],
  );

  /**
   * الرافدُ المختار في المنتقي ⇒ طريقةُ الردّ في عقد الخادم: الدرجُ والخزينةُ نقدٌ (`CASH`)،
   * والفرقُ بينهما درجٌ يُرسَل أو لا (بلا درجٍ يوجّه الخادمُ الإداريَّ إلى الخزينة).
   */
  const pickedRail = railState?.selection?.rail ?? null;
  const method: "CASH" | "CARD" = pickedRail === "CARD" ? "CARD" : "CASH";
  const shiftId = pickedRail === "DRAWER" ? railState?.selection?.refundShiftId ?? null : null;
  const cardReference = railState?.selection?.cardReference ?? "";
  const usesTreasury = pickedRail === "TREASURY";

  const options = inv?.refundOptions ?? [];
  // الزبون العابر لا يملك ذمةً تُرحّل إليها القيمة، وعقد الخادم يقبل CASH فقط.
  // لا نعرض رافداً آخر ولو أعاده خادم قديم/منجرف ضمن الخيارات.
  const visibleRefundOptions = isWalkIn
    ? options.filter((option) => option.method === "CASH")
    : options;
  const activeOption = options.find((o) => o.method === method);
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

  /**
   * العميل المسجّل يحتفظ بالمسار القديم. أمّا العابر فالمبلغ ليس قراراً واجهياً: هو قيمة
   * المرتجع الدقيقة المحسوبة (ومنها باقي تقريب IQD عند الإرجاع المُكمِل) ولا يمكن تحريرها.
   */
  const suggestedRefund = useMemo(
    () => isWalkIn ? returnValue : (customerOwedBack.lt(railCap) ? customerOwedBack : railCap),
    [isWalkIn, returnValue, customerOwedBack, railCap],
  );
  const refundAmount = isWalkIn
    ? (suggestedRefund.gt(0) ? suggestedRefund.toFixed(2) : "")
    : manualAmount ?? (suggestedRefund.gt(0) ? suggestedRefund.toFixed(2) : "");
  const refundD = /^\d+(\.\d+)?$/.test(refundAmount.trim()) ? D(refundAmount.trim()) : D(0);
  const overCap = refundD.gt(railCap);

  const selectedLines = useMemo(
    () => Object.entries(qty)
      .map(([id, q]) => ({ invoiceItemId: Number(id), baseQuantity: q }))
      .filter((l) => l.baseQuantity > 0),
    [qty],
  );

  // اعتماد طلبٍ قائم — يشارك نفس معالجات النجاح/الخطأ (سلوكٌ واحد للمستخدم).
  const approve = trpc.returns.approveRequest.useMutation({
    onSuccess: async (res) => {
      setDone("اعتُمد الطلب ونُفِّذ المرتجع.");
      setQty({});
      setManualAmount(null);
      setReason("");
      setClientRequestId(crypto.randomUUID());
      await utils.returns.requests.invalidate();
      await utils.returns.getInvoice.invalidate({ invoiceId });
      onDone?.({ fullyReturned: !!res.fullyReturned, returnedTotal: String(res.returnedTotal ?? "0") });
    },
    onError: (e) => setError(e.message),
  });

  /**
   * ⭐ **التقاطُ مرتجعٍ نقديّ عند فشل النقل فعلاً** (تدقيق ١/٩/٢٦ — البند الرابع).
   *
   * كان الأوفلاين بلا مرتجعٍ ولا طابور، فالزبونُ يعود ببضاعته أثناء الانقطاع ولا مسارَ أمام
   * الموظّف إلّا الدفعُ من خارج النظام والتسجيلُ لاحقاً — مصدرُ النقد اليتيم والعجز غير
   * المفسَّر في Z-report. الالتقاطُ يجعل الدينارَ موثَّقاً من لحظته.
   *
   * ⛔ **حدودٌ صريحة، ولا واحدٌ منها تجميليّ:**
   *  · **عند فشل النقل حصراً** (`Failed to fetch`) لا بالاختيار — نفس عقد الكاشير.
   *  · **نقدٌ فقط** (`method === "CASH"`) — البطاقة تحتاج جهازاً والآجل يحتاج سقفاً حيّاً.
   *  · **المالك وحده**: التنفيذ الفوريّ سلطتُه، والتقاطُ «طلبٍ» يترك النقدَ بلا مستند.
   *  · صمّاما الكاشير نفساهما: عمرُ اللقطة ≤٤٨س وسقفُ الطابور (`assertCanCapture`).
   *  · **السقفُ الماليّ يُقيَّم خادمياً عند الترحيل** — رفضُه يُعلّق العنصر في طابور
   *    الاسترداد بقناة RETURN لمراجعة المدير، فيصير العجزُ موثَّقاً بمستندٍ لا ضياعاً صامتاً.
   */
  async function captureOfflineReturn(): Promise<boolean> {
    const isOwner = me.data?.isOwner === true;
    if (!inv || !isOwner || method !== "CASH" || !refundD.gt(0)) return false;
    if (!(await isOfflineSaleEnabled())) {
      notify.errBig(
        "العمل دون اتصال مُعطَّل على هذا الجهاز",
        "عُطِّل يدوياً من «إعدادات الجهاز» في شارة المزامنة — أعِد تفعيله ليقبل المرتجع أثناء الانقطاع.",
      );
      return false;
    }
    const gate = await assertCanCapture(refundD.toNumber());
    if (!gate.ok) {
      notify.errBig(gate.reason);
      return false;
    }
    const receiptNumber = await allocateOfflineReceiptNumber(inv.branchId);
    const ok = await enqueueOfflineReturn({
      payload: {
        branchId: inv.branchId,
        shiftId: shiftId ?? null,
        invoiceId: inv.id,
        lines: selectedLines,
        refund: {
          amount: round2(refundD).toFixed(2),
          method: "CASH",
          ...(shiftId != null ? { shiftId } : {}),
        },
        restock,
        reason: reason.trim(),
        clientRequestId,
      },
      offlineReceiptNumber: receiptNumber,
      total: round2(refundD).toFixed(2),
    });
    if (!ok) {
      notify.errBig("تعذّر حفظ المرتجع في طابور المزامنة — لا تُسلّم النقد قبل نجاح الحفظ.");
      return false;
    }
    setDone(`التُقط المرتجع دون اتصال برقم ${receiptNumber} — يُرحَّل تلقائياً عند عودة الشبكة.`);
    setQty({});
    setManualAmount(null);
    setReason("");
    setClientRequestId(crypto.randomUUID());
    return true;
  }

  const create = trpc.returns.create.useMutation({
    onSuccess: async (res) => {
      /**
       * العائدُ نوعٌ مُميَّزٌ بـ`mode` (قرار المالك ١/٩/٢٦): المالكُ يُنفَّذ مرتجعُه فوراً،
       * وغيرُه يُرسل طلباً. الشاشة تقول أيَّهما وقع — لا نصّاً واحداً يصف الحالتين.
       */
      const isExecuted = res.mode === "EXECUTED" || (res as { status?: string }).status === "APPROVED";
      if (isExecuted) {
        const total = "returnedTotal" in res && res.returnedTotal ? ` بقيمة ${fmt(String(res.returnedTotal))} د.ع` : "";
        setDone(`نُفِّذ المرتجع فعلاً${total} — تحرّك المخزون والمال.`);
      } else {
        setDone(`أُرسل طلب المرتجع #${res.requestId} للاعتماد — لم يتغيّر المخزون أو المال بعد.`);
      }
      setQty({});
      setManualAmount(null);
      setReason("");
      setClientRequestId(crypto.randomUUID());
      await Promise.all([
        utils.returns.getInvoice.invalidate({ invoiceId }),
        utils.salesControl.list.invalidate(),
      ]);
      if (isExecuted) {
        onDone?.({
          fullyReturned: "fullyReturned" in res ? !!res.fullyReturned : false,
          returnedTotal: "returnedTotal" in res ? String(res.returnedTotal ?? "0") : "0",
        });
      }
    },
    onError: (e) => {
      // انقطاعُ الشبكة ≠ رفضُ أعمال: الأوّل يُلتقَط، والثاني يُعرَض. الخلطُ بينهما يبتلع
      // رفضاً مشروعاً في طابورٍ أو يُفقد نقداً خرج فعلاً.
      const isTransport = /Failed to fetch|NetworkError|Load failed|ERR_INTERNET_DISCONNECTED/i.test(e.message);
      if (isTransport) {
        void captureOfflineReturn().then((captured) => {
          if (!captured) setError(e.message);
        });
        return;
      }
      setError(e.message);
    },
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

  /** مسح الباركود السريع للأصناف لزيادة الكمية المرتجعة فوراً */
  function handleFastItemScan(barcodeToMatch?: string) {
    const code = (barcodeToMatch ?? fastBarcode).trim();
    if (!code || !inv) return;

    const codeLower = code.toLowerCase();
    const matched = items.find(
      (it) =>
        (it.barcode && String(it.barcode).toLowerCase() === codeLower) ||
        (it.sku && String(it.sku).toLowerCase() === codeLower) ||
        it.productName.toLowerCase().includes(codeLower)
    );

    if (!matched) {
      notify.err(`الصنف بالرمز "${code}" غير موجود في هذه الفاتورة!`);
      setFastBarcode("");
      return;
    }

    const currentQty = qty[matched.invoiceItemId] ?? 0;
    const step = matched.conversionFactor > 1 ? matched.conversionFactor : 1;
    const remaining = matched.remaining;

    if (currentQty >= remaining) {
      notify.err(`تم استيفاء الحد الأقصى لإرجاع "${matched.productName}" (${remaining} قطعة)`);
      setFastBarcode("");
      return;
    }

    const nextQty = Math.min(remaining, currentQty + step);
    setQtyClamped(matched.invoiceItemId, nextQty, remaining);
    notify.ok(`تمت إضافة ${matched.productName} (+${step}) للإرجاع`);
    setFastBarcode("");
  }

  useEffect(() => {
    if (scannedBarcode && items.length > 0) {
      handleFastItemScan(scannedBarcode);
      onBarcodeHandled?.();
    }
  }, [scannedBarcode, items.length]);

  /** الكمّيات غير قابلة للتعديل في وضع الاعتماد: الخادم ينفّذ بنود الطلب لا إدخال المدير. */
  const qtyLocked = !!approvingRequestId;
  const isLocked = inv?.status === "RETURNED" || inv?.status === "CANCELLED";
  /** الطلب المعلّق على هذه الفاتورة (الحوكميّ أو القديم) — الخادم مصدرُه، لا اشتقاقٌ في الشاشة. */
  const pending = inv?.pendingRequest ?? null;
  /**
   * مرتجعٌ بلا ردّ نقديّ (بلاغ المالك ١٨/٨) — فاتورةٌ لم يُقبض عليها دينار (آجلة/COD/عربونٌ
   * أقلّ) أو قيمةُ المرتجع تُغطّيها الذمّة: **لا مال يخرج**، فلا رافدَ ولا درجَ ولا مرجع.
   * الخادم يقبل هذا أصلاً (returnService: كتلة الردّ تُتخطّى عند صفر)، لكن الشاشة كانت تُعطّل
   * زرّ التأكيد كلّياً لأنّ كلا الرافدين «محجوب» حين يكون وعاء المقبوض صفراً — فيُقرأ ذلك
   * «النظام يجبرني على اختيار درجٍ لردّ نقودٍ لم تُقبض».
   */
  const noRefundNeeded = !isWalkIn && refundD.lte(0);

  /** سببُ تعطيل الحفظ — نصٌّ واحدٌ يُعرَض دائماً بدل رفضٍ متأخّر من الخادم. */
  const blockReason = useMemo(() => {
    if (isLocked) return "هذه الفاتورة مرتجعة/ملغاة — لا يمكن تسجيل مرتجع جديد.";
    // لا اعتماد قبل أن تصل بنود الطلب — وإلّا اعتمد المدير على جدولٍ فارغ لا يمثّل ما سيُنفَّذ.
    if (approvingRequestId && !lockedLines) return "جارٍ تحميل بنود الطلب المطلوب اعتماده…";
    // طلبٌ معلّقٌ قائم ⇒ الخادم يرفض الثاني بالفهرس الفريد. نقولها هنا بدل خطأٍ خامّ بعد الملء.
    if (pending && !approvingRequestId) {
      return `على هذه الفاتورة طلبٌ معلّق #${pending.id} — احسمه أولاً (اعتماداً أو رفضاً) قبل إرسال طلبٍ جديد.`;
    }
    if (!approvingRequestId && me.data?.role === "cashier") {
      const cashierHasShift = inv?.refundShifts?.some((s) => s.isMine || Number(s.userId) === Number(me.data?.id));
      if (!cashierHasShift) {
        return "يشترط وجود وردية مفتوحة للكاشير في فرع الفاتورة لتنفيذ المرتجع.";
      }
    }
    if (!selectedLines.length) return "حدّد كمية إرجاع واحدة على الأقل.";
    if (isWalkIn && !returnValue.gt(0)) return "قيمة المرتجع صفر؛ لا يمكن إنشاء تسوية نقدية لزبون عابر.";
    // حجبُ الرافد يسري على ردٍّ **موجب** فقط — لا معنى لسقفٍ حين لا يخرج مال.
    if (!noRefundNeeded && activeOption?.blockedReason) return activeOption.blockedReason;
    if (overCap) return `المبلغ يتجاوز المسموح (${fmt(railCap.toFixed(2))} د.ع).`;
    // مالٌ يخرج ⇒ الرافدُ والدرجُ والمرجعُ من المنتقي الموحَّد — سببُ حجبه مقروءٌ من الخادم.
    if (!noRefundNeeded && refundD.gt(0)) {
      if (railState == null || railState.loading) return "جارٍ التحقق من روافد الردّ والأدراج المفتوحة…";
      if (railState.error) return `تعذّر التحقق من روافد الردّ — ${railState.error}`;
      if (railState.blockReason) return railState.blockReason;
      if (!railState.selection) return "حدّد من أين يخرج المال.";
    }
    if (reason.trim().length < 3) return "اكتب سبب المرتجع (٣ أحرف على الأقل) لتوثيق الطلب.";
    return null;
  }, [isLocked, pending, approvingRequestId, lockedLines, me.data?.role, me.data?.id, inv?.refundShifts, selectedLines.length, isWalkIn, returnValue, noRefundNeeded, activeOption?.blockedReason, overCap, railCap, refundD, railState, reason]);

  async function submit() {
    setError("");
    setDone("");
    if (!inv || blockReason) return;

    const refund = !isWalkIn && refundD.gt(0)
      ? {
          amount: round2(refundD).toFixed(2),
          method,
          ...(method === "CASH" && shiftId != null ? { shiftId } : {}),
          ...(method === "CARD" ? { reference: cardReference.trim() } : {}),
        }
      : undefined;
    const resolution = isWalkIn
      ? {
          kind: "IMMEDIATE_REFUND" as const,
          method: "CASH" as const,
          amount: round2(returnValue).toFixed(2),
          ...(shiftId != null ? { shiftId } : {}),
          reason: reason.trim(),
          disposition: restock ? "RESTOCK" as const : "DAMAGED" as const,
        }
      : undefined;

    const pieces = selectedLines.reduce((s, l) => s + l.baseQuantity, 0);
    const railLabel = pickedRail ? REFUND_RAIL_LABEL[pickedRail] : REFUND_RAIL_LABEL.DRAWER;
    const cashSource = usesTreasury ? "من خزينة الفرع" : "من الدرج المحدّد";
    const moneySentence = resolution
      ? `يستلم الزبون العابر ${fmt(resolution.amount)} د.ع نقداً كاملاً ${cashSource}`
      : refund
        ? `يستلم الزبون ${fmt(refund.amount)} د.ع عبر ${railLabel}`
      : "بلا إرجاع نقود (تُخصَم من ذمّة العميل فقط)";
    const stockSentence = restock ? "والبضاعة تعود للرفّ" : "والبضاعة تالفة لا تعود للمخزون";
    const scope = `${selectedLines.length === 1 ? "صنفٌ واحد" : `${selectedLines.length} أصناف`} (${pieces} قطعة)`;

    /**
     * ⭐ حوارُ التأكيد يقول الحقيقة (تدقيق ١/٩/٢٦ — بلاغ «المرتجع وهميّ»).
     * كان يُعنوَن «مرتجع الفاتورة» وزرُّه «تسجيل المرتجع» ويصف تسليم النقود وعودة البضاعة
     * للرفّ **بصيغة الحاضر** — بينما `returns.create` طلبٌ صفريّ الأثر لا يُنفَّذ حتى يعتمده
     * مراجعٌ مستقل. فيسلّم الموظّف البضاعة والنقود على وعدٍ لم يقع. المسار الوحيد الذي
     * ينفّذ فوراً هو اعتماد طلبٍ قائم (`approvingRequestId`).
     */
    if (
      !(await confirm({
        variant: (approvingRequestId || executesImmediately) ? "danger" : "warning",
        title: approvingRequestId
          ? `اعتماد وتنفيذ مرتجع الفاتورة ${inv.invoiceNumber}`
          : executesImmediately
            ? `تنفيذ مرتجع الفاتورة ${inv.invoiceNumber} الآن`
            : `إرسال طلب مرتجع للفاتورة ${inv.invoiceNumber}`,
        description: (approvingRequestId || executesImmediately)
          ? `يُنفَّذ الأثر الآن: ترجع ${scope} — ${moneySentence}، ${stockSentence}.${executesImmediately && !approvingRequestId ? (me.data?.isOwner ? " تنفيذٌ فوريّ بصفتك المالك، موثَّقٌ بسببه في سجلّ التدقيق." : " تنفيذٌ فوريّ ذريّ، موثَّقٌ بسببه في سجلّ التدقيق.") : ""} متابعة؟`
          : `ترسل طلباً بإرجاع ${scope} — وعند الاعتماد ${moneySentence}، ${stockSentence}.\n\nتنبيه: لا تسلّم الزبون نقوداً ولا تستلم البضاعة على هذا الطلب: لا يتغيّر المخزون ولا المال حتى يعتمده مراجعٌ مستقل (غيرك وغير منشئ الفاتورة).`,
        confirmText: approvingRequestId ? "اعتماد وتنفيذ" : executesImmediately ? "تنفيذ المرتجع" : "إرسال الطلب للاعتماد",
      }))
    ) return;

    if (approvingRequestId) {
      approve.mutate({
        requestId: approvingRequestId,
        refund,
        resolution,
        ...(!isWalkIn ? { restock } : {}),
        clientRequestId,
      });
      return;
    }
    create.mutate({
      invoiceId: inv.id,
      lines: selectedLines,
      refund,
      resolution,
      ...(!isWalkIn ? { restock } : {}),
      reason: reason.trim(),
      clientRequestId,
      directExecution: executesImmediately,
    });
  }

  /**
   * ⭐ إرجاع فوري ذكي لكامل الفاتورة بنقرة واحدة (One-Click Express Return)
   * يملأ كافة البنود، يضع سبباً نظامياً تلقائياً، يحسب التسوية الذرية ويعرض تأكيداً واحداً شاملاً.
   */
  async function triggerExpressReturn() {
    if (isLocked) {
      notify.err("هذه الفاتورة مقفلة أو مرتجعة بالكامل.");
      return;
    }
    const eligible = items.filter((it) => it.remaining > 0);
    if (!eligible.length) {
      notify.err("لا توجد بنود قابلة للإرجاع في هذه الفاتورة.");
      return;
    }

    const fullQty: Record<number, number> = {};
    for (const it of eligible) {
      fullQty[it.invoiceItemId] = it.remaining;
    }
    setQty(fullQty);

    const effectiveReason = reason.trim() || "إرجاع كامل الفاتورة — تسوية سريعة";
    if (!reason.trim()) {
      setReason(effectiveReason);
    }

    const fullReturnValue = inv ? D(computeReturnTotal(inv.items, fullQty, inv)) : D(0);
    const netAfter = D(inv?.total ?? "0").minus(D(inv?.returnedTotal ?? "0")).minus(fullReturnValue);
    const over = D(inv?.paidAmount ?? "0").minus(netAfter);
    const fullCustomerOwedBack = over.gt(0) ? over : D(0);
    const fullRailCap = fullReturnValue.lte(D(activeOption?.cap ?? "0")) ? fullReturnValue : D(activeOption?.cap ?? "0");
    const fullSuggestedRefund = isWalkIn ? fullReturnValue : (fullCustomerOwedBack.lt(fullRailCap) ? fullCustomerOwedBack : fullRailCap);
    const fullRefundAmount = fullSuggestedRefund.gt(0) ? fullSuggestedRefund.toFixed(2) : "0.00";
    const fullRefundD = D(fullRefundAmount);

    if (!noRefundNeeded && fullRefundD.gt(0) && railState?.blockReason) {
      notify.err(railState.blockReason);
      return;
    }

    const linesToSubmit = eligible.map((it) => ({
      invoiceItemId: it.invoiceItemId,
      baseQuantity: it.remaining,
    }));

    const fullRefund = !isWalkIn && fullRefundD.gt(0)
      ? {
          amount: round2(fullRefundD).toFixed(2),
          method,
          ...(method === "CASH" && shiftId != null ? { shiftId } : {}),
          ...(method === "CARD" ? { reference: cardReference.trim() } : {}),
        }
      : undefined;

    const fullResolution = isWalkIn
      ? {
          kind: "IMMEDIATE_REFUND" as const,
          method: "CASH" as const,
          amount: round2(fullReturnValue).toFixed(2),
          ...(shiftId != null ? { shiftId } : {}),
          reason: effectiveReason,
          disposition: restock ? ("RESTOCK" as const) : ("DAMAGED" as const),
        }
      : undefined;

    const totalPieces = linesToSubmit.reduce((s, l) => s + l.baseQuantity, 0);
    const railLabel = pickedRail ? REFUND_RAIL_LABEL[pickedRail] : REFUND_RAIL_LABEL.DRAWER;
    const cashSource = usesTreasury ? "من خزينة الفرع" : "من الدرج المفتوح";
    const moneySentence = fullResolution
      ? `استرداد ${fmt(fullResolution.amount)} د.ع نقداً ${cashSource}`
      : fullRefund
        ? `استرداد ${fmt(fullRefund.amount)} د.ع عبر ${railLabel}`
        : "بلا إرجاع نقد (تسوية ذمة العميل)";

    const confirmed = await confirm({
      variant: (approvingRequestId || executesImmediately) ? "danger" : "warning",
      title: `إرجاع فوري لكامل الفاتورة ${inv?.invoiceNumber}`,
      description: `سيتم إرجاع جميع بنود الفاتورة المتبقية (${linesToSubmit.length} صنف · ${totalPieces} قطعة) مع ${moneySentence}. هل تؤكد التنفيذ الفوري؟`,
      confirmText: approvingRequestId ? "اعتماد وتنفيذ فوراً" : executesImmediately ? "تنفيذ فوري مباشر" : "إرسال الطلب للاعتماد",
    });

    if (!confirmed) return;

    if (approvingRequestId) {
      approve.mutate({
        requestId: approvingRequestId,
        refund: fullRefund,
        resolution: fullResolution,
        ...(!isWalkIn ? { restock } : {}),
        clientRequestId,
      });
    } else if (inv) {
      create.mutate({
        invoiceId: inv.id,
        lines: linesToSubmit,
        refund: fullRefund,
        resolution: fullResolution,
        ...(!isWalkIn ? { restock } : {}),
        reason: effectiveReason,
        clientRequestId,
      });
    }
  }

  if (detail.isLoading) return <LoadingState message="جارٍ تحميل بنود الفاتورة…" />;
  if (detail.isError) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-destructive space-y-1">
        <div className="flex items-center gap-2 font-bold text-sm">
          <AlertTriangle aria-hidden className="size-4 shrink-0 text-destructive" />
          <span>تعذّر تحميل تفاصيل الفاتورة للمرتجع</span>
        </div>
        <p className="text-xs text-muted-foreground">{detail.error.message}</p>
      </div>
    );
  }
  if (!inv) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        الفاتورة غير موجودة أو لا تخصّ فرعك.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* الطلب المعلق إن وجد */}
      {pending && !approvingRequestId && (
        <Card className="border-[var(--sem-warn)]/50 bg-[var(--sem-warn-bg)]/30">
          <CardContent className="flex items-start gap-2 p-4 text-sm">
            <Clock aria-hidden className="mt-0.5 size-4 shrink-0 text-[var(--sem-warn)]" />
            <div className="space-y-1">
              <p className="font-bold text-[var(--sem-warn)]">
                على هذه الفاتورة طلبٌ معلّق #{pending.id} بانتظار مراجعٍ مستقل — لم يتغيّر المخزون ولا المال بعد.
              </p>
              <p className="text-muted-foreground">
                طلبه {pending.requestedByName ?? `المستخدم ${pending.requestedBy}`}
                {pending.isMine ? " (أنت)" : ""}؛ السبب: {pending.reason}.
              </p>
              <p className="text-muted-foreground">
                {pending.canReviewIt
                  ? "تستطيع اعتماده من تبويب «طلبات العمليات» في المبيعات."
                  : pending.isMine
                    ? "لا تعتمد طلبك بنفسك (فصل المهام) — يعتمده مديرٌ آخر لم يُنشئ الفاتورة."
                    : "أنت منشئ هذه الفاتورة فلا تراجع إرجاعها — يعتمده مديرٌ آخر."}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {isLocked && (
        <Card className="border-[var(--sem-warn)]/50 bg-[var(--sem-warn-bg)]/30">
          <CardContent className="flex items-start gap-2.5 p-4 text-sm">
            <AlertTriangle aria-hidden className="mt-0.5 size-5 shrink-0 text-[var(--sem-warn)]" />
            <div className="space-y-1">
              <p className="font-bold text-[var(--sem-warn)]">
                {inv.status === "RETURNED"
                  ? "هذه الفاتورة تم استرجاعها بالكامل مسبقاً — لا يمكن تسجيل أي مرتجع جديد عليها."
                  : "هذه الفاتورة ملغاة مسبقاً — لا يمكن تسجيل أي مرتجع جديد عليها."}
              </p>
              <p className="text-xs text-muted-foreground">
                إجمالي ما أُرجع: {fmt(inv.returnedTotal ?? "0")} د.ع من أصل {fmt(inv.total)} د.ع.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ① ملخص الفاتورة والمبالغ — شريط مكثف ومباشر */}
      <Card>
        <CardContent className="grid grid-cols-2 gap-3 p-4 text-xs sm:text-sm md:grid-cols-3 xl:grid-cols-6">
          <div><div className="text-xs text-muted-foreground">رقم الفاتورة</div><div className="font-mono font-bold" dir="ltr">{inv.invoiceNumber}</div></div>
          <div><div className="text-xs text-muted-foreground">العميل</div><div className="font-semibold">{inv.customerName ?? "عميل نقدي"}</div></div>
          <div><div className="text-xs text-muted-foreground">الإجمالي</div><div className="tabular-nums font-bold" dir="ltr">{fmt(inv.total)}</div></div>
          <div><div className="text-xs text-muted-foreground">المقبوض</div><div className="tabular-nums" dir="ltr">{fmt(inv.paidAmount)}</div></div>
          <div>
            <div className="text-xs text-muted-foreground">المتاح للاسترداد</div>
            <div className="font-bold tabular-nums text-money-positive" dir="ltr">{fmt(inv.refundPool)}</div>
          </div>
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

      {/* ② بنود الفاتورة مع مسح الباركود السريع وأزرار الإرجاع الذكي */}
      <Card>
        <CardHeader className="p-3 pb-2 flex flex-col sm:flex-row sm:items-center justify-between gap-2 space-y-0">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">بنود الإرجاع</CardTitle>
            <Badge variant="secondary" className="text-xs font-mono">
              {selectedLines.length} من {items.length} صنف
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* مسح باركود الصنف السريع */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleFastItemScan();
              }}
              className="flex items-center gap-1.5"
            >
              <div className="relative">
                <ScanLine className="absolute right-2.5 top-2 size-3.5 text-muted-foreground" aria-hidden />
                <Input
                  value={fastBarcode}
                  onChange={(e) => setFastBarcode(e.target.value)}
                  placeholder="امسح باركود صنف..."
                  className="h-8 w-44 pr-8 font-mono text-xs"
                  disabled={isLocked || qtyLocked}
                />
              </div>
              <Button
                type="submit"
                size="sm"
                variant="outline"
                className="h-8 px-2.5 text-xs"
                disabled={isLocked || qtyLocked || !fastBarcode.trim()}
              >
                إضافة
              </Button>
            </form>

            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs font-semibold"
              onClick={fillAll}
              disabled={isLocked || items.every((it) => it.remaining <= 0)}
            >
              تحديد الكل
            </Button>

            <Button
              size="sm"
              variant="default"
              className="h-8 gap-1 text-xs font-bold bg-primary hover:bg-primary/90 text-primary-foreground"
              onClick={triggerExpressReturn}
              disabled={isLocked || items.every((it) => it.remaining <= 0) || create.isPending || approve.isPending}
            >
              <Zap className="size-3.5" aria-hidden />
              <span>إرجاع فوري لكامل الفاتورة</span>
            </Button>
          </div>
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
                        <div className="font-semibold">{it.productName}{it.variantLabel ? ` — ${it.variantLabel}` : ""}</div>
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
                              disabled={isLocked || qtyLocked || v <= 0} onClick={() => setQtyClamped(it.invoiceItemId, v - step, it.remaining)}>−</Button>
                            <Input dir="ltr" inputMode="numeric" className="h-8 w-16 text-center font-bold tabular-nums"
                              value={v > 0 ? String(v) : ""} placeholder="0" disabled={isLocked || qtyLocked}
                              aria-label={`كمية إرجاع ${it.productName} بالقطعة`}
                              onChange={(e) => {
                                const raw = e.target.value.replace(/[^\d]/g, "");
                                setQtyClamped(it.invoiceItemId, raw ? parseInt(raw, 10) : 0, it.remaining);
                              }} />
                            <Button size="sm" variant="outline" className="h-8 w-8 p-0 font-black" aria-label="زد كمية الإرجاع"
                              disabled={isLocked || qtyLocked || v >= it.remaining} onClick={() => setQtyClamped(it.invoiceItemId, v + step, it.remaining)}>+</Button>
                            <Button size="sm" variant="ghost" className="h-8 px-2 text-[11px] font-bold"
                              disabled={isLocked || qtyLocked || v >= it.remaining} onClick={() => setQtyClamped(it.invoiceItemId, it.remaining, it.remaining)}>الكل</Button>
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

      {/* ③ خيارات التسوية والاسترداد الرشيقة في لوحة مدمجة */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* العمود الأيمن: التوثيق السريع وحالة البضاعة */}
        <div className="lg:col-span-5 space-y-3">
          <Card>
            <CardHeader className="p-3 pb-2">
              <CardTitle className="text-sm font-bold">سبب الإرجاع والتوثيق</CardTitle>
            </CardHeader>
            <CardContent className="p-3 pt-0 space-y-3">
              <div className="space-y-1.5">
                <div className="flex flex-wrap gap-1">
                  {QUICK_REASONS.map((qr) => (
                    <button
                      key={qr}
                      type="button"
                      disabled={isLocked}
                      onClick={() => {
                        setReason(qr);
                        setError("");
                      }}
                      className={cn(
                        "rounded-md border px-2 py-0.5 text-xs transition-colors",
                        reason === qr
                          ? "bg-primary text-primary-foreground border-primary font-bold"
                          : "bg-muted/50 hover:bg-muted text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {qr}
                    </button>
                  ))}
                </div>
                <Input
                  id="ret-reason"
                  value={reason}
                  maxLength={500}
                  disabled={isLocked}
                  onChange={(event) => { setReason(event.target.value); setError(""); }}
                  placeholder="اختر سبباً من الأزرار أو اكتب هنا..."
                  className="h-9 text-xs"
                />
              </div>

              {/* حالة البضاعة */}
              <div className="space-y-1">
                <Label className="text-xs font-semibold">حالة البضاعة العائدة</Label>
                <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="حالة البضاعة العائدة">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={restock}
                    disabled={isLocked}
                    onClick={() => setRestock(true)}
                    className={`rounded-lg border p-2.5 text-start text-xs font-bold transition-all ${restock ? "border-primary bg-primary/10 text-primary" : "bg-card hover:bg-muted text-muted-foreground"}`}
                  >
                    سليمة — تعود للرفّ
                    <div className="mt-0.5 text-[10px] font-normal text-muted-foreground">تُضاف للمخزون للبيع ثانية</div>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!restock}
                    disabled={isLocked}
                    onClick={() => setRestock(false)}
                    className={`rounded-lg border p-2.5 text-start text-xs font-bold transition-all ${!restock ? "border-[var(--sem-warn)] bg-[var(--sem-warn-bg)]/60 text-stock-low" : "bg-card hover:bg-muted text-muted-foreground"}`}
                  >
                    تالفة — هدر وعزل
                    <div className="mt-0.5 text-[10px] font-normal text-muted-foreground">خسارة ولا تُضاف للرفّ</div>
                  </button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* العمود الأيسر: طريقة الاسترداد ومنتقي الرافد والدرج */}
        <div className="lg:col-span-7 space-y-3">
          {noRefundNeeded ? (
            <Card>
              <CardHeader className="p-3 pb-2"><CardTitle className="text-sm font-bold">تسوية الذمة (لا يُرَدّ نقد)</CardTitle></CardHeader>
              <CardContent className="p-3 pt-0">
                <div className="flex items-start gap-2 rounded-lg border border-[var(--sem-info)]/45 bg-[var(--sem-info-bg)] p-3 text-xs font-semibold text-[var(--sem-info)]">
                  <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
                  <div>
                    <div>لم يُقبض من هذه الفاتورة ما يُستردّ — قيمة المرتجع تُخصَم من المتبقّي عليها{inv?.customerId != null ? " ومن ذمّة العميل" : ""}.</div>
                    <div className="mt-1 text-[11px] font-normal">
                      المرتجع {fmt(returnValue.toFixed(2))} د.ع · المدفوع على الفاتورة {fmt(D(inv?.paidAmount ?? "0").toFixed(2))} د.ع
                      {customerStillOwes.gt(0) ? ` · يبقى على العميل ${fmt(customerStillOwes.toFixed(2))} د.ع` : ""}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader className="p-3 pb-2"><CardTitle className="text-sm font-bold">الاسترداد المالي والدرج</CardTitle></CardHeader>
              <CardContent className="p-3 pt-0 space-y-3">
                {/* سقوف الرد */}
                <ul className="grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2">
                  {visibleRefundOptions.map((o) => (
                    <li key={o.method} className="rounded-md border bg-muted/30 px-2 py-1">
                      <span className="font-bold text-foreground">{paymentMethodLabel(o.method)}</span>
                      {o.blockedReason ? (
                        <span> — {o.blockedReason}</span>
                      ) : (
                        <span dir="ltr" className="ms-1 tabular-nums font-semibold"> حتى {fmt(o.cap)} د.ع</span>
                      )}
                    </li>
                  ))}
                </ul>

                <div className="rounded-lg border bg-muted/20 p-2.5">
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div className="text-xs sm:text-sm">
                      <span className="font-bold">يُعاد للزبون: </span>
                      <span className="text-base sm:text-lg font-black tabular-nums text-primary" dir="ltr">{fmt(refundAmount || "0")}</span>
                      <span className="ms-1 text-xs font-bold">د.ع{pickedRail ? ` — ${REFUND_RAIL_LABEL[pickedRail]}` : ""}</span>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        قيمة المرتجع {fmt(returnValue.toFixed(2))} · المسموح {fmt(railCap.toFixed(2))}
                      </div>
                    </div>
                    {isWalkIn ? (
                      <div className="rounded-md border border-[var(--sem-info)]/35 bg-[var(--sem-info-bg)] px-2.5 py-1.5 text-xs font-bold text-[var(--sem-info)]">
                        مبلغ ثابت بعد التقريب (زبون عابر)
                      </div>
                    ) : (
                      <div className="w-36 space-y-1">
                        <Label htmlFor="ret-amount" className="text-[11px]">تعديل المبلغ (اختياري)</Label>
                        <MoneyInput
                          id="ret-amount"
                          value={refundAmount}
                          onChange={setManualAmount}
                          ariaLabel="مبلغ الاسترداد"
                          disabled={isLocked}
                          expectedRange={{ max: Number(railCap.toFixed(2)) }}
                        />
                      </div>
                    )}
                  </div>
                  {overCap && (
                    <p className="mt-2 text-xs font-bold text-destructive">
                      المبلغ يتجاوز المسموح — الحدّ {fmt(railCap.toFixed(2))} د.ع.
                    </p>
                  )}
                </div>

                {refundD.gt(0) ? (
                  <RefundRailPicker
                    context={{
                      sourceDocType: "SALE_RETURN",
                      sourceDocId: invoiceId,
                      amount: round2(refundD).toFixed(2),
                    }}
                    mode="embedded"
                    onStateChange={setRailState}
                    drawerLabel="من أيّ درج يخرج النقد؟"
                    drawerHint="النقد يخرج من الدرج المختار عند تنفيذ المرتجع، ويظهر في تسويته."
                    submitting={create.isPending || approve.isPending}
                  />
                ) : null}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {blockReason && !error && <p className="text-sm font-semibold text-muted-foreground">{blockReason}</p>}
      {error && <p className="text-sm font-semibold text-destructive">{error}</p>}
      {done && <p className="text-sm font-bold text-money-positive">{done}</p>}

      {/* شريط الأوامر والتنفيذ */}
      <div className="flex flex-wrap items-center gap-2 pt-1 border-t">
        <Button
          onClick={submit}
          disabled={!!blockReason || create.isPending || approve.isPending}
          className="font-bold text-xs sm:text-sm gap-1.5"
        >
          <CheckCircle2 className="size-4" aria-hidden />
          <span>
            {create.isPending ? ACTION_LABELS.sending : approvingRequestId ? "اعتماد وتنفيذ المرتجع" : executesImmediately ? "تنفيذ المرتجع الآن" : "إرسال طلب المرتجع"}
          </span>
        </Button>

        <Button
          variant="secondary"
          onClick={triggerExpressReturn}
          disabled={isLocked || items.every((it) => it.remaining <= 0) || create.isPending || approve.isPending}
          className="font-bold text-xs sm:text-sm gap-1.5"
        >
          <Zap className="size-4" aria-hidden />
          <span>إرجاع سريع لكامل الفاتورة</span>
        </Button>

        <Button
          variant="outline"
          onClick={() => { setQty({}); setManualAmount(null); setReason(""); setError(""); setDone(""); setFastBarcode(""); }}
          className="text-xs sm:text-sm gap-1 text-muted-foreground"
        >
          <RotateCcw className="size-3.5" aria-hidden />
          <span>إعادة ضبط</span>
        </Button>

        {footer}
      </div>
    </div>
  );
}

export default ReturnComposer;
