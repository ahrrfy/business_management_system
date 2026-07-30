-- ═══════════════════════════════════════════════════════════════════════════════
-- 0129 — priceSanity L1.8: حدود قصوى على تكلفة المتغيّر ومعامل الوحدة (٣٠/٧/٢٦).
--
-- الجذر: حادثة SINARLINE (١٦١٦٢ بدل ١١٦٢.٥) كشفت أنّ كل حرّاس التطبيق قابلةٌ للتجاوز عبر:
--   (١) استيراد CSV/Excel مباشر بلا مرور بـzod الراوتر.
--   (٢) بذور seed أو تصحيحات db:push عارية.
--   (٣) تريجرات مستقبلية أو أدوات إدارة.
--
-- هذه القيود على مستوى DB **دفاعٌ نهائيّ** — MySQL 8.0.16+ يفرض CHECK بلا خدعة. الحدود:
--   - productVariants.costPrice ∈ [0, 10^8] د.ع — ١٠٠ مليون د.ع سقفٌ مطلق لأيّ صنف (سيارة صغيرة).
--   - productUnits.conversionFactor > 0 — لا صفر ولا سالب (المخطّط `precision:15, scale:4` يحمي أعلى).
--
-- **idempotent** عبر INFORMATION_SCHEMA (يُطبَّق مرّتَين بأمان — نمط 0057/0059/0060) لأن CI/init
-- يُعيدان تشغيل هذا السكريبت بعد كل db:push.
-- ═══════════════════════════════════════════════════════════════════════════════

-- (١) سقف التكلفة على productVariants.costPrice.
SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'productVariants' AND CONSTRAINT_NAME = 'chk_variant_cost_range');
SET @sql := IF(@exists = 0,
  'ALTER TABLE `productVariants` ADD CONSTRAINT `chk_variant_cost_range` CHECK (`costPrice` IS NULL OR (`costPrice` >= 0 AND `costPrice` <= 100000000))',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- (٢) معامل التحويل موجب صريح على productUnits.conversionFactor.
SET @exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'productUnits' AND CONSTRAINT_NAME = 'chk_unit_factor_positive');
SET @sql := IF(@exists = 0,
  'ALTER TABLE `productUnits` ADD CONSTRAINT `chk_unit_factor_positive` CHECK (`conversionFactor` > 0)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
