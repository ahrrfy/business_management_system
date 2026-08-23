# جاهزية Apple Developer وبناء iOS لاختبار OTP

## مسار التسجيل الموصى به

التطبيق يحمل اسم مؤسسة، لذلك يوصى بالتسجيل في Apple Developer Program كـ **Organization** حتى يظهر الاسم القانوني للمؤسسة كبائع في App Store بدلاً من الاسم الشخصي. يلزم وجود Apple Account مفعّل عليه التحقق بخطوتين، مع أن يكون صاحب الحساب مخولاً قانونياً بتوقيع الاتفاقيات باسم المؤسسة.

| المطلوب | الغرض | متى يستخدم |
|---|---|---|
| Apple Account باسم الشخص المخول قانونياً | حساب Account Holder والتوقيع على الاتفاقية | بداية التسجيل وربط EAS |
| مصادقة ثنائية مفعلة | شرط Apple للحساب | قبل التسجيل |
| الاسم القانوني المسجل للمؤسسة | يظهر كبائع في App Store | استمارة Organization |
| رقم D-U-N-S من 9 أرقام | تحقق Apple من الكيان القانوني والعنوان | استمارة Organization |
| بريد عمل على نطاق المؤسسة وموقع عام فعال | يثبت الارتباط بالمؤسسة | استمارة Organization |
| عنوان ورقم هاتف جهة العمل | تحقق الهوية والتواصل | استمارة Organization |
| سلطة قانونية أو مرجع مخول | تحقق Apple من الصلاحية | إن لم يكن المسجل المالك/المؤسس |
| وسيلة دفع صالحة | رسوم العضوية السنوية | بعد قبول بيانات التسجيل |

رسوم Apple Developer Program هي 99 دولاراً أمريكياً سنوياً قبل الضرائب حيثما ينطبق؛ قد تظهر العملة والسعر المحليان أثناء التسجيل.

## مسار بناء واختبار iOS

1. بعد قبول العضوية، يسجل EAS جهاز iPhone الاختباري ضمن إعداد Ad Hoc، ثم ينشئ بروفايل provisioning جديد يشمل UDID للجهاز.
2. ينشأ بناء iOS داخلي جديد يضم `GoogleService-Info.plist` ووحدتي React Native Firebase الأصليتين؛ لا يُختبر OTP في Expo Go أو في باينري أقدم.
3. يثبت البناء على الجهاز المسجل فقط، ثم تجرى محاولة OTP واحدة وفق قائمة الاختبار أدناه.

قد تتطلب عضوية Apple الجديدة أو المتجددة 24–72 ساعة قبل قبول جهاز جديد في بروفايل Ad Hoc؛ هذه مدة معالجة Apple وليست عطل بناء.

## بروتوكول محاولة OTP الوحيدة

1. ثبّت أحدث APK Android أو البناء iOS الأصلي، وتأكد أولاً من عدم ظهور أخطاء SecureStore أو NativeRNFB.
2. تحقق في Firebase Console أن Phone provider مفعّل وأن حد Spark اليومي لم يُستهلك؛ يفضّل رقم اختبار Firebase عند توفره.
3. استخدم رقماً عراقياً صحيحاً بصيغة محلية `07xxxxxxxxx` مرة واحدة فقط، ثم انتظر شاشة إدخال الرمز.
4. أدخل رمز SMS خلال صلاحيته، وتحقق من انتقال الولاء من حالة غير موثقة إلى حالة العميل الموثق.
5. عند أي فشل، التقط لقطة واحدة للرسالة ووقت المحاولة والمنصة وإصدار التطبيق. لا تعِد الطلب؛ راجع رمز Firebase أولاً.

## المصادر

1. Apple, "Become a member": https://developer.apple.com/programs/enroll/
2. Apple, "Program enrollment": https://developer.apple.com/help/account/membership/program-enrollment/
3. Expo, "Internal distribution": https://docs.expo.dev/build/internal-distribution/
4. Expo, "Create and share internal distribution build": https://docs.expo.dev/tutorial/eas/internal-distribution-builds/
