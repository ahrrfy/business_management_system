-- بنك جهات الاتصال — ش١ (S3): أعمدة الموافقة التسويقية على العميل/المورّد + جدول أشخاص الاتصال
-- B2B، أساسٌ فقط (بلا خدمة/راوتر/شاشات — تُبنى في مهام لاحقة). راجع docs/whatsapp-hub-design-2026-07-23.md.
--   customers.waConsent/waConsentAt/waConsentSource + نظيرهما على suppliers: حالة موافقة تسويق
--     واتساب (UNKNOWN افتراضياً حتى تصريح صريح أو التقاط كلمة إلغاء اشتراك تلقائي من الوارد).
--   contactPersons: شخص اتصال مربوط بعميل أو مورّد (لا كليهما — يُفرض تطبيقياً، لا قيد CHECK على
--     MySQL) — جهة تواصل فعلية داخل مؤسسة الطرف (مفوّض/محاسب/مدير مشتريات…) بهاتف مستقلّ. بلا
--     searchNorm (تعقيد زائد لحجم بيانات صغير؛ البحث لاحقاً على name/phone مباشرة).
-- ⚠️ MySQL 8 لا يدعم ADD COLUMN IF NOT EXISTS — الإضافة صريحة (نمط 0091/0102/0106).
ALTER TABLE `customers` ADD `waConsent` enum('UNKNOWN','OPTED_IN','OPTED_OUT') NOT NULL DEFAULT 'UNKNOWN';--> statement-breakpoint
ALTER TABLE `customers` ADD `waConsentAt` timestamp;--> statement-breakpoint
ALTER TABLE `customers` ADD `waConsentSource` varchar(40);--> statement-breakpoint
ALTER TABLE `suppliers` ADD `waConsent` enum('UNKNOWN','OPTED_IN','OPTED_OUT') NOT NULL DEFAULT 'UNKNOWN';--> statement-breakpoint
ALTER TABLE `suppliers` ADD `waConsentAt` timestamp;--> statement-breakpoint
ALTER TABLE `suppliers` ADD `waConsentSource` varchar(40);--> statement-breakpoint
CREATE TABLE `contactPersons` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`customerId` bigint,
	`supplierId` bigint,
	`name` varchar(160) NOT NULL,
	`phone` varchar(20),
	`role` varchar(60),
	`isPrimary` boolean NOT NULL DEFAULT false,
	`notes` varchar(255),
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `contactPersons_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `contactPersons` ADD CONSTRAINT `contactPersons_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contactPersons` ADD CONSTRAINT `contactPersons_supplierId_suppliers_id_fk` FOREIGN KEY (`supplierId`) REFERENCES `suppliers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_contact_person_customer` ON `contactPersons` (`customerId`);--> statement-breakpoint
CREATE INDEX `idx_contact_person_supplier` ON `contactPersons` (`supplierId`);--> statement-breakpoint
CREATE INDEX `idx_contact_person_phone` ON `contactPersons` (`phone`);
