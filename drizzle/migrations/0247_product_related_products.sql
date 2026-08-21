SET NAMES utf8mb4;
--> statement-breakpoint

CREATE TABLE `productRelatedProducts` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `sourceProductId` bigint NOT NULL,
  `relatedProductId` bigint NOT NULL,
  `relationType` enum('COMPLETE_KIT','COMPATIBLE','SAME_THEME','UPSELL') NOT NULL DEFAULT 'COMPLETE_KIT',
  `sortOrder` int NOT NULL DEFAULT 0,
  `isActive` boolean NOT NULL DEFAULT true,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `productRelatedProducts_id` PRIMARY KEY(`id`),
  CONSTRAINT `uq_prod_related_pair` UNIQUE(`sourceProductId`,`relatedProductId`),
  CONSTRAINT `fk_rel_source_product`
    FOREIGN KEY (`sourceProductId`) REFERENCES `products` (`id`) ON DELETE cascade ON UPDATE no action,
  CONSTRAINT `fk_rel_target_product`
    FOREIGN KEY (`relatedProductId`) REFERENCES `products` (`id`) ON DELETE cascade ON UPDATE no action,
  CONSTRAINT `chk_prod_related_not_self` CHECK (`sourceProductId` <> `relatedProductId`)
);
--> statement-breakpoint

CREATE INDEX `idx_prod_related_source`
  ON `productRelatedProducts` (`sourceProductId`, `isActive`, `sortOrder`);
--> statement-breakpoint

CREATE INDEX `idx_prod_related_target`
  ON `productRelatedProducts` (`relatedProductId`);
