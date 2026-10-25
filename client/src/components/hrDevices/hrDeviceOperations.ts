/** A failed refresh cannot prove that a physical device is disconnected. */
export function deviceConnectionFeedback(
  result: {
    isError: boolean;
  data?: ReadonlyArray<{ id: number; enabled: boolean; status: string | null }>;
  },
  deviceId: number,
): { kind: "ok" | "warn" | "err"; message: string } {
  if (result.isError)
    return {
      kind: "err",
      message:
        "تعذّر التحقق من اتصال الجهاز. أعد المحاولة بعد التحقق من اتصال النظام بالخادم.",
    };
  const device = result.data?.find((row) => row.id === deviceId);
  if (!device)
    return {
      kind: "warn",
      message: "الجهاز غير موجود في القائمة الحالية. حدّث قائمة الأجهزة.",
    };
  if (!device.enabled)
    return {
      kind: "warn",
      message: "الجهاز بانتظار الاعتماد؛ اعتمده قبل التحقق من استقبال بصماته.",
    };
  return device.status === "online"
    ? { kind: "ok", message: "الجهاز متصل ويستقبل الخادم إشاراته الآن" }
    : {
        kind: "warn",
        message: "لم تصل إشارة حديثة من الجهاز — راجع الشبكة وإعدادات الاتصال",
      };
}
