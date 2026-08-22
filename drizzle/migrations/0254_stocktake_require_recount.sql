-- **الجرد بالباركود — حوكمة: إلزام إعادة العدّ فوق الحدّ** (وثيقة ٢٢/٨، م٥).
--
-- عمودٌ واحد على `stocktakeSessions`: `requireRecountOverThreshold` (tinyint، افتراض 0). إن كان 1،
-- لا تُعتمد الجلسة ما دام صنفٌ يتجاوز الحدّ لم يُعَد عدّه فعلياً (RECOUNT) — قرار المدير وحده لا يكفي
-- فوق الحدّ. الافتراض 0 عمداً: توافقٌ مع كل جلسةٍ قائمة والسلوك القديم (صفر أثرٍ ما لم يُفعَّل).
--
-- لا يمسّ عموداً ولا قيمةَ enum قائمة ⇒ لا حارسَ يُعمى. idempotent محروسٌ بـ information_schema.

SET NAMES utf8mb4;
--> statement-breakpoint

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stocktakeSessions'
    AND COLUMN_NAME = 'requireRecountOverThreshold'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE `stocktakeSessions` ADD COLUMN `requireRecountOverThreshold` tinyint NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
