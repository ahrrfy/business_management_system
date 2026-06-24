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
import { Download } from "lucide-react";
import { confirm } from "@/lib/confirm";
import { D, round2 } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { PageHeader } from "@/components/PageHeader";
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

export default function PurchaseReturnNew() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

  // 1) ───── حالة عامة + هوية المستخدم ─────────────────────────────────────────
  const me = trpc.auth.me.useQuery();
  const defaultBranchId = me.data?.branchId ?? 1;

  const [state, dispatch] = useReducer(
    invoiceReducer,
    undefined,
    () => ({ ...createInitialState(TYPE, defaultBranchId), branchId: defaultBranchId })
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

  // 4) ───── RBAC: التكلفة مرئية للمدير دائماً في مرتجع الشراء ─────────────────
  const showCost = true;

  // 5) ───── mutation: trpc.purchaseReturns.create ─────────────────────────────
  const mutation = trpc.purchaseReturns.create.useMutation({
    onSuccess: async () => {
      toast.success("تم إنشاء مرتجع الشراء بنجاح");
      await utils.purchases.list.invalidate();
      navigate("/purchases");
    },
    onError: (e) => {
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
  async function tryLoadFromReference() {
    const raw = (state.poReference || state.refInvoice || "").trim();
    if (!raw) {
      setRefLookupError("أدخل رقم أمر الشراء المرجعي.");
      return;
    }
    const match = raw.match(/\d+/);
    const id = match ? Number(match[0]) : NaN;
    if (!Number.isInteger(id) || id <= 0) {
      setRefLookupError("القيمة ليست مُعرّف أمر شراء صالحاً.");
      return;
    }
    if (id === refLastFetchedId && state.items.length > 0) {
      setRefLookupError(null);
      return;
    }

    setRefLookupError(null);
    try {
      const po = await utils.purchases.get.fetch({ purchaseOrderId: id });
      if (!po) {
        setRefLookupError("لم يُعثر على أمر الشراء.");
        return;
      }

      // — تعيين المورد والفرع من المرجع (الخادم يتحقّق منها لاحقاً)
      dispatch({ type: "SET_ENTITY", id: Number(po.supplierId) });
      dispatch({ type: "SET_FIELD", field: "branchId", value: Number(po.branchId) });

      // — بنود ⇒ خطوط السلة: نأخذ المُستلَم كحدّ أعلى للإرجاع، نتجاهل البنود غير المُستلَمة.
      const lines: InvoiceLine[] = (po.items ?? [])
        .filter((it) => Number(it.receivedBaseQuantity ?? 0) > 0)
        .map((it) => {
          // إعادة قسمة الأساس على معامل التحويل المخزّن:
          // الـ baseQuantity = quantity × conversionFactor ⇒ conversionFactor = baseQuantity/quantity
          const qtyUnits = D(it.quantity);
          const baseQty = D(it.baseQuantity);
          const conv = qtyUnits.gt(0)
            ? round2(baseQty.dividedBy(qtyUnits)).toString()
            : "1";
          // الحدّ الأعلى للإرجاع بوحدة الشراء = receivedBase / conversionFactor
          const recvBase = D(it.receivedBaseQuantity ?? 0);
          const recvInUnit = conv === "1" || conv === "0"
            ? recvBase.toNumber()
            : recvBase.dividedBy(D(conv)).toNumber();
          return {
            productId: 0, // غير مستخدم في الإرسال؛ المعروض هو variantId/productUnitId.
            variantId: Number(it.variantId),
            productUnitId: Number(it.productUnitId),
            name:
              (it.productName ?? "منتج") +
              (it.variantName ? ` — ${it.variantName}` : ""),
            sku: it.sku ?? "",
            barcode: null,
            unit: it.unitName ?? "وحدة",
            qty: Math.max(1, Math.floor(recvInUnit) || 1),
            conversionFactor: conv,
            stockBase: 0,
            price: D(it.unitPrice).toFixed(2),
            costBase: D(it.unitPrice).toFixed(2),
            discount: "0",
            discountType: "percent",
            tax: "0",
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
      setRefLastFetchedId(id);
      toast.success(`تم جلب ${lines.length} منتجاً من أمر الشراء ${po.poNumber ?? id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "تعذّر جلب أمر الشراء";
      setRefLookupError(msg);
    }
  }

  // 7) ───── الإجماليات للعرض/التحقّق ──────────────────────────────────────────
  const totals = useMemo(() => calcTotals(state.items, state), [state]);

  // 8) ───── التحقّق + الإرسال ────────────────────────────────────────────────
  function validateAndBuildPayload():
    | { ok: true; payload: Parameters<typeof mutation.mutate>[0] }
    | { ok: false; error: string } {
    if (!state.entityId) return { ok: false, error: "اختر المورد." };
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
    }

    const purchaseOrderRefId = (() => {
      if (refLastFetchedId) return refLastFetchedId;
      const raw = (state.poReference || state.refInvoice || "").trim();
      const m = raw.match(/\d+/);
      const n = m ? Number(m[0]) : NaN;
      return Number.isInteger(n) && n > 0 ? n : undefined;
    })();

    const paymentMethod = state.paymentMethod;
    const settlement: "CASH" | "CREDIT" =
      state.paymentTerms === "CREDIT" || state.paymentTerms === "INSTALLMENT"
        ? "CREDIT"
        : "CASH";

    const payload = {
      clientRequestId,
      supplierId: Number(state.entityId),
      branchId: Number(state.branchId),
      purchaseOrderRefId,
      items: state.items.map((l) => ({
        variantId: Number(l.variantId),
        productUnitId: Number(l.productUnitId),
        quantity: D(l.qty).toString(),
        unitPrice: D(l.price || l.costBase || "0").toFixed(2),
      })),
      reason: state.notes?.trim() || null,
      paymentMethod,
      settlement,
    };
    return { ok: true, payload };
  }

  async function handleSubmit() {
    const v = validateAndBuildPayload();
    if (!v.ok) {
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
    )
      return;
    mutation.mutate(v.payload);
  }

  function handleSaveDraft() {
    toast.info("حفظ المسوّدة غير مفعّل لمرتجعات الشراء بعد — احفظ مباشرة عند الجاهزية.");
  }

  function handlePrint() {
    window.print();
  }

  function handleAction(kind: InvoiceActionKind) {
    switch (kind) {
      case "save":
        handleSubmit();
        return;
      case "draft":
        handleSaveDraft();
        return;
      case "print":
        handlePrint();
        return;
      case "send":
      case "pdf":
      case "duplicate":
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
        handlePrint();
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
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={tryLoadFromReference}
              disabled={!state.poReference && !state.refInvoice}
              title="جلب بنود أمر الشراء المرجعي"
            >
              <Download aria-hidden className="size-4" />
              استيراد من أمر الشراء
            </Button>
            <Link href="/purchases" className="text-sm text-muted-foreground hover:underline">
              ← رجوع للمشتريات
            </Link>
          </>
        }
      />

      {refLookupError && (
        <div className="badge-stock-out rounded-md px-3 py-2 text-xs font-semibold">
          {refLookupError}
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
          <TotalsPanel items={state.items} state={state} dispatch={dispatch} />
          <ActionButtons
            invoiceType={TYPE}
            items={state.items}
            saving={mutation.isPending}
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
