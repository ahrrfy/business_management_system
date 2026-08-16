import { D, round2 } from "@/lib/money";

export type PayrollRunStatus = "draft" | "approved" | "paid" | "cancelled";
export type PayrollObligationKind =
  | "SALARY_NET"
  | "INCOME_TAX"
  | "SOCIAL_SECURITY"
  | "EOS_PROVISION";

export const PAYROLL_STATUS_LABEL: Record<PayrollRunStatus, string> = {
  draft: "مسوّدة",
  approved: "معتمد استحقاقياً",
  paid: "مدفوع",
  cancelled: "ملغى",
};

export const OBLIGATION_KIND_LABEL: Record<PayrollObligationKind, string> = {
  SALARY_NET: "صافي رواتب مستحق",
  INCOME_TAX: "ضريبة دخل مستحقة",
  SOCIAL_SECURITY: "ضمان اجتماعي مستحق",
  EOS_PROVISION: "مخصص نهاية الخدمة",
};

export const REMITTANCE_STATUS_LABEL: Record<string, string> = {
  PENDING: "بانتظار الاعتماد",
  APPROVED: "معتمد للدفع",
  PAID: "مدفوع للجهة",
  REJECTED: "مرفوض",
  REVERSED: "معاد",
};

export function payrollStatusLabel(status: string): string {
  return PAYROLL_STATUS_LABEL[status as PayrollRunStatus] ?? status;
}

export function shortHash(value: string | null | undefined): string {
  if (!value) return "غير مثبت";
  return value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-8)}`;
}

type PayrollItemAmount = {
  gross: string;
  overtime: string;
  commission: string;
  wageReduction?: string | null;
  socialSecurityEmployer?: string | null;
  endOfServiceAccrual?: string | null;
};

/** تكلفة الفترة المعترف بها: الأجر المكتسب بعد التخفيض الصريح + كلفة الضمان + نهاية الخدمة. */
export function payrollExpenseFromItems(items: PayrollItemAmount[]): string {
  const value = items.reduce(
    (sum, item) => sum
      .plus(D(item.gross))
      .plus(D(item.overtime))
      .plus(D(item.commission))
      .minus(D(item.wageReduction ?? 0))
      .plus(D(item.socialSecurityEmployer ?? 0))
      .plus(D(item.endOfServiceAccrual ?? 0)),
    D(0),
  );
  return round2(value).toFixed(2);
}

export type ObligationLike = {
  kind?: PayrollObligationKind | string | null;
  originalAmount?: string | null;
  remainingAmount?: string | null;
  status?: string | null;
  revisionNo?: number | null;
  branchIdSnapshot?: number | null;
};

export type ObligationSummary = {
  kind: PayrollObligationKind;
  original: string;
  remaining: string;
  count: number;
  openCount: number;
};

export function summarizeObligations(
  rows: ObligationLike[],
  revisionNo?: number,
): ObligationSummary[] {
  const kinds = Object.keys(OBLIGATION_KIND_LABEL) as PayrollObligationKind[];
  return kinds.map((kind) => {
    const filtered = rows.filter((row) =>
      row.kind === kind && (revisionNo == null || Number(row.revisionNo) === revisionNo),
    );
    return {
      kind,
      original: round2(filtered.reduce((sum, row) => sum.plus(D(row.originalAmount ?? 0)), D(0))).toFixed(2),
      remaining: round2(filtered.reduce((sum, row) => sum.plus(D(row.remainingAmount ?? 0)), D(0))).toFixed(2),
      count: filtered.length,
      openCount: filtered.filter((row) => row.status === "OPEN" || row.status === "PARTIAL").length,
    };
  });
}

/**
 * المبلغ المسدّد فعلياً من التزامات المراجعة الحالية. لا نستنتجه من حالة المسيّر:
 * إعادة دفعةٍ جزئية تعيد `remainingAmount` فوراً، والالتزام المعكوس ليس دفعةً مهما كان باقيه صفراً.
 */
export function settledObligationAmount(
  rows: ObligationLike[],
  kind: PayrollObligationKind,
  revisionNo?: number,
): string {
  const value = rows
    .filter((row) =>
      row.kind === kind &&
      row.status !== "REVERSED" &&
      (revisionNo == null || Number(row.revisionNo) === revisionNo),
    )
    .reduce(
      (sum, row) => sum.plus(D(row.originalAmount ?? 0).minus(D(row.remainingAmount ?? 0))),
      D(0),
    );
  return round2(value).toFixed(2);
}

type AccountingEventLike = {
  id: number;
  eventKind: string;
  reversalOfId?: number | null;
};

/** دفعات صافي الراتب التي لم يُنشأ لها حدث إعادة مستقل. */
export function activeSalaryPaymentEvents<T extends AccountingEventLike>(events: T[]): T[] {
  const reversed = new Set(
    events
      .filter((event) => event.eventKind === "SALARY_PAYMENT_RETURN" && event.reversalOfId != null)
      .map((event) => Number(event.reversalOfId)),
  );
  return events.filter((event) => event.eventKind === "SALARY_PAYMENT" && !reversed.has(Number(event.id)));
}

export function toExcelMoney(value: string | null | undefined): number {
  const normalized = round2(D(value ?? 0));
  // ExcelJS لا يملك خلية Decimal؛ التحويل الوحيد عند حدّ الملف مسموح بعد حارس دقة السنتين.
  // أي مبلغ يتجاوز تمثيل JavaScript الصحيح إلى منزلتين يُرفض بدلاً من إفساده بصمت.
  const safeTwoDecimalLimit = D(Number.MAX_SAFE_INTEGER).div(100);
  if (normalized.abs().gt(safeTwoDecimalLimit)) {
    throw new RangeError("المبلغ أكبر من النطاق الرقمي الآمن لتصدير Excel");
  }
  return normalized.toNumber();
}
