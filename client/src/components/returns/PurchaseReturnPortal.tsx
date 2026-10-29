/**
 * PurchaseReturnPortal — المنفذ الثاني: مرتجعات الشراء (الموردين والشركات)
 *
 * يشمل:
 *  - اختيار المورد وكشف رصيده الدفتري المباشر
 *  - الرقم المرجعي لفاتورة المورد (اختياري)
 *  - مسح الباركود وجدول مرتجع المشتريات بسعر التكلفة
 *  - طرق التسوية: معادلة ذمم (خصم من رصيد المورد)، مردود نقدي (توريد للصندوق)، أو تحويل بنكي
 *  - طباعة سند إرجاع مشتريات حراري 80مم/58مم
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useOperationPermission } from "@/hooks/useOperationPermission";
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Coins,
  CreditCard,
  FileText,
  Minus,
  Package,
  Plus,
  Scale,
  ScanLine,
  Trash2,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { MoneyInput } from "@/components/form/MoneyInput";
import { AppSelect } from "@/components/ui/AppSelect";
import { D, fmt, moneyInput, round2 } from "@/lib/money";
import { purchaseReturnCartInputSchema } from "@shared/purchaseReturnCartInput";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  printPurchaseReturnVoucher,
  type PrintPurchaseReturnData,
} from "./printThermalReturnReceipt";
import { ProductSearchBar } from "@/components/invoice/ProductSearchBar";
import type { InvoiceLine } from "@/components/invoice/types";
import { canViewOperationData } from "@shared/operationPermissions";
import { lifecycleActionAllowed } from "@/lib/lifecycleActionPermission";

export interface PurchaseCartItem {
  id: string;
  variantId: number;
  productUnitId?: number;
  productName: string;
  barcode?: string | null;
  quantity: number;
  unitPrice: string;
  unit?: string;
  conversionFactor?: number;
}

interface PurchaseReturnPortalProps {
  initialPoRef?: string;
  onReturnSuccess: (data: PrintPurchaseReturnData) => void;
}

export function PurchaseReturnPortal(props: PurchaseReturnPortalProps) {
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  const branchId = me.data?.branchId ?? branches.data?.[0]?.id;
  if (!me.data || !branchId) return null;
  // Origin and the authenticated company identity distinguish deployments; null
  // is the actual single-company context, never a fabricated tenant identifier.
  const scope = JSON.stringify([
    window.location.origin,
    me.data.companyId,
    me.data.id,
    branchId,
  ]);
  return (
    <PurchaseReturnPortalScoped
      key={scope}
      {...props}
      storageKey={`purchase-return-pending:${scope}`}
    />
  );
}

function PurchaseReturnPortalScoped({
  initialPoRef,
  onReturnSuccess,
  storageKey,
}: PurchaseReturnPortalProps & { storageKey: string }) {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const operationPermission = useOperationPermission(
    "returns.executePurchaseReturnCart",
  );
  const costVisible =
    !!me.data &&
    canViewOperationData(me.data, "purchaseCost") &&
    canViewOperationData(me.data, "profitMargin");
  const canReadSuppliers =
    costVisible && lifecycleActionAllowed(me.data, "suppliers.list", true);
  const canReadDrawers =
    costVisible &&
    lifecycleActionAllowed(me.data, "returns.getOpenRefundDrawers", true);
  const branches = trpc.branches.list.useQuery();
  const activeBranchId = me.data?.branchId
    ? Number(me.data.branchId)
    : Number(branches.data?.[0]?.id);

  const purchaseReturnMutation =
    trpc.returns.executePurchaseReturnCart.useMutation();
  type Proposal = Parameters<typeof purchaseReturnMutation.mutateAsync>[0];
  const [restored] = useState(() => {
    const saved = sessionStorage.getItem(storageKey);
    return saved
      ? (JSON.parse(saved) as { proposal: Proposal; requestId: number | null })
      : null;
  });
  const submittedInput = useRef<Proposal | null>(restored?.proposal ?? null);
  const [frozen, setFrozen] = useState(!!restored);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [selectedSupplierId, setSelectedSupplierId] = useState<number | null>(
    restored?.proposal.supplierId ?? null,
  );
  const [purchaseRef, setPurchaseRef] = useState(
    restored?.proposal.reference ?? initialPoRef ?? "",
  );
  const [lastAddedId, setLastAddedId] = useState<string | null>(null);
  const [purchaseReason, setPurchaseReason] = useState(
    restored?.proposal.reason ?? "",
  );
  const [requestKey, setRequestKey] = useState(
    () => restored?.proposal.clientRequestId ?? crypto.randomUUID(),
  );
  const [pendingRequestId, setPendingRequestId] = useState<number | null>(
    restored?.requestId ?? null,
  );
  const [purchaseBarcode, setPurchaseBarcode] = useState("");
  const [purchaseCart, setPurchaseCart] = useState<PurchaseCartItem[]>(
    () =>
      restored?.proposal.items.map((item, i) => ({
        ...item,
        id: `restored-${i}`,
        unitPrice: item.unitCost,
      })) ?? [],
  );
  const [purchaseSettlement, setPurchaseSettlement] = useState<
    "CREDIT_OFFSET" | "CASH_IN" | "CARD_TRANSFER"
  >(restored?.proposal.settlement.method ?? "CREDIT_OFFSET");
  useEffect(() => {
    if (initialPoRef && !submittedInput.current) setPurchaseRef(initialPoRef);
  }, [initialPoRef]);
  const openDrawersQ = trpc.returns.getOpenRefundDrawers.useQuery(undefined, {
    enabled: canReadDrawers,
    refetchInterval: false,
  });
  const openDrawers = canReadDrawers ? (openDrawersQ.data ?? []) : [];
  const [selectedShiftId, setSelectedShiftId] = useState<number | null>(
    restored?.proposal.settlement.shiftId ?? null,
  );

  useEffect(() => {
    if (
      !submittedInput.current &&
      openDrawers.length > 0 &&
      selectedShiftId == null
    ) {
      const mine = openDrawers.find((d) => d.isMine);
      if (mine) {
        setSelectedShiftId(mine.shiftId);
      } else {
        setSelectedShiftId(openDrawers[0].shiftId);
      }
    }
  }, [openDrawers, selectedShiftId]);

  const selectedDrawer = useMemo(() => {
    return openDrawers.find((d) => d.shiftId === selectedShiftId) ?? null;
  }, [openDrawers, selectedShiftId]);

  const purchaseBarcodeRef = useRef<HTMLInputElement>(null);

  const suppliersQuery = trpc.suppliers.list.useQuery(undefined, {
    enabled: canReadSuppliers,
  });
  const suppliers = canReadSuppliers ? (suppliersQuery.data ?? []) : [];
  const selectedSupplier = useMemo(() => {
    if (!selectedSupplierId || !canReadSuppliers) return null;
    return suppliers.find((s) => s.id === selectedSupplierId) ?? null;
  }, [selectedSupplierId, suppliersQuery.data, canReadSuppliers]);

  const purchaseTotal = useMemo(() => {
    const total = purchaseCart.reduce(
      (sum, item) => sum.plus(moneyInput(item.unitPrice).times(moneyInput(item.quantity))),
      D(0),
    );
    return total.isFinite() ? round2(total).toFixed(2) : "0.00";
  }, [purchaseCart]);

  const purchaseTotalPieces = useMemo(() => {
    return purchaseCart.reduce((sum, item) => sum + item.quantity, 0);
  }, [purchaseCart]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "F2") return;
      e.preventDefault();
      const el = document.querySelector<HTMLInputElement>(
        "input[data-product-search='1']",
      );
      el?.focus();
      el?.select();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleAddProductFromSearch = (line: InvoiceLine) => {
    if (submittedInput.current || inFlight.current || !mounted.current) return;
    if (!costVisible)
      return notify.warn("هذه العملية تحتاج تفويض عرض التكلفة والربح");
    const variantId = line.variantId;
    const factor = Math.max(1, Number(line.conversionFactor) || 1);
    const costStr = String(line.price || line.costBase || "0");

    setPurchaseCart((prev) => {
      const existingIdx = prev.findIndex((i) => i.variantId === variantId);
      if (existingIdx >= 0) {
        const target = prev[existingIdx];
        const updated = [...prev];
        const newQty = target.quantity + (line.qty || 1);
        const [moved] = updated.splice(existingIdx, 1);
        const itemToPlace = { ...moved, quantity: newQty };
        setLastAddedId(itemToPlace.id);
        return [itemToPlace, ...updated];
      }
      const newId = `${variantId}-${Date.now()}`;
      setLastAddedId(newId);
      return [
        {
          id: newId,
          variantId,
          productUnitId: line.productUnitId,
          productName: line.name,
          barcode: line.barcode ?? null,
          quantity: line.qty || 1,
          unitPrice: costStr,
          unit: line.unit || "قطعة",
          conversionFactor: factor,
        },
        ...prev,
      ];
    });

    notify.ok(`أُضيف لمرتجع المشتريات: ${line.name}`);
  };

  const [purchaseScanPending, setPurchaseScanPending] = useState(false);
  const handlePurchaseScan = async (barcodeToScan?: string) => {
    if (submittedInput.current || inFlight.current || !mounted.current) return;
    if (!costVisible)
      return notify.warn("هذه العملية تحتاج تفويض عرض التكلفة والربح");
    const raw = (barcodeToScan ?? purchaseBarcode).trim();
    if (!raw) return;
    setPurchaseScanPending(true);
    try {
      const res = await utils.returns.lookupItemForReturn.fetch({
        barcode: raw,
      });
      if (submittedInput.current || inFlight.current || !mounted.current)
        return;
      if (!res) {
        notify.warn(`لم يتم العثور على منتج بالباركود: ${raw}`);
        return;
      }
      if (res.costPrice == null)
        return notify.warn("سعر التكلفة محجوب؛ لا يمكن إدراج الصنف بتكلفة صفر");
      const variantId = res.variantId;
      const costStr = String(res.costPrice || "0");

      setPurchaseCart((prev) => {
        const existingIdx = prev.findIndex((i) => i.variantId === variantId);
        if (existingIdx >= 0) {
          const target = prev[existingIdx];
          const updated = [...prev];
          const [moved] = updated.splice(existingIdx, 1);
          const itemToPlace = { ...moved, quantity: target.quantity + 1 };
          setLastAddedId(itemToPlace.id);
          return [itemToPlace, ...updated];
        }
        const newId = `${variantId}-${Date.now()}`;
        setLastAddedId(newId);
        return [
          {
            id: newId,
            variantId,
            productUnitId: res.productUnitId,
            productName: res.productName,
            barcode: res.barcode ?? raw,
            quantity: 1,
            unitPrice: costStr,
          },
          ...prev,
        ];
      });

      setPurchaseBarcode("");
      notify.ok(`أُضيف لمرتجع المورد: ${res.productName}`);
      purchaseBarcodeRef.current?.focus();
    } catch {
      notify.err("خطأ أثناء قراءة الصنف");
    } finally {
      setPurchaseScanPending(false);
    }
  };

  const handleExecutePurchaseReturn = async () => {
    if (inFlight.current) return;
    if (!costVisible)
      return notify.warn("هذه العملية تحتاج تفويض عرض التكلفة والربح");
    if (!operationPermission.allowed) {
      notify.err(operationPermission.reason);
      return;
    }
    let proposal = submittedInput.current;
    if (!proposal) {
      if (!selectedSupplierId || !selectedSupplier) {
        notify.warn("يرجى اختيار المورد أولاً");
        return;
      }
      if (purchaseCart.length === 0) {
        notify.warn("يرجى إضافة صنف واحد على الأقل لمرتجع المورد");
        return;
      }
      if (D(purchaseTotal).lte(0)) {
        notify.warn("مبلغ الإرجاع غير صالح");
        return;
      }
      if (!purchaseRef.trim() || purchaseReason.trim().length < 3) {
        notify.warn(
          "أدخل مرجع دليل اتفاق المورد وسبب الاستثناء قبل إرسال طلب اعتماد المالك",
        );
        return;
      }

      if (purchaseSettlement === "CASH_IN") {
        if (openDrawers.length === 0) {
          notify.warn(
            "لا توجد وردية كاشير مفتوحة حالياً في الفرع لتوريد النقد إليها — افتح وردية أولاً أو اختر طريقة أخرى",
          );
          return;
        }
        if (!selectedShiftId) {
          notify.warn(
            "يرجى اختيار درج النقدية / الوردية التي سيتم توريد النقد إليها",
          );
          return;
        }
      }

      const parsed = purchaseReturnCartInputSchema.safeParse({
          supplierId: selectedSupplierId!,
          branchId: activeBranchId,
          reference: purchaseRef.trim(),
          evidenceType: "SUPPLIER_ACKNOWLEDGEMENT",
          clientRequestId: requestKey,
          items: purchaseCart.map((i) => ({
            variantId: i.variantId,
            productUnitId: i.productUnitId,
            productName: i.productName,
            barcode: i.barcode,
            quantity: i.quantity,
            unitCost: i.unitPrice,
          })),
          settlement: {
            method: purchaseSettlement,
            totalAmount: String(purchaseTotal),
            reference:
              purchaseSettlement === "CARD_TRANSFER"
                ? purchaseRef.trim()
                : undefined,
            shiftId:
              purchaseSettlement === "CASH_IN"
                ? (selectedShiftId ?? undefined)
                : undefined,
          },
          reason: purchaseReason.trim(),
        });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const field = issue.path.filter((part) => typeof part === "string").join(".");
        const messages: Record<string, string> = {
          "settlement.reference": "مرجع الحوالة: أدخل مرجعاً لا يتجاوز 160 حرفاً قبل الإرسال",
          reference: "مرجع دليل المورد: أدخل مرجعاً لا يتجاوز 500 حرف قبل الإرسال",
          reason: "سبب المرتجع: أدخل سبباً من 3 إلى 500 حرف قبل الإرسال",
          "items.quantity": "كمية الصنف: أدخل عدداً صحيحاً موجباً قبل الإرسال",
          "items.unitCost": "سعر الصنف: أدخل مبلغاً غير سالب وبمنزلتين عشريتين كحد أقصى قبل الإرسال",
        };
        notify.warn(messages[field] ?? "بيانات المرتجع: صحح القيم قبل الإرسال");
        return;
      }
      proposal = parsed.data;

      const methodDesc =
        purchaseSettlement === "CREDIT_OFFSET"
          ? "معادلة ذمم (تقليل ذمة المورد علينا)"
          : purchaseSettlement === "CASH_IN"
            ? `مردود نقدي وتوريد إلى درج [${selectedDrawer?.userName || "الكاشير"}]`
            : "حوالة بنكية";

      inFlight.current = true;
      setBusy(true);
      const ok = await confirm({
        title: `تأكيد مرتجع الشراء للمورد: ${selectedSupplier.name}`,
        description: `طلب استثناء موثق باعتماد المالك: ${purchaseTotalPieces} قطعة بإجمالي ${fmt(String(purchaseTotal))} د.ع بتسوية [${methodDesc}].`,
        confirmText: pendingRequestId ? "متابعة الطلب" : "إرسال طلب الاعتماد",
        variant: "info",
      });
      if (!ok) {
        inFlight.current = false;
        setBusy(false);
        return;
      }
    }

    if (!proposal) return;
    try {
      inFlight.current = true;
      setBusy(true);
      // Persist before dispatch; storage failure must prevent an unrecoverable send.
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({ proposal, requestId: pendingRequestId }),
      );
      submittedInput.current = proposal;
      setFrozen(true);
      const res = await purchaseReturnMutation.mutateAsync(proposal);
      if (!mounted.current) return;
      if (res.mode === "INVALID_PROPOSAL") {
        setPendingRequestId(null);
        sessionStorage.removeItem(storageKey);
        submittedInput.current = null;
        setFrozen(false);
        notify.err(res.message);
        // Keep the SAME request key for visible correction, including retries.
        return;
      }
      if (res.mode === "REQUESTED") {
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({ proposal, requestId: res.requestId }),
        );
        setPendingRequestId(res.requestId);
        notify.ok(
          `طلب المرتجع ${res.requestId}: ${res.status === "PENDING" ? "بانتظار اعتماد المالك؛ لم يُرحّل" : res.status}`,
        );
        if (res.status !== "PENDING") {
          sessionStorage.removeItem(storageKey);
          submittedInput.current = null;
          setFrozen(false);
          setPendingRequestId(null);
          setRequestKey(crypto.randomUUID());
        }
        return;
      }
      if (!mounted.current) return;
      const document = res.document;
      notify.ok(`تم تسجيل مرتجع المشتريات بنجاح: ${document.returnNumber}`);

      const printData: PrintPurchaseReturnData = {
        returnNumber: document.returnNumber,
        supplierName: document.supplierName,
        supplierPhone: document.supplierPhone,
        reference: document.evidenceReference,
        method:
          document.settlement === "CREDIT"
            ? "CREDIT_OFFSET"
            : document.paymentMethod === "CASH"
              ? "CASH_IN"
              : "CARD_TRANSFER",
        totalAmount: document.totalAmount,
        postedAt: document.postedAt,
        approvedBy: document.createdByName,
        origin: document.origin,
        items: document.items.map((item) => ({
          name: item.productNameSnapshot,
          quantity: Number(item.quantity),
          unitCost: item.unitPrice,
          lineTotal: item.lineTotal,
        })),
      };

      void printPurchaseReturnVoucher(printData);
      void utils.suppliers.list.invalidate();
      onReturnSuccess(printData);

      setPurchaseCart([]);
      setPurchaseRef("");
      setPurchaseReason("");
      setPendingRequestId(null);
      setRequestKey(crypto.randomUUID());
      sessionStorage.removeItem(storageKey);
      submittedInput.current = null;
      setFrozen(false);
      purchaseBarcodeRef.current?.focus();
    } catch (e: any) {
      notify.err(e.message || "تعذر تنفيذ مرتجع المشتريات");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  if (!costVisible || !operationPermission.allowed || !canReadSuppliers)
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          {!costVisible
            ? "مرتجع المورد يحتاج تفويض عرض التكلفة والربح إلى جانب تفويض عملية المرتجع."
            : !operationPermission.allowed
              ? operationPermission.reason
              : "مرتجع المورد يحتاج صلاحية عرض قائمة الموردين لاختيار المورد المرتبط بالعملية."}
        </CardContent>
      </Card>
    );
  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5">
      {frozen && (
        <div className="lg:col-span-12 rounded border p-3 text-sm">
          طلب {pendingRequestId} بانتظار الاعتماد. احتُفظ بالبيانات ومفتاح
          الطلب.{" "}
          <a href="/purchases/returns-governance" className="underline">
            افتح سجل الحوكمة
          </a>
          <Button
            variant="outline"
            disabled={busy || purchaseReturnMutation.isPending}
            onClick={() => void handleExecutePurchaseReturn()}
          >
            تحديث نتيجة الطلب
          </Button>
        </div>
      )}
      <fieldset data-no-draft disabled={frozen || busy} className="contents">
        {/* العمود الرئيسي: المورد وسلة مرتجع الشراء */}
        <div className="lg:col-span-8 space-y-3.5">
          {/* بطاقة المورد والبيانات المرجعية — تصميم رشيق ومضغوط للأعلى */}
          <Card className="shadow-xs border-blue-500/20">
            <CardContent className="p-3">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 items-end">
                {/* قائمة الموردين */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <label className="text-[11px] font-semibold text-foreground">
                      المورد المطلوب إرجاع البضاعة له *
                    </label>
                    {selectedSupplier && (
                      <Badge
                        variant={
                          moneyInput(selectedSupplier.currentBalance).gt(0)
                            ? "destructive"
                            : "secondary"
                        }
                        className="font-mono text-[10px] px-1.5 py-0"
                      >
                        رصيده:{" "}
                        {fmt(String(selectedSupplier.currentBalance || "0"))}{" "}
                        د.ع
                      </Badge>
                    )}
                  </div>
                  <AppSelect
                    value={selectedSupplierId ? String(selectedSupplierId) : ""}
                    onValueChange={(val) => {
                      if (!submittedInput.current && !inFlight.current)
                        setSelectedSupplierId(val ? Number(val) : null);
                    }}
                    placeholder="اختر المورد..."
                    searchable
                    searchPlaceholder="ابحث عن المورد بالاسم أو الهاتف..."
                  >
                    <option value="">-- اختر المورد --</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={String(s.id)}>
                        {s.name} {s.phone ? `(${s.phone})` : ""}
                      </option>
                    ))}
                  </AppSelect>
                </div>

                {/* الرقم المرجعي لفاتورة الشراء */}
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-foreground">
                    مرجع إقرار المورد (إلزامي)
                  </label>
                  <Input
                    value={purchaseRef}
                    onChange={(e) => setPurchaseRef(e.target.value)}
                    placeholder="PO-5432 أو 5432..."
                    className="h-8.5 text-xs"
                  />
                </div>

                {/* سبب الإرجاع */}
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-foreground">
                    سبب الإرجاع للمورد
                  </label>
                  <Input
                    value={purchaseReason}
                    onChange={(e) => setPurchaseReason(e.target.value)}
                    placeholder="عيب مصنعي، صلاحية، زائد عن الحاجة..."
                    className="h-8.5 text-xs"
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* سلة أصناف مرتجع الشراء */}
          <Card className="shadow-xs">
            <CardHeader className="p-3 pb-2 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-sm font-bold flex items-center gap-2">
                  <Package className="size-4 text-blue-600" aria-hidden />
                  <span>أصناف مرتجع المورد ({purchaseCart.length})</span>
                  {purchaseTotalPieces > 0 && (
                    <Badge
                      variant="secondary"
                      className="text-[11px] font-normal px-2 py-0"
                    >
                      إجمالي القطع: {purchaseTotalPieces}
                    </Badge>
                  )}
                </CardTitle>
                {purchaseCart.length > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setPurchaseCart([])}
                    className="h-7 text-xs text-muted-foreground hover:text-destructive px-2"
                  >
                    <Trash2 className="size-3 ml-1" />
                    تفريغ السلة
                  </Button>
                )}
              </div>

              {/* المكون الموحد للبحث عن منتجات المورد وإضافتها للسلة كما في الكاشير */}
              <ProductSearchBar
                invoiceType="PURCHASE_RETURN"
                branchId={activeBranchId}
                tier="RETAIL"
                onAddProduct={handleAddProductFromSearch}
                onNotify={(msg, kind) =>
                  kind === "error" ? notify.err(msg) : notify.info(msg)
                }
                placeholder="ابحث بالاسم أو SKU أو امسح الباركود لإدراج بضاعة المورد ومراجعة سعر الاتفاق... (F2)"
                compact={true}
                autoFocus={true}
              />
            </CardHeader>

            <CardContent className="p-3 pt-0">
              {purchaseCart.length === 0 ? (
                <div className="py-10 border-2 border-dashed rounded-xl text-center flex flex-col items-center justify-center gap-2 text-muted-foreground bg-muted/10">
                  <Building2 className="size-9 text-muted-foreground/40" />
                  <p className="font-semibold text-sm">
                    سلة مرتجع الشراء فارغة
                  </p>
                  <p className="text-xs max-w-sm">
                    استخدم حقل البحث الموحد أعلاه بالاسم أو مسح الباركود لإدراج
                    أصناف الاستثناء بسعر الاتفاق مع المورد
                  </p>
                </div>
              ) : (
                <div className="border rounded-xl overflow-hidden shadow-2xs">
                  <div className="max-h-[460px] overflow-y-auto overflow-x-auto">
                    <table className="w-full text-xs text-right">
                      <thead className="sticky top-0 bg-muted/95 backdrop-blur z-10 text-muted-foreground font-semibold border-b shadow-2xs">
                        <tr>
                          <th className="p-2.5">الصنف</th>
                          <th className="p-2.5 text-center w-36">الكمية</th>
                          <th className="p-2.5 w-36">سعر الاتفاق (د.ع)</th>
                          <th className="p-2.5 w-28 text-left">الإجمالي</th>
                          <th className="p-2.5 w-12 text-center">حذف</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {purchaseCart.map((item, idx) => {
                          const subtotal =
                            round2(moneyInput(item.unitPrice).times(moneyInput(item.quantity))).toFixed(2);
                          const isRecentlyAdded = item.id === lastAddedId;
                          return (
                            <tr
                              key={item.id}
                              className={cn(
                                "transition-colors duration-700",
                                isRecentlyAdded
                                  ? "bg-blue-500/20 dark:bg-blue-500/25 font-medium"
                                  : "hover:bg-muted/20",
                              )}
                            >
                              <td className="p-2.5">
                                <div className="font-bold text-foreground flex items-center gap-1.5 flex-wrap">
                                  <span>{item.productName}</span>
                                  {item.unit &&
                                    item.conversionFactor &&
                                    item.conversionFactor > 1 && (
                                      <span className="text-[10px] font-normal px-1.5 py-0.5 rounded bg-muted text-muted-foreground border">
                                        {item.unit} ({item.conversionFactor}{" "}
                                        قطعة)
                                      </span>
                                    )}
                                </div>
                                {item.barcode && (
                                  <span className="font-mono text-[10px] text-muted-foreground">
                                    {item.barcode}
                                  </span>
                                )}
                              </td>
                              <td className="p-2.5">
                                <div className="flex items-center justify-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setPurchaseCart((prev) =>
                                        prev.map((it, i) =>
                                          i === idx
                                            ? {
                                                ...it,
                                                quantity: Math.max(
                                                  1,
                                                  it.quantity - 1,
                                                ),
                                              }
                                            : it,
                                        ),
                                      );
                                    }}
                                    className="size-7 rounded border flex items-center justify-center hover:bg-muted text-muted-foreground"
                                  >
                                    <Minus className="size-3" />
                                  </button>
                                  <Input
                                    type="number"
                                    min={1}
                                    value={item.quantity}
                                    onChange={(e) => {
                                      const q = Math.max(
                                        1,
                                        parseInt(e.target.value, 10) || 1,
                                      );
                                      setPurchaseCart((prev) =>
                                        prev.map((it, i) =>
                                          i === idx
                                            ? { ...it, quantity: q }
                                            : it,
                                        ),
                                      );
                                    }}
                                    className="h-7 w-14 text-center text-xs font-bold p-0"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setPurchaseCart((prev) =>
                                        prev.map((it, i) =>
                                          i === idx
                                            ? {
                                                ...it,
                                                quantity: it.quantity + 1,
                                              }
                                            : it,
                                        ),
                                      );
                                    }}
                                    className="size-7 rounded border flex items-center justify-center hover:bg-muted text-muted-foreground"
                                  >
                                    <Plus className="size-3" />
                                  </button>
                                </div>
                              </td>
                              <td className="p-2.5">
                                <MoneyInput
                                  value={item.unitPrice}
                                  onChange={(p) => {
                                    setPurchaseCart((prev) =>
                                      prev.map((it, i) =>
                                        i === idx
                                          ? { ...it, unitPrice: p }
                                          : it,
                                      ),
                                    );
                                  }}
                                  className="h-7 text-xs font-mono"
                                  ariaLabel="سعر الاتفاق"
                                />
                              </td>
                              <td className="p-2.5 text-left font-mono font-bold">
                                {fmt(String(subtotal))}
                              </td>
                              <td className="p-2.5 text-center">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setPurchaseCart((prev) =>
                                      prev.filter((_, i) => i !== idx),
                                    );
                                  }}
                                  className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                                >
                                  <Trash2 className="size-4" />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="p-2.5 bg-muted/30 border-t flex items-center justify-between text-xs">
                    <button
                      type="button"
                      onClick={() => setPurchaseCart([])}
                      className="text-muted-foreground hover:text-destructive text-[11px]"
                    >
                      تفريغ السلة
                    </button>
                    <div className="flex items-center gap-3">
                      <span className="text-muted-foreground">
                        القطع:{" "}
                        <strong className="text-foreground">
                          {purchaseTotalPieces}
                        </strong>
                      </span>
                      <span>
                        المجموع:{" "}
                        <strong className="text-blue-700 dark:text-blue-400 font-mono font-bold text-sm">
                          {fmt(String(purchaseTotal))} د.ع
                        </strong>
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* العمود الجانبي: تسوية مرتجع الشراء */}
        <div className="lg:col-span-4 space-y-5">
          <Card className="shadow-sm border-blue-500/30">
            <CardHeader className="p-4 pb-2 border-b bg-muted/20">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <Scale className="size-4 text-blue-600" aria-hidden />
                <span>معادلة وتسوية حساب المورد</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-4">
              {/* كارت المبلغ الإجمالي */}
              <div className="p-4 bg-blue-500/10 border border-blue-500/20 rounded-xl text-center space-y-1">
                <span className="text-xs text-muted-foreground font-medium">
                  إجمالي قيمة مردود المشتريات
                </span>
                <div className="text-2xl font-black text-blue-700 dark:text-blue-400 font-mono">
                  {fmt(String(purchaseTotal))}{" "}
                  <span className="text-sm font-bold">د.ع</span>
                </div>
                <span className="text-[11px] text-muted-foreground">
                  الأصناف: {purchaseCart.length} ({purchaseTotalPieces} قطعة)
                </span>
              </div>

              {/* طريقة التسوية */}
              <div className="space-y-2">
                <label className="text-xs font-bold text-foreground">
                  المعالجة المالية
                </label>
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => setPurchaseSettlement("CREDIT_OFFSET")}
                    className={cn(
                      "w-full p-3 rounded-lg border text-right transition-all flex items-center justify-between text-xs cursor-pointer",
                      purchaseSettlement === "CREDIT_OFFSET"
                        ? "border-blue-600 bg-blue-50 dark:bg-blue-950/30 font-bold text-blue-900 dark:text-blue-200"
                        : "border-border hover:bg-muted/50 text-foreground",
                    )}
                  >
                    <div className="flex items-center gap-2.5">
                      <Scale className="size-4 text-blue-600" />
                      <div>
                        <div>معادلة ذمم (تقليل الذمة علينا)</div>
                        <div className="text-[10px] text-muted-foreground font-normal">
                          يُخصم مباشرة من رصيد المورد المستحق لدينا
                        </div>
                      </div>
                    </div>
                    {purchaseSettlement === "CREDIT_OFFSET" && (
                      <CheckCircle2 className="size-4 text-blue-600" />
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => setPurchaseSettlement("CASH_IN")}
                    className={cn(
                      "w-full p-3 rounded-lg border text-right transition-all flex items-center justify-between text-xs cursor-pointer",
                      purchaseSettlement === "CASH_IN"
                        ? "border-blue-600 bg-blue-50 dark:bg-blue-950/30 font-bold text-blue-900 dark:text-blue-200"
                        : "border-border hover:bg-muted/50 text-foreground",
                    )}
                  >
                    <div className="flex items-center gap-2.5">
                      <Wallet className="size-4 text-blue-600" />
                      <div>
                        <div>مردود نقدي (توريد نقد للصندوق)</div>
                        <div className="text-[10px] text-muted-foreground font-normal">
                          استلام نقد كاش من المورد وتوريده للدرج
                        </div>
                      </div>
                    </div>
                    {purchaseSettlement === "CASH_IN" && (
                      <CheckCircle2 className="size-4 text-blue-600" />
                    )}
                  </button>

                  {/* قائمة أدراج النقدية المفتوحة للتوريد إليها */}
                  {purchaseSettlement === "CASH_IN" && (
                    <div className="p-3 rounded-lg border border-blue-200 dark:border-blue-900/60 bg-blue-50/50 dark:bg-blue-950/20 space-y-2">
                      <div className="flex items-center justify-between text-xs font-bold text-blue-900 dark:text-blue-300">
                        <div className="flex items-center gap-1.5">
                          <Coins className="size-3.5" />
                          <span>اختيار درج الوردية المودع بها النقد:</span>
                        </div>
                        {openDrawers.length > 0 && (
                          <span className="text-[10px] text-muted-foreground font-normal font-mono">
                            {openDrawers.length} درج متاح
                          </span>
                        )}
                      </div>

                      {openDrawersQ.isLoading ? (
                        <div className="text-[11px] text-muted-foreground p-2 text-center">
                          جارٍ فحص أدراج النقدية المفتوحة...
                        </div>
                      ) : openDrawers.length === 0 ? (
                        <div className="p-2.5 rounded border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200 text-[11px] flex items-start gap-2">
                          <AlertTriangle className="size-4 shrink-0 text-amber-600 mt-0.5" />
                          <div>
                            <div className="font-bold">
                              لا توجد وردية كاشير مفتوحة حالياً
                            </div>
                            <div className="text-[10px] text-muted-foreground">
                              يجب فتح وردية في هذا الفرع لاستلام النقد في الدرج،
                              أو اختيار طريقة تسوية أخرى كمعادلة الذمم.
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-1.5 max-h-48 overflow-y-auto">
                          {openDrawers.map((dr) => {
                            const isSelected = dr.shiftId === selectedShiftId;
                            const shiftTypeLabel =
                              dr.shiftType === "RETAIL"
                                ? "تجزئة"
                                : dr.shiftType === "RECEPTION"
                                  ? "استقبال"
                                  : dr.shiftType === "PRINT_SERVICES"
                                    ? "طباعة"
                                    : dr.shiftType;

                            return (
                              <button
                                key={dr.shiftId}
                                type="button"
                                onClick={() => setSelectedShiftId(dr.shiftId)}
                                className={cn(
                                  "w-full p-2 rounded-md border text-right transition-all flex flex-col gap-1 cursor-pointer text-xs",
                                  isSelected
                                    ? "border-blue-600 bg-white dark:bg-card ring-1 ring-blue-500 font-bold shadow-xs"
                                    : "border-border/70 hover:bg-background/80 bg-background/50 text-foreground",
                                )}
                              >
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-1.5 font-bold">
                                    <span>{dr.userName}</span>
                                    <Badge
                                      variant="outline"
                                      className="text-[9px] py-0 px-1 font-normal"
                                    >
                                      {shiftTypeLabel}
                                    </Badge>
                                    {dr.isMine && (
                                      <Badge className="text-[9px] py-0 px-1 bg-blue-600 text-white hover:bg-blue-700 font-normal">
                                        درجي
                                      </Badge>
                                    )}
                                  </div>
                                  {isSelected && (
                                    <CheckCircle2 className="size-3.5 text-blue-600" />
                                  )}
                                </div>
                                <div className="flex items-center justify-between text-[11px] font-normal">
                                  <span className="text-muted-foreground">
                                    النقد الحالي بالدرج:
                                  </span>
                                  <span className="font-mono font-bold text-foreground">
                                    {fmt(dr.expectedCash)} د.ع
                                  </span>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => setPurchaseSettlement("CARD_TRANSFER")}
                    className={cn(
                      "w-full p-3 rounded-lg border text-right transition-all flex items-center justify-between text-xs cursor-pointer",
                      purchaseSettlement === "CARD_TRANSFER"
                        ? "border-blue-600 bg-blue-50 dark:bg-blue-950/30 font-bold text-blue-900 dark:text-blue-200"
                        : "border-border hover:bg-muted/50 text-foreground",
                    )}
                  >
                    <div className="flex items-center gap-2.5">
                      <CreditCard className="size-4 text-blue-600" />
                      <div>
                        <div>حوالة بنكية</div>
                        <div className="text-[10px] text-muted-foreground font-normal">
                          استلام حوالة من المورد على الحساب المصرفي
                        </div>
                      </div>
                    </div>
                    {purchaseSettlement === "CARD_TRANSFER" && (
                      <CheckCircle2 className="size-4 text-blue-600" />
                    )}
                  </button>
                </div>
              </div>

              {/* زر تأكيد مرتجع الشراء */}
              <Button
                type="button"
                onClick={() => void handleExecutePurchaseReturn()}
                disabled={
                  !operationPermission.allowed ||
                  purchaseReturnMutation.isPending ||
                  !selectedSupplierId ||
                  purchaseCart.length === 0 ||
                  D(purchaseTotal).lte(0)
                }
                className="w-full h-12 text-sm font-bold bg-blue-600 hover:bg-blue-700 text-white gap-2 shadow-sm cursor-pointer"
              >
                <FileText className="size-5" />
                <span>
                  {purchaseReturnMutation.isPending
                    ? "جاري تسجيل المرتجع..."
                    : "إرسال طلب استثناء باعتماد المالك"}
                </span>
              </Button>
            </CardContent>
          </Card>
        </div>
      </fieldset>
    </div>
  );
}
