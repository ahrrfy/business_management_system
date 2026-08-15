import { D, round2 } from "@/lib/money";

export type TerminationSettlementBreakdown = {
  earnedGrossWages: string;
  wageReductions: string;
  advanceRecovery: string;
  incomeTax: string;
  employeeSocialSecurity: string;
  employerSocialSecurity: string;
  leaveCompensation: string;
  noticeCompensation: string;
  eosBenefit: string;
  otherSettlement: string;
  otherSettlementLabel: string;
};

export const EMPTY_TERMINATION_SETTLEMENT: TerminationSettlementBreakdown = {
  earnedGrossWages: "",
  wageReductions: "",
  advanceRecovery: "",
  incomeTax: "",
  employeeSocialSecurity: "",
  employerSocialSecurity: "",
  leaveCompensation: "",
  noticeCompensation: "",
  eosBenefit: "",
  otherSettlement: "",
  otherSettlementLabel: "",
};

export function terminationSettlementTotal(
  value: TerminationSettlementBreakdown,
): string {
  const earnedNet = D(value.earnedGrossWages || 0)
    .minus(D(value.wageReductions || 0))
    .minus(D(value.advanceRecovery || 0))
    .minus(D(value.incomeTax || 0))
    .minus(D(value.employeeSocialSecurity || 0));
  return round2(
    earnedNet
      .plus(D(value.leaveCompensation || 0))
      .plus(D(value.noticeCompensation || 0))
      .plus(D(value.eosBenefit || 0))
      .plus(D(value.otherSettlement || 0)),
  ).toFixed(2);
}

export function validateTerminationSettlement(
  value: TerminationSettlementBreakdown,
): string | null {
  const entries = [
    ["إجمالي الأجور المكتسبة", value.earnedGrossWages],
    ["تخفيضات الأجر", value.wageReductions],
    ["استرداد السلفة", value.advanceRecovery],
    ["ضريبة الدخل", value.incomeTax],
    ["حصة الموظف من الضمان", value.employeeSocialSecurity],
    ["حصة الشركة من الضمان", value.employerSocialSecurity],
    ["بدل الإجازات", value.leaveCompensation],
    ["بدل الإشعار", value.noticeCompensation],
    ["مكافأة نهاية الخدمة", value.eosBenefit],
    ["المستحق الآخر", value.otherSettlement],
  ] as const;
  for (const [label, raw] of entries) {
    const amount = D(raw || 0);
    if (!amount.isFinite() || amount.isNegative() || !amount.eq(round2(amount))) {
      return `${label}: أدخل مبلغاً غير سالب بمنزلتين عشريتين كحد أقصى.`;
    }
  }
  const earnedNet = D(value.earnedGrossWages || 0)
    .minus(D(value.wageReductions || 0))
    .minus(D(value.advanceRecovery || 0))
    .minus(D(value.incomeTax || 0))
    .minus(D(value.employeeSocialSecurity || 0));
  if (earnedNet.isNegative()) {
    return "صافي الأجور المكتسبة لا يجوز أن يكون سالباً.";
  }
  if (D(value.otherSettlement || 0).gt(0) && !value.otherSettlementLabel.trim()) {
    return "تصنيف المستحق الآخر إلزامي عندما تكون له قيمة.";
  }
  return null;
}

export function terminationEarnedNet(
  value: TerminationSettlementBreakdown,
): string {
  return round2(
    D(value.earnedGrossWages || 0)
      .minus(D(value.wageReductions || 0))
      .minus(D(value.advanceRecovery || 0))
      .minus(D(value.incomeTax || 0))
      .minus(D(value.employeeSocialSecurity || 0)),
  ).toFixed(2);
}

export const TERMINATION_PAYMENT_METHOD_LABEL: Record<string, string> = {
  CASH: "نقداً من الخزينة",
  CARD: "بطاقة / حساب مصرفي",
  TRANSFER: "تحويل مصرفي",
  WALLET: "محفظة دفع",
};
