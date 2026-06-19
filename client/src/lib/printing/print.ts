import { EscPos } from "./escpos";
import { docToHtml, docToRaster, printHtml, type PrintDoc } from "./render";
import { isPaired, sendBytes, tryReconnectPrinter, isWebUsbSupported } from "./thermal";
import { isServerBridgeEnabled, sendRawToServer } from "./serverBridge";
import { isLocalBridgeEnabled, fetchBridgeStatus, sendToLocalBridge } from "./localBridgeTransport";
import { receiptToRaster } from "./receiptRaster";
import { workOrderToRaster, type WorkOrderReceiptData } from "./workOrderRaster";
import { buildLabelBytes, type LabelRenderItem, type LabelRenderOpts } from "./labelRaster";
import { getLabelSize, type LabelSize } from "./labelSize";
import { printBrowserReceipt, printBarcodeSheet, printBrowserWorkOrderReceipt, type ReceiptBrowserData } from "./printTemplates";

export type { PrintDoc, ReceiptBrowserData, WorkOrderReceiptData, LabelRenderItem, LabelRenderOpts, LabelSize };
export { isPaired, isWebUsbSupported, pairPrinter, tryReconnectPrinter } from "./thermal";
export type { PrinterRole } from "./thermal";
export {
  getLabelSize, setLabelSize, LABEL_PRESETS, DEFAULT_LABEL_SIZE, presetIdFor, clampLabelSize,
} from "./labelSize";
export {
  isServerBridgeEnabled, getServerBridgeStatus, serverPrintTest, sendRawToServer,
} from "./serverBridge";
export {
  isLocalBridgeEnabled, fetchBridgeStatus, sendToLocalBridge,
  localBridgeTestPrint, localBridgeOpenDrawer,
  getBridgeSecret, setBridgeSecret, clearBridgeSecret, ingestBridgeSecretFromUrl,
} from "./localBridgeTransport";

/**
 * نوع موحَّد لقناة الطباعة المُستعمَلة في النهاية.
 *  - "local-bridge": جسر محلي على جهاز المستخدم (المسار الإنتاجي الجديد للنشر السحابي).
 *  - "server":       جسر على الخادم (يعمل في نشر داخل الموقع where المخدّم يصل للطابعة).
 *  - "thermal":      WebUSB مباشر للطابعة (يحتاج تعريف WinUSB).
 *  - "browser":      نافذة الطباعة في المتصفح (احتياطٌ أخير).
 */
export type PrintVia = "local-bridge" | "server" | "thermal" | "browser";

/** بناء بايتات ESC/POS من المستند (نقطية Canvas + قطع). يعيد null إن تعذّر الرسم (بلا DOM). */
async function buildReceiptBytes(doc: PrintDoc): Promise<Uint8Array | null> {
  const raster = await docToRaster(doc); // async: توليد QR وCode128 على Canvas
  if (!raster) return null;
  return new EscPos().init().raster(raster).feed(3).cut().bytes();
}

/**
 * طباعة مستند بترتيب أولوية متدرّج:
 *  ٠) **الجسر المحلي** — alroya-bridge.exe على جهاز المستخدم نفسه (المسار الإنتاجي
 *      للنشر السحابي — يعمل لأي طابعة على هذا الجهاز عبر Windows Spooler أو TCP).
 *  ١) **جسر الخادم** — طباعة صامتة (إن ضُبط PRINT_TARGET على الخادم — للنشر داخل الموقع).
 *  ٢) **WebUSB** — طابعة USB حرارية مربوطة في المتصفّح (يحتاج تعريف WinUSB/Zadig).
 *  ٣) **حوار المتصفّح** — بديل أخير بعرض ٨٠مم.
 * أي فشل في مستوى أعلى يتدهّور بسلاسة للمستوى التالي ⇒ لا تُسقَط الطباعة أبداً.
 */
export async function printDoc(doc: PrintDoc): Promise<{ via: PrintVia }> {
  // ٠) الجسر المحلي (الأولوية الأعلى — يعمل في النشر السحابي).
  if (await isLocalBridgeEnabled()) {
    const bytes = await buildReceiptBytes(doc);
    if (bytes) {
      const r = await sendToLocalBridge(bytes, "receipt");
      if (r.ok) return { via: "local-bridge" };
      console.warn("[print] الجسر المحلي فشل، نتراجع للبديل:", r.error);
    }
  }

  // ١) جسر الخادم (نشر داخل الموقع — يصل للطابعة عبر الشبكة).
  if (await isServerBridgeEnabled()) {
    const bytes = await buildReceiptBytes(doc);
    if (bytes) {
      try {
        await sendRawToServer(bytes);
        return { via: "server" };
      } catch (e) {
        console.warn("[print] فشل جسر الخادم، نتراجع للبديل:", e);
      }
    }
  }

  // ٢) WebUSB (طابعة USB حرارية مربوطة).
  if (isPaired()) {
    const bytes = await buildReceiptBytes(doc);
    if (bytes) {
      await sendBytes(bytes);
      return { via: "thermal" };
    }
  }

  // ٣) حوار طباعة المتصفّح (بديل أخير).
  const html = await docToHtml(doc);
  printHtml(html);
  return { via: "browser" };
}

/**
 * طباعة إيصال نقطة البيع **بالتصميم المُعلَّم** بنفس ترتيب الأولوية المتدرّج لـprintDoc:
 *  ٠) الجسر المحلي  ١) جسر الخادم  ٢) WebUSB  ٣) نافذة المتصفّح.
 * التصميم واحد في المسارات الأربعة ⇒ لا يتفاوت شكل الإيصال بتفاوت الناقل.
 */
export async function printReceipt(d: ReceiptBrowserData): Promise<{ via: PrintVia }> {
  const localOn = await isLocalBridgeEnabled();
  const serverOn = await isServerBridgeEnabled();
  // النقطية تُبنى مرة واحدة وتُستعمل لكل المسارات الصامتة (الجسرَين/WebUSB).
  if (localOn || serverOn || isPaired()) {
    const raster = await receiptToRaster(d);
    if (raster) {
      const bytes = new EscPos().init().raster(raster).feed(3).cut().bytes();
      if (localOn) {
        const r = await sendToLocalBridge(bytes, "receipt");
        if (r.ok) return { via: "local-bridge" };
        console.warn("[print] الجسر المحلي فشل، نتراجع للبديل:", r.error);
      }
      if (serverOn) {
        try {
          await sendRawToServer(bytes);
          return { via: "server" };
        } catch (e) {
          console.warn("[print] فشل جسر الخادم، نتراجع للبديل:", e);
        }
      }
      if (isPaired()) {
        try {
          await sendBytes(bytes);
          return { via: "thermal" };
        } catch (e) {
          console.warn("[print] فشل WebUSB، نتراجع لنافذة المتصفّح:", e);
        }
      }
    }
  }
  printBrowserReceipt(d);
  return { via: "browser" };
}

/**
 * طباعة ملصقات الباركود — أولوية مماثلة لإيصال الكاشير:
 *  ٠) الجسر المحلي (kind=label ⇒ يوجَّه لطابعة الملصقات المُكوَّنة في config.json)
 *  ١) WebUSB لطابعة الملصقات (دور "label" منفصل عن الإيصالات — يحتاج WinUSB)
 *  ٢) نافذة المتصفّح (تعريف Windows للطابعة — لا يدعم المحاذاة الدقيقة للـdie-cut)
 *
 * ملاحظة: لا يمرّ بـ«جسر الخادم» — وجهة PRINT_TARGET هي طابعة الإيصالات لا الملصقات.
 * يستعمل المقاس المحفوظ (getLabelSize) ما لم يُمرَّر مقاسٌ صراحةً.
 */
export async function printLabel(
  items: LabelRenderItem[],
  opts: LabelRenderOpts = {},
  size: LabelSize = getLabelSize(),
): Promise<{ via: PrintVia; ok: boolean }> {
  if (!items.length) return { via: "browser", ok: false };

  // ٠) الجسر المحلي — لكن فقط إن كان فيه طابعة ملصقات مُكوَّنة (labelConfigured).
  // بدون هذا الفحص، الـPWA يرسل bytes للجسر فيردّ 503 ثم نسقط للبديل ⇒ هدر زمن + سجلات
  // مضلِّلة. labelConfigured يأتي من /health مع cache فعّال.
  const bridgeStatus = await fetchBridgeStatus();
  if (bridgeStatus.available && bridgeStatus.labelConfigured) {
    const bytes = await buildLabelBytes(items, size, opts);
    if (bytes) {
      const r = await sendToLocalBridge(bytes, "label");
      if (r.ok) return { via: "local-bridge", ok: true };
      console.warn("[print] الجسر المحلي فشل لطباعة الملصق، نتراجع للبديل:", r.error);
    }
  }

  // إعادة ربط صامتة لطابعة الملصقات عبر WebUSB إن لم تكن مربوطة (للأجهزة التي طُبِّق
  // عليها Zadig مسبقاً — تستعمل WebUSB بدل السقوط للمتصفّح بلا داعٍ).
  if (!isPaired("label") && isWebUsbSupported()) {
    try { await tryReconnectPrinter("label"); } catch { /* تجاهل — نتراجع للمتصفّح */ }
  }

  // ١) WebUSB لطابعة الملصقات (يحتاج تعريف WinUSB).
  if (isPaired("label")) {
    const bytes = await buildLabelBytes(items, size, opts);
    if (bytes) {
      try {
        await sendBytes(bytes, "label");
        return { via: "thermal", ok: true };
      } catch (e) {
        console.warn("[print] فشل WebUSB لطابعة الملصقات، نتراجع لنافذة المتصفّح:", e);
      }
    }
  }

  // ٢) نافذة المتصفّح (بمقاس الملصق). ok=false إن حُجبت النافذة.
  const ok = printBarcodeSheet(items, size, opts);
  return { via: "browser", ok };
}

/**
 * طباعة إيصال أمر الشغل الحراري (80مم) بترتيب الأولوية المتدرّج نفسه:
 *  ٠) الجسر المحلي  ١) جسر الخادم  ٢) WebUSB  ٣) نافذة متصفّح 80مم.
 * التصميم واحد في المسارات الأربعة (workOrderRaster = نفس القالب على Canvas).
 */
export async function printWorkOrderReceipt(
  d: WorkOrderReceiptData,
): Promise<{ via: PrintVia }> {
  // إعادة ربط صامتة لطابعة الإيصالات إن لم تكن مربوطة في الذاكرة (للأجهزة التي طُبِّق
  // عليها Zadig — تستعمل WebUSB بدل السقوط للمتصفّح بلا داعٍ).
  if (!isPaired() && isWebUsbSupported()) {
    try { await tryReconnectPrinter(); } catch { /* تجاهل — نتراجع للبدائل */ }
  }

  const localOn = await isLocalBridgeEnabled();
  const serverOn = await isServerBridgeEnabled();
  if (localOn || serverOn || isPaired()) {
    const raster = await workOrderToRaster(d);
    if (raster) {
      const bytes = new EscPos().init().raster(raster).feed(3).cut().bytes();
      if (localOn) {
        const r = await sendToLocalBridge(bytes, "receipt");
        if (r.ok) return { via: "local-bridge" };
        console.warn("[print] الجسر المحلي فشل (WO)، نتراجع للبديل:", r.error);
      }
      if (serverOn) {
        try {
          await sendRawToServer(bytes);
          return { via: "server" };
        } catch (e) {
          console.warn("[print] فشل جسر الخادم (WO)، نتراجع للبديل:", e);
        }
      }
      if (isPaired()) {
        try {
          await sendBytes(bytes);
          return { via: "thermal" };
        } catch (e) {
          console.warn("[print] فشل WebUSB (WO)، نتراجع لنافذة المتصفّح:", e);
        }
      }
    }
  }
  printBrowserWorkOrderReceipt(d);
  return { via: "browser" };
}
