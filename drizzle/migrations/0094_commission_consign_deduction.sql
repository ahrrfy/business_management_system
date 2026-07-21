-- بضاعة الأمانة (ش٣): لقطة خصم حصص المودِعين في سطر تشغيلة العمولة (اكتمال اللقطة المحصَّنة).
-- راجع docs/consignment-design-2026-07-20.md §٤.١. DEFAULT آمن على البيانات القائمة.
ALTER TABLE `commissionRunLines` ADD `baseConsignDeduction` decimal(15,2) NOT NULL DEFAULT '0';
