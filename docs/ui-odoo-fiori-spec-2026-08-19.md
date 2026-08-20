# مواصفة التنفيذ الموحَّدة — لغةٌ بصرية واحدة للبطاقات والقوائم

> وثيقةٌ تنفيذية. كلّ قيمةٍ فيها مقروءةٌ من ملفٍّ وسطر، وكلّ قرارٍ فيها مرفوعٌ من أحد الطروحات الثلاثة أو من النقد — مع سبب الاختيار. ما لم أجده قلتُ «غير موجود».

---

## ١. المرجع المعتمد

**مزيجٌ محسوم بحدٍّ فاصل: تشريح SAP Fiori للبلاطة والبطاقة، ولغة Odoo للقائمة الكثيفة وشريط الحالة.** لا يُؤخَذ من أودو تشريحُ البطاقة ولا من فيوري كثافةُ الصفّ.

**لماذا هذا التقسيم بعينه — بدلالة موظّفة المكتبة العراقية:**

**من Fiori: البلاطة والبطاقة.** الموظّفة تفتح الرئيسية وأمامها ٣٨ بطاقة وحدة ([Dashboard.tsx:54](client/src/pages/Dashboard.tsx#L54))، ثمّ تنتقل إلى شاشة الكاشير فترى بطاقاتٍ **بلا أيقونة ولا لون عائلة ولا ظلّ ولا تحويم** ([Dashboard.tsx:1386-1423](client/src/pages/Dashboard.tsx#L1386)) مقابل بطاقة إدارية بأيقونة 50px وذيلٍ وارتفاعٍ عند التحويم ([Dashboard.tsx:807-889](client/src/pages/Dashboard.tsx#L807)). هذان نمطان **لا يشتركان في سطرٍ واحد من الشيفرة** لفعلٍ واحد. مبدأ فيوري — «موضعٌ ثابت لكل عنصر عبر النظام» — يُنهي هذا مباشرةً: تتعلّم الموظّفة الموضع مرّةً وتمسح الشبكة بحركة عينٍ رأسية بدل قراءة كلّ بطاقةٍ على حدة. وفيوري نظام RTL أصيل ⇒ التشريح يُنقَل بالخصائص المنطقية بلا انقلاب.

**من Odoo: صفّ القائمة وشريط الحالة.** جدول الفواتير يحمل ١٣ عموداً كلّها `whitespace-nowrap` ⇒ تمريرٌ أفقيّ حتميّ، وصفٌّ يتراوح **41→60px** بحسب وجود خليّةٍ ذات سطرين ([DataTable.tsx:523](client/src/components/data-table/DataTable.tsx#L523) مقابل [Invoices.tsx:511-519](client/src/pages/Invoices.tsx#L511)). الموظّفة تمسح هذا الجدول عشرات المرّات في الوردية بحثاً عن رقمٍ أو حالة — وإيقاعُ الارتفاع الثابت هو ما يجعل المسح ممكناً. أودو مبنيٌّ لهذا بالضبط.

**ولماذا لا يُؤخَذ ControlPanel من أودو:** طلبُ المالك «ترتيب البطاقات» لا إعادةَ تصميم شريط التحكّم. ودمجُ `PageHeader` (١٢٥ موضعاً في ١٢٤ ملفاً) و`ListToolbar` (٣٦ صفحة) و`PageTabs` (١٧ محوراً) في مكوّنٍ واحد **ينزل على كلّ مستهلكيه فوراً** — «تطبيقٌ على شاشة الفواتير وحدها» وهمٌ حين يكون التعديل في المكوّن نفسه. مرفوضٌ باعتماد النقد.

---

## ٢. سلالم النظام — القيم الصريحة

### ٢-أ. المسافات

**السلّم موجودٌ اليوم بستّ درجات و«صفر مستهلك» في كلّ `client/src`** — تحقّقتُ: `--ui-space-1…8` معرَّفة في [comfort.css:8-13](client/src/lib/theme/comfort.css#L8) ولا تُستعمل خارج ملفّ تعريفها.

| التوكن | القيمة | فاتح/داكن |
|---|---|---|
| `--ui-space-1` | 0.25rem (4px) | نفس القيمة (مقاس) |
| `--ui-space-2` | 0.5rem (8px) | نفس القيمة |
| `--ui-space-3` | 0.75rem (12px) | نفس القيمة |
| `--ui-space-4` | 1rem (16px) | نفس القيمة |
| **`--ui-space-5` (جديد)** | **1.25rem (20px)** | نفس القيمة |
| `--ui-space-6` | 1.5rem (24px) | نفس القيمة |
| `--ui-space-8` | 2rem (32px) | نفس القيمة |

`--ui-space-5` هو الدرجة الناقصة (السلّم يقفز من 16 إلى 24). يُضاف في [comfort.css](client/src/lib/theme/comfort.css) بجوار إخوته.

**قاعدة الاستعمال:** أيّ رقمٍ حرفيّ للمسافة في ملفّ شاشة انحرافٌ لا خيار. الاستثناء الوحيد: الأبعاد الهندسية المسمّاة بتوكنٍ خاصّ (ارتفاع البلاطة، عرض العمود).

### ٢-ب. أحجام الخطّ

السلّم القائم في [index.css:46-61](client/src/index.css#L46) ضمن `@theme inline` بتسع درجات، أرضيّته `--text-xs: 0.8125rem` (13px). والشاشات تهرب من هذه الأرضية **٦٣٣ مرّة** في `client/src/pages` وحده (416× `text-[11px]` · 168× `text-[10px]` · 20× `text-[9px]` · 11× `text-[12px]` · 10× `text-[13px]`).

**درجةٌ جديدة واحدة، بقيمة 12px لا 11px:**

```css
/* داخل @theme inline في client/src/index.css، بجوار --text-xs (السطر 46) */
--text-2xs: 0.75rem;
--text-2xs--line-height: 1.125rem;
```

**قيمةٌ واحدة لا قيمتان** — مقاسٌ لا لون. **ويلزم أن تكون داخل `@theme inline`** (فتحُ الكتلة [index.css:6](client/src/index.css#L6)): لا `tailwind.config.*` في المستودع البتّة، فما لم يُسجَّل هناك لا يُولَّد له صنف `text-2xs` أصلاً — هذا حاجزٌ رفعه النقد على الطرح الأول ومُعتمَد هنا.

**ولماذا 12px لا 11px** (خلافاً لطرحَي ٢ و٣ اللذين اختارا 11px): خطّ Cairo عند 11px يبدأ يفقد تمييز النقاط والهمزات على شاشة لمس، و12px هي الأرضيّة العملية الآمنة. طرح ٢ نفسه يعترف بأنّ «Cairo عند 9.5px يفقد النقاط» ثمّ يقف عند 11px — والخطوة الأصدق هي 12px. الثمن معروف ومُعلَن: 416 موضعاً عند 11px لن تُهاجَر في هذه الحملة (انظر §٨).

**السلّم النهائي:**

| التوكن | الحجم | ارتفاع السطر | الاستعمال في هذه المواصفة |
|---|---|---|---|
| `--text-2xs` **(جديد)** | 0.75rem (12px) | 1.125rem (18px) | تسمية · شارة · ميتا · وصفٌ ثانويّ |
| `--text-xs` | 0.8125rem (13px) | 1.25rem | وصف البلاطة · رأس عمود · نصّ زرّ الذيل |
| `--text-sm` | 0.9375rem (15px) | 1.5rem | قيمة الخليّة · عنوان بطاقة الكانبان |
| `--text-base` | 1.0625rem (17px) | 1.75rem | المتن · عنوان البلاطة |
| `--text-lg` | 1.1875rem (19px) | 1.875rem | — |
| `--text-xl` | 1.3125rem (21px) | 2rem | — |
| `--text-2xl` | 1.625rem (26px) | 2.25rem | رقم KPI · عنوان الصفحة (h1) |
| `--text-3xl` | 2rem (32px) | 2.5rem | — |
| `--text-4xl` | 2.375rem (38px) | 2.75rem | — |

**⛔ أرضيّة مطلقة: لا شيء تحت 12px في أيّ عنصرٍ تصفه هذه الوثيقة.**

### ٢-ج. أوزان الخطّ

السلّم اليوم **مكسور من جهتين**:
1. `--font-weight-medium: 700` و`--font-weight-semibold: 700` ([index.css:63-64](client/src/index.css#L63)) — **متطابقان حرفياً** ⇒ `font-medium` و`font-semibold` لا يفترقان بصرياً، فتضيع رتبةُ هرمٍ كاملة.
2. `--font-weight-normal: 600` ([index.css:62](client/src/index.css#L62)) داخل `@layer base`، بينما `body { font-weight: 500 }` في [comfort.css:36](client/src/lib/theme/comfort.css#L36) **خارج أيّ طبقة** فيغلب بحكم CSS Cascade Layers ⇒ المتن يُرسَم 500 وهو وزنٌ **ليس على السلّم**، وأيّ عنصرٍ بـ`font-normal` يقفز إلى 600 بلا سبب ظاهر.

**السلّم بعد الإصلاح** (الأربعة محمَّلة فعلاً: [main.tsx:16-20](client/src/main.tsx#L16) يستورد 400/500/600/700/800):

| التوكن | القيمة الحالية | القيمة الجديدة | فاتح/داكن |
|---|---|---|---|
| `--font-weight-normal` | 600 | **500** | نفس القيمة |
| `--font-weight-medium` | 700 | **600** | نفس القيمة |
| `--font-weight-semibold` | 700 | 700 (بلا تغيير) | نفس القيمة |
| `--font-weight-bold` | 800 | 800 (بلا تغيير) | نفس القيمة |

**وفي نفس التعديل: يُحذف `body { font-weight: 500 }` من [comfort.css:34-37](client/src/lib/theme/comfort.css#L34)** — شرطٌ لا خيار، وإلّا بقي مصدرا حقيقةٍ متناقضان. بعد الحذف يُنتج `index.css:171` نفسَ 500 من التوكن المصحَّح ⇒ **صفر تغيير بصريّ على المتن**، والتوكن يصير صادقاً.

**⛔ الوزن 900 محظور** (`font-black` و`font-extrabold`): غير محمَّلٍ في التطبيق ⇒ المتصفّح يصطنعه غليظاً من 800 فتفقد الأرقام العربية حدّتها. مستعملٌ اليوم 41 مرّة كـ`font-black` و106 مرّة كـ`font-extrabold` في الصفحات — الحملة تُخرجه من العناصر التي تصفها (رقم KPI · شارة العدّاد) ولا تدّعي هجرة المواضع الباقية.

### ٢-د. أنصاف الأقطار

**العطب الجذريّ: `--radius` يتبدّل بالسمة** — 0.625rem (10px) فاتحاً ([index.css:78](client/src/index.css#L78)) و**0.375rem (6px)** داكناً ([index.css:119](client/src/index.css#L119))، وكلّ السلّم مشتقٌّ منه ([index.css:7-10](client/src/index.css#L7)) ⇒ بطاقة `rounded-xl` تنزل من 14px إلى 10px وزرّ `rounded-md` من 8px إلى 4px **بمجرّد تبديل السمة**. الشكل ليس لوناً.

**القرار: تثبيت `--radius: 0.625rem` في كتلة `.dark` أيضاً.**

يترتّب عليه السلّم التالي، **موحَّداً في السمتين**:

| التوكن | القيمة | المصدر |
|---|---|---|
| `--radius` | 0.625rem (10px) | [index.css:78](client/src/index.css#L78) — يُثبَّت في `.dark` |
| `--radius-sm` = radius−4px | 0.25rem (4px) | [index.css:7](client/src/index.css#L7) |
| `--radius-md` = radius−2px | 0.5rem (8px) | [index.css:8](client/src/index.css#L8) |
| `--radius-lg` = radius | 0.625rem (10px) | [index.css:9](client/src/index.css#L9) |
| `--radius-xl` = radius+4px | **0.875rem (14px)** | [index.css:10](client/src/index.css#L10) |
| `--ui-radius-control` | 0.625rem (10px) | [comfort.css:26](client/src/lib/theme/comfort.css#L26) |
| `--ui-radius-card` | **0.875rem (14px)** | [comfort.css:27](client/src/lib/theme/comfort.css#L27) — **يبقى كما هو** |
| `--ui-radius-dialog` | 1.125rem (18px) | [comfort.css:28](client/src/lib/theme/comfort.css#L28) |

**`--ui-radius-card` يبقى 14px ولا يُخفَض إلى 8px** (خلافاً لطرح ٢): `Card` من shadcn يستعمل `rounded-xl` = 14px ([card.tsx:10](client/src/components/ui/card.tsx#L10))، ويستهلكه 190 ملفاً. خفضُ التوكن إلى 8px يُنتج بطاقاتٍ جديدة 8px بجوار 190 ملفاً بـ14px — وعدُ «نصف قطرٍ واحد» ينكسر بالضبط عند التنفيذ. النقد أمسك هذا؛ 14px هي القيمة التي **تلتقي** عندها البطاقة الجديدة مع كلّ بطاقات النظام بعد تثبيت `--radius`.

**⇒ ثلاثة أنصاف أقطار في كل ما تصفه هذه الوثيقة: 14px للبطاقة · 10px للتحكّم والرقاقة الأيقونية · 8px للشارة (`--radius-md`) · و999px للكبسولة (العدّاد) وحدها.**

### ٢-هـ. الظلال

**لا سلّم ظلالٍ نافذ اليوم.** المعرَّف ثلاثُ درجات ([comfort.css:29-31](client/src/lib/theme/comfort.css#L29)) مستهلكها **موضعان في كلّ المستودع** ([dialog.tsx:127](client/src/components/ui/dialog.tsx#L127) و[comfort.css:69](client/src/lib/theme/comfort.css#L69))، و`--ui-shadow-float` **صفر مستهلك**. والارتفاع الفعليّ يأتي من ثلاثة أنظمة متوازية: 180 استعمالاً لـ`shadow-xs..2xl` الافتراضية في الصفحات + ظلال [WorkOrders.board.css:19-21](client/src/pages/WorkOrders.board.css#L19) المحلّية + ظلال [PriceChecker.css:313-314](client/src/pages/PriceChecker.css#L313).

**والعطب الحاسم:** القيم الثلاث **ثابتةٌ لا تتبدّل بالسمة** — ظلٌّ نيليّ `rgb(15 23 42 / …)` على `#010409` غير مرئيّ أصلاً، ويناقض عقيدة الملفّ المكتوبة في [tokens.css:117](client/src/lib/theme/tokens.css#L117) («الارتفاع بالحدود لا الظلال» في الداكن).

**السلّم النهائي — ثلاث درجات، بمقابلٍ داكنٍ صريح:**

| التوكن | فاتح | داكن |
|---|---|---|
| `--ui-shadow-surface` | `0 1px 2px oklch(0.26 0.012 70 / 0.06), 0 2px 6px -2px oklch(0.26 0.012 70 / 0.08)` | `0 0 0 1px #21262d` |
| `--ui-shadow-float` | `0 6px 16px -6px oklch(0.26 0.012 70 / 0.16), 0 2px 4px -2px oklch(0.26 0.012 70 / 0.10)` | `0 0 0 1px #30363d, 0 8px 24px -12px #000000` |
| `--ui-shadow-dialog` | `0 16px 40px -18px oklch(0.26 0.012 70 / 0.28)` | `0 0 0 1px #30363d, 0 16px 40px -18px #000000` |

الأسماءُ القائمة تُعاد قيمُها فقط — لا أسماء جديدة، فيرث `dialog.tsx:127` القيمة المصحَّحة مجّاناً. والداكنُ يرتفع بالحدّ أوّلاً التزاماً بعقيدة الملفّ.

**⛔ لا رابعة، ولا ظلٌّ محلّيٌّ جديد** خارج هذه الثلاثة في أيّ ملفّ تمسّه هذه الحملة.

### ٢-و. الأسطح والحدود — التغييرات اللونية

**العطب المقيس:** الفرق بين خلفية البطاقة وخلفية الصفحة **1.05:1** فاتحاً و**1.09:1** داكناً، فيبقى الحدّ 1px هو البنيةَ الوحيدة — وهو نفسه عند **1.26:1** فاتحاً، دون عتبة 3:1 لحدود العناصر غير النصّية (WCAG 1.4.11). شبكةُ ٣٨ بطاقة تبدو حقلاً متّصلاً.

**قرارٌ حاسم اعتماداً على النقد: لا يُمَسّ `--background`.** طرح ٣ اقترح خفضه إلى 0.935 — والنقد أمسك أنّ ذلك **يقلب هرم الأسطح المحايدة كلّه**: `--muted`/`--accent` = 0.940 ([index.css:87](client/src/index.css#L87) و[:90](client/src/index.css#L90)) و`--secondary` = 0.945 ⇒ يصير الكانفاس أغمق من كلّ الأسطح المحايدة، فيُقرأ `bg-muted` (رأس الجدول في [DataTable.tsx:441](client/src/components/data-table/DataTable.tsx#L441) والترويسة اللاصقة في [ScrollTableShell.tsx:45](client/src/components/table/ScrollTableShell.tsx#L45)) سطحاً **مرتفعاً** بدل غائر. وأخطر فورياً: صفوف `odd:bg-background` تصير أغمق من حاويتها `bg-card` ⇒ تخطيطٌ مُزنَّر صارخ.

**البديل المعتمد: يُخفَض `--dash-bg` وحده — واللوحة هي موضع الشكوى، والجداول تعيش على `--card` أصلاً.**

| التوكن | الحالة اليوم | القيمة الجديدة | الأثر |
|---|---|---|---|
| `--dash-bg` (فاتح) | oklch(0.958 0.010 82) [tokens.css:35](client/src/lib/theme/tokens.css#L35) | **oklch(0.935 0.010 82)** | البطاقة على اللوحة: 1.05:1 ⇒ **≈1.13:1** |
| `--dash-bg` (داكن) | #010409 [tokens.css:118](client/src/lib/theme/tokens.css#L118) | **#010409** (بلا تغيير) | الفصل داكناً بالحدّ لا بالسطح |
| `--card-edge` (جديد، فاتح) | — | **oklch(0.820 0.008 78)** | الحدّ على البطاقة: **≈1.63:1** |
| `--card-edge` (جديد، داكن) | — | **#30363d** | **≈1.54:1** بدل 1.26:1 |
| `--dash-card-bord` | قيمةٌ صريحة [tokens.css:37](client/src/lib/theme/tokens.css#L37) | **`var(--card-edge)`** | يرقّي ٣٨ بطاقة + الكاشير + BriefCard + MetricsBar بسطرٍ واحد |
| `--border` | oklch(0.900 0.008 78) [index.css:94](client/src/index.css#L94) | **بلا تغيير** | فاصلٌ داخليّ أنعم من حدّ البطاقة عمداً |

**`--card-edge` غير قابلٍ للاشتقاق:** `--border` عند 1.26:1 أضعفُ من أن يُقرأ حدّاً، و`--input` = oklch(0.62 0.010 78) ([index.css:96](client/src/index.css#L96)) حدُّ تحكّمٍ مقصودٌ ثقيلاً (≈3.5:1) فيصير سياجاً على ٣٨ بطاقة. والقيمة الداكنة `#30363d` **قائمةٌ أصلاً** في النظام ([index.css:143](client/src/index.css#L143) و[tokens.css:133](client/src/lib/theme/tokens.css#L133)) فلا لونَ جديد يُخترَع.

**⭐ القاعدة التي أنقذها النقد:** التوكنات الجديدة تُربَط **مرادفاتٍ** لا أسماءً موازية. `--dash-card-bord: var(--card-edge)` ينزل على ٣٨ بطاقة **بلا لمس أيّ ملفّ شاشة**، لأنّ [Dashboard.tsx:14-30](client/src/pages/Dashboard.tsx#L14) يقرأ خريطة `T` من التوكن لا من القيمة. أمّا إضافةُ اسمٍ جديد وترك القديم على حاله ⇒ **صفر أثر بصريّ** والوعدُ المُعلَن كذب.

### ٢-ز. توحيد العائلات الدلالية

العائلتان `money/stock/status` (tokens.css:12-18) و`sem-*` (tokens.css:60-63) **متطابقتان حرفياً في الفاتح** ومنفرقتان في الداكن: `--money-negative: #f85149` مقابل `--sem-neg: oklch(0.725 0.150 27)` ⇒ أحمران في الصفّ الواحد، والعطب لا يُرى إلّا داكناً.

**تُصبح العائلة القديمة مرادفاتٍ للجديدة في السمتين** (الأسماء تبقى فلا تُكسَر ٣٦ شاشة):

```
--money-positive  ⇒ var(--sem-pos)
--money-negative  ⇒ var(--sem-neg)
--money-neutral   ⇒ var(--sem-neutral)      ← بعد إضافة sem-neutral
--stock-ok        ⇒ var(--sem-pos)
--stock-low       ⇒ var(--sem-warn)
--stock-out       ⇒ var(--sem-neg)
--status-active   ⇒ var(--sem-pos)
--status-pending  ⇒ var(--sem-info)
--status-done     ⇒ var(--sem-info)          ← انظر أدناه
--status-cancelled⇒ var(--sem-neutral)
```

**`--status-done` مسألةٌ رفعها النقد كنقصٍ في طرح ١:** قيمته اليوم فاتحاً oklch(0.505 0.110 200) وداكناً `#39c5cf` ([tokens.css:18](client/src/lib/theme/tokens.css#L18) و[:104](client/src/lib/theme/tokens.css#L104)) — سماويٌّ خامسٌ خارج الأربعة الدلالية. **القرار: يُربَط بـ`--sem-info`** ولا يبقى لونُ حالةٍ خامس. الفرقُ البصريّ (هيو 200 ⇐ 240) مقبولٌ مقابل إغلاق العائلة.

**والتوكنان الناقصان يُضافان:**

| التوكن | فاتح | داكن | المصدر |
|---|---|---|---|
| `--sem-neutral` | oklch(0.450 0.011 70) | #b1bac4 | = `--dash-sub` ([tokens.css:41](client/src/lib/theme/tokens.css#L41) و[:124](client/src/lib/theme/tokens.css#L124)) |
| `--sem-neutral-bg` | oklch(0.940 0.008 82) | #161b22 | = `--muted` ([index.css:87](client/src/index.css#L87)) و`--pos-muted` الداكن |
| `--sem-danger` | `var(--sem-neg)` | `var(--sem-neg)` | مرادفٌ لإصلاح توكنٍ مجهول — أدناه |

**`--sem-danger` غير معرَّف في أيّ مكان** (تحقّقتُ: tokens.css تعرّف pos/neg/warn/info فقط)، بينما يُستعمل في **أربعة مواضع**: [DataTable.tsx:273](client/src/components/data-table/DataTable.tsx#L273) (نصّ حالة الخطأ) و[DeliveryHub.tsx:435](client/src/pages/DeliveryHub.tsx#L435) و[:439](client/src/pages/DeliveryHub.tsx#L439) و[Storefront.tsx:2098](client/src/pages/Storefront.tsx#L2098). المتغيّر المجهول يجعل `color` غير صالح ⇒ **نصّ الخطأ بلا لونٍ في السمتين**. المرادفُ يُصلح الأربعة بسطرين.

### ٢-ح. سلّم الطبقات (z-index)

**لا يوجد أيّ توكن `--z-*` في `index.css` ولا `lib/theme`** — تحقّقتُ. والنتيجة تصادمٌ حقيقيّ: `SelectionBar` بـ`fixed bottom-4 z-50` ([SelectionBar.tsx:77](client/src/components/list/SelectionBar.tsx#L77)) يعلو `MobileBottomNav` بـ`z-40` ([MobileBottomNav.tsx:107](client/src/components/MobileBottomNav.tsx#L107)) فيحجب التنقّل السفليّ على الهاتف. والأرقام مبعثرة: 15× `z-10` · 13× `z-[100]` · 10× `z-50` · موضعٌ بـ`z-[81]` · وشبح سحب الكانبان عند 9999.

| التوكن | القيمة | فاتح/داكن |
|---|---|---|
| `--z-sticky` | 10 | نفس القيمة |
| `--z-dropdown` | 30 | نفس القيمة |
| `--z-overlay` | 40 | نفس القيمة |
| `--z-modal` | 50 | نفس القيمة |
| `--z-toast` | 60 | نفس القيمة |
| `--z-drag` | 70 | نفس القيمة |

الشريط السفليّ = `--z-overlay`، وشريط التحديد **يُزاح فوقه بـ`bottom` لا بـ`z`**.

### ٢-ط. الحركة

**لا توكن مدّةٍ أو منحنى في النظام** — تحقّقتُ. المدد مبعثرة: 0.18s و0.15s في [Dashboard.tsx:822](client/src/pages/Dashboard.tsx#L822) و[:970](client/src/pages/Dashboard.tsx#L970)، و0.15s/0.12s/0.4s في [board.css:110](client/src/pages/WorkOrders.board.css#L110) و[:164](client/src/pages/WorkOrders.board.css#L164).

| التوكن | القيمة | فاتح/داكن |
|---|---|---|
| `--motion-fast` | 120ms | نفس القيمة |
| `--motion-base` | 180ms | نفس القيمة |
| `--motion-slow` | 320ms | نفس القيمة |
| `--ease-standard` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | نفس القيمة |

**المنحنى ليس اختراعاً** — هو المستعمل فعلاً في امتلاء شريط التقدّم ([board.css:164](client/src/pages/WorkOrders.board.css#L164)). وقاعدة `prefers-reduced-motion` تغطّي هذا كلّه أصلاً ([index.css:220-228](client/src/index.css#L220)).

### ٢-ي. هندسة البلاطة

توكناتٌ مخصَّصة تُضاف في [comfort.css](client/src/lib/theme/comfort.css)، **قيمةٌ واحدة في السمتين** (مقاسات لا ألوان):

| التوكن | القيمة | ملاحظة |
|---|---|---|
| `--tile-min-w` | 15rem (240px) | أدنى عرضٍ في شبكة `auto-fill` |
| `--tile-body-h` | 9rem (144px) | ارتفاع الجسم المحجوز |
| `--tile-foot-h` | 2.75rem (44px) | **= `--ui-control`** ([comfort.css:16](client/src/lib/theme/comfort.css#L16)) ⇒ أزرار الذيل أهدافُ لمسٍ شرعية |
| `--tile-icon` | 3rem (48px) | **= `--ui-control-lg`** ([comfort.css:17](client/src/lib/theme/comfort.css#L17)) بدل 50px الاعتباطية |
| `--kpi-h` | 4.75rem (76px) | ارتفاع بطاقة الرقم |

---

## ٣. تشريح البلاطة — بطاقة الرئيسية (`LaunchTile`)

**تستبدل نمطين غريبين لفعلٍ واحد:** `ModuleCard` ([Dashboard.tsx:807-889](client/src/pages/Dashboard.tsx#L807)) و`Tile` ([Dashboard.tsx:1386-1423](client/src/pages/Dashboard.tsx#L1386)) — لا يشتركان اليوم في سطرٍ واحد.

### الرسم النصّيّ

```
┌──────────────────────────────────────────────┐  ← border 1px var(--card-edge)
│                                              │     radius 14px (--ui-radius-card)
│  ┌────────┐                          ┌────┐  │     shadow var(--ui-shadow-surface)
│  │        │                          │ ١٢ │  │     bg var(--dash-card-bg)
│  │ 48×48  │  ← رقاقة الأيقونة        └────┘  │     ↑ شارة عدّاد (كبسولة 24px)
│  │  rx10  │     var(--secN-chip)             │       تُحذَف عند الصفر
│  └────────┘     حدّ var(--secN-chipbd)       │
│                                              │  ← الرأس: 48px، محاذاةٌ للبداية
│  ↕ 12px (--ui-space-3)                       │
│                                              │
│  المبيعات والفواتير                          │  ← 17px/700، سطر واحد، ellipsis
│  ↕ 4px (--ui-space-1)                        │
│  فواتير البيع وتحصيل الذمم                   │  ← 13px/500، سطران، line-clamp:2
│                                              │
│  ↕ (مساحة مرنة — الجسم 144px محجوز)          │
├──────────────────────────────────────────────┤  ← border-top 1px var(--border)
│   + فاتورة  │   بحث      │   طباعة           │  ← الذيل 44px، ≤٣ أزرار
└──────────────────────────────────────────────┘     فاصل borderInlineStart 1px
   ↑ 16px حشوة على الجوانب الثلاثة (--ui-space-4)
   الذيل بلا حشوةٍ رأسية (ارتفاعه من --tile-foot-h)
```

### القيم الكاملة

| الخاصّية | القيمة | يستبدل |
|---|---|---|
| العرض الأدنى | `--tile-min-w` = 240px | — |
| الارتفاع | جسم 144px + ذيل 44px = **188px** | 150px للإدارة ([:812](client/src/pages/Dashboard.tsx#L812)) · 92px للكاشير ([:1400](client/src/pages/Dashboard.tsx#L1400)) |
| الشبكة | `repeat(auto-fill, minmax(var(--tile-min-w), 1fr))` | `repeat(cols,1fr)` بـcols محسوبٍ في JS ([:928](client/src/pages/Dashboard.tsx#L928)) **و** `minmax(264px,1fr)` ([:1384](client/src/pages/Dashboard.tsx#L1384)) |
| فجوة الشبكة | 16px (`--ui-space-4`) | 14px في الشبكتين |
| نصف القطر | 14px (`--ui-radius-card`) | 16 · 14 · 18 · 10 · 11 المتزامنة |
| الحدّ | 1px `var(--card-edge)` | 1px `--dash-card-bord` (1.26:1) |
| الظلّ | `var(--ui-shadow-surface)` | `restShadow` inline ([:804](client/src/pages/Dashboard.tsx#L804)) |
| حشوة البلاطة | 16px على الجوانب الثلاثة | «12px 10px 8px» ([:841](client/src/pages/Dashboard.tsx#L841)) |
| رقاقة الأيقونة | 48×48، `rx=13.8` على viewBox 52 | 50px ([:855](client/src/pages/Dashboard.tsx#L855)) · **معدومة** في بطاقة الكاشير |
| الرأس ← الجسم | 12px (`--ui-space-3`) | — |
| العنوان ← الوصف | 4px (`--ui-space-1`) | 7px gap مركزيّ ([:845](client/src/pages/Dashboard.tsx#L845)) |
| المحاذاة | `align-items: flex-start; text-align: start` | `alignItems/justifyContent: center` ([:846-849](client/src/pages/Dashboard.tsx#L846)) |

### الطباعة

| العنصر | الحجم | الوزن | يستبدل |
|---|---|---|---|
| العنوان | `--text-base` 17px / 1.75rem، `letter-spacing: -0.01em` | 700 | 13px ([:864](client/src/pages/Dashboard.tsx#L864)) · 16px ([:1403](client/src/pages/Dashboard.tsx#L1403)) |
| الوصف | `--text-xs` 13px / 1.25rem، `line-clamp: 2` | 500 | **10.5px** ([:866](client/src/pages/Dashboard.tsx#L866)) · 12.5px ([:1422](client/src/pages/Dashboard.tsx#L1422)) |
| شارة العدّاد | `--text-2xs` 12px | 800 | 12px ([:1412](client/src/pages/Dashboard.tsx#L1412)) |
| نصّ زرّ الذيل | `--text-xs` 13px | 700 للأوّل، 600 لغيره | 12px ([:761](client/src/pages/Dashboard.tsx#L761)) |

⇒ **أربعة أحجام في البلاطة** بدل ثلاثة عشر على الصفحة اليوم.

**شارة العدّاد إلزامياً:** `fmtAr(count)` + `dir="ltr"` + `font-variant-numeric: tabular-nums` — اليوم `{t.badge}` ([:1418](client/src/pages/Dashboard.tsx#L1418)) هو الرقم **الوحيد** في الملفّ الذي يُطبع خاماً بلا أيٍّ من الثلاثة، بينما النمط الصحيح قائمٌ في [:999](client/src/pages/Dashboard.tsx#L999).

### الحالات

| الحالة | الوصفة |
|---|---|
| **سكون** | `background: var(--dash-card-bg)` · `border: 1px solid var(--card-edge)` · `box-shadow: var(--ui-shadow-surface)` |
| **تحويم** | `box-shadow: var(--ui-shadow-float)` · `transform: translateY(-2px)` · `border-color: color-mix(in oklch, var(--secN-ink) 32%, var(--card-edge))` · `transition: box-shadow var(--motion-base) var(--ease-standard), transform var(--motion-base) var(--ease-standard)` — **عبر `:hover` في CSS** لا عبر `onMouseEnter/onMouseLeave` يكتبان style مباشرةً ([:826-836](client/src/pages/Dashboard.tsx#L826)) |
| **تركيز** | `outline: 2px solid var(--ring); outline-offset: 2px` ([index.css:213](client/src/index.css#L213)) — ظاهرةٌ كاملةً بعد إصلاح القصّ (أدناه) |
| **نشط** | `transform: translateY(0)` · `box-shadow: var(--ui-shadow-surface)` |
| **مميَّزة** | `border: 2px solid var(--sem-info)` · `background: color-mix(in oklch, var(--sem-info-bg) 55%, var(--dash-card-bg))` — لأنّ `--dash-featured-bg` و`--dash-card-bg` **متطابقان حرفياً في الداكن** (`#0d1117` في [tokens.css:129](client/src/lib/theme/tokens.css#L129) و[:119](client/src/lib/theme/tokens.css#L119)) و1.06:1 فاتحاً |
| **تحميل** | هيكلٌ بنفس الأبعاد 240×188 — لا سبينر، فلا قفزة تخطيط |
| **عدّاد صفر** | لا تُرسَم الشارة (القاعدة قائمة، [:1404](client/src/pages/Dashboard.tsx#L1404)) |
| **فشل استعلام العدّاد** | **نقطة 6px بلون `var(--sem-neutral)` مع `title="تعذّر جلب العدد"`** — نقصٌ رفعه النقد: اليوم `{!!t.badge && t.badge > 0 && …}` تُخفي الشارة عند `undefined` تماماً كما تُخفيها عند الصفر ⇒ «فشلَ الجلب» و«لا طلبات» يبدوان واحداً على شاشة الكاشير |
| **قسمٌ فارغ** | يُخفى كاملاً ([:918](client/src/pages/Dashboard.tsx#L918)) |
| **معطَّل بصلاحية** | لا يُرسَم أصلاً — بوّابة `canSeeGate` ([:916](client/src/pages/Dashboard.tsx#L916)) |

### ⚠️ بنيةُ الجذر — حاجزٌ من النقد يُحسَم هنا

**لا يُجعَل الجذرُ رابطاً.** طرحا ١ و٢ نصّا على «الجذر هو `<Link>` نفسه» — وهو **مستحيلٌ مع بقاء ذيل الإجراءات**: الذيل يرسم ≤٣ أزرار عبر `ActionButton` ([:886](client/src/pages/Dashboard.tsx#L886)) و`ActionButton` نفسه `<Link href={a.href}>` ([:753](client/src/pages/Dashboard.tsx#L753)) ⇒ رابطٌ داخل رابط: HTML غير صالح، ووكلاء لوحة المفاتيح وقارئ الشاشة ينكسران.

**الحلّ المعتمد** (وهو ما فعله طرح ٣ حرفياً):

```
الجذر يبقى <div>.
يُحذَف        overflow: "hidden"        (Dashboard.tsx:815)
ويُستبدَل بـ  overflow: clip;
              overflow-clip-margin: 4px;
```

⇒ حلقةُ التركيز 2px بإزاحة 2px تظهر كاملةً على رابط الجسم عبر ٣٨ بطاقة (كانت **مقصوصة**)، ويبقى الذيل روابطَ مستقلّة صالحة.

### الأيقونات

**تبقى خريطة الأشكال اليدوية الـ37 كما هي** ([Dashboard.tsx:166-440](client/src/pages/Dashboard.tsx#L166)). هجرتُها إلى `lucide-react` **مرفوضة باعتماد النقد**: إعادةُ رسم ٣٧ هويّة بصرية لم يشتكِ منها المالك (شكواه الترتيب واللغة الواحدة)، وكلفتُها فقدانُ التمييز الحاليّ لصالح مجموعةٍ عامّة.

**العطب الحقيقيّ المُثبَت واحدٌ فقط:** مفتاح `shifts` غير موجود في الخريطة ([:73](client/src/pages/Dashboard.tsx#L73) يعرّف الوحدة، ولا مفتاح لها بين 166-440) فيسقط على الاحتياطيّ `<circle r=9>` ([:441](client/src/pages/Dashboard.tsx#L441)) ⇒ دائرةٌ فارغة بين ٣٧ أيقونة، في القسم الماليّ الأكثف (12 بطاقة). **يُصلَح بإضافة شكلٍ واحد.**

### الملفّات
- `D:\business_management_system\.claude\worktrees\invoices-orders-system-149fd0\client\src\pages\Dashboard.tsx`
- `D:\business_management_system\.claude\worktrees\invoices-orders-system-149fd0\client\src\lib\theme\comfort.css`

---

## ٤. تشريح بطاقة الكانبان (`ObjectCard`)

**الحال اليوم:** ٨ أشقّاء مسطّحين تفصلهم هوامش 7/9/9/7/7/7/8 بلا نسبة ([board.css:116](client/src/pages/WorkOrders.board.css#L116) · [:136](client/src/pages/WorkOrders.board.css#L136) · [:145](client/src/pages/WorkOrders.board.css#L145) · [:146](client/src/pages/WorkOrders.board.css#L146) · [:148](client/src/pages/WorkOrders.board.css#L148) · [:162](client/src/pages/WorkOrders.board.css#L162) · [:167](client/src/pages/WorkOrders.board.css#L167))، و**≈٣٧ عنصراً بصرياً** و**١٧ لوناً متزامناً** من ستّة أنظمة غير مترابطة، داخل عمودٍ عرضه 320px. الارتفاع المحسوب ≈234px ⇒ **≈٣ بطاقات** على شاشة 1080px. لوحةٌ لا تُري صفّها ليست لوحة.

### الرسم النصّيّ

```
┃┌────────────────────────────────────────────┐  ← شريط inline-start 4px
┃│  WO-1042    [جاهز للتسليم]           ⋯    │     = حالة الأمر وحدها
┃│                                            │  ← الرأس 28px
┃├────────────────────────────────────────────┤  ← border-bottom 1px var(--border)
┃│                                            │
┃│  طباعة كروت تعريف ١٠٠٠ نسخة على           │  ← 15px/700، line-clamp: 2
┃│  ورق كوشيه ٣٠٠ غرام                        │
┃│  أحمد الجبوري · ٠٧٧٠١٢٣٤٥٦٧               │  ← 12px مكتوم
┃│                                            │
┃│  [الكمية ١٠٠٠]  [٧٥٬٠٠٠]  [متأخّر ٣ أيام] │  ← صفٌّ لا يلتفّ (nowrap)
┃│                                            │     الاستحقاق أوّلُ ثابتِ الموضع
┃├────────────────────────────────────────────┤  ← border-top 1px var(--border)
┃│  (ع) عليّ حسن                    [مراسلة] │  ← الذيل 44px
┃└────────────────────────────────────────────┘
   ↑ حشوة 12px (--ui-space-3)
```

### المحذوفات — مع تحفّظ النقد

**يُحذَف من البطاقة:**
1. **قضيب التقدّم وسطر «المرحلة N/4 — NN%»** ([board.css:162-166](client/src/pages/WorkOrders.board.css#L162)) — ≈34px من ارتفاع كلّ بطاقة.
2. **رقاقة الأولوية حين تكون «عادي»** — تُرسَم اليوم دائماً لأنّ الفراغ يسقط عليها ([WorkOrders.tsx:251](client/src/pages/WorkOrders.tsx#L251)).

**السبب المقيس:** كلاهما مشتقٌّ من `o.status` وحده ([:248](client/src/pages/WorkOrders.tsx#L248) و[:252](client/src/pages/WorkOrders.tsx#L252))، وبطاقاتُ العمود الواحد **متطابقة الحالة** بحكم `COLUMNS[].match` ([:93-101](client/src/pages/WorkOrders.tsx#L93)) ⇒ صفر معلومةٍ تمييزية.

**⚠️ والمصغّرة 44×44 لا تُحذَف — تحفّظٌ من النقد مُعتمَد.** الطروحات الثلاثة وصفتها «ثابتة»، والنقد أمسك أنّها تعرض **صورة الأمر الأولى** حين توجد ([WorkOrders.tsx:309](client/src/pages/WorkOrders.tsx#L309) يفحص `o.thumbnailUrl`) — حذفُها يُلغي المعاينة البصرية للأمر المطبوع.

**القرار: المصغّرة تُعرَض حين توجد صورة، وتُحذَف حين لا توجد.** الاحتياطيّ الحاليّ (أيقونة `Printer` على لون الحالة) هو الثابت بلا معلومة، لا المصغّرة نفسها. تعديلٌ من سطرين: `{o.thumbnailUrl && <img … />}` بلا فرعٍ بديل.

**وقرار الحذف يُعرَض على المالك بمقارنة قبل/بعد بعدد البطاقات الظاهرة في العمود — لا يُدمج صامتاً** (باعتماد النقد: هذا قرارُ منتجٍ لا تصميم).

### القيم

| الخاصّية | القيمة | يستبدل |
|---|---|---|
| حشوة البطاقة | 12px (`--ui-space-3`) | «9px 10px» ([board.css:110](client/src/pages/WorkOrders.board.css#L110)) |
| الرأس ← الجسم | 8px + حدّ 1px `var(--border)` | `margin-bottom: 7px` بلا حدّ |
| الجسم ← الذيل | 12px + حدّ 1px `var(--border)` | `mt 8 + pt 8` |
| فجوة أسطر الجسم | 4px | 9/9/7/7 |
| فجوة رقاقات الميتا | 6px | 6px (يبقى) |
| نصف قطر البطاقة | 14px (`--ui-radius-card`) | 12px (`--wob-radius`، [:22](client/src/pages/WorkOrders.board.css#L22)) |
| نصف قطر الرقاقات | 8px (`--radius-md`) موحَّداً | خمسة: 12 · 9 · 8 · 7 · 99 |
| شريط البداية | `border-inline-start: 4px` | 4px (يبقى) |
| عرض العمود | 320px / 280px تحت 1366px | يبقى ([:23](client/src/pages/WorkOrders.board.css#L23)) |
| **عرض الشبح** | **304px** = 320 − حشو العمود 6×2 − حشو الجسم 2×2 | 312px (`calc(var(--wob-col-w) - 8px)`، [:115](client/src/pages/WorkOrders.board.css#L115)) ⇒ يقفز المقاس لحظة السحب |
| **الارتفاع المتوقَّع** | **≈150px** | ≈234px ⇒ من ≈٣ بطاقات إلى **≈٥** على شاشة 1080px |

⇒ **ثلاث فجواتٍ بنسبةٍ واضحة (4/8/12)** بدل ستٍّ متقاربة بلا نسبة.

### الطباعة

| العنصر | الحجم | الوزن | يستبدل |
|---|---|---|---|
| العنوان | `--text-sm` 15px / 1.35، **`line-clamp: 2`** | 700 | 14px **بلا أيّ قصّ** ([board.css:141](client/src/pages/WorkOrders.board.css#L141)) — الحقل الوحيد غير المقصوص بينما كلّ ما دونه أهمّيةً مقصوص |
| العميل | `--text-xs` 13px، **`ellipsis`** | 500 | 12.5px بلا قصّ ([:142](client/src/pages/WorkOrders.board.css#L142)) |
| الهاتف · الميتا · الذيل · الحالة | `--text-2xs` 12px | 600 | ستّة أحجام في مدى 3.5px (10.5 · 11 · 11.5 · 12 · 12.5 · 14) |

⇒ **ثلاثة أحجام** بدل ستّة. **والوزن يتبع الأهمّية:** العنوان 700 وحده، وزرّ «مراسلة» ينزل من **800** ([:172](client/src/pages/WorkOrders.board.css#L172)) إلى 600 — اليوم الزرّ والأولوية والصورة الرمزية كلّها 800 بينما عنوان الأمر 700.

### الحالات — خمسة أعطابٍ تُغلَق

**١) نصّ الحالة يظهر أخيراً.** `workOrderCardLabel` معرَّفةٌ في [WorkOrders.tsx:63](client/src/pages/WorkOrders.tsx#L63) وتميّز «مُرسل للتوصيل» عن «وصل للعميل» عن «جاهز للتسليم»، ومستدعاةٌ في الدرج ([:717](client/src/pages/WorkOrders.tsx#L717)) والجدول ([:966](client/src/pages/WorkOrders.tsx#L966)) وبطاقة الجوال ([:1097](client/src/pages/WorkOrders.tsx#L1097)) والتصدير ([:1441](client/src/pages/WorkOrders.tsx#L1441)) — **ولا استدعاء لها بين 257 و399** (جسم `Card`). ⇒ أمرٌ خرج مع مندوب يبدو مطابقاً لأمرٍ على الرفّ. **تُستدعى في الرأس نصّاً.**

**٢) `.wob-done` تُعرَّف.** `dueInfo` تُرجع `state: "done"` ([:132](client/src/pages/WorkOrders.tsx#L132)) و[:341](client/src/pages/WorkOrders.tsx#L341) يبني `wob-due wob-done` — والصنف **غير معرَّف** ([board.css:155-160](client/src/pages/WorkOrders.board.css#L155) تعرّف ok/soon/late فقط) ⇒ شارةٌ بلا خلفية ولا لون في **كلّ بطاقة في عمود المُغلَق**. الوصفة: `background: var(--sem-neutral-bg); color: var(--sem-neutral)`.

**٣) تلوّث `--accent` يُنهى.** حقنُ `["--accent"]: oklch(0.6 0.17 ${hue})` inline على `.wob-card` ([WorkOrders.tsx:258](client/src/pages/WorkOrders.tsx#L258)) **يُظلّل توكن shadcn الحقيقيّ** ([index.css:23](client/src/index.css#L23) يربط `--color-accent` بـ`--accent`، و[:90](client/src/index.css#L90) يعرّفه) لكامل شجرة البطاقة ⇒ زرّ النسخ (`hover:bg-accent/60`، [CopyButton.tsx:73](client/src/components/CopyButton.tsx#L73)) وزرّ ⋯ (`variant="ghost"` ⇒ `hover:bg-accent`، [button.tsx:20](client/src/components/ui/button.tsx#L20)) يُطليان بلون الحالة المُشبَع. **يُعاد التسمية إلى `--card-accent` في TSX وCSS معاً في التزامٍ واحد.**

⚠️ **الـCSS يحمل احتياطاً `var(--accent, var(--border))` ([board.css:110](client/src/pages/WorkOrders.board.css#L110)) و`var(--accent, var(--primary))` ([:164](client/src/pages/WorkOrders.board.css#L164))** — تعديلُ TSX وحده يترك الشريط على قيمة توكن shadcn المحايدة. **فحصُ القبول:** `grep -n 'var(--accent' client/src/pages/WorkOrders.board.css` يجب أن يُرجع **صفراً** بعد التعديل.

**٤) تكرار الترميز الأحمر ثلاثاً يُختصَر.** الأمر العاجل المتأخّر يُشفَّر أحمرَ في ثلاثة مواضع بنفس التوكن ([:113](client/src/pages/WorkOrders.board.css#L113) · [:119](client/src/pages/WorkOrders.board.css#L119) · [:159](client/src/pages/WorkOrders.board.css#L159)) بلا أيّ ترميزٍ غير لونيّ ⇒ سقوطٌ كامل عند عمى الألوان الأحمر-الأخضر. **يبقى: شريط البداية `--sem-neg` + أيقونة `Timer` + نصّ «متأخّر ٣ أيام»** — لونٌ واحد وترميزان غير لونيَّين.

**٥) لوحة المفاتيح.** الجذر `<div>` بلا `role` ولا `tabIndex` ولا `onKeyDown` ⇒ فتحُ الدرج ونقلُ الأمر مستحيلان بلا فأرة — بينما قاعدة حلقة التركيز تستهدف `.wob-card` صراحةً ([board.css:39](client/src/pages/WorkOrders.board.css#L39)) فتبدو مغطّاة. **يُضاف `role="article"` و`tabIndex={0}` و`onKeyDown` (Enter يفتح الدرج).**

**وإضافات أخرى:**
- **الصورة الرمزية:** لونٌ من `var(--sem-neutral)` لا من تجزئة اسم الموظّف بـ360 درجة ([:122-126](client/src/pages/WorkOrders.tsx#L122)) التي تُنتج دائرةً حمراء في ذيل بطاقةٍ سليمة الاستحقاق.
- **`user-select`:** يُرفَع عن الجسم ([board.css:110](client/src/pages/WorkOrders.board.css#L110)) ويبقى على الرأس وحده ⇒ هاتف العميل (الأكثر طلباً على الكاونتر) قابلٌ للنسخ.
- **صفّ الميتا لا يلتفّ:** `flex-wrap: nowrap` بدل `wrap` ([:148](client/src/pages/WorkOrders.board.css#L148)) — اليوم شارة الاستحقاق (أهمّ إشارة تشغيلية) تنزل سطراً وحدها متى وُجد التوصيل، فيفقد المسحُ الرأسيّ عمودَ الاستحقاق.

### `--s-amber` والتوكنات الميّتة — نقصٌ من النقد يُغلَق هنا

`--s-amber: oklch(0.72 0.16 72)` معرَّفٌ داخل `.wob` ([board.css:14](client/src/pages/WorkOrders.board.css#L14)) و**لا يعيد `.dark .wob` تعريفه** — الكتلة الداكنة تبدّل `--border-strong` والظلال الثلاثة فقط ([:31-36](client/src/pages/WorkOrders.board.css#L31)) ⇒ سطر التوصيل يُرسَم بلونٍ واحد على سطحَي البطاقة المتناقضين. و`.wob-deliv` يبدّل لون نصّه فقط في الداكن ويترك الخلفية والحدّ بقيم الفاتح ([:152-153](client/src/pages/WorkOrders.board.css#L152)).

**القرار:**
- `--s-amber` **يُحذَف** ويُستبدَل بـ`var(--sem-warn)` (له مقابلٌ داكنٌ كامل: [tokens.css:62](client/src/lib/theme/tokens.css#L62) و[:142](client/src/lib/theme/tokens.css#L142)).
- `.wob-deliv` تُبنى على `var(--sem-warn)` و`var(--sem-warn-bg)` ⇒ السمتان معاً بلا كتلة `.dark` خاصّة.
- `--s-blue` و`--s-violet` و`--s-emerald` ([:15-17](client/src/pages/WorkOrders.board.css#L15)) **تُحذَف** — صفر استعمال، وتُوهم القارئ بوجود نظام توكنات للحالة بينما التنفيذ oklch مُركَّبة inline.
- `--s-late` يبقى مرادفاً: `--s-late: var(--sem-neg)` بدل `var(--destructive)` (التشبّع 0.245 مقابل 0.170 — و`destructive` أعلى بـ44% من «الأحمر الطوبيّ الهادئ» الذي تنصّ عليه فلسفة [tokens.css:6](client/src/lib/theme/tokens.css#L6)).
- القاعدة الميتة `.wob-cust .wob-ch` ([:144](client/src/pages/WorkOrders.board.css#L144)) تُحذَف (لا `.wob-ch` في الشجرة).

### أهداف اللمس داخل البطاقة — جردٌ صريح

قاعدة 44px تشترط `[data-slot="button"]` أو `[data-slot="input"]` أو `select` ([index.css:234-241](client/src/index.css#L234)) ⇒ **لا تبلغ `<button>` الخامّ.** الجرد الكامل داخل البطاقة:

| العنصر | الحال | القرار |
|---|---|---|
| زرّ ⋯ (`RowActions`) | `size="icon-sm"` = 40px ⇒ 44px على اللمس | ✅ يبقى |
| زرّ واتساب (`WhatsAppShare`) | `.wob-wa { height: 30px }` ([board.css:172](client/src/pages/WorkOrders.board.css#L172)) على `Button` shadcn ⇒ ينتفخ 14px على اللمس | **يُضبَط على `--ui-control-sm` (40px)** فلا يقفز |
| `<select>` الإسناد | 32px ⇒ 44px على اللمس (مشمول) | ✅ يبقى |
| زرّ «إسناد» (`.wob-inbox-btn`) | `<button>` **خامّ** بـ32px ([:214](client/src/pages/WorkOrders.board.css#L214)) — **غير مشمول** | **يُحوَّل إلى `<Button size="sm">`** |
| زرّ نسخ الرقم (`CopyInline`) | `<button>` **خامّ** ≈18px ([CopyButton.tsx:68](client/src/components/CopyButton.tsx#L68)) بلا `data-slot` — **غير مشمول** | **يُضاف `data-slot="button"`** ⇒ يشمله الإلزام |

### RTL

- `.wob-cust-phone` يستعمل `text-align: right` ([board.css:143](client/src/pages/WorkOrders.board.css#L143)) ⇒ **`text-align: start`**.
- `.wob-sel` يرث حشواً فيزيائياً `padding: 0 30px 0 12px` وسهماً بـ`background-position: left 11px center` ([:81](client/src/pages/WorkOrders.board.css#L81))، و`.wob-inbox-sel` يرثه بـ`0 26px 0 10px` ([:213](client/src/pages/WorkOrders.board.css#L213)) ⇒ في RTL يزحف اسم الفنّي تحت السهم. **يُستبدَل بـ`AppSelect`** الذي يحمل الاتّجاه صحيحاً.

### الملفّات
- `D:\business_management_system\.claude\worktrees\invoices-orders-system-149fd0\client\src\pages\WorkOrders.board.css`
- `D:\business_management_system\.claude\worktrees\invoices-orders-system-149fd0\client\src\pages\WorkOrders.tsx`

---

## ٥. تشريح صفّ القائمة وشريط الأدوات

### ٥-أ. صفّ الجدول (`DataRow`)

**العطبان الوظيفيّان أوّلاً — هذا ليس تجميلاً:**

`odd:bg-background even:bg-muted/20` على الـ`<tr>` ([DataTable.tsx:493](client/src/components/data-table/DataTable.tsx#L493)) وقاعدة الحاوية `[&_tbody_tr:nth-child(even)]:bg-muted/20` ([ScrollTableShell.tsx:46](client/src/components/table/ScrollTableShell.tsx#L46)) بخصوصية **(0,2,2)** — تايلوند v4 يترجم `odd:` إلى `&:nth-child(odd)` فخصوصيتها **(0,2,0)** — تغلبان:
1. **تمييز «عربون — يحتاج تحصيل الباقي»** القادم من `getRowClassName` بخصوصية **(0,1,0)** ([Invoices.tsx:852](client/src/pages/Invoices.tsx#L852)) ⇒ **لا يُرسَم أصلاً**.
2. **تمييز الصفّ المحدَّد** `data-[selected=true]:bg-accent/60` بخصوصية **(0,2,0)** ⇒ **يختفي على نصف الصفوف**.

⇒ **حذفُ التزنير يُغلق الصنف كلَّه** بدل مطاردة الخصوصية. ولا خطر انقلابٍ لأنّ `--background` لا يُمَسّ في هذه المواصفة.

**البنية:**

```
┌──────────────────────────────────────────────────────┐
│ ☐ │ رقم │ التاريخ │ العميل │ … │ الحالة │  ⋯       │  ← الرأس 44px، lاصق
├───┼─────┼─────────┼────────┼───┼────────┼───────────┤     bg var(--muted)
┃ ☐ │ INV-… │ ٢٠٢٦/٠٨/١٩ │ … │ [مدفوعة] │  ⋯      │  ← الصفّ 48px
├───┴──────┴───────────┴─────┴──────────┴─────────────┤     فاصلٌ واحد 1px
┃ ☐ │ …                                               │
└──────────────────────────────────────────────────────┘
 ↑ شريط حالة 3px على inline-start
```

| الخاصّية | القيمة | يستبدل |
|---|---|---|
| ارتفاع الرأس | `var(--ui-table-head)` = **44px** | `py-2.5` ⇒ ≈41px ([DataTable.tsx:464](client/src/components/data-table/DataTable.tsx#L464)) |
| ارتفاع الصفّ | `var(--ui-table-row)` = **48px** | `py-2.5` + محتوى ⇒ 41→60px متقلّب ([:523](client/src/components/data-table/DataTable.tsx#L523)) |
| الحشوة الأفقية | 12px (`px-3`) ثابتة في الوضعين | الوضع المدمج `[&_td]:!p-1.5` يُنزل الأفقيّ إلى 6px ([:348](client/src/components/data-table/DataTable.tsx#L348)) فتلتصق أعمدة المال |
| الحشوة الرأسية | `padding-block: 0` — الارتفاع من التوكن | `py-2.5` |
| الفاصل | **خطٌّ واحد** 1px `var(--border)` أسفل الخليّة | ثلاثة: `border-b/80` للرأس · `border-b/55` للخليّة · `border-t` على الصفّ ([:464](client/src/components/data-table/DataTable.tsx#L464) · [:523](client/src/components/data-table/DataTable.tsx#L523) · [:493](client/src/components/data-table/DataTable.tsx#L493)) |
| محاذاة الرأس | `text-start` (منطقيّ) | `<tr className="text-right">` فيزيائيّ ([:443](client/src/components/data-table/DataTable.tsx#L443)) — بينما بديل النظام [ui/table.tsx:77](client/src/components/ui/table.tsx#L77) يستعمل `text-start` أصلاً |
| شريط حالة الصفّ | `border-inline-start: 3px` | `shadow-[inset_-3px_0_0_…]` فيزيائيّ ([Invoices.tsx:852](client/src/pages/Invoices.tsx#L852)) |

**⚠️ الارتفاع 48px لا 36px — حاجزٌ من النقد.** طرح ٢ اقترح صفّاً كثيفاً 36px، وهو **مستحيلٌ مع زرّ إجراء الصفّ القائم**: `RowActions` يستعمل `<Button variant="ghost" size="icon-sm">` ([RowActions.tsx:161](client/src/components/list/RowActions.tsx#L161))، و`icon-sm` = `size-[var(--ui-control-sm)]` ([button.tsx:28](client/src/components/ui/button.tsx#L28)) = **40px** ([comfort.css:15](client/src/lib/theme/comfort.css#L15))، وعلى اللمس يرتفع إلى 44px ⇒ الخليّة تنمو والارتفاع «الثابت» لا يثبت. **و48px هو التوكن القائم `--ui-table-row` الذي يستهلكه [ui/table.tsx:90](client/src/components/ui/table.tsx#L90) في ثماني شاشات أصلاً** — الالتقاء عنده يوحّد النظام بلا اختراع مقاس.

**الطباعة:**

| العنصر | الحجم | الوزن |
|---|---|---|
| رأس العمود | `--text-xs` 13px، `whitespace-nowrap` | 700 |
| قيمة الخليّة | `--text-sm` 15px | 500 |
| قيمة مالية | `--text-sm` 15px + **`tabular-nums` + `dir="ltr"` + `text-align: end`** | 600 |
| سطر ثانويّ داخل الخليّة | `--text-2xs` 12px، `var(--muted-foreground)` | 500 |

**الحالات:**

| الحالة | الوصفة |
|---|---|
| سكون | خلفية `var(--card)` لكلّ الصفوف — **بلا تخطيطٍ مُزنَّر إطلاقاً** |
| تحويم | `color-mix(in oklch, var(--primary) 6%, transparent)` |
| محدَّد | `color-mix(in oklch, var(--primary) 12%, transparent)` + شريط inline-start 2px `var(--primary)` |
| حالة دلالية (عربون) | خلفية `color-mix(in oklch, var(--sem-warn) 8%, transparent)` + شريط inline-start 3px `var(--sem-warn)` |
| مستندٌ ميت (ملغاة/مستبدَلة) | `opacity: 0.6` + شارة `--sem-neutral` |
| تركيز صفّ | `outline: 2px solid var(--ring)` داخليّ |
| **تحميل** | هيكلٌ بارتفاع 48px نفسه، وبعدد الأعمدة **المرئية** لا الخامّ (اليوم `columns.length` في [:484](client/src/components/data-table/DataTable.tsx#L484) بينما `visibleColumnCount` محسوبٌ في [:295](client/src/components/data-table/DataTable.tsx#L295)) وبحشوة الصفّ نفسها لا `p-2` |
| **تحميل الجوال** | **بطاقاتٌ هيكلية** — يُمنَع حقنُ `<tr>/<td>` داخل `<div className="md:hidden">` بلا `<table>` ([:421-424](client/src/components/data-table/DataTable.tsx#L421)): HTML غير صالح، وحالة تحميل بطاقات الجوال مكسورة بصرياً |
| خطأ | صفٌّ واحد: أيقونة `AlertTriangle` + نصّ **`var(--sem-neg)`** (بعد إصلاح `--sem-danger`) + زرّ إعادة |
| فارغ | نصٌّ محايد بحشوة 24px |

### ٥-ب. الشارة (`Badge`) — شكلان فقط

**الحال:** الصفُّ الواحد في شاشة الفواتير يحمل **خمس هندسات** و**أربعة أحجام خطّ**، **ولا واحدةٌ منها تستعمل مكوّن `Badge` القائم**:

| الموضع | الهندسة الحالية |
|---|---|
| [Invoices.tsx:457](client/src/pages/Invoices.tsx#L457) | `rounded` + `px-1 py-px` + `text-[10px]` + `font-bold` |
| [InvoiceChannelBadge.tsx:56](client/src/components/InvoiceChannelBadge.tsx#L56) | `rounded` + `px-1.5 py-0.5` + `text-[11px]` |
| [Invoices.tsx:512](client/src/pages/Invoices.tsx#L512) | `rounded-full` + `px-2 py-0.5` + `text-xs` + `font-semibold` |
| [Invoices.tsx:544](client/src/pages/Invoices.tsx#L544) | `rounded-full` + `px-2 py-0.5` + `text-xs` بلا وزن |
| [Invoices.tsx:564](client/src/pages/Invoices.tsx#L564) | `rounded-full` + `px-2 py-0.5` + `text-[11px]` + `font-bold` |
| [badge.tsx:8](client/src/components/ui/badge.tsx#L8) (المشترك، **غير مستورَد**) | `rounded-md` + `px-2 py-0.5` + `text-xs` + `font-medium` |

**الشكلان النهائيّان:**

| | شارة الحالة | رقاقة العدّاد |
|---|---|---|
| الشكل | مستطيلٌ مُدوَّر | كبسولة |
| الارتفاع | **24px ثابت** | **24px ثابت** |
| العرض الأدنى | — | 24px |
| نصف القطر | 8px (`--radius-md`) | 999px |
| الحشوة الأفقية | 8px (`--ui-space-2`) | 8px |
| الحجم | `--text-2xs` 12px | `--text-2xs` 12px |
| الوزن | 700 | 800 |
| الأرقام | — | `tabular-nums` + `dir="ltr"` + `fmtAr` |
| الأيقونة | 12px اختيارية، فجوة 4px | — |
| فجوة شارتين | 6px | 6px |

**⇒ ارتفاعٌ واحد 24px يُعيد لصفّ الجدول إيقاعه:** الخلايا ذات العمودين ([Invoices.tsx:511-519](client/src/pages/Invoices.tsx#L511) و[:562-565](client/src/pages/Invoices.tsx#L562)) هي سببُ قفزة الصفّ من ≈41px إلى ≈58-60px.

**خمس حالاتٍ لا سادسة**، كلٌّ = `color: var(--sem-X)` على `background: var(--sem-X-bg)`:

| الحالة | التوكن | أمثلة |
|---|---|---|
| موجب | `--sem-pos` | مدفوعة · متوفّر · مسلَّم |
| حرج | `--sem-warn` | عربون · مخزون منخفض · يستحق قريباً |
| سالب | `--sem-neg` | متأخّر · نافد · ملغاة |
| معلوماتيّ | `--sem-info` | قيد التنفيذ · تصحيح · **مُغلَق/سُلّم** |
| محايد | `--sem-neutral` | مسوَّدة · بلا موعد |

**⛔ وهويّة القناة ليست حالة:** تبقى على `--chan-*` ([tokens.css:66-70](client/src/lib/theme/tokens.css#L66)) بتشبّعها الأدنى عمداً، وتُرسَم بالشكل **المُدمج** (أيقونة 20×20 بلا نصّ، [InvoiceChannelBadge.tsx:45-53](client/src/components/InvoiceChannelBadge.tsx#L45)) داخل الجداول كي لا تُزاحم الحالة.

### ٥-ج. مسار الجوال — `MobileDataCard`

**نقصٌ رفعه النقد على طرحَي ١ و٣، ومُعتمَدٌ هنا كاملاً.**

العطب ليس المقاس بل **ازدواج الدلالة**: `MobileDataCard` يفرض ألواناً خامّة `border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400` ([MobileDataCard.tsx:77](client/src/components/ui/MobileDataCard.tsx#L77)) و`amber-500` ([:78](client/src/components/ui/MobileDataCard.tsx#L78)) و`text-emerald-600` للمبلغ الموجب ([:102](client/src/components/ui/MobileDataCard.tsx#L102))، بينما سطح المكتب يمرّ على `badge-status-*` من التوكنز ([tokens.css:321](client/src/lib/theme/tokens.css#L321)) ⇒ **أخضران مختلفان لحالة «مدفوعة» الواحدة** بحسب حجم الشاشة.

وهو **خارج نطاق حارس `check:colors`** (`SCAN_ROOT = client/src/pages`، [check-no-raw-status-colors.mjs:27](scripts/check-no-raw-status-colors.mjs#L27)) فلن يمسكه شيء.

**القرار:** تُحذف الألوان الخامّة الثلاثة وتُستبدَل بمتغيّرات `Badge` نفسها (`success`/`warning`) و`text-money-positive`. نصف القطر ينزل من `rounded-2xl` ([:60](client/src/components/ui/MobileDataCard.tsx#L60)) إلى `--ui-radius-card` = 14px.

### ٥-د. شريط الأدوات — ما يُلمَس وما لا يُلمَس

**⛔ لا يُبنى `ControlPanel` جديد** (مرفوضٌ باعتماد النقد — §١). التعديلات محصورةٌ في ثلاثة عيوبٍ مقيسة:

**١) لوحة الفلاتر الفارغة.** الشاشة تمرّر `ListToolbar` بلا `search` وبلا `filters` ([Invoices.tsx:743](client/src/pages/Invoices.tsx#L743))، و`hasFilterSection` يصير `true` بمجرّد وجود `onResetFilters` ([ListToolbar.tsx:132](client/src/components/list/ListToolbar.tsx#L132) و[:214](client/src/components/list/ListToolbar.tsx#L214)) ⇒ يُرسَم `rounded-lg border border-border/60 bg-muted/30 p-2.5` وداخله flex فارغ = **شريطٌ رماديّ ≈20px بلا محتوى** كلّما لم يكن هناك فلترٌ مفعَّل. **الإصلاح:** `hasFilterSection` يشترط وجود `search` أو `filters` فعلياً، لا مجرّد `onResetFilters`.

**٢) الحشوة المضاعفة.** جذر `Card` فيه `py-6` ([card.tsx:10](client/src/components/ui/card.tsx#L10)) والشاشة تضيف `pt-6` على `CardContent` (التي لا حشوة رأسية لها، [card.tsx:68](client/src/components/ui/card.tsx#L68)) ⇒ **48px فراغ ميت** فوق شريط الفلاتر ومثله فوق شريط المجاميع ([Invoices.tsx:741](client/src/pages/Invoices.tsx#L741) و[:967](client/src/pages/Invoices.tsx#L967)).

**⚠️ الإصلاح في الشاشة لا في `card.tsx`.** طرح ٣ اقترح خفض حشوة `card.tsx` من 24px إلى 16px — والنقد أمسك أنّ الرقعة **586 استعمالاً لـ`<CardContent>` في 190 ملفاً، منها 399 يمرّر حشوةً صريحة** مبنيّةً على الأساس الحاليّ. المكسب (8px) هامشيّ مقابل مئات مواضع تركيبٍ تتغيّر بلا مراجعة. **⇒ يُحذَف `pt-6` من المواضع المحدَّدة في الشاشات المستهدَفة، و`card.tsx` لا يُمَسّ.**

**٣) اتّساق ارتفاعات الحقول.** حقل «العميل» يقفز 8px عند الاختيار: الحالة الفارغة `Input` = 44px، والحالة المختارة `div` بـ`h-9` = 36px ([Invoices.tsx:134](client/src/pages/Invoices.tsx#L134)) بينما الثمانية المجاورة (AppSelect) كلّها 44px. **يُضبَط على `h-[var(--ui-control)]`.**

### ٥-هـ. ما لا يُلمَس في هذا القسم

| العنصر | السبب |
|---|---|
| الفرز الخادميّ للفواتير | الشاشة لا تمرّر `serverSorting` فيصير `enableSorting: false` ([DataTable.tsx:237](client/src/components/data-table/DataTable.tsx#L237)) ⇒ ١٣ عموداً بلا فرز. **إصلاحٌ خلفيّ لا تصميميّ** — خارج نطاق هذه الحملة، ويُسجَّل ديناً معلَناً. |
| طيّ الفلاتر خلف أوجه بحث | قرارُ استعمالٍ يُعرض على المالك لا يُقرَّر في شريحة تصميم (باعتماد النقد). |
| `card.tsx` | §٥-د أعلاه. |

### الملفّات
- `D:\business_management_system\.claude\worktrees\invoices-orders-system-149fd0\client\src\components\data-table\DataTable.tsx`
- `D:\business_management_system\.claude\worktrees\invoices-orders-system-149fd0\client\src\components\table\ScrollTableShell.tsx`
- `D:\business_management_system\.claude\worktrees\invoices-orders-system-149fd0\client\src\components\ui\badge.tsx`
- `D:\business_management_system\.claude\worktrees\invoices-orders-system-149fd0\client\src\components\InvoiceChannelBadge.tsx`
- `D:\business_management_system\.claude\worktrees\invoices-orders-system-149fd0\client\src\components\ui\MobileDataCard.tsx`
- `D:\business_management_system\.claude\worktrees\invoices-orders-system-149fd0\client\src\components\PageState.tsx`
- `D:\business_management_system\.claude\worktrees\invoices-orders-system-149fd0\client\src\pages\Invoices.tsx`

---

## ٦. رأس الصفحة الموحَّد

### ⛔ لا مكوّن جديد

`PageHeader` **موجودٌ ويغطّي العقد كاملاً**: `{title, description, actions, icon, breadcrumbs, backHref, backLabel, className}` ([PageHeader.tsx:50](client/src/components/PageHeader.tsx#L50))، ويستعمله **١٢٥ موضعاً في ١٢٤ ملفاً**. المشكلة ليست غياب المكوّن بل **٣٣ صفحة تبني رأسها يدوياً** بأربعة مقاسات (`text-2xl font-bold` · `text-xl font-bold` · `text-xl font-extrabold` · `text-lg font-bold`) و**١٤ صفحة بلا أيّ عنوان** — منها `/work-orders` (لوحة الكانبان، صفر مطابقة لـ`<h1|<h2|<h3`).

**⇒ التوقيع لا يتغيّر. التعديلات ثلاثةٌ داخل المكوّن، والباقي هجرةٌ تدريجية خارج نطاق هذه الحملة.**

### التعديلات الثلاثة داخل `PageHeader`

**١) سهم الرجوع.** اليوم محرفٌ خامّ `<span aria-hidden>←</span>` ([PageHeader.tsx:59](client/src/components/PageHeader.tsx#L59)) — يشير إلى **الأمام** في RTL لا إلى الرجوع، وهو نصٌّ لا أيقونة فلا يمسكه حارس `check:emoji`، وقد تكرّر يدوياً في عشرات الصفحات.

```
يُستبدَل بـ:  <ArrowRight aria-hidden className="size-4 shrink-0" />
```
(يمينٌ = رجوعٌ في RTL؛ وإن وُجدت أسطح LTR مستقبلاً فتُقلَب بـ`rtl:`/`ltr:` لا باختيار الأيقونة.)

**٢) فاصل مسار التنقّل — مقلوبٌ مرّتين.** مكوّن shadcn يقلبه أصلاً: `[&>svg]:rtl:rotate-180` مع الافتراضيّ `{children ?? <ChevronRight />}` ([breadcrumb.tsx:75](client/src/components/ui/breadcrumb.tsx#L75) و[:78](client/src/components/ui/breadcrumb.tsx#L78))، بينما `PageHeader` يمرّر `<ChevronLeft className="size-3.5" />` ([PageHeader.tsx:98](client/src/components/PageHeader.tsx#L98)) ⇒ **قلبان يتعاندان** فيشير الفاصل عكس تدفّق القراءة العربيّ. و`<html dir="rtl">` مضبوطة فعلاً ([index.html:2](client/index.html#L2)) فالمتغيّر `rtl:` نشِطٌ حتماً.

```
يُحذَف تمرير الفاصل ويُترَك الافتراضيّ ChevronRight يعمل مع rtl:rotate-180
```

**٣) وسم مسار التنقّل بالعربية.** `aria-label="breadcrumb"` ([breadcrumb.tsx:8](client/src/components/ui/breadcrumb.tsx#L8)) يُقرأ حرفياً لقارئ الشاشة العربيّ، خلافاً لبقيّة الوسوم («التنقّل الرئيسي» في [AppLayout.tsx:248](client/src/components/AppLayout.tsx#L248)).

```
aria-label="مسار التنقّل"
```

### الرأس اللاصق — بحذر

**العطب:** صفر `sticky` في `PageHeader` و`PageTabs` و`ReportShell` ⇒ في جدولٍ طويل يختفي اسم الشاشة وشريط التبويبات معاً فيفقد الموظّف موضعه.

**⚠️ لكن `sticky top-0` داخل `<main>` يُنتج فجوةً مكشوفة** — حاجزٌ من النقد: `<main>` حشوته العلوية 24px (`p-3 md:p-6`، [AppLayout.tsx:462](client/src/components/AppLayout.tsx#L462))، فالرأس يثبت عند حافّة صندوق الحشو ويبقى شريطٌ 24px فوقه يمرّ المحتوى خلفه مكشوفاً.

**الوصفة الصحيحة:** الرأس يحمل حشوته الرأسية الذاتية وخلفيةً معتمة تغطّي كامل العرض:

```css
position: sticky;
inset-block-start: 0;
z-index: var(--z-sticky);
margin-block-start: calc(-1 * var(--ui-space-6));   /* يبتلع حشوة main العلوية */
padding-block: var(--ui-space-3);
background: color-mix(in oklch, var(--background) 96%, transparent);
backdrop-filter: blur(8px);
border-block-end: 1px solid var(--border);
```

هذه هي وصفة الرأس اللاصق **القائمة فعلاً** في [comfort.css:66-69](client/src/lib/theme/comfort.css#L66) — لا اختراع.

**⇒ يُطبَّق كـ`prop` اختياريّ `sticky?: boolean` بافتراضٍ `false`**، فلا ينزل على ١٢٥ موضعاً دفعةً. الشاشات ذات الجداول الطويلة تُفعّله صراحةً.

### ⛔ ما لا يُلمَس في هذا القسم

| البند | السبب |
|---|---|
| `client/src/components/AppLayout.tsx` | **ملفٌّ ساخن** بنصّ §٧ من CLAUDE.md — يملكه قائد الدمج وحده، وhooks الـcoord ترفض الكتابة عليه لغير مالك `_integration`. طرح ٣ أدرجه في شريحةٍ عادية ⇒ **ستُرفَض ميكانيكياً**. |
| سقف عرض 1440px على `<main>` | حاجزان من النقد: (أ) `<main>` ملفٌّ ساخن؛ (ب) يستضيف الكاشير (`.pos-workspace`، [comfort.css:109-136](client/src/lib/theme/comfort.css#L109)) ولوحة الكانبان (`height: calc(100vh - 3rem)`، [board.css:28](client/src/pages/WorkOrders.board.css#L28)) — كلاهما مصمَّمٌ لملء الشاشة، فالسقفُ يقصّهما على شاشة 1920. **البديل:** `max-inline-size: 90rem; margin-inline: auto` على غلافٍ **داخل** الصفحات التي تحتاجه — شريحةٌ مستقلّة خارج هذه الحملة. |
| `margin: "-24px"` في اللوحتين ([Dashboard.tsx:1443](client/src/pages/Dashboard.tsx#L1443) و[:1300](client/src/pages/Dashboard.tsx#L1300)) | **يُحذَف** — هذا داخل `Dashboard.tsx` لا `AppLayout`. القوقعة `p-3` (12px) تحت 768px لا 24px ⇒ فيضٌ أفقيّ 24px عرضاً داخل `overflow-auto`. الحشوة تأتي من `<main>` وحده. |
| توحيد تسميات التنقّل الأربع | `/invoices` = «المبيعات» / «فواتير المبيعات» / «فواتيري» — إصلاحٌ يمسّ `AppLayout.tsx` و`MobileBottomNav.tsx` و`CommandPalette.tsx`. دَينٌ معلَن. |
| `document.title` لكل مسار | لا خطّاف عنوانٍ في ١٢ خطّافاً بـ`client/src/hooks/`. دَينٌ معلَن. |

### رأس المجموعة (`SectionHeader`)

نسختان اليوم لا تلتقيان:

| | الإدارية ([:921-926](client/src/pages/Dashboard.tsx#L921)) | الكاشير ([:1377-1382](client/src/pages/Dashboard.tsx#L1377)) |
|---|---|---|
| شريط اللون | 3×14px، radius 2 | **معدوم** |
| التسمية | 11px/700، `letter-spacing: 0.06em` | 13px/800، `0.04em` |
| خطّ الامتداد | `opacity: 0.35` | بلا opacity |

**الموحَّد:** شريط لونٍ 3×14px بنصف قطر 2px (لون القسم) ← تسمية `--text-xs` 13px/700 بـ`letter-spacing: 0.05em` ولون `var(--dash-sec-label)` ← تلميحٌ اختياريّ `--text-2xs` 12px ← خطُّ امتدادٍ 1px `var(--border)` بـ`opacity: 1`.

| المسافة | القيمة | يستبدل |
|---|---|---|
| رأس المجموعة ← الشبكة | 12px (`--ui-space-3`) | 10 للإدارة ([:920](client/src/pages/Dashboard.tsx#L920)) · 14 للكاشير ([:1376](client/src/pages/Dashboard.tsx#L1376)) |
| بين مجموعتين | 32px (`--ui-space-8`) | 20 ([:1455](client/src/pages/Dashboard.tsx#L1455)) · 32 ([:1305](client/src/pages/Dashboard.tsx#L1305)) |
| عناصر الرأس | 8px (`--ui-space-2`) | — |

**وحشوةٌ أفقية 24px على شريط المقاييس** ليحاذي ما تحته: اليوم `padding: "10px 0"` ([:653](client/src/pages/Dashboard.tsx#L653)) صفرٌ أفقياً بينما الشبكة تحته 24px ([:1451](client/src/pages/Dashboard.tsx#L1451)) ⇒ خطُّ بدايةٍ متكسّر بين ثلاث مناطق متتالية.

**والحشوة المضاعفة في شاشة الكاشير:** `TasksBrief` يحمل 24px ([:1177](client/src/pages/Dashboard.tsx#L1177)) داخل حاويةٍ حشوتها `clamp(20px,4vw,48px)` ([:1302](client/src/pages/Dashboard.tsx#L1302)) ⇒ تُحذَف الداخلية.

### الملفّات
- `D:\business_management_system\.claude\worktrees\invoices-orders-system-149fd0\client\src\components\PageHeader.tsx`
- `D:\business_management_system\.claude\worktrees\invoices-orders-system-149fd0\client\src\components\ui\breadcrumb.tsx`
- `D:\business_management_system\.claude\worktrees\invoices-orders-system-149fd0\client\src\pages\Dashboard.tsx`

---

## ٧. تسلسل التنفيذ

> **قبل أيّ كتابة:** `pnpm coord:list` + `git status` + `pnpm coord:claim <شريحة> --files <ملفّاتك>` — البوّابة الإلزامية §٤ من CLAUDE.md. وكلّ شريحةٍ تملك ملفّاتها حصرياً ولا تتقاطع مع أختها.

### ش١ — طبقة التوكنز (المرادفات معها، لا بعدها)

**الملفّات:** `client/src/index.css` · `client/src/lib/theme/tokens.css` · `client/src/lib/theme/comfort.css`

**العمل:**
1. تثبيت `--radius: 0.625rem` في كتلة `.dark` ([index.css:119](client/src/index.css#L119)).
2. سلّم الأوزان 500/600/700/800 ([index.css:62-63](client/src/index.css#L62)) **+ حذف `body { font-weight: 500 }`** من [comfort.css:34-37](client/src/lib/theme/comfort.css#L34).
3. `--text-2xs: 0.75rem` و`--text-2xs--line-height: 1.125rem` **داخل `@theme inline`** ([index.css:46](client/src/index.css#L46) بجواره).
4. `--ui-space-5: 1.25rem` و`--tile-*` و`--kpi-h` في [comfort.css](client/src/lib/theme/comfort.css).
5. إعادة قيم `--ui-shadow-surface/float/dialog` بمقابلٍ داكنٍ صريح.
6. `--card-edge` في السمتين، و**`--dash-card-bord: var(--card-edge)`**، و`--dash-bg` الفاتح ⇒ oklch(0.935 0.010 82).
7. `--sem-neutral` و`--sem-neutral-bg` و`--sem-danger: var(--sem-neg)`.
8. تحويل `money/stock/status` كلّها إلى مرادفاتٍ لـ`sem-*` (بما فيها `--status-done ⇒ --sem-info`).
9. سلّم `--z-*` وتوكنز الحركة.

**الأثر:** ⭐ **أعلى نسبة أثرٍ إلى مخاطرة في الحملة.** بتغييرٍ في ثلاثة ملفّات تُغلَق أعطابٌ تمسّ كلّ شاشة: تبدّلُ شكل كلّ زاويةٍ عند تبديل السمة · تطابقُ `font-medium` و`font-semibold` · ازدواجُ الأحمر والأخضر داكناً · نصُّ الخطأ بلا لون في أربعة مواضع (`--sem-danger`). **والمرادفات هي ما ينزّل المكسب:** `--dash-card-bord: var(--card-edge)` يرقّي حدّ ٣٨ بطاقة + بطاقات الكاشير + `BriefCard` + `MetricsBar` **بلا لمس ملفّ شاشة**، لأنّ خريطة `T` تقرأ التوكن.

**⚠️ قاعدةٌ من النقد:** لو أُضيفت الأسماء الجديدة **موازيةً** بدل مرادفات، لكان الأثر البصريّ **صفراً** والوعد كذباً. المرادفات في هذه الشريحة لا في التالية.

**التحقّق:** جولةٌ بصرية داكنة على ثلاث شاشات بكثافاتٍ مختلفة: الكاشير · الفواتير · الكانبان. لقطتا قبل/بعد لشاشتين. لا يُدمج مع أيّ تغييرٍ آخر ⇒ `git revert` نظيف.

---

### ش٢ — `LaunchTile`: تشريحٌ واحد للمسارين

**الملفّات:** `client/src/pages/Dashboard.tsx`

**العمل:** استبدال `ModuleCard` و`Tile` ببلاطةٍ واحدة (رأس 48 · جسم 144 · ذيل 44)؛ محاذاةٌ للبداية لا توسيط؛ **`overflow: clip` + `overflow-clip-margin: 4px`** بدل `overflow: hidden` والجذر يبقى `<div>`؛ شبكة `auto-fill/minmax(15rem,1fr)`؛ حذف `margin: "-24px"` من اللوحتين؛ شارة العدّاد عبر `fmtAr` + `dir="ltr"` + `tabular-nums`؛ حالة فشل الاستعلام (نقطة `--sem-neutral`)؛ إضافة شكل `shifts` للخريطة.

**الأثر:** هذه هي الشريحة التي يراها المالك مباشرةً. تُنهي نمطين غريبين لفعلٍ واحد؛ تُصلح **قصّ حلقة التركيز عبر ٣٨ بطاقة** (عطبُ وصولٍ عالٍ)؛ تُسقط ٢٠ مستمع `matchMedia` (أربع استدعاءات `useMediaQuery` داخل كلّ `SectionRow` × ٥ أقسام، [:908-912](client/src/pages/Dashboard.tsx#L908)); تُنهي الفيض الأفقيّ 24px على الموبايل؛ تُنزل أحجام الخطّ من ١٣ إلى ٤؛ وتُخرج النصّ العربيّ من 10.5px إلى 13px.

**⚠️ ميزانية اللون صفر:** `Dashboard.tsx` **ليس في خطّ الأساس المجمَّد** ([raw-color-baseline.json](scripts/raw-color-baseline.json) — ٧٥ مفتاحاً ولا مفتاح فيه «Dashboard») ⇒ أيّ لونٍ خامّ يُضاف يُفشِل CI فوراً. حمايةٌ حقيقية.

---

### ش٣ — `KpiTile`: رقمٌ واحدٌ بمقاسٍ واحد

**الملفّات:** `client/src/pages/Dashboard.tsx` (كتلٌ منفصلة عن ش٢)

**العمل:** توحيد `MetricsBar` (ارتفاع 50px، تسمية **9.5px**، [:670](client/src/pages/Dashboard.tsx#L670) و[:708](client/src/pages/Dashboard.tsx#L708)) و`BriefCard` (radius 10، رقم 22px/**900**، [:962](client/src/pages/Dashboard.tsx#L962) و[:998](client/src/pages/Dashboard.tsx#L998)) في بطاقةٍ واحدة:

| الخاصّية | القيمة |
|---|---|
| الارتفاع | `--kpi-h` = 76px |
| نصف القطر | 14px |
| الحشوة | 12px رأسياً / 16px أفقياً |
| رقاقة الأيقونة | 40×40، radius 10px |
| التسمية | `--text-xs` 13px / 600 / `var(--dash-sub)` |
| الرقم | `--text-2xl` 26px / **800** / `tabular-nums` / `dir="ltr"` |
| السطر الثانويّ | `--text-2xs` 12px / 500 / ellipsis |
| شريط الحالة | `border-inline-start: 3px` |
| الشبكة | `repeat(auto-fill, minmax(15rem, 1fr))` بفجوة 16px |
| حشوة الحاوية | 16px رأسياً / **24px أفقياً** |
| قيمة معدومة | «—» لا 0 (`fmtAr` يُرجعها للفارغ) |

**الأثر:** يُنهي أصغرَ نصٍّ عربيّ في النظام (9.5px يفقد فيه Cairo النقاط والهمزات)، وأخطرَ faux-bold (وزن 900 **غير محمَّل**: [main.tsx:16-20](client/src/main.tsx#L16) يستورد 400-800) على أهمّ رقمٍ في الشاشة، ويستقيم خطُّ البداية المتكسّر بين ثلاث مناطق. **و`borderRight` الفيزيائيّ** ([:965](client/src/pages/Dashboard.tsx#L965)) يصير منطقياً — وهو يعمل صدفةً اليوم وينقلب في أيّ حاوية `dir="ltr"` (شائعةٌ للأرقام).

---

### ش٤ — شكلا الشارة فقط

**الملفّات:** `client/src/components/ui/badge.tsx` · `client/src/components/InvoiceChannelBadge.tsx` · `client/src/components/ui/MobileDataCard.tsx` · `client/src/pages/Invoices.tsx`

**العمل:** إضافة متغيّرَي هندسة إلى `Badge` (status 24px/`rounded-md` · counter 24px/`rounded-full`) وتحويل الشارات الخمس في شاشة الفواتير وشارة القناة إليهما؛ وحذف الألوان الخامّة الثلاثة من `MobileDataCard`.

**الأثر:** يُنهي خمس هندسات وأربعة أحجام خطٍّ في **الصفّ الواحد**، ويُثبِّت ارتفاع الخليّة 24px فيستقيم إيقاع الصفّ (41→60px اليوم)، **ويُنهي أخضرَين مختلفين لحالة «مدفوعة» الواحدة** بين سطح المكتب والجوال.

**⚠️ `badge.tsx` و`MobileDataCard.tsx` خارج نطاق `check:colors`** (`SCAN_ROOT = pages`) ⇒ **بوّابةٌ يدوية في المراجعة:** `grep -nE "emerald|amber|rose|slate-[0-9]" client/src/components/ui/MobileDataCard.tsx` يجب أن يُرجع صفراً بعد التعديل.

---

### ش٥ — إيقاع الجدول (إصلاحُ عطبٍ ماليّ الأثر)

**الملفّات:** `client/src/components/data-table/DataTable.tsx` · `client/src/components/table/ScrollTableShell.tsx` · `client/src/components/PageState.tsx`

**العمل:** إزالة `odd:/even:` من [DataTable.tsx:493](client/src/components/data-table/DataTable.tsx#L493) **وقاعدة الحاوية** من [ScrollTableShell.tsx:46](client/src/components/table/ScrollTableShell.tsx#L46) — **الاثنتان في نفس الالتزام**؛ ربط `h-[var(--ui-table-head)]` و`h-[var(--ui-table-row)]`; `padding-block: 0`; `text-start` بدل `text-right`; فاصلٌ واحد؛ هيكلُ التحميل بعدد الأعمدة **المرئية**; بطاقاتٌ هيكلية للجوال بدل `<tr>` يتيمة؛ الوضع المدمج يقصّ الرأسيّ وحده.

**الأثر:** ⭐ **ليس تجميلاً:** تمييز «عربون — يحتاج تحصيل الباقي» **لا يُرسَم أصلاً** وتمييزُ الصفّ المحدَّد **يختفي على نصف الصفوف** — كلاهما بسبب خصوصية (0,2,2) مقابل (0,1,0) و(0,2,0). وحذفُ التزنير يُغلق الصنف كلَّه. ويعطي أخيراً مستهلكاً للتوكنين [comfort.css:19-20](client/src/lib/theme/comfort.css#L19) الجالسَين بمستهلكٍ واحد.

**التعويض عن التزنير** (ثلاثيّ ومقيس): الارتفاع يرتفع من ≈41px إلى **48px ثابت** · تحويم الصفّ بتظليلٍ صريح · فاصل 1px واضحٌ بدل ثلاثةٍ بشفافيات. وإن أصرّ الاستعمال على التزنير: يُعاد بـ`[&_tbody_tr[data-zebra]]` بخصوصيةٍ **أدنى** من تمييز الحالة والتحديد — لا كما هو اليوم أعلى منهما.

---

### ش٦ — `ObjectCard` للكانبان (التزامان)

**الملفّات:** `client/src/pages/WorkOrders.tsx` · `client/src/pages/WorkOrders.board.css`

**التزام أ — بصريّ محض** (بلا مسّ أيّ مسار `pointerdown`): تشريح رأس/جسم/ذيل بحدَّين صريحين؛ قصّ العنوان سطرين واسم العميل ellipsis؛ إدخال `workOrderCardLabel` نصّاً؛ تعريف `.wob-done`؛ حذف قضيب التقدّم وسطر المرحلة ورقاقة «عادي»؛ المصغّرة تُعرَض حين توجد صورة فقط؛ توحيد الأحجام والأوزان وأنصاف الأقطار؛ حذف `--s-blue/-violet/-emerald` و`--s-amber` والقاعدة الميتة؛ حصر الترميز الأحمر؛ `flex-wrap: nowrap` للميتا؛ `text-align: start`.

**التزام ب — هندسيّ:** عرض الشبح 304px؛ إعادة تسمية `--accent` ⇒ `--card-accent` في **TSX وCSS معاً**؛ `role`/`tabIndex`/`onKeyDown`؛ جرد أهداف اللمس (زرّ الإسناد ⇒ `Button` · `CopyInline` ⇒ `data-slot` · `.wob-wa` ⇒ 40px)؛ `AppSelect` بدل `<select>` الخامّ.

**الأثر:** أكبر مكسبٍ في كثافة المعلومة: الارتفاع ينزل من ≈234px إلى ≈150px ⇒ من **≈٣ بطاقات إلى ≈٥** في العمود على شاشة 1080px. ويُصلح أربعة أعطابٍ حقيقية: تلوّثُ `--accent` لكامل شجرة البطاقة · شارةُ «سُلّم» بلا لونٍ في كلّ بطاقةٍ مُغلَقة · حالةُ التوصيل المشتقّة الغائبة · وعدمُ الوصول بلوحة المفاتيح.

**فحوص القبول:**
```
grep -n 'var(--accent'  client/src/pages/WorkOrders.board.css   ⇒ صفر
grep -nE 'oklch\(|#[0-9a-fA-F]{3,6}'  client/src/pages/WorkOrders.board.css
   ⇒ كلّ مطابقة تُبرَّر أو تُحوَّل إلى توكن
```
**واختبارُ السحب يدوياً بين الأعمدة الخمسة في الاتّجاهين قبل كلّ دمج** — الكانبان بلا اختبارٍ آليّ يغطّي التفاعل. **وقرار حذف قضيب التقدّم يُعرَض على المالك بمقارنة قبل/بعد بعدد البطاقات الظاهرة.**

⚠️ **حارس `check:colors` أعمى عن `.css` كلّياً** ([:43](scripts/check-no-raw-status-colors.mjs#L43) يمسح `.tsx` فقط) وخطُّ أساس `WorkOrders.tsx` = **١** (وهو `text-emerald-600` في [:464](client/src/pages/WorkOrders.tsx#L464)، خارج البطاقة أصلاً) ⇒ الفحص اليدويّ أعلاه هو البوّابة الوحيدة.

---

### ش٧ — رأس الصفحة (RTL والتسمية واللصق الاختياريّ)

**الملفّات:** `client/src/components/PageHeader.tsx` · `client/src/components/ui/breadcrumb.tsx` · `client/src/pages/Dashboard.tsx` (رأس المجموعة)

**العمل:** `ArrowRight` بدل `←`؛ حذف تمرير `ChevronLeft` ليعمل الافتراضيّ مع القلب؛ `aria-label="مسار التنقّل"`؛ `sticky?: boolean` بافتراضٍ `false` بوصفة [comfort.css:66-69](client/src/lib/theme/comfort.css#L66)؛ توحيد رأس المجموعة في `Dashboard`؛ حشوة 24px أفقية على شريط المقاييس؛ حذف الحشوة المضاعفة في `TasksBrief`.

**الأثر:** اتّجاهان بصريّان مقلوبان في واجهةٍ عربية كاملة يُصحَّحان في المكوّن المشترك ⇒ ينزلان على ١٢٥ موضعاً. وسهمُ الرجوع الخامّ الذي نُسخ يدوياً في عشرات الصفحات يصير أيقونةً محروسة.

**⛔ `AppLayout.tsx` لا يُلمَس** — ملفٌّ ساخن (§٧ من CLAUDE.md).

---

### ش٨ — الحرّاس (شريحةٌ مستقلّة، بعد تجميد المكسب)

**الملفّات:** `scripts/check-no-raw-status-colors.mjs` · `scripts/raw-color-baseline.json`

**العمل الوحيد:** توسيع `SCAN_ROOT` ليشمل `client/src/components` **بخطّ أساسٍ مجمَّد يُضاف في نفس الـPR بلا إصلاح أيّ موضع** (٤٢٤ موقعاً في ٥٤ ملفاً غير محروسة اليوم — منها [invoice/ProductTable.tsx](client/src/components/invoice/ProductTable.tsx) بـ١٢ و[reception/PaymentPanel.tsx](client/src/components/reception/PaymentPanel.tsx) بـ٩، وفيه يعرض «الباقي» بـ`text-emerald-700` خامّاً بينما جاره بـ`text-[var(--sem-warn)]` في الشاشة نفسها).

**⛔ ولا حارس `check:type-scale`.** حاجزٌ من النقد: الوصف المقترح يجمع بين خطّ أساسٍ مجمَّد **و**رفضٍ «مطلق» لما دون 11px — والوصفان يتناقضان. العدّ الفعليّ **633 مطابقة** لـ`text-[Npx]` في `client/src/pages`، منها **188 موضعاً دون 11px قائمةً على `main`** ⇒ الرفض المطلق **يفشل على الحال الراهن قبل أيّ تغيير**، فيُتجاوَز بـ`--no-verify` — وهي بالضبط العلّة التي أُعيدت لأجلها معايرة `pre-commit`. الحارس يأتي بعد الهجرة لا قبلها.

**الأثر:** يمنع النموّ ولا يطالب بالتراجع — نفس نمط خطّ الأساس القائم (٧٥ ملفاً بمجموع **٨٣٦**، لا ٦٩٥ كما يذكر التوثيق).

**⚠️ ترتيبٌ مهم:** ش٨ **لا تُقدَّم** لأنّ هذه المواصفة **لا تنقل أيّ كودٍ إلى `client/src/components`** — البلاطة والـKPI يبقيان في `Dashboard.tsx` والبطاقة في `WorkOrders.tsx`. النقد حذّر من نقل كودٍ محروسٍ إلى منطقةٍ غير محروسة (كما فعل طرح ٢ بإنشاء `LauncherCard.tsx` و`StatTile.tsx` تحت `components/`) — والمواصفة تتجنّب هذا بالبقاء داخل `pages/`.

---

## ٨. ما لن يُنفَّذ ولماذا

### ٨-أ. مرفوضٌ بقرار (تجاوزُ نطاق)

| البند | السبب |
|---|---|
| **`ControlPanel` موحَّد** (دمج PageHeader + ListToolbar + PeriodFilter + شريط DataTable) | يمسّ ثلاثة أسطحٍ مشتركة يستعملها ١٢٥ + ٣٦ + ١٧ موضعاً. تعديلُ المكوّن ينزل على كلّ مستهلكيه فوراً — «تطبيقٌ على شاشة واحدة» وهم. وطلبُ المالك ترتيبُ البطاقات لا إعادة تصميم شريط التحكّم. |
| **طيّ الفلاتر خلف أوجه بحث** (`SearchFacet`) | تغييرُ سلوكٍ لا تصميم: الفلاتر العشرة تعمل اليوم بنقرةٍ واحدة، والطيّ يضيف نقرتين لموظّفةٍ تفلتر عشرات المرّات في الوردية. **قرارُ استعمالٍ يُعرَض على المالك.** |
| **تعديل حشوة `card.tsx`** (24px ⇒ 16px) | ٥٨٦ استعمالاً لـ`<CardContent>` في ١٩٠ ملفاً، **٣٩٩ منها يمرّر حشوةً صريحة** مبنيّةً على الأساس الحاليّ. المكسب 8px مقابل مئات مواضع تركيبٍ تتغيّر بلا مراجعة ولا اختبارٍ بصريّ يغطّيها. البديل: حذف `pt-6` في المواضع المستهدَفة (§٥-د). |
| **هجرة ٣٧ شكلاً إلى `lucide-react`** | إعادةُ رسم ٣٧ هويّة بصرية لم يشتكِ منها المالك، وكلفتُها فقدانُ التمييز لصالح مجموعةٍ عامّة. العطب المُثبَت واحدٌ فقط: مفتاح `shifts` المفقود — يُصلَح بشكلٍ واحد. |
| **حارس `check:type-scale`** | الوصفُ المقترح متناقض داخلياً (خطّ أساسٍ مجمَّد + رفضٌ مطلق)، ورفضُ ما دون 11px يفشل على الحال الراهن (188 موضعاً على `main`) ⇒ يُتجاوَز بـ`--no-verify` فيصير مسرحياً. يأتي بعد الهجرة. |
| **حارس يمنع الظلال المحلّية** | نفس المنطق: [WorkOrders.board.css](client/src/pages/WorkOrders.board.css) و[PriceChecker.css](client/src/pages/PriceChecker.css) يحملانها اليوم؛ الحارس قبل الهجرة يُحمِّر CI. |
| **خفض `--background`** | يقلب هرم الأسطح المحايدة كلَّه (`--muted`/`--accent` = 0.940 · `--secondary` = 0.945) فيُقرأ رأسُ الجدول والترويسةُ اللاصقة سطحاً **مرتفعاً** بدل غائر، ويُنتج تزنيراً صارخاً في `odd:bg-background`. البديل المعتمد: خفض `--dash-bg` وحده. |
| **جعل جذر البلاطة رابطاً** | مستحيلٌ مع ذيل الإجراءات ⇒ `<a>` داخل `<a>`: HTML غير صالح، ووكلاء لوحة المفاتيح وقارئ الشاشة ينكسران. البديل: `overflow: clip` + `overflow-clip-margin`. |
| **صفٌّ كثيف 36px** | زرّ الصفّ `icon-sm` = 40px ويرتفع إلى 44px على اللمس ⇒ الارتفاع «الثابت» لا يثبت. و48px هو التوكن القائم المستهلَك في ثماني شاشات. |
| **`--ui-radius-card` ⇒ 8px** | `Card` يستعمل `rounded-xl` = 14px ويستهلكه ١٩٠ ملفاً ⇒ بطاقاتٌ جديدة 8px بجوار ١٩٠ ملفاً بـ14px. وعدُ «نصف قطرٍ واحد» ينكسر عند التنفيذ. |
| **حذف مصغّرة الكانبان** | تعرض **صورة الأمر الأولى** حين توجد ([WorkOrders.tsx:309](client/src/pages/WorkOrders.tsx#L309)) — حذفُها يُلغي المعاينة البصرية. المحذوف هو الاحتياطيّ الثابت فقط. |
| **`AppLayout.tsx` و`<main>`** | ملفٌّ ساخن (§٧ من CLAUDE.md) يملكه قائد الدمج، وhooks الـcoord ترفض الكتابة عليه لغير `_integration`. وسقفُ 1440px عليه يقصّ الكاشير والكانبان المصمَّمَين لملء الشاشة. |
| **استخراج المكوّنات إلى `client/src/components/**`** | يُخرجها من نطاق `check:colors` (`SCAN_ROOT = pages`) — والحمايةُ الوحيدة لـ`Dashboard.tsx` أنّه **ليس في خطّ الأساس** فميزانيتُه صفر. النقلُ يُبطل الضمان. تبقى داخل `pages/` حتى تتّسع الشريحة ش٨. |

### ٨-ب. دَينٌ مُعلَنٌ لا مُنجَزٌ مزعوم

| الدَّين | الحجم المقيس |
|---|---|
| **٦٣٣ مقاس خطٍّ حرفيّ** في `client/src/pages` (416× 11px · 168× 10px · 20× 9px · 11× 12px · 10× 13px) | الحملة **لا تدّعي هجرتها**. تدّعي أنّ **البلاطة والبطاقة والشارة والصفّ والـKPI** لا تنزل تحت 12px — وهي ما يراه المالك. |
| **٨٣٦ لوناً خامّاً** في ٧٥ ملفاً (خطّ الأساس المجمَّد الفعليّ، لا ٦٩٥ كما يذكر التوثيق) | تبقى مجمَّدة. الحملة لا تُضيف واحداً. |
| **٤٢٤ لوناً خامّاً** في ٥٤ ملفَّ مكوّن، **غير مجمَّد** | تُجمَّد في ش٨ بلا إصلاح — تمنع النموّ لا أكثر. |
| **الفرز الخادميّ لشاشة الفواتير** | ١٣ عموداً بلا نقرة فرزٍ واحدة (الشاشة لا تمرّر `serverSorting`). إصلاحٌ خلفيّ خارج نطاق حملةٍ تصميمية. |
| **توحيد تسميات التنقّل الأربع** (`/invoices` = «المبيعات»/«فواتير المبيعات»/«فواتيري») | يمسّ `AppLayout.tsx` (ساخن) + `MobileBottomNav.tsx` + `CommandPalette.tsx`. |
| **`document.title` لكل مسار** | لا خطّاف عنوانٍ ضمن ١٢ خطّافاً في `client/src/hooks/`. |
| **٣٣ صفحة تبني رأسها يدوياً + ١٤ بلا عنوان** | هجرةٌ تدريجية مع كلّ لمسةٍ لاحقة. المكوّن جاهزٌ ومُصحَّح بعد ش٧. |
| **٣ صفحات فقط تمرّر `breadcrumbs`** مقابل ٢٤ مساراً مُعشَّشاً | المكوّن يدعمها منذ البداية؛ الهجرة تدريجية. |
| **سقف عرض القراءة (1440px)** | يُطبَّق على غلافٍ داخل الصفحات المحتاجة، شريحةٌ مستقلّة تستثني POS والكانبان والمتجر. |
| **كثافة شبكة البلاطات على الهاتف** | على عرض 360px ⇒ عمودٌ واحد ⇒ ≈٣ بلاطات مرئية لـ٣٨ وحدة (تمريرٌ ≈٧٢٠٠px). **مسألةٌ حقيقية لم تُحلّ في أيٍّ من الطروحات الثلاثة.** تحتاج صيغةً مضغوطة (صفٌّ بلا ذيل، أو طيّ الأقسام) — شريحةٌ مستقلّة بعد استقرار البلاطة. |

### ٨-ج. معيار «مكتمل»

**لا تُعلَن الحملة مكتملةً بعدد الشاشات المهاجَرة، بل ببلوغ الخمس المرجعية التشريحَ الواحد:** الرئيسية (الإدارية) · الرئيسية (الكاشير) · الفواتير · الكانبان · بطاقة الجوال. وكلّ شريحةٍ في التسلسل **قابلةٌ للدمج وحدها وقابلةٌ للتراجع وحدها**.