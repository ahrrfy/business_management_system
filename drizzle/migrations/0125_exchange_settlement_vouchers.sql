-- 0125: تسديد المورد عبر الصيرفة يصبح سند صرف موحّداً ومرئياً في السندات وكشف المورد.
-- لا نعيد تحريك أي رصيد تاريخي: الـbackfill توثيقي/ترابطي فقط لأن أثر المورد والصيرفة سبق ترحيله.
ALTER TABLE `receipts`
  MODIFY COLUMN `paymentMethod`
    ENUM('CASH','CARD','CHECK','TRANSFER','WALLET','EXCHANGE') NOT NULL;

INSERT INTO `receipts` (
  `branchId`, `shiftId`, `direction`, `amount`, `paymentMethod`, `cashBucket`,
  `referenceNumber`, `receiptStatus`, `voucherNumber`, `voucherPartyType`, `partyId`,
  `description`, `createdBy`, `createdAt`, `voucherDate`,
  `receiptApprovalStatus`, `approvedBy`, `approvedAt`
)
SELECT et.`branchId`, NULL, 'OUT',
  CASE WHEN et.`settledIqd` > 0 THEN et.`settledIqd` ELSE et.`iqdAmount` END,
  'EXCHANGE', NULL, et.`txnNumber`,
  CASE WHEN et.`exchangeTxnStatus` = 'REVERSED' THEN 'REVERSED' ELSE 'COMPLETED' END,
  CONCAT('PV-EX-', et.`txnNumber`), 'SUPPLIER', et.`supplierId`,
  CONCAT('تسديد مورد عبر صيرفة «', COALESCE(eh.`name`, CAST(et.`exchangeHouseId` AS CHAR)), '» — ', et.`txnNumber`),
  et.`createdBy`, et.`createdAt`, DATE(et.`createdAt`),
  'APPROVED', et.`createdBy`, et.`createdAt`
FROM `exchangeTransactions` et
LEFT JOIN `exchangeHouses` eh ON eh.`id` = et.`exchangeHouseId`
WHERE et.`exchangeTxnType` = 'SETTLE'
  AND et.`supplierId` IS NOT NULL AND et.`receiptId` IS NULL
  AND NOT EXISTS (SELECT 1 FROM `receipts` r WHERE r.`voucherNumber` = CONCAT('PV-EX-', et.`txnNumber`));

UPDATE `exchangeTransactions` et
INNER JOIN `receipts` r ON r.`voucherNumber` = CONCAT('PV-EX-', et.`txnNumber`) AND r.`paymentMethod` = 'EXCHANGE'
SET et.`receiptId` = r.`id`
WHERE et.`exchangeTxnType` = 'SETTLE' AND et.`receiptId` IS NULL;

UPDATE `accountingEntries` ae
INNER JOIN `exchangeTransactions` et ON ae.`dedupeKey` = CONCAT('EXSET:', et.`txnNumber`)
SET ae.`receiptId` = et.`receiptId`
WHERE et.`exchangeTxnType` = 'SETTLE' AND et.`receiptId` IS NOT NULL AND ae.`receiptId` IS NULL;
