-- Stock identity is (variantId, branchId). A duplicate UPSERT against the old
-- surrogate clustered key can retain its tail gap and block another variant.
-- Keep every row/ID and the AUTO_INCREMENT counter; only change index layout.
-- The unique ID index stays enforced but INVISIBLE: otherwise its covering
-- scan can lock unrelated rows in existing natural-identity stock queries.
-- Direct ID-only predicates require a scan; application stock access uses the
-- natural identity. drizzle-kit cannot represent visibility, so CI replays this.
SET @stock_0413_pk = (SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='branchStock' AND INDEX_NAME='PRIMARY');
SET @stock_0413_id_count = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='branchStock' AND INDEX_NAME='uq_stock_id');
SET @stock_0413_id_ok = (SELECT COUNT(*)=1 AND MIN(COLUMN_NAME)='id' AND MAX(NON_UNIQUE)=0 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='branchStock' AND INDEX_NAME='uq_stock_id');
SET @stock_0413_old_count = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='branchStock' AND INDEX_NAME='uq_stock_variant_branch');
SET @stock_0413_old_ok = (SELECT COUNT(*)=2 AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='variantId,branchId' AND MAX(NON_UNIQUE)=0 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='branchStock' AND INDEX_NAME='uq_stock_variant_branch');
SET @stock_0413_ddl = CASE
  WHEN @stock_0413_pk='id' AND @stock_0413_id_count=0 AND @stock_0413_old_ok THEN 'ALTER TABLE `branchStock` ADD UNIQUE INDEX `uq_stock_id` (`id`) INVISIBLE, DROP PRIMARY KEY, ADD PRIMARY KEY (`variantId`, `branchId`), DROP INDEX `uq_stock_variant_branch`'
  WHEN @stock_0413_pk='variantId,branchId' AND @stock_0413_id_ok AND (@stock_0413_old_count=0 OR @stock_0413_old_ok) THEN 'SELECT 1'
  ELSE 'SELECT * FROM `migration_0413_unexpected_branch_stock_shape`'
END;
PREPARE stock_0413_stmt FROM @stock_0413_ddl;
EXECUTE stock_0413_stmt;
DEALLOCATE PREPARE stock_0413_stmt;
--> statement-breakpoint
-- Fresh db:push already creates the new keys, with ID visible. Also accept a
-- correctly shaped redundant old index left by an interrupted/manual upgrade.
SET @stock_0413_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='branchStock' AND INDEX_NAME='uq_stock_variant_branch'), 'ALTER TABLE `branchStock` DROP INDEX `uq_stock_variant_branch`', 'SELECT 1');
PREPARE stock_0413_stmt FROM @stock_0413_ddl;
EXECUTE stock_0413_stmt;
DEALLOCATE PREPARE stock_0413_stmt;
--> statement-breakpoint
SET @stock_0413_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='branchStock' AND INDEX_NAME='uq_stock_id' AND IS_VISIBLE='YES'), 'ALTER TABLE `branchStock` ALTER INDEX `uq_stock_id` INVISIBLE', 'SELECT 1');
PREPARE stock_0413_stmt FROM @stock_0413_ddl;
EXECUTE stock_0413_stmt;
DEALLOCATE PREPARE stock_0413_stmt;
