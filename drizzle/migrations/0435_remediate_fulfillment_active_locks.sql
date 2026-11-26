-- Remediation 0435: Release active fulfillmentRequestItems locks for consignments
-- that have already reached a terminal or detached state (DELIVERED, CANCELLED,
-- RETURNED, WRITTEN_OFF), while preserving HELD_AT_SHOP (consignmentStatus = 'DISPATCHED')
-- and unreleased WAITING/READY items.

UPDATE `fulfillmentRequestItems` fri
SET fri.`isActive` = 0
WHERE fri.`isActive` = 1
  AND fri.`status` = 'RELEASED'
  AND (
    (
      COALESCE(fri.`invoiceId`, fri.`materializedInvoiceId`) IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM `deliveryConsignments` dc
        WHERE dc.`invoiceId` = COALESCE(fri.`invoiceId`, fri.`materializedInvoiceId`)
          AND dc.`consignmentStatus` IN ('DELIVERED', 'CANCELLED', 'RETURNED', 'WRITTEN_OFF')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM `deliveryConsignments` dc_live
        WHERE dc_live.`invoiceId` = COALESCE(fri.`invoiceId`, fri.`materializedInvoiceId`)
          AND dc_live.`consignmentStatus` NOT IN ('DELIVERED', 'CANCELLED', 'RETURNED', 'WRITTEN_OFF')
      )
    )
    OR (
      COALESCE(fri.`invoiceId`, fri.`materializedInvoiceId`) IS NULL
      AND fri.`consignmentId` IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM `deliveryConsignments` dc_cn
        WHERE dc_cn.`id` = fri.`consignmentId`
          AND dc_cn.`consignmentStatus` IN ('DELIVERED', 'CANCELLED', 'RETURNED', 'WRITTEN_OFF')
      )
    )
  );
