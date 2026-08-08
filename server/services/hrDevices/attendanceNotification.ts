export type AttendanceMovement =
  | "ATTENDANCE_CHECK_IN"
  | "ATTENDANCE_CHECK_OUT";

export interface AttendanceNotificationInput {
  employeeId: number;
  attendanceDate: string;
  movement: AttendanceMovement;
  clock: string;
  needsReview: boolean;
  branchName?: string | null;
  deviceName?: string | null;
  includeWorkplace?: boolean;
}

export interface AttendanceNotificationContent {
  eventKey: string;
  title: string;
  body: string;
  requiresAction: boolean;
}

function safeLabel(value: string | null | undefined, maxLength = 36): string | null {
  const normalized = value
    ?.replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

/**
 * يبني نص شاشة القفل من معلومات تشغيلية غير مالية وغير تعريفية. لا يدخل اسم الموظف أو
 * رقمه أو أي حمولة خام من جهاز البصمة في النص المرسل إلى FCM.
 */
export function buildAttendanceNotification(
  input: AttendanceNotificationInput,
): AttendanceNotificationContent {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.attendanceDate)) {
    throw new Error("INVALID_ATTENDANCE_DATE");
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.clock)) {
    throw new Error("INVALID_ATTENDANCE_CLOCK");
  }

  const checkIn = input.movement === "ATTENDANCE_CHECK_IN";
  const segments = [
    input.clock,
    input.needsReview ? "بانتظار المراجعة" : "مسجّل",
  ];
  if (input.includeWorkplace === true) {
    const branch = safeLabel(input.branchName);
    const device = safeLabel(input.deviceName);
    if (branch) segments.push(branch);
    if (device && device !== branch) segments.push(device);
  }

  return {
    eventKey: `attendance:${input.employeeId}:${input.attendanceDate}:${input.movement}`,
    title: checkIn ? "تم تسجيل الحضور" : "تم تسجيل الانصراف",
    body: segments.join(" • ").slice(0, 180),
    requiresAction: input.needsReview,
  };
}
