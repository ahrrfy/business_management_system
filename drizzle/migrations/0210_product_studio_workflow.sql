-- تشغيل Product Studio: أولوية وموعد SLA وقفل تفاؤلي للتعديلات المتزامنة.
SET NAMES utf8mb4;
--> statement-breakpoint

ALTER TABLE `productImageJobs`
  ADD COLUMN `priority` ENUM('LOW','NORMAL','HIGH','URGENT') NOT NULL DEFAULT 'NORMAL' AFTER `status`,
  ADD COLUMN `dueAt` TIMESTAMP NULL AFTER `priority`,
  ADD COLUMN `revision` INT NOT NULL DEFAULT 1 AFTER `dueAt`;
--> statement-breakpoint

CREATE INDEX `idx_pijob_branch_priority_due`
  ON `productImageJobs` (`branchId`, `priority`, `dueAt`);
