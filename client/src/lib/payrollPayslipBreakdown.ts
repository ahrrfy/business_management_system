import { D, round2 } from "@/lib/money";

/** لقطات الجزاءات المثبتة في بند المسير؛ غيابها لا يعني أن الجزاء التاريخي صفر. */
export interface PayrollPenaltyProjection {
  penaltyDeduction?: string | null;
  penaltyLines?: Array<{ penaltyId: number; decisionNumber: string; amount: string }> | null;
}

export interface PayrollPayslipBreakdownInput {
  gross: string;
  allowances?: string | null;
  baseSalary?: string | null;
  overtime: string;
  commission: string;
  deductions: string;
  advanceDeduction?: string | null;
  penaltyDeduction?: string | null;
  socialSecurityEmployee?: string | null;
  incomeTax?: string | null;
  net: string;
}

export interface PayrollPayslipBreakdown {
  gross: string;
  allowances: string;
  baseWage: string;
  overtime: string;
  commission: string;
  totalEarnings: string;
  advanceDeduction: string;
  penaltyDeduction: string;
  penaltyDeductionKnown: boolean;
  socialSecurityEmployee: string;
  incomeTax: string;
  otherDeductions: string;
  totalDeductions: string;
  expectedNet: string;
  net: string;
  netDifference: string;
  deductionClassificationGap: string;
  allowancesValid: boolean;
  deductionComponentsValid: boolean;
  netMatches: boolean;
}

function money(value: string | null | undefined) {
  return round2(D(value ?? 0));
}

/**
 * مصدر العرض الوحيد لقسائم الرواتب.
 *
 * `gross` يشمل المخصصات، و`deductions` يشمل كل مكوّناته المسماة. لذلك لا يجوز
 * جمع أيّ منهما مرة ثانية عند عرض المكونات. المساعد لا يصحح لقطة غير متطابقة؛
 * يعيد فروقها صراحةً كي تظهر للمراجع بدلاً من إخفائها بتقريب أو قصّ.
 */
export function buildPayrollPayslipBreakdown(
  input: PayrollPayslipBreakdownInput,
): PayrollPayslipBreakdown {
  const gross = money(input.gross);
  const explicitAllowances =
    input.allowances == null ? null : money(input.allowances);
  const baseSalary = input.baseSalary == null ? null : money(input.baseSalary);
  const allowances = explicitAllowances ??
    (baseSalary == null ? money("0") : round2(gross.minus(baseSalary)));
  const baseWage = round2(gross.minus(allowances));
  const overtime = money(input.overtime);
  const commission = money(input.commission);
  const totalEarnings = round2(gross.plus(overtime).plus(commission));

  const advanceDeduction = money(input.advanceDeduction);
  const penaltyDeduction = money(input.penaltyDeduction);
  const socialSecurityEmployee = money(input.socialSecurityEmployee);
  const incomeTax = money(input.incomeTax);
  const totalDeductions = money(input.deductions);
  const namedDeductions = round2(
    advanceDeduction.plus(penaltyDeduction).plus(socialSecurityEmployee).plus(incomeTax),
  );
  const deductionClassificationGap = round2(
    totalDeductions.minus(namedDeductions),
  );
  const deductionComponentsValid =
    deductionClassificationGap.greaterThanOrEqualTo(0);
  const otherDeductions = deductionComponentsValid
    ? deductionClassificationGap
    : money("0");

  const expectedNet = round2(totalEarnings.minus(totalDeductions));
  const net = money(input.net);
  const netDifference = round2(net.minus(expectedNet));

  return {
    gross: gross.toFixed(2),
    allowances: allowances.toFixed(2),
    baseWage: baseWage.toFixed(2),
    overtime: overtime.toFixed(2),
    commission: commission.toFixed(2),
    totalEarnings: totalEarnings.toFixed(2),
    advanceDeduction: advanceDeduction.toFixed(2),
    penaltyDeduction: penaltyDeduction.toFixed(2),
    penaltyDeductionKnown: input.penaltyDeduction != null,
    socialSecurityEmployee: socialSecurityEmployee.toFixed(2),
    incomeTax: incomeTax.toFixed(2),
    otherDeductions: otherDeductions.toFixed(2),
    totalDeductions: totalDeductions.toFixed(2),
    expectedNet: expectedNet.toFixed(2),
    net: net.toFixed(2),
    netDifference: netDifference.toFixed(2),
    deductionClassificationGap: deductionClassificationGap.toFixed(2),
    allowancesValid:
      allowances.greaterThanOrEqualTo(0) && allowances.lessThanOrEqualTo(gross),
    deductionComponentsValid,
    netMatches: netDifference.isZero(),
  };
}
