/**
 * Common rules for the human-entered evidence attached to a digital sale.
 *
 * This is deliberately an internal record only.  It does not call or validate
 * against a provider/platform API; it merely keeps the cashier, invoice and
 * reconciliation reports on the same normalized value.
 */
export function normalizeDigitalSaleReference(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, "");
}

export function digitalSaleReferenceLabel(offeringType: string | null | undefined): string {
  return offeringType === "EDUCATIONAL_SUBSCRIPTION"
    ? "رقم الاشتراك أو ID"
    : "رقم العملية أو ID الكرت";
}
