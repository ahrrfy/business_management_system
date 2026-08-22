-- فصل واجبات Product Studio: ثبّت آخر مرسل خادمياً كي لا يعتمد المنفذ عمله بعد تغيّر الإسناد.
SET NAMES utf8mb4;
--> statement-breakpoint

ALTER TABLE `productImageJobs`
  ADD COLUMN `submittedBy` INT NULL AFTER `submittedAt`,
  ADD COLUMN `processingLeaseTokenHash` VARCHAR(64) NULL AFTER `processingProofExpiresAt`,
  ADD COLUMN `processingLeaseExpiresAt` TIMESTAMP NULL AFTER `processingLeaseTokenHash`;
--> statement-breakpoint

-- حفظ أمان المهام التاريخية: أفضل هوية متاحة للمرشح القديم هي مالك المهمة وقت الإرسال.
UPDATE `productImageJobs`
SET `submittedBy` = `assignedTo`
WHERE `submittedAt` IS NOT NULL
  AND `submittedBy` IS NULL;
--> statement-breakpoint

ALTER TABLE `productImageJobs`
  ADD CONSTRAINT `fk_pijob_submitted_by`
    FOREIGN KEY (`submittedBy`) REFERENCES `users` (`id`);
--> statement-breakpoint

CREATE INDEX `idx_pijob_submitter_status`
  ON `productImageJobs` (`submittedBy`, `status`);
