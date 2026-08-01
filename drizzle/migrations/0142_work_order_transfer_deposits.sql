-- `paymentMethod` is the TypeScript property, while `woPaymentMethod` is the
-- intentional physical column name used by schema.ts and migration 0000.
-- Select the safe operation at runtime so production, schema-pushed databases,
-- and any database carrying the accidental generic name converge identically.
SET @wo_old_payment_column := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'workOrders'
    AND COLUMN_NAME = 'woPaymentMethod'
);
--> statement-breakpoint
SET @wo_new_payment_column := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'workOrders'
    AND COLUMN_NAME = 'paymentMethod'
);
--> statement-breakpoint
SET @wo_payment_sql := IF(
  @wo_old_payment_column = 1,
  'ALTER TABLE `workOrders` MODIFY COLUMN `woPaymentMethod` enum(''CASH'',''CARD'',''TRANSFER'') DEFAULT ''CASH''',
  IF(
    @wo_new_payment_column = 1,
    'ALTER TABLE `workOrders` CHANGE COLUMN `paymentMethod` `woPaymentMethod` enum(''CASH'',''CARD'',''TRANSFER'') DEFAULT ''CASH''',
    'ALTER TABLE `workOrders` ADD COLUMN `woPaymentMethod` enum(''CASH'',''CARD'',''TRANSFER'') DEFAULT ''CASH'' AFTER `deposit`'
  )
);
--> statement-breakpoint
PREPARE wo_payment_stmt FROM @wo_payment_sql;
--> statement-breakpoint
EXECUTE wo_payment_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE wo_payment_stmt;
