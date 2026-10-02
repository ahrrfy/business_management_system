-- الأختام القابلة للتخصيص ورثت قالب «هدية» العام من 0244 رغم أن المطلوب منها
-- وصف التنفيذ الذي يكتبه الزبون. نطابق البصمة الكاملة للقالب البِكر فقط؛ أي تعديل
-- أجراه مدير على القالب أو أحد حقوله يبقى كما هو.

DROP TEMPORARY TABLE IF EXISTS `_stamp_default_templates_0378`;
--> statement-breakpoint

CREATE TEMPORARY TABLE `_stamp_default_templates_0378` (
  `templateId` bigint NOT NULL PRIMARY KEY,
  `productId` bigint NOT NULL UNIQUE
);
--> statement-breakpoint

INSERT INTO `_stamp_default_templates_0378` (`templateId`, `productId`)
SELECT t.`id`, t.`productId`
FROM `productCustomizationTemplates` t
INNER JOIN `products` p ON p.`id` = t.`productId`
INNER JOIN `categories` c ON c.`id` = p.`categoryId`
WHERE c.`name` = 'الاختام التجارية والشخصية والشركات'
  AND t.`kind` = 'GIFT'
  AND t.`title` = 'أضف لمسة الهدية'
  AND t.`description` = 'خيارات الهدية تُجهّز مع المنتج قبل الإرسال.'
  AND t.`isActive` = true
  AND (
    SELECT COUNT(*)
    FROM `productCustomizationFields` f
    WHERE f.`templateId` = t.`id`
  ) = 3
  AND EXISTS (
    SELECT 1
    FROM `productCustomizationFields` f
    WHERE f.`templateId` = t.`id`
      AND f.`fieldKey` = 'packaging'
      AND f.`label` = 'التغليف'
      AND f.`fieldType` = 'SELECT'
      AND f.`isRequired` = false
      AND f.`sortOrder` = 20
      AND f.`maxLength` IS NULL
      AND JSON_LENGTH(f.`optionsJson`) = 2
      AND JSON_UNQUOTE(JSON_EXTRACT(f.`optionsJson`, '$[0].value')) = 'standard'
      AND JSON_UNQUOTE(JSON_EXTRACT(f.`optionsJson`, '$[0].label')) = 'تغليف عادي'
      AND JSON_UNQUOTE(JSON_EXTRACT(f.`optionsJson`, '$[0].priceDelta')) = '0'
      AND JSON_UNQUOTE(JSON_EXTRACT(f.`optionsJson`, '$[1].value')) = 'gift'
      AND JSON_UNQUOTE(JSON_EXTRACT(f.`optionsJson`, '$[1].label')) = 'تغليف هدية'
      AND JSON_UNQUOTE(JSON_EXTRACT(f.`optionsJson`, '$[1].priceDelta')) = '0'
      AND f.`dependencyJson` IS NULL
      AND f.`priceDelta` = 0
      AND f.`isActive` = true
  )
  AND EXISTS (
    SELECT 1
    FROM `productCustomizationFields` f
    WHERE f.`templateId` = t.`id`
      AND f.`fieldKey` = 'recipient'
      AND f.`label` = 'اسم المستلم'
      AND f.`fieldType` = 'TEXT'
      AND f.`isRequired` = false
      AND f.`sortOrder` = 25
      AND f.`maxLength` = 120
      AND f.`optionsJson` IS NULL
      AND f.`dependencyJson` IS NULL
      AND f.`priceDelta` = 0
      AND f.`isActive` = true
  )
  AND EXISTS (
    SELECT 1
    FROM `productCustomizationFields` f
    WHERE f.`templateId` = t.`id`
      AND f.`fieldKey` = 'message'
      AND f.`label` = 'رسالة الإهداء'
      AND f.`fieldType` = 'TEXTAREA'
      AND f.`isRequired` = false
      AND f.`sortOrder` = 30
      AND f.`maxLength` = 300
      AND f.`optionsJson` IS NULL
      AND f.`dependencyJson` IS NULL
      AND f.`priceDelta` = 0
      AND f.`isActive` = true
  );
--> statement-breakpoint

-- هوية القالب جزء من عقد السلة العامة. نحذف القالب القديم (فتُحذف حقوله
-- بالتسلسل) ثم ننشئ قالباً جديداً كي تُرفض السلال القديمة بأمان.
DELETE t
FROM `productCustomizationTemplates` t
INNER JOIN `_stamp_default_templates_0378` target ON target.`templateId` = t.`id`;
--> statement-breakpoint

INSERT INTO `productCustomizationTemplates`
  (`productId`, `kind`, `title`, `description`, `isActive`)
SELECT
  target.`productId`,
  'GENERAL',
  'تفاصيل تخصيص الختم',
  'اكتب النص أو التفاصيل التي تريد تنفيذها على الختم قبل إضافته إلى السلة.',
  true
FROM `_stamp_default_templates_0378` target;
--> statement-breakpoint

INSERT INTO `productCustomizationFields`
  (`templateId`, `fieldKey`, `label`, `fieldType`, `isRequired`, `sortOrder`, `maxLength`, `optionsJson`, `dependencyJson`, `priceDelta`, `isActive`)
SELECT
  t.`id`,
  'details',
  'تفاصيل الختم المطلوبة',
  'TEXTAREA',
  true,
  10,
  2000,
  NULL,
  NULL,
  '0',
  true
FROM `_stamp_default_templates_0378` target
INNER JOIN `productCustomizationTemplates` t ON t.`productId` = target.`productId`;
--> statement-breakpoint

DROP TEMPORARY TABLE `_stamp_default_templates_0378`;
