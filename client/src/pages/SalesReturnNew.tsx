/**
 * SalesReturnNew — مرتجع بيع جديد (محرّر شريحة كاملة)
 *
 * يستخدم مكتبة محرّر الفاتورة المشتركة (`@/components/invoice`) ويرتبط
 * بـ tRPC الحقيقي: لا mock. النموذج هنا «مرتجع مرجعي» — البنود تُحمَّل من
 * فاتورة المصدر (عن طريق رقمها) ثم يحدّد المستخدم كميات الإرجاع
 * (≤ المتبقّي لكل بند).
 *
 * نقطة دقيقة: API الخادم الفعليّ (`trpc.returns.create`) يستلم
 * `{ invoiceId, lines: [{invoiceItemId, baseQuantity}], refund?, restock? }`،
 * لا «items + customerId». لذا نُمسك خريطة موازية
 * `productUnitId → {invoiceItemId, remaining, unitName, conversionFactor}`
 * ونبني المُدخل من حالة المحرّر عند الحفظ، ونحرس بأن qty ≤ المتبقّي ≤ المباع.
 *
 * صلاحية: المرتجعات تعكس مخزوناً ونقداً ⇒ يستلزم دور مدير على الخادم
 * (`managerProcedure`). الواجهة لا تفلتر الدور (UX لطيف) لكنّ الخادم يرفض
 * الطلب إذا لم يكن المستخدم مديراً.
 */
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  ActionButtons,
  BulkPicker,
  InvoiceHeader,
  INVOICE_TYPES,
  ProductTable,
  ShortcutsBar,
  TermsAndNotes,
  TotalsPanel,
  createInitialState,
  invoiceReducer,
  type InvoiceLine,
} from "@/components/invoice";
import { AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { confirm } from "@/lib/confirm";
import { fmtDate } from "@/lib/date";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { D, fmt, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { copyInvoiceItems, hasInvoiceTransfer, takeInvoiceItems } from "@/lib/invoiceTransfer";

/** بيانات الأصل لكل بند تمّ تحميله من الفاتورة المرجعية. */
interface RefMeta {
  invoiceItemId: number;
  /** المتبقّي القابل للإرجاع بالوحدة الأساس (= المُباع − المُرتجع سابقاً). */
  remainingBase: number;
  /** الوحدة الأساس → الكمية المُدخَلة في الوحدة المُختارة تتحوّل ضرباً بهذا. */
  conversionFactor: string;
  /** إجمالي بند الفاتورة المصدر (نصّ decimal) — أساس التوزيع التناسبيّ المطابق للخادم. */
  itemTotal: string;
  /** الكمية المباعة بالأساس لبند الفاتورة المصدر — مقام النسبة. */
  itemBaseQuantity: number;
}

/**
 * إجمالي المرتجع المطابق للخادم (فرع الإرجاع الجزئيّ في `returnService`): توزيعٌ تناسبيّ لإجماليّات
 * بنود الفاتورة المصدر (`Σ total×(qtyBase/itemBase)`) ثم تطبيق نسبتَي الخصم والضريبة على مستوى
 * الفاتورة. مصدر حقيقة واحد للعرض وحدّ الاسترداد ⇒ لا «إجمالي» مصطنع من حالة المحرّر (الذي يتجاهل
 * خصم/ضريبة الفاتورة فيُظهر رقماً خاطئاً كلّما كان للأصل خصمٌ أو ضريبة). §٥: كلّه decimal.js.
 * (الإرجاع الكامل يختلف على الخادم بمتبقّي تقريبٍ ضئيل + عكس الشحن — عرضٌ فقط، والخادم يحدّ الاسترداد.)
 */
export function computeExpectedReturnTotal(
  items: InvoiceLine[],
  meta: Record<number, RefMeta>,
  inv: { subtotal: string; discountAmount: string; taxAmount: string } | null | undefined,
): string {
  if (!inv) return "0.00";
  let grossNet = D(0);
  for (const item of items) {
    const m = meta[item.productUnitId];
    if (!m) continue;
    const baseDec = round2(D(String(item.qty)).times(D(item.conversionFactor || "1")));
    const itemBase = D(m.itemBaseQuantity);
    if (!baseDec.gt(0) || !itemBase.gt(0)) continue;
    grossNet = grossNet.plus(D(m.itemTotal).times(baseDec.div(itemBase)));
  }
  const subtotal = D(inv.subtotal);
  const discountAmount = D(inv.discountAmount);
  const taxAmount = D(inv.taxAmount);
  const discountRatio = subtotal.gt(0) ? discountAmount.div(subtotal) : D(0);
  const taxable = subtotal.minus(discountAmount);
  const taxRate = taxable.gt(0) ? taxAmount.div(taxable) : D(0);
  const returnedRevenue = round2(grossNet.times(D(1).minus(discountRatio)));
  const returnedTax = round2(returnedRevenue.times(taxRate));
  return round2(returnedRevenue.plus(returnedTax)).toFixed(2);
}

function shiftTypeLabel(t: string): string {
  return t === "RECEPTION" ? "استقبال" : t === "PRINT_SERVICES" ? "خدمات طباعة" : "تجزئة";
}

export default function SalesReturnNew() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [pasteAvailable, setPasteAvailable] = useState(hasInvoiceTransfer);

  // الجلسة الحالية لمعرفة الفرع الافتراضي.
  const me = trpc.auth.me.useQuery();

  // الحالة الموحّدة للمحرّر (نفس reducer الشرائح الأخرى — اتساق + قابلية صيانة).
  const [state, dispatch] = useReducer(
    invoiceReducer,
    undefined,
    () => ({ ...createInitialState("SALE_RETURN", me.data?.branchId ?? 1) })
  );

  // عند توفّر me لاحقاً نضبط الفرع مرّة واحدة (إن لم يُغيّره المستخدم).
  useEffect(() => {
    if (me.data?.branchId && state.branchId === 1 && state.items.length === 0) {
      dispatch({ type: "SET_FIELD", field: "branchId", value: me.data.branchId });
    }
    // ندَع state.branchId بقصد خارج deps — تعديله بيد المستخدم لا يُعاد ضبطه.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.data?.branchId]);

  // idempotency: مُعرّف فريد للطلب يبقى ثابتاً عبر إعادات المحاولة.
  const [clientRequestId] = useState(() => crypto.randomUUID());

  // مرجع فاتورة المصدر (id + خريطة البنود) — يُسكَت قبل التحميل.
  const [sourceInvoiceId, setSourceInvoiceId] = useState<number | null>(null);
  const [refMeta, setRefMeta] = useState<Record<number, RefMeta>>({});

  // إعدادات الواجهة العامّة للمحرّر.
  const [bulkOpen, setBulkOpen] = useState(false);
  const [showCost] = useState(false); // مرتجع بيع: الكاشير قد يراه، نخفي التكلفة.
  const [restock, setRestock] = useState(true);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // درج الاسترداد النقدي: الدرج مورد فرعٍ لا مستخدم — هذه الشاشة تتطلّب صلاحية مدير، وقد يكون
  // منفِّذ المرتجع شخصاً مختلفاً عن الكاشير الذي يُشغّل الدرج الذي سيخرج منه النقد فعلياً. نجلب
  // ورديات الفرع المفتوحة فعلياً لنعرض/نُلزم اختيار الدرج الصحيح (راجع resolveBranchCashShiftTx
  // على الخادم) بدل ترك النظام يخمّن، فيظهر عجزٌ لا يفهم الكاشير سببه عند إغلاق ورديته.
  const [refundShiftId, setRefundShiftId] = useState<number | null>(null);

  // بحث حيّ (رقم الفاتورة المرجعية) — خادميّ عبر sales.list({q}) (رقم الفاتورة LIKE أو اسم
  // العميل)، لا يقتصر على آخر ٢٠٠ فاتورة محمَّلة مسبقاً كما كان (كانت فاتورة أقدم "غير موجودة").
  const [refOpen, setRefOpen] = useState(false);
  const [resolvingRef, setResolvingRef] = useState(false);
  const refBoxRef = useRef<HTMLDivElement>(null);
  const debouncedRefQuery = useDebouncedValue(state.refInvoice.trim(), 250);
  const refSearchQ = trpc.sales.list.useQuery(
    { q: debouncedRefQuery, limit: 8 },
    { enabled: refOpen && debouncedRefQuery.length >= 2 }
  );
  const refSuggestions = (refSearchQ.data ?? []).filter(
    (inv) => inv.status !== "CANCELLED" && inv.status !== "RETURNED"
  );

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (refBoxRef.current && !refBoxRef.current.contains(e.target as Node)) setRefOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  // تفاصيل الفاتورة المصدر — تُفعَّل فقط حين نعرف id.
  const refDetail = trpc.returns.getInvoice.useQuery(
    { invoiceId: sourceInvoiceId ?? 0 },
    { enabled: !!sourceInvoiceId }
  );

  // عند نجاح تحميل تفاصيل المصدر: إن لم تكن مُحمَّلة بعد، احقن البنود في الحالة.
  useEffect(() => {
    const data = refDetail.data;
    if (!data || !sourceInvoiceId) return;
    if (data.status === "RETURNED" || data.status === "CANCELLED") {
      notify.err(`الفاتورة ${data.invoiceNumber} ${data.status === "RETURNED" ? "مرتجعة" : "ملغاة"} — لا يمكن الإرجاع منها.`);
      setSourceInvoiceId(null);
      return;
    }

    const lines: InvoiceLine[] = [];
    const meta: Record<number, RefMeta> = {};
    let added = 0;
    let skipped = 0;

    for (const it of data.items) {
      if (it.remaining <= 0) {
        skipped += 1;
        continue;
      }
      // بدون productUnitId/variantId/conversionFactor كاملة في returns.getInvoice،
      // نُنشئ مفتاحاً اصطناعياً (invoiceItemId) لمنع تصادم ADD_ITEM.
      const productUnitId = -Number(it.invoiceItemId); // سالب ⇒ لن يتعارض مع أيّ productUnitId حقيقي.
      const line: InvoiceLine = {
        productId: 0,
        variantId: 0,
        productUnitId,
        name: it.productName + (it.variantLabel ? ` — ${it.variantLabel}` : ""),
        sku: "",
        barcode: null,
        unit: it.unitName ?? "",
        qty: it.remaining, // افتراضياً نضع كل المتبقّي — المستخدم يخفّض.
        conversionFactor: "1", // الكميات هنا بالوحدة الأساس بالفعل (returns.getInvoice).
        stockBase: it.remaining,
        price: it.unitPrice,
        costBase: "0",
        discount: "0",
        discountType: "percent",
        note: `بند #${it.invoiceItemId}`,
      };
      lines.push(line);
      meta[productUnitId] = {
        invoiceItemId: Number(it.invoiceItemId),
        remainingBase: it.remaining,
        conversionFactor: "1",
        itemTotal: it.total,
        itemBaseQuantity: Number(it.baseQuantity),
      };
      added += 1;
    }

    dispatch({ type: "CLEAR_ITEMS" });
    if (lines.length) dispatch({ type: "ADD_ITEMS", items: lines });
    setRefMeta(meta);

    // اعتمد العميل تلقائياً من فاتورة المصدر — منع عدم اتساق محاسبيّ.
    if (data.customerId) dispatch({ type: "SET_ENTITY", id: Number(data.customerId) });
    // اعتمد الفرع من المصدر — لأنّ المخزون يُعاد للفرع نفسه.
    dispatch({ type: "SET_FIELD", field: "branchId", value: Number(data.branchId) });

    if (added === 0) {
      notify.warn("لا توجد كميات متبقّية للإرجاع في هذه الفاتورة.");
    } else {
      notify.ok(`حُمِّل ${added} بنداً من ${data.invoiceNumber}${skipped ? ` (تجاهلت ${skipped} مُرتجع كاملاً)` : ""}.`);
    }
  }, [refDetail.data, sourceInvoiceId]);

  /** يحلّ رقم الفاتورة المُدخَل إلى id عبر بحث خادميّ فوريّ (sales.list — لا byNumber بعد)،
   *  بلا القيد القديم (آخر ٢٠٠ فاتورة محمَّلة سلفاً). يُستعمَل من زرّ "تحميل البنود"/Enter؛
   *  الاختيار من القائمة المنسدلة الحيّة (refSuggestions) أسرع ولا يحتاج تطابقاً تاماً. */
  async function lookupReference() {
    const num = state.refInvoice.trim();
    if (!num) {
      notify.err("أدخل رقم الفاتورة المرجعية أولاً.");
      return;
    }
    setResolvingRef(true);
    try {
      const matches = await utils.sales.list.fetch({ q: num, limit: 5 });
      const exact = matches.find((inv) => inv.invoiceNumber === num);
      const target = exact ?? (matches.length === 1 ? matches[0] : null);
      if (!target) {
        notify.err(
          matches.length > 1
            ? `أكثر من فاتورة تطابق «${num}» — اختر من القائمة المنسدلة تحت الحقل.`
            : `لم تُعثَر على فاتورة بالرقم «${num}».`
        );
        return;
      }
      setSourceInvoiceId(Number(target.id));
      setRefOpen(false);
    } finally {
      setResolvingRef(false);
    }
  }

  // إرسال المرتجع — يبني payload وفق ما يتوقّعه trpc.returns.create.
  const createMutation = trpc.returns.create.useMutation({
    onSuccess: async (r) => {
      await Promise.all([
        utils.sales.list.invalidate(),
        utils.returns.getInvoice.invalidate(),
        utils.inventory.onHand.invalidate(),
      ]);
      notify.ok("تمّ تسجيل المرتجع بنجاح.");
      navigate(`/invoices/${r.invoiceId}`);
    },
    onError: (e) => notify.err(e),
  });

  function buildLinesPayload(): Array<{ invoiceItemId: number; baseQuantity: number }> | null {
    const out: Array<{ invoiceItemId: number; baseQuantity: number }> = [];
    for (const item of state.items) {
      const meta = refMeta[item.productUnitId];
      if (!meta) {
        notify.err(`بند «${item.name}» غير مرتبط بفاتورة المصدر — حمّل الفاتورة المرجعية أولاً.`);
        return null;
      }
      // المُدخل من المستخدم في الوحدة المختارة → نحوّله للأساس بـ decimal.js.
      const qDec = D(String(item.qty));
      if (!qDec.gt(0)) {
        notify.err(`كمية «${item.name}» يجب أن تكون موجبة.`);
        return null;
      }
      const factor = D(item.conversionFactor || "1");
      const baseDec = round2(qDec.times(factor));
      if (!baseDec.isInteger()) {
        notify.err(`كمية «${item.name}» تنتج كسراً بالوحدة الأساس — استخدم أعداداً صحيحة.`);
        return null;
      }
      const baseInt = baseDec.toNumber();
      if (baseInt > meta.remainingBase) {
        notify.err(`كمية «${item.name}» (${baseInt}) تتجاوز المتبقّي (${meta.remainingBase}).`);
        return null;
      }
      out.push({ invoiceItemId: meta.invoiceItemId, baseQuantity: baseInt });
    }
    return out;
  }

  async function handleSubmit(opts: { print?: boolean } = {}) {
    if (!sourceInvoiceId) {
      notify.err("اختر فاتورة مرجعية وحمّل بنودها قبل الحفظ.");
      return;
    }
    if (state.items.length === 0) {
      notify.err("لا توجد بنود للإرجاع.");
      return;
    }
    const lines = buildLinesPayload();
    if (!lines) return;

    // مبلغ الاسترداد — إن دفع شيئاً نسجّله؛ غير ذلك يبقى ذمة (سيُسوَّى لاحقاً).
    const paidStr = state.paidAmount.trim();
    let refund: { amount: string; method: "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET"; shiftId?: number } | undefined;
    if (paidStr) {
      if (!/^\d+(\.\d+)?$/.test(paidStr)) {
        notify.err("مبلغ الاسترداد غير صالح.");
        return;
      }
      const amt = D(paidStr);
      if (amt.gt(D(expectedReturnTotal))) {
        notify.err(`مبلغ الاسترداد (${fmt(paidStr)}) يتجاوز إجمالي المرتجع (${fmt(expectedReturnTotal)}).`);
        return;
      }
      if (amt.gt(0)) {
        refund = { amount: round2(amt).toFixed(2), method: state.paymentMethod };
        if (refund.method === "CASH") {
          // الدرج مورد فرعٍ لا مستخدم — يجب تحديد أيّ درجٍ سيخرج منه النقد فعلياً قبل الحفظ
          // (مرآةً لِما يفرضه resolveBranchCashShiftTx خادمياً) كي لا يظهر عجزٌ لكاشيرٍ لم يَرَ هذا المرتجع.
          if (openShiftsQ.isLoading || openShiftsQ.isFetching) {
            notify.err("جارٍ فحص الورديات المفتوحة بالفرع — أعد المحاولة بعد لحظة.");
            return;
          }
          if (drawerShifts.length === 0) {
            notify.err("لا توجد وردية مفتوحة في هذا الفرع لاسترداد نقدي — افتح وردية أو غيّر طريقة الاسترداد.");
            return;
          }
          if (drawerShifts.length > 1) {
            if (refundShiftId == null) {
              notify.err("أكثر من درجٍ مفتوح بالفرع — حدّد أعلاه أيّ درجٍ سيخرج منه النقد فعلياً.");
              return;
            }
            refund.shiftId = refundShiftId;
          } else {
            refund.shiftId = drawerShifts[0].shiftId;
          }
        }
      }
    }

    if (
      !(await confirm({
        variant: "danger",
        title: "تأكيد حفظ مرتجع البيع",
        description: "حفظ مرتجع البيع سينقل المخزون ويسجّل استرداداً. متابعة؟",
        confirmText: "حفظ",
      }))
    )
      return;

    createMutation.mutate(
      { invoiceId: sourceInvoiceId, lines, refund, restock, clientRequestId },
      {
        onSuccess: () => {
          if (opts.print) {
            // الطباعة بعد الحفظ — التنقّل سيُحدث، فنطبع بعد التحديث في صفحة الفاتورة.
            setTimeout(() => window.print(), 400);
          }
        },
      }
    );
  }

  // اختصارات لوحة المفاتيح (F2/F4/F9/F12/Esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // تجاهل ضغطات داخل حقول النصّ متعدّد الأسطر.
      const target = e.target as HTMLElement | null;
      const isTyping = target && (target.tagName === "TEXTAREA");

      if (e.key === "F2") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "F4") {
        e.preventDefault();
        if (!createMutation.isPending) handleSubmit();
      } else if (e.key === "F9") {
        e.preventDefault();
        window.print();
      } else if (e.key === "F12") {
        e.preventDefault();
        if (window.confirm("تفريغ كلّ بيانات المرتجع الحالي؟")) {
          dispatch({ type: "RESET", invoiceType: "SALE_RETURN" });
          setSourceInvoiceId(null);
          setRefMeta({});
        }
      } else if (e.key === "Escape" && !isTyping) {
        if (bulkOpen) setBulkOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkOpen, createMutation.isPending, sourceInvoiceId, state.items]);

  const typeMeta = INVOICE_TYPES["SALE_RETURN"];
  const hasRefLoaded = !!sourceInvoiceId && !!refDetail.data;
  // إجمالي المرتجع المطابق للخادم (لا حالة المحرّر) — مصدر العرض وحدّ الاسترداد معاً.
  const expectedReturnTotal = useMemo(
    () => computeExpectedReturnTotal(state.items, refMeta, refDetail.data),
    [state.items, refMeta, refDetail.data],
  );

  // تعبئة تلقائية لحقل «المدفوع» (= مبلغ الاسترداد هنا) بكامل قيمة المرتجع فور معرفتها — كان الحقل
  // يعرض الرقم كـplaceholder شبحيّ فقط (يبدو مملوءاً لكنه فارغ فعلياً) فيغادر الكاشير الشاشة معتقداً
  // أن الاسترداد النقدي سُجِّل، بينما handleSubmit يقرأ state.paidAmount الفعلي (فارغ) فيُسجَّل
  // المرتجع كذمّة مؤجَّلة بلا سند صرف — نقدٌ يخرج فعلياً من الدرج دون أن يعرف النظام، فيظهر عجزٌ
  // عند إغلاق الوردية. الافتراض الآن: استرداد نقدي كامل، وعلى الكاشير أن يُعدِّل/يُصفِّر الحقل يدوياً
  // إن أراد استرداداً جزئياً أو تأجيل التسوية. يعيد الضبط فقط حين يتغيّر الإجمالي المتوقَّع فعلاً
  // (تحميل/تغيير كميات) — تعديل الكاشير اليدويّ اللاحق لا يُطمَس ما لم يتغيّر الإجمالي مجدداً.
  useEffect(() => {
    if (D(expectedReturnTotal).gt(0)) {
      dispatch({ type: "SET_FIELD", field: "paidAmount", value: expectedReturnTotal });
    }
  }, [expectedReturnTotal]);

  // درج الاسترداد النقدي — نجلب ورديات الفرع المفتوحة (أيّ صاحب) فقط حين الاسترداد نقديّ فعلاً؛
  // غير النقد لا يمسّ درجاً فلا داعي للاستعلام. مطابقٌ لِما يفحصه الخادم (resolveBranchCashShiftTx).
  const isCashRefundPending = state.paymentMethod === "CASH" && D(state.paidAmount.trim() || "0").gt(0);
  const openShiftsQ = trpc.treasury.getOpenShifts.useQuery(
    { branchId: state.branchId },
    { enabled: isCashRefundPending && !!state.branchId }
  );
  const drawerShifts = openShiftsQ.data ?? [];

  // اختيارٌ سابق قد يصير غير صالح إن تغيّر الفرع أو طريقة الدفع أو انغلق الدرج المُختار — نصفّره
  // بدل إبقاء قيمة يتيمة قد تُرسَل خطأً (الخادم يرفضها فعلياً، لكن الأوضح مسحها من الواجهة أولاً).
  useEffect(() => {
    setRefundShiftId(null);
  }, [state.branchId, state.paymentMethod]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3" dir="rtl">
      {/* شريط العنوان */}
      <PageHeader
        className="shrink-0"
        icon={(() => { const TIcon = typeMeta.icon; return <TIcon aria-hidden className="size-5 text-primary" />; })()}
        title={`${typeMeta.label} جديد`}
        actions={
          <Link href="/invoices" className="text-sm text-muted-foreground hover:text-foreground">
            ← رجوع للفواتير
          </Link>
        }
      />

      {/* رأس المحرّر — يحتوي حقل «رقم الفاتورة المرجعية» تلقائياً لـ SALE_RETURN. */}
      <InvoiceHeader state={state} dispatch={dispatch} invoiceType="SALE_RETURN" />

      {/* شريط أدوات المرجع — بحث حيّ برقم الفاتورة (جزئي) أو اسم العميل + زر تحميل البنود. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-xl border bg-card px-4 py-2.5 text-sm">
        <span className="font-semibold text-muted-foreground">المرجع:</span>
        <div ref={refBoxRef} className="relative w-64">
          <Input
            ref={searchRef}
            dir="ltr"
            value={state.refInvoice}
            onChange={(e) => {
              dispatch({ type: "SET_FIELD", field: "refInvoice", value: e.target.value });
              setRefOpen(true);
            }}
            onFocus={() => setRefOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void lookupReference();
              } else if (e.key === "Escape") {
                setRefOpen(false);
              }
            }}
            placeholder="اكتب رقم الفاتورة أو جزءاً منه…"
            className="h-9 font-mono"
          />
          {refOpen && debouncedRefQuery.length >= 2 && (
            <div
              role="listbox"
              className="absolute inset-x-0 top-[calc(100%+4px)] z-50 max-h-64 overflow-y-auto rounded-xl border bg-card shadow-xl"
            >
              {refSearchQ.isFetching && (
                <div className="px-3 py-3 text-center text-xs text-muted-foreground">جارٍ البحث…</div>
              )}
              {!refSearchQ.isFetching && refSuggestions.length === 0 && (
                <div className="px-3 py-3 text-center text-xs text-muted-foreground">لا فواتير مطابقة</div>
              )}
              {refSuggestions.map((inv) => (
                <div
                  key={inv.id}
                  role="option"
                  aria-selected={Number(inv.id) === sourceInvoiceId}
                  onClick={() => {
                    dispatch({ type: "SET_FIELD", field: "refInvoice", value: inv.invoiceNumber });
                    setSourceInvoiceId(Number(inv.id));
                    setRefOpen(false);
                  }}
                  className="cursor-pointer border-b px-3 py-2 text-xs last:border-b-0 hover:bg-muted"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono font-bold text-foreground" dir="ltr">{inv.invoiceNumber}</span>
                    <span className="shrink-0 text-muted-foreground" dir="ltr">{fmt(inv.total)} د.ع</span>
                  </div>
                  <div className="text-muted-foreground">{inv.customerName ?? "نقدي"} · {fmtDate(inv.invoiceDate)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!state.refInvoice.trim() || resolvingRef || refDetail.isFetching}
          onClick={() => void lookupReference()}
        >
          {resolvingRef || refDetail.isFetching ? "جارٍ التحميل…" : hasRefLoaded ? "إعادة تحميل" : "تحميل البنود"}
        </Button>
        {hasRefLoaded && refDetail.data && (
          <>
            <span className="text-muted-foreground">·</span>
            <span>عميل: {refDetail.data.customerName ?? "نقدي"}</span>
            <span className="text-muted-foreground">·</span>
            <span dir="ltr">إجمالي الأصل: {fmt(refDetail.data.total)} د.ع</span>
          </>
        )}
        <label className="ms-auto inline-flex cursor-pointer items-center gap-2 text-xs">
          <input
            type="checkbox"
            className="size-4"
            checked={restock}
            onChange={(e) => setRestock(e.target.checked)}
          />
          <span className="text-muted-foreground">
            {restock ? "إعادة للمخزون" : "بلا إعادة للمخزون (تالف)"}
          </span>
        </label>
      </div>

      {/* المحرّر الرئيسي: جدول البنود + لوحة الجوانب */}
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <ProductTable
            items={state.items}
            dispatch={dispatch}
            branchId={state.branchId}
            tier={state.tier}
            invoiceType="SALE_RETURN"
            showCost={showCost}
            onOpenBulkPicker={() => setBulkOpen(true)}
            onNotify={(msg, kind) => (kind === "error" ? notify.err(msg) : notify.info(msg))}
          />
          <BulkPicker
            open={bulkOpen}
            onClose={() => setBulkOpen(false)}
            onAddItems={(items) => dispatch({ type: "ADD_ITEMS", items })}
            invoiceType="SALE_RETURN"
            branchId={state.branchId}
            tier={state.tier}
          />
          {state.items.length > 0 && !hasRefLoaded && (
            <div className="badge-stock-low flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
              <AlertTriangle aria-hidden className="size-4 shrink-0" />
              <span>
                هذه البنود ليست مرتبطة بفاتورة مصدر — لن يتمكّن الخادم من حفظ المرتجع.
                حمّل الفاتورة المرجعية أعلاه.
              </span>
            </div>
          )}
        </div>

        <aside className="flex w-80 shrink-0 flex-col gap-2">
          <TotalsPanel
            items={state.items}
            state={state}
            dispatch={dispatch}
            overrideGrandTotal={expectedReturnTotal}
            showDiscount={false}
            showShipping={false}
            showOtherExpenses={false}
          />

          {/* مصدر النقد المسترَد — الدرج مورد فرعٍ لا مستخدم؛ هذه الشاشة صلاحية مدير وقد يختلف
              منفِّذ المرتجع عن الكاشير صاحب الدرج الفعليّ. راجع resolveBranchCashShiftTx (الخادم). */}
          {isCashRefundPending && (
            <div className="rounded-xl border bg-card p-3 text-xs">
              <div className="mb-1.5 font-bold text-foreground">مصدر النقد المسترَد</div>
              {openShiftsQ.isFetching ? (
                <div className="text-muted-foreground">جارٍ فحص الورديات المفتوحة بالفرع…</div>
              ) : drawerShifts.length === 0 ? (
                <div className="badge-stock-low flex items-start gap-2 rounded-md border px-2.5 py-2">
                  <AlertTriangle aria-hidden className="size-3.5 shrink-0" />
                  <span>لا توجد وردية مفتوحة في هذا الفرع — لا يمكن استرداد نقدٍ حتى تُفتح وردية، أو غيّر طريقة الاسترداد.</span>
                </div>
              ) : drawerShifts.length === 1 ? (
                <div className="text-muted-foreground">
                  سيُخصَم هذا المبلغ من درج: <span className="font-semibold text-foreground">{drawerShifts[0].userName}</span>
                  {" — "}{shiftTypeLabel(drawerShifts[0].shiftType)} (وردية #{drawerShifts[0].shiftId})
                </div>
              ) : (
                <>
                  <div className="mb-1.5 text-muted-foreground">
                    أكثر من درجٍ مفتوح بالفرع — حدّد أيّ درجٍ سيخرج منه النقد فعلياً:
                  </div>
                  <AppSelect
                    size="sm"
                    className="text-xs"
                    value={refundShiftId != null ? String(refundShiftId) : ""}
                    onValueChange={(v) => setRefundShiftId(v ? Number(v) : null)}
                    placeholder="اختر الدرج…"
                  >
                    {drawerShifts.map((s) => (
                      <option key={s.shiftId} value={String(s.shiftId)}>
                        {s.userName} — {shiftTypeLabel(s.shiftType)} (وردية #{s.shiftId})
                      </option>
                    ))}
                  </AppSelect>
                </>
              )}
            </div>
          )}

          <ActionButtons
            invoiceType="SALE_RETURN"
            items={state.items}
            saving={createMutation.isPending}
            onAction={(action) => {
              switch (action) {
                case "save":
                  handleSubmit();
                  break;
                case "print":
                  handleSubmit({ print: true });
                  break;
                case "draft":
                  notify.info("لا توجد مسوّدات للمرتجعات — احفظ مباشرة عند الجاهزية.");
                  break;
                case "pdf":
                  window.print();
                  break;
                case "send":
                case "convert":
                case "return":
                  notify.info("هذا الإجراء غير متاح في مرتجع البيع.");
                  break;
                case "duplicate":
                  if (!state.items.length) {
                    notify.warn("لا توجد محتويات لنسخها.");
                    break;
                  }
                  copyInvoiceItems(state.items);
                  dispatch({ type: "CLEAR_ITEMS" });
                  setPasteAvailable(true);
                  notify.ok("تم نسخ الأصناف وتفريغ الفاتورة. ستجد «لصق» في أي فاتورة تفتحها.");
                  break;
                case "paste": {
                  const items = takeInvoiceItems();
                  if (!items) {
                    setPasteAvailable(false);
                    notify.warn("لا توجد محتويات صالحة للصقها.");
                    break;
                  }
                  dispatch({ type: "ADD_ITEMS", items });
                  setPasteAvailable(false);
                  notify.ok("تم لصق المحتويات. اختر الفاتورة المرجعية قبل حفظ المرتجع.");
                  break;
                }
              }
            }}
            pasteAvailable={pasteAvailable}
          />
          <TermsAndNotes state={state} dispatch={dispatch} />
          <div className="rounded-xl border bg-muted/40 p-3 text-[11px] text-muted-foreground">
            <div className="mb-1 font-bold text-foreground">ملاحظات</div>
            <ul className="list-disc space-y-0.5 pe-4">
              <li>كميات الإرجاع مُقيّدة بالمتبقّي من فاتورة المصدر.</li>
              <li>«المدفوع» هنا = مبلغ الاسترداد للعميل (نقد/تحويل/…) — يُملأ تلقائياً بكامل قيمة المرتجع.</li>
              <li>عدِّله أو صفِّره يدوياً إن كان الاسترداد جزئياً أو مؤجَّلاً (يبقى الباقي ذمّة على المؤسّسة).</li>
              <li>إعادة المخزون مفعّلة افتراضياً — أوقفها للبضاعة التالفة.</li>
            </ul>
            <div className="mt-1.5 text-[10px]" dir="ltr">
              req-id: {clientRequestId.slice(0, 8)}…
            </div>
            <div className="mt-0.5 text-[10px]" dir="ltr">
              إجمالي المرتجع: {fmt(expectedReturnTotal)} د.ع
            </div>
          </div>
        </aside>
      </div>

      <ShortcutsBar />
    </div>
  );
}
