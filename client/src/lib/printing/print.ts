import { EscPos } from "./escpos";
import { docToHtml, docToRaster, printHtml, type PrintDoc } from "./render";
import { isPaired, sendBytes } from "./thermal";
import { isServerBridgeEnabled, sendRawToServer } from "./serverBridge";
import { receiptToRaster } from "./receiptRaster";
import { printBrowserReceipt, type ReceiptBrowserData } from "./printTemplates";

export type { PrintDoc, ReceiptBrowserData };
export { isPaired, isWebUsbSupported, pairPrinter, tryReconnectPrinter } from "./thermal";
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
 * طباعة إيصال نقطة البيع **بالتصميم المُعلَّم** (شعار + باركود + جدول الأصناف +
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
