-- إصلاح مسار بيع الكروت والاشتراكات لحسابات «كاشير تجزئة» القائمة.
--
-- الأدوار القياسية تُخزّن لقطة كاملة من الصلاحيات. بعض صفوف retail_cashier
-- سُجّلت قبل إضافة digital_cards، والغياب يُفسَّر عمداً كـ NONE عند حلّ الدور
-- (فلا يكفي أن يحمل قالب cashier الحالي READ). نمنح READ فقط حين يكون المفتاح
-- غائباً، ولا نغيّر قرار مديرٍ حفظ NONE صراحةً.
UPDATE `roles`
SET `permissions` = JSON_SET(COALESCE(`permissions`, JSON_OBJECT()), '$.digital_cards', 'READ')
WHERE `key` = 'retail_cashier'
  AND `baseRole` = 'cashier'
  AND JSON_EXTRACT(`permissions`, '$.digital_cards') IS NULL;
