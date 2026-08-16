import { TRPCError } from "@trpc/server";

const PREFIX = "PAYROLL_TERMINATION_WAGE_COVERAGE_V1:";
const MONEY = /^\d+\.\d{2}$/;

export interface TerminationWageCoverageItem {
  terminationId: number;
  employeeId: number;
  settlementSnapshotHash: string;
  earnedGrossWages: string;
  payrollCommission: string;
}

interface TerminationWageCoverageSnapshot {
  version: 1;
  period: string;
  policy: "TERMINATION_EARNED_WAGES_AUTHORITATIVE";
  items: TerminationWageCoverageItem[];
}

export function encodeTerminationWageCoverage(
  period: string,
  items: TerminationWageCoverageItem[],
): string | null {
  if (items.length === 0) return null;
  const snapshot: TerminationWageCoverageSnapshot = {
    version: 1,
    period,
    // The approved termination earned-wage breakdown is the authoritative final-pay source.
    // Approved commission is recorded here and remains a separate zero-base payroll item.
    policy: "TERMINATION_EARNED_WAGES_AUTHORITATIVE",
    items: [...items].sort(
      (a, b) => a.employeeId - b.employeeId || a.terminationId - b.terminationId,
    ),
  };
  return `${PREFIX}${JSON.stringify(snapshot)}`;
}

export function decodeTerminationWageCoverage(
  notes: string | null,
  expectedPeriod: string,
): TerminationWageCoverageItem[] {
  if (notes == null || notes === "") return [];
  if (!notes.startsWith(PREFIX)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "ملاحظات مسيّر الرواتب لا تحمل صيغة تغطية أجور إنهاء خدمة معتمدة.",
    });
  }
  try {
    const value = JSON.parse(notes.slice(PREFIX.length)) as Partial<TerminationWageCoverageSnapshot>;
    if (
      value.version !== 1 ||
      value.period !== expectedPeriod ||
      value.policy !== "TERMINATION_EARNED_WAGES_AUTHORITATIVE" ||
      !Array.isArray(value.items)
    ) {
      throw new Error("invalid header");
    }
    const employeeIds = new Set<number>();
    const terminationIds = new Set<number>();
    const items = value.items.map((item) => {
      if (
        !item ||
        !Number.isInteger(item.employeeId) ||
        !Number.isInteger(item.terminationId) ||
        typeof item.settlementSnapshotHash !== "string" ||
        !/^[a-f0-9]{64}$/i.test(item.settlementSnapshotHash) ||
        typeof item.earnedGrossWages !== "string" ||
        !MONEY.test(item.earnedGrossWages) ||
        typeof item.payrollCommission !== "string" ||
        !MONEY.test(item.payrollCommission) ||
        employeeIds.has(item.employeeId) ||
        terminationIds.has(item.terminationId)
      ) {
        throw new Error("invalid item");
      }
      employeeIds.add(item.employeeId);
      terminationIds.add(item.terminationId);
      return item as TerminationWageCoverageItem;
    });
    return items;
  } catch {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "دليل تغطية أجور إنهاء الخدمة في المسيّر تالف؛ احذف المسودة وأعد توليدها.",
    });
  }
}
