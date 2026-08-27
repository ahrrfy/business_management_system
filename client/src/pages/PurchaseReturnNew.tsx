/**
 * PurchaseReturnNew — صفحة مرتجع شراء كاملة باستخدام مكتبة المحرر المشتركة.
 *
 * مرتجع المشتريات = إرجاع بضاعة للمورد ⇒ يخصم المخزون + يخفّض ذمم المورد (AP) +
 * يُسجّل قيد RETURN سالب. تتطلّب صلاحية مدير (managerProcedure على الخادم).
 *
 * الاتفاقيات (CLAUDE.md):
 *  - Decimal-safe: كل الأموال عبر D()/round2 (لا parseFloat).
 *  - idempotency: clientRequestId يولَّد مرة واحدة لكل جلسة محاولة.
 *  - "مرتجع مرجعي" اختياري: يُدخل المستخدم رقم/مُعرّف أمر الشراء فنجلب بنوده ونملأ السلة
 *    بالكمّيات المُستلَمة (قيد بحدّ أعلى ≤ المُستلَم − المُرتجَع سابقاً يُفرض على الخادم).
 */

import { useEffect, useMemo, useRef, useState, useReducer } from "react";
import { Link, useLocation } from "wouter";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertTriangle, Download } from "lucide-react";
import { confirm } from "@/lib/confirm";
import { useUnsavedGuard } from "@/hooks/useUnsavedGuard";
import { D } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { releaseReservedPrintWindow, reservePrintWindow } from "@/lib/printing/brand";
import { PageHeader } from "@/components/PageHeader";
import { copyInvoiceItems, hasInvoiceTransfer, takeInvoiceItems } from "@/lib/invoiceTransfer";
import {
  ActionButtons,
  BulkPicker,
  INVOICE_TYPES,
  InvoiceHeader,
  ProductTable,
  ShortcutsBar,
  TermsAndNotes,
  TotalsPanel,
  calcTotals,
  createInitialState,
  invoiceReducer,
  type InvoiceLine,
  type InvoiceActionKind,
} from "@/components/invoice";

const TYPE = "PURCHASE_RETURN" as const;
// مرتجع الشراء لا يملك دورة مسودة. إبقاء القائمة صريحة يمنع ظهور إجراء وهمي إذا تغيّرت
// افتراضات ActionButtons المشتركة مستقبلاً.
const PURCHASE_RETURN_ACTIONS = ["save", "print", "duplicate", "paste"] as const satisfies readonly InvoiceActionKind[];

export default function PurchaseReturnNew() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [pasteAvailable, setPasteAvailable] = useState(hasInvoiceTransfer);
  const printAfterSaveRef = useRef(false);

  // 1) ───── حالة عامة + هوية المستخدم ─────────────────────────────────────────
  const me = trpc.auth.me.useQuery();
  const [state, dispatch] = useReducer(
    invoiceReducer,
    undefined,
    // صفر = «لم يُختر فرع» وليس فرعاً افتراضياً؛ غير الأدمن يُملأ فرعه من /me أدناه،
    // والأدمن يبقى الحفظ معطلاً حتى اختيار فرع صريح.
    () => ({ ...createInitialState(TYPE, 0), branchId: 0 })
  );

  // عند تحميل /me لاحقاً ⇒ صحّح الفرع الافتراضي إن لم يختر المستخدم غيره يدوياً.
  useEffect(() => {
    if (me.data?.branchId && state.branchId !== me.data.branchId && !state.items.length) {
      dispatch({ type: "SET_FIELD", field: "branchId", value: me.data.branchId });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.data?.branchId]);

  // 2) ───── idempotency token (UUID per attempt) ─────────────────────────────
  const [clientRequestId, setClientRequestId] = useState<string>(() =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `pr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  );
  const regenerateRequestId = () =>
    setClientRequestId(
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `pr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    );

  // 3) ───── BulkPicker state ─────────────────────────────────────────────────
  const [bulkOpen, setBulkOpen] = useState(false);

  // تسوية المرتجع صريحة (تدقيق ١٧/٧): الافتراض CREDIT = خصم من ذمة المورد. كانت التسوية تُشتقّ من
  // paymentTerms العام الذي يفترض CASH ⇒ كل مرتجع يُحفَظ بالافتراضي يسجّل قبض نقد كامل من المورد لم يحدث.
  const [settlement, setSettlement] = useState<"CREDIT" | "CASH">("CREDIT");

  // 4) ───── RBAC: التكلفة مرئية للمدير دائماً في مرتجع الشراء ─────────────────
  const showCost = true;

  // حارس فقدان البيانات (نمط PurchaseNew/ExpenseNew): dirty عند إدخال فعليّ فقط.
  const isDirty = state.entityId != null || state.items.length > 0 || (state.notes?.trim() ?? "") !== "";
  useUnsavedGuard(isDirty);

  // الحدّ الأعلى المسموح بإرجاعه لكل سطر (بوحدة الشراء) — يُبنى فقط للبنود المحمَّلة من أمر شراء
  // مرجعي (استيراد)؛ مفتاحه `variantId:productUnitId`. يُظهر تحذيراً فورياً قبل محاولة الحفظ بدل
  // انتظار رفض الخادم (السقف الخادمي الحقيقي أدقّ — يخصم مرتجعات سابقة من نفس الأمر لا يعرفها العميل).
  const [maxByKey, setMaxByKey] = useState<Map<string, { max: number; name: string; unit: string; purchaseOrderItemId: number }>>(new Map());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const eligibleOrders = trpc.purchaseReturns.eligibleOrders.useQuery(
    { branchId: Number(state.branchId), q: pickerQuery.trim() || undefined, limit: 20 },
    { enabled: pickerOpen && Number(state.branchId) > 0 },
  );

  // 5) ───── mutation: trpc.purchaseReturns.create ─────────────────────────────
  const mutation = trpc.purchaseReturns.create.useMutation({
    onSuccess: async (result) => {
      toast.success("تم إنشاء مرتجع الشراء بنجاح");
      await utils.purchases.list.invalidate();
      const print = printAfterSaveRef.current;
      printAfterSaveRef.current = false;
      navigate(`/purchase-returns/${result.purchaseReturnId}${print ? "?print=1" : ""}`);
    },
    onError: (e) => {
      printAfterSaveRef.current = false;
      releaseReservedPrintWindow();
      toast.error(e.message || "فشل إنشاء مرتجع الشراء");
      regenerateRequestId(); // اسمح بإعادة محاولة جديدة بدون اصطدام idempotency.
    },
  });

  // 6) ───── مرجعية أمر شراء: نجلب بنوده عند إدخال المُعرّف الرقمي ──────────────
  const [refLookupError, setRefLookupError] = useState<string | null>(null);
  const [refLastFetchedId, setRefLastFetchedId] = useState<number | null>(null);

  /**
   * يحاول تفسير قيمة "رقم أمر الشراء المرجعي" (state.poReference) كمُعرّف رقمي،
   * فإن كان صالحاً ولم يُجلَب سابقاً ⇒ يستدعي trpc.purchases.get ويملأ السلة.
   * (يقبل أيضاً اللصق برمز SR/PR/PO؛ نستخلص أوّل تسلسل أرقام.)
   */
  async function tryLoadFromReference(referenceOverride?: string) {
    const raw = (referenceOverride || state.poReference || state.refInvoice || "").trim();
    if (!raw) {
      setRefLookupError(null);
      setPickerOpen(true);
      return;
    }

    setRefLookupError(null);
    try {
      const po = await utils.purchaseReturns.resolveOrder.fetch({ branchId: Number(state.branchId), reference: raw });

      // — تعيين المورد والفرع من المرجع (الخادم يتحقّق منها لاحقاً)
      dispatch({ type: "SET_ENTITY", id: Number(po.supplierId) });
      dispatch({ type: "SET_FIELD", field: "branchId", value: Number(po.branchId) });
      dispatch({ type: "SET_FIELD", field: "taxEnabled", value: D(po.taxAmount ?? "0").gt(0) });
      dispatch({ type: "SET_FIELD", field: "taxRatePercent", value: po.taxRatePercent ?? "0" });

      // — بنود ⇒ خطوط السلة: الحدّ الأعلى للإرجاع = المُستلَم (لا يخصم مرتجعات سابقة — العميل لا
      // يعرفها؛ السقف الخادمي الدقيق يُطبَّق وقت الحفظ)، نتجاهل البنود غير المُستلَمة.
      // الكمية تبدأ من صفر (لا كامل المُستلَم تلقائياً) — المستخدم يختار صراحةً ماذا يُرجِع وكم،
      // بدل افتراضٍ خطِر «أرجِع كل شيء» قد يُحفَظ سهواً.
      const maxMap = new Map<string, { max: number; name: string; unit: string; purchaseOrderItemId: number }>();
      const lines: InvoiceLine[] = (po.items ?? [])
        .map((it) => {
          const conv = D(it.conversionFactor || "1").toString();
          const recvInUnit = D(it.remainingQuantity || "0").toNumber();
          const name = (it.productName ?? "منتج") + (it.variantName ? ` — ${it.variantName}` : "");
          const unit = it.unitName ?? "وحدة";
          maxMap.set(`${it.variantId}:${it.productUnitId}`, {
            max: recvInUnit,
            name,
            unit,
            purchaseOrderItemId: Number(it.purchaseOrderItemId),
          });
          return {
            productId: 0, // غير مستخدم في الإرسال؛ المعروض هو variantId/productUnitId.
            variantId: Number(it.variantId),
            productUnitId: Number(it.productUnitId),
            name,
            sku: it.sku ?? "",
            barcode: null,
            unit,
            qty: 0,
            conversionFactor: conv,
            stockBase: 0,
            price: D(it.unitPrice).toFixed(2),
            costBase: D(it.unitPrice).toFixed(2),
            discount: "0",
            discountType: "percent",
            note: "",
          };
        });

      if (!lines.length) {
        setRefLookupError("لا توجد بنود مُستلَمة في هذا أمر الشراء للإرجاع.");
        return;
      }

      // نمسح أي سلة سابقة قبل الإضافة (مرتجع مرجعي ⇒ السلة = صورة من PO).
      dispatch({ type: "CLEAR_ITEMS" });
      dispatch({ type: "ADD_ITEMS", items: lines });
      setMaxByKey(maxMap);
      setRefLastFetchedId(Number(po.id));
      dispatch({ type: "SET_FIELD", field: "poReference", value: po.poNumber });
      setPickerOpen(false);
      toast.success(`تم جلب ${lines.length} منتجاً من أمر الشراء ${po.poNumber} — أدخل كمية الإرجاع لكل صنف`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "تعذّر جلب أمر الشراء";
      setRefLookupError(msg);
    }
  }

  useEffect(() => {
    const reference = new URLSearchParams(window.location.search).get("po")?.trim();
    if (!reference || !state.branchId || refLastFetchedId != null) return;
    dispatch({ type: "SET_FIELD", field: "poReference", value: reference });
    void tryLoadFromReference(reference);
    // refLastFetchedId يمنع التكرار بعد نجاح التحميل؛ الفرع مطلوب لعزل المرجع.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.branchId, refLastFetchedId]);

  // 7) ───── الإجماليات للعرض/التحقّق ──────────────────────────────────────────
  const totals = useMemo(() => calcTotals(state.items, state), [state]);

  // 8) ───── التحقّق + الإرسال ────────────────────────────────────────────────
  function validateAndBuildPayload():
    | { ok: true; payload: Parameters<typeof mutation.mutate>[0] }
    | { ok: false; error: string } {
    if (!state.entityId) return { ok: false, error: "اختر المورد." };
    if (!state.branchId) return { ok: false, error: "اختر الفرع أولاً." };
    if (!refLastFetchedId) return { ok: false, error: "اختر أمر شراء مثبتاً من زر الاستيراد أولاً." };
    if (!state.items.length) return { ok: false, error: "أضف منتجاً واحداً على الأقل." };

    for (const l of state.items) {
      if (!Number.isFinite(l.qty) || l.qty <= 0) {
        return { ok: false, error: `الكمية في «${l.name}» يجب أن تكون موجبة.` };
      }
      const qty = D(l.qty);
      const conv = D(l.conversionFactor);
      if (!conv.isPositive()) {
        return { ok: false, error: `معامل تحويل غير صالح في «${l.name}».` };
      }
      const baseQty = qty.times(conv);
      if (!baseQty.isInteger()) {
        return { ok: false, error: `الكمية في «${l.name}» تنتج كسراً بالوحدة الأساس.` };
      }
      const price = D(l.price || l.costBase || "0");
      if (price.isNegative()) {
        return { ok: false, error: `سعر الإرجاع في «${l.name}» غير صالح.` };
      }
      // حارس محلّي بالحدّ الأعلى المعروف (المُستلَم من أمر الشراء المرجعي) — لا ينتظر رفض الخادم.
      // السقف الخادمي الفعلي قد يكون أدقّ (يخصم مرتجعات سابقة)، فقد يُرفَض رغم اجتياز هذا الفحص.
      const cap = maxByKey.get(`${l.variantId}:${l.productUnitId}`);
      if (!cap) return { ok: false, error: `السطر «${l.name}» غير مرتبط ببند أمر الشراء المرجعي.` };
      if (cap && qty.gt(cap.max)) {
        return {
          ok: false,
          error: `الكمية في «${l.name}» (${qty}) تتجاوز الحدّ الأعلى المسموح بإرجاعه من هذا الأمر (${cap.max} ${cap.unit}).`,
        };
      }
    }

    const paymentMethod = state.paymentMethod;
    // تدقيق ١٧/٧: التسوية من المفتاح الصريح لا من paymentTerms العام (كان افتراضه CASH يسجّل قبضاً وهمياً).

    const payload = {
      clientRequestId,
      supplierId: Number(state.entityId),
      branchId: Number(state.branchId),
      purchaseOrderRefId: refLastFetchedId,
      items: state.items.map((l) => ({
        purchaseOrderItemId: maxByKey.get(`${l.variantId}:${l.productUnitId}`)!.purchaseOrderItemId,
        quantity: D(l.qty).toString(),
      })),
      reason: state.notes?.trim() || null,
      paymentMethod,
      settlement,
    };
    return { ok: true, payload };
  }

  async function handleSubmit(options: { printAfterSave?: boolean } = {}) {
    const reserved = options.printAfterSave === true ? reservePrintWindow() : false;
    if (options.printAfterSave && !reserved) {
      toast.error("تعذّر فتح نافذة الطباعة — تحقّق من مانع النوافذ المنبثقة");
      return;
    }
    const v = validateAndBuildPayload();
    if (!v.ok) {
      if (reserved) releaseReservedPrintWindow();
      toast.error(v.error);
      return;
    }
    if (
      !(await confirm({
        variant: "danger",
        title: "تأكيد حفظ مرتجع الشراء",
        description: "حفظ مرتجع الشراء سيحرّك مخزوناً وذمم المورد. متابعة؟",
        confirmText: "حفظ",
      }))
    ) {
      if (reserved) releaseReservedPrintWindow();
      return;
    }
    printAfterSaveRef.current = options.printAfterSave === true;
    mutation.mutate(v.payload);
  }

  function handleAction(kind: InvoiceActionKind) {
    switch (kind) {
      case "save":
        handleSubmit();
        return;
      case "print":
        void handleSubmit({ printAfterSave: true });
        return;
      case "duplicate":
        if (!state.items.length) return toast.warning("لا توجد محتويات لنسخها.");
        copyInvoiceItems(state.items);
        dispatch({ type: "CLEAR_ITEMS" });
        setPasteAvailable(true);
        toast.success("تم نسخ المنتجات وتفريغ الفاتورة. ستجد «لصق» في أي فاتورة تفتحها.");
        return;
      case "paste": {
        const items = takeInvoiceItems();
        if (!items) {
          setPasteAvailable(false);
          toast.warning("لا توجد محتويات صالحة للصقها.");
          return;
        }
        dispatch({ type: "ADD_ITEMS", items });
        setPasteAvailable(false);
        toast.success("تم لصق محتويات الفاتورة.");
        return;
      }
      case "send":
      case "pdf":
      case "convert":
        toast.info("سيُفعَّل لاحقاً.");
        return;
      case "return":
        toast.info("أنت بالفعل في صفحة مرتجع شراء.");
        return;
      default:
        return;
    }
  }

  // 9) ───── اختصارات لوحة المفاتيح (F2/F4/F9/F12/Esc) ─────────────────────────
  const searchScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    async function onKey(e: KeyboardEvent) {
      // تجنّب الالتقاط داخل حقول إدخال نشطة لأقل عرضاً (نسمح بمفاتيح الوظائف)
      const t = e.target as HTMLElement | null;
      const isFnKey = e.key.startsWith("F") && e.key.length >= 2;
      const isEditing =
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        (t && t.isContentEditable);

      if (e.key === "F2") {
        e.preventDefault();
        // ركّز أوّل حقل بحث منتجات داخل الـ ProductTable.
        const input = searchScrollRef.current?.querySelector<HTMLInputElement>(
          'input[aria-label="بحث المنتجات"]'
        );
        input?.focus();
      } else if (e.key === "F4") {
        e.preventDefault();
        handleSubmit();
      } else if (e.key === "F9") {
        e.preventDefault();
        void handleSubmit({ printAfterSave: true });
      } else if (e.key === "F12") {
        e.preventDefault();
        if (
          await confirm({
            variant: "warning",
            title: "تفريغ النموذج",
            description: "تفريغ النموذج وبدء مرتجع جديد؟",
            confirmText: "تفريغ",
          })
        ) {
          dispatch({ type: "RESET", invoiceType: TYPE });
          regenerateRequestId();
          setRefLastFetchedId(null);
          setRefLookupError(null);
          setSettlement("CREDIT");
          setMaxByKey(new Map());
        }
      } else if (e.key === "Escape") {
        if (!isEditing && !isFnKey) {
          // لا شيء؛ نتجنّب الانتقال غير المقصود.
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.items, state.entityId, state.branchId, clientRequestId]);

  // 10) ───── Render ─────────────────────────────────────────────────────────
  const typeInfo = INVOICE_TYPES[TYPE];

  return (
    <div className="flex h-full flex-col gap-3">
      <PageHeader
        title={`${typeInfo.label} جديد`}
        icon={(() => {
          const TIcon = typeInfo.icon;
          return <TIcon aria-hidden className="size-5 text-primary" />;
        })()}
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void tryLoadFromReference()}
            disabled={!state.branchId}
            title="جلب بنود أمر الشراء المرجعي"
          >
            <Download aria-hidden className="size-4" />
            استيراد من أمر الشراء
          </Button>
        }
        backHref="/purchases"
        backLabel="رجوع للمشتريات"
      />

      {refLookupError && (
        <div className="badge-stock-out rounded-md px-3 py-2 text-xs font-semibold">
          {refLookupError}
        </div>
      )}

      {pickerOpen && (
        <div className="rounded-md border bg-card p-3 shadow-sm">
          <div className="mb-2 flex items-center gap-2">
            <Input
              value={pickerQuery}
              onChange={(e) => setPickerQuery(e.target.value)}
              placeholder="ابحث برقم أمر الشراء أو اسم المورد…"
              className="h-9"
              autoFocus
            />
            <Button type="button" variant="ghost" size="sm" onClick={() => setPickerOpen(false)}>إغلاق</Button>
          </div>
          <div className="max-h-52 overflow-auto rounded border">
            {(eligibleOrders.data ?? []).map((po) => (
              <button
                key={po.id}
                type="button"
                className="flex w-full items-center justify-between border-b px-3 py-2 text-right text-sm last:border-b-0 hover:bg-muted"
                onClick={() => void tryLoadFromReference(po.poNumber)}
              >
                <span><b dir="ltr">{po.poNumber}</b> — {po.supplierName}</span>
                <span className="text-xs text-muted-foreground">{po.returnableLines} بند قابل للإرجاع</span>
              </button>
            ))}
            {eligibleOrders.isLoading && <div className="p-4 text-center text-sm text-muted-foreground">جارٍ تحميل الأوامر المؤهلة…</div>}
            {!eligibleOrders.isLoading && (eligibleOrders.data?.length ?? 0) === 0 && (
              <div className="p-4 text-center text-sm text-muted-foreground">لا توجد أوامر مثبتة بكميات متبقية قابلة للإرجاع.</div>
            )}
          </div>
        </div>
      )}

      <InvoiceHeader state={state} dispatch={dispatch} invoiceType={TYPE} />

      <div className="flex min-h-0 flex-1 gap-3">
        <div ref={searchScrollRef} className="flex min-w-0 flex-1 flex-col gap-2">
          <ProductTable
            items={state.items}
            dispatch={dispatch}
            branchId={state.branchId}
            tier={state.tier}
            invoiceType={TYPE}
            showCost={showCost}
            onOpenBulkPicker={() => setBulkOpen(true)}
            onNotify={(msg, kind) => (kind === "error" ? toast.error(msg) : toast.info(msg))}
          />
          {/* الحدّ الأعلى المسموح بإرجاعه لكل سطر مُستورَد من أمر شراء مرجعي — يظهر فوراً بدل انتظار
              رفض الخادم عند الحفظ (السقف الخادمي الفعلي أدقّ: يخصم مرتجعات سابقة على نفس الأمر). */}
          {maxByKey.size > 0 && (
            <div className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs">
              <div className="mb-1 font-semibold text-muted-foreground">
                الحدّ الأعلى المسموح بإرجاعه لكل صنف (بحسب أمر الشراء المرجعي — قد تُخفّضه مرتجعات سابقة)
              </div>
              <ul className="grid grid-cols-1 gap-y-0.5 sm:grid-cols-2">
                {state.items.map((l, i) => {
                  const cap = maxByKey.get(`${l.variantId}:${l.productUnitId}`);
                  if (!cap) return null;
                  const over = D(l.qty).gt(cap.max);
                  return (
                    <li key={`${l.variantId}-${l.productUnitId}-${i}`} className={over ? "font-bold text-destructive" : "text-muted-foreground"}>
                      {cap.name}: الحدّ الأعلى {cap.max} {cap.unit}
                      {over && " — تجاوزت الحدّ!"}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <BulkPicker
            open={bulkOpen}
            onClose={() => setBulkOpen(false)}
            onAddItems={(items) => dispatch({ type: "ADD_ITEMS", items })}
            invoiceType={TYPE}
            branchId={state.branchId}
            tier={state.tier}
          />
        </div>
        <aside className="flex w-80 shrink-0 flex-col gap-2">
          {/* تدقيق ١٧/٧ (خطر #2): إخفاء الحقول غير المحفوظة في مرتجع الشراء (شحن/مصاريف/خصم/دفع) —
              التسوية عبر مفتاح «تسوية المرتجع» أدناه لا قسم الدفع العام. */}
          <TotalsPanel
            items={state.items}
            state={state}
            dispatch={dispatch}
            showShipping={false}
            showOtherExpenses={false}
            showDiscount={false}
            showPayment={false}
          />

          {/* تسوية المرتجع الصريحة (تدقيق ١٧/٧): الافتراض «خصم من ذمة المورد» ⇒ لا قبض نقديّ وهميّ. */}
          <div className="rounded-md border px-3 py-2 text-xs">
            <div className="mb-1.5 font-semibold text-muted-foreground">تسوية المرتجع</div>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => setSettlement("CREDIT")}
                aria-pressed={settlement === "CREDIT"}
                className={`flex-1 rounded px-2 py-1.5 font-semibold transition-colors ${
                  settlement === "CREDIT" ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-muted/80"
                }`}
              >
                خصم من ذمة المورد
              </button>
              <button
                type="button"
                onClick={() => setSettlement("CASH")}
                aria-pressed={settlement === "CASH"}
                className={`flex-1 rounded px-2 py-1.5 font-semibold transition-colors ${
                  settlement === "CASH" ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-muted/80"
                }`}
              >
                استلام نقديّ من المورد
              </button>
            </div>
            {settlement === "CASH" && (
              <div className="mt-1.5 flex items-center gap-1 text-[10px] font-semibold text-[var(--sem-warn)]">
                <AlertTriangle aria-hidden className="size-3" />
                يُقبض بقدر الدفع النقدي المثبت سابقاً فقط، والباقي يُخصم من ذمة المورد ويظهر في المستند.
              </div>
            )}
          </div>

          <ActionButtons
            invoiceType={TYPE}
            items={state.items}
            saving={mutation.isPending}
            pasteAvailable={pasteAvailable}
            availableActions={PURCHASE_RETURN_ACTIONS}
            onAction={handleAction}
          />
          <TermsAndNotes state={state} dispatch={dispatch} />
          <div className="rounded-md bg-muted/60 px-3 py-2 text-[11px] text-muted-foreground">
            <div className="flex justify-between">
              <span>إجمالي المرتجع</span>
              <span dir="ltr" className="font-bold">
                {totals.grandTotal}
              </span>
            </div>
            <div className="mt-1 text-[10px] opacity-70" dir="ltr">
              req: {clientRequestId.slice(0, 8)}…
            </div>
          </div>
        </aside>
      </div>

      <ShortcutsBar />
    </div>
  );
}
