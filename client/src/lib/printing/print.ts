import { EscPos } from "./escpos";
import { docToHtml, docToRaster, printHtml, type PrintDoc } from "./render";
import {
  isPaired,
  sendBytes,
  tryReconnectPrinter,
  isWebUsbSupported,
  isPairedProfile,
  tryReconnectProfile,
  sendBytesProfile,
} from "./thermal";
import { isServerBridgeEnabled, sendRawToServer } from "./serverBridge";
import { isLocalBridgeAvailable, sendRawToBridge } from "./localBridge";
import { resolveProfile, type PrintPurpose } from "./printerProfiles";
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

/** ناقل تمّت عبره الطباعة فعلاً (للعرض/التشخيص). */
export type PrintVia = "server" | "thermal" | "bridge" | "browser";

/** بناء بايتات ESC/POS من المستند (نقطية Canvas + قطع). يعيد null إن تعذّر الرسم (بلا DOM). */
async function buildReceiptBytes(doc: PrintDoc): Promise<Uint8Array | null> {
  const raster = await docToRaster(doc); // async: توليد QR وCode128 على Canvas
  if (!raster) return null;
  return new EscPos().init().raster(raster).feed(3).cut().bytes();
}

/** مذكّر: يبني القيمة مرّة واحدة فقط (نتفادى إعادة رسم النقطية إن لزمت لأكثر من ناقل). */
function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => (p ??= fn());
}

/**
 * موزِّع الطباعة الصامتة حسب **ملفّ المهمة** المحلي:
 *  - transport "webusb"  → إعادة ربط صامتة ثم إرسال بايتات (نفس بايتات WebUSB القديمة — جودة مطابقة).
 *  - transport "bridge"  → إرسال للجسر المحلي بالاسم (يمرّر البايتات حرفياً — جودة بايت-مطابقة).
 *  - transport "browser" أو أي فشل → حوار المتصفّح (browserFallback).
 * **الجسر/WebUSB يرسلان نفس البايتات تماماً** ⇒ لا فرق جودة بين النواقل.
 */
async function dispatchBytes(
  purpose: PrintPurpose,
  buildBytes: () => Promise<Uint8Array | null>,
  browserFallback: () => boolean | void | Promise<boolean | void>,
): Promise<{ via: PrintVia; ok: boolean }> {
  const profile = resolveProfile(purpose);
  if (profile && profile.transport !== "browser") {
    const bytes = await buildBytes();
    if (bytes) {
      if (profile.transport === "webusb") {
        if (!isPairedProfile(profile.id) && isWebUsbSupported()) {
          try { await tryReconnectProfile(profile); } catch { /* تجاهل — نتراجع */ }
        }
        if (isPairedProfile(profile.id)) {
          try {
            await sendBytesProfile(profile.id, bytes);
            return { via: "thermal", ok: true };
          } catch (e) {
            console.warn("[print] فشل WebUSB، نتراجع للبديل:", e);
          }
        }
      } else if (profile.transport === "bridge" && profile.bridgePrinterName) {
        try {
          if (await isLocalBridgeAvailable()) {
            await sendRawToBridge(profile.bridgePrinterName, bytes, profile.outputFormat);
            return { via: "bridge", ok: true };
          }
        } catch (e) {
          console.warn("[print] فشل الجسر المحلي، نتراجع للبديل:", e);
        }
      }
    }
  }
  const ok = await browserFallback();
  return { via: "browser", ok: ok !== false };
}

/**
 * طباعة مستند (نقطي 80مم) بترتيب أولوية متدرّج:
 *  ١) **جسر الخادم** (إن ضُبط PRINT_TARGET) — كما كان، صفر انحدار.
 *  ٢) **ملفّ مهمة RECEIPT** (webusb/جسر محلي) — أو حوار المتصفّح.
 * أي فشل في مستوى أعلى يتدهّور بسلاسة ⇒ لا تُسقَط الطباعة أبداً.
 */
export async function printDoc(doc: PrintDoc): Promise<{ via: PrintVia }> {
  const build = once(() => buildReceiptBytes(doc));

  if (await isServerBridgeEnabled()) {
    const bytes = await build();
    if (bytes) {
      try {
        await sendRawToServer(bytes);
        return { via: "server" };
      } catch (e) {
        console.warn("[print] فشل جسر الخادم، نتراجع للبديل:", e);
      }
    }
  }

  const r = await dispatchBytes("RECEIPT", build, async () => {
    const html = await docToHtml(doc); // async: توليد QR SVG
    printHtml(html);
    return true;
  });
  return { via: r.via };
}

/**
 * طباعة إيصال نقطة البيع **بالتصميم المُعلَّم** بنفس ترتيب أولوية printDoc:
 *  ١) جسر الخادم  ٢) ملفّ RECEIPT (webusb/جسر محلي)  ٣) نافذة المتصفّح (قالب الإيصال المُعلَّم نفسه).
 * التصميم واحد على كل النواقل ⇒ لا يتفاوت شكل/جودة الإيصال بتفاوت الناقل.
 */
export async function printReceipt(d: ReceiptBrowserData): Promise<{ via: PrintVia }> {
  const build = once(async () => {
    const raster = await receiptToRaster(d);
    return raster ? new EscPos().init().raster(raster).feed(3).cut().bytes() : null;
  });

  if (await isServerBridgeEnabled()) {
    const bytes = await build();
    if (bytes) {
      try {
        await sendRawToServer(bytes);
        return { via: "server" };
      } catch (e) {
        console.warn("[print] فشل جسر الخادم، نتراجع للبديل:", e);
      }
    }
  }

  const r = await dispatchBytes("RECEIPT", build, () => {
    printBrowserReceipt(d);
    return true;
  });
  return { via: r.via };
}

/**
 * طباعة تذكرة طلب/أمر شغل (نقطي حراري) عبر **ملفّ مهمة ORDER_TICKET** ثم حوار المتصفّح.
 * لا تمرّ بجسر الخادم (وجهته طابعة الإيصالات لا التذاكر).
 */
export async function printOrderTicket(doc: PrintDoc): Promise<{ via: PrintVia }> {
  const build = once(() => buildReceiptBytes(doc));
  const r = await dispatchBytes("ORDER_TICKET", build, async () => {
    const html = await docToHtml(doc);
    printHtml(html);
    return true;
  });
  return { via: r.via };
}

/**
 * طباعة مستند A4 (فاتورة/عرض/تقرير) **عبر حوار الطباعة** — يُطبع بتعريف الطابعة الأصلي (vector،
 * أعلى دقّة، بلا تحويل لصورة). المستندات الكبيرة لا تُرسَل RAW؛ يختار المستخدم طابعته من الحوار.
 */
export async function printDocument(doc: PrintDoc): Promise<{ via: "browser" }> {
  const html = await docToHtml(doc);
  printHtml(html);
  return { via: "browser" };
}

/**
 * طباعة ملصقات الباركود عبر **ملفّ مهمة LABEL** (webusb/جسر محلي بنقطية ESC/POS، صامت)،
 * وإلا نافذة المتصفّح (طباعة عبر تعريف Windows). لا تمرّ بجسر الخادم.
 * يستعمل المقاس المحفوظ (getLabelSize) ما لم يُمرَّر مقاسٌ صراحةً.
 */
export async function printLabel(
  items: LabelRenderItem[],
  opts: LabelRenderOpts = {},
  size: LabelSize = getLabelSize(),
): Promise<{ via: PrintVia; ok: boolean }> {
  if (!items.length) return { via: "browser", ok: false };
  const build = once(() => buildLabelBytes(items, size, opts));
  return dispatchBytes("LABEL", build, () => printBarcodeSheet(items, size, opts));
}
