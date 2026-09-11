import * as FileSystem from "expo-file-system/legacy";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";

import { buildPersonalPayslipPdfHtml } from "@/lib/payslipPdf";
import type { MobilePayslip } from "@/lib/secureTransportPayload";

/**
 * The sensitive PDF stays in app cache and is removed once the user closes the
 * platform chooser. Sharing is explicit: no URL, public download, or automatic
 * save is created.
 */
export async function exportPersonalPayslipPdf(input: {
  employeeName: string;
  payslip: NonNullable<MobilePayslip["personal"]["payslip"]>;
}): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error("المشاركة غير متاحة على هذا الجهاز.");
  }
  const result = await Print.printToFileAsync({
    html: buildPersonalPayslipPdfHtml(input),
    base64: false,
  });
  try {
    await Sharing.shareAsync(result.uri, {
      dialogTitle: "مشاركة قسيمة الراتب الشخصية",
      mimeType: "application/pdf",
      UTI: "com.adobe.pdf",
    });
  } finally {
    await FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => undefined);
  }
}
