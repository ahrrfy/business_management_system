# بناء Android محلياً على Windows

React Native/CMake قد يتجاوز حدّ طول المسار التقليدي في Windows عندما يكون مسار شجرة العمل طويلاً. هذا عائق أدوات محلي، لا إذن لتقصير مسارات المصدر أو تغيير هوية التطبيق.

## المسار المعتمد للفحص

1. يبقى المصدر المرجعي في شجرة العمل ويمر بفحوص TypeScript وVitest وExpo.
2. عند حاجة `assembleDebug`، انسخ **لقطة QA مؤقتة** من `expo/superapp-mobile` إلى مسار محلي قصير، مثل `D:\sa-qa`.
3. شغّل `pnpm install --frozen-lockfile --ignore-workspace` داخل النسخة المؤقتة، ثم `pnpm exec expo prebuild --platform android --clean` عندما تتغير plugins أصلية مثل `expo-notifications`، وبعدها شغّل Gradle منها.
4. لا تلتزم النسخة المؤقتة، ولا تستخدم APK الناتج للنشر أو التوقيع أو EAS. إنها دليل قابل لإعادة الإنتاج للبناء المحلي فقط.

```powershell
Set-Location D:\sa-qa\android
$env:NODE_ENV = 'development'
.\gradlew.bat ':app:assembleDebug' '-PreactNativeArchitectures=x86_64' '-Pkotlin.incremental=false' '--no-configuration-cache'
.\gradlew.bat ':alrueya-secure-transport:testDebugUnitTest' '-Pkotlin.incremental=false' '--no-configuration-cache'
```

أي إصدار فعلي يُبنى لاحقاً من شجرة نظيفة وهوية إنتاج موثقة؛ نجاح نسخة QA القصيرة لا يحل محل بوابة الإصدار أو اختبار iPhone.

بعد تركيب بناء جديد على المحاكي، افحص حساب الإشعارات بخط نظام `2.0` ثم أعده إلى `1.0`. لا تفعّل `EXPO_EAS_PROJECT_ID` أو الإرسال الخادمي في QA المحلي إلا لمشروع Expo مستقل ومراجع.
