-- اعتماد المالك الذاتي الشامل: قيود CHECK أحادية الجدول لا تستطيع معرفة isOwner من users.
-- تتحقق الخدمات من أن الفاعل مالك نشط من قاعدة البيانات قبل الاستثناء، لذلك تُزال قيود
-- فصل المهام المتعارضة فقط، مع بقاء بقية قيود دورة الحياة والأثر كما هي.

SET @has_c1 := (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'purchaseOrderControlRequests' AND constraint_name = 'chk_po_control_maker_checker');
SET @sql := IF(@has_c1 > 0, 'ALTER TABLE `purchaseOrderControlRequests` DROP CHECK `chk_po_control_maker_checker`', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_c2 := (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'purchaseIntegrityCases' AND constraint_name = 'chk_purchase_integrity_resolution_sod');
SET @sql := IF(@has_c2 > 0, 'ALTER TABLE `purchaseIntegrityCases` DROP CHECK `chk_purchase_integrity_resolution_sod`', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_c3 := (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'purchaseIntegrityCaseEvents' AND constraint_name = 'chk_purchase_integrity_event_sod');
SET @sql := IF(@has_c3 > 0, 'ALTER TABLE `purchaseIntegrityCaseEvents` DROP CHECK `chk_purchase_integrity_event_sod`', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_c4 := (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'accrualCorrectionRequests' AND constraint_name = 'chk_accrual_correction_maker_checker');
SET @sql := IF(@has_c4 > 0, 'ALTER TABLE `accrualCorrectionRequests` DROP CHECK `chk_accrual_correction_maker_checker`', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_c5 := (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'employeeTerminations' AND constraint_name = 'chk_term_recognition_maker_checker');
SET @sql := IF(@has_c5 > 0, 'ALTER TABLE `employeeTerminations` DROP CHECK `chk_term_recognition_maker_checker`', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_c6 := (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'workOrderControlRequests' AND constraint_name = 'chk_wo_control_maker_checker');
SET @sql := IF(@has_c6 > 0, 'ALTER TABLE `workOrderControlRequests` DROP CHECK `chk_wo_control_maker_checker`', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_c7 := (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'yearEndReopenRequests' AND constraint_name = 'chk_yerr_maker_checker');
SET @sql := IF(@has_c7 > 0, 'ALTER TABLE `yearEndReopenRequests` DROP CHECK `chk_yerr_maker_checker`', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_c8 := (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'salesControlRequests' AND constraint_name = 'chk_sales_control_maker_checker');
SET @sql := IF(@has_c8 > 0, 'ALTER TABLE `salesControlRequests` DROP CHECK `chk_sales_control_maker_checker`', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_c9 := (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'salesExchangeCommands' AND constraint_name = 'chk_sales_exchange_maker_checker');
SET @sql := IF(@has_c9 > 0, 'ALTER TABLE `salesExchangeCommands` DROP CHECK `chk_sales_exchange_maker_checker`', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_c10 := (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'deliveryCodWriteOffRequests' AND constraint_name = 'chk_delivery_cod_writeoff_maker_checker');
SET @sql := IF(@has_c10 > 0, 'ALTER TABLE `deliveryCodWriteOffRequests` DROP CHECK `chk_delivery_cod_writeoff_maker_checker`', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_c11 := (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'commissionRunApprovalRequests' AND constraint_name = 'chk_commission_run_approval_maker_checker');
SET @sql := IF(@has_c11 > 0, 'ALTER TABLE `commissionRunApprovalRequests` DROP CHECK `chk_commission_run_approval_maker_checker`', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- هذا القيد يجمع دورة الحياة وفصل المهام؛ نعيده بلا مقارنة الطالب بالمراجع.
SET @has_c12 := (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'cashMissedDailyCountExceptions' AND constraint_name = 'chk_cash_missed_daily_decision_shape');
SET @sql := IF(@has_c12 > 0, 'ALTER TABLE `cashMissedDailyCountExceptions` DROP CHECK `chk_cash_missed_daily_decision_shape`', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_c12_new := (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'cashMissedDailyCountExceptions' AND constraint_name = 'chk_cash_missed_daily_decision_shape');
SET @has_t12 := (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'cashMissedDailyCountExceptions');
SET @sql := IF(@has_t12 > 0 AND @has_c12_new = 0,
  'ALTER TABLE `cashMissedDailyCountExceptions` ADD CONSTRAINT `chk_cash_missed_daily_decision_shape` CHECK (((`missedDailyCountExceptionStatus` = ''PENDING'') AND (`version` = 1) AND (`decisionClientRequestId` IS NULL) AND (`decisionHash` IS NULL) AND (`reviewedByUserId` IS NULL) AND (`reviewedAt` IS NULL) AND (`decisionNote` IS NULL)) OR ((`missedDailyCountExceptionStatus` IN (''APPROVED'',''REJECTED'')) AND (`version` = 2) AND (`decisionClientRequestId` IS NOT NULL) AND (`decisionHash` IS NOT NULL) AND (`reviewedByUserId` IS NOT NULL) AND (`reviewedAt` IS NOT NULL) AND (`decisionNote` IS NOT NULL)))',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
