ALTER TABLE `users` ADD `pinHash` varchar(255);
--> statement-breakpoint
ALTER TABLE `users` ADD `badgeBarcode` varchar(64);
--> statement-breakpoint
ALTER TABLE `users` ADD CONSTRAINT `users_badgeBarcode_unique` UNIQUE(`badgeBarcode`);
