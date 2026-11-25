import { useEffect, useState } from "react";
import { Check, Printer, Usb } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePrinterConnection } from "@/hooks/usePrinterConnection";
import { notify } from "@/lib/notify";
import {
  hasConnectedAlertThermalPrinter,
  printStoreOrderAlertAuto,
  readStoreOrderAutoPrintStationSetting,
  setStoreOrderAutoPrintStationSetting,
  STORE_ORDER_AUTOPRINT_STATION_EVENT,
} from "@/lib/printing/storeOrderAlertSlip";

export function StoreOrderAutoPrintBar({
  defaultRecipient,
  canAutoPrint = true,
}: {
  defaultRecipient: boolean;
  canAutoPrint?: boolean;
}) {
  const printer = usePrinterConnection("receipt");
  const [explicitSetting, setExplicitSetting] = useState<boolean | null>(() =>
    readStoreOrderAutoPrintStationSetting(),
  );
  const [testingPrint, setTestingPrint] = useState(false);

  useEffect(() => {
    const onSync = () => setExplicitSetting(readStoreOrderAutoPrintStationSetting());
    window.addEventListener(STORE_ORDER_AUTOPRINT_STATION_EVENT, onSync);
    window.addEventListener("storage", onSync);
    return () => {
      window.removeEventListener(STORE_ORDER_AUTOPRINT_STATION_EVENT, onSync);
      window.removeEventListener("storage", onSync);
    };
  }, []);

  const stationActive = canAutoPrint && (explicitSetting !== null ? explicitSetting : defaultRecipient);

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
      if (outcome === "printed") {
        notify.ok(
          hasThermal
            ? "تمت طباعة قصاصة الاختبار صامتاً عبر الطابعة الحرارية"
            : "تم إرسال قصاصة الاختبار (80مم) إلى طابعة المتصفح",
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
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-bold ${
            stationActive
              ? "border border-[var(--sem-pos)]/35 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]"
              : "border border-border bg-muted text-muted-foreground"
          }`}
        >
          <Printer aria-hidden className="size-3.5" />
          {stationActive
            ? printer.printerReady
              ? "الطباعة التلقائية للطلبات الواردة: نشطة (حراري مباشر)"
              : "الطباعة التلقائية للطلبات الواردة: نشطة (طابعة النظام 80مم)"
            : "الطباعة التلقائية للطلبات الواردة متوقفة على هذا الجهاز"}
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

        {canAutoPrint && (
          <Button
            type="button"
            variant={stationActive ? "outline" : "default"}
            size="sm"
            onClick={() => {
              const next = !stationActive;
              setStoreOrderAutoPrintStationSetting(next);
              setExplicitSetting(next);
              notify.ok(
                next
                  ? "فعلت الطباعة التلقائية لطلبات المتجر على هذا الجهاز"
                  : "أوقفت الطباعة التلقائية لطلبات المتجر على هذا الجهاز",
              );
            }}
            className="h-7 gap-1 px-2.5 text-[11px] font-bold"
          >
            {stationActive && <Check aria-hidden className="size-3.5 text-[var(--sem-pos)]" />}
            {stationActive ? "إيقاف التلقائي هنا" : "تفعيل الطباعة التلقائية هنا"}
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
