# إصدار Android الداخلي لسوبر العربية

هذا المسار ينشئ أثراً موقّعاً من `main` فقط، ولا ينشره تلقائياً في Google Play.

## البوابة

1. يجب أن تكون بوابات CI وSecurity Audit وNative Android CI خضراء على رأس `main` أو سلف قريب تسمح به بوابة الإصدار.
2. يشغّل المشغل `Expo Super Arabia Android release artifact` يدوياً من `main`.
3. يستعيد المسار مفتاح الرفع و`google-services.json` من GitHub Secrets، ولا يطبعهما أو يرفعهما ضمن الأثر.
4. يعيد prebuild للإنتاج، ثم TypeScript وVitest وLint وExpo Doctor واختبارات وحدة النقل الأصلية وAndroid Lint.
5. لا يقبل الأثر إلا إذا طابقت الحزمة `online.alarabiya.store` والإصدار `1.1.1` ورمز الإصدار `19` وABI `arm64-v8a` وبصمة مفتاح الرفع المعتمدة، وأعاد مورد النقل المجمّع عنوان الخادم والمسامير المراجعة حرفياً.

## الرفع المسموح

- نزّل AAB من GitHub Artifact وتحقق من ملف `expo-superapp-android-SHA256SUMS.txt`.
- ارفعه إلى مسار **Internal testing** لتطبيق سوبر العربية الحالي.
- لا تضغط Production أو Start rollout أو إرسال المراجعة من هذا المسار.
- احتفظ بتطبيق Android الأصلي مرجعاً قابلاً للرجوع حتى نجاح اختبار تسجيل الدخول و2FA والحضور والقسيمة وPDF والمهمة والقفل على جهاز حقيقي.

## الإيقاف الآمن

أي اختلاف في package/version/signature أو فشل بوابة أو غياب اعتماد Firebase يوقف الإصدار. لا يُنشأ مفتاح جديد ولا تستبدل هوية التطبيق لمعالجة الفشل.
