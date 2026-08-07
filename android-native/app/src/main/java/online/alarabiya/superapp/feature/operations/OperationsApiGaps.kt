package online.alarabiya.superapp.feature.operations

object OperationsApiGaps {
    val current: List<String> = listOf(
        "assets.list وassets.get لا يفرضان عزل الفرع في الخادم؛ التطبيق يثبت فرع المستخدم ولا يطلب التفاصيل الموسعة لغير admin، لكن يلزم إصلاح IDOR خادمي.",
        "assets.custodyReport وassets.formOptions يعيدان بيانات كل الفروع؛ استُبعدا من التطبيق الأصلي واعتمدت شاشة العُهد على assets.list المقيدة محلياً.",
        "assets.addMaintenance يرحّل تكلفة نقدية مباشرة بلا clientRequestId أو maker-checker؛ التطبيق المتنقل يسمح بصيانة صفرية فقط حتى إضافة مسار موافقة مالي.",
        "consignments.get يعيد unitShareSnapshot بلا canSeeCostForUser؛ التطبيق لا يستدعيه لغير admin ولا يعرض حقل الحصة مطلقاً حتى يُحجب خادمياً.",
        "commissions.performance.myStatus قد يعيد JSON null، بينما TrpcClient الحالي يقبل الكائنات فقط؛ المستودع يترجم null المعروف إلى حالة فارغة.",
        "consignments لا يوفّر قائمة مودعين مستقلة ضمن الوحدة؛ الإنشاء المتنقل السريع يبدأ من سند مودع موجود ويدعم إيداعاً أو سحباً بسطر واحد، لا الاستبدال متعدد الأسطر.",
        "consignments.list يوفّر offset/total ولا يوفّر cursor؛ التحميل يستخدم offset مع منع الإرسال المزدوج في ViewModel.",
    )
}
