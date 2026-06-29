-- 0030 (٢٩/٦/٢٦): إصلاح علّة فهرس حيّة — `idx_receipt_bucket_status` مفقود في الإنتاج.
-- الجذر: 0013 أنشأ الفهرس على العمود `bucketId` (نظام دلاء النقد القديم الذي كان موجوداً آنذاك)،
-- ثم 0017 (drop_dead_cash_buckets) حذف ذلك العمود ⇒ أسقط MySQL الفهرس معه تلقائياً، ولم يُعَد
-- إنشاؤه على العمود البديل `cashBucket` (enum DRAWER/TREASURY) ⇒ استعلامات الخزينة/حالة الإيصال
-- بلا فهرس. (`db:verify` يفحص الأعمدة لا الفهارس ⇒ بقي العطل غير مرئي — يُعالَج في شريحة الوقاية.)
-- الإصلاح: إعادة إنشاء `idx_receipt_bucket_status` على `(cashBucket, receiptStatus)` بالاسم الصحيح، idempotent.
-- ملاحظة: S1 يضيف لاحقاً مركّبات المدى الأقوى — `(shiftId, createdAt)` و`(branchId, cashBucket, createdAt)`
-- و`(invoiceId, receiptStatus)` — التي تخدم تسويات الخزينة وZ-report ونطاقات التاريخ بكفاءة أعلى.
--
-- نمط idempotency (مطابق 0013): كل خطوة = ٥ chunks مفصولة بفاصل التقسيم القياسي، لأنّ drizzle
-- migrator + mysql2 (multipleStatements:false) ينفّذ كل chunk كجملة SQL واحدة.
-- أسماء أعمدة DB لا JS: `receiptStatus` (لا `status`)، `cashBucket`.

SET @x := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'receipts' AND INDEX_NAME = 'idx_receipt_bucket_status');
--> statement-breakpoint
SET @s := IF(@x = 0, 'CREATE INDEX `idx_receipt_bucket_status` ON `receipts` (`cashBucket`, `receiptStatus`)', 'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @s;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
