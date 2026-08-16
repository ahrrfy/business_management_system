// عقد تحرير بند مسيّر الرواتب (updateItem) — الحقول القابلة للتعديل يدوياً على بند في حالة draft فقط.
export interface UpdateItemInput {
  overtime?: string | null;
  deductions?: string | null;
  note?: string | null;
}

export type PayrollPaymentMethod = "CASH" | "CARD" | "TRANSFER" | "WALLET";

export interface PayrollPaymentInput {
  paymentMethod?: PayrollPaymentMethod;
  paymentDate?: string | null;
  referenceNumber?: string | null;
}

export interface PayrollReturnInput {
  accountingEventId: number;
  reason: string;
  returnedAt?: string | null;
  referenceNumber?: string | null;
}

export type PayrollRemittanceKind = "INCOME_TAX" | "SOCIAL_SECURITY";

export interface CreatePayrollRemittanceInput {
  kind: PayrollRemittanceKind;
  payingBranchId: number;
  amount: string;
  authorityName: string;
  referenceNumber: string;
  supportingDocumentUrl: string;
  clientRequestId: string;
}

export interface PayrollRemittancePaymentInput {
  requestId: number;
  paymentMethod: PayrollPaymentMethod;
  paymentDate?: string | null;
  referenceNumber?: string | null;
}
