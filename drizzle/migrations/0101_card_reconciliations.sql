-- حساب البطاقة/البنك — لقطات مطابقة كشف البنك/البطاقة (card-account slice).
-- رصيد حساب البطاقة **مشتقّ** من receipts (paymentMethod='CARD'، approvalStatus='APPROVED') — لا جدول رصيد
-- مخزَّن (نفس نمط الخزينة/الدرج القائم). هذا الجدول يحفظ لقطات المطابقة الدورية فقط: المتوقَّع (النظام)
-- مقابل كشف البنك الفعليّ عند تاريخٍ محدَّد — سجلّ تدقيقيّ لا يمسّ أي رصيد.
CREATE TABLE `cardReconciliations` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`branchId` bigint NOT NULL,
	`asOfDate` date NOT NULL,
	`systemBalance` decimal(15,2) NOT NULL,
	`statementBalance` decimal(15,2) NOT NULL,
	`difference` decimal(15,2) NOT NULL,
	`statementLabel` varchar(120),
	`note` text,
	`createdBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `cardReconciliations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `cardReconciliations` ADD CONSTRAINT `cardReconciliations_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cardReconciliations` ADD CONSTRAINT `cardReconciliations_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_cardrecon_branch` ON `cardReconciliations` (`branchId`,`asOfDate`);--> statement-breakpoint
CREATE INDEX `idx_cardrecon_created` ON `cardReconciliations` (`createdAt`);--> statement-breakpoint
-- فهرس أداء على receipts القائم: مسح مقبوضات/مدفوعات البطاقة لكل فرع×تاريخ (رصيد حساب البطاقة المشتقّ).
CREATE INDEX `idx_receipt_paymethod_branch_date` ON `receipts` (`paymentMethod`,`branchId`,`createdAt`);
