-- 0084: ربط تسويات السلف بمسيّر الرواتب (تدقيق ١٧/٧) لمنع الخصم المضاعف.
-- السيناريو: دفع مسيّر يُنقص remaining السلفة، ثم عكسه→حذفه، ثم إعادة توليد مسيّر جديد (isFirstPay=true)
-- يُنقصها ثانيةً. الحلّ: عند الدفع نُسجّل كل تسوية سلفة (runId, advanceId, amount)؛ وعند **حذف** المسيّر
-- (لا عكسه — إعادة الدفع لا تُعيد التسوية) نستعيد remaining من هذه السجلّات. CASCADE على runId شبكة أمان.
CREATE TABLE `advanceSettlements` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`runId` bigint NOT NULL,
	`advanceId` bigint NOT NULL,
	`employeeId` bigint NOT NULL,
	`amount` decimal(15,2) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `advanceSettlements_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `advanceSettlements` ADD CONSTRAINT `advanceSettlements_runId_payrollRuns_id_fk` FOREIGN KEY (`runId`) REFERENCES `payrollRuns`(`id`) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE `advanceSettlements` ADD CONSTRAINT `advanceSettlements_advanceId_employeeAdvances_id_fk` FOREIGN KEY (`advanceId`) REFERENCES `employeeAdvances`(`id`);
--> statement-breakpoint
CREATE INDEX `idx_advsettle_run` ON `advanceSettlements` (`runId`);
