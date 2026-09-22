import React, { useState, useRef, useEffect, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { fmt } from "@/lib/money";
import { playReadyBeep } from "@/lib/notifyBeep";
import { normalizeBarcodeScannerInput } from "@/lib/barcodeScannerInput";
import { preopenShippingLabelWindow } from "@/lib/printing/shippingLabel";
import { printDispatchedItem } from "./printDispatchedItem";
import {
  ScanBarcode,
  Truck,
  Printer,
  AlertCircle,
  Loader2,
  Eye,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { AppSelect } from "@/components/ui/AppSelect";
import { RecentDispatchesList, type DispatchedItemHistory } from "./RecentDispatchesList";
import { DispatchPreviewCard, type ScannedDispatchOrder } from "./DispatchPreviewCard";
import { CancelDeliveryAssignmentDialog } from "./CancelDeliveryAssignmentDialog";

export type { DispatchedItemHistory };

interface Props {
  onDispatchSuccess?: () => void;
  defaultPartyId?: number | null;
}

export function BarcodeDispatchStream({ onDispatchSuccess, defaultPartyId }: Props) {
  const utils = trpc.useUtils();
  const partiesQuery = trpc.delivery.listParties.useQuery({ activeOnly: true });
  const parties = partiesQuery.data ?? [];
  const individualCouriers = parties.filter((p) => p.partyType === "INDIVIDUAL");
  const companyCouriers = parties.filter((p) => p.partyType === "COMPANY");

  const [selectedPartyId, setSelectedPartyId] = useState<number | null>(defaultPartyId ?? null);
  const [barcode, setBarcode] = useState("");
  const [externalTrackingRef, setExternalTrackingRef] = useState("");
  const [customFee, setCustomFee] = useState("");
  const [instantPrint, setInstantPrint] = useState(true);
  const [previewMode, setPreviewMode] = useState(false);
  const [previewOrder, setPreviewOrder] = useState<ScannedDispatchOrder | null>(null);
  const [recipientPhone, setRecipientPhone] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [deliveryNotes, setDeliveryNotes] = useState("");
  const [recentDispatches, setRecentDispatches] = useState<DispatchedItemHistory[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const [isLoadingLookup, setIsLoadingLookup] = useState(false);
  const [cancellingConsignment, setCancellingConsignment] = useState<{ id: number; number: string } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const selectedParty = parties.find((p) => p.id === selectedPartyId);

  // تحديث الجهة الافتراضية عند اكتمال تحميل الجهات
  useEffect(() => {
    if (!selectedPartyId && parties.length > 0) {
      setSelectedPartyId(defaultPartyId ?? parties[0]?.id ?? null);
    }
  }, [parties, selectedPartyId, defaultPartyId]);

  // تثبيت التركيز الدائم على حقل الباركود
  const focusInput = useCallback(() => {
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 50);
  }, []);

  const dispatchMutation = trpc.delivery.dispatchByBarcode.useMutation();

  const handlePrintItem = useCallback((item: DispatchedItemHistory) => {
    printDispatchedItem(item);
  }, []);

  const executeDispatch = async (payload: {
    cleanBarcode: string; customFeeStr?: string; extRef?: string;
    recName?: string; recPhone?: string; address?: string; notes?: string;
  }) => {
    if (!selectedPartyId) {
      setLastError("يرجى اختيار جهة التوصيل أولاً قبل المسح");
      notify.err("اختر جهة التوصيل");
      focusInput();
      return;
    }

    const labelWin = instantPrint ? preopenShippingLabelWindow() : null;

    try {
      const res = await dispatchMutation.mutateAsync({
        barcode: payload.cleanBarcode,
        partyId: selectedPartyId,
        deliveryFee: payload.customFeeStr || undefined,
        externalTrackingRef: payload.extRef || undefined,
        recipientName: payload.recName || undefined,
        recipientPhone: payload.recPhone || undefined,
        deliveryAddress: payload.address || undefined,
        notes: payload.notes || undefined,
        clientRequestId: crypto.randomUUID(),
      });

      playReadyBeep();

      const historyItem: DispatchedItemHistory = {
        consignmentId: res.consignmentId, consignmentNumber: res.consignmentNumber,
        sourceType: res.sourceType, sourceId: res.sourceId, sourceNumber: res.sourceNumber,
        invoiceNumber: res.invoiceNumber, codAmount: res.codAmount, deliveryFee: res.deliveryFee,
        recipientName: res.recipientName, recipientPhone: res.recipientPhone,
        deliveryAddress: res.deliveryAddress, partyName: res.partyName || selectedParty?.name || "المندوب",
        dispatchedAt: new Date(), externalTrackingRef: payload.extRef || undefined,
      };

      if (instantPrint) {
        printDispatchedItem(historyItem, labelWin);
      }

      setRecentDispatches((prev) => [historyItem, ...prev.slice(0, 19)]);
      setBarcode("");
      setExternalTrackingRef("");
      setCustomFee("");
      setPreviewOrder(null);
      notify.ok(
        "تم الإسناد بنجاح",
        `إرسالية ${res.consignmentNumber} — COD ${fmt(res.codAmount)} د.ع لـ ${res.recipientName ?? "العميل"}`,
      );

      onDispatchSuccess?.();
    } catch (err: any) {
      labelWin?.close();
      const msg = err.message || "تعذر إسناد الطلب";
      setLastError(msg);
      notify.err("فشل الإسناد", msg);
    } finally {
      focusInput();
    }
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setLastError(null);

    const raw = barcode.trim();
    if (!raw) return;

    if (!selectedPartyId) {
      setLastError("يرجى اختيار جهة التوصيل أولاً قبل المسح");
      notify.err("اختر جهة التوصيل");
      focusInput();
      return;
    }

    const cleanBarcode = normalizeBarcodeScannerInput(raw);

    if (previewMode) {
      setIsLoadingLookup(true);
      try {
        const orderData = await utils.workOrders.getByNumber.fetch({ orderNumber: cleanBarcode });
        if (!orderData) {
          notify.err(`لم يتم العثور على طلب أو فاتورة بالرمز: ${cleanBarcode}`);
          return;
        }
        const scanned: ScannedDispatchOrder = {
          id: orderData.id, kind: orderData.kind ?? "workOrder", orderNumber: orderData.orderNumber,
          title: orderData.title, status: orderData.status ?? null,
          branchId: orderData.branchId ? Number(orderData.branchId) : null,
          customerName: orderData.customerName, customerPhone: orderData.customerPhone,
          salePrice: orderData.salePrice, deposit: orderData.deposit,
          deliveryAddress: orderData.deliveryAddress, deliveryPhone: orderData.deliveryPhone,
          deliveryCost: orderData.deliveryCost, version: (orderData as { version?: number }).version,
          invoiceId: (orderData as { invoiceId?: number | null }).invoiceId,
          activeConsignment: (orderData as { activeConsignment?: ScannedDispatchOrder["activeConsignment"] }).activeConsignment ?? null,
        };

        setPreviewOrder(scanned);
        setRecipientName(scanned.customerName ?? "");
        setRecipientPhone(scanned.deliveryPhone ?? scanned.customerPhone ?? "");
        setDeliveryAddress(scanned.deliveryAddress ?? "");
        setCustomFee(scanned.deliveryCost ?? "");
        setDeliveryNotes((orderData as { notes?: string | null }).notes ?? "");
      } catch (err: any) {
        notify.err(err, "تعذر جلب بيانات الفاتورة/الطلب للمعاينة");
      } finally {
        setIsLoadingLookup(false);
      }
      return;
    }

    await executeDispatch({
      cleanBarcode,
      customFeeStr: customFee.trim() || undefined,
      extRef: externalTrackingRef.trim() || undefined,
    });
  };

  return (
    <div className="rounded-xl border bg-card p-4 space-y-4 shadow-sm" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
        <div className="flex items-center gap-2">
          <div className="p-2 bg-primary/10 text-primary rounded-lg">
            <ScanBarcode className="size-5" />
          </div>
          <div>
            <h3 className="font-bold text-sm text-foreground">الإسناد السريع بالباركود</h3>
            <p className="text-xs text-muted-foreground">
              امسح باركود طلبات المتجر (ORD-)، أو أوامر الشغل (WO-)، أو الفواتير (INV-) لإسنادها فورياً
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 bg-muted/50 px-3 py-1.5 rounded-lg border">
            <Eye className="size-4 text-muted-foreground" />
            <Label htmlFor="preview-toggle" className="text-xs font-semibold cursor-pointer">
              معاينة قبل الإسناد
            </Label>
            <Switch
              id="preview-toggle"
              checked={previewMode}
              onCheckedChange={(checked) => {
                setPreviewMode(checked);
                setPreviewOrder(null);
              }}
            />
          </div>

          <div className="flex items-center gap-2 bg-muted/50 px-3 py-1.5 rounded-lg border">
            <Printer className="size-4 text-muted-foreground" />
            <Label htmlFor="instant-print-toggle" className="text-xs font-semibold cursor-pointer">
              طباعة صامتة فورية
            </Label>
            <Switch
              id="instant-print-toggle"
              checked={instantPrint}
              onCheckedChange={setInstantPrint}
            />
          </div>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
          {/* اختيار جهة التوصيل عبر AppSelect المعتمد */}
          <div className="sm:col-span-5 space-y-1">
            <label className="text-xs font-bold text-foreground flex items-center gap-1">
              <Truck className="size-3.5 text-muted-foreground" />
              جهة التوصيل / المندوب
            </label>
            <AppSelect
              value={selectedPartyId ? String(selectedPartyId) : ""}
              onValueChange={(v) => {
                setSelectedPartyId(v ? Number(v) : null);
                focusInput();
              }}
              className="w-full h-10 text-sm font-bold"
            >
              <option value="">— اختر المندوب أو شركة التوصيل —</option>
              {individualCouriers.length > 0 && (
                <optgroup label="── المناديب الداخليين (سائقون بعُهدة نقدية) ──">
                  {individualCouriers.map((p) => (
                    <option key={p.id} value={String(p.id)}>
                      {p.name} (مندوب) {p.phone ? `— ${p.phone}` : ""}
                    </option>
                  ))}
                </optgroup>
              )}
              {companyCouriers.length > 0 && (
                <optgroup label="── شركات ومكاتب التوصيل (مطابقة كشوفات) ──">
                  {companyCouriers.map((p) => (
                    <option key={p.id} value={String(p.id)}>
                      {p.name} (شركة) {p.phone ? `— ${p.phone}` : ""}
                    </option>
                  ))}
                </optgroup>
              )}
            </AppSelect>
          </div>

          {/* حقل مسح الباركود الرئيسي */}
          <div className="sm:col-span-4 space-y-1">
            <label className="text-xs font-bold text-foreground flex items-center gap-1">
              <ScanBarcode className="size-3.5 text-primary" />
              باركود الطلب / الفاتورة
            </label>
            <div className="relative">
              <Input
                ref={inputRef}
                autoFocus
                placeholder="امسح الباركود (INV- / WO- / ORD-)..."
                value={barcode}
                onChange={(e) => setBarcode(e.target.value)}
                disabled={dispatchMutation.isPending || isLoadingLookup}
                className="h-10 text-base font-mono pr-10 focus:ring-2 focus:ring-primary"
                dir="ltr"
              />
              <div className="absolute right-3 top-2.5 text-muted-foreground pointer-events-none">
                {dispatchMutation.isPending || isLoadingLookup ? (
                  <Loader2 className="size-5 animate-spin text-primary" />
                ) : (
                  <ScanBarcode className="size-5" />
                )}
              </div>
            </div>
          </div>

          {/* رقم التتبع الخارجي (اختياري) */}
          <div className="sm:col-span-3 space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              مرجع خارجي للشركة (اختياري)
            </label>
            <Input
              placeholder="رقم تتبع الشركة..."
              value={externalTrackingRef}
              onChange={(e) => setExternalTrackingRef(e.target.value)}
              disabled={dispatchMutation.isPending || isLoadingLookup}
              className="h-10 text-sm font-mono"
              dir="ltr"
            />
          </div>
        </div>

        {lastError && (
          <div className="flex items-center gap-2 p-2.5 rounded-lg border border-destructive/40 bg-destructive/10 text-destructive text-xs font-medium">
            <AlertCircle className="size-4 shrink-0" />
            <span>{lastError}</span>
          </div>
        )}
      </form>

      {/* بطاقة المعاينة والتثبيت عند تفعيل وضع المعاينة */}
      {previewOrder && (
        <div className="pt-2">
          <DispatchPreviewCard
            order={previewOrder}
            isCompanyParty={selectedParty?.partyType === "COMPANY"}
            recipientName={recipientName}
            onRecipientNameChange={setRecipientName}
            recipientPhone={recipientPhone}
            onRecipientPhoneChange={setRecipientPhone}
            dispatchFee={customFee}
            onDispatchFeeChange={setCustomFee}
            deliveryAddress={deliveryAddress}
            onDeliveryAddressChange={setDeliveryAddress}
            deliveryNotes={deliveryNotes}
            onDeliveryNotesChange={setDeliveryNotes}
            externalTrackingRef={externalTrackingRef}
            onExternalTrackingRefChange={setExternalTrackingRef}
            onConfirmDispatch={() => {
              void executeDispatch({
                cleanBarcode: previewOrder.orderNumber,
                customFeeStr: customFee.trim() || undefined,
                extRef: externalTrackingRef.trim() || undefined,
                recName: recipientName.trim() || undefined,
                recPhone: recipientPhone.trim() || undefined,
                address: deliveryAddress.trim() || undefined,
                notes: deliveryNotes.trim() || undefined,
              });
            }}
            onCancel={() => {
              setPreviewOrder(null);
              setBarcode("");
              focusInput();
            }}
            onCancelAssignment={setCancellingConsignment}
            isPending={dispatchMutation.isPending}
          />
        </div>
      )}

      {/* سجل الإسناد السريع في هذه الجلسة */}
      <RecentDispatchesList
        items={recentDispatches}
        onPrint={handlePrintItem}
        onCancelAssignment={setCancellingConsignment}
      />

      {/* نافذة إلغاء إسناد التوصيل */}
      <CancelDeliveryAssignmentDialog
        consignment={cancellingConsignment}
        open={Boolean(cancellingConsignment)}
        onOpenChange={(open) => { if (!open) setCancellingConsignment(null); }}
        onCompleted={() => {
          if (cancellingConsignment) {
            const cid = cancellingConsignment.id;
            setRecentDispatches((prev) => prev.filter((it) => it.consignmentId !== cid));
            if (previewOrder?.activeConsignment?.id === cid) {
              setPreviewOrder(null); setBarcode(""); focusInput();
            }
          }
          void utils.delivery.invalidate();
          void utils.workOrders.invalidate();
        }}
      />
    </div>
  );
}
