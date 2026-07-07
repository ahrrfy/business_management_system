-- promotions v2 (٨/٧/٢٦، بعد gstack-review على PR #163): إعادة بناء العروض على فلسفة «نقطة العرض = نقطة الفرض»
-- ⇒ pos.ts يحلّ السعر المخصوم ويعيده للـPOS، فيبني الكاشير payment.amount من السعر المخصوم مباشرةً.
-- التخزين والقيود مماثلة للسابق مع تصحيحات gstack:
--   B11: `promotionDiscount` على invoiceItems صار NOT NULL (كان يقبل NULL بلا فائدة).
--   B11: `minLineAmount` على promotions صار NOT NULL DEFAULT '0' (كان يعطّل العرض بصمت عند NULL).

-- توسيع invoiceItems: عرض العرض المطبَّق + الخصم النقدي المتجمّد (لا يتأثر بتعديل العرض لاحقاً).
ALTER TABLE `invoiceItems` ADD `promotionId` bigint;--> statement-breakpoint
ALTER TABLE `invoiceItems` ADD `promotionDiscount` decimal(15,2) NOT NULL DEFAULT '0';--> statement-breakpoint
CREATE INDEX `idx_item_promotion` ON `invoiceItems` (`promotionId`);--> statement-breakpoint

CREATE TABLE `promotions` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`promotionType` enum('PERCENT','AMOUNT') NOT NULL,
	`discountPercent` decimal(5,2) NOT NULL DEFAULT '0',
	`discountAmount` decimal(15,2) NOT NULL DEFAULT '0',
	`promotionScope` enum('ALL','CATEGORIES','PRODUCTS') NOT NULL,
	`effectiveFrom` date NOT NULL,
	`effectiveTo` date,
	`promotionCustomerTier` enum('RETAIL','WHOLESALE','GOVERNMENT'),
	`branchId` bigint,
	-- gstack B11: NOT NULL DEFAULT '0' (كان nullable ⇒ مسند lte عار مع NULL يعطّل العرض بصمت).
	`minLineAmount` decimal(15,2) NOT NULL DEFAULT '0',
	`priority` int NOT NULL DEFAULT 0,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `promotions_id` PRIMARY KEY(`id`),
	-- شكل الخصم: PERCENT ⇒ 0<pct≤100 & amount=0. AMOUNT ⇒ amount>0 & pct=0.
	CONSTRAINT `chk_promo_shape` CHECK (
		(promotionType = 'PERCENT' AND discountPercent > 0 AND discountPercent <= 100 AND discountAmount = 0)
		OR (promotionType = 'AMOUNT' AND discountAmount > 0 AND discountPercent = 0)
	),
	CONSTRAINT `chk_promo_dates` CHECK (effectiveTo IS NULL OR effectiveTo >= effectiveFrom)
);--> statement-breakpoint
CREATE INDEX `idx_promo_active_dates` ON `promotions` (`isActive`,`effectiveFrom`,`effectiveTo`);--> statement-breakpoint
CREATE INDEX `idx_promo_scope` ON `promotions` (`promotionScope`);--> statement-breakpoint
CREATE INDEX `idx_promo_branch` ON `promotions` (`branchId`);--> statement-breakpoint
ALTER TABLE `promotions` ADD CONSTRAINT `fk_promo_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `promotions` ADD CONSTRAINT `fk_promo_creator` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE TABLE `promotionTargets` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`promotionId` bigint NOT NULL,
	`categoryId` bigint,
	`productId` bigint,
	`variantId` bigint,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `promotionTargets_id` PRIMARY KEY(`id`),
	CONSTRAINT `chk_promo_target_grain` CHECK (
		(CASE WHEN categoryId IS NOT NULL THEN 1 ELSE 0 END)
		+ (CASE WHEN productId IS NOT NULL THEN 1 ELSE 0 END)
		+ (CASE WHEN variantId IS NOT NULL THEN 1 ELSE 0 END) = 1
	)
);--> statement-breakpoint
CREATE INDEX `idx_promo_target_promo` ON `promotionTargets` (`promotionId`);--> statement-breakpoint
CREATE INDEX `idx_promo_target_category` ON `promotionTargets` (`categoryId`);--> statement-breakpoint
CREATE INDEX `idx_promo_target_product` ON `promotionTargets` (`productId`);--> statement-breakpoint
CREATE INDEX `idx_promo_target_variant` ON `promotionTargets` (`variantId`);--> statement-breakpoint
ALTER TABLE `promotionTargets` ADD CONSTRAINT `fk_promo_target_promo` FOREIGN KEY (`promotionId`) REFERENCES `promotions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `promotionTargets` ADD CONSTRAINT `fk_promo_target_category` FOREIGN KEY (`categoryId`) REFERENCES `categories`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `promotionTargets` ADD CONSTRAINT `fk_promo_target_product` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `promotionTargets` ADD CONSTRAINT `fk_promo_target_variant` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`) ON DELETE cascade ON UPDATE no action;
