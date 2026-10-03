-- يفصل دليل تنفيذ الحركة النقدية عن منشئ الطلب ومعتمده.
-- الحقول اختيارية لضمان التوافق مع السجلات التاريخية؛ التقارير تستخدم مسار fallback القديم عند غيابها.
ALTER TABLE `receipts`
  ADD COLUMN `executedBy` int NULL AFTER `approvedAt`,
  ADD COLUMN `executedAt` timestamp NULL AFTER `executedBy`,
  ADD CONSTRAINT `fk_receipts_executed_by`
    FOREIGN KEY (`executedBy`) REFERENCES `users` (`id`),
  ADD INDEX `idx_receipt_executed_at` (`executedAt`);
