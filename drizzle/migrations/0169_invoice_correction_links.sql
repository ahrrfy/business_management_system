-- تصحيح الفاتورة (١٠/٨) — أساس البيانات: حالة SUPERSEDED + نسب التصحيح ثنائية الاتجاه.
--
-- النموذج (docs/invoice-correction-design-2026-08-10.md §١٠): «تصحيح» = عكسٌ كامل للأصل
-- (كمرتجعٍ بلا ردّ نقديّ) + إعادة إصدارٍ بفاتورةٍ جديدة، ذرّياً. الأصل يصير SUPERSEDED مربوطاً
-- بالجديدة (correctedByInvoiceId)، والجديدة تشير إلى الأصل (correctionOfInvoiceId).
--
-- FK ذاتيّ ON DELETE SET NULL: الفواتير لا تُحذف (سجلّ ماليّ إلحاقيّ)، لكن SET NULL دفاعٌ صريح
-- لا يمنع حذفاً نظرياً بترك رابطٍ معلَّق. الفهرسان لبحث النسب بلا مسحٍ كامل.
--
-- ⚠️ توسيع enum: `drizzle-kit push` لا يوسّع enum قائماً ⇒ للإنتاج تسري هذه الهجرة عبر migrator،
-- ولقاعدة الاختبار/CI (تُبنى بـpush) نسخةٌ مطابقة في extras/0168 (آخر ci-apply-extra-migrations).

ALTER TABLE `invoices` MODIFY COLUMN `invoiceStatus` ENUM(
  'PENDING','CONFIRMED','PAID','PARTIALLY_PAID','CANCELLED','RETURNED','SUPERSEDED'
) NOT NULL DEFAULT 'PENDING';--> statement-breakpoint
ALTER TABLE `invoices` ADD COLUMN `correctionOfInvoiceId` BIGINT NULL;--> statement-breakpoint
ALTER TABLE `invoices` ADD COLUMN `correctedByInvoiceId` BIGINT NULL;--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `fk_invoice_correction_of` FOREIGN KEY (`correctionOfInvoiceId`) REFERENCES `invoices`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `fk_invoice_corrected_by` FOREIGN KEY (`correctedByInvoiceId`) REFERENCES `invoices`(`id`) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `idx_invoice_correction_of` ON `invoices` (`correctionOfInvoiceId`);--> statement-breakpoint
CREATE INDEX `idx_invoice_corrected_by` ON `invoices` (`correctedByInvoiceId`);
