-- ٨/٨ — ختمُ تسليم المندوب الذاتيّ (توصيلاتي) لإرساليات الاستقبال: إفصاحٌ تشغيليّ فقط،
-- لا يمسّ التسوية/العهدة/الدفتر (توريد المندوب يبقى مسار المال كما هو).
ALTER TABLE `deliveryConsignments` ADD COLUMN `courierDeliveredAt` timestamp NULL;
