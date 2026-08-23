# تحقيق Firebase الأصلي على iOS — 2026-08-23

## الدليل الميداني

أظهر اختبار iOS خطأ `Native module NativeRNFBTurboApp is not registered` عند تنفيذ `require("@react-native-firebase/auth")` في `lib/firebase-phone-auth.native.ts`. لذلك يفشل مسار OTP قبل الاتصال بخدمة Firebase أو التحقق من حصة الرسائل.

أظهر فحص Firebase Console بحساب المالك أن مشروع `store-alarabiya` يحتوي تطبيق Android واحداً فقط باسم الحزمة `online.alarabiya.customerstore` وبصمتي SHA-1 وSHA-256، ولا يحتوي تطبيق iOS مسجلاً. لذلك لا يتوفر ملف `GoogleService-Info.plist` ولا يمكن لبناء iOS تكوين Firebase الأصلي.

## الاستنتاج

المشروع يضم حزمتَي `@react-native-firebase/app` و`@react-native-firebase/auth` وإضافتيهما في `app.config.ts`، لكنه لا يعرّف `ios.googleServicesFile` ولا يحتوي ملف `GoogleService-Info.plist` الخاص بتطبيق iOS. كما أن رسالة التطبيق القديمة التي تنسب الخطأ إلى Expo Go مضللة عندما يظهر في بناء iOS أصلي؛ الخطأ يثبت أن الباينري المثبّت لا يضم وحدة RNFB أو لا يحمل تهيئة iOS الأصلية اللازمة.

## الإعداد المطلوب قبل البناء التالي

يجب تسجيل تطبيق iOS في مشروع Firebase بالمعرّف `online.alarabiya.customerstore`، تنزيل `GoogleService-Info.plist` إلى جذر المشروع، وتعيين `ios.googleServicesFile` إلى مساره. تبقى إضافتا RNFB و`expo-build-properties` مع `ios.useFrameworks: "dynamic"` لازمتين، ثم يلزم إنشاء بناء iOS جديد كلياً وإزالة أي بناء قديم لا يحتوي الوحدات الأصلية.

## حالة المعالجة

تم في 2026-08-23 تسجيل تطبيق Apple باسم «مكتبة العربية – متجر العملاء iOS» بالمعرّف `online.alarabiya.customerstore` بعد موافقة المالك. تم تنزيل ملف `GoogleService-Info.plist` ومطابقة `BUNDLE_ID` من دون عرض مفاتيحه، ثم نسخه إلى جذر المشروع وربطه في `app.config.ts`. أثبت `expo config --type public` ظهوره في التهيئة، ونجحت فحوص TypeScript وVitest (11 اختباراً ناجحاً واختبار واحد متجاوز). لا يُثبت ذلك نجاح OTP بعد؛ إذ يلزم بناء iOS جديد أصلي وتثبيته على جهاز فعلي، ولا تصلح نسخة Expo Go أو أي باينري أقدم لهذا الاختبار.

## المصادر

- Expo, "Using Firebase", 2026-07-17: https://docs.expo.dev/guides/using-firebase/
- React Native Firebase, "Installation for Expo projects": https://rnfirebase.io/
