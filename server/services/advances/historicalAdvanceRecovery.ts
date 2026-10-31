import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  auditLogs,
  doubleEntrySettings,
  employeeAdvanceHistoricalRecoveries,
  employeeAdvances,
  employees,
  type EmployeeAdvance,
  type EmployeeAdvanceHistoricalRecovery,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractAffectedRows, extractInsertId } from "../../lib/insertId";
import { logAuditTx } from "../auditService";
import { resolveApprovalActor } from "../approval/ownerGate";
import { baghdadToday } from "../businessDay";
import { money, sumMoney, toDbMoney } from "../money";
import { assertFinancialWriterGateHeld, withTx, type Actor } from "../tx";

const APPLY_ACTION = "employeeAdvance.historicalRecovery.apply";
const REVERSE_ACTION = "employeeAdvance.historicalRecovery.reverse";
const AUDIT_ENTITY = "employeeAdvanceHistoricalRecoveryBatch";
const BAGHDAD_OFFSET_MS = 3 * 60 * 60 * 1000;
const HASH_RE = /^[a-f0-9]{64}$/;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const BATCH_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,39}$/;

type FailureCode =
  | "BAD_REQUEST"
  | "FORBIDDEN"
  | "CONFLICT"
  | "PRECONDITION_FAILED";

function fail(message: string, code: FailureCode = "CONFLICT"): never {
  throw new TRPCError({ code, message });
}

export interface HistoricalAdvanceExpectedPreimage {
  employeeId: number;
  branchId: number;
  amount: string;
  remaining: string;
  receiptId: number | null;
  grantedAt: string;
}

export interface HistoricalAdvanceRecoveryApplyRow {
  advanceId: number;
  amount: string;
  expected: HistoricalAdvanceExpectedPreimage;
}

export interface HistoricalAdvanceRecoveryApplyPlanBase {
  batchKey: string;
  evidenceKind: "OWNER_ATTESTATION";
  evidenceReference: string;
  evidenceHash: string;
  /** Must equal the current Baghdad YYYY-MM. Only rows granted before it are eligible. */
  priorToPeriod: string;
  totalAmount: string;
  /** Explicit, strictly ascending by advanceId, and duplicate-free. */
  rows: HistoricalAdvanceRecoveryApplyRow[];
}

export interface HistoricalAdvanceRecoveryApplyPlan extends HistoricalAdvanceRecoveryApplyPlanBase {
  sourceHash: string;
}

export interface HistoricalAdvanceRecoveryReverseRow {
  recoveryId: number;
  advanceId: number;
  employeeId: number;
  branchId: number;
  amount: string;
  applySourceHash: string;
}

export interface HistoricalAdvanceRecoveryReversePlanBase {
  batchKey: string;
  reason: string;
  totalAmount: string;
  /** Explicit, strictly ascending by advanceId, and duplicate-free. */
  rows: HistoricalAdvanceRecoveryReverseRow[];
}

export interface HistoricalAdvanceRecoveryReversePlan extends HistoricalAdvanceRecoveryReversePlanBase {
  sourceHash: string;
}

export interface HistoricalAdvanceRecoveryResult {
  mode: "APPLIED" | "REPLAY_VERIFIED";
  batchKey: string;
  sourceHash: string;
  totalAmount: string;
  recoveryIds: number[];
}

type NormalizedApplyPlan = HistoricalAdvanceRecoveryApplyPlan;
type NormalizedReversePlan = HistoricalAdvanceRecoveryReversePlan;

function inputObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} غير صالح`, "BAD_REQUEST");
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const expected = new Set(keys);
  if (
    Object.keys(value).length !== expected.size ||
    Object.keys(value).some((key) => !expected.has(key))
  ) {
    fail(`${label} يحتوي حقولاً ناقصة أو غير معروفة`, "BAD_REQUEST");
  }
}

function inputString(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`${label} غير صالح`, "BAD_REQUEST");
  return value;
}

function inputNumber(value: unknown, label: string): number {
  if (typeof value !== "number") fail(`${label} غير صالح`, "BAD_REQUEST");
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} غير صالح`, "BAD_REQUEST");
  }
  return value;
}

function exactMoney(value: string, label: string, allowZero = false): string {
  const parsed = money(value);
  if (
    parsed.decimalPlaces() > 2 ||
    parsed.isNegative() ||
    parsed.gte("10000000000000") ||
    (!allowZero && parsed.isZero())
  ) {
    fail(`${label} غير صالح`, "BAD_REQUEST");
  }
  return toDbMoney(parsed);
}

function exactHash(value: string, label: string): string {
  if (typeof value !== "string" || !HASH_RE.test(value)) {
    fail(`${label} غير صالح`, "BAD_REQUEST");
  }
  return value;
}

function exactBatchKey(value: string): string {
  if (typeof value !== "string" || !BATCH_KEY_RE.test(value)) {
    fail("مفتاح دفعة التسوية التاريخية غير صالح", "BAD_REQUEST");
  }
  return value;
}

function exactReference(value: string, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    normalized.length < 1 ||
    normalized.length > 500 ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    fail(`${label} غير صالح`, "BAD_REQUEST");
  }
  return normalized;
}

function exactIso(value: string, label: string): string {
  if (typeof value !== "string") fail(`${label} غير صالح`, "BAD_REQUEST");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()))
    fail(`${label} غير صالح`, "BAD_REQUEST");
  return parsed.toISOString();
}

function dbIso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) fail("تاريخ السلفة المخزن غير صالح");
  return parsed.toISOString();
}

function baghdadPeriod(instantIso: string): string {
  return new Date(new Date(instantIso).getTime() + BAGHDAD_OFFSET_MS)
    .toISOString()
    .slice(0, 7);
}

function normalizeApplyBase(
  input: HistoricalAdvanceRecoveryApplyPlanBase,
): HistoricalAdvanceRecoveryApplyPlanBase {
  const batchKey = exactBatchKey(input.batchKey);
  if (input.evidenceKind !== "OWNER_ATTESTATION") {
    fail("نوع دليل التسوية التاريخية غير مدعوم", "BAD_REQUEST");
  }
  const evidenceReference = exactReference(
    input.evidenceReference,
    "مرجع إقرار المالك",
  );
  const evidenceHash = exactHash(input.evidenceHash, "بصمة إقرار المالك");
  if (!PERIOD_RE.test(input.priorToPeriod)) {
    fail("حد فترة التسوية التاريخية غير صالح", "BAD_REQUEST");
  }
  if (
    !Array.isArray(input.rows) ||
    input.rows.length < 1 ||
    input.rows.length > 100
  ) {
    fail("صفوف التسوية التاريخية غير صالحة", "BAD_REQUEST");
  }

  let priorId = 0;
  const rows = input.rows.map((row, index) => {
    const advanceId = positiveInteger(
      row.advanceId,
      `معرف السلفة في الصف ${index + 1}`,
    );
    if (advanceId <= priorId) {
      fail("يجب ترتيب السلف تصاعدياً ومنع التكرار", "BAD_REQUEST");
    }
    priorId = advanceId;
    const amount = exactMoney(row.amount, `مبلغ التسوية للسلفة ${advanceId}`);
    const employeeId = positiveInteger(
      row.expected.employeeId,
      "معرف الموظف المتوقع",
    );
    const branchId = positiveInteger(
      row.expected.branchId,
      "معرف الفرع المتوقع",
    );
    const expectedAmount = exactMoney(
      row.expected.amount,
      "أصل السلفة المتوقع",
    );
    const expectedRemaining = exactMoney(
      row.expected.remaining,
      "رصيد السلفة المتوقع",
      true,
    );
    if (
      !money(amount).eq(expectedRemaining) ||
      money(expectedRemaining).gt(expectedAmount)
    ) {
      fail(
        "مبلغ التسوية يجب أن يساوي كامل الرصيد المتوقع دون زيادة",
        "BAD_REQUEST",
      );
    }
    const receiptId =
      row.expected.receiptId === null
        ? null
        : positiveInteger(row.expected.receiptId, "معرف السند المتوقع");
    const grantedAt = exactIso(
      row.expected.grantedAt,
      "تاريخ منح السلفة المتوقع",
    );
    if (baghdadPeriod(grantedAt) >= input.priorToPeriod) {
      fail(
        "لا يجوز إدخال سلفة الشهر الحالي في التسوية التاريخية",
        "PRECONDITION_FAILED",
      );
    }
    return {
      advanceId,
      amount,
      expected: {
        employeeId,
        branchId,
        amount: expectedAmount,
        remaining: expectedRemaining,
        receiptId,
        grantedAt,
      },
    };
  });
  const totalAmount = exactMoney(input.totalAmount, "إجمالي التسوية");
  if (!sumMoney(rows.map((row) => row.amount)).eq(totalAmount)) {
    fail("إجمالي التسوية لا يطابق مجموع الصفوف", "BAD_REQUEST");
  }
  return {
    batchKey,
    evidenceKind: "OWNER_ATTESTATION",
    evidenceReference,
    evidenceHash,
    priorToPeriod: input.priorToPeriod,
    totalAmount,
    rows,
  };
}

function canonicalApply(base: HistoricalAdvanceRecoveryApplyPlanBase): string {
  return JSON.stringify({
    version: "employee-advance-historical-recovery.apply.v1",
    batchKey: base.batchKey,
    evidenceKind: base.evidenceKind,
    evidenceReference: base.evidenceReference,
    evidenceHash: base.evidenceHash,
    priorToPeriod: base.priorToPeriod,
    totalAmount: base.totalAmount,
    rows: base.rows.map((row) => ({
      advanceId: row.advanceId,
      amount: row.amount,
      expected: {
        employeeId: row.expected.employeeId,
        branchId: row.expected.branchId,
        amount: row.expected.amount,
        remaining: row.expected.remaining,
        receiptId: row.expected.receiptId,
        grantedAt: row.expected.grantedAt,
      },
    })),
  });
}

export function historicalAdvanceRecoveryApplySourceHash(
  plan: HistoricalAdvanceRecoveryApplyPlanBase,
): string {
  return sha256(canonicalApply(normalizeApplyBase(plan)));
}

function normalizeApplyPlan(
  input: HistoricalAdvanceRecoveryApplyPlan,
): NormalizedApplyPlan {
  const { sourceHash, ...baseInput } = input;
  const base = normalizeApplyBase(baseInput);
  const expectedHash = sha256(canonicalApply(base));
  if (exactHash(sourceHash, "بصمة خطة التسوية") !== expectedHash) {
    fail("بصمة خطة التسوية لا تطابق حمولتها canonical", "BAD_REQUEST");
  }
  return { ...base, sourceHash };
}

/** Strict JSON boundary for CLI/internal callers; rejects missing and unknown fields. */
export function parseHistoricalAdvanceRecoveryApplyPlan(
  input: unknown,
): HistoricalAdvanceRecoveryApplyPlan {
  const value = inputObject(input, "خطة التسوية التاريخية");
  assertExactKeys(
    value,
    [
      "batchKey",
      "evidenceKind",
      "evidenceReference",
      "evidenceHash",
      "priorToPeriod",
      "totalAmount",
      "rows",
      "sourceHash",
    ],
    "خطة التسوية التاريخية",
  );
  if (!Array.isArray(value.rows))
    fail("صفوف التسوية التاريخية غير صالحة", "BAD_REQUEST");
  const rows = value.rows.map((rawRow, index) => {
    const row = inputObject(rawRow, `صف التسوية ${index + 1}`);
    assertExactKeys(
      row,
      ["advanceId", "amount", "expected"],
      `صف التسوية ${index + 1}`,
    );
    const expected = inputObject(
      row.expected,
      `الصورة المتوقعة للصف ${index + 1}`,
    );
    assertExactKeys(
      expected,
      [
        "employeeId",
        "branchId",
        "amount",
        "remaining",
        "receiptId",
        "grantedAt",
      ],
      `الصورة المتوقعة للصف ${index + 1}`,
    );
    if (expected.receiptId !== null && typeof expected.receiptId !== "number") {
      fail("معرف السند المتوقع غير صالح", "BAD_REQUEST");
    }
    return {
      advanceId: inputNumber(row.advanceId, "معرف السلفة"),
      amount: inputString(row.amount, "مبلغ التسوية"),
      expected: {
        employeeId: inputNumber(expected.employeeId, "معرف الموظف المتوقع"),
        branchId: inputNumber(expected.branchId, "معرف الفرع المتوقع"),
        amount: inputString(expected.amount, "أصل السلفة المتوقع"),
        remaining: inputString(expected.remaining, "رصيد السلفة المتوقع"),
        receiptId: expected.receiptId,
        grantedAt: inputString(expected.grantedAt, "تاريخ منح السلفة المتوقع"),
      },
    };
  });
  const parsed: HistoricalAdvanceRecoveryApplyPlan = {
    batchKey: inputString(value.batchKey, "مفتاح الدفعة"),
    evidenceKind: inputString(
      value.evidenceKind,
      "نوع الدليل",
    ) as "OWNER_ATTESTATION",
    evidenceReference: inputString(value.evidenceReference, "مرجع الدليل"),
    evidenceHash: inputString(value.evidenceHash, "بصمة الدليل"),
    priorToPeriod: inputString(value.priorToPeriod, "حد الفترة"),
    totalAmount: inputString(value.totalAmount, "الإجمالي"),
    rows,
    sourceHash: inputString(value.sourceHash, "بصمة الخطة"),
  };
  return normalizeApplyPlan(parsed);
}

function normalizeReverseBase(
  input: HistoricalAdvanceRecoveryReversePlanBase,
): HistoricalAdvanceRecoveryReversePlanBase {
  const batchKey = exactBatchKey(input.batchKey);
  const reason = exactReference(input.reason, "سبب عكس التسوية التاريخية");
  if (reason.length < 5) fail("سبب عكس التسوية التاريخية قصير", "BAD_REQUEST");
  if (
    !Array.isArray(input.rows) ||
    input.rows.length < 1 ||
    input.rows.length > 100
  ) {
    fail("صفوف عكس التسوية التاريخية غير صالحة", "BAD_REQUEST");
  }
  let priorAdvanceId = 0;
  const seenRecoveries = new Set<number>();
  const rows = input.rows.map((row, index) => {
    const recoveryId = positiveInteger(
      row.recoveryId,
      `معرف الاسترداد في الصف ${index + 1}`,
    );
    const advanceId = positiveInteger(
      row.advanceId,
      `معرف السلفة في الصف ${index + 1}`,
    );
    if (advanceId <= priorAdvanceId || seenRecoveries.has(recoveryId)) {
      fail("يجب ترتيب صفوف العكس حسب السلفة ومنع التكرار", "BAD_REQUEST");
    }
    priorAdvanceId = advanceId;
    seenRecoveries.add(recoveryId);
    return {
      recoveryId,
      advanceId,
      employeeId: positiveInteger(row.employeeId, "معرف موظف العكس"),
      branchId: positiveInteger(row.branchId, "معرف فرع العكس"),
      amount: exactMoney(row.amount, `مبلغ العكس للسلفة ${advanceId}`),
      applySourceHash: exactHash(row.applySourceHash, "بصمة التطبيق الأصلي"),
    };
  });
  const totalAmount = exactMoney(input.totalAmount, "إجمالي العكس");
  if (!sumMoney(rows.map((row) => row.amount)).eq(totalAmount)) {
    fail("إجمالي العكس لا يطابق مجموع الصفوف", "BAD_REQUEST");
  }
  return { batchKey, reason, totalAmount, rows };
}

function canonicalReverse(
  base: HistoricalAdvanceRecoveryReversePlanBase,
): string {
  return JSON.stringify({
    version: "employee-advance-historical-recovery.reverse.v1",
    batchKey: base.batchKey,
    reason: base.reason,
    totalAmount: base.totalAmount,
    rows: base.rows.map((row) => ({
      recoveryId: row.recoveryId,
      advanceId: row.advanceId,
      employeeId: row.employeeId,
      branchId: row.branchId,
      amount: row.amount,
      applySourceHash: row.applySourceHash,
    })),
  });
}

export function historicalAdvanceRecoveryReverseSourceHash(
  plan: HistoricalAdvanceRecoveryReversePlanBase,
): string {
  return sha256(canonicalReverse(normalizeReverseBase(plan)));
}

function normalizeReversePlan(
  input: HistoricalAdvanceRecoveryReversePlan,
): NormalizedReversePlan {
  const { sourceHash, ...baseInput } = input;
  const base = normalizeReverseBase(baseInput);
  const expectedHash = sha256(canonicalReverse(base));
  if (exactHash(sourceHash, "بصمة خطة العكس") !== expectedHash) {
    fail("بصمة خطة العكس لا تطابق حمولتها canonical", "BAD_REQUEST");
  }
  return { ...base, sourceHash };
}

function sourceKey(
  direction: "APPLY" | "REVERSE",
  batchKey: string,
  id: number,
  index: number,
): string {
  const head = `ADVHIST:${direction}:${batchKey}`;
  return index === 0 ? head : `${head}:${id}`;
}

function sameReceipt(actual: number | null, expected: number | null): boolean {
  return actual === null ? expected === null : Number(actual) === expected;
}

function sameAdvanceIdentity(
  actual: EmployeeAdvance,
  expected: HistoricalAdvanceRecoveryApplyRow,
): boolean {
  return (
    Number(actual.id) === expected.advanceId &&
    Number(actual.employeeId) === expected.expected.employeeId &&
    Number(actual.branchId) === expected.expected.branchId &&
    money(actual.amount).eq(expected.expected.amount) &&
    sameReceipt(
      actual.receiptId === null ? null : Number(actual.receiptId),
      expected.expected.receiptId,
    ) &&
    dbIso(actual.grantedAt) === expected.expected.grantedAt &&
    actual.sourceType === "LEGACY_UNCLASSIFIED" &&
    actual.payrollPeriod === null
  );
}

function matchesApplyBefore(
  actual: EmployeeAdvance,
  expected: HistoricalAdvanceRecoveryApplyRow,
): boolean {
  return (
    sameAdvanceIdentity(actual, expected) &&
    actual.status === "ACTIVE" &&
    money(actual.remaining).eq(expected.expected.remaining)
  );
}

function matchesApplyAfter(
  actual: EmployeeAdvance,
  expected: HistoricalAdvanceRecoveryApplyRow,
): boolean {
  return (
    sameAdvanceIdentity(actual, expected) &&
    actual.status === "SETTLED" &&
    money(actual.remaining).isZero()
  );
}

function matchesApplyLedger(
  actual: EmployeeAdvanceHistoricalRecovery,
  expected: HistoricalAdvanceRecoveryApplyRow,
  plan: NormalizedApplyPlan,
  index: number,
): boolean {
  return (
    Number(actual.advanceId) === expected.advanceId &&
    Number(actual.employeeId) === expected.expected.employeeId &&
    Number(actual.branchId) === expected.expected.branchId &&
    money(actual.amount).eq(expected.amount) &&
    actual.direction === "APPLY" &&
    actual.reversalOfId === null &&
    actual.sourceKey ===
      sourceKey("APPLY", plan.batchKey, expected.advanceId, index) &&
    actual.sourceHash === plan.sourceHash &&
    actual.evidenceKind === "OWNER_ATTESTATION" &&
    actual.evidenceReference === plan.evidenceReference &&
    actual.evidenceHash === plan.evidenceHash &&
    actual.priorToPeriod === plan.priorToPeriod
  );
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== "object") return value;
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = stable((value as Record<string, unknown>)[key]);
        return result;
      }, {});
  };
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function businessBranchId(rows: Array<{ branchId: number }>): number | null {
  const branchIds = Array.from(new Set(rows.map((row) => row.branchId)));
  return branchIds.length === 1 ? branchIds[0] : null;
}

function expectedApplyAudit(plan: NormalizedApplyPlan, recoveryIds: number[]) {
  return {
    version: "employee-advance-historical-recovery.apply.v1",
    batchKey: plan.batchKey,
    sourceHash: plan.sourceHash,
    evidenceKind: plan.evidenceKind,
    evidenceReference: plan.evidenceReference,
    evidenceHash: plan.evidenceHash,
    priorToPeriod: plan.priorToPeriod,
    totalAmount: plan.totalAmount,
    advanceIds: plan.rows.map((row) => row.advanceId),
    businessBranchId: businessBranchId(
      plan.rows.map((row) => ({ branchId: row.expected.branchId })),
    ),
    recoveryIds,
    effects: {
      payroll: "NONE",
      cash: "NONE",
      receipt: "NONE",
      generalLedger: "NONE",
    },
  };
}

async function lockAdvancesTx(
  tx: Tx,
  advanceIds: number[],
): Promise<EmployeeAdvance[]> {
  const rows = await tx
    .select()
    .from(employeeAdvances)
    .where(inArray(employeeAdvances.id, advanceIds))
    .orderBy(asc(employeeAdvances.id))
    .for("update");
  if (
    rows.length !== advanceIds.length ||
    rows.some((row, index) => Number(row.id) !== advanceIds[index])
  ) {
    fail("تعذر قفل جميع السلف التاريخية المطلوبة");
  }
  return rows;
}

async function lockEmployeesTx(
  tx: Tx,
  expectedEmployeeIds: number[],
): Promise<void> {
  const employeeIds = Array.from(new Set(expectedEmployeeIds)).sort(
    (left, right) => left - right,
  );
  const rows = await tx
    .select({ id: employees.id })
    .from(employees)
    .where(inArray(employees.id, employeeIds))
    .orderBy(asc(employees.id))
    .for("share");
  if (
    rows.length !== employeeIds.length ||
    rows.some((row, index) => Number(row.id) !== employeeIds[index])
  ) {
    fail("تعذر قفل جميع الموظفين المرتبطين بخطة التسوية");
  }
}

async function lockRecoveryHistoryTx(
  tx: Tx,
  advanceIds: number[],
): Promise<EmployeeAdvanceHistoricalRecovery[]> {
  return tx
    .select()
    .from(employeeAdvanceHistoricalRecoveries)
    .where(inArray(employeeAdvanceHistoricalRecoveries.advanceId, advanceIds))
    .orderBy(
      asc(employeeAdvanceHistoricalRecoveries.advanceId),
      asc(employeeAdvanceHistoricalRecoveries.direction),
      asc(employeeAdvanceHistoricalRecoveries.id),
    )
    .for("update");
}

async function lockBatchAuditTx(tx: Tx, action: string, batchKey: string) {
  return tx
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, action), eq(auditLogs.entityId, batchKey)))
    .orderBy(asc(auditLogs.id))
    .for("update");
}

async function assertLiveOwnerTx(tx: Tx, actor: Actor): Promise<Actor> {
  const resolved = await resolveApprovalActor(tx, actor, { current: true });
  if (!resolved.isOwner) {
    fail("التسوية التاريخية محصورة بمالك نشط مثبت داخل المعاملة", "FORBIDDEN");
  }
  return resolved;
}

function isNowaitConflict(error: unknown): boolean {
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 5 && current && typeof current === "object";
    depth += 1
  ) {
    const record = current as {
      code?: unknown;
      errno?: unknown;
      cause?: unknown;
    };
    if (
      record.code === "ER_LOCK_NOWAIT" ||
      record.code === "ER_LOCK_WAIT_TIMEOUT" ||
      record.errno === 3572 ||
      record.errno === 1205
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

/**
 * This reconciliation intentionally changes only the legacy materialized debt.
 * It is valid only before a double-entry opening exists. The shared NOWAIT lock
 * stays held until commit, so OFF cannot transition concurrently with the write.
 */
async function assertNonPostingModeTx(tx: Tx): Promise<void> {
  let rows: Array<{ mode: "OFF" | "SHADOW" | "ACTIVE" }>;
  try {
    rows = await tx
      .select({ mode: doubleEntrySettings.mode })
      .from(doubleEntrySettings)
      .where(eq(doubleEntrySettings.id, 1))
      .for("share", { noWait: true })
      .limit(1);
  } catch (error) {
    if (!isNowaitConflict(error)) throw error;
    fail(
      "يتغير وضع الدفتر المزدوج الآن؛ أعد المحاولة بعد اكتمال التحويل",
      "CONFLICT",
    );
  }
  if (rows.length !== 1 || rows[0].mode !== "OFF") {
    fail(
      "التسوية التاريخية غير الناشرة متاحة فقط عند وجود إعداد دفتر مزدوج صريح بوضع OFF",
      "PRECONDITION_FAILED",
    );
  }
}

export async function applyHistoricalAdvanceRecoveriesTx(
  tx: Tx,
  actor: Actor,
  rawPlan: HistoricalAdvanceRecoveryApplyPlan,
): Promise<HistoricalAdvanceRecoveryResult> {
  assertFinancialWriterGateHeld(tx);
  const currentActor = await assertLiveOwnerTx(tx, actor);
  await assertNonPostingModeTx(tx);
  const plan = parseHistoricalAdvanceRecoveryApplyPlan(rawPlan);
  await lockEmployeesTx(
    tx,
    plan.rows.map((row) => row.expected.employeeId),
  );
  const auditBranchId = businessBranchId(
    plan.rows.map((row) => ({ branchId: row.expected.branchId })),
  );
  const advanceIds = plan.rows.map((row) => row.advanceId);
  const advances = await lockAdvancesTx(tx, advanceIds);
  const history = await lockRecoveryHistoryTx(tx, advanceIds);
  const markerKey = sourceKey("APPLY", plan.batchKey, advanceIds[0], 0);
  const markerRows = await tx
    .select()
    .from(employeeAdvanceHistoricalRecoveries)
    .where(eq(employeeAdvanceHistoricalRecoveries.sourceKey, markerKey))
    .for("update")
    .limit(1);
  if (markerRows[0] && markerRows[0].sourceHash !== plan.sourceHash) {
    fail("مفتاح دفعة التطبيق مستعمل لخطة مختلفة");
  }
  const audits = await lockBatchAuditTx(tx, APPLY_ACTION, plan.batchKey);
  const orderedApplyRows = history.filter((row) => row.direction === "APPLY");
  const orderedRecoveryIds = orderedApplyRows.map((row) => Number(row.id));
  const replayLedger =
    history.length === plan.rows.length &&
    orderedApplyRows.length === plan.rows.length &&
    orderedApplyRows.every((row, index) =>
      matchesApplyLedger(row, plan.rows[index], plan, index),
    );
  const replayAudit =
    audits.length === 1 &&
    sameJson(
      jsonObject(audits[0].newValue),
      expectedApplyAudit(plan, orderedRecoveryIds),
    ) &&
    (audits[0].branchId === null
      ? auditBranchId === null
      : Number(audits[0].branchId) === auditBranchId) &&
    orderedApplyRows.every(
      (row) => Number(row.createdBy) === Number(audits[0].userId),
    );
  const replayState = advances.every((row, index) =>
    matchesApplyAfter(row, plan.rows[index]),
  );
  if (replayLedger && replayAudit && replayState) {
    return {
      mode: "REPLAY_VERIFIED",
      batchKey: plan.batchKey,
      sourceHash: plan.sourceHash,
      totalAmount: plan.totalAmount,
      recoveryIds: orderedRecoveryIds,
    };
  }

  if (plan.priorToPeriod !== baghdadToday().slice(0, 7)) {
    fail("حد التسوية يجب أن يساوي شهر بغداد الحالي", "PRECONDITION_FAILED");
  }

  const pristine =
    history.length === 0 &&
    audits.length === 0 &&
    advances.every((row, index) => matchesApplyBefore(row, plan.rows[index]));
  if (!pristine) {
    fail("حالة السلف أو سجل التسوية أو التدقيق مختلطة؛ رُفض التطبيق دون تخمين");
  }

  const recoveryIds: number[] = [];
  for (let index = 0; index < plan.rows.length; index += 1) {
    const row = plan.rows[index];
    const insertResult = await tx
      .insert(employeeAdvanceHistoricalRecoveries)
      .values({
        advanceId: row.advanceId,
        employeeId: row.expected.employeeId,
        branchId: row.expected.branchId,
        amount: row.amount,
        direction: "APPLY",
        reversalOfId: null,
        sourceKey: sourceKey("APPLY", plan.batchKey, row.advanceId, index),
        sourceHash: plan.sourceHash,
        evidenceKind: plan.evidenceKind,
        evidenceReference: plan.evidenceReference,
        evidenceHash: plan.evidenceHash,
        priorToPeriod: plan.priorToPeriod,
        createdBy: currentActor.userId,
      });
    recoveryIds.push(extractInsertId(insertResult));

    const receiptPredicate =
      row.expected.receiptId === null
        ? isNull(employeeAdvances.receiptId)
        : eq(employeeAdvances.receiptId, row.expected.receiptId);
    const updateResult = await tx
      .update(employeeAdvances)
      .set({ remaining: "0.00", status: "SETTLED" })
      .where(
        and(
          eq(employeeAdvances.id, row.advanceId),
          eq(employeeAdvances.employeeId, row.expected.employeeId),
          eq(employeeAdvances.branchId, row.expected.branchId),
          eq(employeeAdvances.amount, row.expected.amount),
          eq(employeeAdvances.remaining, row.expected.remaining),
          eq(employeeAdvances.status, "ACTIVE"),
          eq(employeeAdvances.sourceType, "LEGACY_UNCLASSIFIED"),
          isNull(employeeAdvances.payrollPeriod),
          receiptPredicate,
        ),
      );
    if (extractAffectedRows(updateResult) !== 1) {
      fail("تغيرت السلفة أثناء التطبيق؛ أُعيدت المعاملة كاملة");
    }
  }

  await logAuditTx(
    tx,
    { userId: currentActor.userId, branchId: auditBranchId },
    {
      action: APPLY_ACTION,
      entityType: AUDIT_ENTITY,
      entityId: plan.batchKey,
      newValue: expectedApplyAudit(plan, recoveryIds),
    },
  );
  return {
    mode: "APPLIED",
    batchKey: plan.batchKey,
    sourceHash: plan.sourceHash,
    totalAmount: plan.totalAmount,
    recoveryIds,
  };
}

function reverseEvidenceHash(reason: string): string {
  return sha256(
    JSON.stringify({
      version: "employee-advance-historical-recovery.reverse-attestation.v1",
      reason,
    }),
  );
}

function matchesOriginalApply(
  actual: EmployeeAdvanceHistoricalRecovery,
  expected: HistoricalAdvanceRecoveryReverseRow,
): boolean {
  return (
    Number(actual.id) === expected.recoveryId &&
    Number(actual.advanceId) === expected.advanceId &&
    Number(actual.employeeId) === expected.employeeId &&
    Number(actual.branchId) === expected.branchId &&
    actual.direction === "APPLY" &&
    actual.reversalOfId === null &&
    money(actual.amount).eq(expected.amount) &&
    actual.sourceHash === expected.applySourceHash &&
    actual.evidenceKind === "OWNER_ATTESTATION"
  );
}

function expectedReverseAudit(
  plan: NormalizedReversePlan,
  recoveryIds: number[],
) {
  return {
    version: "employee-advance-historical-recovery.reverse.v1",
    batchKey: plan.batchKey,
    sourceHash: plan.sourceHash,
    reason: plan.reason,
    totalAmount: plan.totalAmount,
    applyRecoveryIds: plan.rows.map((row) => row.recoveryId),
    advanceIds: plan.rows.map((row) => row.advanceId),
    businessBranchId: businessBranchId(plan.rows),
    recoveryIds,
    effects: {
      payroll: "NONE",
      cash: "NONE",
      receipt: "NONE",
      generalLedger: "NONE",
    },
  };
}

function matchesReverseLedger(
  actual: EmployeeAdvanceHistoricalRecovery,
  expected: HistoricalAdvanceRecoveryReverseRow,
  original: EmployeeAdvanceHistoricalRecovery,
  plan: NormalizedReversePlan,
  index: number,
): boolean {
  return (
    Number(actual.advanceId) === expected.advanceId &&
    Number(actual.employeeId) === Number(original.employeeId) &&
    Number(actual.branchId) === Number(original.branchId) &&
    money(actual.amount).eq(expected.amount) &&
    actual.direction === "REVERSE" &&
    Number(actual.reversalOfId) === expected.recoveryId &&
    actual.sourceKey ===
      sourceKey("REVERSE", plan.batchKey, expected.recoveryId, index) &&
    actual.sourceHash === plan.sourceHash &&
    actual.evidenceKind === "OWNER_ATTESTATION" &&
    actual.evidenceReference === plan.reason &&
    actual.evidenceHash === reverseEvidenceHash(plan.reason) &&
    actual.priorToPeriod === original.priorToPeriod
  );
}

export async function reverseHistoricalAdvanceRecoveriesTx(
  tx: Tx,
  actor: Actor,
  rawPlan: HistoricalAdvanceRecoveryReversePlan,
): Promise<HistoricalAdvanceRecoveryResult> {
  assertFinancialWriterGateHeld(tx);
  const currentActor = await assertLiveOwnerTx(tx, actor);
  await assertNonPostingModeTx(tx);
  const plan = normalizeReversePlan(rawPlan);
  await lockEmployeesTx(
    tx,
    plan.rows.map((row) => row.employeeId),
  );
  const auditBranchId = businessBranchId(plan.rows);
  const advanceIds = plan.rows.map((row) => row.advanceId);
  const advances = await lockAdvancesTx(tx, advanceIds);
  const history = await lockRecoveryHistoryTx(tx, advanceIds);
  const markerKey = sourceKey(
    "REVERSE",
    plan.batchKey,
    plan.rows[0].recoveryId,
    0,
  );
  const markerRows = await tx
    .select()
    .from(employeeAdvanceHistoricalRecoveries)
    .where(eq(employeeAdvanceHistoricalRecoveries.sourceKey, markerKey))
    .for("update")
    .limit(1);
  if (markerRows[0] && markerRows[0].sourceHash !== plan.sourceHash) {
    fail("مفتاح دفعة العكس مستعمل لخطة مختلفة");
  }
  const audits = await lockBatchAuditTx(tx, REVERSE_ACTION, plan.batchKey);
  const originals = plan.rows.map((expected) =>
    history.find((row) => Number(row.id) === expected.recoveryId),
  );
  if (
    originals.some((row) => !row) ||
    originals.some(
      (row, index) => !matchesOriginalApply(row!, plan.rows[index]),
    )
  ) {
    fail("تعذر إثبات صفوف التطبيق الأصلية المطابقة لخطة العكس");
  }
  const applyRows = originals as EmployeeAdvanceHistoricalRecovery[];
  const reverseRows = plan.rows.map((expected) =>
    history.find(
      (row) =>
        row.direction === "REVERSE" &&
        Number(row.reversalOfId) === expected.recoveryId,
    ),
  );
  const otherHistoryCount =
    history.length - applyRows.length - reverseRows.filter(Boolean).length;
  const replayRecoveryIds = reverseRows.map((row) =>
    row ? Number(row.id) : -1,
  );
  const replayLedger =
    otherHistoryCount === 0 &&
    reverseRows.every(Boolean) &&
    reverseRows.every((row, index) =>
      matchesReverseLedger(
        row!,
        plan.rows[index],
        applyRows[index],
        plan,
        index,
      ),
    );
  const replayState = advances.every(
    (advance, index) =>
      Number(advance.employeeId) === Number(applyRows[index].employeeId) &&
      Number(advance.branchId) === Number(applyRows[index].branchId) &&
      advance.sourceType === "LEGACY_UNCLASSIFIED" &&
      advance.payrollPeriod === null &&
      advance.status === "ACTIVE" &&
      money(advance.remaining).eq(plan.rows[index].amount) &&
      money(advance.amount).gte(plan.rows[index].amount),
  );
  const replayAudit =
    audits.length === 1 &&
    sameJson(
      jsonObject(audits[0].newValue),
      expectedReverseAudit(plan, replayRecoveryIds),
    ) &&
    (audits[0].branchId === null
      ? auditBranchId === null
      : Number(audits[0].branchId) === auditBranchId) &&
    reverseRows.every(
      (row) => Number(row!.createdBy) === Number(audits[0].userId),
    );
  if (replayLedger && replayState && replayAudit) {
    return {
      mode: "REPLAY_VERIFIED",
      batchKey: plan.batchKey,
      sourceHash: plan.sourceHash,
      totalAmount: plan.totalAmount,
      recoveryIds: replayRecoveryIds,
    };
  }

  const pristine =
    otherHistoryCount === 0 &&
    reverseRows.every((row) => !row) &&
    audits.length === 0 &&
    advances.every(
      (advance, index) =>
        Number(advance.employeeId) === Number(applyRows[index].employeeId) &&
        Number(advance.branchId) === Number(applyRows[index].branchId) &&
        advance.sourceType === "LEGACY_UNCLASSIFIED" &&
        advance.payrollPeriod === null &&
        advance.status === "SETTLED" &&
        money(advance.remaining).isZero() &&
        money(advance.amount).gte(plan.rows[index].amount),
    );
  if (!pristine) {
    fail("حالة العكس أو سجل التسوية أو التدقيق مختلطة؛ رُفض العكس دون تخمين");
  }

  const recoveryIds: number[] = [];
  for (let index = 0; index < plan.rows.length; index += 1) {
    const row = plan.rows[index];
    const original = applyRows[index];
    const insertResult = await tx
      .insert(employeeAdvanceHistoricalRecoveries)
      .values({
        advanceId: row.advanceId,
        employeeId: Number(original.employeeId),
        branchId: Number(original.branchId),
        amount: row.amount,
        direction: "REVERSE",
        reversalOfId: row.recoveryId,
        sourceKey: sourceKey("REVERSE", plan.batchKey, row.recoveryId, index),
        sourceHash: plan.sourceHash,
        evidenceKind: "OWNER_ATTESTATION",
        evidenceReference: plan.reason,
        evidenceHash: reverseEvidenceHash(plan.reason),
        priorToPeriod: original.priorToPeriod,
        createdBy: currentActor.userId,
      });
    recoveryIds.push(extractInsertId(insertResult));
    const updateResult = await tx
      .update(employeeAdvances)
      .set({ remaining: row.amount, status: "ACTIVE" })
      .where(
        and(
          eq(employeeAdvances.id, row.advanceId),
          eq(employeeAdvances.employeeId, Number(original.employeeId)),
          eq(employeeAdvances.branchId, Number(original.branchId)),
          eq(employeeAdvances.remaining, "0.00"),
          eq(employeeAdvances.status, "SETTLED"),
          eq(employeeAdvances.sourceType, "LEGACY_UNCLASSIFIED"),
          isNull(employeeAdvances.payrollPeriod),
        ),
      );
    if (extractAffectedRows(updateResult) !== 1) {
      fail("تغيرت السلفة أثناء العكس؛ أُعيدت المعاملة كاملة");
    }
  }

  await logAuditTx(
    tx,
    { userId: currentActor.userId, branchId: auditBranchId },
    {
      action: REVERSE_ACTION,
      entityType: AUDIT_ENTITY,
      entityId: plan.batchKey,
      newValue: expectedReverseAudit(plan, recoveryIds),
    },
  );
  return {
    mode: "APPLIED",
    batchKey: plan.batchKey,
    sourceHash: plan.sourceHash,
    totalAmount: plan.totalAmount,
    recoveryIds,
  };
}

function isDuplicateKey(error: unknown): boolean {
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 5 && current && typeof current === "object";
    depth += 1
  ) {
    const record = current as {
      code?: unknown;
      errno?: unknown;
      cause?: unknown;
    };
    if (record.code === "ER_DUP_ENTRY" || record.errno === 1062) return true;
    current = record.cause;
  }
  return false;
}

async function withDuplicateReplay<T>(
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  try {
    return await withTx(work, { gate: "GOVERNANCE" });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    // A concurrent writer may have won a unique source/reversal key. The first
    // transaction was rolled back, so a fresh transaction can only verify an
    // exact replay or reject the now-visible conflicting state.
    return withTx(work, { gate: "GOVERNANCE" });
  }
}

export function applyHistoricalAdvanceRecoveries(
  actor: Actor,
  plan: HistoricalAdvanceRecoveryApplyPlan,
): Promise<HistoricalAdvanceRecoveryResult> {
  return withDuplicateReplay((tx) =>
    applyHistoricalAdvanceRecoveriesTx(tx, actor, plan),
  );
}

export function reverseHistoricalAdvanceRecoveries(
  actor: Actor,
  plan: HistoricalAdvanceRecoveryReversePlan,
): Promise<HistoricalAdvanceRecoveryResult> {
  return withDuplicateReplay((tx) =>
    reverseHistoricalAdvanceRecoveriesTx(tx, actor, plan),
  );
}
