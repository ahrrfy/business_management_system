import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";
import {
  advanceSettlements,
  auditLogs,
  doubleEntrySettings,
  employeeAdvanceHistoricalRecoveries,
  employeeAdvancePeriodClassifications,
  employeeAdvanceRepaymentAllocations,
  employeeAdvanceRepaymentRequests,
  employeeAdvances,
  employeeLoanRequests,
  employees,
  payrollRuns,
  receipts,
  terminationAdvanceAllocations,
  type EmployeeAdvance,
  type EmployeeAdvancePeriodClassification,
  type Receipt,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractAffectedRows, extractInsertId } from "../../lib/insertId";
import { logAuditTx } from "../auditService";
import { resolveApprovalActor } from "../approval/ownerGate";
import { baghdadToday } from "../businessDay";
import { money, sumMoney, toDbMoney } from "../money";
import { assertFinancialWriterGateHeld, withTx, type Actor } from "../tx";

const APPLY_ACTION = "employeeAdvance.periodClassification.apply";
const REVERSE_ACTION = "employeeAdvance.periodClassification.reverse";
const AUDIT_ENTITY = "employeeAdvancePeriodClassificationBatch";
const BAGHDAD_OFFSET_MS = 3 * 60 * 60 * 1000;
const HASH_RE = /^[a-f0-9]{64}$/;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;
const BATCH_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,39}$/;

type FailureCode =
  | "BAD_REQUEST"
  | "FORBIDDEN"
  | "CONFLICT"
  | "PRECONDITION_FAILED";

function fail(message: string, code: FailureCode = "CONFLICT"): never {
  throw new TRPCError({ code, message });
}

export interface AdvancePeriodClassificationExpectedPreimage {
  employeeId: number;
  branchId: number;
  amount: string;
  remaining: string;
  receiptId: number;
  voucherNumber: string;
  voucherDate: string;
  grantedAt: string;
}

export interface AdvancePeriodClassificationRow {
  advanceId: number;
  amount: string;
  expected: AdvancePeriodClassificationExpectedPreimage;
}

export interface AdvancePeriodClassificationPlanBase {
  batchKey: string;
  evidenceKind: "OWNER_ATTESTATION";
  evidenceReference: string;
  evidenceHash: string;
  /** Exact salary month; operational tool accepts only Baghdad's prior month. */
  payrollPeriod: string;
  totalAmount: string;
  /** Complete target-month scope, strictly ascending and duplicate-free. */
  rows: AdvancePeriodClassificationRow[];
}

export interface AdvancePeriodClassificationPlan extends AdvancePeriodClassificationPlanBase {
  sourceHash: string;
}

export interface AdvancePeriodClassificationResult {
  mode: "APPLIED" | "REPLAY_VERIFIED";
  batchKey: string;
  sourceHash: string;
  payrollPeriod: string;
  totalAmount: string;
  classificationIds: number[];
}

type NormalizedPlan = AdvancePeriodClassificationPlan;

export interface AdvancePeriodClassificationReverseRow {
  classificationId: number;
  advanceId: number;
  employeeId: number;
  branchId: number;
  amount: string;
  remaining: string;
  applySourceHash: string;
}

export interface AdvancePeriodClassificationReversePlanBase {
  batchKey: string;
  reason: string;
  payrollPeriod: string;
  totalAmount: string;
  /** Complete original apply batch, strictly ascending by advanceId. */
  rows: AdvancePeriodClassificationReverseRow[];
}

export interface AdvancePeriodClassificationReversePlan extends AdvancePeriodClassificationReversePlanBase {
  sourceHash: string;
}

type NormalizedReversePlan = AdvancePeriodClassificationReversePlan;

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

function exactMoney(value: string, label: string): string {
  const parsed = money(value);
  if (
    parsed.decimalPlaces() > 2 ||
    parsed.lte(0) ||
    parsed.gte("10000000000000")
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
    fail("مفتاح دفعة تصنيف السلف غير صالح", "BAD_REQUEST");
  }
  return value;
}

function exactReference(value: string, label: string, max = 500): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    normalized.length < 1 ||
    normalized.length > max ||
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

function exactDate(value: string, label: string): string {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    fail(`${label} غير صالح`, "BAD_REQUEST");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (parsed.toISOString().slice(0, 10) !== value) {
    fail(`${label} غير صالح`, "BAD_REQUEST");
  }
  return value;
}

function dbIso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) fail("تاريخ السلفة المخزن غير صالح");
  return parsed.toISOString();
}

function dbDate(value: Date | string | null): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function baghdadPeriod(instantIso: string): string {
  return new Date(new Date(instantIso).getTime() + BAGHDAD_OFFSET_MS)
    .toISOString()
    .slice(0, 7);
}

function priorPeriod(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7);
}

function periodBounds(period: string): { start: Date; end: Date } {
  const [year, month] = period.split("-").map(Number);
  return {
    start: new Date(Date.UTC(year, month - 1, 1) - BAGHDAD_OFFSET_MS),
    end: new Date(Date.UTC(year, month, 1) - BAGHDAD_OFFSET_MS),
  };
}

function normalizePlanBase(
  input: AdvancePeriodClassificationPlanBase,
): AdvancePeriodClassificationPlanBase {
  const batchKey = exactBatchKey(input.batchKey);
  if (input.evidenceKind !== "OWNER_ATTESTATION") {
    fail("نوع دليل تصنيف السلف غير مدعوم", "BAD_REQUEST");
  }
  const evidenceReference = exactReference(
    input.evidenceReference,
    "مرجع إقرار المالك",
  );
  const evidenceHash = exactHash(input.evidenceHash, "بصمة إقرار المالك");
  if (!PERIOD_RE.test(input.payrollPeriod)) {
    fail("شهر تصنيف السلف غير صالح", "BAD_REQUEST");
  }
  if (
    !Array.isArray(input.rows) ||
    input.rows.length < 1 ||
    input.rows.length > 100
  ) {
    fail("صفوف تصنيف السلف غير صالحة", "BAD_REQUEST");
  }

  let priorAdvanceId = 0;
  const seenReceipts = new Set<number>();
  const rows = input.rows.map((row, index) => {
    const advanceId = positiveInteger(
      row.advanceId,
      `معرف السلفة في الصف ${index + 1}`,
    );
    if (advanceId <= priorAdvanceId) {
      fail("يجب ترتيب السلف تصاعدياً ومنع التكرار", "BAD_REQUEST");
    }
    priorAdvanceId = advanceId;
    const amount = exactMoney(row.amount, `مبلغ التصنيف للسلفة ${advanceId}`);
    const expectedAmount = exactMoney(
      row.expected.amount,
      "أصل السلفة المتوقع",
    );
    const expectedRemaining = exactMoney(
      row.expected.remaining,
      "رصيد السلفة المتوقع",
    );
    if (
      !money(amount).eq(expectedRemaining) ||
      !money(expectedRemaining).eq(expectedAmount)
    ) {
      fail(
        "التصنيف يقبل فقط سلفة غير مستقطعة بكامل رصيدها الأصلي",
        "BAD_REQUEST",
      );
    }
    const receiptId = positiveInteger(
      row.expected.receiptId,
      "معرف سند صرف السلفة المتوقع",
    );
    if (seenReceipts.has(receiptId)) {
      fail("لا يجوز ربط أكثر من سلفة بسند صرف واحد", "BAD_REQUEST");
    }
    seenReceipts.add(receiptId);
    const voucherNumber = exactReference(
      row.expected.voucherNumber,
      "رقم سند صرف السلفة المتوقع",
      50,
    );
    const voucherDate = exactDate(
      row.expected.voucherDate,
      "تاريخ سند صرف السلفة المتوقع",
    );
    const grantedAt = exactIso(
      row.expected.grantedAt,
      "تاريخ منح السلفة المتوقع",
    );
    if (
      baghdadPeriod(grantedAt) !== input.payrollPeriod ||
      voucherDate.slice(0, 7) !== input.payrollPeriod
    ) {
      fail(
        "السلفة وسند صرفها لا ينتميان إلى شهر التصنيف",
        "PRECONDITION_FAILED",
      );
    }
    return {
      advanceId,
      amount,
      expected: {
        employeeId: positiveInteger(
          row.expected.employeeId,
          "معرف الموظف المتوقع",
        ),
        branchId: positiveInteger(row.expected.branchId, "معرف الفرع المتوقع"),
        amount: expectedAmount,
        remaining: expectedRemaining,
        receiptId,
        voucherNumber,
        voucherDate,
        grantedAt,
      },
    };
  });
  const totalAmount = exactMoney(input.totalAmount, "إجمالي التصنيف");
  if (!sumMoney(rows.map((row) => row.amount)).eq(totalAmount)) {
    fail("إجمالي التصنيف لا يطابق مجموع الصفوف", "BAD_REQUEST");
  }
  return {
    batchKey,
    evidenceKind: "OWNER_ATTESTATION",
    evidenceReference,
    evidenceHash,
    payrollPeriod: input.payrollPeriod,
    totalAmount,
    rows,
  };
}

function canonicalPlan(base: AdvancePeriodClassificationPlanBase): string {
  return JSON.stringify({
    version: "employee-advance-period-classification.apply.v1",
    batchKey: base.batchKey,
    evidenceKind: base.evidenceKind,
    evidenceReference: base.evidenceReference,
    evidenceHash: base.evidenceHash,
    payrollPeriod: base.payrollPeriod,
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
        voucherNumber: row.expected.voucherNumber,
        voucherDate: row.expected.voucherDate,
        grantedAt: row.expected.grantedAt,
      },
    })),
  });
}

export function advancePeriodClassificationSourceHash(
  plan: AdvancePeriodClassificationPlanBase,
): string {
  return sha256(canonicalPlan(normalizePlanBase(plan)));
}

function normalizePlan(input: AdvancePeriodClassificationPlan): NormalizedPlan {
  const { sourceHash, ...baseInput } = input;
  const base = normalizePlanBase(baseInput);
  const expectedHash = sha256(canonicalPlan(base));
  if (exactHash(sourceHash, "بصمة خطة التصنيف") !== expectedHash) {
    fail("بصمة خطة التصنيف لا تطابق حمولتها canonical", "BAD_REQUEST");
  }
  return { ...base, sourceHash };
}

export function parseAdvancePeriodClassificationPlan(
  input: unknown,
): AdvancePeriodClassificationPlan {
  const value = inputObject(input, "خطة تصنيف السلف");
  assertExactKeys(
    value,
    [
      "batchKey",
      "evidenceKind",
      "evidenceReference",
      "evidenceHash",
      "payrollPeriod",
      "totalAmount",
      "rows",
      "sourceHash",
    ],
    "خطة تصنيف السلف",
  );
  if (!Array.isArray(value.rows))
    fail("صفوف تصنيف السلف غير صالحة", "BAD_REQUEST");
  const rows = value.rows.map((rawRow, index) => {
    const row = inputObject(rawRow, `صف التصنيف ${index + 1}`);
    assertExactKeys(
      row,
      ["advanceId", "amount", "expected"],
      `صف التصنيف ${index + 1}`,
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
        "voucherNumber",
        "voucherDate",
        "grantedAt",
      ],
      `الصورة المتوقعة للصف ${index + 1}`,
    );
    return {
      advanceId: inputNumber(row.advanceId, "معرف السلفة"),
      amount: inputString(row.amount, "مبلغ التصنيف"),
      expected: {
        employeeId: inputNumber(expected.employeeId, "معرف الموظف المتوقع"),
        branchId: inputNumber(expected.branchId, "معرف الفرع المتوقع"),
        amount: inputString(expected.amount, "أصل السلفة المتوقع"),
        remaining: inputString(expected.remaining, "رصيد السلفة المتوقع"),
        receiptId: inputNumber(expected.receiptId, "معرف سند الصرف المتوقع"),
        voucherNumber: inputString(
          expected.voucherNumber,
          "رقم سند الصرف المتوقع",
        ),
        voucherDate: inputString(
          expected.voucherDate,
          "تاريخ سند الصرف المتوقع",
        ),
        grantedAt: inputString(expected.grantedAt, "تاريخ منح السلفة المتوقع"),
      },
    };
  });
  return normalizePlan({
    batchKey: inputString(value.batchKey, "مفتاح الدفعة"),
    evidenceKind: inputString(
      value.evidenceKind,
      "نوع الدليل",
    ) as "OWNER_ATTESTATION",
    evidenceReference: inputString(value.evidenceReference, "مرجع الدليل"),
    evidenceHash: inputString(value.evidenceHash, "بصمة الدليل"),
    payrollPeriod: inputString(value.payrollPeriod, "شهر الراتب"),
    totalAmount: inputString(value.totalAmount, "الإجمالي"),
    rows,
    sourceHash: inputString(value.sourceHash, "بصمة الخطة"),
  });
}

function normalizeReverseBase(
  input: AdvancePeriodClassificationReversePlanBase,
): AdvancePeriodClassificationReversePlanBase {
  const batchKey = exactBatchKey(input.batchKey);
  const reason = exactReference(input.reason, "سبب عكس تصنيف السلف");
  if (reason.length < 5) fail("سبب عكس تصنيف السلف قصير", "BAD_REQUEST");
  if (!PERIOD_RE.test(input.payrollPeriod)) {
    fail("شهر عكس التصنيف غير صالح", "BAD_REQUEST");
  }
  if (
    !Array.isArray(input.rows) ||
    input.rows.length < 1 ||
    input.rows.length > 100
  ) {
    fail("صفوف عكس تصنيف السلف غير صالحة", "BAD_REQUEST");
  }
  let priorAdvanceId = 0;
  const seenClassifications = new Set<number>();
  let batchApplySourceHash: string | null = null;
  const rows = input.rows.map((row, index) => {
    const classificationId = positiveInteger(
      row.classificationId,
      `معرف التصنيف في الصف ${index + 1}`,
    );
    const advanceId = positiveInteger(
      row.advanceId,
      `معرف السلفة في صف العكس ${index + 1}`,
    );
    if (
      advanceId <= priorAdvanceId ||
      seenClassifications.has(classificationId)
    ) {
      fail("يجب ترتيب صفوف العكس حسب السلفة ومنع التكرار", "BAD_REQUEST");
    }
    priorAdvanceId = advanceId;
    seenClassifications.add(classificationId);
    const amount = exactMoney(row.amount, `أصل السلفة ${advanceId}`);
    const remaining = exactMoney(row.remaining, `رصيد السلفة ${advanceId}`);
    if (!money(amount).eq(remaining)) {
      fail("عكس التصنيف يقبل رصيداً كاملاً غير مستقطع فقط", "BAD_REQUEST");
    }
    const applySourceHash = exactHash(
      row.applySourceHash,
      "بصمة التطبيق الأصلي",
    );
    if (
      batchApplySourceHash !== null &&
      applySourceHash !== batchApplySourceHash
    ) {
      fail("يجب أن تعكس الخطة دفعة تطبيق أصلية واحدة", "BAD_REQUEST");
    }
    batchApplySourceHash = applySourceHash;
    return {
      classificationId,
      advanceId,
      employeeId: positiveInteger(row.employeeId, "معرف موظف العكس"),
      branchId: positiveInteger(row.branchId, "معرف فرع العكس"),
      amount,
      remaining,
      applySourceHash,
    };
  });
  const totalAmount = exactMoney(input.totalAmount, "إجمالي عكس التصنيف");
  if (!sumMoney(rows.map((row) => row.remaining)).eq(totalAmount)) {
    fail("إجمالي عكس التصنيف لا يطابق مجموع الصفوف", "BAD_REQUEST");
  }
  return {
    batchKey,
    reason,
    payrollPeriod: input.payrollPeriod,
    totalAmount,
    rows,
  };
}

function canonicalReverse(
  base: AdvancePeriodClassificationReversePlanBase,
): string {
  return JSON.stringify({
    version: "employee-advance-period-classification.reverse.v1",
    batchKey: base.batchKey,
    reason: base.reason,
    payrollPeriod: base.payrollPeriod,
    totalAmount: base.totalAmount,
    rows: base.rows.map((row) => ({
      classificationId: row.classificationId,
      advanceId: row.advanceId,
      employeeId: row.employeeId,
      branchId: row.branchId,
      amount: row.amount,
      remaining: row.remaining,
      applySourceHash: row.applySourceHash,
    })),
  });
}

export function advancePeriodClassificationReverseSourceHash(
  plan: AdvancePeriodClassificationReversePlanBase,
): string {
  return sha256(canonicalReverse(normalizeReverseBase(plan)));
}

function normalizeReversePlan(
  input: AdvancePeriodClassificationReversePlan,
): NormalizedReversePlan {
  const { sourceHash, ...baseInput } = input;
  const base = normalizeReverseBase(baseInput);
  const expectedHash = sha256(canonicalReverse(base));
  if (exactHash(sourceHash, "بصمة خطة عكس التصنيف") !== expectedHash) {
    fail("بصمة خطة عكس التصنيف لا تطابق حمولتها canonical", "BAD_REQUEST");
  }
  return { ...base, sourceHash };
}

export function parseAdvancePeriodClassificationReversePlan(
  input: unknown,
): AdvancePeriodClassificationReversePlan {
  const value = inputObject(input, "خطة عكس تصنيف السلف");
  assertExactKeys(
    value,
    [
      "batchKey",
      "reason",
      "payrollPeriod",
      "totalAmount",
      "rows",
      "sourceHash",
    ],
    "خطة عكس تصنيف السلف",
  );
  if (!Array.isArray(value.rows)) {
    fail("صفوف عكس تصنيف السلف غير صالحة", "BAD_REQUEST");
  }
  const rows = value.rows.map((rawRow, index) => {
    const row = inputObject(rawRow, `صف عكس التصنيف ${index + 1}`);
    assertExactKeys(
      row,
      [
        "classificationId",
        "advanceId",
        "employeeId",
        "branchId",
        "amount",
        "remaining",
        "applySourceHash",
      ],
      `صف عكس التصنيف ${index + 1}`,
    );
    return {
      classificationId: inputNumber(row.classificationId, "معرف التصنيف"),
      advanceId: inputNumber(row.advanceId, "معرف السلفة"),
      employeeId: inputNumber(row.employeeId, "معرف الموظف"),
      branchId: inputNumber(row.branchId, "معرف الفرع"),
      amount: inputString(row.amount, "أصل السلفة"),
      remaining: inputString(row.remaining, "رصيد السلفة"),
      applySourceHash: inputString(row.applySourceHash, "بصمة التطبيق الأصلي"),
    };
  });
  return normalizeReversePlan({
    batchKey: inputString(value.batchKey, "مفتاح دفعة العكس"),
    reason: inputString(value.reason, "سبب العكس"),
    payrollPeriod: inputString(value.payrollPeriod, "شهر الراتب"),
    totalAmount: inputString(value.totalAmount, "إجمالي العكس"),
    rows,
    sourceHash: inputString(value.sourceHash, "بصمة خطة العكس"),
  });
}

function sourceKey(
  direction: "APPLY" | "REVERSE",
  batchKey: string,
  advanceId: number,
  index: number,
): string {
  const head = `ADVPERIOD:${direction}:${batchKey}`;
  return index === 0 ? head : `${head}:${advanceId}`;
}

function sameBaseIdentity(
  actual: EmployeeAdvance,
  expected: AdvancePeriodClassificationRow,
): boolean {
  return (
    Number(actual.id) === expected.advanceId &&
    Number(actual.employeeId) === expected.expected.employeeId &&
    Number(actual.branchId) === expected.expected.branchId &&
    money(actual.amount).eq(expected.expected.amount) &&
    money(actual.remaining).eq(expected.expected.remaining) &&
    actual.receiptId !== null &&
    Number(actual.receiptId) === expected.expected.receiptId &&
    dbIso(actual.grantedAt) === expected.expected.grantedAt &&
    actual.status === "ACTIVE"
  );
}

function matchesBefore(
  actual: EmployeeAdvance,
  expected: AdvancePeriodClassificationRow,
): boolean {
  return (
    sameBaseIdentity(actual, expected) &&
    actual.sourceType === "LEGACY_UNCLASSIFIED" &&
    actual.payrollPeriod === null
  );
}

function matchesAfter(
  actual: EmployeeAdvance,
  expected: AdvancePeriodClassificationRow,
  payrollPeriod: string,
): boolean {
  return (
    sameBaseIdentity(actual, expected) &&
    actual.sourceType === "SALARY_ADVANCE" &&
    actual.payrollPeriod === payrollPeriod
  );
}

function matchesReceipt(
  actual: Receipt,
  expected: AdvancePeriodClassificationRow,
  payrollPeriod: string,
): boolean {
  const voucherDate = dbDate(actual.voucherDate);
  return (
    Number(actual.id) === expected.expected.receiptId &&
    Number(actual.branchId) === expected.expected.branchId &&
    actual.direction === "OUT" &&
    money(actual.amount).eq(expected.expected.amount) &&
    actual.status === "COMPLETED" &&
    actual.approvalStatus === "APPROVED" &&
    actual.voucherNumber === expected.expected.voucherNumber &&
    voucherDate === expected.expected.voucherDate &&
    voucherDate?.slice(0, 7) === payrollPeriod
  );
}

function matchesLedger(
  actual: EmployeeAdvancePeriodClassification,
  expected: AdvancePeriodClassificationRow,
  plan: NormalizedPlan,
  index: number,
): boolean {
  return (
    Number(actual.advanceId) === expected.advanceId &&
    Number(actual.employeeId) === expected.expected.employeeId &&
    Number(actual.branchId) === expected.expected.branchId &&
    money(actual.amount).eq(expected.expected.amount) &&
    money(actual.remaining).eq(expected.expected.remaining) &&
    actual.direction === "APPLY" &&
    actual.reversalOfId === null &&
    actual.payrollPeriod === plan.payrollPeriod &&
    actual.sourceKey ===
      sourceKey("APPLY", plan.batchKey, expected.advanceId, index) &&
    actual.sourceHash === plan.sourceHash &&
    actual.evidenceKind === "OWNER_ATTESTATION" &&
    actual.evidenceReference === plan.evidenceReference &&
    actual.evidenceHash === plan.evidenceHash
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

function businessBranchId(
  rows: AdvancePeriodClassificationRow[],
): number | null {
  const branchIds = Array.from(
    new Set(rows.map((row) => row.expected.branchId)),
  );
  return branchIds.length === 1 ? branchIds[0] : null;
}

function expectedApplyAudit(plan: NormalizedPlan, classificationIds: number[]) {
  return {
    version: "employee-advance-period-classification.apply.v1",
    batchKey: plan.batchKey,
    sourceHash: plan.sourceHash,
    evidenceKind: plan.evidenceKind,
    evidenceReference: plan.evidenceReference,
    evidenceHash: plan.evidenceHash,
    payrollPeriod: plan.payrollPeriod,
    totalAmount: plan.totalAmount,
    advanceIds: plan.rows.map((row) => row.advanceId),
    receiptIds: plan.rows.map((row) => row.expected.receiptId),
    businessBranchId: businessBranchId(plan.rows),
    classificationIds,
    transition: {
      from: { sourceType: "LEGACY_UNCLASSIFIED", payrollPeriod: null },
      to: { sourceType: "SALARY_ADVANCE", payrollPeriod: plan.payrollPeriod },
    },
    effects: {
      balance: "UNCHANGED",
      payrollRun: "NONE",
      payrollDeduction: "NONE_UNTIL_NORMAL_PAYROLL_LIFECYCLE",
      cash: "NONE",
      receipt: "NONE",
      generalLedger: "NONE",
    },
  };
}

function reverseBusinessBranchId(
  rows: AdvancePeriodClassificationReverseRow[],
): number | null {
  const branchIds = Array.from(new Set(rows.map((row) => row.branchId)));
  return branchIds.length === 1 ? branchIds[0] : null;
}

function reverseEvidenceHash(reason: string): string {
  return sha256(
    JSON.stringify({
      version: "employee-advance-period-classification.reverse-attestation.v1",
      reason,
    }),
  );
}

function matchesOriginalApply(
  actual: EmployeeAdvancePeriodClassification,
  expected: AdvancePeriodClassificationReverseRow,
  payrollPeriod: string,
): boolean {
  return (
    Number(actual.id) === expected.classificationId &&
    Number(actual.advanceId) === expected.advanceId &&
    Number(actual.employeeId) === expected.employeeId &&
    Number(actual.branchId) === expected.branchId &&
    money(actual.amount).eq(expected.amount) &&
    money(actual.remaining).eq(expected.remaining) &&
    actual.direction === "APPLY" &&
    actual.reversalOfId === null &&
    actual.payrollPeriod === payrollPeriod &&
    actual.sourceHash === expected.applySourceHash &&
    actual.evidenceKind === "OWNER_ATTESTATION"
  );
}

function matchesReverseLedger(
  actual: EmployeeAdvancePeriodClassification,
  expected: AdvancePeriodClassificationReverseRow,
  plan: NormalizedReversePlan,
  index: number,
): boolean {
  return (
    Number(actual.advanceId) === expected.advanceId &&
    Number(actual.employeeId) === expected.employeeId &&
    Number(actual.branchId) === expected.branchId &&
    money(actual.amount).eq(expected.amount) &&
    money(actual.remaining).eq(expected.remaining) &&
    actual.direction === "REVERSE" &&
    Number(actual.reversalOfId) === expected.classificationId &&
    actual.payrollPeriod === plan.payrollPeriod &&
    actual.sourceKey ===
      sourceKey("REVERSE", plan.batchKey, expected.advanceId, index) &&
    actual.sourceHash === plan.sourceHash &&
    actual.evidenceKind === "OWNER_ATTESTATION" &&
    actual.evidenceReference === plan.reason &&
    actual.evidenceHash === reverseEvidenceHash(plan.reason)
  );
}

function matchesReverseBefore(
  actual: EmployeeAdvance,
  expected: AdvancePeriodClassificationReverseRow,
  payrollPeriod: string,
): boolean {
  return (
    Number(actual.id) === expected.advanceId &&
    Number(actual.employeeId) === expected.employeeId &&
    Number(actual.branchId) === expected.branchId &&
    money(actual.amount).eq(expected.amount) &&
    money(actual.remaining).eq(expected.remaining) &&
    actual.status === "ACTIVE" &&
    actual.sourceType === "SALARY_ADVANCE" &&
    actual.payrollPeriod === payrollPeriod
  );
}

function matchesReverseAfter(
  actual: EmployeeAdvance,
  expected: AdvancePeriodClassificationReverseRow,
): boolean {
  return (
    Number(actual.id) === expected.advanceId &&
    Number(actual.employeeId) === expected.employeeId &&
    Number(actual.branchId) === expected.branchId &&
    money(actual.amount).eq(expected.amount) &&
    money(actual.remaining).eq(expected.remaining) &&
    actual.status === "ACTIVE" &&
    actual.sourceType === "LEGACY_UNCLASSIFIED" &&
    actual.payrollPeriod === null
  );
}

function expectedReverseAudit(
  plan: NormalizedReversePlan,
  reverseClassificationIds: number[],
) {
  return {
    version: "employee-advance-period-classification.reverse.v1",
    batchKey: plan.batchKey,
    sourceHash: plan.sourceHash,
    reason: plan.reason,
    payrollPeriod: plan.payrollPeriod,
    totalAmount: plan.totalAmount,
    applyClassificationIds: plan.rows.map((row) => row.classificationId),
    advanceIds: plan.rows.map((row) => row.advanceId),
    businessBranchId: reverseBusinessBranchId(plan.rows),
    classificationIds: reverseClassificationIds,
    transition: {
      from: { sourceType: "SALARY_ADVANCE", payrollPeriod: plan.payrollPeriod },
      to: { sourceType: "LEGACY_UNCLASSIFIED", payrollPeriod: null },
    },
    effects: {
      balance: "UNCHANGED",
      payrollRun: "NONE",
      payrollDeduction: "NONE",
      cash: "NONE",
      receipt: "NONE",
      generalLedger: "NONE",
    },
  };
}

async function assertLiveOwnerTx(tx: Tx, actor: Actor): Promise<Actor> {
  const resolved = await resolveApprovalActor(tx, actor, { current: true });
  if (!resolved.isOwner) {
    fail(
      "تصنيف السلف التاريخية محصور بمالك نشط مثبت داخل المعاملة",
      "FORBIDDEN",
    );
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
    fail("يتغير وضع الدفتر المزدوج الآن؛ أعد المحاولة بعد اكتمال التحويل");
  }
  if (rows.length !== 1 || rows[0].mode !== "OFF") {
    fail(
      "تصنيف السلف غير الناشر متاح فقط عند وضع الدفتر المزدوج OFF",
      "PRECONDITION_FAILED",
    );
  }
}

async function lockEmployeesTx(
  tx: Tx,
  employeeIdsInput: number[],
): Promise<void> {
  const employeeIds = Array.from(new Set(employeeIdsInput)).sort(
    (a, b) => a - b,
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
    fail("تعذر قفل جميع موظفي خطة التصنيف");
  }
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
    fail("تعذر قفل جميع السلف المطلوبة للتصنيف");
  }
  return rows;
}

async function lockReceiptsTx(
  tx: Tx,
  receiptIds: number[],
): Promise<Receipt[]> {
  const rows = await tx
    .select()
    .from(receipts)
    .where(inArray(receipts.id, receiptIds))
    .orderBy(asc(receipts.id))
    .for("share");
  if (
    rows.length !== receiptIds.length ||
    rows.some((row, index) => Number(row.id) !== receiptIds[index])
  ) {
    fail("تعذر قفل سندات صرف السلف المطلوبة");
  }
  return rows;
}

async function lockHistoryTx(
  tx: Tx,
  advanceIds: number[],
): Promise<EmployeeAdvancePeriodClassification[]> {
  return tx
    .select()
    .from(employeeAdvancePeriodClassifications)
    .where(inArray(employeeAdvancePeriodClassifications.advanceId, advanceIds))
    .orderBy(
      asc(employeeAdvancePeriodClassifications.advanceId),
      asc(employeeAdvancePeriodClassifications.direction),
      asc(employeeAdvancePeriodClassifications.id),
    )
    .for("update");
}

async function lockBatchAuditsTx(tx: Tx, action: string, batchKey: string) {
  return tx
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, action), eq(auditLogs.entityId, batchKey)))
    .orderBy(asc(auditLogs.id))
    .for("update");
}

async function assertNoPayrollRunTx(
  tx: Tx,
  payrollPeriod: string,
): Promise<void> {
  const existing = await tx
    .select({ id: payrollRuns.id, status: payrollRuns.status })
    .from(payrollRuns)
    .where(eq(payrollRuns.period, payrollPeriod))
    .for("update")
    .limit(1);
  if (existing.length) {
    fail(
      "يوجد مسير رواتب للشهر المحدد؛ رُفض تغيير تصنيف السلف",
      "PRECONDITION_FAILED",
    );
  }
}

async function assertCompleteMonthScopeTx(
  tx: Tx,
  plan: NormalizedPlan,
): Promise<void> {
  const bounds = periodBounds(plan.payrollPeriod);
  const rows = await tx
    .select({ id: employeeAdvances.id })
    .from(employeeAdvances)
    .where(
      and(
        eq(employeeAdvances.sourceType, "LEGACY_UNCLASSIFIED"),
        isNull(employeeAdvances.payrollPeriod),
        eq(employeeAdvances.status, "ACTIVE"),
        gte(employeeAdvances.grantedAt, bounds.start),
        lt(employeeAdvances.grantedAt, bounds.end),
      ),
    )
    .orderBy(asc(employeeAdvances.id))
    .for("update");
  const expectedIds = plan.rows.map((row) => row.advanceId);
  if (
    rows.length !== expectedIds.length ||
    rows.some((row, index) => Number(row.id) !== expectedIds[index])
  ) {
    fail(
      "الخطة لا تغطي كل السلف القديمة النشطة في شهر التصنيف؛ رُفض التطبيق الجزئي",
    );
  }
}

async function assertNoPriorEffectsTx(
  tx: Tx,
  plan: NormalizedPlan,
): Promise<void> {
  const advanceIds = plan.rows.map((row) => row.advanceId);
  const employeeIds = Array.from(
    new Set(plan.rows.map((row) => row.expected.employeeId)),
  );
  const receiptIds = plan.rows.map((row) => row.expected.receiptId);
  // Deterministic lock order on one transaction connection; do not issue
  // concurrent FOR UPDATE statements against the same MySQL session.
  const payroll = await tx
    .select({ id: advanceSettlements.id })
    .from(advanceSettlements)
    .where(inArray(advanceSettlements.advanceId, advanceIds))
    .for("update");
  const repayment = await tx
    .select({ id: employeeAdvanceRepaymentAllocations.id })
    .from(employeeAdvanceRepaymentAllocations)
    .where(inArray(employeeAdvanceRepaymentAllocations.advanceId, advanceIds))
    .for("update");
  const termination = await tx
    .select({ id: terminationAdvanceAllocations.id })
    .from(terminationAdvanceAllocations)
    .where(inArray(terminationAdvanceAllocations.advanceId, advanceIds))
    .for("update");
  const recovery = await tx
    .select({ id: employeeAdvanceHistoricalRecoveries.id })
    .from(employeeAdvanceHistoricalRecoveries)
    .where(inArray(employeeAdvanceHistoricalRecoveries.advanceId, advanceIds))
    .for("update");
  const requests = await tx
    .select({ id: employeeLoanRequests.id })
    .from(employeeLoanRequests)
    .where(
      or(
        inArray(employeeLoanRequests.advanceId, advanceIds),
        inArray(employeeLoanRequests.receiptId, receiptIds),
      ),
    )
    .for("update");
  const pendingRepayments = await tx
    .select({ id: employeeAdvanceRepaymentRequests.id })
    .from(employeeAdvanceRepaymentRequests)
    .where(
      and(
        inArray(employeeAdvanceRepaymentRequests.employeeId, employeeIds),
        eq(employeeAdvanceRepaymentRequests.status, "PENDING"),
      ),
    )
    .for("update");
  if (
    payroll.length ||
    repayment.length ||
    termination.length ||
    recovery.length ||
    requests.length ||
    pendingRepayments.length
  ) {
    fail("وجد أثر سابق أو طلب متداخل لإحدى سلف التصنيف؛ رُفض التخمين");
  }
}

async function assertCompleteOriginalApplyBatchTx(
  tx: Tx,
  plan: NormalizedReversePlan,
): Promise<void> {
  const applySourceHash = plan.rows[0].applySourceHash;
  const rows = await tx
    .select({
      id: employeeAdvancePeriodClassifications.id,
      advanceId: employeeAdvancePeriodClassifications.advanceId,
    })
    .from(employeeAdvancePeriodClassifications)
    .where(
      and(
        eq(employeeAdvancePeriodClassifications.direction, "APPLY"),
        eq(employeeAdvancePeriodClassifications.sourceHash, applySourceHash),
      ),
    )
    .orderBy(asc(employeeAdvancePeriodClassifications.advanceId))
    .for("update");
  if (
    rows.length !== plan.rows.length ||
    rows.some(
      (row, index) =>
        Number(row.id) !== plan.rows[index].classificationId ||
        Number(row.advanceId) !== plan.rows[index].advanceId,
    )
  ) {
    fail("خطة العكس لا تغطي دفعة التصنيف الأصلية كاملة");
  }
}

async function assertNoReverseEffectsTx(
  tx: Tx,
  plan: NormalizedReversePlan,
): Promise<void> {
  const advanceIds = plan.rows.map((row) => row.advanceId);
  const employeeIds = Array.from(
    new Set(plan.rows.map((row) => row.employeeId)),
  );
  const payroll = await tx
    .select({ id: advanceSettlements.id })
    .from(advanceSettlements)
    .where(inArray(advanceSettlements.advanceId, advanceIds))
    .for("update");
  const repayment = await tx
    .select({ id: employeeAdvanceRepaymentAllocations.id })
    .from(employeeAdvanceRepaymentAllocations)
    .where(inArray(employeeAdvanceRepaymentAllocations.advanceId, advanceIds))
    .for("update");
  const termination = await tx
    .select({ id: terminationAdvanceAllocations.id })
    .from(terminationAdvanceAllocations)
    .where(inArray(terminationAdvanceAllocations.advanceId, advanceIds))
    .for("update");
  const recovery = await tx
    .select({ id: employeeAdvanceHistoricalRecoveries.id })
    .from(employeeAdvanceHistoricalRecoveries)
    .where(inArray(employeeAdvanceHistoricalRecoveries.advanceId, advanceIds))
    .for("update");
  const requests = await tx
    .select({ id: employeeLoanRequests.id })
    .from(employeeLoanRequests)
    .where(inArray(employeeLoanRequests.advanceId, advanceIds))
    .for("update");
  const pendingRepayments = await tx
    .select({ id: employeeAdvanceRepaymentRequests.id })
    .from(employeeAdvanceRepaymentRequests)
    .where(
      and(
        inArray(employeeAdvanceRepaymentRequests.employeeId, employeeIds),
        eq(employeeAdvanceRepaymentRequests.status, "PENDING"),
      ),
    )
    .for("update");
  if (
    payroll.length ||
    repayment.length ||
    termination.length ||
    recovery.length ||
    requests.length ||
    pendingRepayments.length
  ) {
    fail("لا يمكن عكس التصنيف بعد بدء أثر راتب أو سداد أو مخالصة");
  }
}

export async function applyAdvancePeriodClassificationsTx(
  tx: Tx,
  actor: Actor,
  rawPlan: AdvancePeriodClassificationPlan,
): Promise<AdvancePeriodClassificationResult> {
  assertFinancialWriterGateHeld(tx);
  const currentActor = await assertLiveOwnerTx(tx, actor);
  await assertNonPostingModeTx(tx);
  const plan = parseAdvancePeriodClassificationPlan(rawPlan);
  await lockEmployeesTx(
    tx,
    plan.rows.map((row) => row.expected.employeeId),
  );
  const advanceIds = plan.rows.map((row) => row.advanceId);
  const advances = await lockAdvancesTx(tx, advanceIds);
  const history = await lockHistoryTx(tx, advanceIds);
  const markerKey = sourceKey("APPLY", plan.batchKey, advanceIds[0], 0);
  const markerRows = await tx
    .select()
    .from(employeeAdvancePeriodClassifications)
    .where(eq(employeeAdvancePeriodClassifications.sourceKey, markerKey))
    .for("update")
    .limit(1);
  if (markerRows[0] && markerRows[0].sourceHash !== plan.sourceHash) {
    fail("مفتاح دفعة التصنيف مستعمل لخطة مختلفة");
  }
  const audits = await lockBatchAuditsTx(tx, APPLY_ACTION, plan.batchKey);
  const applyRows = history.filter((row) => row.direction === "APPLY");
  const classificationIds = applyRows.map((row) => Number(row.id));
  const auditBranchId = businessBranchId(plan.rows);
  const replayLedger =
    history.length === plan.rows.length &&
    applyRows.length === plan.rows.length &&
    applyRows.every((row, index) =>
      matchesLedger(row, plan.rows[index], plan, index),
    );
  const replayState = advances.every((row, index) =>
    matchesAfter(row, plan.rows[index], plan.payrollPeriod),
  );
  const replayAudit =
    audits.length === 1 &&
    sameJson(
      jsonObject(audits[0].newValue),
      expectedApplyAudit(plan, classificationIds),
    ) &&
    (audits[0].branchId === null
      ? auditBranchId === null
      : Number(audits[0].branchId) === auditBranchId) &&
    applyRows.every(
      (row) => Number(row.createdBy) === Number(audits[0].userId),
    );
  if (replayLedger && replayState && replayAudit) {
    return {
      mode: "REPLAY_VERIFIED",
      batchKey: plan.batchKey,
      sourceHash: plan.sourceHash,
      payrollPeriod: plan.payrollPeriod,
      totalAmount: plan.totalAmount,
      classificationIds,
    };
  }

  const currentPeriod = baghdadToday().slice(0, 7);
  if (plan.payrollPeriod !== priorPeriod(currentPeriod)) {
    fail("أداة التصنيف تقبل شهر بغداد السابق فقط", "PRECONDITION_FAILED");
  }
  const pristine =
    history.length === 0 &&
    audits.length === 0 &&
    advances.every((row, index) => matchesBefore(row, plan.rows[index]));
  if (!pristine) {
    fail("حالة السلف أو سجل التصنيف أو التدقيق مختلطة؛ رُفض التطبيق دون تخمين");
  }

  await assertNoPayrollRunTx(tx, plan.payrollPeriod);
  await assertCompleteMonthScopeTx(tx, plan);
  await assertNoPriorEffectsTx(tx, plan);
  const receiptIds = plan.rows
    .map((row) => row.expected.receiptId)
    .sort((a, b) => a - b);
  const lockedReceipts = await lockReceiptsTx(tx, receiptIds);
  const receiptById = new Map(
    lockedReceipts.map((receipt) => [Number(receipt.id), receipt]),
  );
  if (
    plan.rows.some((row) => {
      const receipt = receiptById.get(row.expected.receiptId);
      return !receipt || !matchesReceipt(receipt, row, plan.payrollPeriod);
    })
  ) {
    fail("سند صرف إحدى السلف لا يطابق هوية الخطة أو حالتها المعتمدة");
  }

  const insertedIds: number[] = [];
  for (let index = 0; index < plan.rows.length; index += 1) {
    const row = plan.rows[index];
    const insertResult = await tx
      .insert(employeeAdvancePeriodClassifications)
      .values({
        advanceId: row.advanceId,
        employeeId: row.expected.employeeId,
        branchId: row.expected.branchId,
        amount: row.expected.amount,
        remaining: row.expected.remaining,
        direction: "APPLY",
        reversalOfId: null,
        payrollPeriod: plan.payrollPeriod,
        sourceKey: sourceKey("APPLY", plan.batchKey, row.advanceId, index),
        sourceHash: plan.sourceHash,
        evidenceKind: plan.evidenceKind,
        evidenceReference: plan.evidenceReference,
        evidenceHash: plan.evidenceHash,
        createdBy: currentActor.userId,
      });
    insertedIds.push(extractInsertId(insertResult));
    const updateResult = await tx
      .update(employeeAdvances)
      .set({ sourceType: "SALARY_ADVANCE", payrollPeriod: plan.payrollPeriod })
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
          eq(employeeAdvances.receiptId, row.expected.receiptId),
        ),
      );
    if (extractAffectedRows(updateResult) !== 1) {
      fail("تغيرت السلفة أثناء التصنيف؛ أُعيدت المعاملة كاملة");
    }
  }

  await logAuditTx(
    tx,
    { userId: currentActor.userId, branchId: auditBranchId },
    {
      action: APPLY_ACTION,
      entityType: AUDIT_ENTITY,
      entityId: plan.batchKey,
      newValue: expectedApplyAudit(plan, insertedIds),
    },
  );
  return {
    mode: "APPLIED",
    batchKey: plan.batchKey,
    sourceHash: plan.sourceHash,
    payrollPeriod: plan.payrollPeriod,
    totalAmount: plan.totalAmount,
    classificationIds: insertedIds,
  };
}

export async function reverseAdvancePeriodClassificationsTx(
  tx: Tx,
  actor: Actor,
  rawPlan: AdvancePeriodClassificationReversePlan,
): Promise<AdvancePeriodClassificationResult> {
  assertFinancialWriterGateHeld(tx);
  const currentActor = await assertLiveOwnerTx(tx, actor);
  await assertNonPostingModeTx(tx);
  const plan = parseAdvancePeriodClassificationReversePlan(rawPlan);
  await lockEmployeesTx(
    tx,
    plan.rows.map((row) => row.employeeId),
  );
  const advanceIds = plan.rows.map((row) => row.advanceId);
  const advances = await lockAdvancesTx(tx, advanceIds);
  const history = await lockHistoryTx(tx, advanceIds);
  const markerKey = sourceKey("REVERSE", plan.batchKey, advanceIds[0], 0);
  const markerRows = await tx
    .select()
    .from(employeeAdvancePeriodClassifications)
    .where(eq(employeeAdvancePeriodClassifications.sourceKey, markerKey))
    .for("update")
    .limit(1);
  if (markerRows[0] && markerRows[0].sourceHash !== plan.sourceHash) {
    fail("مفتاح دفعة عكس التصنيف مستعمل لخطة مختلفة");
  }
  const audits = await lockBatchAuditsTx(tx, REVERSE_ACTION, plan.batchKey);
  const applyRows = history.filter((row) => row.direction === "APPLY");
  const reverseRows = history.filter((row) => row.direction === "REVERSE");
  const reverseIds = reverseRows.map((row) => Number(row.id));
  const auditBranchId = reverseBusinessBranchId(plan.rows);
  const originalApplyMatches =
    applyRows.length === plan.rows.length &&
    applyRows.every((row, index) =>
      matchesOriginalApply(row, plan.rows[index], plan.payrollPeriod),
    );
  const replayLedger =
    history.length === plan.rows.length * 2 &&
    originalApplyMatches &&
    reverseRows.length === plan.rows.length &&
    reverseRows.every((row, index) =>
      matchesReverseLedger(row, plan.rows[index], plan, index),
    );
  const replayState = advances.every((row, index) =>
    matchesReverseAfter(row, plan.rows[index]),
  );
  const replayAudit =
    audits.length === 1 &&
    sameJson(
      jsonObject(audits[0].newValue),
      expectedReverseAudit(plan, reverseIds),
    ) &&
    (audits[0].branchId === null
      ? auditBranchId === null
      : Number(audits[0].branchId) === auditBranchId) &&
    reverseRows.every(
      (row) => Number(row.createdBy) === Number(audits[0].userId),
    );
  if (replayLedger && replayState && replayAudit) {
    return {
      mode: "REPLAY_VERIFIED",
      batchKey: plan.batchKey,
      sourceHash: plan.sourceHash,
      payrollPeriod: plan.payrollPeriod,
      totalAmount: plan.totalAmount,
      classificationIds: reverseIds,
    };
  }

  const currentPeriod = baghdadToday().slice(0, 7);
  if (plan.payrollPeriod >= currentPeriod) {
    fail("لا يجوز عكس تصنيف شهر حالي أو مستقبلي", "PRECONDITION_FAILED");
  }
  const pristine =
    history.length === plan.rows.length &&
    originalApplyMatches &&
    reverseRows.length === 0 &&
    audits.length === 0 &&
    advances.every((row, index) =>
      matchesReverseBefore(row, plan.rows[index], plan.payrollPeriod),
    );
  if (!pristine) {
    fail("حالة السلف أو دفتر التصنيف أو التدقيق مختلطة؛ رُفض العكس دون تخمين");
  }

  await assertNoPayrollRunTx(tx, plan.payrollPeriod);
  await assertCompleteOriginalApplyBatchTx(tx, plan);
  await assertNoReverseEffectsTx(tx, plan);
  const evidenceHash = reverseEvidenceHash(plan.reason);
  const insertedIds: number[] = [];
  for (let index = 0; index < plan.rows.length; index += 1) {
    const row = plan.rows[index];
    const insertResult = await tx
      .insert(employeeAdvancePeriodClassifications)
      .values({
        advanceId: row.advanceId,
        employeeId: row.employeeId,
        branchId: row.branchId,
        amount: row.amount,
        remaining: row.remaining,
        direction: "REVERSE",
        reversalOfId: row.classificationId,
        payrollPeriod: plan.payrollPeriod,
        sourceKey: sourceKey("REVERSE", plan.batchKey, row.advanceId, index),
        sourceHash: plan.sourceHash,
        evidenceKind: "OWNER_ATTESTATION",
        evidenceReference: plan.reason,
        evidenceHash,
        createdBy: currentActor.userId,
      });
    insertedIds.push(extractInsertId(insertResult));
    const updateResult = await tx
      .update(employeeAdvances)
      .set({ sourceType: "LEGACY_UNCLASSIFIED", payrollPeriod: null })
      .where(
        and(
          eq(employeeAdvances.id, row.advanceId),
          eq(employeeAdvances.employeeId, row.employeeId),
          eq(employeeAdvances.branchId, row.branchId),
          eq(employeeAdvances.amount, row.amount),
          eq(employeeAdvances.remaining, row.remaining),
          eq(employeeAdvances.status, "ACTIVE"),
          eq(employeeAdvances.sourceType, "SALARY_ADVANCE"),
          eq(employeeAdvances.payrollPeriod, plan.payrollPeriod),
        ),
      );
    if (extractAffectedRows(updateResult) !== 1) {
      fail("تغيرت السلفة أثناء عكس التصنيف؛ أُعيدت المعاملة كاملة");
    }
  }

  await logAuditTx(
    tx,
    { userId: currentActor.userId, branchId: auditBranchId },
    {
      action: REVERSE_ACTION,
      entityType: AUDIT_ENTITY,
      entityId: plan.batchKey,
      newValue: expectedReverseAudit(plan, insertedIds),
    },
  );
  return {
    mode: "APPLIED",
    batchKey: plan.batchKey,
    sourceHash: plan.sourceHash,
    payrollPeriod: plan.payrollPeriod,
    totalAmount: plan.totalAmount,
    classificationIds: insertedIds,
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

export async function applyAdvancePeriodClassifications(
  actor: Actor,
  plan: AdvancePeriodClassificationPlan,
): Promise<AdvancePeriodClassificationResult> {
  const work = (tx: Tx) => applyAdvancePeriodClassificationsTx(tx, actor, plan);
  try {
    return await withTx(work, { gate: "GOVERNANCE" });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    return withTx(work, { gate: "GOVERNANCE" });
  }
}

export async function reverseAdvancePeriodClassifications(
  actor: Actor,
  plan: AdvancePeriodClassificationReversePlan,
): Promise<AdvancePeriodClassificationResult> {
  const work = (tx: Tx) =>
    reverseAdvancePeriodClassificationsTx(tx, actor, plan);
  try {
    return await withTx(work, { gate: "GOVERNANCE" });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    return withTx(work, { gate: "GOVERNANCE" });
  }
}
