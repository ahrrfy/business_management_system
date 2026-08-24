# ═════════════════════════════════════════════════════════════════════════════
# قواعد ProGuard/R8 لـ«سوبر العربية» — مُعادُ صياغتها ٢٤/٨ لإغلاق M8 من التدقيق
# الجنائيّ (docs/super-alarabiya-forensic-audit-2026-08-24.md).
# ═════════════════════════════════════════════════════════════════════════════

# ─── Reflection ────────────────────────────────────────────────────────────────
-keepattributes *Annotation*
-dontwarn org.json.**

# ─── قابلية تشخيص Play Vitals ──────────────────────────────────────────────────
# R8 يُسقط SourceFile/LineNumberTable افتراضياً ⇒ stack traces من Play Vitals تصلنا
# بلا أرقام أسطر (كأنّها في release-only دالّةٌ واحدة اسمها `a`). نبقيهما، ونعيد تسمية
# SourceFile إلى قيمةٍ ثابتة تستفيد منها mapping.txt.
-keepattributes SourceFile,LineNumberTable,InnerClasses,Signature,EnclosingMethod
-renamesourcefileattribute SourceFile

# ─── Log stripping (M8) ────────────────────────────────────────────────────────
# نُزيل استدعاءات Log.v/d/i/w/e من release ⇒ لا رسائل تشخيصية عن مسار المصادقة أو
# تسجيل FCM تصل logcat على جهازٍ فُتح ADB عليه (سيناريو نادر لكنّه محسوم عبر هذه
# القاعدة). Log.wtf يبقى (يُسجَّل في Crashlytics عند تفعيلها).
-assumenosideeffects class android.util.Log {
    public static *** v(...);
    public static *** d(...);
    public static *** i(...);
    public static *** w(...);
    public static *** e(...);
}

# ─── إخفاء أعمق للحزم ─────────────────────────────────────────────────────────
# يُقلّص أسماء الحزم إلى أحرف قصيرة — يمنع كشف بنية التطبيق من ملفّ APK لأيّ باحثٍ
# خارجيّ. لا يمسّ الأصول المُبقاة بـ-keep.
-repackageclasses ''

# ─── Firebase Messaging ───────────────────────────────────────────────────────
# Firebase يستعمل reflection في مسارات الـinstance ID + FCM Service. القواعد أسفل
# من دليل Firebase الرسميّ وحفاظاً على AlrueyaFirebaseMessagingService المُصدَّر.
-keepnames class online.alarabiya.superapp.core.notifications.AlrueyaFirebaseMessagingService
-keep class com.google.firebase.messaging.FirebaseMessagingService { *; }
-keep class com.google.firebase.iid.FirebaseInstanceId { *; }

# ─── DeviceProofKey + Session (تحفَّظ الأسماء لسلامة interop مع Keystore aliases) ──
# مفاتيح AndroidKeyStore تُشار إليها باسم alias نصّيّ. R8 قد يُعيد تسمية الحقول
# الثابتة داخل الصنف لكن قيمة الـString نفسها (KEY_ALIAS) تبقى — نُبقي الأسماء
# احتياطياً لتيسير التشخيص من stack traces.
-keepnames class online.alarabiya.superapp.core.security.** { *; }

# ─── kotlinx.serialization (لو استُعمل مستقبلاً) ──────────────────────────────
-keep,includedescriptorclasses class online.alarabiya.superapp.**$$serializer { *; }
-keepclassmembers class online.alarabiya.superapp.** {
    *** Companion;
}
-keepclasseswithmembers class online.alarabiya.superapp.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# ─── Compose runtime hooks ────────────────────────────────────────────────────
# Compose يعتمد على تكوين @Composable + تحويلاته. القواعد الرسمية تحمي هذا.
-keep class kotlin.Metadata { *; }
