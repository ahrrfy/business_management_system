-- 0068: دور «courier» (مندوب توصيل) + ربط جهة التوصيل بحساب دخول (deliveryParties.userId).
-- كلّها idempotent: توسيع enum بإضافة قيمة في الذيل = INSTANT بلا فقد بيانات (آمن للإعادة)،
-- والعمود/القيود محروسة بـINFORMATION_SCHEMA.

-- ① توسيع enum الدور على users.role (إضافة «courier» في الذيل).
ALTER TABLE `users` MODIFY COLUMN `role` enum('user','admin','manager','cashier','warehouse','accountant','print_operator','sales_rep','purchasing','auditor','courier') NOT NULL DEFAULT 'user';
--> statement-breakpoint

-- ② نفس التوسيع على roles.baseRole (الأدوار المخصّصة تُبنى على دور أساس من نفس المجموعة).
ALTER TABLE `roles` MODIFY COLUMN `baseRole` enum('user','admin','manager','cashier','warehouse','accountant','print_operator','sales_rep','purchasing','auditor','courier') NOT NULL DEFAULT 'user';
--> statement-breakpoint

-- ③ عمود ربط جهة التوصيل بحساب المستخدم (المندوب) — nullable، فريد (حساب واحد لكل جهة).
SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryParties' AND COLUMN_NAME = 'userId');
SET @sql := IF(@exists = 0, 'ALTER TABLE `deliveryParties` ADD `userId` int', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- UNIQUE (userId): يمنع ربط حسابٍ واحد بأكثر من جهة. MySQL يسمح بتعدّد NULL ⇒ الجهات بلا حساب تبقى.
SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryParties' AND INDEX_NAME = 'uq_delivery_party_user');
SET @sql := IF(@exists = 0, 'ALTER TABLE `deliveryParties` ADD CONSTRAINT `uq_delivery_party_user` UNIQUE (`userId`)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryParties' AND CONSTRAINT_NAME = 'fk_delivery_party_user');
SET @sql := IF(@exists = 0,
  'ALTER TABLE `deliveryParties` ADD CONSTRAINT `fk_delivery_party_user` FOREIGN KEY (`userId`) REFERENCES `users`(`id`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
