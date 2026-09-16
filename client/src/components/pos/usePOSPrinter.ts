import { useEffect, useState } from "react";
import { notify } from "@/lib/notify";
import {
  getServerBridgeStatus,
  isPaired,
  isWebUsbSupported,
  pairPrinter,
  serverPrintTest,
  tryReconnectPrinter,
} from "@/lib/printing/print";

export function usePOSPrinter() {
  const [printerReady, setPrinterReady] = useState(isPaired());
  const [bridge, setBridge] = useState<{ enabled: boolean; description: string }>({ enabled: false, description: "" });

  const connectPrinter = async () => {
    try {
      await pairPrinter();
      setPrinterReady(true);
      notify.ok("تم ربط الطابعة");
    } catch (e: unknown) {
      notify.err(e, "تعذّر ربط الطابعة");
    }
  };

  useEffect(() => {
    getServerBridgeStatus().then(setBridge).catch(() => { /* ignore */ });
  }, []);

  useEffect(() => {
    if (!isWebUsbSupported()) return;
    tryReconnectPrinter().then((ok) => { if (ok) setPrinterReady(true); }).catch(() => { /* ignore */ });
    const usb = (navigator as unknown as { usb?: EventTarget }).usb;
    if (!usb) return;
    const onConnect = () => {
      tryReconnectPrinter().then((ok) => { if (ok) setPrinterReady(true); }).catch(() => { /* ignore */ });
    };
    usb.addEventListener("connect", onConnect);
    return () => usb.removeEventListener("connect", onConnect);
  }, []);

  const testServerPrint = async () => {
    const r = await serverPrintTest();
    if (r.ok) notify.ok("أُرسلت تذكرة اختبار للطابعة عبر الخادم");
    else notify.err(r.error ?? "فشل اختبار الطباعة");
  };

  return {
    printerReady,
    setPrinterReady,
    bridge,
    connectPrinter,
    testServerPrint,
  };
}
