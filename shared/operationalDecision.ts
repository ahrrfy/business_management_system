import Decimal from "decimal.js";

/** قرار تشغيلي واحد تستهلكه الواجهة والراوتر والخدمة المالية. */
export type OperationalDecision =
  | { result: "DIRECT"; reason: string }
  | {
      result: "APPROVAL_REQUIRED";
      reason: string;
      approvalOperation: string;
    }
  | { result: "DENY"; reason: string };

export interface RefundOperationalContext {
  operationAllowed: boolean;
  sameBranch: boolean;
  ownsTransaction: boolean;
  sameOpenShift: boolean;
  sameBusinessDay: boolean;
  accountingPeriodOpen: boolean;
  hasDownstreamEffects?: boolean;
  hasSourceDocument?: boolean;
  refundAmountIqd: string | number;
  maxRefundAmountIqd: string | null | undefined;
  refundMethod: string;
  originalPaymentMethods?: readonly string[];
  drawerHasFunds?: boolean;
  approvalOperation: string;
}

const approval = (
  reason: string,
  approvalOperation: string,
): OperationalDecision => ({
  result: "APPROVAL_REQUIRED",
  reason,
  approvalOperation,
});

/**
 * يحسم قابلية الإلغاء/المرتجع النقدي قبل أول كتابة. لا يمنح الصلاحية بذاته؛
 * بل يضيف حدود المعاملة إلى قرار التفويض المحلول من الدور والمستخدم.
 */
export function evaluateRefundOperationalDecision(
  input: RefundOperationalContext,
): OperationalDecision {
  if (!input.operationAllowed)
    return { result: "DENY", reason: "العملية غير مفوضة لهذا الحساب" };
  if (!input.sameBranch)
    return { result: "DENY", reason: "المستند يخص فرعاً آخر" };
  if (input.drawerHasFunds === false)
    return { result: "DENY", reason: "رصيد درج الوردية لا يكفي للرد النقدي" };
  if (input.hasSourceDocument === false)
    return approval("المرتجع بلا مستند بيع أصلي", input.approvalOperation);
  if (!input.accountingPeriodOpen)
    return approval("الفترة المحاسبية للمستند مقفلة", input.approvalOperation);
  if (input.hasDownstreamEffects)
    return approval("للمستند آثار تشغيلية أو مالية لاحقة", input.approvalOperation);

  // A manager approval cannot make an impossible payout rail valid. Validate
  // the original payment method before same-maker/same-shift routing so the
  // operator sees the actionable defect first.
  const amount = new Decimal(input.refundAmountIqd || 0);
  const originalMethods = new Set(
    (input.originalPaymentMethods ?? []).map((method) => method.toUpperCase()),
  );
  if (
    amount.gt(0) &&
    originalMethods.size > 0 &&
    !originalMethods.has(input.refundMethod.toUpperCase())
  )
    return approval(
      "طريقة الرد لا تطابق طريقة الدفع الأصلية",
      input.approvalOperation,
    );

  if (!input.ownsTransaction)
    return approval("المستند أنشأه موظف آخر", input.approvalOperation);
  if (!input.sameOpenShift)
    return approval("الرد ليس من الوردية المفتوحة التي قبضت المبلغ", input.approvalOperation);
  if (!input.sameBusinessDay)
    return approval("المستند ليس من يوم العمل الحالي", input.approvalOperation);

  const cap =
    input.maxRefundAmountIqd == null
      ? null
      : new Decimal(input.maxRefundAmountIqd || 0);
  if (cap != null && amount.gt(cap))
    return approval(
      `مبلغ الرد ${amount.toFixed(2)} د.ع يتجاوز السقف ${cap.toFixed(2)} د.ع`,
      input.approvalOperation,
    );

  return {
    result: "DIRECT",
    reason:
      amount.isZero()
        ? "لا يوجد مبلغ مقبوض يحتاج إلى رد"
        : `ينفذ مباشرة ضمن سقف ${cap == null ? "غير محدود" : `${cap.toFixed(2)} د.ع`}`,
  };
}

export class OperationalApprovalRequiredError extends Error {
  readonly decision: Extract<OperationalDecision, { result: "APPROVAL_REQUIRED" }>;

  constructor(
    decision: Extract<OperationalDecision, { result: "APPROVAL_REQUIRED" }>,
  ) {
    super(decision.reason);
    this.name = "OperationalApprovalRequiredError";
    this.decision = decision;
  }
}
