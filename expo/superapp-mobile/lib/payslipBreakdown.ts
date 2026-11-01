export interface PayslipBreakdownInput {
  gross: string;
  allowances?: string | null;
  baseSalary?: string | null;
  overtime: string;
  commission: string;
  deductions: string;
  advanceDeduction?: string | null;
  socialSecurityEmployee?: string | null;
  incomeTax?: string | null;
  net: string;
}

export interface PayslipBreakdown {
  gross: string;
  allowances: string;
  baseWage: string;
  overtime: string;
  commission: string;
  totalEarnings: string;
  advanceDeduction: string;
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

/** يحوّل النص المالي إلى فلسين بدقة، مع تقريب HALF_UP إلى منزلتين. */
function toCents(value: string | null | undefined): bigint {
  const normalized = (value ?? "0").trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) throw new Error("قيمة مالية غير صالحة في قسيمة الراتب.");
  const sign = match[1] === "-" ? -1n : 1n;
  const fraction = match[3] ?? "";
  let cents = BigInt(match[2]) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, "0"));
  if ((fraction[2] ?? "0") >= "5") cents += 1n;
  return sign * cents;
}

function fromCents(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * مرآة الهاتف للمساعد النقي في الويب. لا يستخدم Number في الحسابات المالية،
 * ويعامل المخصصات كمعلومة داخل الإجمالي ومكونات الاستقطاع كتفصيل داخل مجموعه.
 */
export function buildPayslipBreakdown(input: PayslipBreakdownInput): PayslipBreakdown {
  const gross = toCents(input.gross);
  const allowances =
    input.allowances != null
      ? toCents(input.allowances)
      : input.baseSalary != null
        ? gross - toCents(input.baseSalary)
        : 0n;
  const baseWage = gross - allowances;
  const overtime = toCents(input.overtime);
  const commission = toCents(input.commission);
  const totalEarnings = gross + overtime + commission;

  const advanceDeduction = toCents(input.advanceDeduction);
  const socialSecurityEmployee = toCents(input.socialSecurityEmployee);
  const incomeTax = toCents(input.incomeTax);
  const totalDeductions = toCents(input.deductions);
  const namedDeductions = advanceDeduction + socialSecurityEmployee + incomeTax;
  const deductionClassificationGap = totalDeductions - namedDeductions;
  const deductionComponentsValid = deductionClassificationGap >= 0n;
  const otherDeductions = deductionComponentsValid ? deductionClassificationGap : 0n;

  const expectedNet = totalEarnings - totalDeductions;
  const net = toCents(input.net);
  const netDifference = net - expectedNet;

  return {
    gross: fromCents(gross),
    allowances: fromCents(allowances),
    baseWage: fromCents(baseWage),
    overtime: fromCents(overtime),
    commission: fromCents(commission),
    totalEarnings: fromCents(totalEarnings),
    advanceDeduction: fromCents(advanceDeduction),
    socialSecurityEmployee: fromCents(socialSecurityEmployee),
    incomeTax: fromCents(incomeTax),
    otherDeductions: fromCents(otherDeductions),
    totalDeductions: fromCents(totalDeductions),
    expectedNet: fromCents(expectedNet),
    net: fromCents(net),
    netDifference: fromCents(netDifference),
    deductionClassificationGap: fromCents(deductionClassificationGap),
    allowancesValid: allowances >= 0n && allowances <= gross,
    deductionComponentsValid,
    netMatches: netDifference === 0n,
  };
}
