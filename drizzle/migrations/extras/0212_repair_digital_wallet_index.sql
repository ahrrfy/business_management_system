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
