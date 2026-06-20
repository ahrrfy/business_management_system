-- 0020 (٢٠/٦/٢٦): الأدوار الديناميكية المخصّصة (طلب المالك: إضافة/تعديل أدوار بصلاحيات محفوظة).
-- جدول `roles` للأدوار المخصّصة (المبنية تبقى في الكود). `users.customRoleId` يربط مستخدماً بدور
-- مخصّص؛ يُحلّ في context إلى role=baseRole + permissionsOverride مشتقّ ⇒ لا تغيير في requireModule.
-- إضافة عمود + جدول = آمنة بلا فقد بيانات (المستخدمون الحاليون customRoleId=NULL ⇒ سلوك مطابق).
CREATE TABLE `roles` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`key` varchar(64) NOT NULL,
	`label` varchar(120) NOT NULL,
	`description` text,
	`baseRole` enum('user','admin','manager','cashier','warehouse','accountant','print_operator','sales_rep','purchasing','auditor') NOT NULL DEFAULT 'user',
	`permissions` json NOT NULL,
	`canSeeCost` boolean NOT NULL DEFAULT false,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `roles_id` PRIMARY KEY(`id`),
	CONSTRAINT `roles_key_unique` UNIQUE(`key`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `customRoleId` bigint;
