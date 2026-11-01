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
import { money, toDateStr } from "../money";
import {
  assertSalaryReceiptEvidence,
  readSalarySettlementEvidence,
} from "./settlementEvidence";

/**
 * وقت آخر دفعة راتب فعالة لبند الموظف في مراجعة المسيّر الحالية.
 * لا يُستعمل `payrollRuns.paidAt` هنا لأنه يثبت إغلاق المسيّر ككل، لا قبض هذا الموظف.
 */
export function activeEmployeeSalaryPaidAtSql() {
  return sql<Date | null>`(
    SELECT MAX(payment.\`occurredAt\`)
    FROM \`payrollAccountingEvents\` payment
    INNER JOIN \`payrollObligations\` obligation
      ON obligation.\`id\` = payment.\`obligationId\`
    INNER JOIN \`accountingEntries\` paymentEntry
      ON paymentEntry.\`id\` = payment.\`accountingEntryId\`
    INNER JOIN \`receipts\` paymentReceipt
      ON paymentReceipt.\`id\` = payment.\`receiptId\`
    WHERE payment.\`runId\` = ${payrollRuns.id}
      AND payment.\`revisionNo\` = ${payrollRuns.revisionNo}
      AND payment.\`payrollAccountingEventKind\` = 'SALARY_PAYMENT'
      AND obligation.\`itemId\` = ${payrollItems.id}
      AND obligation.\`employeeId\` = ${payrollItems.employeeId}
      AND obligation.\`branchIdSnapshot\` = payment.\`branchIdSnapshot\`
      AND obligation.\`payrollObligationKind\` = 'SALARY_NET'
      AND obligation.\`payrollObligationStatus\` = 'SETTLED'
      AND obligation.\`remainingAmount\` = 0
      AND paymentReceipt.\`receiptStatus\` = 'COMPLETED'
      AND paymentReceipt.\`receiptApprovalStatus\` = 'APPROVED'
      AND paymentReceipt.\`direction\` = 'OUT'
      AND paymentReceipt.\`amount\` > 0
      AND paymentReceipt.\`branchId\` = payment.\`branchIdSnapshot\`
      AND paymentEntry.\`entryType\` = 'PAYMENT_OUT'
      AND paymentEntry.\`receiptId\` = paymentReceipt.\`id\`
      AND paymentEntry.\`amount\` = paymentReceipt.\`amount\`
      AND paymentEntry.\`branchId\` = payment.\`branchIdSnapshot\`
      AND (
        paymentEntry.\`postingProfile\` IS NULL
        OR paymentEntry.\`postingProfile\` = 'PAYMENT_OUT_PAYROLL_NET'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM \`payrollAccountingEvents\` paymentReturn
        WHERE paymentReturn.\`payrollAccountingEventKind\` = 'SALARY_PAYMENT_RETURN'
          AND paymentReturn.\`reversalOfId\` = payment.\`id\`
      )
  )`;
}

export async function listRuns() {
  const db = requireDb();
  const rows = await db
    .select()
    .from(payrollRuns)
    .orderBy(desc(payrollRuns.period), desc(payrollRuns.id));
  const payments = await db
    .select({
      event: payrollAccountingEvents,
      amount: accountingEntries.amount,
      receiptAmount: receipts.amount,
      receipt: receipts,
      receiptStatus: receipts.status,
    })
    .from(payrollAccountingEvents)
    .innerJoin(
      payrollRuns,
      and(
        eq(payrollAccountingEvents.runId, payrollRuns.id),
        eq(payrollAccountingEvents.revisionNo, payrollRuns.revisionNo),
      ),
    )
    .innerJoin(
      accountingEntries,
      eq(payrollAccountingEvents.accountingEntryId, accountingEntries.id),
    )
    .leftJoin(receipts, eq(payrollAccountingEvents.receiptId, receipts.id))
    .where(
      and(
        eq(payrollAccountingEvents.eventKind, "SALARY_PAYMENT"),
        sql`NOT EXISTS (SELECT 1 FROM payrollAccountingEvents reversed WHERE reversed.reversalOfId = ${payrollAccountingEvents.id})`,
      ),
    );
  return rows.map((run) => {
    const active = payments
      .filter((row) => row.event.runId === run.id)
      .filter((row) => {
        const evidence = readSalarySettlementEvidence(
          row.event.settlementEvidence,
          row.event.sourceHash,
        );
        assertSalaryReceiptEvidence(evidence, {
          event: row.event,
          receipt: row.receipt,
          entryAmount: row.amount,
          reversed: false,
        });
        return (
          row.receiptStatus === "COMPLETED" ||
          (row.event.receiptId == null && evidence != null)
        );
      });
    return {
      ...run,
      totalActualSalaryPaid: active
        .reduce((sum, row) => sum.plus(money(row.amount)), money(0))
        .toFixed(2),
      salarySettlementCount: active.length,
    };
  });
}

export async function getRun(id: number) {
  const db = requireDb();
  const [run] = await db
    .select()
    .from(payrollRuns)
    .where(eq(payrollRuns.id, id))
    .limit(1);
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
      event: payrollAccountingEvents,
      obligation: payrollObligations,
      receipt: receipts,
      settlementEvidence: payrollAccountingEvents.settlementEvidence,
      sourceHash: payrollAccountingEvents.sourceHash,
      occurredAt: payrollAccountingEvents.occurredAt,
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
    .leftJoin(receipts, eq(payrollAccountingEvents.receiptId, receipts.id))
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
          event.eventKind === "SALARY_PAYMENT_RETURN" &&
          event.reversalOfId != null,
      )
      .map((event) => Number(event.reversalOfId)),
  );
  return {
    ...run,
    items: items.map((it) => ({ ...it, employeeName: fullEmployeeName(it) })),
    obligations,
    accountingEvents,
    employeePaymentSnapshots: salaryPayments.map((payment) => {
      const evidence = readSalarySettlementEvidence(
        payment.settlementEvidence,
        payment.sourceHash,
      );
      assertSalaryReceiptEvidence(evidence, {
        event: payment.event,
        receipt: payment.receipt,
        obligation: payment.obligation,
        reversed: reversedPaymentIds.has(payment.eventId),
      });
      if (!payment.receiptId && !evidence)
        throw new Error("دليل تسوية الراتب بلا إيصال مفقود");
      return {
        employeeId:
          payment.employeeId == null ? null : Number(payment.employeeId),
        obligationId: Number(payment.obligationId),
        eventId: Number(payment.eventId),
        revisionNo: Number(payment.revisionNo),
        active:
          (payment.receiptStatus === "COMPLETED" ||
            (!payment.receiptId && evidence != null)) &&
          !reversedPaymentIds.has(Number(payment.eventId)),
        amount: evidence?.actualPayout ?? payment.amount!,
        entitlementSettled: evidence?.entitlementSettled ?? null,
        signedDifference: evidence?.signedDifference ?? null,
        classification: evidence?.classification ?? "LEGACY_UNCLASSIFIED",
        evidenceVersion: evidence?.version ?? null,
        paymentDate: evidence
          ? new Date(`${evidence.paymentYmd}T00:00:00.000Z`)
          : (payment.paymentDate ?? payment.occurredAt),
        paymentMethod: evidence?.method ?? payment.paymentMethod!,
        referenceNumber: evidence
          ? evidence.referenceNumber
          : payment.referenceNumber,
        receiptId: payment.receiptId == null ? null : Number(payment.receiptId),
      };
    }),
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
      ? sql`DATE_FORMAT(COALESCE(${receipts.voucherDate}, ${receipts.createdAt}, ${payrollAccountingEvents.occurredAt}), '%Y-%m') = ${input.period}`
      : undefined,
  ].filter(Boolean) as ReturnType<typeof eq>[];
  const rows = await db
    .select({
      event: payrollAccountingEvents,
      obligation: payrollObligations,
      receipt: receipts,
      settlementEvidence: payrollAccountingEvents.settlementEvidence,
      sourceHash: payrollAccountingEvents.sourceHash,
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
      receiptAmount: receipts.amount,
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
    .leftJoin(receipts, eq(payrollAccountingEvents.receiptId, receipts.id))
    .leftJoin(
      payrollObligations,
      eq(payrollAccountingEvents.obligationId, payrollObligations.id),
    )
    .leftJoin(employees, eq(payrollObligations.employeeId, employees.id))
    .leftJoin(payrollRuns, eq(payrollAccountingEvents.runId, payrollRuns.id))
    .leftJoin(
      payrollRemittanceRequests,
      eq(
        payrollAccountingEvents.remittanceRequestId,
        payrollRemittanceRequests.id,
      ),
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
    const evidence = readSalarySettlementEvidence(
      row.settlementEvidence,
      row.sourceHash,
    );
    assertSalaryReceiptEvidence(evidence, {
      event: row.event,
      receipt: row.receipt,
      obligation: row.obligation,
      entryAmount: row.amount,
      reversed: reversedIds.has(row.eventId),
    });
    const paymentDate = evidence
      ? new Date(`${evidence.paymentYmd}T00:00:00.000Z`)
      : (row.paymentDate ?? row.receiptCreatedAt ?? row.occurredAt);
    const isOutgoing =
      row.movementType === "SALARY_PAYMENT" ||
      row.movementType === "TAX_REMITTANCE" ||
      row.movementType === "SOCIAL_SECURITY_REMITTANCE";
    return {
      movementType:
        row.movementType as (typeof FINANCIAL_MOVEMENT_KINDS)[number],
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
        row.remittanceRequestId == null
          ? null
          : Number(row.remittanceRequestId),
      remittanceKind: row.remittanceKind,
      authorityName: row.authorityName,
      eventId: Number(row.eventId),
      reversalOfId: row.reversalOfId == null ? null : Number(row.reversalOfId),
      active:
        (row.receiptStatus === "COMPLETED" ||
          (row.receiptId == null && evidence != null)) &&
        (!isOutgoing || !reversedIds.has(Number(row.eventId))),
      amount: evidence?.actualPayout ?? row.amount,
      entitlementSettled: evidence?.entitlementSettled ?? null,
      signedDifference: evidence?.signedDifference ?? null,
      classification: evidence?.classification ?? "LEGACY_UNCLASSIFIED",
      evidenceVersion: evidence?.version ?? null,
      paymentDate,
      method: evidence?.method ?? row.paymentMethod,
      referenceNumber: evidence
        ? evidence.referenceNumber
        : row.referenceNumber,
      receiptId: row.receiptId == null ? null : Number(row.receiptId),
      createdBy: Number(row.createdBy),
      createdByName: row.createdByName,
      occurredAt: row.occurredAt,
    };
  });
}
