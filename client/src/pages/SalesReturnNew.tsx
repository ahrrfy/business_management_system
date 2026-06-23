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
  calcTotals,
  createInitialState,
  invoiceReducer,
  type InvoiceLine,
} from "@/components/invoice";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirm } from "@/lib/confirm";
import { D, fmt, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";

/** بيانات الأصل لكل بند تمّ تحميله من الفاتورة المرجعية. */
interface RefMeta {
  invoiceItemId: number;
  /** المتبقّي القابل للإرجاع بالوحدة الأساس (= المُباع − المُرتجع سابقاً). */
  remainingBase: number;
  /** الوحدة الأساس → الكمية المُدخَلة في الوحدة المُختارة تتحوّل ضرباً بهذا. */
  conversionFactor: string;
}

export default function SalesReturnNew() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

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

  // البحث في قائمة الفواتير الأخيرة لاستخراج id من رقم — لا توجد invoices.byNumber.
  const salesList = trpc.sales.list.useQuery({ limit: 200 });

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
        tax: "0",
        note: `بند #${it.invoiceItemId}`,
      };
      lines.push(line);
      meta[productUnitId] = {
        invoiceItemId: Number(it.invoiceItemId),
        remainingBase: it.remaining,
        conversionFactor: "1",
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

  /** يحلّ رقم الفاتورة المُدخَل إلى id باستخدام sales.list (لا byNumber في الخادم بعد). */
  function lookupReference() {
    const num = state.refInvoice.trim();
    if (!num) {
      notify.err("أدخل رقم الفاتورة المرجعية أولاً.");
      return;
    }
    const list = salesList.data ?? [];
    const match = list.find((inv) => inv.invoiceNumber === num);
    if (!match) {
      notify.err(`لم تُعثَر على فاتورة بالرقم «${num}» ضمن آخر ${list.length} فاتورة.`);
      return;
    }
    setSourceInvoiceId(Number(match.id));
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

    const totals = calcTotals(state.items, state);
    // مبلغ الاسترداد — إن دفع شيئاً نسجّله؛ غير ذلك يبقى ذمة (سيُسوَّى لاحقاً).
    const paidStr = state.paidAmount.trim();
    let refund: { amount: string; method: "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET" } | undefined;
    if (paidStr) {
      if (!/^\d+(\.\d+)?$/.test(paidStr)) {
        notify.err("مبلغ الاسترداد غير صالح.");
        return;
      }
      const amt = D(paidStr);
      if (amt.gt(D(totals.grandTotal))) {
        notify.err(`مبلغ الاسترداد (${fmt(paidStr)}) يتجاوز إجمالي المرتجع (${fmt(totals.grandTotal)}).`);
        return;
      }
      if (amt.gt(0)) {
        refund = { amount: round2(amt).toFixed(2), method: state.paymentMethod };
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
  const totals = useMemo(() => calcTotals(state.items, state), [state]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3" dir="rtl">
      {/* شريط العنوان */}
      <div className="flex shrink-0 items-center justify-between">
        <h1 className="flex items-center gap-2 text-xl font-extrabold">
          {(() => { const TIcon = typeMeta.icon; return <TIcon aria-hidden className="size-5 text-primary" />; })()}
          {typeMeta.label} جديد
        </h1>
        <Link href="/invoices" className="text-sm text-muted-foreground hover:text-foreground">
          ← رجوع للفواتير
        </Link>
      </div>

      {/* رأس المحرّر — يحتوي حقل «رقم الفاتورة المرجعية» تلقائياً لـ SALE_RETURN. */}
      <InvoiceHeader state={state} dispatch={dispatch} invoiceType="SALE_RETURN" />

      {/* شريط أدوات المرجع — زر تحميل البنود. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-xl border bg-card px-4 py-2.5 text-sm">
        <span className="font-semibold text-muted-foreground">المرجع:</span>
        <span className="font-mono" dir="ltr">
          {state.refInvoice || <span className="text-muted-foreground">— غير محدّد —</span>}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!state.refInvoice.trim() || salesList.isLoading || refDetail.isFetching}
          onClick={lookupReference}
        >
          {refDetail.isFetching ? "جارٍ التحميل…" : hasRefLoaded ? "إعادة تحميل" : "تحميل البنود"}
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
            <div className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <AlertTriangle aria-hidden className="size-4 shrink-0" />
              <span>
                هذه البنود ليست مرتبطة بفاتورة مصدر — لن يتمكّن الخادم من حفظ المرتجع.
                حمّل الفاتورة المرجعية أعلاه.
              </span>
            </div>
          )}
        </div>

        <aside className="flex w-80 shrink-0 flex-col gap-2">
          <TotalsPanel items={state.items} state={state} dispatch={dispatch} />
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
                case "duplicate":
                case "return":
                  notify.info("هذا الإجراء غير متاح في مرتجع البيع.");
                  break;
              }
            }}
          />
          <TermsAndNotes state={state} dispatch={dispatch} />
          <div className="rounded-xl border bg-muted/40 p-3 text-[11px] text-muted-foreground">
            <div className="mb-1 font-bold text-foreground">ملاحظات</div>
            <ul className="list-disc space-y-0.5 pe-4">
              <li>كميات الإرجاع مُقيّدة بالمتبقّي من فاتورة المصدر.</li>
              <li>«المدفوع» هنا = مبلغ الاسترداد للعميل (نقد/تحويل/…).</li>
              <li>إن تركته فارغاً يبقى المبلغ ذمّة على المؤسّسة (يُسوَّى لاحقاً).</li>
              <li>إعادة المخزون مفعّلة افتراضياً — أوقفها للبضاعة التالفة.</li>
            </ul>
            <div className="mt-1.5 text-[10px]" dir="ltr">
              req-id: {clientRequestId.slice(0, 8)}…
            </div>
            <div className="mt-0.5 text-[10px]" dir="ltr">
              إجمالي المرتجع: {fmt(totals.grandTotal)} د.ع
            </div>
          </div>
        </aside>
      </div>

      <ShortcutsBar />
    </div>
  );
}
