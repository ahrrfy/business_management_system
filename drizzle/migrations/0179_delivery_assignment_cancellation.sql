-- Idempotent repair of 0179 (completes #582). Production already carries the cancellation
-- columns/FK and the `consignmentStatus` enum (materialised earlier via a schema-push/repair
-- path), so the original compound ALTER duplicate-failed on deploy ("Duplicate column
-- 'cancelledAt'"), just as the pre-#582 form failed on the wrong `status` name. Every
-- statement below is guarded through information_schema, so the migrator's forward pass is
-- safe on both drifted-production and freshly-built databases. Connection runs with
-- multipleStatements=true (same path 0178 uses), so the SET/PREPARE/EXECUTE blocks apply.
--
-- Ordering note: `db:migrate:safe` runs this main migration BEFORE the extras pass that
-- creates `parcelStatus`. So on a fresh migrator-built DB `parcelStatus` is absent here — its
-- absent branch therefore CREATES the column with the FINAL enum (including CANCELLED) rather
-- than journaling a no-op the later extra could not recover. ADD COLUMNs omit AFTER anchors so
-- they never depend on a column an out-of-order extra has not created yet (position is
-- cosmetic — Drizzle does not rely on physical column order).

-- parcelStatus: MODIFY to the final enum when present, else CREATE it with the final enum (incl CANCELLED)
SET @has_parcel_status := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments' AND COLUMN_NAME = 'parcelStatus'
);
SET @ddl := IF(
  @has_parcel_status > 0,
  'ALTER TABLE `deliveryConsignments` MODIFY COLUMN `parcelStatus` ENUM(''ASSIGNED'',''ACCEPTED'',''PICKED_UP'',''OUT_FOR_DELIVERY'',''DELIVERED'',''FAILED'',''CANCELLED'',''RETURNED'') NOT NULL DEFAULT ''ASSIGNED''',
  'ALTER TABLE `deliveryConsignments` ADD COLUMN `parcelStatus` ENUM(''ASSIGNED'',''ACCEPTED'',''PICKED_UP'',''OUT_FOR_DELIVERY'',''DELIVERED'',''FAILED'',''CANCELLED'',''RETURNED'') NOT NULL DEFAULT ''ASSIGNED'''
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- consignmentStatus (created by 0029 without CANCELLED): MODIFY to the final enum when present,
-- else CREATE with the final enum. The MODIFY branch is the real work — it adds CANCELLED.
SET @has_consignment_status := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments' AND COLUMN_NAME = 'consignmentStatus'
);
SET @ddl := IF(
  @has_consignment_status > 0,
  'ALTER TABLE `deliveryConsignments` MODIFY COLUMN `consignmentStatus` ENUM(''DISPATCHED'',''DELIVERED'',''PARTIAL'',''CANCELLED'',''RETURNED'',''WRITTEN_OFF'') NOT NULL DEFAULT ''DISPATCHED''',
  'ALTER TABLE `deliveryConsignments` ADD COLUMN `consignmentStatus` ENUM(''DISPATCHED'',''DELIVERED'',''PARTIAL'',''CANCELLED'',''RETURNED'',''WRITTEN_OFF'') NOT NULL DEFAULT ''DISPATCHED'''
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- cancelledAt (guarded add; no AFTER anchor)
SET @has_cancelled_at := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments' AND COLUMN_NAME = 'cancelledAt'
);
SET @ddl := IF(
  @has_cancelled_at = 0,
  'ALTER TABLE `deliveryConsignments` ADD COLUMN `cancelledAt` TIMESTAMP NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- cancellationReason (guarded add; no AFTER anchor)
SET @has_cancellation_reason := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments' AND COLUMN_NAME = 'cancellationReason'
);
SET @ddl := IF(
  @has_cancellation_reason = 0,
  'ALTER TABLE `deliveryConsignments` ADD COLUMN `cancellationReason` VARCHAR(500) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- cancelledBy (guarded add; no AFTER anchor)
SET @has_cancelled_by := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments' AND COLUMN_NAME = 'cancelledBy'
);
SET @ddl := IF(
  @has_cancelled_by = 0,
  'ALTER TABLE `deliveryConsignments` ADD COLUMN `cancelledBy` INT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- FK cancelledBy -> users(id) (guarded add)
SET @has_cancelled_by_fk := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments'
    AND CONSTRAINT_NAME = 'deliveryConsignments_cancelledBy_users_id_fk' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @ddl := IF(
  @has_cancelled_by_fk = 0,
  'ALTER TABLE `deliveryConsignments` ADD CONSTRAINT `deliveryConsignments_cancelledBy_users_id_fk` FOREIGN KEY (`cancelledBy`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
