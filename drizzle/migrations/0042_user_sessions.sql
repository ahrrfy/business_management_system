-- 0042 (٣/٧/٢٦): جدول جديد `userSessions` — تتبّع الجلسات الفردية لشاشة «عرض/إلغاء
-- الجلسات النشطة» (§٦ الخطوة التالية المقترحة). يدوية (نمط 0037: جدول جديد بسيط، لا
-- حاجة لتحصين انحراف — لا db:generate لأن snapshot مُجمَّد عند 0034).

CREATE TABLE IF NOT EXISTS `userSessions` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`userAgent` varchar(255),
	`ipAddress` varchar(45),
	`createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`lastSeenAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`expiresAt` timestamp NOT NULL,
	`revokedAt` timestamp,
	CONSTRAINT `userSessions_id` PRIMARY KEY(`id`),
	INDEX `idx_user_sessions_user` (`userId`),
	INDEX `idx_user_sessions_active` (`userId`,`revokedAt`,`expiresAt`),
	CONSTRAINT `userSessions_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`)
);
