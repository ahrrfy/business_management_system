-- price-waves (٧/٧/٢٦): موجات تحديث الأسعار — تعديل جماعيّ لأسعار البيع بمعاينة ذرّية + سجلّ دائم.
-- السياق العراقي: أسعار السوق تتذبذب أسبوعياً؛ المدير يعدّل مجموعة منتجات دفعةً واحدة برؤية معاينة قبل الالتزام.

CREATE TABLE `priceUpdateWaves` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`priceChangeType` enum('INCREASE_PERCENT','DECREASE_PERCENT','INCREASE_AMOUNT','DECREASE_AMOUNT','SET_MARGIN') NOT NULL,
	`changeValue` decimal(15,2) NOT NULL,
	`filtersJson` text,
	`totalRows` int NOT NULL DEFAULT 0,
	`appliedBy` int NOT NULL,
	`appliedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `priceUpdateWaves_id` PRIMARY KEY(`id`),
	-- قيمة تغيير موجبة (السالب يُعبَّر بـDECREASE_*).
	CONSTRAINT `chk_wave_value_positive` CHECK (changeValue > 0),
	-- نسب معقولة: 0<pct≤1000 (الأمان + السماح بمضاعفة قصوى).
	CONSTRAINT `chk_wave_pct_bounds` CHECK (
		(priceChangeType IN ('INCREASE_PERCENT','DECREASE_PERCENT','SET_MARGIN') AND changeValue <= 1000)
		OR priceChangeType IN ('INCREASE_AMOUNT','DECREASE_AMOUNT')
	)
);--> statement-breakpoint
CREATE INDEX `idx_wave_applied_at` ON `priceUpdateWaves` (`appliedAt`);--> statement-breakpoint
CREATE INDEX `idx_wave_applied_by` ON `priceUpdateWaves` (`appliedBy`);--> statement-breakpoint
ALTER TABLE `priceUpdateWaves` ADD CONSTRAINT `fk_wave_applied_by` FOREIGN KEY (`appliedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE TABLE `priceChangeLog` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`productUnitId` bigint NOT NULL,
	`priceChangeTier` enum('RETAIL','WHOLESALE','GOVERNMENT') NOT NULL,
	`oldPrice` decimal(15,2),
	`newPrice` decimal(15,2) NOT NULL,
	`reason` varchar(255),
	`waveId` bigint,
	`actorUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `priceChangeLog_id` PRIMARY KEY(`id`),
	CONSTRAINT `chk_price_log_new_positive` CHECK (newPrice > 0)
);--> statement-breakpoint
CREATE INDEX `idx_price_log_unit_tier` ON `priceChangeLog` (`productUnitId`,`priceChangeTier`);--> statement-breakpoint
CREATE INDEX `idx_price_log_wave` ON `priceChangeLog` (`waveId`);--> statement-breakpoint
CREATE INDEX `idx_price_log_created` ON `priceChangeLog` (`createdAt`);--> statement-breakpoint
ALTER TABLE `priceChangeLog` ADD CONSTRAINT `fk_price_log_unit` FOREIGN KEY (`productUnitId`) REFERENCES `productUnits`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `priceChangeLog` ADD CONSTRAINT `fk_price_log_wave` FOREIGN KEY (`waveId`) REFERENCES `priceUpdateWaves`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `priceChangeLog` ADD CONSTRAINT `fk_price_log_actor` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
