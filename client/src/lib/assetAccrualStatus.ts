export type AssetSettlementStatus =
  | "ACCRUED_UNPAID"
  | "PAYMENT_PENDING"
  | "PAYABLE_UNSETTLED"
  | "PAID"
  | "CORRECTION_PENDING"
  | "REFUND_PENDING"
  | "REFUNDED"
  | "RECOGNITION_REVERSED";

export type AssetSettlementTone = "active" | "pending" | "cancelled" | "muted";

export interface AssetSettlementPresentation {
  label: string;
  detail: string;
  tone: AssetSettlementTone;
  liabilityOutstanding: boolean;
  cashMoved: boolean;
}

const EMPTY: AssetSettlementPresentation = {
  label: "بلا التزام مالي",
  detail: "لا يوجد التزام اقتناء مرتبط بهذا الأصل.",
  tone: "muted",
  liabilityOutstanding: false,
  cashMoved: false,
};

export function assetSettlementPresentation(
  status?: string | null,
): AssetSettlementPresentation {
  switch (status as AssetSettlementStatus | undefined) {
    case "ACCRUED_UNPAID":
      return {
        label: "مستحق غير مدفوع",
        detail: "التزام اقتناء غير مسوّى؛ لم يُنشأ طلب دفع بعد، ولا يوجد خروج نقدي.",
        tone: "pending",
        liabilityOutstanding: true,
        cashMoved: false,
      };
    case "PAYMENT_PENDING":
      return {
        label: "طلب دفع معلّق",
        detail: "التزام اقتناء غير مسوّى؛ طلب الدفع ينتظر اعتماد مالك آخر بلا خروج نقدي.",
        tone: "pending",
        liabilityOutstanding: true,
        cashMoved: false,
      };
    case "PAYABLE_UNSETTLED":
      return {
        label: "ذمة مورد غير مسوّاة",
        detail: "الأصل مثبت وتبقى ذمة المورد مفتوحة حتى سدادها واعتمادها فعلياً.",
        tone: "pending",
        liabilityOutstanding: true,
        cashMoved: false,
      };
    case "PAID":
      return {
        label: "مسوّى ومدفوع",
        detail: "اكتملت تسوية التزام الاقتناء وثبت خروج النقد.",
        tone: "active",
        liabilityOutstanding: false,
        cashMoved: true,
      };
    case "CORRECTION_PENDING":
      return {
        label: "تصحيح معلّق",
        detail: "طلب تصحيح المصدر ينتظر اعتماد مالك آخر؛ لا عكس مالي حتى الاعتماد.",
        tone: "pending",
        liabilityOutstanding: true,
        cashMoved: false,
      };
    case "REFUND_PENDING":
      return {
        label: "استرداد معلّق",
        detail: "التصحيح المدفوع ينتظر إثبات الاسترداد الفعلي واعتماد مالك آخر.",
        tone: "pending",
        liabilityOutstanding: false,
        cashMoved: true,
      };
    case "REFUNDED":
      return {
        label: "مسترد بانتظار عكس الاعتراف",
        detail: "ثبت الاسترداد الفعلي ويجري إتمام عكس الاعتراف داخل المسار الذري.",
        tone: "pending",
        liabilityOutstanding: false,
        cashMoved: false,
      };
    case "RECOGNITION_REVERSED":
      return {
        label: "مصحح ومعكوس",
        detail: "اكتمل تصحيح المصدر وعكس الاعتراف بقيد مستقل غير قابل للمحو.",
        tone: "cancelled",
        liabilityOutstanding: false,
        cashMoved: false,
      };
    default:
      return EMPTY;
  }
}
