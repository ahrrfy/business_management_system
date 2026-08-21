-- **المرتجعُ المُعلَن ≠ المرتجعُ المستلَم** (إطار المالك، نسخة ٢).
--
-- شركةُ التوصيل تُعلن أنّ طرداً **راجعٌ إلينا** قبل أن يصل بأيّام. وحتى اليوم لا يوجد إلّا
-- `returnConsignment` — وهي لحظةُ **الاستلام**: تُعيد المخزون بحركةِ IN، وتُرجع الفاتورة،
-- وتردّ العربون، وتُغلق أمر الشغل. فالموظّف أمام خيارَين كلاهما خطأ:
--
--   · **يُشغّلها عند الإعلان** ⇒ يعود للمخزون صنفٌ **لم يصل ولم يُفحَص بعد** — بضاعةٌ
--     تُحسَب موجودةً وقد تكون تالفةً أو ضائعةً في الطريق، فتُباع وهي ليست في الرفّ.
--   · **ينتظر الوصول** ⇒ يبقى الطردُ في «قيد التوصيل» بتعرّضِ تحصيلٍ قائمٍ على الجهة
--     أسابيع، فتكذب أعمارُ الطرود وتقاريرُ التعرّض.
--
-- الفصلُ يحلّهما: الإعلانُ يُغلق **توقّعَ التحصيل** وحده (`COD_RELEASED`) ويَسِم الطردَ
-- «راجعٌ مُعلَن»؛ والاستلامُ والفحصُ في الفرع هما وحدهما ما يُشغّل العكس الكامل.
--
-- ⛔ **ولا قيمةَ enum جديدة على `parcelStatus`**: كلُّ حارسٍ يقارن الحالة (وهي عشرات) يصير
-- أعمى عنها صامتاً — نفس درس `workOrders.status`. الوسمُ أعمدةٌ **إضافيةٌ محضة**، فكلّ
-- الحرّاس القائمة تبقى صحيحةً بلا مسّ، والطردُ يظلّ `DISPATCHED` أي حيّاً كما هو فعلاً.
--
-- idempotent محروسٌ بـinformation_schema.

SET NAMES utf8mb4;
--> statement-breakpoint

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments'
    AND COLUMN_NAME = 'returnDeclaredAt'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `deliveryConsignments` ADD COLUMN `returnDeclaredAt` timestamp NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments'
    AND COLUMN_NAME = 'returnDeclaredBy'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `deliveryConsignments` ADD COLUMN `returnDeclaredBy` int NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- السببُ إلزاميٌّ في العقد: «رفض العميل» و«العنوان خاطئ» و«لم يُعثر عليه» قراراتُ متابعةٍ
-- مختلفة، وبلا تمييزها يصير طابورُ المرتجعات كومةً لا تُدار.
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments'
    AND COLUMN_NAME = 'returnDeclaredReason'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `deliveryConsignments` ADD COLUMN `returnDeclaredReason` varchar(500) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments'
    AND CONSTRAINT_NAME = 'fk_cn_return_declared_by' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `deliveryConsignments` ADD CONSTRAINT `fk_cn_return_declared_by` FOREIGN KEY (`returnDeclaredBy`) REFERENCES `users`(`id`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- طابورُ «بانتظار المرتجع» يُرشّح على المُعلَن غير المستلَم — فهرسٌ جزئيٌّ بحكم NULL.
SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryConsignments'
    AND INDEX_NAME = 'idx_cn_return_declared'
);
SET @sql := IF(@idx_exists = 0,
  'CREATE INDEX `idx_cn_return_declared` ON `deliveryConsignments` (`returnDeclaredAt`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
