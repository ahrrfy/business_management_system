-- 0045 (٤/٧/٢٦): جدول جديد `arReminders` — سجلّ تذكيرات الذمم الآجلة (مراجعة يدوية → واتساب).
-- يدوية (نمط 0037/0042/0044: snapshot مجمَّد عند 0034 ⇒ db:generate يُعيد إصدار كل جداول 0035-0044 مجدداً).
-- أُبقيت فقط عبارات `arReminders` الجديدة الفعلية، بصيغة IF NOT EXISTS الآمنة للتكرار.

CREATE TABLE IF NOT EXISTS `arReminders` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`customerId` bigint NOT NULL,
	`branchId` bigint NOT NULL,
	`totalUnpaidSnapshot` decimal(15,2) NOT NULL,
	`oldestInvoiceDate` date NOT NULL,
	`daysOverdue` int NOT NULL,
	`messageBody` text NOT NULL,
	`arReminderStatus` enum('SENT','SKIPPED') NOT NULL,
	`skipReason` varchar(255),
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `arReminders_id` PRIMARY KEY(`id`),
	CONSTRAINT `arReminders_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action,
	CONSTRAINT `arReminders_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action,
	CONSTRAINT `arReminders_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `idx_ar_reminders_customer_created` ON `arReminders` (`customerId`,`createdAt`);
--> statement-breakpoint
CREATE INDEX `idx_ar_reminders_branch_created` ON `arReminders` (`branchId`,`createdAt`);
