-- 0267_delivery_outbox_dead_letter: attempt-cap + DEAD_LETTER status for outbox
--
-- الغرض (Tier-1 #1، تقرير مراجعة التوصيل ٢٥/٨): `outboxWorker.claimBatch` كان يزيد `attempts`
-- ويؤجّل ٥ دقائق على كلّ إخفاق بلا حدٍّ أعلى، بلا حالةٍ نهائيّة، بلا تنبيه ⇒ صفٌّ سامٌّ يُعاد
-- كلّ ٥ دقائق للأبد فيَكتب `lastError` بصمتٍ، ويُفوّت SLA على `delivery.failed`.
--
-- الحلّ:
-- 1) `status` (mysqlEnum PENDING/DEAD_LETTER) — الافتراض PENDING (لا تغيير سلوكيّ للصفوف القائمة).
-- 2) `deadLetteredAt` timestamp — يُوسم لحظة النقل، للتقرير الإداريّ.
-- 3) claimBatch يصفّي status='PENDING' — الرسائل المستنفَدة تخرج من الطابور تلقائياً.
-- 4) عند وصول `attempts` للحدّ الأعلى (MAX_ATTEMPTS = 10 في الخدمة) تُنقَل تلقائياً إلى DEAD_LETTER
--    بلا تدخّل خارجيّ. الاسترجاع بإجراءٍ إداريّ (`delivery.requeueDeadLetter`).
--
-- ⚠️ لا FK هنا؛ ALTER بسيط بلا statement-breakpoint خاصّ.
--
-- Idempotency: احرس بـinformation_schema (نمط 0180+). قد تُعاد عبر ci-apply-extra-migrations.

SET @status_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'deliveryOutbox'
    AND COLUMN_NAME = 'status'
);

SET @status_ddl := IF(
  @status_exists = 0,
  'ALTER TABLE `deliveryOutbox` ADD COLUMN `status` ENUM(''PENDING'',''DEAD_LETTER'') NOT NULL DEFAULT ''PENDING'' AFTER `lastError`',
  'SELECT 1'
);

PREPARE stmt FROM @status_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @dead_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'deliveryOutbox'
    AND COLUMN_NAME = 'deadLetteredAt'
);

SET @dead_ddl := IF(
  @dead_exists = 0,
  'ALTER TABLE `deliveryOutbox` ADD COLUMN `deadLetteredAt` TIMESTAMP NULL AFTER `status`',
  'SELECT 1'
);

PREPARE stmt FROM @dead_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'deliveryOutbox'
    AND INDEX_NAME = 'idx_delivery_outbox_status'
);

SET @idx_ddl := IF(
  @idx_exists = 0,
  'CREATE INDEX `idx_delivery_outbox_status` ON `deliveryOutbox` (`status`)',
  'SELECT 1'
);

PREPARE stmt FROM @idx_ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
