-- Persist applicant ownership independently from an optional vacancy. This
-- keeps general applications and applicants detached by vacancy deletion in
-- the correct branch queue without exposing branchless legacy records.
ALTER TABLE `jobApplicants`
  ADD COLUMN `branchId` bigint NULL AFTER `jobTitle`;
--> statement-breakpoint
UPDATE `jobApplicants` AS applicant
INNER JOIN `jobVacancies` AS vacancy ON vacancy.`id` = applicant.`vacancyId`
SET applicant.`branchId` = vacancy.`branchId`
WHERE applicant.`branchId` IS NULL AND vacancy.`branchId` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `jobApplicants`
  ADD CONSTRAINT `fk_jobApplicant_branch`
  FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `idx_applicant_branch`
  ON `jobApplicants` (`branchId`, `createdAt`);
