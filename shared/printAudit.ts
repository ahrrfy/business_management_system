export const PRINT_DOCUMENT_TYPES = [
  "PURCHASE_RETURN",
  "EXCHANGE_TRANSACTION",
  "VOUCHER",
  "CUSTOMER_STATEMENT",
  "SUPPLIER_STATEMENT",
] as const;

export type PrintDocumentType = (typeof PRINT_DOCUMENT_TYPES)[number];
export type PrintChannel = "BROWSER" | "PDF" | "THERMAL" | "SERVER_BRIDGE";
export type PrintOutcome =
  | "REQUESTED"
  | "DIALOG_OPENED"
  | "DISPATCHED"
  | "FAILED";

export const PRINT_FAILURE_CODES = [
  "UNKNOWN",
  "POPUP_BLOCKED",
  "PRINT_FAILED",
  "NETWORK_ERROR",
  "PRINT_ABORTED",
  "PRINT_NOT_ALLOWED",
] as const;

export type PrintFailureCode = (typeof PRINT_FAILURE_CODES)[number];
export type PrintTransportVia = "server" | "thermal" | "browser";
export type PrintOpenResult =
  | boolean
  | { via: PrintTransportVia; ok?: boolean };
export type PrintAuditCompletion =
  | { outcome: "DIALOG_OPENED" | "DISPATCHED" }
  | { outcome: "FAILED"; failureCode: PrintFailureCode };

const failureCodeSet = new Set<string>(PRINT_FAILURE_CODES);

/** لا يسمح بتحويل رسالة خطأ أو حمولة طابعة إلى سجل التدقيق. */
export function sanitizePrintFailureCode(
  value?: string | null,
): PrintFailureCode {
  const candidate = value?.trim().toUpperCase();
  return candidate && candidate.length <= 32 && failureCodeSet.has(candidate)
    ? (candidate as PrintFailureCode)
    : "UNKNOWN";
}

export function printFailureCodeFromError(error: unknown): PrintFailureCode {
  const name = error instanceof Error ? error.name : "";
  if (name === "NetworkError") return "NETWORK_ERROR";
  if (name === "AbortError") return "PRINT_ABORTED";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "PRINT_NOT_ALLOWED";
  return "PRINT_FAILED";
}

/**
 * DISPATCHED يعني نجاح تسليم المهمة لناقل مباشر فقط. نجاح boolean لا يثبت ذلك،
 * وقنوات المتصفح/PDF لا تتجاوز DIALOG_OPENED حتى لو أعاد المستدعي via غير متوقع.
 */
export function derivePrintAuditOutcome(
  channel: PrintChannel,
  result: PrintOpenResult,
): PrintAuditCompletion {
  const via = typeof result === "boolean" ? null : result.via;
  const ok = typeof result === "boolean" ? result : result.ok !== false;
  if (!ok) {
    return {
      outcome: "FAILED",
      failureCode:
        via === "browser" || channel === "BROWSER" || channel === "PDF"
          ? "POPUP_BLOCKED"
          : "PRINT_FAILED",
    };
  }
  if (
    channel === "BROWSER" ||
    channel === "PDF" ||
    via == null ||
    via === "browser"
  ) {
    return { outcome: "DIALOG_OPENED" };
  }
  return { outcome: "DISPATCHED" };
}
