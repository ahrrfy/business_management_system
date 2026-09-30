ALTER TABLE `attendance` ADD `branchId` bigint;
--> statement-breakpoint
UPDATE `attendance` a JOIN `employees` e ON a.employeeId = e.id SET a.branchId = e.branchId WHERE a.branchId IS NULL;
--> statement-breakpoint
UPDATE `attendance` SET `branchId` = 1 WHERE `branchId` IS NULL;
--> statement-breakpoint
ALTER TABLE `attendance` MODIFY `branchId` bigint NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `attendance` ADD CONSTRAINT `attendance_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX `idx_attendance_branch` ON `attendance` (`branchId`);
