import { EscPos, type Raster } from "./escpos";
import { docToHtml, docToRaster, printHtml, type PrintDoc } from "./render";
import { isPaired, sendBytes, tryReconnectPrinter, isWebUsbSupported } from "./thermal";
import { isServerBridgeEnabled, sendRawToServer } from "./serverBridge";
import { receiptToRaster } from "./receiptRaster";
import { workOrderToRaster, type WorkOrderReceiptData } from "./workOrderRaster";
import { shiftOpenToRaster, shiftCloseToRaster } from "./shiftRaster";
import { buildLabelBytes, type LabelRenderItem, type LabelRenderOpts } from "./labelRaster";
import { getLabelSize, type LabelSize } from "./labelSize";
import {
  printBrowserReceipt, printBarcodeSheet, printBrowserWorkOrderReceipt,
  printShiftOpenBrowser, printShiftCloseBrowser,
  type ReceiptBrowserData, type ShiftOpenData, type ShiftCloseData,
} from "./printTemplates";

export type { PrintDoc, ReceiptBrowserData, WorkOrderReceiptData, LabelRenderItem, LabelRenderOpts, LabelSize };
export { isPaired, isWebUsbSupported, pairPrinter, tryReconnectPrinter } from "./thermal";
export type { PrinterRole } from "./thermal";
export {
  getLabelSize, setLabelSize, LABEL_PRESETS, DEFAULT_LABEL_SIZE, presetIdFor, clampLabelSize,
} from "./labelSize";
export {
  isServerBridgeEnabled, getServerBridgeStatus, serverPrintTest, sendRawToServer,
} from "./serverBridge";

export type PrintResult =
  | { via: "server" | "thermal" | "browser"; ok: true }
  | { via: "browser"; ok: false; reason: "popup-blocked" };

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
export async function printDoc(doc: PrintDoc): Promise<PrintResult> {
  // ١) جسر الخادم (الأولوية حين يكون مفعّلاً).
  if (await isServerBridgeEnabled()) {
    const bytes = await buildReceiptBytes(doc);
    if (bytes) {
      try {
        await sendRawToServer(bytes);
        return { via: "server", ok: true };
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
      try {
        await sendBytes(bytes);
        return { via: "thermal", ok: true };
      } catch (e) {
        console.warn("[print] فشل WebUSB، نتراجع لنافذة المتصفّح:", e);
      }
    }
  }

  // ٣) حوار طباعة المتصفّح (بديل أخير).
  const html = await docToHtml(doc); // async: توليد QR SVG
  return printHtml(html)
    ? { via: "browser", ok: true }
    : { via: "browser", ok: false, reason: "popup-blocked" };
}

/**
 * طباعة إيصال نقطة البيع **بالتصميم المُعلَّم** (شعار + باركود + جدول المنتجات +
 * أرقام التواصل + سياسة الاستبدال) بنفس ترتيب الأولوية المتدرّج لـprintDoc:
 *  ١) جسر الخادم  ٢) WebUSB  ٣) نافذة المتصفّح (قالب الإيصال المُعلَّم نفسه).
 * التصميم واحد في المسارات الثلاثة ⇒ لا يتفاوت شكل الإيصال بتفاوت الناقل.
 */
export async function printReceipt(d: ReceiptBrowserData): Promise<PrintResult> {
  // ش٢ (§١٠) — حارسٌ بنيويّ: قالب الإيصال لمستندٍ محاسبيّ حقيقيّ حصراً. حمولةٌ بلا رقمٍ، أو
  // برقم مسوّدة (DRF-)، تُنتج ورقةً لا يميّزها الزبون عن إيصال دفعٍ فعليّ — تُطبَع المسوّدة
  // بقالبها المنفصل (printDraftTicket) الذي يعلن «غير محاسَبة» ويُمنع فيه سطرا مدفوع/الفكّة.
  const num = d.receiptNumber?.trim() ?? "";
  if (!num || num.startsWith("DRF-")) {
    throw new Error("قالب الإيصال يرفض حمولةً بلا رقم مستندٍ حقيقيّ — مسوّدة الطلب تُطبَع بقالب المسوّدة");
  }
  // Restore a previously-authorized USB receipt printer at the point of use.
  // Printing can be triggered from screens that do not own the POS reconnect
  // effect, and a printer may have been unplugged and reconnected meanwhile.
  const bridgeEnabled = await isServerBridgeEnabled();
  if (!bridgeEnabled && !isPaired() && isWebUsbSupported()) {
    try {
      await tryReconnectPrinter();
    } catch {
      // The browser print dialog below remains the safe final fallback.
    }
  }

  // النقطية تُبنى مرة واحدة لمساري الطباعة الصامتة (الجسر/WebUSB).
  if (bridgeEnabled || isPaired()) {
    const raster = await receiptToRaster(d);
    if (raster) {
      const bytes = new EscPos().init().raster(raster).feed(3).cut().openDrawer().bytes();
      if (bridgeEnabled) {
        try {
          await sendRawToServer(bytes);
          return { via: "server", ok: true };
        } catch (e) {
          console.warn("[print] فشل جسر الخادم، نتراجع للبديل:", e);
        }
      }
      if (isPaired()) {
        try {
          await sendBytes(bytes);
          return { via: "thermal", ok: true };
        } catch (e) {
          // طابعة مفصولة/خطأ نقل ⇒ تدهور سلس لنافذة المتصفّح (لا تُسقَط الطباعة).
          console.warn("[print] فشل WebUSB، نتراجع لنافذة المتصفّح:", e);
        }
      }
    }
  }
  return printBrowserReceipt(d)
    ? { via: "browser", ok: true }
    : { via: "browser", ok: false, reason: "popup-blocked" };
}

/**
 * فتح درج النقود يدوياً عبر إرسال نبضة ESC/POS لطابعة الإيصالات الحرارية.
 */
export async function openCashDrawer(): Promise<{ ok: boolean; via?: "thermal" | "server" }> {
  const bytes = new EscPos().init().openDrawer().bytes();
  if (await isServerBridgeEnabled()) {
    try {
      await sendRawToServer(bytes);
      return { ok: true, via: "server" };
    } catch (e) {
      console.warn("[drawer] فشل فتح الدرج عبر جسر الخادم:", e);
    }
  }
  if (isPaired()) {
    try {
      await sendBytes(bytes);
      return { ok: true, via: "thermal" };
    } catch (e) {
      console.warn("[drawer] فشل فتح الدرج عبر WebUSB:", e);
    }
  }
  return { ok: false };
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

/**
 * طباعة إيصال طلب الخدمة الحراري (80مم) بترتيب الأولوية المتدرّج نفسه:
 *  ١) جسر الخادم  ٢) WebUSB  ٣) نافذة متصفّح 80مم (بديل أخير).
 * التصميم واحد في المسارات الثلاثة (workOrderRaster = نفس القالب على Canvas).
 */
export async function printWorkOrderReceipt(
  d: WorkOrderReceiptData,
): Promise<{ via: "server" | "thermal" | "browser" }> {
  // إعادة ربط صامتة لطابعة الإيصالات إن لم تكن مربوطة في الذاكرة (مثلاً الطباعة من لوحة
  // طلبات خدمة العملاء أو تفاصيلها بلا فتح الكاشير أوّلاً) ⇒ تجربة الكاشير نفسها: WebUSB صامت
  // بلا نافذة المتصفّح. مطابق لما يفعله printLabel للملصقات.
  if (!isPaired() && isWebUsbSupported()) {
    try { await tryReconnectPrinter(); } catch { /* تجاهل — نتراجع للبدائل */ }
  }

  if ((await isServerBridgeEnabled()) || isPaired()) {
    const raster = await workOrderToRaster(d);
    if (raster) {
      const bytes = new EscPos().init().raster(raster).feed(3).cut().bytes();
      if (await isServerBridgeEnabled()) {
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

export type { ShiftOpenData, ShiftCloseData };

/**
 * طباعة إيصال الوردية (فتح/إغلاق) بنفس ترتيب أولوية إيصال الكاشير تماماً:
 *  ١) جسر الخادم  ٢) WebUSB (نقطية التصميم المُعلَّم عبر shiftRaster)  ٣) نافذة المتصفّح بالتصميم المُعلَّم (تطبع تلقائياً).
 * التصميم المُعلَّم نفسه على النواقل الثلاثة (raster على Canvas = قالب المتصفّح) ⇒ لا يتفاوت الشكل.
 * يعالج علّة «إيصالات الوردية لا تُطبع»: كانت تفتح نافذة متصفّح فقط بلا مسار حراري، فلا تصل
 * لطابعة الكاشير (المربوطة WinUSB عبر WebUSB) بينما الفواتير تطبع لأنها تمرّ بهذا المسار.
 */
async function printShiftRaster(
  buildRaster: () => Promise<Raster | null>,
  browserFallback: () => void,
): Promise<{ via: "server" | "thermal" | "browser" }> {
  // إعادة ربط صامتة لطابعة الإيصالات إن لم تكن مربوطة (مطابق لـ printWorkOrderReceipt).
  if (!isPaired() && isWebUsbSupported()) {
    try { await tryReconnectPrinter(); } catch { /* تجاهل — نتراجع للبدائل */ }
  }

  if ((await isServerBridgeEnabled()) || isPaired()) {
    const raster = await buildRaster();
    if (raster) {
      const bytes = new EscPos().init().raster(raster).feed(3).cut().bytes();
      if (await isServerBridgeEnabled()) {
        try { await sendRawToServer(bytes); return { via: "server" }; }
        catch (e) { console.warn("[print] فشل جسر الخادم (وردية)، نتراجع للبديل:", e); }
      }
      if (isPaired()) {
        try { await sendBytes(bytes); return { via: "thermal" }; }
        catch (e) { console.warn("[print] فشل WebUSB (وردية)، نتراجع لنافذة المتصفّح:", e); }
      }
    }
  }
  browserFallback();
  return { via: "browser" };
}

export function printShiftOpen(d: ShiftOpenData): Promise<{ via: "server" | "thermal" | "browser" }> {
  return printShiftRaster(() => shiftOpenToRaster(d), () => printShiftOpenBrowser(d));
}

export function printShiftClose(d: ShiftCloseData): Promise<{ via: "server" | "thermal" | "browser" }> {
  return printShiftRaster(() => shiftCloseToRaster(d), () => printShiftCloseBrowser(d));
}
