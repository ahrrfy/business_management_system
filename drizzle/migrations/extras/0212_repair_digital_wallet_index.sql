-- إصلاح دفاعي لقاعدة db:push في CI: أحياناً ينشئ MySQL فهرس FK افتراضياً لـwalletId
-- لكنه لا يحفظ الاسم التعاقدي idx_dwt_wallet الذي تعتمد عليه قراءات المحفظة واختبار الحماية.
-- هذه الهجرة idempotent وتبقي قواعد CI متطابقة مع مخطط الإنتاج.
SET @has_idx_dwt_wallet := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'digitalWalletTransactions'
    AND index_name = 'idx_dwt_wallet'
);

SET @sql_idx_dwt_wallet := IF(
  @has_idx_dwt_wallet = 0,
  'CREATE INDEX `idx_dwt_wallet` ON `digitalWalletTransactions` (`walletId`)',
  'SELECT 1'
);

PREPARE stmt_idx_dwt_wallet FROM @sql_idx_dwt_wallet;
EXECUTE stmt_idx_dwt_wallet;
DEALLOCATE PREPARE stmt_idx_dwt_wallet;

-- فهارس قوائم التشغيل الرقمية: db:push قد ينشئ أعمدة الجداول ولا يثبت الفهارس المسمّاة
-- في قواعد CI الجديدة. نصلح العقود الثلاثة idempotently في نفس مرحلة التهيئة.
SET @has_idx_dsi_status := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'digitalSaleIntents'
    AND index_name = 'idx_dsi_status'
);

SET @sql_idx_dsi_status := IF(
  @has_idx_dsi_status = 0,
  'CREATE INDEX `idx_dsi_status` ON `digitalSaleIntents` (`status`)',
  'SELECT 1'
);

PREPARE stmt_idx_dsi_status FROM @sql_idx_dsi_status;
EXECUTE stmt_idx_dsi_status;
DEALLOCATE PREPARE stmt_idx_dsi_status;

SET @has_idx_dpv_offering := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'digitalPriceVersions'
    AND index_name = 'idx_dpv_offering'
);

SET @sql_idx_dpv_offering := IF(
  @has_idx_dpv_offering = 0,
  'CREATE INDEX `idx_dpv_offering` ON `digitalPriceVersions` (`offeringId`)',
  'SELECT 1'
);

PREPARE stmt_idx_dpv_offering FROM @sql_idx_dpv_offering;
EXECUTE stmt_idx_dpv_offering;
DEALLOCATE PREPARE stmt_idx_dpv_offering;

-- عقود الفهارس الحرجة التي يفحصها db-verify-schema في CI. تُطبّق دائماً بعد db:push
-- لأن بعض نسخ Drizzle/MySQL قد تفوّت فهارس مركّبة أو فهارس أعمدة enum في قاعدة نظيفة.
SET @has_idx_receipt_bucket_status := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'receipts' AND index_name = 'idx_receipt_bucket_status'
);
SET @sql_idx_receipt_bucket_status := IF(
  @has_idx_receipt_bucket_status = 0,
  'CREATE INDEX `idx_receipt_bucket_status` ON `receipts` (`cashBucket`, `status`)',
  'SELECT 1'
);
PREPARE stmt_idx_receipt_bucket_status FROM @sql_idx_receipt_bucket_status;
EXECUTE stmt_idx_receipt_bucket_status;
DEALLOCATE PREPARE stmt_idx_receipt_bucket_status;

SET @has_idx_crm_campaign_branch_status := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'crmCampaigns' AND index_name = 'idx_crm_campaign_branch_status'
);
SET @sql_idx_crm_campaign_branch_status := IF(
  @has_idx_crm_campaign_branch_status = 0,
  'CREATE INDEX `idx_crm_campaign_branch_status` ON `crmCampaigns` (`branchId`, `status`)',
  'SELECT 1'
);
PREPARE stmt_idx_crm_campaign_branch_status FROM @sql_idx_crm_campaign_branch_status;
EXECUTE stmt_idx_crm_campaign_branch_status;
DEALLOCATE PREPARE stmt_idx_crm_campaign_branch_status;

SET @has_idx_promo_application := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'promotions' AND index_name = 'idx_promo_application'
);
SET @sql_idx_promo_application := IF(
  @has_idx_promo_application = 0,
  'CREATE INDEX `idx_promo_application` ON `promotions` (`applicationMode`, `isActive`)',
  'SELECT 1'
);
PREPARE stmt_idx_promo_application FROM @sql_idx_promo_application;
EXECUTE stmt_idx_promo_application;
DEALLOCATE PREPARE stmt_idx_promo_application;

SET @has_idx_delivery_remittance_line_cn := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'deliveryRemittanceLines' AND index_name = 'idx_delivery_remittance_line_cn'
);
SET @sql_idx_delivery_remittance_line_cn := IF(
  @has_idx_delivery_remittance_line_cn = 0,
  'CREATE INDEX `idx_delivery_remittance_line_cn` ON `deliveryRemittanceLines` (`consignmentId`, `createdAt`)',
  'SELECT 1'
);
PREPARE stmt_idx_delivery_remittance_line_cn FROM @sql_idx_delivery_remittance_line_cn;
EXECUTE stmt_idx_delivery_remittance_line_cn;
DEALLOCATE PREPARE stmt_idx_delivery_remittance_line_cn;

SET @has_idx_delivery_ledger_party_time := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'deliveryLedgerEntries' AND index_name = 'idx_delivery_ledger_party_time'
);
SET @sql_idx_delivery_ledger_party_time := IF(
  @has_idx_delivery_ledger_party_time = 0,
  'CREATE INDEX `idx_delivery_ledger_party_time` ON `deliveryLedgerEntries` (`partyId`, `occurredAt`)',
  'SELECT 1'
);
PREPARE stmt_idx_delivery_ledger_party_time FROM @sql_idx_delivery_ledger_party_time;
EXECUTE stmt_idx_delivery_ledger_party_time;
DEALLOCATE PREPARE stmt_idx_delivery_ledger_party_time;

SET @has_idx_delivery_event_cn_time := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'deliveryEvents' AND index_name = 'idx_delivery_event_cn_time'
);
SET @sql_idx_delivery_event_cn_time := IF(
  @has_idx_delivery_event_cn_time = 0,
  'CREATE INDEX `idx_delivery_event_cn_time` ON `deliveryEvents` (`consignmentId`, `occurredAt`)',
  'SELECT 1'
);
PREPARE stmt_idx_delivery_event_cn_time FROM @sql_idx_delivery_event_cn_time;
EXECUTE stmt_idx_delivery_event_cn_time;
DEALLOCATE PREPARE stmt_idx_delivery_event_cn_time;

SET @has_idx_delivery_outbox_pending := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'deliveryOutbox' AND index_name = 'idx_delivery_outbox_pending'
);
SET @sql_idx_delivery_outbox_pending := IF(
  @has_idx_delivery_outbox_pending = 0,
  'CREATE INDEX `idx_delivery_outbox_pending` ON `deliveryOutbox` (`processedAt`, `availableAt`)',
  'SELECT 1'
);
PREPARE stmt_idx_delivery_outbox_pending FROM @sql_idx_delivery_outbox_pending;
EXECUTE stmt_idx_delivery_outbox_pending;
DEALLOCATE PREPARE stmt_idx_delivery_outbox_pending;

SET @has_idx_exchange_custody_scope := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'exchangeTransactions' AND index_name = 'idx_exchange_custody_scope'
);
SET @sql_idx_exchange_custody_scope := IF(
  @has_idx_exchange_custody_scope = 0,
  'CREATE INDEX `idx_exchange_custody_scope` ON `exchangeTransactions` (`exchangeHouseId`, `branchId`, `status`, `currency`, `type`, `id`)',
  'SELECT 1'
);
PREPARE stmt_idx_exchange_custody_scope FROM @sql_idx_exchange_custody_scope;
EXECUTE stmt_idx_exchange_custody_scope;
DEALLOCATE PREPARE stmt_idx_exchange_custody_scope;
