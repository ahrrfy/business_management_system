-- 0026 (٢٤/٦/٢٦): تَكاملات القَنوات الخارِجية — بَدل .env إلى DB مُشَفَّر (شَريحة #6).
--
-- المُفتاح الرَئيسي وَحده يَبقى في .env: INTEGRATIONS_ENCRYPTION_KEY (32 bytes).
-- باقي الـsecrets (verifyToken/appSecret/accessToken) كلها مُشَفَّرة بـAES-256-GCM داخل DB.
--
-- لِماذا: المالك لا يَحتاج SSH لِلسيرفر عند كل تَغيير tokens — يَفتح /settings/integrations
-- كأَدمن، يَلصق، يَضغط «تَحقّق» (يَضرب Meta API فِعلياً)، يَحفظ. كل العَملية في الواجهة.
--
-- backup safety: مَلف backup مَكشوف بَلا المُفتاح ⇒ صَفر مَعلومات.
-- multi-branch: مُفتاح فَريد (branchId, channel) ⇒ WhatsApp مُختلف لـMAIN و SALES.
--
-- INSTANT DDL غَير مَضمون هُنا (TEXT + UNIQUE) ⇒ النَشر يَحتاج وَقتاً قَصيراً (~ث) على جَدول صَغير.

CREATE TABLE `channelIntegrations` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `branchId` bigint NOT NULL,
  `intChannel` enum('WHATSAPP','INSTAGRAM','STORE') NOT NULL,
  `displayName` varchar(120),
  `phoneNumberId` varchar(80),
  `encryptedVerifyToken` text,
  `encryptedAppSecret` text,
  `encryptedAccessToken` text,
  `intStatus` enum('PENDING','ACTIVE','FAILED','DISABLED') NOT NULL DEFAULT 'PENDING',
  `lastVerifiedAt` timestamp NULL,
  `lastError` varchar(500),
  `updatedBy` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `channelIntegrations_id` PRIMARY KEY(`id`),
  CONSTRAINT `uq_int_branch_channel` UNIQUE(`branchId`,`intChannel`),
  CONSTRAINT `channelIntegrations_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`),
  CONSTRAINT `channelIntegrations_updatedBy_users_id_fk` FOREIGN KEY (`updatedBy`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_int_status` ON `channelIntegrations` (`intStatus`);
