import React, { useState, useRef, useEffect, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { fmt } from "@/lib/money";
import { playReadyBeep } from "@/lib/notifyBeep";
import { normalizeBarcodeScannerInput } from "@/lib/barcodeScannerInput";
import { printDeliverySlip, printReadyOrderLabel, type LabelPrintableOrder } from "@/lib/printing/deliveryDocs";
import { preopenShippingLabelWindow } from "@/lib/printing/shippingLabel";
import {
  ScanBarcode,
  Truck,
  Printer,
  CheckCircle2,
  AlertCircle,
  Loader2,
  RotateCcw,
  Sparkles,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

export interface DispatchedItemHistory {
  consignmentId: number;
  consignmentNumber: string;
  sourceType: "ONLINE_ORDER" | "WORK_ORDER" | "INVOICE";
  sourceId: number;
  sourceNumber: string;
  invoiceNumber?: string | null;
  codAmount: string;
  deliveryFee: string;
  recipientName?: string | null;
  recipientPhone?: string | null;
  deliveryAddress?: string | null;
  partyName: string;
  dispatchedAt: Date;
  externalTrackingRef?: string | null;
}

interface Props {
  onDispatchSuccess?: () => void;
  defaultPartyId?: number | null;
}

export function BarcodeDispatchStream({ onDispatchSuccess, defaultPartyId }: Props) {
  const partiesQuery = trpc.delivery.listParties.useQuery({ activeOnly: true });
  const parties = partiesQuery.data ?? [];

  const [selectedPartyId, setSelectedPartyId] = useState<number | null>(defaultPartyId ?? null);
  const [barcode, setBarcode] = useState("");
  const [externalTrackingRef, setExternalTrackingRef] = useState("");
  const [customFee, setCustomFee] = useState("");
  const [instantPrint, setInstantPrint] = useState(true);
  const [recentDispatches, setRecentDispatches] = useState<DispatchedItemHistory[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

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
    const labelWin = preopenShippingLabelWindow();
    const printableOrder: LabelPrintableOrder = {
      orderNumber: item.sourceNumber,
      title:
        item.sourceType === "ONLINE_ORDER"
          ? `طلب متجر #${item.sourceNumber}`
          : item.sourceType === "INVOICE"
          ? `فاتورة مبيعات #${item.sourceNumber}`
          : `أمر شغل #${item.sourceNumber}`,
      quantity: 1,
      salePrice: item.codAmount,
      deposit: "0",
      customerName: item.recipientName ?? null,
      customerPhone: item.recipientPhone ?? null,
      deliveryAddress: item.deliveryAddress ?? null,
      deliveryCost: item.deliveryFee,
    };

    try {
      printDeliverySlip(
        printableOrder,
        { name: item.partyName },
        {
          consignmentNumber: item.consignmentNumber,
          invoiceNumber: item.invoiceNumber ?? item.sourceNumber,
          codAmount: item.codAmount,
          deliveryFee: item.deliveryFee,
          externalTrackingRef: item.externalTrackingRef || undefined,
        },
      );
      void printReadyOrderLabel(printableOrder, {
        partyName: item.partyName,
        trackingNumber: item.consignmentNumber,
        cod: item.codAmount,
        externalTrackingRef: item.externalTrackingRef || undefined,
        into: labelWin,
      });
    } catch {
      labelWin?.close();
    }
  }, []);

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
    const labelWin = instantPrint ? preopenShippingLabelWindow() : null;

    try {
      const selectedParty = parties.find((p) => p.id === selectedPartyId);
      const res = await dispatchMutation.mutateAsync({
        barcode: cleanBarcode,
        partyId: selectedPartyId,
        deliveryFee: customFee.trim() ? customFee.trim() : undefined,
        externalTrackingRef: externalTrackingRef.trim() ? externalTrackingRef.trim() : undefined,
        clientRequestId: crypto.randomUUID(),
      });

      playReadyBeep();

      const historyItem: DispatchedItemHistory = {
        consignmentId: res.consignmentId,
        consignmentNumber: res.consignmentNumber,
        sourceType: res.sourceType,
        sourceId: res.sourceId,
        sourceNumber: res.sourceNumber,
        invoiceNumber: res.invoiceNumber,
        codAmount: res.codAmount,
        deliveryFee: res.deliveryFee,
        recipientName: res.recipientName,
        recipientPhone: res.recipientPhone,
        deliveryAddress: res.deliveryAddress,
        partyName: res.partyName || selectedParty?.name || "المندوب",
        dispatchedAt: new Date(),
        externalTrackingRef: externalTrackingRef.trim() || undefined,
      };

      if (instantPrint) {
        const printableOrder: LabelPrintableOrder = {
          orderNumber: res.sourceNumber,
          title:
            res.sourceType === "ONLINE_ORDER"
              ? `طلب متجر #${res.sourceNumber}`
              : res.sourceType === "INVOICE"
              ? `فاتورة مبيعات #${res.sourceNumber}`
              : `أمر شغل #${res.sourceNumber}`,
          quantity: 1,
          salePrice: res.codAmount,
          deposit: "0",
          customerName: res.recipientName ?? null,
          customerPhone: res.recipientPhone ?? null,
          deliveryAddress: res.deliveryAddress ?? null,
          deliveryCost: res.deliveryFee,
        };

        printDeliverySlip(
          printableOrder,
          { name: historyItem.partyName },
          {
            consignmentNumber: res.consignmentNumber,
            invoiceNumber: res.invoiceNumber ?? res.sourceNumber,
            codAmount: res.codAmount,
            deliveryFee: res.deliveryFee,
            externalTrackingRef: externalTrackingRef.trim() || undefined,
          },
        );

        void printReadyOrderLabel(printableOrder, {
          partyName: historyItem.partyName,
          trackingNumber: res.consignmentNumber,
          cod: res.codAmount,
          externalTrackingRef: externalTrackingRef.trim() || undefined,
          into: labelWin,
        });
      }

      setRecentDispatches((prev) => [historyItem, ...prev.slice(0, 19)]);
      setBarcode("");
      setExternalTrackingRef("");
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

  return (
    <div className="rounded-xl border bg-card p-4 space-y-4 shadow-sm" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
        <div className="flex items-center gap-2">
          <div className="p-2 bg-primary/10 text-primary rounded-lg">
            <ScanBarcode className="size-5" />
          </div>
          <div>
            <h3 className="font-bold text-sm text-foreground">الإسناد السريع المتتابع بالباركود</h3>
            <p className="text-xs text-muted-foreground">
              امسح باركود طلبات المتجر (ORD-)، أو أوامر الشغل (WO-)، أو الفواتير (INV-) لإسنادها وطباعة بوليصتها فورياً
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
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
          {/* اختيار جهة التوصيل */}
          <div className="sm:col-span-4 space-y-1">
            <label className="text-xs font-bold text-foreground flex items-center gap-1">
              <Truck className="size-3.5 text-muted-foreground" />
              جهة التوصيل / المندوب
            </label>
            <select
              value={selectedPartyId ?? ""}
              onChange={(e) => {
                setSelectedPartyId(Number(e.target.value) || null);
                focusInput();
              }}
              className="w-full h-10 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="" disabled>اختر جهة التوصيل...</option>
              {parties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} {p.partyType === "COMPANY" ? "(شركة)" : "(مندوب)"} {p.phone ? `— ${p.phone}` : ""}
                </option>
              ))}
            </select>
          </div>

          {/* حقل مسح الباركود الرئيسي */}
          <div className="sm:col-span-5 space-y-1">
            <label className="text-xs font-bold text-foreground flex items-center gap-1">
              <ScanBarcode className="size-3.5 text-primary" />
              باركود الطلب / أمر الشغل / الفاتورة
            </label>
            <div className="relative">
              <Input
                ref={inputRef}
                autoFocus
                placeholder="امسح الباركود (ORD- / WO- / INV-)..."
                value={barcode}
                onChange={(e) => setBarcode(e.target.value)}
                disabled={dispatchMutation.isPending}
                className="h-10 text-base font-mono pr-10 focus:ring-2 focus:ring-primary"
                dir="ltr"
              />
              <div className="absolute right-3 top-2.5 text-muted-foreground pointer-events-none">
                {dispatchMutation.isPending ? (
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
              disabled={dispatchMutation.isPending}
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

      {/* سجل الإسناد السريع في هذه الجلسة */}
      {recentDispatches.length > 0 && (
        <div className="border-t pt-3 space-y-2">
          <div className="flex items-center justify-between text-xs font-bold text-muted-foreground px-1">
            <span>الطرود المسندة مؤخرا ({recentDispatches.length})</span>
            <span className="text-[11px] font-normal">تحديث فوري وإمكانية إعادة الطباعة</span>
          </div>

          <div className="divide-y rounded-lg border bg-muted/20 max-h-56 overflow-y-auto">
            {recentDispatches.map((item) => (
              <div
                key={item.consignmentId}
                className="flex items-center justify-between p-2.5 hover:bg-muted/40 transition-colors text-xs"
              >
                <div className="flex items-center gap-2.5">
                  <div className="p-1.5 rounded-full bg-emerald-500/10 text-emerald-600">
                    <CheckCircle2 className="size-4" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-foreground font-mono">{item.consignmentNumber}</span>
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                        {item.sourceType === "ONLINE_ORDER" ? "متجر" : item.sourceType === "INVOICE" ? "فاتورة" : "شغل"} #{item.sourceNumber}
                      </Badge>
                      <span className="text-muted-foreground">←</span>
                      <span className="font-semibold text-primary">{item.partyName}</span>
                    </div>
                    <div className="text-muted-foreground text-[11px] mt-0.5">
                      {item.recipientName ?? "عميل"} {item.recipientPhone ? `· ${item.recipientPhone}` : ""}
                      {item.deliveryAddress ? ` · ${item.deliveryAddress}` : ""}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <div className="text-left font-mono">
                    <div className="font-bold text-foreground">{fmt(item.codAmount)} د.ع</div>
                    {Number(item.deliveryFee) > 0 && (
                      <div className="text-[10px] text-muted-foreground">أجرة: {fmt(item.deliveryFee)} د.ع</div>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1 text-xs"
                    onClick={() => handlePrintItem(item)}
                    title="إعادة طباعة البوليصة والملصق"
                  >
                    <Printer className="size-3.5" />
                    طباعة
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
