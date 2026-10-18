// Only these transport/concurrency outcomes may replay the saved full command.
// An HTTP status or retryWithOriginalRequest flag alone never authorizes retry.
export function cashRetryKind(status, code) {
  if (status === 409 && ["STALE_SNAPSHOT_RETRY_SAME_REQUEST", "RECOVERY_PREFIX_PENDING_RETRY_SAME_REQUEST"].includes(code))
    return "concurrency";
  if ((status === 503 && ["D1_ERROR: Network connection lost.", "HTTP_TRANSPORT_UNCERTAIN", "CASH_WRITER_UNAVAILABLE", "CASH_WRITER_EXECUTION_UNCERTAIN"].includes(code)) ||
      ([502,503,504].includes(status) && code === "EDGE_TRANSPORT_UNCERTAIN"))
    return "transport";
  return null;
}
