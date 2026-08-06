package online.alarabiya.superapp.feature.marketing

/** Server-contract limitations intentionally kept visible to prevent the native UI from overstating safety. */
object MarketingApiGaps {
    val current: List<String> = listOf(
        "salesPromotions.create/update/deactivate/reactivate لا تقبل clientRequestId؛ يمنع التطبيق النقر المزدوج ولا يعيد الطلب تلقائيًا، لكن الحماية الكاملة تحتاج idempotency خادمية.",
        "crm.coupons.createProgram وcrm.coupons.issue لا تقبلان clientRequestId؛ الإصدار خصوصًا قد ينشئ رموزًا إضافية بعد انقطاع غير محسوم، لذلك لا توجد إعادة محاولة تلقائية.",
        "crm.coupons لا يوفر getProgram أو updateProgram؛ تفاصيل البرنامج مأخوذة من القائمة ولا يظهر زر تعديل زائف.",
        "crm.coupons.preview يحسب الأثر في الخادم ولا يستهلك الكوبون، لكنه يعتمد unitPrice ومعرّفات السطر المرسلة من مسار البيع؛ الاعتماد النهائي يبقى داخل sales.create.",
        "catalogAnomalies بيانات كتالوج عالمية بلا branchId في العقد؛ الوصول مقيد خادميًا إلى manager/accountant/auditor وبصلاحية الوحدة، وليس بعزل فرع.",
        "catalogAnomalies.revertChange يغير تكلفة فعلية بلا clientRequestId أو maker-checker؛ استبعد من تطبيق الهاتف إلى أن يتوفر مسار اعتماد آمن.",
        "الراوتر promotions القديم خاص بترقيات الموظفين وليس عروض الأسعار؛ الوحدة الأصلية تستخدم salesPromotions فقط لتجنب خلط نطاقين متشابهَي الاسم.",
    )
}
