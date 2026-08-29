-- 0281_invoice_events: سجلّ أحداث الفاتورة (مرآة workOrderEvents)
--
-- الغرض (Slice 9، ٢٨/٨/٢٦): تعميمُ نموذج Event Store من deliveryEvents/workOrderEvents
-- إلى الفاتورة. اليوم auditLogs يعرض بعض الأحداث لكن دون fromStatus/toStatus مُنمَّطة —
-- هذا السجلّ يوفّر الطبقة الثانية المنظَّمة.
--
-- Idempotent: نمط 0278.

SET @db := DATABASE();
SET @tbl_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA=@db AND TABLE_NAME='invoiceEvents');
SET @sql := IF(@tbl_exists = 0, '
CREATE TABLE `invoiceEvents` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `eventKey` varchar(160) NOT NULL,
  `invoiceId` bigint NOT NULL,
  `eventType` varchar(60) NOT NULL,
  `fromStatus` varchar(30) DEFAULT NULL,
  `toStatus` varchar(30) DEFAULT NULL,
  `payload` json DEFAULT NULL,
  `actorUserId` int DEFAULT NULL,
  `branchId` bigint DEFAULT NULL,
  `occurredAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `invoiceEvents_eventKey_unique` (`eventKey`),
  KEY `idx_invoice_event_inv_time` (`invoiceId`,`occurredAt`),
  KEY `idx_invoice_event_type` (`eventType`),
  KEY `inv_event_actor_fk_idx` (`actorUserId`),
  CONSTRAINT `inv_event_inv_fk` FOREIGN KEY (`invoiceId`) REFERENCES `invoices` (`id`) ON DELETE CASCADE,
  CONSTRAINT `inv_event_actor_fk` FOREIGN KEY (`actorUserId`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
