-- image-studio Pro (0097): إعدادات الاستوديو المفردة (singleton id=1، نمط taxSettings) — مفتاح
-- remove.bg مُشفَّراً (AES-256-GCM عبر cryptoService) + مفتاح تفعيل مسار Pro. المفتاح لا يُعرَض
-- نصّاً أبداً (قناع). عند التعطيل/نفاد الرصيد يبقى FLATTEN المجانيّ افتراضياً. راجع
-- docs/product-image-studio-design-2026-07-21.md.
CREATE TABLE `imageStudioSettings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`proEnabled` boolean NOT NULL DEFAULT false,
	`encryptedRemovebgKey` text,
	`lastVerifiedAt` timestamp,
	`lastError` varchar(500),
	`updatedBy` int,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `imageStudioSettings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `imageStudioSettings` ADD CONSTRAINT `fk_imgstudio_updated_by` FOREIGN KEY (`updatedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
