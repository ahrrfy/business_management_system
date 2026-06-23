-- 0025 (٢٣/٦/٢٦): صَندوق الوارد المُوحَّد — قَنوات + محادثات + رَسائل.
--
-- المَنطق: كل قَناة (WhatsApp/Instagram/متجر/هاتف/حُضوري) تَصبّ في «محادثة» واحدة لِلعَميل.
-- المُحادثة = مَوضوع مفتوح بَين خِدمة العُملاء وزَبون عبر قَناة مُحدَّدة. تَجمع رَسائل
-- IN (مِن العَميل) و OUT (مِن مُوظَّفنا) و NOTE (مُلاحظة داخِلية).
--
-- تَدخل بَطريقَين:
--   ١) Webhook مِن مَنصّة القَناة (يَحتاج HMAC verify + tokens مِن المالك لاحقاً).
--   ٢) إدخال يَدوي مِن مُوظَّف (اتصال هاتفي/حُضوري).
--
-- الفُروع: مَعزولة per branchId (IDOR-safe per branchScopedProcedure).
-- التَكَرار: UNIQUE(channel, channelHandle, branchId) ⇒ webhook مُكَرَّر لا يُنشئ سجلّاً ثانياً.
-- dedup الرَسائل: UNIQUE(externalId) ⇒ retries مُزوّد لا تُكرّر رَسالة.

CREATE TABLE `conversations` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `branchId` bigint NOT NULL,
  `convChannel` enum('WHATSAPP','INSTAGRAM','TIKTOK','STORE','PHONE','WALK_IN','OTHER') NOT NULL,
  `channelHandle` varchar(120) NOT NULL,
  `customerId` bigint,
  `displayName` varchar(200),
  `linkedWorkOrderId` bigint,
  `unreadCount` int NOT NULL DEFAULT 0,
  `lastMessageAt` timestamp NULL,
  `lastMessagePreview` varchar(280),
  `convStatus` enum('OPEN','ARCHIVED','CLOSED') NOT NULL DEFAULT 'OPEN',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `conversations_id` PRIMARY KEY(`id`),
  CONSTRAINT `uq_conv_channel_handle` UNIQUE(`convChannel`,`channelHandle`,`branchId`),
  CONSTRAINT `conversations_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`),
  CONSTRAINT `conversations_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`),
  CONSTRAINT `conversations_linkedWorkOrderId_workOrders_id_fk` FOREIGN KEY (`linkedWorkOrderId`) REFERENCES `workOrders`(`id`)
);
CREATE INDEX `idx_conv_branch` ON `conversations` (`branchId`,`convStatus`,`lastMessageAt`);
CREATE INDEX `idx_conv_customer` ON `conversations` (`customerId`);

CREATE TABLE `conversationMessages` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `conversationId` bigint NOT NULL,
  `msgDirection` enum('IN','OUT','NOTE') NOT NULL,
  `body` text,
  `mediaUrl` text,
  `mediaType` varchar(40),
  `externalId` varchar(200),
  `authorUserId` int,
  `msgDelivery` enum('PENDING','SENT','DELIVERED','READ','FAILED'),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `conversationMessages_id` PRIMARY KEY(`id`),
  CONSTRAINT `uq_msg_external` UNIQUE(`externalId`),
  CONSTRAINT `conversationMessages_conversationId_conversations_id_fk` FOREIGN KEY (`conversationId`) REFERENCES `conversations`(`id`) ON DELETE cascade,
  CONSTRAINT `conversationMessages_authorUserId_users_id_fk` FOREIGN KEY (`authorUserId`) REFERENCES `users`(`id`)
);
CREATE INDEX `idx_msg_conv` ON `conversationMessages` (`conversationId`,`createdAt`);
