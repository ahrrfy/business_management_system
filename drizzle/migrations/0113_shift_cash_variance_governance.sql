-- 0113: حوكمة فروقات درج النقد.
-- لا نملأ الحقول رجعياً كي لا ننسب تفسيراً أو اعتماداً لم يحدث تاريخياً.
ALTER TABLE `shifts`
  ADD COLUMN `varianceReasonCode` enum(
    'COUNT_ERROR',
    'UNRECORDED_SALE',
    'UNRECORDED_CASH_IN',
    'UNRECORDED_CASH_OUT',
    'CHANGE_FUND_TRANSFER',
    'OFFLINE_SALE',
    'REFUND_ERROR',
    'OTHER'
  ) NULL,
  ADD COLUMN `varianceReason` varchar(500) NULL,
  ADD COLUMN `reconciliationStatus` enum('MATCHED','EXPLAINED','MANAGER_APPROVED') NULL,
  ADD COLUMN `closedByUserId` int NULL,
  ADD COLUMN `varianceReviewedByUserId` int NULL,
  ADD CONSTRAINT `shifts_closedByUserId_users_id_fk`
    FOREIGN KEY (`closedByUserId`) REFERENCES `users`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT `shifts_varianceReviewedByUserId_users_id_fk`
    FOREIGN KEY (`varianceReviewedByUserId`) REFERENCES `users`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;
