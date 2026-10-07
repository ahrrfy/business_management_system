/**
 * CancelDeliveryAssignmentSection - قسم إلغاء الإسناد والتوصيل بالباركود
 * يتيح مسح باركود الطلب أو الإرسالية (أو إدخال الرقم يدوياً)
 * وعرض تفاصيل الإسناد الحالية، ثم إلغاء الإسناد ذرياً عبر delivery.cancelAssignment
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ScanLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { parseScan } from "@/lib/scanRouter";
import { storefrontUrl } from "@/lib/siteHosts";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { trpc } from "@/lib/trpc";
import { ACTION_LABELS as L } from "@shared/actionLabels";
import { CancelAssignmentOrderCard } from "./CancelAssignmentOrderCard";

export interface ScannedOrderForCancellation {
  id: number;
  kind?: "workOrder" | "invoice" | "onlineOrder";
  orderNumber: string;
  title: string | null;
  status?: string | null;
  branchId?: number | null;
  customerName: string | null;
  customerPhone: string | null;
  salePrice: string;
  deposit: string | null;
  deliveryAddress: string | null;
  deliveryPhone: string | null;
  deliveryCost: string | null;
  version: number;
  invoiceId?: number | null;
  qrUrl?: string | null;
  activeConsignment?: {
    id: number;
    consignmentNumber: string;
    partyId: number;
    partyName: string | null;
    partyType: "INDIVIDUAL" | "COMPANY" | null;
    parcelStatus: string;
    moneyStatus: string;
    codAmount: string;
    collectedAmount: string;
  } | null;
}

export interface CancelDeliveryAssignmentSectionProps {
  branchId?: number | null;
  scannedBarcode?: string | null;
  onBarcodeConsumed?: () => void;
  onNavigateToDispatch?: (order: ScannedOrderForCancellation) => void;
}

export function CancelDeliveryAssignmentSection({
  branchId,
  scannedBarcode,
  onBarcodeConsumed,
  onNavigateToDispatch,
}: CancelDeliveryAssignmentSectionProps) {
  const [barcodeInput, setBarcodeInput] = useState("");
  const [scannedOrder, setScannedOrder] = useState<ScannedOrderForCancellation | null>(null);
  const [reason, setReason] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const utils = trpc.useUtils();

  const lookupOrder = useCallback(
    async (raw: string) => {
      const r = parseScan(raw);
      const orderNumber =
        r.type === "workOrder" || r.type === "invoice" || r.type === "consignment"
          ? r.number
          : raw.trim();
      if (!orderNumber) return;

      setIsSearching(true);
      try {
        const wo = await utils.workOrders.getByNumber.fetch({ orderNumber });
        if (!wo) {
          notify.err(`طلب أو إرسالية غير موجودة: ${orderNumber}`);
          return;
        }

        const activeCn = (
          wo as {
            activeConsignment?: ScannedOrderForCancellation["activeConsignment"];
          }
        ).activeConsignment;

        const qrUrl =
          wo.kind === "onlineOrder"
            ? `${storefrontUrl()}?order=${encodeURIComponent(wo.orderNumber)}&token=${encodeURIComponent(wo.labelToken)}`
            : `${window.location.origin}/verify?payload=${encodeURIComponent(wo.qrPayload)}`;

        const order: ScannedOrderForCancellation = {
          id: wo.id,
          kind: wo.kind ?? "workOrder",
          orderNumber: wo.orderNumber,
          title: wo.title,
          status: wo.status ?? null,
          branchId: wo.branchId ? Number(wo.branchId) : null,
          customerName: wo.customerName,
          customerPhone: wo.customerPhone,
          salePrice: wo.salePrice,
          deposit: wo.deposit,
          deliveryAddress: wo.deliveryAddress,
          deliveryPhone: wo.deliveryPhone,
          deliveryCost: wo.deliveryCost,
          version: (wo as { version?: number }).version ?? 1,
          qrUrl,
          invoiceId: (wo as { invoiceId?: number | null }).invoiceId ?? null,
          activeConsignment: activeCn ?? null,
        };

        setScannedOrder(order);
        setBarcodeInput("");
        setReason("");

        if (!activeCn) {
          notify.info(
            `الطلب #${order.orderNumber} غير مسند حالياً`,
            "لا توجد إرسالية توصيل نشطة مسندة لهذا الطلب.",
          );
        } else {
          notify.ok(
            `تم العثور على الإرسالية ${activeCn.consignmentNumber}`,
            `مسندة لـ ${activeCn.partyName ?? "جهة التوصيل"}`,
          );
        }
      } catch (e) {
        notify.err(e, "تعذّر جلب بيانات الطلب أو الإرسالية");
      } finally {
        setIsSearching(false);
      }
    },
    [utils],
  );

  // استهلاك الباركود الخارجي الممرر من شاشة سير العمل
  useEffect(() => {
    if (scannedBarcode) {
      void lookupOrder(scannedBarcode);
      onBarcodeConsumed?.();
    }
  }, [scannedBarcode, lookupOrder, onBarcodeConsumed]);

  // التركيز التلقائي على حقل البحث عند تفريغ النتيجة
  useEffect(() => {
    if (!scannedOrder) {
      searchInputRef.current?.focus();
    }
  }, [scannedOrder]);

  const cancelAssignmentMut = trpc.delivery.cancelAssignment.useMutation({
    onSuccess: async () => {
      const cnNumber = scannedOrder?.activeConsignment?.consignmentNumber ?? "";
      notify.ok(
        `تم إلغاء إسناد الإرسالية ${cnNumber} بنجاح`,
        "حُررت عهدة المندوب المالية في دفتر التوصيل وعاد الطلب متاحاً للإسناد الجديد.",
      );
      await Promise.all([
        utils.delivery.invalidate(),
        utils.workOrders.invalidate(),
        utils.sales.invalidate(),
        utils.storeAdmin.orders.invalidate(),
      ]);
      setScannedOrder(null);
      setBarcodeInput("");
      setReason("");
    },
    onError: (e) => {
      notify.err(e, "تعذّر إلغاء إسناد الإرسالية");
    },
  });

  async function handleConfirmCancel() {
    if (!scannedOrder?.activeConsignment) return;
    if (reason.trim().length < 3) {
      notify.err("يرجى كتابة سبب الإلغاء (٣ أحرف على الأقل)");
      return;
    }

    const cn = scannedOrder.activeConsignment;
    const ok = await confirm({
      variant: "danger",
      title: "تأكيد إلغاء إسناد التوصيل",
      description: `سيتم إلغاء الإرسالية #${cn.consignmentNumber} وتحرير ذمة ${cn.partyName ?? "المندوب"} البالغة ${fmt(cn.codAmount)} د.ع.\n\nالسبب: ${reason.trim()}`,
      confirmText: "تأكيد إلغاء الإسناد",
    });
    if (!ok) return;

    cancelAssignmentMut.mutate({
      consignmentId: cn.id,
      reason: reason.trim(),
      clientRequestId: crypto.randomUUID(),
    });
  }

  function handleReset() {
    setScannedOrder(null);
    setBarcodeInput("");
    setReason("");
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4" dir="rtl">
      {!scannedOrder && (
        <div className="rounded-2xl border-2 border-dashed border-destructive/40 bg-destructive/5 p-6 text-center">
          <ScanLine aria-hidden className="mx-auto size-10 text-destructive/60" />
          <p className="mt-2 text-base font-extrabold text-destructive">
            امسح باركود الطلب أو الإرسالية لإلغاء الإسناد
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            أو أدخل رقم الطلب، الفاتورة، أو الإرسالية (CN-...) يدوياً
          </p>
          <div className="mt-4 flex gap-2">
            <UnifiedSearchInput
              ref={searchInputRef}
              value={barcodeInput}
              onChange={setBarcodeInput}
              onScan={(code: string) => void lookupOrder(code)}
              onSubmit={(val: string) => {
                if (val.trim()) void lookupOrder(val.trim());
              }}
              placeholder="رقم الطلب أو الإرسالية (Enter)"
              className="flex-1 text-center font-bold"
              dir="ltr"
              barcode={true}
            />
            <Button
              variant="outline"
              onClick={() => void lookupOrder(barcodeInput.trim())}
              disabled={!barcodeInput.trim() || isSearching}
            >
              {isSearching ? L.loading : "بحث"}
            </Button>
          </div>
        </div>
      )}

      {scannedOrder && (
        <CancelAssignmentOrderCard
          scannedOrder={scannedOrder}
          branchId={branchId}
          reason={reason}
          onReasonChange={setReason}
          onConfirmCancel={() => void handleConfirmCancel()}
          onReset={handleReset}
          onNavigateToDispatch={onNavigateToDispatch}
          isPending={cancelAssignmentMut.isPending}
        />
      )}
    </div>
  );
}
