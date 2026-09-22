# عطل بدء Android في الإصدار 17

## العارض

يسقط الإصدار `1.0.0 (17)` خلال الثانية الأولى من التشغيل في
`MainApplication.onCreate` مع:

```text
com.facebook.soloader.SoLoaderDSONotFoundError:
couldn't find DSO to load: libreactnative.so
```

سجّل Crashlytics 11 حدثاً لسبعة مستخدمين، كلّها على الإصدار 17 ومن أجهزة مُعرّفة
كـOnePlus. العينة المفصّلة المفتوحة مُعرّفة كـOnePlus 8 Pro بنظام Android 11.
يبيّن أثر SoLoader أن بيئة التشغيل تبحث في `lib/x86_64`، بينما حزمة الإصدار 17
لا تضم إلا `base/lib/arm64-v8a`.

## السبب الجذري

كان `app.config.js` يقيّد `expo-build-properties.android.buildArchs` إلى
`arm64-v8a` فقط عند بناء الإصدار 17. أضيف `armeabi-v7a` لاحقاً، لكن الإصدار 18
ظل بلا `x86` و`x86_64`، ولذلك لم يغلق العطل.

هذا التقييد مخصّص لتسريع البناء المحلي، لا لبناء الإصدار. افتراض Expo وReact
Native للإصدار هو المعماريات الأربع: `armeabi-v7a` و`arm64-v8a` و`x86`
و`x86_64`. أما Android App Bundle فيسلّم لكل جهاز مكتبات ABI المطابقة فقط، فلا
تحتاج حزمة Play إلى إسقاط معماريات لتقليل تنزيل المستخدم.

## الإصلاح والحارس

- أزيل override `buildArchs` ليعود البناء إلى مجموعة Expo الافتراضية الكاملة.
- أضيف `pnpm check:android-release` إلى CI وإلى hook `eas-build-post-install` كي
  يفشل البناء عند إعادة تقييد المعماريات.
- يقبل الحارس `--aab <path>` ويفحص الحزمة الفعلية قبل الرفع، ويشترط وجود
  `libreactnative.so` و`libhermes.so` و`libfbjni.so` لكل ABI.

## قبول الإصدار البديل

1. ابنِ AAB جديداً برقم بناء أعلى من 18.
2. شغّل `pnpm check:android-release --aab <artifact.aab>`.
3. ثبّت النسخة من مسار Internal testing على بيئة x86_64 وعلى جهاز arm64 حقيقي.
4. افتح التطبيق مرتين وتحقق من غياب مجموعة Crashlytics نفسها في الإصدار الجديد.
