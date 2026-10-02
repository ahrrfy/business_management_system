/**
 * client/src/lib/printing/barcodePdf.ts — وظيفة مساعدة لتحميل وتصدير باركود المنتج بصيغة PDF عالية الدقة.
 */
import { buildBarcodePdfFilename } from "@shared/barcodeEncoding";

export type { BarcodePdfPreset } from "@/components/product/BarcodePdfButton";
export { buildBarcodePdfFilename };
