-- تحرير بنود أمر الشغل (0200) — وسم «مُعدَّل» الذي طلبه المالك (١٧/٨/٢٦).
--
-- لماذا أعمدة مستقلّة ولا نكتفي بـ`updatedAt`: ذاك يتحرّك مع **كل** كتابة على الأمر
-- (تغيّر حالة، سحب، إسناد فنّي، تحديث موعد) ⇒ لو اشتُقّ منه الوسم لظهر كلُّ أمرٍ «معدَّلاً»
-- وفقد التمييز البصريّ معناه تماماً. هذه الأعمدة يكتبها مسار تحرير البنود وحده.
--
-- كل عبارة محروسة بـinformation_schema (مبدأ idempotency الإنتاجيّ — راجع 0179/0183):
-- الإنتاج قد يكون سبق وحمل العمود عبر مسار push/repair، فالـALTER العاري يسقط بـ
-- «Duplicate column» ويُفشل النشر كلَّه. الاتصال يعمل بـmultipleStatements=true فتُطبَّق
-- كتل SET/PREPARE/EXECUTE. ADD COLUMN بلا مرساة AFTER (الترتيب الفيزيائيّ تجميليّ،
-- وdrizzle لا يعتمد عليه) كي لا تتعلّق بعمودٍ لم تُنشئه هجرةٌ إضافية بعد.

-- materialsEditedAt
SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workOrders' AND COLUMN_NAME = 'materialsEditedAt'
);
SET @ddl := IF(
  @has_col > 0,
  'SELECT 1',
  'ALTER TABLE `workOrders` ADD COLUMN `materialsEditedAt` timestamp NULL'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- materialsEditedBy
SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workOrders' AND COLUMN_NAME = 'materialsEditedBy'
);
SET @ddl := IF(
  @has_col > 0,
  'SELECT 1',
  'ALTER TABLE `workOrders` ADD COLUMN `materialsEditedBy` int NULL'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- materialsEditCount
SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workOrders' AND COLUMN_NAME = 'materialsEditCount'
);
SET @ddl := IF(
  @has_col > 0,
  'SELECT 1',
  'ALTER TABLE `workOrders` ADD COLUMN `materialsEditCount` int NOT NULL DEFAULT 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- FK لمحرّر البنود — اسمٌ صريح (اسم drizzle التلقائيّ يتجاوز ٦٤ محرفاً على MySQL 8.4
-- فيُفشل db:push الطازج — راجع docs/local-test-db.md).
SET @has_fk := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workOrders'
    AND CONSTRAINT_NAME = 'fk_wo_materials_edited_by' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @ddl := IF(
  @has_fk > 0,
  'SELECT 1',
  'ALTER TABLE `workOrders` ADD CONSTRAINT `fk_wo_materials_edited_by` FOREIGN KEY (`materialsEditedBy`) REFERENCES `users`(`id`)'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
