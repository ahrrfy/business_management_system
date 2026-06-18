-- G11+G12 (١٩/٦/٢٦): فهارس حرجة لتقارير الإنتاج + إصلاح UNIQUE على payrollRuns.
-- مصدر التشخيص: تدقيق المرحلة ٤ (اعتمادية وضغط).

-- ١. receipts.shiftId — Z-report لكل إغلاق وردية يستعلم على shiftId.
--    بلا فهرس = full scan على نصف مليون إيصال يومياً (متجر 200 فاتورة/يوم × 5 سنوات).
CREATE INDEX `idx_receipt_shift` ON `receipts` (`shiftId`);
--> statement-breakpoint

-- ٢. receipts (bucketId, status) — cashReconcile يفلتر COMPLETED قبل التجميع.
CREATE INDEX `idx_receipt_bucket_status` ON `receipts` (`bucketId`, `status`);
--> statement-breakpoint

-- ٣. accountingEntries.branchId — GL/P&L/الميزانية/كشوف الحساب تستعلم على branchId.
--    بلا فهرس = full scan على مليون قيد لكل تقرير.
CREATE INDEX `idx_entry_branch` ON `accountingEntries` (`branchId`);
--> statement-breakpoint

-- ٤. invoices composite indexes — AR aging و Daily Sales.
CREATE INDEX `idx_invoice_status_customer` ON `invoices` (`status`, `customerId`);
--> statement-breakpoint
CREATE INDEX `idx_invoice_branch_date` ON `invoices` (`branchId`, `invoiceDate`);
--> statement-breakpoint

-- ٥. purchaseOrders composite — AP aging.
CREATE INDEX `idx_po_supplier_status` ON `purchaseOrders` (`supplierId`, `status`);
--> statement-breakpoint

-- ٦. payrollRuns UNIQUE خاطئ بنيوياً: UNIQUE(period) وحده يمنع فرعَين من توليد مسيّر
--    رواتب لنفس الشهر. التغيير لـUNIQUE(period, branchId) — كل فرع يحتاج مسيّره الشهري.
ALTER TABLE `payrollRuns` DROP INDEX `uq_payroll_period`;
--> statement-breakpoint
ALTER TABLE `payrollRuns` ADD CONSTRAINT `uq_payroll_period_branch` UNIQUE (`period`, `branchId`);
