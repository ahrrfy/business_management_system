ALTER TABLE `roles` ADD COLUMN `atomicPermissions` json NULL;
--> statement-breakpoint
ALTER TABLE `roles` ADD COLUMN `operationalCaps` json NULL;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `atomicPermissions` json NULL;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `operationalCaps` json NULL;
