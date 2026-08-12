package online.alarabiya.superapp.feature.operations

object OperationsApiGaps {
    val current: List<String> = listOf(
        "عزل assets.list/get/formOptions والكتابات أصبح خادمياً ومقيداً بالشركة/الفرع؛ التطبيق يعيد التحقق من effectiveBranchId دفاعاً في العمق.",
        "assets.returnCustody يفك العهدة تحت قفل المعاملة ويعيد الأصل من الخادم؛ التسليم والنقل والاسترجاع متاحة أصلياً.",
        "كتابات create/update/handover/dispose/documents لا تحمل clientRequestId؛ عند فشل نقل ملتبس يقفل التطبيق الإجراءات حتى تحديث السجل ومراجعته صراحةً.",
        "assets.addMaintenance يرحّل تكلفة نقدية مباشرة بلا clientRequestId أو maker-checker؛ التطبيق المتنقل يسمح بصيانة صفرية فقط حتى إضافة مسار موافقة مالي.",
        "consignments.get يعيد unitShareSnapshot بلا canSeeCostForUser؛ التطبيق لا يستدعيه لغير admin ولا يعرض حقل الحصة مطلقاً حتى يُحجب خادمياً.",
        "commissions.performance.myStatus قد يعيد JSON null؛ المستودع يستخدم عقد queryNullableObject المخصص ولا يفسر أخطاء النقل كحالة فارغة.",
        "consignments لا يوفّر قائمة مودعين مستقلة ضمن الوحدة؛ الإنشاء المتنقل السريع يبدأ من سند مودع موجود ويدعم إيداعاً أو سحباً بسطر واحد، لا الاستبدال متعدد الأسطر.",
        "consignments.list يوفّر offset/total ولا يوفّر cursor؛ التحميل يستخدم offset مع منع الإرسال المزدوج في ViewModel.",
    )
}
