import { EscPos } from "./escpos";
import { docToHtml, docToRaster, printHtml, type PrintDoc } from "./render";
import { isPaired, sendBytes } from "./thermal";

export type { PrintDoc };
export { isPaired, isWebUsbSupported, pairPrinter } from "./thermal";

/**
 * Print a document: if a thermal printer is paired, rasterize and send via
 * ESC/POS over WebUSB; otherwise fall back to the browser print dialog (80mm).
 */
export async function printDoc(doc: PrintDoc): Promise<{ via: "thermal" | "browser" }> {
  if (isPaired()) {
    const raster = docToRaster(doc);
    if (raster) {
      const bytes = new EscPos().init().raster(raster).feed(3).cut().bytes();
      await sendBytes(bytes);
      return { via: "thermal" };
    }
  }
  printHtml(docToHtml(doc));
  return { via: "browser" };
}
