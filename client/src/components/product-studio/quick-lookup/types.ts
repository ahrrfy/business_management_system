import type { RouterInputs, RouterOutputs } from "@/lib/trpc";

export type StudioMode = "AI" | "REMOVEBG" | "FLATTEN" | "ORIGINAL";

export interface QuickStudioTarget {
  barcode?: string | null;
  productId?: number | null;
  variantId?: number | null;
}

export interface QuickStudioProps {
  className?: string;
  onProductHandled?: (productId: number) => void;
  offline?: boolean;
  /** إخفاء شريط البحث عند تضمين النافذة في شاشة أخرى. */
  hideSearchBar?: boolean;
  externalTarget?: QuickStudioTarget | null;
  onExternalTargetClose?: () => void;
  externalScannerOpen?: boolean;
  onExternalScannerOpenChange?: (open: boolean) => void;
}

export type QuickStudioLookup =
  RouterOutputs["productStudio"]["quickBarcodeLookup"];
export type QuickStudioSaveInput =
  RouterInputs["productStudio"]["quickSaveBarcodeProductImage"];
