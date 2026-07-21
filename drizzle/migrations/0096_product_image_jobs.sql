-- image-studio (0096): طابور/سجلّ عمليات الاستوديو — يحتجز المرشّح المعالَج (processedUrl) حتى
-- الاعتماد (§٥ #١: لا يُجسَّد كصفّ productImages قابل للخدمة قبل المراجعة). أساس مسار المراجعة/الأسينك
-- (ش٢/Pro/CUT). راجع docs/product-image-studio-design-2026-07-21.md.
CREATE TABLE `productImageJobs` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`productId` bigint,
	`variantId` bigint,
	`sourceContentHash` varchar(64),
	`processedUrl` mediumtext,
	`mode` enum('FLATTEN','CUT','PRO') NOT NULL,
	`status` enum('PENDING_REVIEW','APPROVED','REJECTED','FAILED') NOT NULL DEFAULT 'PENDING_REVIEW',
	`templateVersion` int,
	`createdBy` int,
	`reviewedBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`reviewedAt` timestamp,
	CONSTRAINT `productImageJobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD CONSTRAINT `fk_pijob_product` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD CONSTRAINT `fk_pijob_variant` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD CONSTRAINT `fk_pijob_created_by` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `productImageJobs` ADD CONSTRAINT `fk_pijob_reviewed_by` FOREIGN KEY (`reviewedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_pijob_product` ON `productImageJobs` (`productId`);--> statement-breakpoint
CREATE INDEX `idx_pijob_status` ON `productImageJobs` (`status`);
