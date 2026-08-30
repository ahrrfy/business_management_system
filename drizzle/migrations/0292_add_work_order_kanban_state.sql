-- الموجة ١ من ترقية شاشة أوامر الشغل (٢٠٢٦-٠٨-٣٠) — إشارةُ الفنّيّ داخل المرحلة.
--
-- `kanbanState` **متعامدةٌ** على `workOrderStatus`:
--   · NORMAL   = افتراضٌ (لا إشارة)
--   · READY    = الفنّيّ يشير: جاهزٌ لخطوة المرحلة التالية
--   · BLOCKED  = معطَّلٌ بحاجة تدخّل — `blockedReason` مطلوب في `setKanbanState`
--
-- ⛔ لا حاكم منطقيّ (شرطاً لفاتورة أو خصم مخزون) — إشارةٌ تشغيليّة بحتة. المعاملاتُ
-- المالية تبقى على `status` وحدها. القاموس الحاكم: `shared/workOrderKanban.ts`.
--
-- Idempotent: يفحص `information_schema` قبل الإضافة (نمط `migration-idempotency`
-- المعتمَد في المشروع — انظر ذاكرة `migration-idempotency-and-cart-unit-cost-2026-08-13`).

-- kanbanState enum
SET @needs_kanban := (
  SELECT COUNT(*) = 0 FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'workOrders' AND column_name = 'kanbanState'
);
SET @sql := IF(@needs_kanban,
  "ALTER TABLE `workOrders` ADD COLUMN `kanbanState` ENUM('NORMAL','READY','BLOCKED') NOT NULL DEFAULT 'NORMAL'",
  "SELECT 'kanbanState exists' AS msg");
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- blockedReason للإشارة BLOCKED (اختياريّ NULL — يُفرض غير-فارغ في `setKanbanState` خادمياً)
SET @needs_reason := (
  SELECT COUNT(*) = 0 FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'workOrders' AND column_name = 'blockedReason'
);
SET @sql := IF(@needs_reason,
  "ALTER TABLE `workOrders` ADD COLUMN `blockedReason` VARCHAR(255) NULL",
  "SELECT 'blockedReason exists' AS msg");
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

-- فهرس مُركَّب على (workOrderStatus, kanbanState) — استعلامات KPIs العمود تجمع
-- `count + sum + late` مقسّمةً على الحالتَين معاً؛ الفهرس يفيد `GROUP BY` مباشرةً.
-- ⚠️ اسم العمود الفعليّ `workOrderStatus` (أوّل معامل mysqlEnum في schema.ts:3378) —
--    `status` خاصيّة Drizzle فقط. الخلطُ يُسقط الهجرة على الإنتاج بـ`Unknown column 'status'`
--    (Codex أمسك هذه المرّة). حارس `check:schema-drift` لم يلتقطها لأنّه يفحص أسماء الأعمدة
--    لا مراجع الفهارس. القاعدة العامّة: [[raw-sql-column-names]] — SQL خامّ = أعمدة خام.
SET @needs_idx := (
  SELECT COUNT(*) = 0 FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'workOrders' AND index_name = 'idx_wo_status_kanban'
);
SET @sql := IF(@needs_idx,
  "CREATE INDEX `idx_wo_status_kanban` ON `workOrders` (`workOrderStatus`, `kanbanState`)",
  "SELECT 'idx_wo_status_kanban exists' AS msg");
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
