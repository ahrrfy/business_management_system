-- البث التسويقي (S5، T5.1): جدولا waBroadcasts/waBroadcastRecipients — قناة تنفيذ مراسلة جماعية
-- عبر واتساب فوق عالم crmCampaigns القائم (لا تكراراً له — crmCampaignId رابط اختياري للعزو
-- التقريري فقط). الشريحة تُبنى وقت الإنشاء/الإطلاق عبر باني RFM حيّ (segmentService.ts) على
-- customers/invoices، والقالب يُشترَط من فئة MARKETING ومُعتمَداً فعلياً عند Meta (waTemplates).
-- اعتماد ثانٍ إلزامي (Maker-Checker) فوق عتبة حجم الجمهور (waHubSettings.campaignApprovalThreshold)
-- — بلا استثناء لـadmin (قرار مالك موثَّق، خلافاً لنمط السندات المعتاد SOD-04). استبعاد
-- waConsent='OPTED_OUT' حتميٌّ دائماً في باني الشريحة — لا مسار يتجاوزه.
-- التقطير الفعلي (إدراج صفوف waBroadcastRecipients دفعة-دفعة + إرسالها عبر waOutbox) والقاطع
-- الآلي (جودة/شكاوى) خارج نطاق هذه الهجرة — T5.2.
CREATE TABLE `waBroadcasts` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`branchId` bigint,
	`crmCampaignId` bigint,
	`name` varchar(160) NOT NULL,
	`templateId` bigint NOT NULL,
	`templateLang` varchar(10) NOT NULL DEFAULT 'ar',
	`varsMapJson` json,
	`segmentJson` json NOT NULL,
	`broadcastStatus` enum('DRAFT','PENDING_APPROVAL','APPROVED','RUNNING','PAUSED','COMPLETED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
	`audienceCount` int NOT NULL DEFAULT 0,
	`costEstimate` decimal(15,2) NOT NULL DEFAULT '0',
	`throttlePerMinute` int NOT NULL DEFAULT 10,
	`scheduledAt` timestamp,
	`pausedReason` varchar(200),
	`createdBy` int,
	`approvedBy` int,
	`startedAt` timestamp,
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `waBroadcasts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `waBroadcastRecipients` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`broadcastId` bigint NOT NULL,
	`customerId` bigint,
	`phoneE164` varchar(20) NOT NULL,
	`recipientStatus` enum('PENDING','QUEUED','SENT','DELIVERED','READ','FAILED','SKIPPED_OPTOUT') NOT NULL DEFAULT 'PENDING',
	`outboxId` bigint,
	`wamid` varchar(200),
	`errorCode` varchar(20),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `waBroadcastRecipients_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_wa_broadcast_recipient` UNIQUE(`broadcastId`,`phoneE164`)
);
--> statement-breakpoint
ALTER TABLE `waBroadcasts` ADD CONSTRAINT `waBroadcasts_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `waBroadcasts` ADD CONSTRAINT `waBroadcasts_crmCampaignId_crmCampaigns_id_fk` FOREIGN KEY (`crmCampaignId`) REFERENCES `crmCampaigns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `waBroadcasts` ADD CONSTRAINT `waBroadcasts_templateId_waTemplates_id_fk` FOREIGN KEY (`templateId`) REFERENCES `waTemplates`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `waBroadcasts` ADD CONSTRAINT `waBroadcasts_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `waBroadcasts` ADD CONSTRAINT `waBroadcasts_approvedBy_users_id_fk` FOREIGN KEY (`approvedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `waBroadcastRecipients` ADD CONSTRAINT `waBroadcastRecipients_broadcastId_waBroadcasts_id_fk` FOREIGN KEY (`broadcastId`) REFERENCES `waBroadcasts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `waBroadcastRecipients` ADD CONSTRAINT `waBroadcastRecipients_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_wa_broadcast_status` ON `waBroadcasts` (`broadcastStatus`);--> statement-breakpoint
CREATE INDEX `idx_wa_broadcast_recip_pick` ON `waBroadcastRecipients` (`broadcastId`,`recipientStatus`);
