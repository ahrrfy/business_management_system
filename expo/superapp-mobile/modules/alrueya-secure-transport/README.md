# alrueya-secure-transport

وحدة Expo محلية لحماية نقل «سوبر العربية». العقد الحالي لا يتيح لطبقة TypeScript إلا
التحقق من حالة الحماية ونداء إجراءات مراجعة بالاسم؛ لا يوجد getter أو setter للكوكي أو
عداد replay أو توقيع عام أو `fetch(url)` حر.

## النقل المنفذ

- مفتاح إثبات P-256 غير قابل للتصدير داخل Android Keystore، مع StrongBox مفضّل عند توفره.
- جلسة `app_session_id` مشفرة بـ AES-GCM بمفتاح Android Keystore ولا تعبر جسر JavaScript.
- تواقيع الطلبات والـnonce والعداد تصنع داخلياً على نفس canonical bytes التي يتحقق منها
  `server/auth/deviceProof.ts`.
- يسمح الناقل بإجراءات محددة فقط: `auth.login` و`auth.twoFactorVerify` و`auth.logout`،
  ومسارات «يومي» المقفلة: `superApp.mobileToday` و`mobileAttendanceHistory`
  و`mobilePayslipReveal` و`mobileRequestLeave` و`mobileWithdrawLatestLeave`
  و`mobileStartFocusedTask` و`mobileResolveFocusedTask`، إضافة إلى
  `superApp.mobileCommandCenter` و`mobileExpoPushStatus` و`mobileRegisterExpoPush`
  و`mobileRevokeExpoPush`. لا توجد نقطة نهاية عامة، ولا يقبل أي إجراءٍ أو معرّف
  موظف/فرع/مهمة من JavaScript خارج هذه العقود.
- عنوان الخادم وSPKI pins يحقنان عند البناء بواسطة
  `plugins/withAlrueyaSecureTransport.js`. بناء الإنتاج يفشل عند غياب pin، والمطابقة
  تتحقق بعد TLS/hostname validation وقبل إرسال جسم POST.
- iOS يطبق العقد نفسه: URLSession يفحص سلسلة TLS الافتراضية ثم SPKI لكل شهادة معتمدة، والجلسة في Keychain بـ`biometryCurrentSet`. لا يمكن لـJavaScript تغيير endpoint أو pins.

## حدود الإصدار الصريحة

- يحتاج تعادل iOS للنقل المثبت الشهادة والتخزين المقفل بناء Xcode واختبار iPhone فعلي؛ Windows لا يكفي لإثباته.
- تصدير الحضور وكشف الراتب PDF يتم داخل التطبيق بعد الكشف المحلي للراتب؛ الجلسة أو
  بيانات الراتب لا تُكتب في التخزين العام. تسجيل/إلغاء إشعارات Expo يمر حصراً عبر الإجراءات
  المسماة أعلاه بعد إثبات الجهاز؛ لا تصل إلى TypeScript بصمة المفتاح أو cookie أو endpoint.
  المسح ليس مدمجاً بعد لأن مساراً تشغيلياً مراجعاً وصلاحية الكاميرا لازمان قبل إظهاره.
- لا تُعامل «يومي» كإطلاق إنتاجي قبل اختبار Development Build على جهازين فعليين وتمرير pin mismatch وlogout/replay.
