-- RBAC ش٣ — ترقية الأدوار إلى كيان قياسيّ من الدرجة الأولى (أدوارٌ قياسية محميّة + وسم القسم).
-- إضافيّة بحتة: كل عمود nullable أو له DEFAULT ⇒ ADD COLUMN فوريّ (INSTANT) على MySQL 8، وعكسه
-- DROP COLUMN — صفر أثر على أي دور مُسنَد. ⚠️ MySQL 8 لا يدعم ADD COLUMN IF NOT EXISTS (نمط 0091/0108).
--   isSystem: الأدوار القياسية المبذورة (كاشير تجزئة/طباعة/موظف استقبال) محميّة من الحذف/تغيير الفئة،
--             قابلة للتحرير المُدقَّق. الأدوار المخصّصة التي يصنعها المالك = false (الافتراضي).
--   station:  تلميح عرضٍ لقسم POS (RETAIL/PRINT_SERVICES/RECEPTION) — الحقيقة تبقى مشتقّة من الخريطة
--             المحلولة (deriveStation)؛ العمود لتسريع منتقي الدور فقط، NULL للأدوار غير المرتبطة بقسم.
ALTER TABLE `roles` ADD `isSystem` boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE `roles` ADD `station` varchar(20);
