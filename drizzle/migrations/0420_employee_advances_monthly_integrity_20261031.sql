ALTER TABLE `employeeLoanRequests`
  ADD COLUMN `payrollPeriod` varchar(7) NULL AFTER `monthlyDeduction`,
  ADD COLUMN `clientRequestId` varchar(80) NULL AFTER `payrollPeriod`,
  ADD COLUMN `disbursedById` int NULL AFTER `reviewedAt`,
  ADD COLUMN `disbursedAt` timestamp NULL AFTER `disbursedById`,
  ADD COLUMN `receiptId` bigint NULL AFTER `disbursedAt`,
  ADD CONSTRAINT `fk_emp_loan_req_disbursed_by`
    FOREIGN KEY (`disbursedById`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT `fk_emp_loan_req_receipt`
    FOREIGN KEY (`receiptId`) REFERENCES `receipts` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT `chk_emp_loan_req_period`
    CHECK (`payrollPeriod` IS NULL OR `payrollPeriod` REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  ADD UNIQUE KEY `uq_emp_loan_req_client` (`clientRequestId`),
  ADD KEY `idx_emp_loan_req_period_status` (`employeeId`, `payrollPeriod`, `status`);
