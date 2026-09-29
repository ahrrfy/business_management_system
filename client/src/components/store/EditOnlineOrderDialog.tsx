import { useEffect, useState, useMemo } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AppSelect } from "@/components/ui/AppSelect";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { GOVERNORATES, deliveryFeeFor } from "@shared/governorates";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { fmtInt, formatQuantity } from "@/lib/money";
import { Loader2, Plus, Trash2, ShoppingCart, Search, AlertCircle, Package } from "lucide-react";

export interface EditOnlineOrderDialogProps {
  orderId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

interface EditableLineItem {
  id?: number;
  productUnitId: number;
  productName: string;
  variantLabel: string;
  unitName: string;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
}

export function EditOnlineOrderDialog({
  orderId,
  open,
  onOpenChange,
  onSuccess,
}: EditOnlineOrderDialogProps) {
  const utils = trpc.useUtils();

  const detailQ = trpc.storeAdmin.orders.detail.useQuery(
    { id: orderId! },
    { enabled: open && orderId != null }
  );

  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [governorate, setGovernorate] = useState("baghdad");
  const [shippingAddress, setShippingAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<EditableLineItem[]>([]);

  // Product search state
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedProductUnitId, setSelectedProductUnitId] = useState<string>("");

  const catalogQ = trpc.storeAdmin.catalog.list.useQuery(
    { q: searchQuery.trim(), limit: 20 },
    { enabled: open && searchQuery.trim().length > 1 }
  );

  // Settings for free shipping threshold
  const settingsQ = trpc.storeAdmin.settings.get.useQuery(undefined, { enabled: open });

  // Populate form state when order details load
  useEffect(() => {
    if (detailQ.data) {
      const d = detailQ.data;
      setCustomerName(d.customerName ?? "");
      setCustomerPhone(d.customerPhone ?? "");
      setGovernorate(d.governorate ?? "baghdad");
      setShippingAddress(d.addressText ?? "");
      setNotes("");
      const initialItems: EditableLineItem[] = (d.items ?? []).map((it) => {
        const uPrice = Number(it.unitPrice) || 0;
        const qty = Math.floor(Number(it.quantity)) || 1;
        return {
          id: it.id,
          productUnitId: it.productUnitId ?? 0,
          productName: it.productName,
          variantLabel: it.variantLabel,
          unitName: it.unitName,
          unitPrice: uPrice,
          quantity: qty,
          lineTotal: uPrice * qty,
        };
      });
      setItems(initialItems);
    }
  }, [detailQ.data]);

  const updateMutation = trpc.storeAdmin.orders.update.useMutation({
    onSuccess: (res) => {
      notify.ok(`تم تحديث الطلب بنجاح (المجموع: ${fmtInt(res.total)} د.ع)`);
      void utils.storeAdmin.orders.list.invalidate();
      void utils.storeAdmin.orders.detail.invalidate({ id: orderId! });
      void utils.storeAdmin.orders.counts.invalidate();
      onOpenChange(false);
      onSuccess?.();
    },
    onError: (e) => notify.err(e),
  });

  // Calculate live totals
  const subtotal = useMemo(() => {
    return items.reduce((acc, it) => acc + it.lineTotal, 0);
  }, [items]);

  const baseDeliveryFee = useMemo(() => {
    return deliveryFeeFor(governorate);
  }, [governorate]);

  const freeShippingThreshold = useMemo(() => {
    const raw = settingsQ.data?.freeShippingThreshold;
    return raw ? Number(raw) : null;
  }, [settingsQ.data]);

  const isFreeDelivery = useMemo(() => {
    return freeShippingThreshold != null && freeShippingThreshold > 0 && subtotal >= freeShippingThreshold;
  }, [freeShippingThreshold, subtotal]);

  const finalDeliveryFee = isFreeDelivery ? 0 : baseDeliveryFee;
  const hasCoupon = Boolean(detailQ.data?.couponCode);
  const couponDiscount = Number(detailQ.data?.couponDiscount ?? 0);
  // subtotal is sum of items line totals, which already reflect any coupon discount.
  // Grand total is subtotal + delivery fee.
  const grandTotal = Math.max(0, subtotal + finalDeliveryFee);

  // Available selectable units from catalog search
  const availableSearchUnits = useMemo(() => {
    if (!catalogQ.data?.rows) return [];
    const units: Array<{
      productUnitId: number;
      productName: string;
      variantLabel: string;
      unitName: string;
      price: number;
      stock: number;
    }> = [];

    for (const product of catalogQ.data.rows) {
      for (const variant of product.variants ?? []) {
        for (const unit of variant.units ?? []) {
          if (unit.isActive && unit.isStoreSaleUnit && unit.retailPrice) {
            units.push({
              productUnitId: unit.productUnitId,
              productName: product.name,
              variantLabel: variant.label || variant.sku,
              unitName: unit.unitName,
              price: Number(unit.retailPrice),
              stock: unit.availableUnits,
            });
          }
        }
      }
    }
    return units;
  }, [catalogQ.data]);

  function handleQuantityChange(index: number, newQty: number) {
    if (newQty <= 0) return;
    setItems((prev) => {
      const next = [...prev];
      const item = next[index];
      if (!item) return prev;
      const updatedQty = Math.floor(newQty);
      next[index] = {
        ...item,
        quantity: updatedQty,
        lineTotal: item.unitPrice * updatedQty,
      };
      return next;
    });
  }

  function handleRemoveItem(index: number) {
    setItems((prev) => prev.filter((_, i) => i !== index));
  }

  function handleAddSelectedUnit() {
    const unitId = Number(selectedProductUnitId);
    if (!unitId) return;
    const target = availableSearchUnits.find((u) => u.productUnitId === unitId);
    if (!target) return;

    // Check if already in items
    const existingIndex = items.findIndex((it) => it.productUnitId === target.productUnitId);
    if (existingIndex >= 0) {
      handleQuantityChange(existingIndex, items[existingIndex].quantity + 1);
    } else {
      setItems((prev) => [
        ...prev,
        {
          productUnitId: target.productUnitId,
          productName: target.productName,
          variantLabel: target.variantLabel,
          unitName: target.unitName,
          unitPrice: target.price,
          quantity: 1,
          lineTotal: target.price,
        },
      ]);
    }
    setSelectedProductUnitId("");
  }

  function handleSave() {
    if (!orderId) return;
    if (items.length === 0) {
      notify.err("يجب أن يحتوي الطلب على صنف واحد على الأقل");
      return;
    }
    // Verify all items have valid productUnitId
    const invalidItem = items.find((it) => !it.productUnitId || it.productUnitId <= 0);
    if (invalidItem) {
      notify.err(`الصنف «${invalidItem.productName}» ليس له معرّف وحدة بيع صحيح`);
      return;
    }

    updateMutation.mutate({
      id: orderId,
      customerName: customerName.trim() || null,
      customerPhone: customerPhone.trim() || null,
      governorate,
      shippingAddress: shippingAddress.trim() || null,
      notes: notes.trim() || null,
      items: hasCoupon
        ? undefined
        : items.map((it) => ({
            productUnitId: it.productUnitId,
            quantity: it.quantity,
          })),
    });
  }

  const isLoading = detailQ.isLoading;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl font-bold">
            <Package className="size-5 text-primary" />
            تعديل طلب المتجر {detailQ.data ? `#${detailQ.data.orderNumber}` : ""}
          </DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="flex h-48 items-center justify-center">
            <Loader2 className="size-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-6 py-2">
            {/* Customer & Address Details */}
            <div className="rounded-xl border p-4 bg-muted/20 space-y-4">
              <h3 className="font-semibold text-sm text-foreground flex items-center gap-2">
                بيانات المستلم والتوصيل
              </h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="customer-name">اسم العميل</Label>
                  <Input
                    id="customer-name"
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    placeholder="اسم المستلم"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="customer-phone">رقم الهاتف</Label>
                  <IntlPhoneInput
                    id="customer-phone"
                    value={customerPhone}
                    onChange={(val) => setCustomerPhone(val)}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="governorate">منطقة / محافظة التوصيل</Label>
                  <AppSelect
                    id="governorate"
                    value={governorate}
                    onValueChange={setGovernorate}
                  >
                    {GOVERNORATES.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name} ({fmtInt(g.deliveryFee)} د.ع)
                      </option>
                    ))}
                  </AppSelect>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="shipping-address">العنوان بالتفصيل</Label>
                  <Input
                    id="shipping-address"
                    value={shippingAddress}
                    onChange={(e) => setShippingAddress(e.target.value)}
                    placeholder="الشارع، المحلة، أقرب نقطة دالة"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="order-notes">ملاحظات إضافية للتوصيل</Label>
                <Textarea
                  id="order-notes"
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="ملاحظات على العنوان أو وقت التسليم..."
                />
              </div>
            </div>

            {/* Items Management */}
            <div className="rounded-xl border p-4 bg-muted/20 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-sm text-foreground flex items-center gap-2">
                  <ShoppingCart className="size-4 text-primary" />
                  أصناف الطلب ({items.length})
                </h3>
              </div>

              {hasCoupon && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400 flex items-start gap-2">
                  <AlertCircle className="size-4 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold">كوبون خصم مفعّل ({detailQ.data?.couponCode}):</span>
                    <span className="mr-1">
                      حُظر تعديل أصناف السلة لحماية الخصم المحاسبي للكوبون. يمكنك تعديل بيانات المستلم، المحافظة، وملاحظات التوصيل فقط. لتغيير الأصناف، يُرجى إلغاء الطلب وإنشاء طلب جديد.
                    </span>
                  </div>
                </div>
              )}

              {/* Items List Table */}
              <div className="overflow-x-auto rounded-lg border bg-background">
                <table className="w-full text-right text-sm">
                  <thead className="bg-muted text-muted-foreground border-b text-xs font-semibold">
                    <tr>
                      <th className="p-2.5">الصنف</th>
                      <th className="p-2.5">سعر المفرد</th>
                      <th className="p-2.5 text-center">الكمية</th>
                      <th className="p-2.5">المجموع</th>
                      <th className="p-2.5 text-center">حذف</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {items.map((it, idx) => (
                      <tr key={idx} className="hover:bg-muted/40 transition">
                        <td className="p-2.5">
                          <div className="font-medium text-foreground">{it.productName}</div>
                          <div className="text-xs text-muted-foreground">
                            {[it.variantLabel, it.unitName].filter(Boolean).join(" — ")}
                          </div>
                        </td>
                        <td className="p-2.5 whitespace-nowrap">{fmtInt(it.unitPrice)} د.ع</td>
                        <td className="p-2.5 text-center whitespace-nowrap">
                          <div className="inline-flex items-center gap-1 border rounded-md px-1 py-0.5 bg-background">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="size-6 p-0 h-6"
                              onClick={() => handleQuantityChange(idx, it.quantity - 1)}
                              disabled={hasCoupon || it.quantity <= 1}
                            >
                              -
                            </Button>
                            <span className="w-8 text-center font-bold text-sm">{formatQuantity(it.quantity)}</span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="size-6 p-0 h-6"
                              onClick={() => handleQuantityChange(idx, it.quantity + 1)}
                              disabled={hasCoupon}
                            >
                              +
                            </Button>
                          </div>
                        </td>
                        <td className="p-2.5 font-bold whitespace-nowrap">{fmtInt(it.lineTotal)} د.ع</td>
                        <td className="p-2.5 text-center">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="size-8 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                            onClick={() => handleRemoveItem(idx)}
                            disabled={hasCoupon || items.length <= 1}
                            title={hasCoupon ? "لا يمكن حذف أصناف لطلب يحمل كوبون" : "حذف الصنف من الطلب"}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Add Product Search */}
              {!hasCoupon && (
                <div className="pt-2 border-t space-y-2">
                  <Label className="text-xs font-semibold text-muted-foreground">
                    إضافة صنف جديد للطلب من الكتالوج
                  </Label>
                  <div className="flex flex-col md:flex-row gap-2">
                    <div className="relative flex-1">
                      <Search className="absolute right-2.5 top-2.5 size-4 text-muted-foreground" />
                      <Input
                        className="pr-8"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="ابحث عن منتج بالاسم أو الباركود..."
                      />
                    </div>

                    <div className="flex-1">
                      <AppSelect
                        value={selectedProductUnitId}
                        onValueChange={setSelectedProductUnitId}
                        placeholder={
                          catalogQ.isLoading
                            ? "جاري البحث..."
                            : availableSearchUnits.length > 0
                            ? "اختر الوحدة للإضافة"
                            : searchQuery.trim().length > 1
                            ? "لا توجد نتائج مطابقة"
                            : "اكتب اسم المنتج للبحث"
                        }
                        disabled={availableSearchUnits.length === 0}
                      >
                        {availableSearchUnits.map((u) => (
                          <option key={u.productUnitId} value={String(u.productUnitId)}>
                            {u.productName} ({u.variantLabel}) - {fmtInt(u.price)} د.ع [متاح: {formatQuantity(u.stock)}]
                          </option>
                        ))}
                      </AppSelect>
                    </div>

                    <Button
                      type="button"
                      variant="secondary"
                      className="gap-1.5 shrink-0"
                      onClick={handleAddSelectedUnit}
                      disabled={!selectedProductUnitId}
                    >
                      <Plus className="size-4" />
                      إضافة للطلب
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* Financial Summary */}
            <div className="rounded-xl border p-4 bg-background space-y-2 text-sm">
              <div className="flex justify-between text-muted-foreground">
                <span>مجموع الأصناف ({items.length} صنف):</span>
                <span className="font-semibold text-foreground">{fmtInt(subtotal)} د.ع</span>
              </div>

              <div className="flex justify-between items-center text-muted-foreground">
                <span>أجرة التوصيل ({GOVERNORATES.find((g) => g.id === governorate)?.name ?? governorate}):</span>
                {isFreeDelivery ? (
                  <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-bold">
                    <span className="line-through text-muted-foreground font-normal">{fmtInt(baseDeliveryFee)} د.ع</span>
                    <span>مجاني (تجاوز حد الفاتورة)</span>
                  </div>
                ) : (
                  <span className="font-semibold text-foreground">{fmtInt(baseDeliveryFee)} د.ع</span>
                )}
              </div>

              {hasCoupon && couponDiscount > 0 && (
                <div className="flex justify-between text-emerald-600 dark:text-emerald-400">
                  <span>كوبون الخصم ({detailQ.data?.couponCode}):</span>
                  <span className="font-semibold">{fmtInt(couponDiscount)} د.ع (مطبّق ومخصوم ضمن البنود)</span>
                </div>
              )}

              <div className="pt-2 border-t flex justify-between items-center text-base font-bold text-foreground">
                <span>الإجمالي النهائي:</span>
                <span className="text-lg text-primary">{fmtInt(grandTotal)} د.ع</span>
              </div>

              {isFreeDelivery && (
                <div className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1 mt-1">
                  <AlertCircle className="size-3.5" />
                  مؤهل للشحن المجاني (قيمة الطلب تجاوزت {fmtInt(freeShippingThreshold!)} د.ع)
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={updateMutation.isPending}
          >
            إلغاء
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            disabled={updateMutation.isPending || isLoading || items.length === 0}
            className="gap-2"
          >
            {updateMutation.isPending && <Loader2 className="size-4 animate-spin" />}
            حفظ التعديلات وتحديث الحجز
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
