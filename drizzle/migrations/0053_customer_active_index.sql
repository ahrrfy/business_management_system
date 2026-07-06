-- 0053 (٦/٧/٢٦): فهرس مفقود على customers.isActive — تدقيق فجوات ٦ عدسات (بند ٨).
-- (أُعيد الترقيم 0050→0051→0053: تصادما ترقيم متتاليان مع هجرات جلسات موازية مدموجة — 0050 TOTP ثم 0051 idempotency العملاء و0052 العمولات.)
-- getARAging (server/services/reports/arAging.ts) في مسار التجميع بلا فلتر فرع يُنفّذ
-- `WHERE c.isActive = TRUE` على جدول customers بلا فهرس داعم ⇒ full scan. نمط idempotency مطابق 0031/0013.

SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers' AND INDEX_NAME = 'idx_customer_active');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_customer_active` ON `customers` (`isActive`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
