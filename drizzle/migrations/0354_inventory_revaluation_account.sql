-- 0354 — حساب «تسوية تقييم المخزون» (INVENTORY_REVALUATION).
-- إعادة تقييم تكلفة المخزون (تصحيح WAVG بلا تغيّر كميّة) تُقيَّد في هذا الحساب المخصَّص لا في
-- إيرادات/خسائر التشغيل (قرار المالك ١٣/٩، عن تدقيق المحرّك م١). مطلوبٌ إنتاجياً قبل تفعيل الدفتر
-- المزدوج (SHADOW/ACTIVE) — وإلّا فشل ترحيل قيود إعادة التقييم بـ«دورٌ بلا حساب تشغيليّ فعّال».
-- لا INSERT IGNORE: تعارض الرمز بلا الدور النظامي يوقف النشر للمراجعة ولا يعيد تسمية حسابٍ مستخدَم
-- بصمت — مرآة 0302 (GRNI).

INSERT INTO `accounts` (`code`,`name`,`type`,`parentId`,`systemRole`,`sortOrder`)
SELECT '5680','تسوية تقييم المخزون','EXPENSE',
  (SELECT p.`id` FROM `accounts` p WHERE p.`code` = '5000' AND p.`type` = 'EXPENSE' LIMIT 1),
  'INVENTORY_REVALUATION',568
WHERE NOT EXISTS (SELECT 1 FROM `accounts` a WHERE a.`systemRole` = 'INVENTORY_REVALUATION')
  AND EXISTS (
    SELECT 1 FROM `accounts` p
    WHERE p.`code` = '5000' AND p.`type` = 'EXPENSE'
  );
--> statement-breakpoint

-- حارس: يفشل النشرَ إن لم يوجد الدور نشطاً من نوع EXPENSE بعد الإدراج (أب مفقود أو حساب قديم مُعطَّل).
DROP TEMPORARY TABLE IF EXISTS `_inv_reval_guard_0354`;
--> statement-breakpoint
CREATE TEMPORARY TABLE `_inv_reval_guard_0354` (
  `valid` TINYINT NOT NULL,
  CONSTRAINT `chk_inv_reval_guard_0354` CHECK (`valid` = 1)
);
--> statement-breakpoint
INSERT INTO `_inv_reval_guard_0354` (`valid`)
SELECT IF(
  COUNT(*) = 1
  AND SUM(IF(a.`type` = 'EXPENSE' AND a.`isActive` = 1, 1, 0)) = 1,
  1, 0
)
FROM `accounts` a
WHERE a.`systemRole` = 'INVENTORY_REVALUATION';
--> statement-breakpoint
DROP TEMPORARY TABLE IF EXISTS `_inv_reval_guard_0354`;
