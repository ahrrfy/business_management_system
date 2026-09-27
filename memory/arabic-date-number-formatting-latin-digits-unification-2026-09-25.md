# ذاكرة المشروع: حملة التوحيد الشامل لتنسيق التواريخ والأرقام اللاتينية واستئصال النصوص المعكوسة (2026-09-25)

> **تاريخ الإنجاز:** 25 سبتمبر 2026  
> **طلب الدمج الأساسي:** PR #1259 (`fix(i18n): unify date and number formatting to Latin digits and prevent inverted placeholders`)  
> **الالتزام المدموج في main:** `75a89d8decca3cb324a37aed2b78cae1ed5e660a`  
> **حالة النشر الإنتاجي:** نُشر بنجاح على خادم الإنتاج المشترك (Hostinger VPS - `srv1548487.hstgr.cloud`) عبر `pnpm prod:deploy`، واستقرار تام لـ PM2 Cluster وجسر الحضور مع اجتياز فحص `/healthz`.

---

## ١. سياق الحملة وتوجيه المالك الحاسم

بناءً على طلب وتوجيه المالك الصريح والملزم بتاريخ 25/8/26 و 25/9/26:
> «هذه المشكلة في العرض إما مقلوبة الكتابة أو تحتوي على أرقام بالتنسيق العربي والمراد هو تنسيق إنكليزي 1234 مثل هذا، وهذه في جميع شاشات النظام وصفحاته. فعّل بروتوكول الفحص الجنائي والكشف والتحقيق عن السبب ونفّذ التعديلات والمعالجات والإصلاحات بفريق وبروتوكولات Sub-Agents Network و V.E.R.I.F.Y Protocols و Zero-Hallucination & Fact-Check و Closed-Loop Auto-Correction بشكل عميق وذري وشامل 100%».

---

## ٢. التحقيق الجنائي والأسباب الجذرية (Forensic RCA)

كشف التحقيق الجنائي المعمّق عبر شبكة الوكلاء الفرعيين (Sub-Agents Network) عن 3 أسباب رئيسية متداخلة:

1. **خلل محرك المتصفح وانعكاس النصوص التوجيهية (Chromium BiDi Shadow DOM Reversal):**
   - في بيئات اتجاه اليمين لليسار (`<html dir="rtl">` أو الحاويات الأبوية ذات `dir="rtl"`):
   - يتعامل متصفح Chromium/Blink مع عناصر `<input type="date">` داخل Shadow DOM عبر تجميع أجزاء التاريخ بصورة معكوسة فيظهر النص التوجيهي الداخلي مقلوباً كـ `ةنس/رهش/موي` بدلاً من `يوم/شهر/سنة` أو `dd/mm/yyyy`.
   - كما تنعكس مواضع أزرار الانتقال بين الخانات (الأيام والأشهر والسنوات) ومحدد التاريخ (Calendar Picker Icon).

2. **وراثة المحليات التلقائية واستخدام الأرقام المشرقية (ICU Locale Defaults):**
   - استدعاء دوال التنسيق القياسية مثل `toLocaleDateString("ar-IQ")` أو `Intl.DateTimeFormat` بدون تحديد نظام الترقيم يُنتج افتراضياً أرقاماً عربية مشرقية/هندية (`٢٥/٠٩/٢٠٢٦`).
   - وجود دالة صريحة سابقة في الكود `toArabicDigits` داخل `client/src/lib/variants.ts` كانت تقوم بتحويل الأرقام اللاتينية عمداً إلى أرقام مشرقية (`٠١٢٣٤٥٦٧٨٩`) في بطاقات ومحددات المتغيرات والأصناف.

3. **محارف التوجيه الخفية (BiDi RLM Characters `\u200f`):**
   - إضافة محرف الاتجاه من اليمين إلى اليسار (`\u200f`) حول الفواصل `/` يسبب خللاً عند نسخ التواريخ أو عرضها داخل حاويات مختلطة الاتجاه.

---

## ٣. المعالجات الهندسية والتحصينات الدفاعية (Defensive Architecture)

تم تنفيذ حل هندسي ذري متعدد الطبقات يضمن عدم تكرار المشكلة نهائياً (Defense-in-Depth):

### ٣.١ طبقة المكون القياسي الموحد (`client/src/components/ui/input.tsx`)
تم تزويد مكون `<Input>` القياسي بمنطق آلي يفرض الخصائص الآتية تلقائياً لأي حقل من نوع `date` أو `time` أو `datetime-local` أو `month`:
- `dir="ltr"` لمنع انعكاس نصوص الـ Shadow DOM.
- `lang="en-GB"` لضمان نسق التاريخ البريطاني/الأوروبي القياسي (`DD/MM/YYYY`) واستخدام الأرقام اللاتينية (`1234`).
- فئة `tabular-nums` لضمان تعامد واستقامة الأرقام في الجداول والنماذج.

### ٣.٢ طبقة الأنماط البصرية العامة الصارمة (`client/src/index.css`)
إضافة قاعدة CSS عامة قطعية بقوة `!important`:
```css
input[type="date"],
input[type="time"],
input[type="datetime-local"],
input[type="month"] {
  direction: ltr !important;
  font-variant-numeric: tabular-nums !important;
  unicode-bidi: isolate !important;
}
```

### ٣.٣ حارس وقت التشغيل الحي (`client/src/main.tsx`)
تم تدشين حارس وقت تشغيل ديناميكي `installDateTimeInputLocaleGuard()` يعتمد على `MutationObserver` لمراقبة كامل الـ DOM الحي:
- أي عنصر إدخال تاريخ أو وقت يتم حقنه ديناميكياً (عبر مكتبات خارجية، بوابات حوارية، أو نماذج منبثقة) يتم فوراً تزويده بـ `dir="ltr"` و `lang="en-GB"`.

### ٣.٤ استئصال الأرقام المشرقية في المتغيرات (`client/src/lib/variants.ts`)
- تحييد دالة `toArabicDigits` لترجع دائماً الأرقام اللاتينية الإنجليزية القياسية (`1234`) بصيغة نصية واضحة.
- تحديث اختبارات الوحدة في `client/src/lib/variants.test.ts` و `Storefront.test.ts` وتثبيتها.

### ٣.٥ معايرة وتطهير حقول الإدخال الخام (Raw Inputs Standardization)
تم فحص وتعديل أكثر من 14 ملفاً ومكوناً في الواجهة كانت تستخدم وسوم `<input>` خام بدلاً من المكون القياسي:
- `client/src/pages/PayrollReport.tsx`
- `client/src/components/workOrders/EditWorkOrderDialog.tsx`
- `client/src/components/pos/PaymentPanel.tsx`
- `client/src/pages/Attendance.tsx`
- `client/src/pages/ConsignmentNotes.tsx`
- `client/src/pages/CourierPerformanceReport.tsx`
- `client/src/pages/DayCloseReport.tsx`
- `client/src/pages/digitalCards/DigitalDashboard.tsx`
- `client/src/pages/PeriodLock.tsx`
- `client/src/pages/store/BannerManager.tsx`
- `client/src/pages/WorkOrders.tsx`
- `client/src/pages/IntegrationsSettings.tsx`
- `client/src/pages/OfflineSalesReport.tsx`
- `client/src/pages/Production.tsx`
- `client/src/pages/ReservationsHub.tsx`
- `client/src/pages/WhatsappHubReport.tsx`
- `client/src/pages/reception/ReceptionDraftsPage.tsx`
- `client/src/pages/ConsignmentSettlements.tsx`

### ٣.٦ حارس الجودة والمسننة الصارمة (`scripts/check-locale-numbers.mjs`)
- تطوير حارس الأرقام اللاتينية ليشمل فحص `toLocaleDateString` و `toLocaleTimeString` و `Intl.DateTimeFormat` والتأكد من اقتران أي محلي عربي بـ `-u-nu-latn` أو استخدام دالة `fmtDate` المعتمدة من `@/lib/date`.

---

## ٤. دورة التصحيح التلقائي المغلقة (Closed-Loop Auto-Correction)

- أثناء فحص CI على طلب الدمج #1259، دُمج طلب دمج متزامن (#1256) في `main`.
- أدّى ذلك لتعارض في 3 ملفات مشتركة:
  1. `client/src/components/reception/ReceiptOverlay.tsx`
  2. `client/src/pages/ConsignmentSettlements.tsx`
  3. `client/src/pages/reception/ReceptionDraftsPage.tsx`
- فُعّل بروتوكول التصحيح الذاتي التلقائي فوراً، وتم دمج استيرادات `formatQuantity` الحديثة مع استيرادات التاريخ `fmtDate` بسلاسة، مع اجتياز محلي لكافة الفحوصات `pnpm check` و `pnpm check:guards`.
- أُعيد الدفع، واجتاز طلب الدمج كامل شوارد CI الـ 14 بنسبة 100% Green.

---

## ٥. التحقق والدمج والنشر الإنتاجي

1. **الدمج في الفرع الرئيسي:**
   - دُمج طلب الدمج PR #1259 في `main` بالالتزام: `75a89d8decca3cb324a37aed2b78cae1ed5e660a`.
2. **النشر الذري المدار على VPS:**
   - نُفّذ أمر `pnpm prod:deploy` على خادم Hostinger VPS (`srv1548487.hstgr.cloud`).
   - استغرق النشر 220.1 ثانية، وتم بناء حزم الويب، وتحديث قاعدة البيانات، وتفعيل جسر الحضور، وإعادة تحميل PM2 Cluster بدون أي توقف للخدمة.
3. **التحقق المباشر من الإنتاج (Live Verification):**
   - فحص الحيوية `/healthz` أرجع `200 OK`: `{"ok":true,"time":"2026-09-25T19:51:10.881Z"}`.
   - التحقق من الالتزام الحي النشط على الخادم: `75a89d8d`.
   - عمال PM2 (`erp-server` و `erp-hr-bridge`) بحالة `online` مستقرة بنسبة 0% CPU.
