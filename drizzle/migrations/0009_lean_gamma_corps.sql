ALTER TABLE `productImages` ADD `variantId` bigint;--> statement-breakpoint
ALTER TABLE `productImages` ADD CONSTRAINT `productImages_variantId_productVariants_id_fk` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_pimg_variant` ON `productImages` (`variantId`);