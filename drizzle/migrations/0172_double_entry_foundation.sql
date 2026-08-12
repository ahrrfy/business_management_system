-- أساس الدفتر المزدوج (P2) — خطة docs/double-entry-p2-plan-2026-08-11.md، الشريحة ٠.
--
-- سبب الوجود: محرّك القيود المزدوجة (P1، server/services/accounting/postingEngine.ts) وحدةٌ
-- **نقيّة لا تكتب**، وشجرة الحسابات (accounts، هجرة 0115) قائمةٌ بلا قيدٍ واحدٍ فيها ⇒ النظام
-- لا يُخرج ميزان مراجعةٍ ولا دفتر أستاذٍ بالشكل المحاسبيّ القياسيّ. هذه الهجرة تُنشئ **وعاء**
-- القيود المزدوجة وعلَم أوضاعها؛ التوصيل الفعليّ في الشريحة ١ (خطّاف الظلّ).
--
-- ⚠️ إضافيّة بحتة: لا عمودٌ قائم يُعدَّل، ولا جدولٌ قائم يُمَسّ، ولا سلوكُ قيدٍ حاليٍّ يتغيّر.
-- الوضع الافتراضيّ OFF ⇒ النشر بصفر أثرٍ إنتاجيّ، والتراجع بالعودة إليه.
--
-- FK بأسماء صريحة قصيرة: الاسم التلقائيّ يتجاوز ٦٤ محرفاً على MySQL 8.4 فيُفشل db:push الطازج
-- (العلّة الموثَّقة في docs/local-test-db.md).
CREATE TABLE `journalEntries` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `entryId` bigint NOT NULL,
  `entryDate` date NOT NULL,
  `branchId` bigint,
  `status` enum('POSTED','UNMAPPED') NOT NULL DEFAULT 'POSTED',
  `unmappedReason` varchar(255),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `journalEntries_id` PRIMARY KEY(`id`),
  -- صفر ازدواج بنيوياً: قيدٌ مزدوجٌ واحدٌ لكل حدثٍ ماليّ (لا يعتمد على فحصٍ تطبيقيّ).
  CONSTRAINT `uq_journal_entry` UNIQUE(`entryId`),
  -- CASCADE إلزاميّ: upsertOpeningEntry يحذف صفوف accountingEntries فعلاً (openingBalance.ts)
  -- ⇒ RESTRICT كان سيُفشل حذف رصيدٍ افتتاحيّ ويكسر عمليةً قائمة.
  CONSTRAINT `fk_journal_entry`
    FOREIGN KEY (`entryId`) REFERENCES `accountingEntries`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
-- يخدم ميزان المراجعة (نطاق تاريخ) وعدّاد الفجوات (بوّابة ACTIVE) معاً.
CREATE INDEX `idx_journal_date_status` ON `journalEntries` (`entryDate`,`status`);
--> statement-breakpoint
CREATE TABLE `journalLines` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `journalId` bigint NOT NULL,
  `role` varchar(40) NOT NULL,
  `debit` decimal(15,2) NOT NULL DEFAULT '0',
  `credit` decimal(15,2) NOT NULL DEFAULT '0',
  CONSTRAINT `journalLines_id` PRIMARY KEY(`id`),
  CONSTRAINT `fk_journal_line`
    FOREIGN KEY (`journalId`) REFERENCES `journalEntries`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
-- تجميع ميزان المراجعة حسب الدور النظاميّ.
CREATE INDEX `idx_journal_line_role` ON `journalLines` (`role`);
--> statement-breakpoint
CREATE TABLE `doubleEntrySettings` (
  `id` int NOT NULL DEFAULT 1,
  `mode` enum('OFF','SHADOW','ACTIVE') NOT NULL DEFAULT 'OFF',
  `shadowStartedAt` timestamp NULL,
  `updatedBy` int,
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `doubleEntrySettings_id` PRIMARY KEY(`id`),
  CONSTRAINT `fk_de_settings_user`
    FOREIGN KEY (`updatedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
-- الصفّ المفرد بالوضع الآمن. IGNORE ليبقى التطبيق تكرارياً (idempotent) على قاعدةٍ سبق تهيئتها.
INSERT IGNORE INTO `doubleEntrySettings` (`id`,`mode`) VALUES (1,'OFF');
