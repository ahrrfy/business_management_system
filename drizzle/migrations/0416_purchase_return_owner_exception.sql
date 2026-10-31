-- Owner-approved source-less purchase returns. No historical valuation backfill.
SET @return_0411_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='purchaseReturns' AND CONSTRAINT_NAME='chk_purchase_return_native_source'), 'ALTER TABLE `purchaseReturns` DROP CONSTRAINT `chk_purchase_return_native_source`;', 'SELECT 1');
PREPARE return_0411_stmt FROM @return_0411_ddl;
EXECUTE return_0411_stmt;
DEALLOCATE PREPARE return_0411_stmt;
--> statement-breakpoint
ALTER TABLE `purchaseReturnItems` MODIFY COLUMN `purchaseOrderItemId` bigint;
--> statement-breakpoint
ALTER TABLE `purchaseReturnRequestItems` MODIFY COLUMN `supplierInvoiceLineId` bigint;
--> statement-breakpoint
ALTER TABLE `purchaseReturnRequestItems` MODIFY COLUMN `goodsReceiptItemId` bigint;
--> statement-breakpoint
ALTER TABLE `purchaseReturnRequestItems` MODIFY COLUMN `matchAllocationId` bigint;
--> statement-breakpoint
ALTER TABLE `purchaseReturnRequestItems` MODIFY COLUMN `purchaseOrderItemId` bigint;
--> statement-breakpoint
ALTER TABLE `purchaseReturnRequests` MODIFY COLUMN `supplierInvoiceId` bigint;
--> statement-breakpoint
ALTER TABLE `purchaseReturnRequests` MODIFY COLUMN `matchRunId` bigint;
--> statement-breakpoint
ALTER TABLE `purchaseReturnRequests` MODIFY COLUMN `purchaseOrderId` bigint;
--> statement-breakpoint
ALTER TABLE `purchaseReturnRequests` MODIFY COLUMN `baseInvoiceVersion` int;
--> statement-breakpoint
ALTER TABLE `purchaseReturnReversals` MODIFY COLUMN `supplierInvoiceId` bigint;
--> statement-breakpoint
ALTER TABLE `purchaseReturns` MODIFY COLUMN `origin` enum('NATIVE','LEGACY','OWNER_EXCEPTION') NOT NULL DEFAULT 'NATIVE';
--> statement-breakpoint
ALTER TABLE `purchaseReturns` MODIFY COLUMN `purchaseOrderId` bigint;
--> statement-breakpoint
SET @return_0411_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchaseReturnItems' AND COLUMN_NAME='valuationEvidence'), 'SELECT 1', 'ALTER TABLE `purchaseReturnItems` ADD COLUMN `valuationEvidence` json;');
PREPARE return_0411_stmt FROM @return_0411_ddl;
EXECUTE return_0411_stmt;
DEALLOCATE PREPARE return_0411_stmt;
--> statement-breakpoint
SET @return_0411_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchaseReturnItems' AND COLUMN_NAME='valuationEvidenceHash'), 'SELECT 1', 'ALTER TABLE `purchaseReturnItems` ADD COLUMN `valuationEvidenceHash` char(64);');
PREPARE return_0411_stmt FROM @return_0411_ddl;
EXECUTE return_0411_stmt;
DEALLOCATE PREPARE return_0411_stmt;
--> statement-breakpoint
SET @return_0411_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchaseReturnRequests' AND COLUMN_NAME='sourceKind'), 'SELECT 1', 'ALTER TABLE `purchaseReturnRequests` ADD COLUMN `sourceKind` enum(''SOURCE_BOUND'',''OWNER_EXCEPTION'') DEFAULT ''SOURCE_BOUND'' NOT NULL;');
PREPARE return_0411_stmt FROM @return_0411_ddl;
EXECUTE return_0411_stmt;
DEALLOCATE PREPARE return_0411_stmt;
--> statement-breakpoint
SET @return_0411_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchaseReturnRequests' AND COLUMN_NAME='exceptionEvidenceKey'), 'SELECT 1', 'ALTER TABLE `purchaseReturnRequests` ADD COLUMN `exceptionEvidenceKey` char(64);');
PREPARE return_0411_stmt FROM @return_0411_ddl;
EXECUTE return_0411_stmt;
DEALLOCATE PREPARE return_0411_stmt;
--> statement-breakpoint
SET @return_0411_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchaseReturnReversalItems' AND COLUMN_NAME='valuationEvidence'), 'SELECT 1', 'ALTER TABLE `purchaseReturnReversalItems` ADD COLUMN `valuationEvidence` json;');
PREPARE return_0411_stmt FROM @return_0411_ddl;
EXECUTE return_0411_stmt;
DEALLOCATE PREPARE return_0411_stmt;
--> statement-breakpoint
SET @return_0411_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchaseReturnReversalItems' AND COLUMN_NAME='valuationEvidenceHash'), 'SELECT 1', 'ALTER TABLE `purchaseReturnReversalItems` ADD COLUMN `valuationEvidenceHash` char(64);');
PREPARE return_0411_stmt FROM @return_0411_ddl;
EXECUTE return_0411_stmt;
DEALLOCATE PREPARE return_0411_stmt;
--> statement-breakpoint
SET @return_0411_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchaseReturns' AND COLUMN_NAME='executionEvidence'), 'SELECT 1', 'ALTER TABLE `purchaseReturns` ADD COLUMN `executionEvidence` json;');
PREPARE return_0411_stmt FROM @return_0411_ddl;
EXECUTE return_0411_stmt;
DEALLOCATE PREPARE return_0411_stmt;
--> statement-breakpoint
SET @return_0411_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchaseReturns' AND COLUMN_NAME='executionEvidenceHash'), 'SELECT 1', 'ALTER TABLE `purchaseReturns` ADD COLUMN `executionEvidenceHash` char(64);');
PREPARE return_0411_stmt FROM @return_0411_ddl;
EXECUTE return_0411_stmt;
DEALLOCATE PREPARE return_0411_stmt;
--> statement-breakpoint
SET @return_0411_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='purchaseReturnRequests' AND CONSTRAINT_NAME='uq_purchase_return_exception_evidence'), 'SELECT 1', 'ALTER TABLE `purchaseReturnRequests` ADD CONSTRAINT `uq_purchase_return_exception_evidence` UNIQUE(`exceptionEvidenceKey`);');
PREPARE return_0411_stmt FROM @return_0411_ddl;
EXECUTE return_0411_stmt;
DEALLOCATE PREPARE return_0411_stmt;
--> statement-breakpoint
SET @return_0411_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='purchaseReturnItems' AND CONSTRAINT_NAME='chk_purchase_return_item_valuation'), 'ALTER TABLE `purchaseReturnItems` DROP CHECK `chk_purchase_return_item_valuation`;', 'SELECT 1');
PREPARE return_0411_stmt FROM @return_0411_ddl;
EXECUTE return_0411_stmt;
DEALLOCATE PREPARE return_0411_stmt;
--> statement-breakpoint
ALTER TABLE `purchaseReturnItems` ADD CONSTRAINT `chk_purchase_return_item_valuation` CHECK ((`valuationEvidence` IS NULL AND `valuationEvidenceHash` IS NULL) OR (`valuationEvidence` IS NOT NULL AND `valuationEvidenceHash` IS NOT NULL AND JSON_TYPE(`valuationEvidence`) = 'OBJECT' AND COALESCE(JSON_EXTRACT(`valuationEvidence`, '$.version') = 1 AND JSON_UNQUOTE(JSON_EXTRACT(`valuationEvidence`, '$.basis')) = 'LOCKED_WAVG', FALSE) AND REGEXP_LIKE(`valuationEvidenceHash`, '^[0-9a-f]{64}$', 'c')));
--> statement-breakpoint
SET @return_0411_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='purchaseReturnRequestItems' AND CONSTRAINT_NAME='chk_purchase_return_request_item_source'), 'ALTER TABLE `purchaseReturnRequestItems` DROP CHECK `chk_purchase_return_request_item_source`;', 'SELECT 1');
PREPARE return_0411_stmt FROM @return_0411_ddl;
EXECUTE return_0411_stmt;
DEALLOCATE PREPARE return_0411_stmt;
--> statement-breakpoint
ALTER TABLE `purchaseReturnRequestItems` ADD CONSTRAINT `chk_purchase_return_request_item_source` CHECK ((`supplierInvoiceLineId` IS NULL AND `goodsReceiptItemId` IS NULL AND `matchAllocationId` IS NULL AND `purchaseOrderItemId` IS NULL) OR (`supplierInvoiceLineId` IS NOT NULL AND `goodsReceiptItemId` IS NOT NULL AND `matchAllocationId` IS NOT NULL AND `purchaseOrderItemId` IS NOT NULL));
--> statement-breakpoint
SET @return_0411_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='purchaseReturnRequests' AND CONSTRAINT_NAME='chk_purchase_return_request_source'), 'ALTER TABLE `purchaseReturnRequests` DROP CHECK `chk_purchase_return_request_source`;', 'SELECT 1');
PREPARE return_0411_stmt FROM @return_0411_ddl;
EXECUTE return_0411_stmt;
DEALLOCATE PREPARE return_0411_stmt;
--> statement-breakpoint
ALTER TABLE `purchaseReturnRequests` ADD CONSTRAINT `chk_purchase_return_request_source` CHECK ((`sourceKind` = 'SOURCE_BOUND' AND `supplierInvoiceId` IS NOT NULL AND `matchRunId` IS NOT NULL AND `purchaseOrderId` IS NOT NULL AND `baseInvoiceVersion` IS NOT NULL AND `baseInvoiceVersion` > 0 AND `exceptionEvidenceKey` IS NULL) OR (`sourceKind` = 'OWNER_EXCEPTION' AND `supplierInvoiceId` IS NULL AND `matchRunId` IS NULL AND `purchaseOrderId` IS NULL AND `baseInvoiceVersion` IS NULL AND `exceptionEvidenceKey` IS NOT NULL AND REGEXP_LIKE(`exceptionEvidenceKey`, '^[0-9a-f]{64}$', 'c')));
--> statement-breakpoint
SET @return_0411_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='purchaseReturnReversalItems' AND CONSTRAINT_NAME='chk_purchase_return_reversal_valuation'), 'ALTER TABLE `purchaseReturnReversalItems` DROP CHECK `chk_purchase_return_reversal_valuation`;', 'SELECT 1');
PREPARE return_0411_stmt FROM @return_0411_ddl;
EXECUTE return_0411_stmt;
DEALLOCATE PREPARE return_0411_stmt;
--> statement-breakpoint
ALTER TABLE `purchaseReturnReversalItems` ADD CONSTRAINT `chk_purchase_return_reversal_valuation` CHECK ((`valuationEvidence` IS NULL AND `valuationEvidenceHash` IS NULL) OR (`valuationEvidence` IS NOT NULL AND `valuationEvidenceHash` IS NOT NULL AND JSON_TYPE(`valuationEvidence`) = 'OBJECT' AND COALESCE(JSON_EXTRACT(`valuationEvidence`, '$.version') = 1 AND JSON_UNQUOTE(JSON_EXTRACT(`valuationEvidence`, '$.basis')) = 'SAVED_RETURN', FALSE) AND REGEXP_LIKE(`valuationEvidenceHash`, '^[0-9a-f]{64}$', 'c')));
--> statement-breakpoint
SET @return_0411_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='purchaseReturns' AND CONSTRAINT_NAME='chk_purchase_return_execution_evidence'), 'ALTER TABLE `purchaseReturns` DROP CHECK `chk_purchase_return_execution_evidence`;', 'SELECT 1');
PREPARE return_0411_stmt FROM @return_0411_ddl;
EXECUTE return_0411_stmt;
DEALLOCATE PREPARE return_0411_stmt;
--> statement-breakpoint
ALTER TABLE `purchaseReturns` ADD CONSTRAINT `chk_purchase_return_execution_evidence` CHECK ((`executionEvidence` IS NULL AND `executionEvidenceHash` IS NULL) OR (`executionEvidence` IS NOT NULL AND `executionEvidenceHash` IS NOT NULL AND JSON_TYPE(`executionEvidence`) = 'OBJECT' AND COALESCE(JSON_EXTRACT(`executionEvidence`, '$.version') = 1, FALSE) AND REGEXP_LIKE(`executionEvidenceHash`, '^[0-9a-f]{64}$', 'c')));
--> statement-breakpoint
SET @return_0411_ddl = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='purchaseReturns' AND CONSTRAINT_NAME='chk_purchase_return_native_source'), 'ALTER TABLE `purchaseReturns` DROP CHECK `chk_purchase_return_native_source`;', 'SELECT 1');
PREPARE return_0411_stmt FROM @return_0411_ddl;
EXECUTE return_0411_stmt;
DEALLOCATE PREPARE return_0411_stmt;
--> statement-breakpoint
ALTER TABLE `purchaseReturns` ADD CONSTRAINT `chk_purchase_return_native_source` CHECK ((`origin` = 'LEGACY' AND `purchaseOrderId` IS NOT NULL) OR (`origin` = 'NATIVE' AND `purchaseOrderId` IS NOT NULL AND `requestId` IS NOT NULL AND `supplierInvoiceId` IS NOT NULL AND `matchRunId` IS NOT NULL AND `payloadCanonical` IS NOT NULL AND `payloadHash` IS NOT NULL AND `evidenceType` IS NOT NULL AND `evidenceReference` IS NOT NULL AND `postedBy` IS NOT NULL AND `postedAt` IS NOT NULL) OR (`origin` = 'OWNER_EXCEPTION' AND `purchaseOrderId` IS NULL AND `supplierInvoiceId` IS NULL AND `matchRunId` IS NULL AND `requestId` IS NOT NULL AND `payloadCanonical` IS NOT NULL AND `payloadHash` IS NOT NULL AND `evidenceType` IS NOT NULL AND `evidenceReference` IS NOT NULL AND `postedBy` IS NOT NULL AND `postedAt` IS NOT NULL));
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_pr_execution_bu`;
--> statement-breakpoint
CREATE TRIGGER `trg_pr_execution_bu` BEFORE UPDATE ON `purchaseReturns` FOR EACH ROW
BEGIN
  IF NEW.`origin` = 'OWNER_EXCEPTION' AND NEW.`accountingEntryId` IS NOT NULL AND (NEW.`executionEvidence` IS NULL OR NEW.`executionEvidenceHash` IS NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Posted exception requires execution evidence';
  END IF;
  IF OLD.`executionEvidence` IS NOT NULL AND (NOT (NEW.`executionEvidence` <=> OLD.`executionEvidence`) OR NOT (NEW.`executionEvidenceHash` <=> OLD.`executionEvidenceHash`)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Purchase return evidence is immutable';
  END IF;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_pr_execution_bi`;
--> statement-breakpoint
CREATE TRIGGER `trg_pr_execution_bi` BEFORE INSERT ON `purchaseReturns` FOR EACH ROW
BEGIN
  IF NEW.`origin` = 'OWNER_EXCEPTION' AND NEW.`accountingEntryId` IS NOT NULL AND (NEW.`executionEvidence` IS NULL OR NEW.`executionEvidenceHash` IS NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Posted exception requires execution evidence';
  END IF;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_pri_valuation_bu`;
--> statement-breakpoint
CREATE TRIGGER `trg_pri_valuation_bu` BEFORE UPDATE ON `purchaseReturnItems` FOR EACH ROW
BEGIN
  IF (NOT (NEW.`valuationEvidence` <=> OLD.`valuationEvidence`) OR NOT (NEW.`valuationEvidenceHash` <=> OLD.`valuationEvidenceHash`)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Purchase return evidence is immutable';
  END IF;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_prri_valuation_bu`;
--> statement-breakpoint
CREATE TRIGGER `trg_prri_valuation_bu` BEFORE UPDATE ON `purchaseReturnReversalItems` FOR EACH ROW
BEGIN
  IF (NOT (NEW.`valuationEvidence` <=> OLD.`valuationEvidence`) OR NOT (NEW.`valuationEvidenceHash` <=> OLD.`valuationEvidenceHash`)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Purchase return evidence is immutable';
  END IF;
END;
