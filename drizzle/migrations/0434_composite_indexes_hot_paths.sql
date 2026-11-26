ALTER TABLE `onlineOrders` ADD INDEX `idx_online_orders_branch_status_id` (`branchId`, `orderStatus`, `id`), ALGORITHM=INPLACE, LOCK=NONE;
--> statement-breakpoint
ALTER TABLE `onlineOrders` ADD INDEX `idx_online_orders_invoice` (`invoiceId`), ALGORITHM=INPLACE, LOCK=NONE;
--> statement-breakpoint
ALTER TABLE `workOrders` ADD INDEX `idx_wo_branch_status_id` (`branchId`, `workOrderStatus`, `id`), ALGORITHM=INPLACE, LOCK=NONE;
--> statement-breakpoint
ALTER TABLE `shifts` ADD INDEX `idx_shift_branch_status_type_user` (`branchId`, `shiftStatus`, `shiftType`, `userId`), ALGORITHM=INPLACE, LOCK=NONE;
--> statement-breakpoint
ALTER TABLE `expenses` ADD INDEX `idx_expense_branch_status_date` (`branchId`, `expenseStatus`, `expenseDate`), ALGORITHM=INPLACE, LOCK=NONE;
--> statement-breakpoint
ALTER TABLE `idempotencyKeys` ADD INDEX `idx_idem_op_created` (`operation`, `createdAt`), ALGORITHM=INPLACE, LOCK=NONE;
