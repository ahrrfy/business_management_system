import { EscPos } from "./escpos";
import { docToHtml, docToRaster, printHtml, type PrintDoc } from "./render";
import { isPaired, sendBytes } from "./thermal";

export type { PrintDoc };
export { isPaired, isWebUsbSupported, pairPrinter } from "./thermal";

/**
 * Print a document: if a thermal printer is paired, rasterize and send via
 * ESC/POS over WebUSB; otherwise fall back to the browser print dialog (80mm).
 * Both paths are now async to support QR/barcode generation.
 */
export async function printDoc(doc: PrintDoc): Promise<{ via: "thermal" | "browser" }> {
  if (isPaired()) {
    const raster = await docToRaster(doc); // async: توليد QR وCode128 على Canvas
    if (raster) {
      const bytes = new EscPos().init().raster(raster).feed(3).cut().bytes();
      await sendBytes(bytes);
      return { via: "thermal" };
    }
  }
  const html = await docToHtml(doc); // async: توليد QR SVG
  printHtml(html);
  return { via: "browser" };
}
