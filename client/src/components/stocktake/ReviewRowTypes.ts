import type { RouterOutputs } from "@/lib/trpc";
type Review = RouterOutputs["stocktakes"]["review"];
export type ReviewRow = Review["rows"][number];
export type Reason =
  | "UNSPECIFIED"
  | "DAMAGE"
  | "LOSS_THEFT"
  | "ENTRY_ERROR"
  | "PRINT_WASTE";
/** أسباب الفروقات الخمسة المعتمدة — تغذي تقرير الانكماش والقيد المحاسبي. */
export const REASONS: { v: Reason; label: string }[] = [
  { v: "UNSPECIFIED", label: "غير محدد" },
  { v: "DAMAGE", label: "تلف / كسر" },
  { v: "LOSS_THEFT", label: "فقدان / سرقة" },
  { v: "ENTRY_ERROR", label: "خطأ إدخال" },
  { v: "PRINT_WASTE", label: "هدر تشغيل مطبعة" },
];

export interface ReviewRowActions {
  s: Review["session"];
  isOperational: boolean;
  canOperation: (path: string) => boolean;
  selectedForApproval: Set<number>;
  toggleApprovalSelection: (id: number, checked: boolean) => void;
  setReopenFor: (target: { variantId: number; label: string } | null) => void;
  setReopenReason: (reason: string) => void;
  setConflictFor: (id: number | null) => void;
  decide: { isPending: boolean };
  onDecide: (row: ReviewRow, action: "ADJUST" | "KEEP") => void;
  openRecount: (row: ReviewRow) => void;
  onReasonChange: (row: ReviewRow, value: Reason) => void;
}
