ALTER TABLE `exchangeTransactions` ADD COLUMN `executionSeq` bigint NULL;
--> statement-breakpoint
ALTER TABLE `exchangeTransactions` ADD COLUMN `executedAt` timestamp(3) NULL;
