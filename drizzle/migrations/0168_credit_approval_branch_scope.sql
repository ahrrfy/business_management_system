-- قرارات الائتمان: ربط القرار بفرعٍ صريح حتى لا يستهلكه فرع آخر.
-- نحاول استنتاج الصفوف التاريخية من الفاتورة المستهلكة أولاً ثم فرع المُصدِر.
ALTER TABLE `creditApprovals`
  ADD COLUMN `branchId` BIGINT NULL AFTER `customerId`,
  ADD CONSTRAINT `fk_credit_approval_branch`
    FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`);

UPDATE `creditApprovals` ca
LEFT JOIN `invoices` i ON i.`id` = ca.`consumedByInvoiceId`
LEFT JOIN `users` u ON u.`id` = ca.`approvedBy`
SET ca.`branchId` = COALESCE(i.`branchId`, u.`branchId`)
WHERE ca.`branchId` IS NULL;

-- موافقة تاريخية نشطة بلا فرع لا يجوز أن تبقى قابلة للاستهلاك بعد تفعيل العزل.
UPDATE `creditApprovals`
SET
  `consumedAt` = CURRENT_TIMESTAMP,
  `notes` = LEFT(CONCAT_WS('\n', NULLIF(`notes`, ''), 'أُغلقت آلياً: قرار تاريخي بلا نطاق فرع'), 255)
WHERE `branchId` IS NULL AND `consumedAt` IS NULL;

CREATE INDEX `idx_capp_branch_expiry`
  ON `creditApprovals` (`branchId`, `expiresAt`);
