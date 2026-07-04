-- 0043 (٤/٧/٢٦): جدول جديد `taxSettings` (singleton id=1) — إعدادات الضريبة الافتراضية
-- (تفعيل + نسبة + الرقم الضريبي للشركة). يدوية (نمط 0037/0042: snapshot مجمَّد عند 0034 ⇒
-- db:generate يُعيد إصدار كل جداول/أعمدة 0035-0042 مجدداً — تجويهر معروف). أُبقي فقط على
-- عبارة `taxSettings` الجديدة الفعلية من مخرج db:generate، بصيغة IF NOT EXISTS الآمنة للتكرار.

CREATE TABLE IF NOT EXISTS `taxSettings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`enabledByDefault` boolean NOT NULL DEFAULT false,
	`defaultTaxRatePercent` decimal(5,2) NOT NULL DEFAULT '0',
	`taxRegistrationNumber` varchar(50),
	`updatedBy` int,
	`updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `taxSettings_id` PRIMARY KEY(`id`),
	CONSTRAINT `taxSettings_updatedBy_users_id_fk` FOREIGN KEY (`updatedBy`) REFERENCES `users`(`id`)
);
