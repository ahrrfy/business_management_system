// Lab-only access paths. The source schema and production database are untouched.
export const cashReadIndexes = [
 'CREATE INDEX IF NOT EXISTS cash_scope_invoice_source ON invoices(sourceId);',
 'CREATE INDEX IF NOT EXISTS cash_scope_item_invoice ON invoiceItems(invoiceId);',
 'CREATE INDEX IF NOT EXISTS cash_scope_redemption_invoice ON couponRedemptions(invoiceId);',
 'CREATE INDEX IF NOT EXISTS cash_scope_online_variant ON onlineOrderItems(variantId,onlineOrderId);',
 'CREATE INDEX IF NOT EXISTS cash_scope_online_branch ON onlineOrders(branchId,orderStatus,reservationExpiresAt);',
 'CREATE INDEX IF NOT EXISTS cash_scope_bundle_component ON bundleComponents(componentVariantId,bundleVariantId);',
 'CREATE INDEX IF NOT EXISTS cash_scope_winner_epoch ON cashCommands(json_extract(planJson,\'$.expectedEpoch\'));',
];
