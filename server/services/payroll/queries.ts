// قراءة مسيّرات الرواتب: قائمة المسيّرات ومسيّر واحد ببنوده (مع بيانات الموظف المعروضة).
import { and, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { fullEmployeeName } from "@shared/hr";
import {
  accountingEntries,
  employees,
  payrollAccountingEvents,
  payrollItems,
  payrollObligations,
  payrollRemittanceRequests,
  payrollRuns,
  receipts,
  users,
} from "../../../drizzle/schema";
import { requireDb } from "../tx";
import { toDateStr } from "../money";

export async function listRuns() {
  const db = requireDb();
  const rows = await db.select().from(payrollRuns).orderBy(desc(payrollRuns.period), desc(payrollRuns.id));
  return rows;
}

export async function getRun(id: number) {
  const db = requireDb();
  const [run] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, id)).limit(1);
  if (!run) return null;
  const items = await db
    .select({
      ...getTableColumns(payrollItems),
      firstName: employees.firstName,
      fatherName: employees.fatherName,
      grandfatherName: employees.grandfatherName,
      lastName: employees.lastName,
      position: employees.position,
      department: employees.department,
      colorTag: employees.colorTag,
      photoUrl: employees.photoUrl,
      employmentStatus: employees.employmentStatus,
      baseSalary: employees.salary,
    })
    .from(payrollItems)
    .leftJoin(employees, eq(payrollItems.employeeId, employees.id))
    .where(eq(payrollItems.runId, id))
    .orderBy(payrollItems.id);
  const obligations = await db
    .select()
    .from(payrollObligations)
    .where(eq(payrollObligations.runId, id))
    .orderBy(payrollObligations.revisionNo, payrollObligations.id);
  const accountingEvents = await db
    .select()
    .from(payrollAccountingEvents)
    .where(eq(payrollAccountingEvents.runId, id))
    .orderBy(payrollAccountingEvents.revisionNo, payrollAccountingEvents.id);
  const salaryPayments = await db
    .select({
      employeeId: payrollObligations.employeeId,
      obligationId: payrollAccountingEvents.obligationId,
      eventId: payrollAccountingEvents.id,
      revisionNo: payrollAccountingEvents.revisionNo,
      receiptId: payrollAccountingEvents.receiptId,
      amount: receipts.amount,
      paymentDate: receipts.voucherDate,
      paymentMethod: receipts.paymentMethod,
      referenceNumber: receipts.referenceNumber,
      receiptStatus: receipts.status,
    })
    .from(payrollAccountingEvents)
    .innerJoin(
      payrollObligations,
      eq(payrollAccountingEvents.obligationId, payrollObligations.id),
    )
    .innerJoin(receipts, eq(payrollAccountingEvents.receiptId, receipts.id))
    .where(
      and(
        eq(payrollAccountingEvents.runId, id),
        eq(payrollAccountingEvents.eventKind, "SALARY_PAYMENT"),
      ),
    )
    .orderBy(payrollAccountingEvents.revisionNo, payrollAccountingEvents.id);
  const reversedPaymentIds = new Set(
    accountingEvents
      .filter(
        (event) =>
          event.eventKind === "SALARY_PAYMENT_RETURN" && event.reversalOfId != null,
      )
      .map((event) => Number(event.reversalOfId)),
  );
  return {
    ...run,
    items: items.map((it) => ({ ...it, employeeName: fullEmployeeName(it) })),
    obligations,
    accountingEvents,
    employeePaymentSnapshots: salaryPayments.map((payment) => ({
      employeeId: payment.employeeId == null ? null : Number(payment.employeeId),
      obligationId: Number(payment.obligationId),
      eventId: Number(payment.eventId),
      revisionNo: Number(payment.revisionNo),
      active:
        payment.receiptStatus === "COMPLETED" &&
        !reversedPaymentIds.has(Number(payment.eventId)),
      amount: payment.amount,
      paymentDate: payment.paymentDate,
      paymentMethod: payment.paymentMethod,
      referenceNumber: payment.referenceNumber,
      receiptId: Number(payment.receiptId),
    })),
  };
}

const FINANCIAL_MOVEMENT_KINDS = [
  "SALARY_PAYMENT",
  "SALARY_PAYMENT_RETURN",
  "TAX_REMITTANCE",
  "SOCIAL_SECURITY_REMITTANCE",
  "REMITTANCE_RETURN",
] as const;

export async function getPayrollFinancialLedger(input?: { period?: string }) {
  const db = requireDb();
  const filters = [
    inArray(payrollAccountingEvents.eventKind, [...FINANCIAL_MOVEMENT_KINDS]),
    input?.period
      ? sql`DATE_FORMAT(COALESCE(${receipts.voucherDate}, ${receipts.createdAt}), '%Y-%m') = ${input.period}`
      : undefined,
  ].filter(Boolean) as ReturnType<typeof eq>[];
  const rows = await db
    .select({
      movementType: payrollAccountingEvents.eventKind,
      runId: payrollAccountingEvents.runId,
      runPeriod: payrollRuns.period,
      employeeId: payrollObligations.employeeId,
      employeeFirstName: employees.firstName,
      employeeFatherName: employees.fatherName,
      employeeGrandfatherName: employees.grandfatherName,
      employeeLastName: employees.lastName,
      remittanceRequestId: payrollAccountingEvents.remittanceRequestId,
      remittanceKind: payrollRemittanceRequests.kind,
      authorityName: payrollRemittanceRequests.authorityName,
      eventId: payrollAccountingEvents.id,
      reversalOfId: payrollAccountingEvents.reversalOfId,
      amount: accountingEntries.amount,
      paymentDate: receipts.voucherDate,
      receiptCreatedAt: receipts.createdAt,
      paymentMethod: receipts.paymentMethod,
      referenceNumber: receipts.referenceNumber,
      receiptId: receipts.id,
      receiptStatus: receipts.status,
      createdBy: payrollAccountingEvents.createdBy,
      createdByName: users.name,
      occurredAt: payrollAccountingEvents.occurredAt,
    })
    .from(payrollAccountingEvents)
    .innerJoin(
      accountingEntries,
      eq(payrollAccountingEvents.accountingEntryId, accountingEntries.id),
    )
    .innerJoin(receipts, eq(payrollAccountingEvents.receiptId, receipts.id))
    .leftJoin(
      payrollObligations,
      eq(payrollAccountingEvents.obligationId, payrollObligations.id),
    )
    .leftJoin(employees, eq(payrollObligations.employeeId, employees.id))
    .leftJoin(payrollRuns, eq(payrollAccountingEvents.runId, payrollRuns.id))
    .leftJoin(
      payrollRemittanceRequests,
      eq(payrollAccountingEvents.remittanceRequestId, payrollRemittanceRequests.id),
    )
    .leftJoin(users, eq(payrollAccountingEvents.createdBy, users.id))
    .where(and(...filters))
    .orderBy(desc(receipts.voucherDate), desc(payrollAccountingEvents.id));
  const reversals = await db
    .select({ reversalOfId: payrollAccountingEvents.reversalOfId })
    .from(payrollAccountingEvents)
    .where(
      inArray(payrollAccountingEvents.eventKind, [
        "SALARY_PAYMENT_RETURN",
        "REMITTANCE_RETURN",
      ]),
    );
  const reversedIds = new Set(
    reversals
      .filter((row) => row.reversalOfId != null)
      .map((row) => Number(row.reversalOfId)),
  );
  return rows.map((row) => {
    const paymentDate = row.paymentDate ?? row.receiptCreatedAt;
    const isOutgoing =
      row.movementType === "SALARY_PAYMENT" ||
      row.movementType === "TAX_REMITTANCE" ||
      row.movementType === "SOCIAL_SECURITY_REMITTANCE";
    return {
      movementType: row.movementType as (typeof FINANCIAL_MOVEMENT_KINDS)[number],
      runId: row.runId == null ? null : Number(row.runId),
      period: row.runPeriod ?? toDateStr(new Date(paymentDate)).slice(0, 7),
      employeeId: row.employeeId == null ? null : Number(row.employeeId),
      employeeName:
        row.employeeId == null
          ? null
          : fullEmployeeName({
              firstName: row.employeeFirstName,
              fatherName: row.employeeFatherName,
              grandfatherName: row.employeeGrandfatherName,
              lastName: row.employeeLastName,
            }),
      remittanceRequestId:
        row.remittanceRequestId == null ? null : Number(row.remittanceRequestId),
      remittanceKind: row.remittanceKind,
      authorityName: row.authorityName,
      eventId: Number(row.eventId),
      reversalOfId: row.reversalOfId == null ? null : Number(row.reversalOfId),
      active:
        row.receiptStatus === "COMPLETED" &&
        (!isOutgoing || !reversedIds.has(Number(row.eventId))),
      amount: row.amount,
      paymentDate,
      method: row.paymentMethod,
      referenceNumber: row.referenceNumber,
      receiptId: Number(row.receiptId),
      createdBy: Number(row.createdBy),
      createdByName: row.createdByName,
      occurredAt: row.occurredAt,
    };
  });
}
