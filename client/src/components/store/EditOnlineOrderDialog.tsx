import { useEffect, useState, useMemo, useCallback } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AppSelect } from "@/components/ui/AppSelect";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { UnifiedProductSearch, type PosProductRow } from "@/components/search/UnifiedProductSearch";
import { GOVERNORATES, deliveryFeeFor, isBaghdadGovernorate } from "@shared/governorates";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { fmtInt } from "@/lib/money";
import { Loader2, Trash2, ShoppingCart, AlertCircle, Package } from "lucide-react";

export interface EditOnlineOrderDialogProps {
  orderId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export interface EditableDeliveryZoneChoice {
  id: string;
  name: string;
  deliveryFee: number;
  isActive: boolean;
}

const ORDER_NOTE_SEPARATOR = "\nملاحظة:";
const LEADING_ORDER_NOTE_PREFIX = "ملاحظة:";

export function splitShippingAddressAndNotes(
  rawAddress: string | null | undefined,
): { shippingAddress: string; notes: string } {
  const raw = rawAddress?.trim() ?? "";
  if (!raw) {
    return { shippingAddress: "", notes: "" };
  }
  const sepIdx = raw.indexOf(ORDER_NOTE_SEPARATOR);
  if (sepIdx >= 0) {
    return {
      shippingAddress: raw.slice(0, sepIdx).trim(),
      notes: raw.slice(sepIdx + ORDER_NOTE_SEPARATOR.length).trim(),
    };
  }
  if (raw.startsWith(LEADING_ORDER_NOTE_PREFIX)) {
    return {
      shippingAddress: "",
      notes: raw.slice(LEADING_ORDER_NOTE_PREFIX.length).trim(),
    };
  }
  return { shippingAddress: raw, notes: "" };
}

export function resolveEditableDeliveryZoneOptions(
  zones: ReadonlyArray<EditableDeliveryZoneChoice> | null | undefined,
  currentGovernorate: string,
): EditableDeliveryZoneChoice[] {
  if (zones && zones.length > 0) {
    const filtered = zones.filter(
      (z) => z.isActive || z.id === currentGovernorate,
    );
    if (filtered.length > 0) {
      return filtered;
    }
  }
  return GOVERNORATES.map((g) => ({
    id: g.id,
    name: g.name,
    deliveryFee: g.deliveryFee,
    isActive: true,
  }));
}

export function computeEditOnlineOrderTotals(params: {
  governorate: string;
  zones: ReadonlyArray<EditableDeliveryZoneChoice>;
  items: ReadonlyArray<{
    unitPrice: number;
    retailUnitPrice?: number;
    quantity: number;
    lineTotal: number;
  }>;
  itemsModified: boolean;
  freeShippingThresholdSetting?: string | number | null;
  freeShippingThresholdGovernoratesSetting?: string | number | null;
  pricingBenefitDiscount?: string | number | null;
  couponDiscount?: string | number | null;
  couponFreeShipping?: boolean;
}) {
  const subtotal = params.items.reduce((acc, it) => acc + it.lineTotal, 0);
  const persistedMerchDiscount = Math.max(
    Number(params.pricingBenefitDiscount ?? 0) || 0,
    Number(params.couponDiscount ?? 0) || 0,
  );
  const eligibilitySubtotal = params.itemsModified
    ? params.items.reduce(
        (acc, it) => acc + (it.retailUnitPrice ?? it.unitPrice) * it.quantity,
        0,
      )
    : subtotal + persistedMerchDiscount;
  const matchedZone = params.zones.find((z) => z.id === params.governorate);
  const baseDeliveryFee = matchedZone
    ? matchedZone.deliveryFee
    : deliveryFeeFor(params.governorate);
  const rawThreshold = isBaghdadGovernorate(params.governorate)
    ? params.freeShippingThresholdSetting
    : (params.freeShippingThresholdGovernoratesSetting ??
      params.freeShippingThresholdSetting);
  const parsedThreshold = rawThreshold != null ? Number(rawThreshold) : NaN;
  const freeShippingThreshold =
    Number.isFinite(parsedThreshold) && parsedThreshold > 0
      ? parsedThreshold
      : null;
  const thresholdFree =
    freeShippingThreshold != null &&
    eligibilitySubtotal >= freeShippingThreshold;
  const couponShippingFree = Boolean(
    params.couponFreeShipping && !thresholdFree && baseDeliveryFee > 0,
  );
  const isFreeDelivery = thresholdFree || couponShippingFree;
  const finalDeliveryFee = isFreeDelivery ? 0 : baseDeliveryFee;
  const grandTotal = Math.max(0, subtotal + finalDeliveryFee);

  return {
    subtotal,
    eligibilitySubtotal,
    baseDeliveryFee,
    freeShippingThreshold,
    thresholdFree,
    couponShippingFree,
    isFreeDelivery,
    finalDeliveryFee,
    grandTotal,
  };
}

interface EditableLineItem {
  id?: number;
  productUnitId: number;
  productName: string;
  variantLabel: string;
  unitName: string;
  unitPrice: number;
  retailUnitPrice: number;
  quantity: number;
  lineTotal: number;
  hasCustomization: boolean;
  customizationSummary: string | null;
  maxOrderQty?: number;
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
  const [itemsModified, setItemsModified] = useState(false);
  const [qtyDrafts, setQtyDrafts] = useState<Record<number, string>>({});

  // Settings for free shipping threshold
  const settingsQ = trpc.storeAdmin.settings.get.useQuery(undefined, { enabled: open });

  // Populate form state when order details load
  useEffect(() => {
    if (detailQ.data) {
      const d = detailQ.data;
      const splitAddress = splitShippingAddressAndNotes(d.addressText);
      setCustomerName(d.customerName ?? "");
      setCustomerPhone(d.customerPhone ?? "");
      setGovernorate(d.governorate ?? "baghdad");
      setShippingAddress(splitAddress.shippingAddress);
      setNotes(splitAddress.notes);
      const initialItems: EditableLineItem[] = (d.items ?? []).map((it) => {
        const uPrice = Number(it.unitPrice) || 0;
        const rPrice = Number(it.retailUnitPrice ?? it.unitPrice) || uPrice;
        const qty = Math.floor(Number(it.quantity)) || 1;
        return {
          id: it.id,
          productUnitId: it.productUnitId ?? 0,
          productName: it.productName,
          variantLabel: it.variantLabel,
          unitName: it.unitName,
          unitPrice: uPrice,
          retailUnitPrice: rPrice,
          quantity: qty,
          lineTotal: uPrice * qty,
          hasCustomization: it.hasCustomization,
          customizationSummary: it.customizationSummary ?? null,
        };
      });
      setItems(initialItems);
      setItemsModified(false);
      setQtyDrafts({});
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

  const zoneOptions = useMemo(
    () => resolveEditableDeliveryZoneOptions(detailQ.data?.deliveryZones, governorate),
    [detailQ.data?.deliveryZones, governorate],
  );

  const totals = useMemo(
    () =>
      computeEditOnlineOrderTotals({
        governorate,
        zones: zoneOptions,
        items,
        itemsModified,
        freeShippingThresholdSetting: settingsQ.data?.freeShippingThreshold,
        freeShippingThresholdGovernoratesSetting:
          settingsQ.data?.freeShippingThresholdGovernorates,
        pricingBenefitDiscount: detailQ.data?.pricingBenefitDiscount,
        couponDiscount: detailQ.data?.couponDiscount,
        couponFreeShipping: detailQ.data?.couponFreeShipping,
      }),
    [governorate, zoneOptions, items, itemsModified, settingsQ.data, detailQ.data],
  );

  const {
    subtotal,
    baseDeliveryFee,
    freeShippingThreshold,
    thresholdFree,
    couponShippingFree,
    isFreeDelivery,
    grandTotal,
  } = totals;
  const hasCoupon = Boolean(detailQ.data?.couponCode);
  const hasCustomization = items.some((item) => item.hasCustomization);
  const itemsLocked = hasCoupon || hasCustomization;
  const couponDiscount = Number(detailQ.data?.couponDiscount ?? 0);

  function handleQuantityChange(index: number, newQty: number, fromDraft = false) {
    if (!Number.isFinite(newQty) || newQty <= 0) return;
    const item = items[index];
    if (!item) return;
    let updatedQty = Math.max(1, Math.floor(newQty));
    if (item.maxOrderQty !== undefined && updatedQty > item.maxOrderQty) {
      notify.err(
        `الكمية المطلوبة من «${item.productName}» تتجاوز المتاح في المخزون (${item.maxOrderQty} ${item.unitName})`,
      );
      updatedQty = Math.max(1, item.maxOrderQty);
      if (fromDraft) {
        setQtyDrafts((prev) => ({ ...prev, [index]: String(updatedQty) }));
      }
    }
    if (!fromDraft) {
      setQtyDrafts((prev) => {
        if (!(index in prev)) return prev;
        const copy = { ...prev };
        delete copy[index];
        return copy;
      });
    }
    if (updatedQty !== item.quantity) {
      setItemsModified(true);
    }
    setItems((prev) => {
      const next = [...prev];
      const current = next[index];
      if (!current) return prev;
      next[index] = {
        ...current,
        quantity: updatedQty,
        lineTotal: current.unitPrice * updatedQty,
      };
      return next;
    });
  }

  function handleRemoveItem(index: number) {
    setQtyDrafts({});
    setItemsModified(true);
    setItems((prev) => prev.filter((_, i) => i !== index));
  }

  const handleAddProductFromSearch = useCallback(
    (product: PosProductRow) => {
      const effectivePriceStr = product.promotionEffectivePrice ?? product.price;
      const unitPrice = effectivePriceStr != null ? Number(effectivePriceStr) : NaN;
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        notify.err(`الصنف «${product.productName}» ليس له سعر مفرد محدد في الكتالوج`);
        return;
      }
      const retailUnitPrice = Number(product.price ?? effectivePriceStr) || unitPrice;

      const factor = Math.max(1, Number(product.conversionFactor) || 1);
      const initialQtyForUnit = (detailQ.data?.items ?? [])
        .filter((i) => i.productUnitId === product.productUnitId)
        .reduce((acc, i) => acc + (Math.floor(Number(i.quantity)) || 0), 0);
      const freeBase = Math.max(0, Number(product.availableBase ?? product.stockBase ?? 0));
      const maxOrderQty = product.isService
        ? undefined
        : initialQtyForUnit + Math.floor(freeBase / factor);

      const existingIndex = items.findIndex((it) => it.productUnitId === product.productUnitId);
      const targetQty = existingIndex >= 0 ? items[existingIndex]!.quantity + 1 : 1;
      if (maxOrderQty !== undefined && targetQty > maxOrderQty) {
        notify.err(
          maxOrderQty <= 0
            ? `الصنف «${product.productName}» نافد حالياً من مخزون الفرع (المتاح للبيع: 0)`
            : `الكمية المطلوبة من «${product.productName}» تتجاوز المتاح في المخزون (${maxOrderQty} ${product.unitName})`,
        );
        return;
      }

      const variantParts = Array.from(
        new Set(
          [product.variantName, product.color, product.size]
            .map((v) => v?.trim())
            .filter((v): v is string => Boolean(v) && v !== product.productName.trim()),
        ),
      );
      const variantLabel = variantParts.join(" — ") || product.sku;

      setQtyDrafts({});
      setItemsModified(true);
      setItems((prev) => {
        const idx = prev.findIndex((it) => it.productUnitId === product.productUnitId);
        if (idx >= 0) {
          const next = [...prev];
          const current = next[idx]!;
          const updatedQty = current.quantity + 1;
          next[idx] = {
            ...current,
            quantity: updatedQty,
            lineTotal: current.unitPrice * updatedQty,
            maxOrderQty,
          };
          return next;
        }
        return [
          ...prev,
          {
            productUnitId: product.productUnitId,
            productName: product.productName,
            variantLabel,
            unitName: product.unitName,
            unitPrice,
            retailUnitPrice,
            quantity: 1,
            lineTotal: unitPrice,
            hasCustomization: false,
            customizationSummary: null,
            maxOrderQty,
          },
        ];
      });
    },
    [detailQ.data?.items, items],
  );

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
      items:
        itemsLocked || !itemsModified
          ? undefined
          : items.map((it) => ({
              productUnitId: it.productUnitId,
              quantity: it.quantity,
            })),
    });
  }

  const isLoading = detailQ.isLoading;
  const orderBranchId = detailQ.data?.branchId ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-no-draft className="sm:max-w-3xl max-h-[90vh] overflow-y-auto" dir="rtl">
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
                    {zoneOptions.map((g) => (
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
              {hasCustomization && (
                <div className="flex items-start gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 p-3 text-sm text-blue-700 dark:text-blue-300">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <span>هذا الطلب يحوي تفاصيل تخصيص محفوظة لكل صنف. يمكنك تعديل بيانات المستلم فقط؛ تعديل الأصناف يتطلب إنشاء طلب جديد كي لا تضيع تعليمات الزبون.</span>
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
                      <tr key={`${it.productUnitId}-${idx}`} className="hover:bg-muted/40 transition">
                        <td className="p-2.5">
                          <div className="font-medium text-foreground">{it.productName}</div>
                          <div className="text-xs text-muted-foreground">
                            {[it.variantLabel, it.unitName].filter(Boolean).join(" — ")}
                          </div>
                          {it.customizationSummary && <div className="mt-1 text-xs font-semibold text-blue-700 dark:text-blue-300">تخصيص: {it.customizationSummary}</div>}
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
                              disabled={itemsLocked || it.quantity <= 1}
                            >
                              -
                            </Button>
                            <input
                              type="number"
                              min={1}
                              max={it.maxOrderQty}
                              data-no-draft
                              disabled={itemsLocked}
                              value={qtyDrafts[idx] ?? String(it.quantity)}
                              onChange={(e) => {
                                const raw = e.target.value;
                                setQtyDrafts((prev) => ({ ...prev, [idx]: raw }));
                                const parsed = parseInt(raw, 10);
                                if (Number.isFinite(parsed) && parsed >= 1) {
                                  handleQuantityChange(idx, parsed, true);
                                }
                              }}
                              onBlur={() => {
                                setQtyDrafts((prev) => {
                                  if (!(idx in prev)) return prev;
                                  const copy = { ...prev };
                                  delete copy[idx];
                                  return copy;
                                });
                              }}
                              className="w-12 text-center font-bold text-sm bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-primary rounded [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                              aria-label={`كمية ${it.productName}`}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="size-6 p-0 h-6"
                              onClick={() => handleQuantityChange(idx, it.quantity + 1)}
                              disabled={
                                itemsLocked ||
                                (it.maxOrderQty !== undefined && it.quantity >= it.maxOrderQty)
                              }
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
                            disabled={itemsLocked || items.length <= 1}
                            title={itemsLocked ? "لا يمكن تعديل أصناف طلب يحمل كوبوناً أو تخصيصاً" : "حذف الصنف من الطلب"}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Add Product Search — Unified POS & Barcode Component */}
              {!itemsLocked && orderBranchId != null && (
                <div className="pt-2 border-t space-y-2">
                  <Label className="text-xs font-semibold text-muted-foreground">
                    إضافة صنف جديد للطلب من الكتالوج (يدعم البحث الفوري بالاسم أو SKU أو مسح الباركود المباشر)
                  </Label>
                  <UnifiedProductSearch
                    branchId={orderBranchId}
                    mode="sale"
                    tier="RETAIL"
                    dropDirection="up"
                    branchName="فرع المتجر"
                    placeholder="ابحث عن منتج بالاسم أو SKU أو امسح الباركود للإضافة الفورية…"
                    onSelect={handleAddProductFromSearch}
                  />
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
                <span>
                  أجرة التوصيل (
                  {zoneOptions.find((g) => g.id === governorate)?.name ??
                    GOVERNORATES.find((g) => g.id === governorate)?.name ??
                    governorate}
                  ):
                </span>
                {isFreeDelivery ? (
                  <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-bold">
                    <span className="line-through text-muted-foreground font-normal">{fmtInt(baseDeliveryFee)} د.ع</span>
                    <span>
                      {couponShippingFree
                        ? "مجاني (كوبون شحن مجاني)"
                        : "مجاني (تجاوز حد الفاتورة)"}
                    </span>
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
                  {couponShippingFree
                    ? `شحن مجاني مفعّل عبر الكوبون (${detailQ.data?.couponCode ?? ""})`
                    : thresholdFree && freeShippingThreshold != null
                      ? `مؤهل للشحن المجاني (قيمة الأصناف بالمفرد تجاوزت ${fmtInt(freeShippingThreshold)} د.ع)`
                      : "مؤهل للشحن المجاني"}
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
