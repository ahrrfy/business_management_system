package online.alarabiya.superapp.feature.store

object StoreDeliveryApiGaps {
    val current: List<String> = listOf(
        "storeAdmin.orders.list لا يدعم بحثاً نصياً؛ البحث داخل الصفحات المحمّلة فقط.",
        "storeAdmin.orders.list يعيد مصفوفة بلا hasMore؛ التحميل التالي يعتمد اكتمال حجم الصفحة.",
        "courier.myDeliveries لا يعيد بنود الطلب؛ شاشة المندوب تعرض بيانات التسليم والتحصيل فقط.",
        "storeAdmin.orders.dispatch لا يقبل clientRequestId؛ منع النقر المزدوج في العميل مع بقاء الإرسال idempotent حسب الطلب في الخادم.",
    )
}
