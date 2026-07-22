-- landed-cost (تكلفة الشحن/الكمرك على أمر الشراء): تُوزَّع على الأصناف بنسبة القيمة وتُرسمَل في
-- تكلفة المخزون (WAVG) عند الاستلام ⇒ تظهر في COGS عند البيع، وتُضاف إلى ذمّة المورّد (AP). لا
-- تُسجَّل مصروفَ P&L (منعُ ازدواج مع COGS). الافتراضيّ 0 ⇒ صفر أثر رجعيّ على الأوامر القائمة.
-- ⚠️ MySQL 8 لا يدعم ADD COLUMN IF NOT EXISTS — الإضافة صريحة (نمط 0090).
ALTER TABLE `purchaseOrders` ADD `shippingCost` decimal(15,2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `purchaseOrders` ADD `customsCost` decimal(15,2) DEFAULT '0' NOT NULL;
