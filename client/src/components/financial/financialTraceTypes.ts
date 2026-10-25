import type { ComponentProps, ReactNode } from "react";
import type { FinancialAuditSeverity } from "./FinancialAuditFlag";

export type FinancialTraceTone = FinancialAuditSeverity;

export interface FinancialDocumentIdentity {
  id?: ReactNode;
  number?: ReactNode;
  type?: ReactNode;
  title?: ReactNode;
  status?: ReactNode;
  statusTone?: FinancialTraceTone;
  direction?: "IN" | "OUT" | "NEUTRAL" | string | null;
  amount?: ReactNode;
  currency?: ReactNode;
  branch?: ReactNode;
  reference?: ReactNode;
  description?: ReactNode;
  extra?: FinancialTraceField[];
}

export interface FinancialActor {
  name?: ReactNode;
  id?: ReactNode;
  role?: ReactNode;
  at?: ReactNode;
  note?: ReactNode;
}

export interface FinancialTraceParties {
  recordedBy?: FinancialActor | null;
  executedBy?: FinancialActor | null;
  beneficiary?: FinancialActor | null;
  approvedBy?: FinancialActor | null;
  receivedBy?: FinancialActor | null;
  reversedBy?: FinancialActor | null;
  extra?: Array<FinancialActor & { label: ReactNode }>;
}

export interface FinancialTraceField {
  label: ReactNode;
  value?: ReactNode;
  hint?: ReactNode;
  dir?: "rtl" | "ltr" | "auto";
  emphasis?: boolean;
}

export interface FinancialMoneyPath {
  paymentMethod?: string | null;
  source?: string | null;
  cashBucket?: string | null;
  branch?: ReactNode;
  shiftId?: ReactNode;
  shiftLabel?: ReactNode;
  shiftOwner?: ReactNode;
  from?: ReactNode;
  to?: ReactNode;
  device?: ReactNode;
  externalReference?: ReactNode;
  balanceBefore?: ReactNode;
  balanceAfter?: ReactNode;
  extra?: FinancialTraceField[];
}

export type FinancialLinkKind = "DOCUMENT" | "RECEIPT" | "LEDGER" | "OTHER";

export interface FinancialLinkNode {
  id?: string | number;
  kind: FinancialLinkKind;
  label: ReactNode;
  value?: ReactNode;
  subtitle?: ReactNode;
  href?: string;
  status?: ReactNode;
  missing?: boolean;
}

export interface FinancialTimestamp {
  id?: string | number;
  label: ReactNode;
  value?: ReactNode;
  actor?: ReactNode;
  note?: ReactNode;
}

export interface FinancialIntegrityWarning {
  id?: string | number;
  severity: FinancialAuditSeverity;
  title: ReactNode;
  description?: string | null;
  code?: string | null;
  resolved?: boolean;
}

export interface FinancialAuditEvent {
  id?: string | number;
  action: ReactNode;
  actor?: ReactNode;
  at?: ReactNode;
  detail?: ReactNode;
  status?: ReactNode;
  tone?: FinancialTraceTone;
}

export interface FinancialTraceDetailsProps extends Omit<
  ComponentProps<"section">,
  "title"
> {
  document: FinancialDocumentIdentity;
  parties?: FinancialTraceParties;
  moneyPath?: FinancialMoneyPath;
  linkChain?: FinancialLinkNode[];
  timestamps?: FinancialTimestamp[];
  integrityWarnings?: FinancialIntegrityWarning[];
  auditTimeline?: FinancialAuditEvent[];
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
  contentClassName?: string;
}
