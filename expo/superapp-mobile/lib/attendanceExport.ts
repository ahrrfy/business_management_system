import * as FileSystem from "expo-file-system/legacy";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";

import { buildAttendancePdfHtml } from "@/lib/attendancePdf";
import type { MobileAttendanceHistory } from "@/lib/secureTransportPayload";

/**
 * A PDF is generated inside the app's cache only after an active secure
 * session has already supplied the personal history. Nothing is uploaded,
 * saved to shared downloads, or retained after the platform share sheet
 * returns. The user chooses the receiving app explicitly.
 */
export async function exportPersonalAttendancePdf(input: {
  employeeName: string;
  history: MobileAttendanceHistory;
}): Promise<void> {
  if (input.history.personal.state !== "READY" || input.history.personal.entries.length === 0) {
    throw new Error("لا يوجد سجل حضور متاح لتصديره.");
  }
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error("المشاركة غير متاحة على هذا الجهاز.");
  }

  const result = await Print.printToFileAsync({
    html: buildAttendancePdfHtml(input),
    base64: false,
  });
  try {
    await Sharing.shareAsync(result.uri, {
      dialogTitle: "مشاركة كشف الحضور الشخصي",
      mimeType: "application/pdf",
      UTI: "com.adobe.pdf",
    });
  } finally {
    // `shareAsync` hands the selected target a copy. The app's temporary PDF
    // must not survive in cache after either sharing or cancelling the sheet.
    await FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => undefined);
  }
}
