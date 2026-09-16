export type MobileToday = Readonly<{
  date: string;
  navigation: {
    ownerCenter: boolean;
    personal: boolean;
    work: boolean;
  };
  personal: {
    state: "READY" | "NOT_LINKED";
    employee: { displayName: string; position: string | null; department: string | null } | null;
    attendance: {
      state: "NOT_RECORDED" | "CHECKED_IN" | "COMPLETE" | "NEEDS_REVIEW";
      checkIn: string | null;
      checkOut: string | null;
      action: { destination: "SELF_ATTENDANCE"; requiresStepUp: false };
    } | null;
    focus: {
    id: number;
    title: string;
    priority: string;
    status: "NEW" | "IN_PROGRESS" | "WAITING_CUSTOMER";
    dueAt: string | null;
      action: { destination: "TASKS"; requiresStepUp: false };
    } | null;
    leave: {
      status: string;
      fromDate: string;
      toDate: string;
      action: { destination: "SELF_LEAVE"; requiresStepUp: false };
    } | null;
    payroll: {
      period: string;
      status: "approved" | "paid";
      action: { destination: "SELF_PAYROLL"; requiresStepUp: true };
    } | null;
  };
}>;

export type NativeLoginResult = Readonly<{
  requiresTwoFactor: boolean;
  ticket: string | null;
  name?: string;
  mustChangePassword?: boolean;
  mustEnrollTwoFactor?: boolean;
}>;

export type MobileCommandCenter = Readonly<{
  asOf: string;
  scope: "ALL_BRANCHES" | "ASSIGNED_BRANCH";
  health: { status: "ok" | "degraded"; partialErrors: readonly { section: string; code: "SOURCE_UNAVAILABLE" }[] };
  decisions: readonly {
    id: string;
    severity: "critical" | "warning" | "info";
    title: string;
    actionLabel: string;
  }[];
  metrics: {
    lowStockCount: number | null;
    overdueReceivables: { count: number; total: string } | null;
    salesToday: { total: string; invoiceCount: number } | null;
    treasury: { balance: string; openShiftsCount: number } | null;
  };
}>;

export type MobileAttendanceHistory = Readonly<{
  range: { from: string; to: string };
  personal: {
    state: "READY" | "NOT_LINKED";
    entries: readonly {
      date: string;
      checkIn: string | null;
      checkOut: string | null;
      status: "PRESENT" | "ABSENT" | "LATE" | "LEAVE";
      hours: string | null;
      state: "RECORDED" | "NEEDS_REVIEW";
    }[];
  };
}>;

/** Sensitive projection returned only after a newly consumed server-side 2FA code. */
export type MobilePayslip = Readonly<{
  personal: {
    state: "READY" | "NOT_LINKED";
    payslip: {
      period: string;
      status: "approved" | "paid";
      paidAt: string | null;
      payType: string;
      hours: string | null;
      gross: string;
      allowances: string;
      overtime: string;
      commission: string;
      deductions: string;
      advanceDeduction: string;
      socialSecurityEmployee: string;
      incomeTax: string;
      net: string;
    } | null;
  };
}>;

/** Result of a closed native leave command; no employee, leave, or branch id crosses the bridge. */
export type MobileLeaveCommand = Readonly<{
  leave: {
    status: "pending" | "rejected";
    fromDate: string;
    toDate: string;
  };
  idempotent: boolean;
}>;

/** Closed start/complete result. The task identifier stays server-side. */
export type MobileTaskCommand = Readonly<{
  status: "IN_PROGRESS" | "RESOLVED";
  idempotent: boolean;
}>;

/** No token, device fingerprint, or user identifier crosses this boundary. */
export type MobileExpoPushStatus = Readonly<{
  activeCount: number;
}>;

export type MobileExpoPushCommand = Readonly<{
  registered?: true;
  revoked?: true;
}>;

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
  return value as RecordValue;
}

function text(value: unknown, max = 512): string {
  if (typeof value !== "string" || value.length > max || /[\r\n]/.test(value)) throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
  return value;
}

function nullableText(value: unknown, max = 512): string | null {
  return value === null ? null : text(value, max);
}

function optionalText(value: unknown, max = 512): string | undefined {
  return value === undefined ? undefined : text(value, max);
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
  }
  return value;
}

function moneyText(value: unknown): string {
  const output = text(value, 64);
  if (!/^-?\d+(?:\.\d{1,4})?$/.test(output) || !Number.isFinite(Number(output))) {
    throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
  }
  return output;
}

function dayText(value: unknown): string {
  const output = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(output)) {
    throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
  }
  return output;
}

function timestamp(value: unknown): string | null {
  const output = nullableText(value, 64);
  if (output !== null && Number.isNaN(new Date(output).getTime())) {
    throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
  }
  return output;
}

function hoursText(value: unknown): string | null {
  if (value === null) return null;
  const output = moneyText(value);
  const numeric = Number(output);
  if (numeric < 0 || numeric > 24) {
    throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
  }
  return output;
}

/** Payroll hours span a whole pay period, unlike a single attendance day. */
function payrollHoursText(value: unknown): string | null {
  if (value === null) return null;
  const output = moneyText(value);
  const numeric = Number(output);
  if (numeric < 0 || numeric > 744) {
    throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
  }
  return output;
}

function parseJson(payload: string): RecordValue {
  try {
    return record(JSON.parse(payload));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("وصلت استجابة")) throw error;
    throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
  }
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function action(value: unknown, destination: string, requiresStepUp: boolean): void {
  const source = record(value);
  if (source.destination !== destination || source.requiresStepUp !== requiresStepUp) {
    throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
  }
}

export function parseNativeLoginResult(payload: string): NativeLoginResult {
  const source = parseJson(payload);
  if (typeof source.requiresTwoFactor !== "boolean") throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
  const ticket = nullableText(source.ticket, 4096);
  if (source.requiresTwoFactor && !ticket) throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
  if (!source.requiresTwoFactor && ticket !== null) throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
  if (source.mustChangePassword !== undefined && typeof source.mustChangePassword !== "boolean") throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
  if (source.mustEnrollTwoFactor !== undefined && typeof source.mustEnrollTwoFactor !== "boolean") throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
  return {
    requiresTwoFactor: source.requiresTwoFactor,
    ticket,
    name: optionalText(source.name, 256),
    mustChangePassword: source.mustChangePassword as boolean | undefined,
    mustEnrollTwoFactor: source.mustEnrollTwoFactor as boolean | undefined,
  };
}

export function parseMobileToday(payload: string): MobileToday {
  const source = parseJson(payload);
  const date = dayText(source.date);
  const navigationSource = record(source.navigation);
  if (
    typeof navigationSource.ownerCenter !== "boolean" ||
    typeof navigationSource.personal !== "boolean" ||
    typeof navigationSource.work !== "boolean" ||
    (navigationSource.work && !navigationSource.personal)
  ) {
    throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
  }
  const navigation = {
    ownerCenter: navigationSource.ownerCenter,
    personal: navigationSource.personal,
    work: navigationSource.work,
  };
  const personal = record(source.personal);
  if (!isOneOf(personal.state, ["READY", "NOT_LINKED"] as const)) throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");

  if (personal.state === "NOT_LINKED") {
    if (personal.employee !== null || personal.attendance !== null || personal.focus !== null || personal.leave !== null || personal.payroll !== null) {
      throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
    }
    return {
      date,
      navigation,
      personal: { state: "NOT_LINKED", employee: null, attendance: null, focus: null, leave: null, payroll: null },
    };
  }

  const employeeSource = record(personal.employee);
  const employee = {
    displayName: text(employeeSource.displayName, 256),
    position: nullableText(employeeSource.position, 256),
    department: nullableText(employeeSource.department, 256),
  };
  const attendance = personal.attendance === null ? null : (() => {
    const item = record(personal.attendance);
    if (!isOneOf(item.state, ["NOT_RECORDED", "CHECKED_IN", "COMPLETE", "NEEDS_REVIEW"] as const)) throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
    action(item.action, "SELF_ATTENDANCE", false);
    return { state: item.state, checkIn: nullableText(item.checkIn), checkOut: nullableText(item.checkOut), action: { destination: "SELF_ATTENDANCE" as const, requiresStepUp: false as const } };
  })();
  const focus = personal.focus === null ? null : (() => {
    const item = record(personal.focus);
    if (typeof item.id !== "number" || !Number.isSafeInteger(item.id) || item.id < 1) throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
    action(item.action, "TASKS", false);
    if (!isOneOf(item.status, ["NEW", "IN_PROGRESS", "WAITING_CUSTOMER"] as const)) throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
    return { id: item.id, title: text(item.title, 512), priority: text(item.priority, 64), status: item.status, dueAt: nullableText(item.dueAt), action: { destination: "TASKS" as const, requiresStepUp: false as const } };
  })();
  const leave = personal.leave === null ? null : (() => {
    const item = record(personal.leave);
    action(item.action, "SELF_LEAVE", false);
    return { status: text(item.status, 64), fromDate: text(item.fromDate, 10), toDate: text(item.toDate, 10), action: { destination: "SELF_LEAVE" as const, requiresStepUp: false as const } };
  })();
  const payroll = personal.payroll === null ? null : (() => {
    const item = record(personal.payroll);
    if (!isOneOf(item.status, ["approved", "paid"] as const)) throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
    action(item.action, "SELF_PAYROLL", true);
    return { period: text(item.period, 32), status: item.status, action: { destination: "SELF_PAYROLL" as const, requiresStepUp: true as const } };
  })();

  if (!navigation.personal) throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
  return { date, navigation, personal: { state: "READY", employee, attendance, focus, leave, payroll } };
}

/**
 * Attendance stays an employee-owned, bounded projection. The parser rejects
 * a malformed range or record instead of quietly showing a partial history;
 * it also discards any server fields beyond the allow-list below.
 */
export function parseMobileAttendanceHistory(payload: string): MobileAttendanceHistory {
  const source = parseJson(payload);
  const rangeSource = record(source.range);
  const from = dayText(rangeSource.from);
  const to = dayText(rangeSource.to);
  if (from > to) throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
  const personal = record(source.personal);
  if (!isOneOf(personal.state, ["READY", "NOT_LINKED"] as const) || !Array.isArray(personal.entries) || personal.entries.length > 31) {
    throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
  }
  if (personal.state === "NOT_LINKED" && personal.entries.length !== 0) {
    throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
  }

  const seen = new Set<string>();
  const entries = personal.entries.map((sourceEntry) => {
    const entry = record(sourceEntry);
    const date = dayText(entry.date);
    if (date < from || date > to || seen.has(date)) {
      throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
    }
    seen.add(date);
    if (!isOneOf(entry.status, ["PRESENT", "ABSENT", "LATE", "LEAVE"] as const) || !isOneOf(entry.state, ["RECORDED", "NEEDS_REVIEW"] as const)) {
      throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
    }
    return {
      date,
      checkIn: timestamp(entry.checkIn),
      checkOut: timestamp(entry.checkOut),
      status: entry.status,
      hours: hoursText(entry.hours),
      state: entry.state,
    };
  });

  return { range: { from, to }, personal: { state: personal.state, entries } };
}

/**
 * The parser accepts no payroll identifiers, HR notes, branch details, or
 * unreviewed fields. This makes a malformed or expanded response fail closed
 * at the native boundary before a sensitive amount reaches rendering/export.
 */
export function parseMobilePayslip(payload: string): MobilePayslip {
  const source = parseJson(payload);
  const personal = record(source.personal);
  if (!isOneOf(personal.state, ["READY", "NOT_LINKED"] as const)) {
    throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
  }
  if (personal.state === "NOT_LINKED") {
    if (personal.payslip !== null) {
      throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
    }
    return { personal: { state: "NOT_LINKED", payslip: null } };
  }
  if (personal.payslip === null) {
    return { personal: { state: "READY", payslip: null } };
  }

  const payslip = record(personal.payslip);
  if (!isOneOf(payslip.status, ["approved", "paid"] as const)) {
    throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
  }
  const hours = payslip.hours === null ? null : payrollHoursText(payslip.hours);
  return {
    personal: {
      state: "READY",
      payslip: {
        period: text(payslip.period, 32),
        status: payslip.status,
        paidAt: timestamp(payslip.paidAt),
        payType: text(payslip.payType, 32),
        hours,
        gross: moneyText(payslip.gross),
        allowances: moneyText(payslip.allowances),
        overtime: moneyText(payslip.overtime),
        commission: moneyText(payslip.commission),
        deductions: moneyText(payslip.deductions),
        advanceDeduction: moneyText(payslip.advanceDeduction),
        socialSecurityEmployee: moneyText(payslip.socialSecurityEmployee),
        incomeTax: moneyText(payslip.incomeTax),
        net: moneyText(payslip.net),
      },
    },
  };
}

/**
 * Keeps the leave mutation response intentionally small. A native client can
 * tell the employee what happened, but it cannot turn this result into a
 * handle for another leave record or person.
 */
export function parseMobileLeaveCommand(payload: string): MobileLeaveCommand {
  const source = parseJson(payload);
  const leave = record(source.leave);
  if (!isOneOf(leave.status, ["pending", "rejected"] as const) || typeof source.idempotent !== "boolean") {
    throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
  }
  const fromDate = dayText(leave.fromDate);
  const toDate = dayText(leave.toDate);
  if (toDate < fromDate) throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
  return {
    leave: { status: leave.status, fromDate, toDate },
    idempotent: source.idempotent,
  };
}

export function parseMobileTaskCommand(payload: string): MobileTaskCommand {
  const source = parseJson(payload);
  if (!isOneOf(source.status, ["IN_PROGRESS", "RESOLVED"] as const) || typeof source.idempotent !== "boolean") {
    throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
  }
  return { status: source.status, idempotent: source.idempotent };
}

export function parseMobileExpoPushStatus(payload: string): MobileExpoPushStatus {
  const source = parseJson(payload);
  return { activeCount: nonNegativeInteger(source.activeCount) };
}

export function parseMobileExpoPushCommand(
  payload: string,
  expected: "registered" | "revoked",
): MobileExpoPushCommand {
  const source = parseJson(payload);
  if (source[expected] !== true) {
    throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
  }
  return expected === "registered" ? { registered: true } : { revoked: true };
}

/**
 * The owner projection is a strict allow-list too: action arguments, branch
 * identifiers, raw alert values, and any unrecognized fields never reach UI.
 */
export function parseMobileCommandCenter(payload: string): MobileCommandCenter {
  const source = parseJson(payload);
  const asOf = text(source.asOf, 40);
  if (Number.isNaN(new Date(asOf).getTime())) throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
  if (!isOneOf(source.scope, ["ALL_BRANCHES", "ASSIGNED_BRANCH"] as const)) throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");

  const healthSource = record(source.health);
  if (!isOneOf(healthSource.status, ["ok", "degraded"] as const) || !Array.isArray(healthSource.partialErrors) || healthSource.partialErrors.length > 16) {
    throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
  }
  const partialErrors = healthSource.partialErrors.map((item) => {
    const error = record(item);
    if (error.code !== "SOURCE_UNAVAILABLE") throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
    return { section: text(error.section, 96), code: "SOURCE_UNAVAILABLE" as const };
  });

  if (!Array.isArray(source.decisions) || source.decisions.length > 50) throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
  const decisions = source.decisions.map((item) => {
    const decision = record(item);
    if (!isOneOf(decision.severity, ["critical", "warning", "info"] as const)) throw new Error("وصلت استجابة غير مكتملة من الخادم. أعد المحاولة لاحقاً.");
    return {
      id: text(decision.id, 128),
      severity: decision.severity,
      title: text(decision.title, 256),
      actionLabel: text(decision.actionLabel, 128),
    };
  });

  const metricsSource = record(source.metrics);
  const lowStockCount = metricsSource.lowStockCount === null ? null : nonNegativeInteger(metricsSource.lowStockCount);
  const overdueReceivables = metricsSource.overdueReceivables === null ? null : (() => {
    const value = record(metricsSource.overdueReceivables);
    return { count: nonNegativeInteger(value.count), total: moneyText(value.total) };
  })();
  const salesToday = metricsSource.salesToday === null ? null : (() => {
    const value = record(metricsSource.salesToday);
    return { total: moneyText(value.total), invoiceCount: nonNegativeInteger(value.invoiceCount) };
  })();
  const treasury = metricsSource.treasury === null ? null : (() => {
    const value = record(metricsSource.treasury);
    return { balance: moneyText(value.balance), openShiftsCount: nonNegativeInteger(value.openShiftsCount) };
  })();

  return {
    asOf,
    scope: source.scope,
    health: { status: healthSource.status, partialErrors },
    decisions,
    metrics: { lowStockCount, overdueReceivables, salesToday, treasury },
  };
}
