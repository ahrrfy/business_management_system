import { useEffect } from "react";
import { notify } from "@/lib/notify";
import {
  getServerBridgeStatus,
  isWebUsbSupported,
  pairPrinter,
  serverPrintTest,
  tryReconnectPrinter,
} from "@/lib/printing/print";
export interface useReceptionPrinterInput {
  setPrinterReady: React.Dispatch<React.SetStateAction<boolean>>;
  setBridge: React.Dispatch<
    React.SetStateAction<{ enabled: boolean; description: string }>
  >;
}
export function useReceptionPrinter({
  setPrinterReady,
  setBridge,
}: useReceptionPrinterInput) {
  const connectPrinter = async () => {
    try {
      await pairPrinter();
      setPrinterReady(true);
      notify.ok("تم ربط طابعة الإيصالات");
    } catch (e: unknown) {
      notify.err(e, "تعذّر ربط الطابعة");
    }
  };

  const testServerPrint = async () => {
    try {
      const result = await serverPrintTest();
      if (result.ok) notify.ok("أُرسلت تذكرة اختبار للطابعة عبر الخادم");
      else notify.err(result.error ?? "تعذّر اختبار الطابعة");
    } catch (e: unknown) {
      notify.err(e, "تعذّر اختبار جسر الطباعة");
    }
  };

  // نفس تكامل الطابعة في كاشير التجزئة وكاشير الطباعة: حالة جسر الخادم،
  // وإعادة ربط WebUSB الصامتة عند فتح الشاشة أو إعادة توصيل الطابعة.
  useEffect(() => {
    getServerBridgeStatus()
      .then(setBridge)
      .catch(() => {
        /* الجسر اختياري */
      });
  }, []);

  useEffect(() => {
    if (!isWebUsbSupported()) return;
    tryReconnectPrinter()
      .then((ok) => setPrinterReady(ok))
      .catch(() => setPrinterReady(false));

    const usb = (navigator as unknown as { usb?: EventTarget }).usb;
    if (!usb) return;
    const onConnect = () => {
      tryReconnectPrinter()
        .then((ok) => setPrinterReady(ok))
        .catch(() => setPrinterReady(false));
    };
    const onDisconnect = () => setPrinterReady(false);
    usb.addEventListener("connect", onConnect);
    usb.addEventListener("disconnect", onDisconnect);
    return () => {
      usb.removeEventListener("connect", onConnect);
      usb.removeEventListener("disconnect", onDisconnect);
    };
  }, []);

  return { connectPrinter, testServerPrint };
}
