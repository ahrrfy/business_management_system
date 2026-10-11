ALTER TABLE `storefrontProductReviews` MODIFY COLUMN `customerId` bigint;
--> statement-breakpoint
ALTER TABLE `storefrontProductReviews` MODIFY COLUMN `onlineOrderId` bigint;
--> statement-breakpoint
ALTER TABLE `storefrontProductReviews` ADD COLUMN `reviewerName` varchar(255);
--> statement-breakpoint
ALTER TABLE `storefrontProductReviews` ADD COLUMN `reviewerPhone` varchar(32);
