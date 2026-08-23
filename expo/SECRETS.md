# إدارة الملفات الحساسة والاعتمادات

هذا الدليل يعرّف **أين تُدار الاعتمادات وكيف تُستعاد أو تُدوَّر**. لا يحتوي أي قيمة حساسة، ولا يجوز إضافة القيم الفعلية إلى GitHub أو الدردشة أو سجلات CI.

## تصنيف الملفات

| العنصر | هل يرفع إلى GitHub؟ | أين يُدار أو يُستعاد؟ | الإجراء عند الفقد أو الاشتباه |
|---|---|---|---|
| `google-services.json` و`GoogleService-Info.plist` | نعم في هذا المستودع الخاص بعد فحصه؛ هما إعداد عميل لا مفتاح خادم | Firebase Console → Project settings → التطبيق Android أو Apple → تنزيل ملف الإعداد | نزّل ملفاً جديداً من Firebase عند تغيير التطبيق؛ لا تعدله يدوياً. |
| Android upload keystore و`credentials.json` | **لا** | EAS CLI: `eas credentials` ثم Android → Download credentials، أو Expo Credentials Dashboard | خزّن النسخة في مدير كلمات مرور/خزنة مشفرة؛ عند استخدام Play App Signing يمكن طلب إعادة ضبط Upload key. |
| Apple ID وكلمات مرور الحساب ورموز 2FA | **لا** | Apple Account وApple Developer Portal فقط | غيّر كلمة المرور وألغِ الجلسات عند الاشتباه؛ لا تشاركها مع أي شخص. |
| Apple Distribution Certificate / APNs `.p8` / App Store Connect API key | **لا** | Apple Developer أو App Store Connect؛ ويمكن لـEAS إدارتها | ألغِ المفتاح أو الشهادة المتأثرة وأنشئ بديلاً؛ ملف APNs `.p8` لا يمكن تنزيله مرة ثانية بعد إنشائه. |
| `EXPO_TOKEN` | **لا** | Expo dashboard → Access tokens؛ أنشئ رمزاً جديداً عند الحاجة | ألغِ الرمز فوراً إذا ظهر في سجل أو محادثة. |
| Google Play service-account JSON | **لا** | Google Cloud Console → Service Accounts، مع أقل صلاحيات ممكنة | ألغِ المفتاح وأنشئ مفتاحاً جديداً؛ لا ترفعه إلى GitHub. |
| إنتاج الخادم `.env` أو مفاتيح قاعدة البيانات وTurnstile | **لا** | خادم Hostinger وحسابات موفر الخدمة ذاتها | تدوير الاعتماد، تحديث مخزن الأسرار، وإعادة نشر محروسة فقط. |

## الوصول الصحيح

1. **Firebase:** سجل الدخول إلى Firebase Console باستخدام حساب مالك المشروع. ملفات إعداد Apple/Android تربط التطبيق بمشروع Firebase، ومحتواها يعتبر عاماً من منظور Firebase، لكنه يُعامل هنا كإعداد تشغيلي لا يُعرض في السجلات. لا تمنح هذه الملفات صلاحية خادم أو إدارة قاعدة البيانات.[1]
2. **Expo/EAS:** استخدم `eas credentials` لإدارة أو تنزيل اعتمادات توقيع التطبيق من حساب Expo. لا تُضف keystore أو ملفات `credentials.json` إلى Git؛ تحتفظ EAS بالاعتمادات مشفرة عندما تكون مدارة لديها.[2] [3]
3. **Apple:** بعد عضوية Apple Developer، يكون Account Holder هو من يقبل الاتفاقيات ويجدد العضوية. يمكن إعطاء فريق التطبيق صلاحية مناسبة بدلاً من مشاركة Apple ID.[4]
4. **Google Play:** احتفظ بمفتاح حساب الخدمة في مخزن أسرار أو EAS Secrets فقط؛ يجب أن يملك أقل دور يسمح بالرفع لمسار الاختبار الداخلي.
5. **Hostinger:** لا تنسخ `.env` من الخادم إلى جهاز أو مستودع. الوصول يتم فقط بحساب النشر المحدود وضمن طرفية المالك.

## فحص ما قبل الدفع

```bash
git grep -nEi '(PRIVATE KEY|client_secret|service_account|EXPO_TOKEN|password=)' -- ':!**/*.md'
git check-ignore -v credentials.json '*.jks' '*.p8' '*.p12' '*.pem' || true
```

إذا أعاد الفحص نتيجة، أوقف الدفع، أزل القيمة من السجل، ودوّر الاعتماد إن كان قد ظهر خارج مخزن الأسرار.

## المصادر

[1] Firebase, "Understand Firebase projects — Firebase config files and objects": https://firebase.google.com/docs/projects/learn-more#config-files-objects

[2] Expo, "App credentials": https://docs.expo.dev/app-signing/app-credentials/

[3] Expo, "Security": https://docs.expo.dev/app-signing/security/

[4] Apple, "Roles and access": https://developer.apple.com/help/account/manage-your-team/roles/
