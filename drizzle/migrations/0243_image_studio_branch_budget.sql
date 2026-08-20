-- سقف مزوّد الصور المدفوع لكل فرع.
--
-- القائم قبلها: سقفٌ يوميّ **واحدٌ للشركة كلّها** (`imageStudioUsageDaily` بمفتاح
-- (اليوم، الخدمة)) ⇒ فرعٌ واحدٌ نشِط يستهلك الثلاثين نداءً قبل الظهر فيُردّ الفرع
-- الآخر بـ«بلغ الاستوديو سقف الاستخدام اليوميّ» وهو لم يُجرِ نداءً واحداً.
--
-- التصميم: السقف الشركيّ يبقى **السقف الأعلى** (حماية الميزانية، قرار المالك)، ويُضاف
-- فوقه سقفٌ فرعيّ **اختياريّ**: غياب الصفّ = بلا حدٍّ فرعيّ ⇒ صفر أثرٍ سلوكيّ حتى
-- يضبطه المدير صراحةً. نفس اصطلاح `creditLimit` (null = بلا حدّ).
--
-- المفتاح الأساسيّ مركّبٌ لا معرّفٌ بديل + فهرسٌ فريد: هذان جدولا عدّادٍ وإعداد،
-- والصفّ يُعرَّف بمفاتيحه الطبيعية. (وفائدةٌ عرَضيّة: لا قيد UNIQUE مُسمّى ⇒ لا حاجة
-- لمدخل تشخيصيّ، فالإدراج يمرّ دائماً بـON DUPLICATE KEY UPDATE ولا يرى المستخدم تصادماً.)
--
-- ⚠️ `branchId` **bigint** لا int: `branches.id` bigint، والخلط يُفشل الـFK بـ«أعمدة غير متوافقة».
-- أسماء FK صريحة وقصيرة: التسمية التلقائية تتجاوز ٦٤ محرفاً على MySQL 8.4 فيفشل db:push.

CREATE TABLE IF NOT EXISTS `imageStudioBranchBudgets` (
  `branchId` bigint NOT NULL,
  `service` enum('REMOVEBG','AI') NOT NULL,
  `dailyLimit` int NOT NULL,
  `updatedBy` int NULL,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`branchId`, `service`)
);
--> statement-breakpoint
SET @fk := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'fk_isbb_branch');
--> statement-breakpoint
SET @sql := IF(@fk = 0,
  'ALTER TABLE `imageStudioBranchBudgets` ADD CONSTRAINT `fk_isbb_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE CASCADE',
  'DO 0');
--> statement-breakpoint
PREPARE stmt FROM @sql;
--> statement-breakpoint
EXECUTE stmt;
--> statement-breakpoint
DEALLOCATE PREPARE stmt;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `imageStudioBranchUsageDaily` (
  `usageDate` date NOT NULL,
  `service` enum('REMOVEBG','AI') NOT NULL,
  `branchId` bigint NOT NULL,
  `requestCount` int NOT NULL DEFAULT 0,
  `lastRequestedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`usageDate`, `service`, `branchId`)
);
--> statement-breakpoint
SET @fk2 := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'fk_isbud_branch');
--> statement-breakpoint
SET @sql2 := IF(@fk2 = 0,
  'ALTER TABLE `imageStudioBranchUsageDaily` ADD CONSTRAINT `fk_isbud_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE CASCADE',
  'DO 0');
--> statement-breakpoint
PREPARE stmt2 FROM @sql2;
--> statement-breakpoint
EXECUTE stmt2;
--> statement-breakpoint
DEALLOCATE PREPARE stmt2;
