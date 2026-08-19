SET NAMES utf8mb4;
--> statement-breakpoint

CREATE TABLE `productCustomizationTemplates` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `productId` bigint NOT NULL,
  `kind` enum('PRINT','GIFT','GENERAL') NOT NULL DEFAULT 'GENERAL',
  `title` varchar(160) NOT NULL,
  `description` text,
  `isActive` boolean NOT NULL DEFAULT true,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `productCustomizationTemplates_id` PRIMARY KEY(`id`),
  CONSTRAINT `uq_custom_template_product` UNIQUE(`productId`),
  CONSTRAINT `productCustomizationTemplates_productId_products_id_fk`
    FOREIGN KEY (`productId`) REFERENCES `products` (`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint

CREATE INDEX `idx_custom_template_product`
  ON `productCustomizationTemplates` (`productId`);
--> statement-breakpoint

CREATE TABLE `productCustomizationFields` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `templateId` bigint NOT NULL,
  `fieldKey` varchar(80) NOT NULL,
  `label` varchar(160) NOT NULL,
  `fieldType` enum('TEXT','TEXTAREA','SELECT','FILE','NUMBER','SWATCH') NOT NULL,
  `isRequired` boolean NOT NULL DEFAULT false,
  `sortOrder` int NOT NULL DEFAULT 0,
  `maxLength` int,
  `optionsJson` json,
  `dependencyJson` json,
  `priceDelta` decimal(15,2) NOT NULL DEFAULT '0',
  `isActive` boolean NOT NULL DEFAULT true,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `productCustomizationFields_id` PRIMARY KEY(`id`),
  CONSTRAINT `uq_custom_field_template_key` UNIQUE(`templateId`,`fieldKey`),
  CONSTRAINT `productCustomizationFields_templateId_productCustomizationTemplates_id_fk`
    FOREIGN KEY (`templateId`) REFERENCES `productCustomizationTemplates` (`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint

CREATE INDEX `idx_custom_field_template_sort`
  ON `productCustomizationFields` (`templateId`, `sortOrder`);

--> statement-breakpoint

INSERT INTO `productCustomizationTemplates` (`productId`, `kind`, `title`, `description`, `isActive`)
SELECT
  p.`id`,
  CASE WHEN p.`productType` = 'PRINT_SERVICE' THEN 'PRINT' ELSE 'GIFT' END,
  CASE WHEN p.`productType` = 'PRINT_SERVICE' THEN 'خصّص طلبك قبل الإضافة' ELSE 'أضف لمسة الهدية' END,
  CASE WHEN p.`productType` = 'PRINT_SERVICE' THEN 'خيارات تنفيذ المنتج تُراجع قبل تجهيز الطلب.' ELSE 'خيارات الهدية تُجهّز مع المنتج قبل الإرسال.' END,
  true
FROM `products` p
WHERE p.`isCustomizable` = true
  AND NOT EXISTS (
    SELECT 1 FROM `productCustomizationTemplates` existing
    WHERE existing.`productId` = p.`id`
  );
--> statement-breakpoint

INSERT INTO `productCustomizationFields`
  (`templateId`, `fieldKey`, `label`, `fieldType`, `isRequired`, `sortOrder`, `optionsJson`, `dependencyJson`, `priceDelta`, `isActive`)
SELECT
  t.`id`,
  'service',
  'نوع التنفيذ',
  'SELECT',
  true,
  10,
  JSON_ARRAY(
    JSON_OBJECT('value', 'text', 'label', 'اسم أو عبارة', 'priceDelta', '0'),
    JSON_OBJECT('value', 'file', 'label', 'صورة أو تصميم', 'priceDelta', '0'),
    JSON_OBJECT('value', 'full', 'label', 'طباعة كاملة', 'priceDelta', '0')
  ),
  NULL,
  '0',
  true
FROM `productCustomizationTemplates` t
WHERE t.`kind` = 'PRINT'
  AND NOT EXISTS (
    SELECT 1 FROM `productCustomizationFields` existing
    WHERE existing.`templateId` = t.`id` AND existing.`fieldKey` = 'service'
  );
--> statement-breakpoint

INSERT INTO `productCustomizationFields`
  (`templateId`, `fieldKey`, `label`, `fieldType`, `isRequired`, `sortOrder`, `optionsJson`, `dependencyJson`, `priceDelta`, `isActive`)
SELECT
  t.`id`,
  'packaging',
  'التغليف',
  'SELECT',
  false,
  20,
  JSON_ARRAY(
    JSON_OBJECT('value', 'standard', 'label', 'تغليف عادي', 'priceDelta', '0'),
    JSON_OBJECT('value', 'gift', 'label', 'تغليف هدية', 'priceDelta', '0')
  ),
  NULL,
  '0',
  true
FROM `productCustomizationTemplates` t
WHERE NOT EXISTS (
  SELECT 1 FROM `productCustomizationFields` existing
  WHERE existing.`templateId` = t.`id` AND existing.`fieldKey` = 'packaging'
);
--> statement-breakpoint

INSERT INTO `productCustomizationFields`
  (`templateId`, `fieldKey`, `label`, `fieldType`, `isRequired`, `sortOrder`, `maxLength`, `optionsJson`, `dependencyJson`, `priceDelta`, `isActive`)
SELECT
  t.`id`,
  'message',
  'رسالة أو تفاصيل إضافية',
  'TEXTAREA',
  false,
  30,
  300,
  NULL,
  JSON_OBJECT('fieldKey', 'service', 'operator', 'equals', 'value', JSON_ARRAY('text', 'full')),
  '0',
  true
FROM `productCustomizationTemplates` t
WHERE t.`kind` = 'PRINT'
  AND NOT EXISTS (
    SELECT 1 FROM `productCustomizationFields` existing
    WHERE existing.`templateId` = t.`id` AND existing.`fieldKey` = 'message'
  );
--> statement-breakpoint

INSERT INTO `productCustomizationFields`
  (`templateId`, `fieldKey`, `label`, `fieldType`, `isRequired`, `sortOrder`, `optionsJson`, `dependencyJson`, `priceDelta`, `isActive`)
SELECT
  t.`id`,
  'designFile',
  'مرجع ملف التصميم',
  'FILE',
  true,
  40,
  NULL,
  JSON_OBJECT('fieldKey', 'service', 'operator', 'equals', 'value', JSON_ARRAY('file', 'full')),
  '0',
  true
FROM `productCustomizationTemplates` t
WHERE t.`kind` = 'PRINT'
  AND NOT EXISTS (
    SELECT 1 FROM `productCustomizationFields` existing
    WHERE existing.`templateId` = t.`id` AND existing.`fieldKey` = 'designFile'
  );
--> statement-breakpoint

INSERT INTO `productCustomizationFields`
  (`templateId`, `fieldKey`, `label`, `fieldType`, `isRequired`, `sortOrder`, `maxLength`, `optionsJson`, `dependencyJson`, `priceDelta`, `isActive`)
SELECT
  t.`id`,
  'recipient',
  'اسم المستلم',
  'TEXT',
  false,
  25,
  120,
  NULL,
  NULL,
  '0',
  true
FROM `productCustomizationTemplates` t
WHERE t.`kind` = 'GIFT'
  AND NOT EXISTS (
    SELECT 1 FROM `productCustomizationFields` existing
    WHERE existing.`templateId` = t.`id` AND existing.`fieldKey` = 'recipient'
  );
--> statement-breakpoint

INSERT INTO `productCustomizationFields`
  (`templateId`, `fieldKey`, `label`, `fieldType`, `isRequired`, `sortOrder`, `maxLength`, `optionsJson`, `dependencyJson`, `priceDelta`, `isActive`)
SELECT
  t.`id`,
  'message',
  'رسالة الإهداء',
  'TEXTAREA',
  false,
  30,
  300,
  NULL,
  NULL,
  '0',
  true
FROM `productCustomizationTemplates` t
WHERE t.`kind` = 'GIFT'
  AND NOT EXISTS (
    SELECT 1 FROM `productCustomizationFields` existing
    WHERE existing.`templateId` = t.`id` AND existing.`fieldKey` = 'message'
  );
