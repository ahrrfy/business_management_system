-- نظام المهام الموحّد — ش١ (S2): الأساس فقط (جداول + صلاحيات + بذر — بلا خدمة/راوتر/شاشات، تُبنى
-- في مهام لاحقة). راجع docs/whatsapp-hub-design-2026-07-23.md §٣. خمسة جداول:
--   tasks: تذكرة موحّدة لكل طلب/تفاعل (خدمة/دعم/استفسار/متابعة/داخلية) بغضّ النظر عن مصدره
--     (واتساب/إنستغرام/تيكتوك/متجر/هاتف/حضوري/آخر) — قابلة للربط بعميل/مورّد/محادثة/أمر شغل/
--     فاتورة/عرض سعر. waitingSince/waitingAccumMs يوقفان عدّاد SLA أثناء انتظار ردّ العميل
--     (لا يُحتسَب الانتظار على الموظف). csatScore/csatRequestedAt لقياس رضا العميل عند الإغلاق.
--   taskEvents: سجلّ أحداث تسلسليّ (تعليق/تغيير حالة/إسناد/ربط/نظام/CSAT) — تدقيق كامل بلا حذف.
--   serviceTypes: أنواع خدمة مرجعية (تصنيف + أولوية افتراضية + SLA بالساعات) تُبذَر بخمسة أنواع أولية.
--   waKeywordRules: قواعد تصنيف تلقائي بكلمات مفتاحية لفرز رسائل واتساب الواردة إلى نوع مهمة
--     (عامة إن branchId=NULL، أو خاصة بفرع)، بترتيب أولوية تطبيق.
--   waHubSettings: إعدادات singleton (نمط openingModeSettings) لمركز واتساب الأعمال — وضع الفرز
--     (تلقائي كامل/كلمات مفتاحية فقط/يدوي)، ردود الترحيب/خارج الدوام، مفاتيح الأتمتة لكل تدفّق على
--     حدة (كلّها معطَّلة افتراضياً)، ومفتاح إيقاف طارئ (killSwitch) يوقف كل إرسال آلي.
-- serviceTypeId/conversationId/linkedWorkOrderId/linkedInvoiceId/linkedQuotationId روابط FK فعلية
-- (serviceTypes يُنشأ في هذه الهجرة نفسها؛ البقية جداول قائمة).
CREATE TABLE `tasks` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`taskNumber` varchar(40) NOT NULL,
	`branchId` bigint NOT NULL,
	`taskKind` enum('SERVICE_REQUEST','SUPPORT','INQUIRY','FOLLOW_UP','INTERNAL') NOT NULL DEFAULT 'INQUIRY',
	`taskStatus` enum('NEW','IN_PROGRESS','WAITING_CUSTOMER','RESOLVED','CANCELLED') NOT NULL DEFAULT 'NEW',
	`priority` enum('LOW','NORMAL','HIGH','URGENT') NOT NULL DEFAULT 'NORMAL',
	`title` varchar(200) NOT NULL,
	`description` text,
	`customerId` bigint,
	`supplierId` bigint,
	`conversationId` bigint,
	`linkedWorkOrderId` bigint,
	`linkedInvoiceId` bigint,
	`linkedQuotationId` bigint,
	`serviceTypeId` bigint,
	`sourceChannel` enum('WHATSAPP','INSTAGRAM','TIKTOK','STORE','PHONE','WALK_IN','OTHER'),
	`assignedTo` int,
	`createdBy` int,
	`dueAt` timestamp,
	`firstResponseAt` timestamp,
	`resolvedAt` timestamp,
	`waitingSince` timestamp,
	`waitingAccumMs` bigint NOT NULL DEFAULT 0,
	`csatScore` tinyint,
	`csatRequestedAt` timestamp,
	`reopenCount` int NOT NULL DEFAULT 0,
	`resolutionNote` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tasks_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_task_number` UNIQUE(`taskNumber`)
);
--> statement-breakpoint
CREATE TABLE `taskEvents` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`taskId` bigint NOT NULL,
	`eventType` enum('COMMENT','STATUS','ASSIGN','LINK','SYSTEM','CSAT') NOT NULL,
	`fromStatus` varchar(20),
	`toStatus` varchar(20),
	`note` text,
	`userId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `taskEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `serviceTypes` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`name` varchar(120) NOT NULL,
	`defaultKind` enum('SERVICE_REQUEST','SUPPORT','INQUIRY','FOLLOW_UP','INTERNAL') NOT NULL DEFAULT 'SERVICE_REQUEST',
	`defaultPriority` enum('LOW','NORMAL','HIGH','URGENT') NOT NULL DEFAULT 'NORMAL',
	`slaHours` int,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `serviceTypes_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_service_type_name` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `waKeywordRules` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`branchId` bigint,
	`pattern` varchar(190) NOT NULL,
	`matchKind` enum('SERVICE_REQUEST','SUPPORT','INQUIRY','FOLLOW_UP','INTERNAL') NOT NULL,
	`serviceTypeId` bigint,
	`priority` int NOT NULL DEFAULT 0,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `waKeywordRules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `waHubSettings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`triageMode` enum('AUTO_ALL','KEYWORD_ONLY','MANUAL') NOT NULL DEFAULT 'AUTO_ALL',
	`autoTaskEnabled` boolean NOT NULL DEFAULT true,
	`businessHoursJson` json,
	`afterHoursReply` text,
	`welcomeReply` text,
	`throttlePerMinute` int NOT NULL DEFAULT 10,
	`optOutKeywords` text,
	`campaignApprovalThreshold` int NOT NULL DEFAULT 500,
	`autoReplyAfterHours` boolean NOT NULL DEFAULT false,
	`autoReplyWelcome` boolean NOT NULL DEFAULT false,
	`flowArReminder` boolean NOT NULL DEFAULT false,
	`flowOrderReady` boolean NOT NULL DEFAULT false,
	`flowPurchaseThanks` boolean NOT NULL DEFAULT false,
	`flowConsignmentWithdraw` boolean NOT NULL DEFAULT false,
	`csatOnResolve` boolean NOT NULL DEFAULT false,
	`killSwitch` boolean NOT NULL DEFAULT false,
	`updatedBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `waHubSettings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_supplierId_suppliers_id_fk` FOREIGN KEY (`supplierId`) REFERENCES `suppliers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_conversationId_conversations_id_fk` FOREIGN KEY (`conversationId`) REFERENCES `conversations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_linkedWorkOrderId_workOrders_id_fk` FOREIGN KEY (`linkedWorkOrderId`) REFERENCES `workOrders`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_linkedInvoiceId_invoices_id_fk` FOREIGN KEY (`linkedInvoiceId`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_linkedQuotationId_quotations_id_fk` FOREIGN KEY (`linkedQuotationId`) REFERENCES `quotations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_serviceTypeId_serviceTypes_id_fk` FOREIGN KEY (`serviceTypeId`) REFERENCES `serviceTypes`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_assignedTo_users_id_fk` FOREIGN KEY (`assignedTo`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `taskEvents` ADD CONSTRAINT `taskEvents_taskId_tasks_id_fk` FOREIGN KEY (`taskId`) REFERENCES `tasks`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `taskEvents` ADD CONSTRAINT `taskEvents_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `waKeywordRules` ADD CONSTRAINT `waKeywordRules_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `waKeywordRules` ADD CONSTRAINT `waKeywordRules_serviceTypeId_serviceTypes_id_fk` FOREIGN KEY (`serviceTypeId`) REFERENCES `serviceTypes`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `waHubSettings` ADD CONSTRAINT `waHubSettings_updatedBy_users_id_fk` FOREIGN KEY (`updatedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_task_branch_status` ON `tasks` (`branchId`,`taskStatus`);--> statement-breakpoint
CREATE INDEX `idx_task_assignee` ON `tasks` (`assignedTo`,`taskStatus`);--> statement-breakpoint
CREATE INDEX `idx_task_customer` ON `tasks` (`customerId`);--> statement-breakpoint
CREATE INDEX `idx_task_conv` ON `tasks` (`conversationId`);--> statement-breakpoint
CREATE INDEX `idx_task_events_task` ON `taskEvents` (`taskId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_wa_kw_active` ON `waKeywordRules` (`isActive`,`priority`);
