-- 0380 — فصلُ عكس عهدة مرتجع البيع عن تحرير التعرّض وتسوية العجز.
--
-- `COD_RELEASED` حدثُ تعرّض فقط (إلغاء/رجوع/سداد كاونتري) ولا يعني خروج نقدٍ من يد الجهة.
-- لذلك يلزم حدثان صريحان للمرتجع:
--   • COD_RETURNED: نقدٌ كان بعهدة الجهة ثم عاد سببه بمرتجع، بلا دخول درج المكتبة.
--   • SHORTFALL_SETTLED: عجزٌ غير نقدي زال بمرتجع، بلا شطب خسارة وبلا حركة درج.
-- التطبيق idempotent لأن بيئات الإنتاج قد تعيد تشغيل الهجرة بعد انقطاع.

SET @db := DATABASE();

SET @has_return_types := (
  SELECT IF(
    LOCATE('COD_RETURNED', COLUMN_TYPE) > 0
      AND LOCATE('SHORTFALL_SETTLED', COLUMN_TYPE) > 0,
    1, 0
  )
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'deliveryLedgerEntries'
    AND COLUMN_NAME = 'entryType'
);

SET @sql := IF(
  @has_return_types = 1,
  'SELECT ''deliveryLedgerEntries.entryType already has return settlement types''',
  'ALTER TABLE `deliveryLedgerEntries` MODIFY COLUMN `entryType` ENUM(''COD_ASSIGNED'', ''COD_COLLECTED'', ''COD_REMITTED'', ''COD_RETURNED'', ''COD_RELEASED'', ''COD_WRITTEN_OFF'', ''COD_RECOVERED'', ''SHORTFALL_ASSIGNED'', ''SHORTFALL_SETTLED'', ''FEE_EARNED'', ''FEE_PAID'', ''FEE_OFFSET'', ''FEE_REFUNDED'') NOT NULL'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
