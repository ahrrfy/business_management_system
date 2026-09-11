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
import React, { useMemo, useRef, useState } from "react";
import {
  Building2,
  CheckCircle2,
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
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  printPurchaseReturnVoucher,
  type PrintPurchaseReturnData,
} from "./printThermalReturnReceipt";

export interface PurchaseCartItem {
  id: string;
  variantId: number;
  productUnitId?: number;
  productName: string;
  barcode?: string | null;
  quantity: number;
  unitPrice: string;
}

interface PurchaseReturnPortalProps {
  onReturnSuccess: (data: PrintPurchaseReturnData) => void;
}

export function PurchaseReturnPortal({ onReturnSuccess }: PurchaseReturnPortalProps) {
  const utils = trpc.useUtils();

  const [selectedSupplierId, setSelectedSupplierId] = useState<number | null>(null);
  const [purchaseRef, setPurchaseRef] = useState("");
  const [purchaseReason, setPurchaseReason] = useState("");
  const [purchaseBarcode, setPurchaseBarcode] = useState("");
  const [purchaseCart, setPurchaseCart] = useState<PurchaseCartItem[]>([]);
  const [purchaseSettlement, setPurchaseSettlement] = useState<"CREDIT_OFFSET" | "CASH_IN" | "CARD_TRANSFER">("CREDIT_OFFSET");

  const purchaseBarcodeRef = useRef<HTMLInputElement>(null);

  const suppliersQuery = trpc.suppliers.list.useQuery();
  const selectedSupplier = useMemo(() => {
    if (!selectedSupplierId || !suppliersQuery.data) return null;
    return suppliersQuery.data.find((s) => s.id === selectedSupplierId) ?? null;
  }, [selectedSupplierId, suppliersQuery.data]);

  const purchaseTotal = useMemo(() => {
    return purchaseCart.reduce((sum, item) => sum + item.quantity * Number(item.unitPrice || 0), 0);
  }, [purchaseCart]);

  const purchaseTotalPieces = useMemo(() => {
    return purchaseCart.reduce((sum, item) => sum + item.quantity, 0);
  }, [purchaseCart]);

  const [purchaseScanPending, setPurchaseScanPending] = useState(false);
  const handlePurchaseScan = async (barcodeToScan?: string) => {
    const raw = (barcodeToScan ?? purchaseBarcode).trim();
    if (!raw) return;
    setPurchaseScanPending(true);
    try {
      const res = await utils.returns.lookupItemForReturn.fetch({ barcode: raw });
      if (!res) {
        notify.warn(`لم يتم العثور على منتج بالباركود: ${raw}`);
        return;
      }
      const variantId = res.variantId;
      const costStr = String(res.costPrice || "0");

      setPurchaseCart((prev) => {
        const existingIdx = prev.findIndex((i) => i.variantId === variantId);
        if (existingIdx >= 0) {
          const updated = [...prev];
          updated[existingIdx].quantity += 1;
          return updated;
        }
        return [
          ...prev,
          {
            id: `${variantId}-${Date.now()}`,
            variantId,
            productUnitId: res.productUnitId,
            productName: res.productName,
            barcode: res.barcode ?? raw,
            quantity: 1,
            unitPrice: costStr,
          },
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

  const purchaseReturnMutation = trpc.returns.executePurchaseReturnCart.useMutation();

  const handleExecutePurchaseReturn = async () => {
    if (!selectedSupplierId || !selectedSupplier) {
      notify.warn("يرجى اختيار المورد أولاً");
      return;
    }
    if (purchaseCart.length === 0) {
      notify.warn("يرجى إضافة صنف واحد على الأقل لمرتجع المورد");
      return;
    }
    if (purchaseTotal <= 0) {
      notify.warn("مبلغ الإرجاع غير صالح");
      return;
    }

    const methodDesc =
      purchaseSettlement === "CREDIT_OFFSET"
        ? "معادلة ذمم (تقليل ذمة المورد علينا)"
        : purchaseSettlement === "CASH_IN"
        ? "مردود نقدي (توريد نقد للدرج)"
        : "حوالة بنكية / بطاقة";

    const ok = await confirm({
      title: `تأكيد مرتجع الشراء للمورد: ${selectedSupplier.name}`,
      description: `سيتم إرجاع ${purchaseTotalPieces} قطعة بإجمالي ${fmt(String(purchaseTotal))} د.ع بتسوية [${methodDesc}]. هل تؤكد التنفيذ الذري فوراً؟`,
      confirmText: "تأكيد وطباعة السند",
      variant: "info",
    });
    if (!ok) return;

    try {
      const res = await purchaseReturnMutation.mutateAsync({
        supplierId: selectedSupplierId,
        reference: purchaseRef.trim() || undefined,
        items: purchaseCart.map((i) => ({
          variantId: i.variantId,
          productName: i.productName,
          barcode: i.barcode,
          quantity: i.quantity,
          unitCost: i.unitPrice,
        })),
        settlement: {
          method: purchaseSettlement,
          totalAmount: String(purchaseTotal),
        },
        reason: purchaseReason.trim() || undefined,
      });

      notify.ok(`تم تسجيل مرتجع المشتريات بنجاح: ${res.returnNumber}`);

      const printData: PrintPurchaseReturnData = {
        returnNumber: res.returnNumber,
        supplierName: res.supplierName,
        supplierPhone: res.supplierPhone,
        reference: res.reference,
        method: res.method,
        totalAmount: res.totalAmount,
        items: res.items,
      };

      void printPurchaseReturnVoucher(printData);
      void utils.suppliers.list.invalidate();
      onReturnSuccess(printData);

      setPurchaseCart([]);
      setPurchaseRef("");
      setPurchaseReason("");
      purchaseBarcodeRef.current?.focus();
    } catch (e: any) {
      notify.err(e.message || "تعذر تنفيذ مرتجع المشتريات");
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
      {/* العمود الرئيسي: المورد وسلة مرتجع الشراء */}
      <div className="lg:col-span-8 space-y-5">
        {/* بطاقة المورد والبيانات المرجعية */}
        <Card className="shadow-xs border-blue-500/20">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm font-bold flex items-center justify-between text-blue-700 dark:text-blue-400">
              <div className="flex items-center gap-2">
                <Building2 className="size-4" aria-hidden />
                <span>اختيار المورد وكشف الرصيد الحالي</span>
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-2 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* قائمة الموردين */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-foreground">
                  المورد المطلوب إرجاع البضاعة له *
                </label>
                <AppSelect
                  value={selectedSupplierId ? String(selectedSupplierId) : ""}
                  onValueChange={(val) => setSelectedSupplierId(val ? Number(val) : null)}
                  placeholder="اختر المورد..."
                >
                  <option value="">-- اختر المورد --</option>
                  {(suppliersQuery.data ?? []).map((s) => (
                    <option key={s.id} value={String(s.id)}>
                      {s.name} {s.phone ? `(${s.phone})` : ""}
                    </option>
                  ))}
                </AppSelect>
              </div>

              {/* الرقم المرجعي لفاتورة الشراء */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-foreground">
                  الرقم المرجعي للشراء (اختياري)
                </label>
                <Input
                  value={purchaseRef}
                  onChange={(e) => setPurchaseRef(e.target.value)}
                  placeholder="مثال: فاتورة شراء #PO-5432..."
                  className="h-9 text-xs"
                />
              </div>
            </div>

            {/* كارت تفاصيل رصيد المورد المختار */}
            {selectedSupplier && (
              <div className="p-3 bg-blue-50/50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900/50 rounded-lg flex flex-wrap items-center justify-between gap-3 text-xs">
                <div>
                  <span className="text-muted-foreground">المورد المحدد: </span>
                  <strong className="text-foreground text-sm">{selectedSupplier.name}</strong>
                  {selectedSupplier.phone && (
                    <span className="text-muted-foreground mr-2 font-mono">({selectedSupplier.phone})</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">الرصيد الدفتري الحالي:</span>
                  <Badge
                    variant={Number(selectedSupplier.currentBalance || 0) > 0 ? "destructive" : "secondary"}
                    className="font-mono text-xs px-2 py-0.5"
                  >
                    {fmt(String(selectedSupplier.currentBalance || "0"))} د.ع
                  </Badge>
                </div>
              </div>
            )}

            {/* سبب الإرجاع */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-foreground">
                سبب المردود للمورد
              </label>
              <Input
                value={purchaseReason}
                onChange={(e) => setPurchaseReason(e.target.value)}
                placeholder="مثال: عيب مصنعي، انتهاء صلاحية، بضاعة زائدة عن الحاجة..."
                className="h-9 text-xs"
              />
            </div>
          </CardContent>
        </Card>

        {/* سلة أصناف مرتجع الشراء */}
        <Card className="shadow-xs">
          <CardHeader className="p-4 pb-2">
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <Package className="size-4 text-blue-600" aria-hidden />
                <span>أصناف مرتجع المورد ({purchaseCart.length})</span>
              </CardTitle>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void handlePurchaseScan();
                }}
                className="flex items-center gap-2 flex-1 sm:max-w-md"
              >
                <div className="relative flex-1">
                  <Input
                    ref={purchaseBarcodeRef}
                    value={purchaseBarcode}
                    onChange={(e) => setPurchaseBarcode(e.target.value)}
                    placeholder="امسح باركود الصنف واضغط Enter..."
                    className="h-9 text-xs pr-8 font-mono"
                  />
                  <ScanLine className="absolute right-2.5 top-2.5 size-4 text-muted-foreground pointer-events-none" />
                </div>
                <Button
                  type="submit"
                  size="sm"
                  disabled={purchaseScanPending || !purchaseBarcode.trim()}
                  className="h-9 shrink-0 text-xs px-3 bg-blue-600 hover:bg-blue-700 text-white"
                >
                  {purchaseScanPending ? "إضافة..." : "إضافة للمرتجع"}
                </Button>
              </form>
            </div>
          </CardHeader>
          <CardContent className="p-4 pt-2">
            {purchaseCart.length === 0 ? (
              <div className="py-12 border-2 border-dashed rounded-xl text-center flex flex-col items-center justify-center gap-2 text-muted-foreground bg-muted/10">
                <Building2 className="size-10 text-muted-foreground/40" />
                <p className="font-semibold text-sm">سلة مرتجع الشراء فارغة</p>
                <p className="text-xs max-w-sm">
                  امسح باركود الأصناف المراد إرجاعها للمورد لإدراجها بسعر التكلفة وكميتها بدقة
                </p>
              </div>
            ) : (
              <div className="border rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-right">
                    <thead className="bg-muted/60 text-muted-foreground font-semibold border-b">
                      <tr>
                        <th className="p-2.5">الصنف</th>
                        <th className="p-2.5 text-center w-36">الكمية</th>
                        <th className="p-2.5 w-36">سعر التكلفة (د.ع)</th>
                        <th className="p-2.5 w-28 text-left">الإجمالي</th>
                        <th className="p-2.5 w-12 text-center">حذف</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {purchaseCart.map((item, idx) => {
                        const subtotal = item.quantity * Number(item.unitPrice || 0);
                        return (
                          <tr key={item.id} className="hover:bg-muted/20">
                            <td className="p-2.5">
                              <div className="font-bold text-foreground">{item.productName}</div>
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
                                          ? { ...it, quantity: Math.max(1, it.quantity - 1) }
                                          : it
                                      )
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
                                    const q = Math.max(1, parseInt(e.target.value, 10) || 1);
                                    setPurchaseCart((prev) =>
                                      prev.map((it, i) => (i === idx ? { ...it, quantity: q } : it))
                                    );
                                  }}
                                  className="h-7 w-14 text-center text-xs font-bold p-0"
                                />
                                <button
                                  type="button"
                                  onClick={() => {
                                    setPurchaseCart((prev) =>
                                      prev.map((it, i) =>
                                        i === idx ? { ...it, quantity: it.quantity + 1 } : it
                                      )
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
                                    prev.map((it, i) => (i === idx ? { ...it, unitPrice: p } : it))
                                  );
                                }}
                                className="h-7 text-xs font-mono"
                                ariaLabel="سعر التكلفة"
                              />
                            </td>
                            <td className="p-2.5 text-left font-mono font-bold">
                              {fmt(String(subtotal))}
                            </td>
                            <td className="p-2.5 text-center">
                              <button
                                type="button"
                                onClick={() => {
                                  setPurchaseCart((prev) => prev.filter((_, i) => i !== idx));
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
                      القطع: <strong className="text-foreground">{purchaseTotalPieces}</strong>
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
              <span className="text-xs text-muted-foreground font-medium">إجمالي قيمة مردود المشتريات</span>
              <div className="text-2xl font-black text-blue-700 dark:text-blue-400 font-mono">
                {fmt(String(purchaseTotal))} <span className="text-sm font-bold">د.ع</span>
              </div>
              <span className="text-[11px] text-muted-foreground">
                الأصناف: {purchaseCart.length} ({purchaseTotalPieces} قطعة)
              </span>
            </div>

            {/* طريقة التسوية */}
            <div className="space-y-2">
              <label className="text-xs font-bold text-foreground">المعالجة المالية</label>
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => setPurchaseSettlement("CREDIT_OFFSET")}
                  className={cn(
                    "w-full p-3 rounded-lg border text-right transition-all flex items-center justify-between text-xs cursor-pointer",
                    purchaseSettlement === "CREDIT_OFFSET"
                      ? "border-blue-600 bg-blue-50 dark:bg-blue-950/30 font-bold text-blue-900 dark:text-blue-200"
                      : "border-border hover:bg-muted/50 text-foreground"
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
                  {purchaseSettlement === "CREDIT_OFFSET" && <CheckCircle2 className="size-4 text-blue-600" />}
                </button>

                <button
                  type="button"
                  onClick={() => setPurchaseSettlement("CASH_IN")}
                  className={cn(
                    "w-full p-3 rounded-lg border text-right transition-all flex items-center justify-between text-xs cursor-pointer",
                    purchaseSettlement === "CASH_IN"
                      ? "border-blue-600 bg-blue-50 dark:bg-blue-950/30 font-bold text-blue-900 dark:text-blue-200"
                      : "border-border hover:bg-muted/50 text-foreground"
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
                  {purchaseSettlement === "CASH_IN" && <CheckCircle2 className="size-4 text-blue-600" />}
                </button>

                <button
                  type="button"
                  onClick={() => setPurchaseSettlement("CARD_TRANSFER")}
                  className={cn(
                    "w-full p-3 rounded-lg border text-right transition-all flex items-center justify-between text-xs cursor-pointer",
                    purchaseSettlement === "CARD_TRANSFER"
                      ? "border-blue-600 bg-blue-50 dark:bg-blue-950/30 font-bold text-blue-900 dark:text-blue-200"
                      : "border-border hover:bg-muted/50 text-foreground"
                  )}
                >
                  <div className="flex items-center gap-2.5">
                    <CreditCard className="size-4 text-blue-600" />
                    <div>
                      <div>حوالة بنكية / بطاقة</div>
                      <div className="text-[10px] text-muted-foreground font-normal">
                        استلام حوالة من المورد على الحساب المصرفي
                      </div>
                    </div>
                  </div>
                  {purchaseSettlement === "CARD_TRANSFER" && <CheckCircle2 className="size-4 text-blue-600" />}
                </button>
              </div>
            </div>

            {/* زر تأكيد مرتجع الشراء */}
            <Button
              type="button"
              onClick={() => void handleExecutePurchaseReturn()}
              disabled={
                purchaseReturnMutation.isPending ||
                !selectedSupplierId ||
                purchaseCart.length === 0 ||
                purchaseTotal <= 0
              }
              className="w-full h-12 text-sm font-bold bg-blue-600 hover:bg-blue-700 text-white gap-2 shadow-sm cursor-pointer"
            >
              <FileText className="size-5" />
              <span>
                {purchaseReturnMutation.isPending ? "جاري تسجيل المرتجع..." : "تأكيد مرتجع الشراء وطباعة السند"}
              </span>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
