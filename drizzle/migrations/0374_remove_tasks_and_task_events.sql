-- 0367_remove_tasks_and_task_events.sql
-- الاستئصال الذري الشامل لوحدة المهام والتذاكر (tasks & taskEvents) وفك الارتباط التام

-- ١. فحص وإسقاط أي قيد مفتاح أجنبي يربط workOrderDesignApprovals بجدول tasks
SET @fk_name := (
  SELECT CONSTRAINT_NAME
  FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'workOrderDesignApprovals'
    AND COLUMN_NAME = 'taskId'
    AND REFERENCED_TABLE_NAME = 'tasks'
  LIMIT 1
);

SET @drop_fk := IF(
  @fk_name IS NOT NULL,
  CONCAT('ALTER TABLE `workOrderDesignApprovals` DROP FOREIGN KEY `', @fk_name, '`'),
  'SELECT 1'
);
PREPARE stmt FROM @drop_fk;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ٢. فحص وإسقاط الفهرس على عمود taskId إن وُجد
SET @has_task_idx := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'workOrderDesignApprovals'
    AND INDEX_NAME = 'idx_wo_design_approval_task'
);
SET @drop_idx := IF(
  @has_task_idx > 0,
  'ALTER TABLE `workOrderDesignApprovals` DROP INDEX `idx_wo_design_approval_task`',
  'SELECT 1'
);
PREPARE stmt FROM @drop_idx;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ٣. فحص وإسقاط عمود taskId من جدول workOrderDesignApprovals
SET @has_task_col := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'workOrderDesignApprovals'
    AND COLUMN_NAME = 'taskId'
);
SET @drop_col := IF(
  @has_task_col > 0,
  'ALTER TABLE `workOrderDesignApprovals` DROP COLUMN `taskId`',
  'SELECT 1'
);
PREPARE stmt FROM @drop_col;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- ٤. إسقاط جدول taskEvents إن وُجد
DROP TABLE IF EXISTS `taskEvents`;
--> statement-breakpoint

-- ٥. إسقاط جدول tasks إن وُجد
DROP TABLE IF EXISTS `tasks`;
