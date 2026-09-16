export const EXCHANGE_DOUBLE_ENTRY_ROLE_LABELS = Object.freeze({
  FOREIGN_CASH_USD: "نقد دولار فعلي بالقيمة الدفترية",
  EXCHANGE_RECEIVABLE_IQD: "ذمم صيرفات مدينة — دينار عراقي",
  EXCHANGE_RECEIVABLE_USD: "ذمم صيرفات مدينة — دولار بالقيمة الدفترية",
  EXCHANGE_PAYABLE_IQD: "ذمم صيرفات دائنة — دينار عراقي",
  EXCHANGE_PAYABLE_USD: "ذمم صيرفات دائنة — دولار بالقيمة الدفترية",
} as const);

export const EXCHANGE_CONTROL_SCOPE_DISCLOSURE =
  "ذمم الصيرفات المدينة والدائنة تُعرض إجمالياً لكل صيرفة وعلى مستوى الشركة، ولا تُنسب إلى فرع اعتباطياً. أمّا «نقد دولار فعلي» فهو أصل حيازة مستقل ومفصّل حسب الفرع.";

export function exchangeDoubleEntryRoleLabel(role: string): string | null {
  return EXCHANGE_DOUBLE_ENTRY_ROLE_LABELS[
    role as keyof typeof EXCHANGE_DOUBLE_ENTRY_ROLE_LABELS
  ] ?? null;
}

export const ROLE_LABELS: Record<string, string> = {
  ...EXCHANGE_DOUBLE_ENTRY_ROLE_LABELS,
  AR: "ذمم العملاء",
  AP: "ذمم الموردين",
  CASH: "النقد",
  TREASURY_CASH: "نقد الخزينة",
  CARD_BANK: "البطاقة / البنك",
  INVENTORY: "المخزون",
  FIXED_ASSETS: "الأصول الثابتة",
  ACCUMULATED_DEPRECIATION: "مجمع الإهلاك",
  CONSIGNMENT_PAYABLE: "مستحقات مودعي الأمانة",
  DELIVERY_FLOAT: "عهدة التوصيل",
  EXCHANGE_WALLET_IQD: "محفظة الصيرفة بالدينار",
  EXCHANGE_WALLET_USD: "محفظة الصيرفة بالدولار",
  DIGITAL_WALLET: "المحافظ الرقمية",
  CAPITAL: "رأس المال",
  RETAINED_EARNINGS: "الأرباح المحتجزة",
  OWNER_CURRENT: "جاري المالك",
  LOAN_PAYABLE: "قروض مستحقة",
  SALES_STATIONERY: "إيراد القرطاسية",
  SALES_PRINT: "إيراد الطباعة",
  SALES_FLEX: "إيراد الفلكس",
  DELIVERY_REVENUE: "إيراد التوصيل",
  COGS: "تكلفة البضاعة المباعة",
  OPENING_EQUITY: "حقوق الرصيد الافتتاحي",
};

export function doubleEntryRoleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

export type OpeningAllocationRole =
  | "CAPITAL"
  | "RETAINED_EARNINGS"
  | "OWNER_CURRENT"
  | "LOAN_PAYABLE";

export const OPENING_ALLOCATION_ROLES: OpeningAllocationRole[] = [
  "CAPITAL",
  "RETAINED_EARNINGS",
  "OWNER_CURRENT",
  "LOAN_PAYABLE",
];

export function allocationKey(
  branchId: number | null,
  role: OpeningAllocationRole,
): string {
  return `${branchId == null ? "GLOBAL" : branchId}:${role}`;
}

