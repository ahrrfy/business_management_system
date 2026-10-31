ALTER TABLE `employeeAdvances`
  ADD COLUMN `advanceSourceType` enum('SALARY_ADVANCE','OTHER_DEDUCTION','LEGACY_UNCLASSIFIED') NOT NULL DEFAULT 'LEGACY_UNCLASSIFIED' AFTER `monthlyDeduction`,
  ADD COLUMN `payrollPeriod` varchar(7) NULL AFTER `advanceSourceType`,
  ADD CONSTRAINT `chk_employee_advance_period`
    CHECK (`payrollPeriod` IS NULL OR `payrollPeriod` REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  ADD CONSTRAINT `chk_employee_advance_source_period`
    CHECK (
      (`advanceSourceType` = 'SALARY_ADVANCE' AND `payrollPeriod` IS NOT NULL)
      OR (`advanceSourceType` IN ('OTHER_DEDUCTION','LEGACY_UNCLASSIFIED') AND `payrollPeriod` IS NULL)
    ),
  ADD KEY `idx_advance_emp_period_status` (`employeeId`, `payrollPeriod`, `advanceStatus`, `id`),
  ADD KEY `idx_advance_period_source_status` (`advanceSourceType`, `payrollPeriod`, `advanceStatus`, `id`);
