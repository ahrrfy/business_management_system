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
