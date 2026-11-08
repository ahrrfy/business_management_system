// أنواع العقد المشترك للاستيراد (عملاء/موردون/منتجات).

export type OnExisting = "skip" | "update" | "error";
export type BalanceSign = "asIs" | "invert";
export type ImportOptions = {
  dryRun?: boolean;
  onExisting?: OnExisting;
  fileName?: string;
  /** سعر صرف الدولار (نص — decimal.js): إلزامي إن وُجدت صفوف USD برصيد غير صفري. */
  usdRate?: string;
  /** تجاوز الصفوف الفاشلة: اكتب الصالح فقط بدل «الكل أو لا شيء» (افتراضه مطفأ). */
  skipFailed?: boolean;
  /** اتجاه الرصيد الافتتاحي: «كما في الملف» أو «اعكس الإشارة» (افتراض الموردين في الواجهة: اعكس). */
  balanceSign?: BalanceSign;
  /** الفرع المستهدف عند استيراد مخزون افتتاحي موجب (يُشترط صراحةً أو من فرع الفاعل المخوَّل). */
  branchId?: number;
};

export type ImportRowResult = {
  rowNumber: number;
  status: "created" | "updated" | "skipped" | "failed";
  message?: string;
};

export type ImportSummary = {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  committed: boolean;
  rows: ImportRowResult[];
};

// تصدير داخلي للحزمة فقط (يستهلكه helpers.ts) — لا يُعاد تصديره من البرميل importService.ts.
export type ImportType = "CUSTOMERS" | "SUPPLIERS" | "PRODUCTS";
