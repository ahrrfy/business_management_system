// حالة ربط الطابعة الحرارية (WebUSB) + إجراء الربط اليدوي، موحّدة لأي شاشة تريد عرضها —
// لا الكاشير فقط. الإذن والاتصال الفعليّ (client/src/lib/printing/thermal.ts) عالميّان بالفعل
// داخل الجلسة (singleton بمستوى الوحدة)؛ هذا الخطّاف واجهة قراءة/ربط موحّدة تتزامن تلقائياً مع
// ربطٍ حصل من شاشة أخرى (مثلاً: يُربط من شريط لوحة التحكم فيظهر مربوطاً فوراً داخل الكاشير).
import { useEffect, useState } from "react";
import { notify } from "@/lib/notify";
import {
  isPaired, isWebUsbSupported, pairPrinter, tryReconnectPrinter, type PrinterRole,
} from "@/lib/printing/print";

export function usePrinterConnection(role: PrinterRole = "receipt") {
  const [printerReady, setPrinterReady] = useState(() => isPaired(role));
  const supported = isWebUsbSupported();

  useEffect(() => {
    if (!supported) return;
    const refresh = () => setPrinterReady(isPaired(role));
    tryReconnectPrinter(role).then((ok) => { if (ok) setPrinterReady(true); }).catch(() => { /* تجاهل */ });
    const usb = (navigator as unknown as { usb?: EventTarget }).usb;
    if (!usb) return;
    const onConnect = () => {
      tryReconnectPrinter(role).then((ok) => { if (ok) setPrinterReady(true); }).catch(() => { /* تجاهل */ });
    };
    const onDisconnect = () => refresh();
    usb.addEventListener("connect", onConnect);
    usb.addEventListener("disconnect", onDisconnect);
    return () => {
      usb.removeEventListener("connect", onConnect);
      usb.removeEventListener("disconnect", onDisconnect);
    };
  }, [role, supported]);

  async function connect() {
    try {
      await pairPrinter(role);
      setPrinterReady(true);
      notify.ok(role === "label" ? "تم ربط طابعة الملصقات" : "تم ربط الطابعة الحرارية");
    } catch (e: unknown) {
      notify.err(e, "تعذّر ربط الطابعة");
    }
  }

  return { printerReady, supported, connect };
}
