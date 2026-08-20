-- 0229 — انتهاء صلاحية الحساب: أساسُ الحساب المؤقّت.
--
-- طلب المالك: تشغيلُ مصوّرٍ لا حساب له طوال حملة التصوير ثمّ انغلاق وصوله وحده.
-- ولا مفهومَ صلاحيةٍ زمنيّة على `users` أصلاً — فكل حساب يُنشأ دائماً حتى يُعطَّل يدوياً،
-- وهو ما يترك حسابات مصوّرين مفتوحةً بعد انتهاء الحملة إن نسي أحدٌ إغلاقها.
--
-- `NULL` = حسابٌ دائم بلا انتهاء ⇒ **كل الحسابات القائمة تبقى كما هي حرفياً**.
-- الإنفاذ مركزيّ في `server/auth/session.ts` بجوار فحص `isActive`: أيّ طلبٍ من حسابٍ
-- انتهت صلاحيته يسقط فوراً ولو كانت جلسته مفتوحة — لا يُترك للشاشات.
SET NAMES utf8mb4;
--> statement-breakpoint

SET @stmt := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'accessExpiresAt'
    ),
    'SELECT 1',
    'ALTER TABLE `users` ADD COLUMN `accessExpiresAt` TIMESTAMP NULL'
  )
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
