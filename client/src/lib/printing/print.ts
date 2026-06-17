import { EscPos } from "./escpos";
import { docToHtml, docToRaster, printHtml, type PrintDoc } from "./render";
import { isPaired, sendBytes, tryReconnectPrinter, isWebUsbSupported } from "./thermal";
import { isServerBridgeEnabled, sendRawToServer } from "./serverBridge";
import { receiptToRaster } from "./receiptRaster";
import { buildLabelBytes, type LabelRenderItem, type LabelRenderOpts } from "./labelRaster";
import { getLabelSize, type LabelSize } from "./labelSize";
import { printBrowserReceipt, printBarcodeSheet, type ReceiptBrowserData } from "./printTemplates";

export type { PrintDoc, ReceiptBrowserData, LabelRenderItem, LabelRenderOpts, LabelSize };
export { isPaired, isWebUsbSupported, pairPrinter, tryReconnectPrinter } from "./thermal";
export type { PrinterRole } from "./thermal";
export {
  getLabelSize, setLabelSize, LABEL_PRESETS, DEFAULT_LABEL_SIZE, presetIdFor, clampLabelSize,
} from "./labelSize";
export {
  isServerBridgeEnabled, getServerBridgeStatus, serverPrintTest, sendRawToServer,
} from "./serverBridge";

/** بناء بايتات ESC/POS من المستند (نقطية Canvas + قطع). يعيد null إن تعذّر الرسم (بلا DOM). */
async function buildReceiptBytes(doc: PrintDoc): Promise<Uint8Array | null> {
  const raster = await docToRaster(doc); // async: توليد QR وCode128 على Canvas
  if (!raster) return null;
  return new EscPos().init().raster(raster).feed(3).cut().bytes();
}

/**
 * طباعة مستند بترتيب أولوية متدرّج:
 *  ١) **جسر الخادم** — طباعة صامتة لأي طابعة شبكية/مشتركة (إن ضُبط PRINT_TARGET على الخادم).
 *  ٢) **WebUSB** — طابعة USB حرارية مربوطة في المتصفّح (صامت، Chrome/Edge).
 *  ٣) **حوار المتصفّح** — بديل أخير بعرض 80مم.
 * أي فشل في مستوى أعلى يتدهّور بسلاسة للمستوى التالي ⇒ لا تُسقَط الطباعة أبداً.
 */
export async function printDoc(doc: PrintDoc): Promise<{ via: "server" | "thermal" | "browser" }> {
  // ١) جسر الخادم (الأولوية حين يكون مفعّلاً).
  if (await isServerBridgeEnabled()) {
    const bytes = await buildReceiptBytes(doc);
    if (bytes) {
      try {
        await sendRawToServer(bytes);
        return { via: "server" };
      } catch (e) {
        // فشل الجسر ⇒ تدهور سلس للبدائل (لا نُسقط الطباعة).
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
  const html = await docToHtml(doc); // async: توليد QR SVG
  printHtml(html);
  return { via: "browser" };
}

/**
 * طباعة إيصال نقطة البيع **بالتصميم المُعلَّم** (شعار + باركود + جدول المنتجات +
 * أرقام التواصل + سياسة الاستبدال) بنفس ترتيب الأولوية المتدرّج لـprintDoc:
 *  ١) جسر الخادم  ٢) WebUSB  ٣) نافذة المتصفّح (قالب الإيصال المُعلَّم نفسه).
 * التصميم واحد في المسارات الثلاثة ⇒ لا يتفاوت شكل الإيصال بتفاوت الناقل.
 */
export async function printReceipt(d: ReceiptBrowserData): Promise<{ via: "server" | "thermal" | "browser" }> {
  // النقطية تُبنى مرة واحدة لمساري الطباعة الصامتة (الجسر/WebUSB).
  if ((await isServerBridgeEnabled()) || isPaired()) {
    const raster = await receiptToRaster(d);
    if (raster) {
      const bytes = new EscPos().init().raster(raster).feed(3).cut().bytes();
      if (await isServerBridgeEnabled()) {
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
          // طابعة مفصولة/خطأ نقل ⇒ تدهور سلس لنافذة المتصفّح (لا تُسقَط الطباعة).
          console.warn("[print] فشل WebUSB، نتراجع لنافذة المتصفّح:", e);
        }
      }
    }
  }
  printBrowserReceipt(d);
  return { via: "browser" };
}

/**
 * طباعة ملصقات الباركود **بنفس تقنية إيصال الكاشير**: نقطية ESC/POS عبر WebUSB لطابعة
 * الملصقات (HPRT LPQ58، صامت)، وإلا نافذة المتصفّح (طباعة عبر تعريف Windows للطابعة نفسها).
 *
 * ملاحظة: **لا يمرّ بجسر الخادم** — وجهة الجسر (PRINT_TARGET) هي طابعة الإيصالات لا الملصقات،
 * والجسر أصلاً لا يصل لطابعة المتجر بعد النشر السحابي. لذا الملصقات: WebUSB(label) ← المتصفّح.
 * يستعمل المقاس المحفوظ (getLabelSize) ما لم يُمرَّر مقاسٌ صراحةً.
 */
export async function printLabel(
  items: LabelRenderItem[],
  opts: LabelRenderOpts = {},
  size: LabelSize = getLabelSize(),
): Promise<{ via: "thermal" | "browser"; ok: boolean }> {
  if (!items.length) return { via: "browser", ok: false };

  // إعادة ربط صامتة لطابعة الملصقات إن لم تكن مربوطة في الذاكرة بعد (مثلاً الطباعة من شاشة
  // المنتجات بعد إعادة تحميل دون فتح شاشة الملصقات) ⇒ يُستعمل WebUSB بدل السقوط للمتصفّح بلا داعٍ.
  if (!isPaired("label") && isWebUsbSupported()) {
    try { await tryReconnectPrinter("label"); } catch { /* تجاهل — نتراجع للمتصفّح */ }
  }

  // ١) WebUSB لطابعة الملصقات (الدور "label" — منفصل عن طابعة الإيصالات).
  if (isPaired("label")) {
    const bytes = await buildLabelBytes(items, size, opts);
    if (bytes) {
      try {
        await sendBytes(bytes, "label");
        return { via: "thermal", ok: true };
      } catch (e) {
        // طابعة مفصولة/خطأ نقل ⇒ تدهور سلس لنافذة المتصفّح (لا تُسقَط الطباعة).
        console.warn("[print] فشل WebUSB لطابعة الملصقات، نتراجع لنافذة المتصفّح:", e);
      }
    }
  }

  // ٢) نافذة المتصفّح (بمقاس الملصق — تُطبع عبر تعريف Windows للطابعة). ok=false إن حُجبت النافذة.
  const ok = printBarcodeSheet(items, size, opts);
  return { via: "browser", ok };
}
