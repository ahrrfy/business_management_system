-- إضافة حقل رقم التتبع الخارجي لشركات التوصيل (اختياري)
-- يُسجَّل عند الإرسال أو يُحدَّث لاحقاً من قِبَل الكاشير أو المدير
ALTER TABLE `deliveryConsignments` ADD COLUMN `externalTrackingRef` varchar(100) NULL;
--> statement-breakpoint
CREATE INDEX `idx_consignment_ext_ref` ON `deliveryConsignments` (`externalTrackingRef`);
