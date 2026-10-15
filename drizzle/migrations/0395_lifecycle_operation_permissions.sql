-- NULL keeps the existing authorization path until an administrator saves a policy.
ALTER TABLE `roles` ADD COLUMN `operationPolicy` json NULL;
--> statement-breakpoint
ALTER TABLE `roles` ADD COLUMN `operationPolicyRevision` int NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `operationPolicy` json NULL;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `operationPolicyRevision` int NOT NULL DEFAULT 0;
