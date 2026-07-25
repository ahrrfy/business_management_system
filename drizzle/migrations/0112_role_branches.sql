-- RBAC ش٦ — نطاق الفرع متعدّد القيم (أساسٌ خاملٌ مؤجَّل التفعيل). جدول ربطٍ يحدّد فروع الدور الصريحة
-- عند تفعيل «فروع محدّدة». **غير موصولٍ بأي مخنق إنفاذ بعد** ⇒ صفر أثر سلوكيّ؛ التفعيل حملةٌ واعية
-- تحوّل مخانق العزل الـ٧٣ إلى فحص عضوية. جدولٌ فارغٌ = لا قيد ⇒ كل الأدوار تبقى بسلوكها الحاليّ.
-- إضافيّة بحتة (CREATE TABLE)، عكسها DROP TABLE — صفر أثر على أي بيانات قائمة.
CREATE TABLE `roleBranches` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`roleId` bigint NOT NULL,
	`branchId` bigint NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `roleBranches_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_role_branch` UNIQUE(`roleId`,`branchId`)
);
--> statement-breakpoint
ALTER TABLE `roleBranches` ADD CONSTRAINT `roleBranches_roleId_roles_id_fk` FOREIGN KEY (`roleId`) REFERENCES `roles`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `roleBranches` ADD CONSTRAINT `roleBranches_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE cascade ON UPDATE no action;
