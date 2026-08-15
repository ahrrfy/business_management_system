-- حالات صريحة لدورة اعتماد المصروفات. السجلات القديمة تبقى ACTIVE بلا أي أثر رجعي.
-- PENDING_APPROVAL/REJECTED لا تمثلان مصروفاً مرحّلاً؛ ACTIVE وحدها تعني تنفيذ الأثر المالي.

SET @expense_status_ready := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'expenses'
    AND COLUMN_NAME = 'expenseStatus'
    AND COLUMN_TYPE LIKE '%PENDING_APPROVAL%'
    AND COLUMN_TYPE LIKE '%REJECTED%'
);
SET @ddl := IF(
  @expense_status_ready = 0,
  'ALTER TABLE `expenses` MODIFY COLUMN `expenseStatus` ENUM(''PENDING_APPROVAL'',''ACTIVE'',''REJECTED'',''CANCELLED'') NOT NULL DEFAULT ''ACTIVE''',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
