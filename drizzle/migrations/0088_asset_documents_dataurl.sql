-- 0088: عمود dataUrl على assetDocuments — رفع مستندات الأصل فعلياً (صورة base64 مضغوطة data-URL)
-- بلا بنية S3 (لا وجود لها في النظام)، على نمط productImages/receipts.attachmentUrl في MEDIUMTEXT.
-- ملاحظة MySQL 8: لا يدعم ADD COLUMN IF NOT EXISTS — الهجرة تُطبَّق مرة واحدة عبر drizzle migrator.
ALTER TABLE `assetDocuments` ADD COLUMN `dataUrl` MEDIUMTEXT NULL AFTER `fileKey`;
