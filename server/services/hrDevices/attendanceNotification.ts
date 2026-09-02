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

export interface AttendanceNotificationDeliveriesInput
  extends AttendanceNotificationInput {
  employeeUserId?: number | null;
  employeeDisplayName: string;
  adminRecipientUserIds: readonly number[];
  attendanceId: number;
}

export interface AttendanceNotificationDelivery {
  userId: number;
  kind: "ATTENDANCE";
  title: string;
  body: string;
  route: string;
  eventKey: string;
  entityType: "attendance";
  entityId: number;
  requiresAction: boolean;
  lockScreenSafe: true;
  push: true;
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

/**
 * توزيع حدث البصمة الحقيقي: تأكيدٌ شخصيٌّ للموظف المرتبط بحساب، وتنبيهٌ مسمّى
 * للإدارة. لا تستعمله أحداث جلسة الحساب (login/logout) مطلقاً.
 */
export function buildAttendanceNotificationDeliveries(
  input: AttendanceNotificationDeliveriesInput,
): AttendanceNotificationDelivery[] {
  const notification = buildAttendanceNotification(input);
  const deliveries: AttendanceNotificationDelivery[] = [];
  const base = {
    kind: "ATTENDANCE" as const,
    body: notification.body,
    route: "/hr?tab=attendance",
    entityType: "attendance" as const,
    entityId: input.attendanceId,
    requiresAction: notification.requiresAction,
    lockScreenSafe: true as const,
    push: true as const,
  };

  if (Number.isInteger(input.employeeUserId) && Number(input.employeeUserId) > 0) {
    deliveries.push({
      ...base,
      userId: Number(input.employeeUserId),
      title: notification.title,
      eventKey: notification.eventKey,
    });
  }

  const employeeName = safeLabel(input.employeeDisplayName, 60) ?? "موظّف";
  const movementLabel =
    input.movement === "ATTENDANCE_CHECK_IN" ? "سجل حضور" : "سجل انصراف";
  const seen = new Set<number>();
  for (const rawRecipientId of input.adminRecipientUserIds) {
    const recipientId = Number(rawRecipientId);
    if (
      !Number.isInteger(recipientId) ||
      recipientId <= 0 ||
      recipientId === input.employeeUserId ||
      seen.has(recipientId)
    ) {
      continue;
    }
    seen.add(recipientId);
    deliveries.push({
      ...base,
      userId: recipientId,
      title: `${employeeName} ${movementLabel}`.slice(0, 90),
      eventKey: `attendance-admin:${input.employeeId}:${input.attendanceDate}:${input.movement}:${recipientId}`,
    });
  }

  return deliveries;
}
