import { useEffect, useState } from "react";
import { Printer, Usb } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePrinterConnection } from "@/hooks/usePrinterConnection";
import { notify } from "@/lib/notify";
import { isServerBridgeEnabled } from "@/lib/printing/serverBridge";
import {
  hasConnectedAlertThermalPrinter,
  printStoreOrderAlertAuto,
} from "@/lib/printing/storeOrderAlertSlip";
import { THERMAL_PRINTER_CHANGE_EVENT } from "@/lib/printing/thermal";

export function StoreOrderAutoPrintBar({
  defaultRecipient,
  canAutoPrint = true,
}: {
  defaultRecipient: boolean;
  canAutoPrint?: boolean;
}) {
  const printer = usePrinterConnection("receipt");
  const [bridgeEnabled, setBridgeEnabled] = useState(false);
  const [testingPrint, setTestingPrint] = useState(false);

  useEffect(() => {
    if (!canAutoPrint) {
      setBridgeEnabled(false);
      return;
    }
    let active = true;
    const syncBridge = () => {
      void isServerBridgeEnabled()
        .then((ok) => {
          if (active) setBridgeEnabled(ok);
        })
        .catch(() => {
          if (active) setBridgeEnabled(false);
        });
    };
    syncBridge();
    window.addEventListener(THERMAL_PRINTER_CHANGE_EVENT, syncBridge);
    return () => {
      active = false;
      window.removeEventListener(THERMAL_PRINTER_CHANGE_EVENT, syncBridge);
    };
  }, [canAutoPrint]);

  if (!canAutoPrint) return null;

  const printerReady = printer.printerReady || bridgeEnabled;
  const activeReady = printerReady || defaultRecipient;

  const statusLabel = printerReady
    ? defaultRecipient
      ? "الطباعة التلقائية الإلزامية: نشطة (حراري مباشر — أولوية الاستقبال)"
      : "الطباعة التلقائية الإلزامية: نشطة (حراري مباشر — احتياط تلقائي)"
    : defaultRecipient
      ? "الطباعة التلقائية الإلزامية: نشطة (طابعة النظام 80مم — احتياط تلقائي)"
      : "الطباعة التلقائية الإلزامية: مفعلة (بانتظار ربط طابعة USB على هذا الجهاز)";

  async function handleTestSlip() {
    setTestingPrint(true);
    try {
      const hasThermal = await hasConnectedAlertThermalPrinter().catch(() => false);
      const outcome = await printStoreOrderAlertAuto(
        {
          orderNumber: "TEST-80MM",
          createdAt: new Date(),
          itemsCount: 2,
          totalAmount: "25000",
        },
        { allowBrowserFallback: true },
      );
      if (outcome === "printed" || outcome === "dialog_opened") {
        notify.ok(
          hasThermal && outcome === "printed"
            ? "تمت طباعة قصاصة الاختبار صامتاً عبر الطابعة الحرارية"
            : "تم فتح نافذة طباعة قصاصة الاختبار (80مم)",
        );
      } else {
        notify.err("تعذر إرسال قصاصة الاختبار للطابعة");
      }
    } finally {
      setTestingPrint(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span
          role="status"
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-bold select-none ${
            activeReady
              ? "border border-[var(--sem-pos)]/35 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]"
              : "border border-[var(--sem-warn)]/35 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]"
          }`}
        >
          <Printer aria-hidden className="size-3.5" />
          {statusLabel}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {printer.supported && !printer.printerReady && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void printer.connect()}
            className="h-7 gap-1 px-2.5 text-[11px] font-bold"
            title="ربط طابعة الإيصالات عبر WebUSB للطباعة الفورية الصامتة دون نافذة النظام"
          >
            <Usb aria-hidden className="size-3.5" />
            ربط USB صامت
          </Button>
        )}

        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={testingPrint}
          onClick={() => void handleTestSlip()}
          className="h-7 gap-1 px-2.5 text-[11px] font-semibold"
          title="اختبار طباعة قصاصة تنبيه طلب متجر (10 سم)"
        >
          <Printer aria-hidden className="size-3.5" />
          اختبار القصاصة
        </Button>
      </div>
    </div>
  );
}
