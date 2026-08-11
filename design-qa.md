# Design QA — Digital Offering Assignments

## Scope

- Added assigned device and assigned wallet information to the digital cards/subscriptions table.
- Added an explicit column chooser while keeping all 11 columns visible by default.
- Preserved the existing RTL table, toolbar, status, and action patterns.

## Evidence

- Source screenshot: `C:/Users/alara/AppData/Local/Temp/codex-clipboard-eb39f77a-d34d-46f4-9ae9-268232113c66.png`
- Normalized source region: `.product-design-audit/digital-offering-assignments/source-table-region.png`
- Implementation, all columns: `.product-design-audit/digital-offering-assignments/implementation-light-all-columns.png`
- Implementation, chooser open: `.product-design-audit/digital-offering-assignments/implementation-column-chooser.png`
- Combined comparison: `.product-design-audit/digital-offering-assignments/comparison-source-vs-implementation.png`

The source and implementation comparison uses a 1173 x 905 table-region pair in light mode. The implementation was verified on `/digital-cards?tab=offerings` with representative card and subscription records and two branch assignments per offering.

## Visual review

- The original table hierarchy, neutral surfaces, typography, row dividers, green status badge, and red disable action remain consistent.
- The new device and wallet cells use compact stacked branch assignments, keeping each device/wallet relationship unambiguous.
- Missing assignments have an explicit `غير مسند` state; postpaid offerings can state that settlement is deferred without implying a wallet.
- The column chooser is discoverable in the existing toolbar as `الأعمدة 11/11`, and its menu follows the same component styling.
- Horizontal overflow remains available when all columns are shown, with the table minimum width derived from the visible-column count.

## Interaction review

- Opened the column chooser successfully.
- Hid `بيانات طالب`; the header disappeared and the visible count changed to 10/11.
- Restored all columns; the visible count returned to 11/11 and the device, wallet, and student-data headers were present.
- Browser console warnings/errors: none.

## Findings

- P0: none.
- P1: none.
- P2: none.
- P3: the QA fixture has three representative rows rather than the production screenshot's 28 rows; this is a data-state difference, not a layout defect.

final result: passed

---

# Design QA — أجهزة الحضور

## النطاق والحالة المختبرة

- إعادة بناء شاشة أجهزة الحضور على نمط master-detail مؤسساتي، مع إبقاء بنية النظام وRTL ومكوّناته الحالية.
- الحالة البصرية: الوضع الداكن، ستة أجهزة اختبار تمثل متصل/منقطع/بانتظار الاعتماد، الجهاز المحدد «جهاز قاعة الموظفين»، والفلاتر على قيمها الافتراضية.
- viewport CSS: `1488 × 1057`، ونسبة البكسل `1`.

## دليل المقارنة

- مصدر الحقيقة البصري: `C:/Users/alara/.codex/generated_images/019ff140-6c92-7070-ac34-b59a24c0f907/exec-d2ff55af-8780-464f-9071-f04af2656d6f.png` (`1487 × 1058`).
- لقطة التنفيذ: `artifacts/hr-devices-redesign/implementation-final-compact-2.png` (`1488 × 1057`).
- مقارنة العرض الكامل: `artifacts/hr-devices-redesign/design-qa-comparison-02.png`.
- مقارنة مركزة لمنطقة القائمة والتفاصيل: `artifacts/hr-devices-redesign/design-qa-master-detail-comparison.png`؛ استُخدمت لأن كثافة صفوف الجدول وتباعد لوحة التفاصيل هما أهم منطقتين للمطابقة.

## تاريخ المراجعة

### الجولة الأولى

- كانت لوحة التفاصيل أضيق من المرجع، وشريط الأدوات متعدد الصفوف، والطوابع الزمنية الكاملة مزدحمة داخل الجدول.
- التصحيح: رفع عرض لوحة التفاصيل من `340px` إلى `420px`، استخدام وقت نسبي مختصر، وتحويل شريط الأدوات إلى صف مضغوط مستقل مع تقليل ارتفاع صفوف الأجهزة.

### الجولة الثانية

- تأكدت مطابقة التسلسل البصري: عنوان وحالة النظام، قائمة تشغيلية كثيفة، تحديد أزرق، ثم لوحة تفاصيل ثابتة بإجراءات واضحة.
- التفاف تبويبات الموارد البشرية إلى صفين سببه الغلاف الحالي للنظام عند هذا العرض، وليس مكوّن الشاشة الجديدة؛ تم الحفاظ عليه لعدم كسر نمط التنقل العام.

## مراجعة الأسطح المطلوبة

- Typography: خط Cairo من النظام، مع تدرج واضح بين العنوان، اسم الجهاز، البيانات الوصفية، والحالات.
- Layout/spacing: شبكة master-detail متوازنة، شريط أدوات أحادي الصف، صفوف كثيفة قابلة للمسح، وتباعد متسق مع البطاقات الحالية.
- Colors/tokens: أسطح داكنة محايدة، اختيار أزرق، وحالات دلالية خضراء/صفراء/حمراء عبر متغيرات النظام بلا ألوان خام جديدة.
- Assets/icons: لا توجد صور أو أصول نقطية مطلوبة؛ استُخدمت أيقونات Lucide الموجودة في المشروع فقط.
- Copy/content: إزالة قصة المزود الخارجي وبنر IraqSoft، واستبدالها بلغة تشغيلية تشرح حالة الخدمة والجهاز والإجراء المطلوب.

## مراجعة التفاعل

- اختيار حالة «بانتظار الاعتماد» أعاد صفاً واحداً صحيحاً، ثم أعاد «كل الحالات» الصفوف الستة.
- تبديل الجهاز يحدّث لوحة التفاصيل، وزر عرض البصمات يربط جدول البصمات بالجهاز المختار.
- إعدادات الاتصال، اختبار الاتصال، ربط الموظفين، الاعتماد، التحديث والتصدير ظاهرة وقابلة للتشغيل حسب الصلاحية والحالة.
- أخطاء Console: لا شيء.

## النتائج

- P0: لا شيء.
- P1: لا شيء.
- P2: لا شيء.
- P3: بيانات لقطات QA تمثيلية، لذلك تختلف الأعداد عن المرجع البصري من دون أثر على التخطيط.

final result: passed
