-- مركز واتساب الأعمال — ش١ (S1): نواة WhatsApp Cloud API فوق بنية الـinbox القائمة (conversations/
-- conversationMessages/channelIntegrations). راجع docs/whatsapp-hub-design-2026-07-23.md §٣.
-- إسناد محادثة لموظف + مرساة نافذة الردّ الحرّ ٢٤ساعة (lastInboundAt) + ربط اختياري بمورّد (محادثات B2B)؛
-- توسعة الرسائل بأختام Cloud API (waTimestamp/statusUpdatedAt) + سبب فشل + اسم قالب + مصدر الرسالة (origin)؛
-- توسعة channelIntegrations بمعرّف WABA وقاعدة API (حيادية المزوّد — NULL = graph.facebook.com الافتراضي).
-- ثلاثة جداول جديدة: waOutbox (طابور الإرسال الصادر مع إعادة محاولة/جدولة/idempotency)، waMedia (وسائط
-- الرسائل الواردة/الصادرة base64)، waWebhookEvents (سجلّ خام لأحداث الـwebhook الواردة). campaignId/taskId
-- في waOutbox روابط منطقية فقط (الجدولان محجوزان لشرائح S2/S5 لاحقاً) — بلا FK فعلي حتى تُنشأ.
-- ⚠️ MySQL 8 لا يدعم ADD COLUMN IF NOT EXISTS — الإضافة صريحة (نمط 0091/0102).
ALTER TABLE `conversations` ADD `assignedTo` int;--> statement-breakpoint
ALTER TABLE `conversations` ADD `lastInboundAt` timestamp;--> statement-breakpoint
ALTER TABLE `conversations` ADD `supplierId` bigint;--> statement-breakpoint
ALTER TABLE `conversations` ADD CONSTRAINT `conversations_assignedTo_users_id_fk` FOREIGN KEY (`assignedTo`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversations` ADD CONSTRAINT `conversations_supplierId_suppliers_id_fk` FOREIGN KEY (`supplierId`) REFERENCES `suppliers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversationMessages` ADD `waTimestamp` timestamp;--> statement-breakpoint
ALTER TABLE `conversationMessages` ADD `statusUpdatedAt` timestamp;--> statement-breakpoint
ALTER TABLE `conversationMessages` ADD `errorCode` varchar(20);--> statement-breakpoint
ALTER TABLE `conversationMessages` ADD `templateName` varchar(128);--> statement-breakpoint
ALTER TABLE `conversationMessages` ADD `origin` enum('API','PHONE_APP','SYSTEM');--> statement-breakpoint
ALTER TABLE `channelIntegrations` ADD `wabaId` varchar(80);--> statement-breakpoint
ALTER TABLE `channelIntegrations` ADD `apiBaseUrl` varchar(160);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `waOutbox` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`branchId` bigint NOT NULL,
	`dedupeKey` varchar(190) NOT NULL,
	`conversationId` bigint,
	`toPhoneE164` varchar(20),
	`kind` enum('SESSION_TEXT','TEMPLATE','MEDIA','MEDIA_FETCH') NOT NULL,
	`payloadJson` json NOT NULL,
	`templateName` varchar(128),
	`templateLang` varchar(10),
	`status` enum('QUEUED','SENDING','SENT','FAILED','CANCELLED') NOT NULL DEFAULT 'QUEUED',
	`attempts` int NOT NULL DEFAULT 0,
	`nextAttemptAt` timestamp,
	`lastError` varchar(500),
	`wamid` varchar(200),
	`campaignId` bigint,
	`taskId` bigint,
	`scheduledAt` timestamp,
	`createdBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `waOutbox_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_wa_outbox_dedupe` UNIQUE(`dedupeKey`)
);
--> statement-breakpoint
CREATE INDEX `idx_wa_outbox_pick` ON `waOutbox` (`status`,`nextAttemptAt`);--> statement-breakpoint
CREATE INDEX `idx_wa_outbox_wamid` ON `waOutbox` (`wamid`);--> statement-breakpoint
CREATE INDEX `idx_wa_outbox_campaign` ON `waOutbox` (`campaignId`,`status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `waMedia` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`messageId` bigint NOT NULL,
	`mimeType` varchar(80) NOT NULL,
	`bytesBase64` mediumtext NOT NULL,
	`sizeBytes` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `waMedia_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_wa_media_message` UNIQUE(`messageId`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `waWebhookEvents` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`channel` varchar(20) NOT NULL,
	`integrationId` bigint,
	`payloadJson` json NOT NULL,
	`status` enum('PENDING','PROCESSED','FAILED') NOT NULL DEFAULT 'PENDING',
	`attempts` int NOT NULL DEFAULT 0,
	`lastError` varchar(500),
	`receivedAt` timestamp NOT NULL DEFAULT (now()),
	`processedAt` timestamp,
	CONSTRAINT `waWebhookEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_wa_events_pick` ON `waWebhookEvents` (`status`,`receivedAt`);
