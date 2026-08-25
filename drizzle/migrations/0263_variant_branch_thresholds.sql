-- 0263_variant_branch_thresholds: per-branch minStock/reorderPoint override
--
-- الغرض: تقرير المراجعة التشغيلية (٢٥/٨) رصد أنّ عتبات إعادة الطلب على المتغيّر
-- (`productVariants.minStock`/`reorderPoint`) عالميّة ⇒ الفرعُ سريع الدوران والبطيء يتلقّيان
-- نفس التنبيه. هذا الجدول يحمل override لكل (متغيّر × فرع)، والقارئُ الرئيس (listReorderAlerts
-- و«المخزون الحيّ» في inventoryRouter.ts) يستعمل COALESCE(override, default).
--
-- ⚠️ الأعمدة القائمة على `productVariants` تبقى كما هي (صفر أثر تحميل، توافق كامل مع كلّ الشاشات
-- والقوارئ التي تظهر «الافتراض العامّ»). override يظهر تدريجياً فقط للفروع التي تُخصَّص لها عتبة.
--
-- Idempotency: احرس بـinformation_schema (نمط 0180+ في هذا المستودع) — الهجرة قد تُعاد
-- تشغيلاً عبر ci-apply-extra-migrations أو migration-dry-run.
--
-- FK ↔ productVariants و branches: أضفناها inline في CREATE TABLE (FK اسمها < 64 محرفاً — يحرسه
-- check:fk-name — لكن نُبقيها ضمن حدود MySQL 8.4 تقليدياً). ON DELETE CASCADE على variantId/branchId
-- (override يفقد معناه بلا صاحبه). updatedBy → users.id ON DELETE SET NULL (يُبقي الأثر التدقيقيّ).

SET @tbl_exists := (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'variantBranchThresholds'
);

SET @ddl := IF(
  @tbl_exists = 0,
  'CREATE TABLE `variantBranchThresholds` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `variantId` BIGINT NOT NULL,
    `branchId` BIGINT NOT NULL,
    `minStock` INT NULL,
    `reorderPoint` INT NULL,
    `updatedBy` INT NULL,
    `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uq_vbt_variant_branch` (`variantId`, `branchId`),
    KEY `idx_vbt_branch` (`branchId`),
    CONSTRAINT `fk_vbt_variant` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_vbt_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_vbt_updated_by` FOREIGN KEY (`updatedBy`) REFERENCES `users`(`id`) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
