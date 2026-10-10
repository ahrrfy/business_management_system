ALTER TABLE `promotions` ADD `maxDiscountAmount` decimal(15,2);
--> statement-breakpoint
ALTER TABLE `promotions` ADD `minOrderSpend` decimal(15,2) NOT NULL DEFAULT '0.00';
--> statement-breakpoint
ALTER TABLE `promotions` ADD `freeShipping` boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE `promotions` ADD `shippingDiscountAmount` decimal(15,2) NOT NULL DEFAULT '0.00';
--> statement-breakpoint
ALTER TABLE `couponPrograms` ADD `affiliateName` varchar(255);
--> statement-breakpoint
ALTER TABLE `couponPrograms` ADD `affiliatePhone` varchar(32);
--> statement-breakpoint
ALTER TABLE `couponPrograms` ADD `affiliateCommissionRate` decimal(5,2) NOT NULL DEFAULT '0.00';
--> statement-breakpoint
ALTER TABLE `couponRedemptions` ADD `affiliateCommissionAmount` decimal(15,2) NOT NULL DEFAULT '0.00';
