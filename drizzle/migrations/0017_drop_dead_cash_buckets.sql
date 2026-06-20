-- 0017 (٢٠/٦/٢٦): إزالة نظام «صناديق النقد» الميّت (CASH-CORE POC غير المُتبنّى).
-- cashOps/cashReconcile لم يُوصَلا بأي راوتر/واجهة قط؛ الأعمدة bucketId/pairToken/balanceAfter
-- كلّها NULL في الإنتاج (لم تُكتَب أبداً) ولا FK عليها. cashBucket (DRAWER/TREASURY) يبقى — حيّ.
-- لا FK من receipts→cashBuckets (مرجع ناعم)، فلا حاجة لـDROP FOREIGN KEY.
DROP INDEX `idx_receipt_bucket` ON `receipts`;--> statement-breakpoint
DROP INDEX `idx_receipt_pair` ON `receipts`;--> statement-breakpoint
DROP INDEX `idx_receipt_bucket_status` ON `receipts`;--> statement-breakpoint
ALTER TABLE `receipts` DROP COLUMN `bucketId`;--> statement-breakpoint
ALTER TABLE `receipts` DROP COLUMN `pairToken`;--> statement-breakpoint
ALTER TABLE `receipts` DROP COLUMN `balanceAfter`;--> statement-breakpoint
DROP TABLE IF EXISTS `cashBuckets`;
