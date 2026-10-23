import { type RouterInputs } from "@/lib/trpc";
import { type PrintSalesReturnData } from "./printThermalReturnReceipt";
import type { RouterOutputs } from "@/lib/trpc";
export interface SalesReturnPortalProps {
  initialInvoiceNo?: string;
  initialMode?: "FULL" | "PARTIAL";
  onReturnSuccess: (data: PrintSalesReturnData) => void;
}
export type InspectedInvoice = NonNullable<
  RouterOutputs["returns"]["inspectInvoiceForReturn"]
>;
export type ReturnSubmission =
  RouterInputs["returns"]["executeSalesReturnCart"];
export interface SalesCartItem {
  id: string;
  variantId: number;
  productUnitId?: number;
  invoiceItemId?: number;
  isBundle?: boolean;
  productName: string;
  barcode?: string | null;
  quantity: number;
  maxAllowedQuantity?: number;
  unitPrice: string;
  originalUnitPrice?: string;
  unit?: string;
  conversionFactor?: number;
}
