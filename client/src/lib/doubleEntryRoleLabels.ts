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
