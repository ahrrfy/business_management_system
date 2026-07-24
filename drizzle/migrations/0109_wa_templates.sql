-- بنية قوالب Meta (مركز واتساب الأعمال — S4، T4.1): جدول waTemplates يخزّن قوالب الرسائل المعتمَدة
-- من Meta (نُتزامن معه عبر GET /{wabaId}/message_templates) لاستعمالها في الإرسال خارج نافذة ٢٤
-- ساعة (تذكيرات آجلة/إشعارات جاهزية/حملات — S4/S5 لاحقاً). name+language مميّزان على مستوى WABA
-- (وثيقة Meta) ⇒ UNIQUE مركّب. bodyText/variableCount مُستخرَجان من componentsJson (type=BODY)
-- وقت المزامنة لعرض/تعبئة سريعة بلا تفكيك JSON في كل استهلاك.
-- + عمود sentVia على arReminders/apReminders: يميّز تذكيراً أُرسِل يدوياً (من شاشة المتابعة القائمة)
-- عن تذكير سيُرسَل عبر Cloud API/قالب معتمَد (S4/S5) — NULL للتذكيرات القديمة (يدويّة قبل هذه الهجرة).
-- ⚠️ MySQL 8 لا يدعم ADD COLUMN IF NOT EXISTS — الإضافة صريحة (نمط 0091/0102/0106/0108).
CREATE TABLE `waTemplates` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`branchId` bigint,
	`name` varchar(128) NOT NULL,
	`language` varchar(10) NOT NULL DEFAULT 'ar',
	`category` enum('MARKETING','UTILITY','AUTHENTICATION') NOT NULL DEFAULT 'UTILITY',
	`templateStatus` enum('PENDING','APPROVED','REJECTED','PAUSED','DISABLED') NOT NULL DEFAULT 'PENDING',
	`bodyText` text,
	`componentsJson` json,
	`variableCount` int NOT NULL DEFAULT 0,
	`qualityScore` varchar(20),
	`syncedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `waTemplates_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_wa_template_name_lang` UNIQUE(`name`,`language`)
);
--> statement-breakpoint
ALTER TABLE `waTemplates` ADD CONSTRAINT `waTemplates_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_wa_template_status` ON `waTemplates` (`templateStatus`);--> statement-breakpoint
ALTER TABLE `arReminders` ADD `sentVia` enum('MANUAL','API');--> statement-breakpoint
ALTER TABLE `apReminders` ADD `sentVia` enum('MANUAL','API');
