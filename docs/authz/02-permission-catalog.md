# 2 · كتالوج الصلاحيات الذرية (Permission Catalog)

> §30.2 — «الكتالوج الذري الأولي مع ملاك المجالات».
> **الحالة: مسودّة آلية تحتاج اعتماد ملاك المجالات** (بوابة خروج المرحلة 2، §23).
> الاشتقاق الكامل في عمود `proposedPermission` في [`endpoint-inventory.csv`](endpoint-inventory.csv).

## 2.1 الصيغة

`domain.resource.action` — مطابقة §10.1. لا يُدخَل في الكود: اسم الدور، الفرع، مبلغ، نسبة،
نافذة زمنية، حالة MFA، شرط SQL (§10.3).

## 2.2 الحصيلة الأولية

**561 صلاحية ذرية مقترحة** مشتقّة من 671 نقطة دخول، عبر **28 مجالاً**.

الفارق (110) هو نقاط تتشارك الصلاحية نفسها — وهو **مقصود ومسموح** بـ§10.5 («يمكن أن تحمي صلاحية
واحدة عدة نقاط دخول إذا كانت تؤدي الأثر التجاري نفسه»)، لكن **كل تشارك يجب أن يُراجَع يدوياً**:
تشاركٌ خاطئ = توسّع صلاحيات. مثال يجب فضّه: `recruitment.openVacancies` (قراءة عامة) و
`recruitment.submit` (كتابة PII) يشتقّان اليوم الكود نفسه.

## 2.3 المجالات المقترحة (28)

| المجال | الصلاحيات | مالك المجال المقترح | ملاحظة |
|---|---:|---|---|
| `hr` | 75 | مسؤول الموارد البشرية | **الأعلى حساسية** (رواتب + PII) وأكبر كتلة بوّابات لامركزية |
| `inventory` | 60 | أمين المخزن + المدير | يشمل الجرد وبوابة العدّ |
| `reports` | 58 | المحاسب + المدير | خط §٦ الأحمر: التكلفة/الربح |
| `treasury` | 58 | المحاسب + المالك | سندات/ورديات/تحويلات/بطاقات |
| `catalog` | 54 | مدير الكتالوج | منتجات/باقات/موجات أسعار/صور |
| `iam` | 39 | مالك المنظومة | مستخدمون/أدوار/مصادقة |
| `admin` | 36 | مالك المنظومة | إعدادات/فروع/تكاملات/نسخ/استيراد |
| `store` | 36 | مدير المتجر | |
| `sales` | 34 | مدير المبيعات | يشمل POS والأوفلاين وتسعير الطباعة |
| `crm` | 30 | مدير المبيعات | |
| `marketing` | 26 | مدير الحملات | |
| `purchasing` | 24 | مسؤول المشتريات | |
| `commissions` | 17 | المدير + المحاسب | |
| `assets` | 15 | المحاسب | |
| `tasks` | 13 | مدير العمليات | |
| `delivery` | 12 | مدير العمليات | |
| `kiosk` | 11 | مدير المتجر | Principal جهاز |
| `storefront` | 11 | مدير المتجر | Principal مجهول |
| `workorders` | 11 | فني المطبعة + المدير | |
| `channels` | 10 | مدير القنوات | |
| `gifts` | 9 | المدير | |
| `platform` | 8 | مالك المنصّة | **حدّ ثقة منفصل** |
| `ar` | 7 | المحاسب | ذمم/أقساط/ائتمان |
| `accounting` | 5 | المحاسب | إقفال فترة/سنة/حسابات |
| `reservations` | 5 | مدير المبيعات | |
| `consignment` | 4 | المحاسب + المخزن | |
| `audit` | 2 | مسؤول الأمن/التدقيق | **مالكه ≠ مالك `iam`** (§22.4) |
| `search` | 1 | — | البحث الشامل: يرث صلاحية كل نوع |

## 2.4 قواعد الاشتقاق المطبَّقة

**الأفعال** (§10.2) — تُشتقّ من اسم النقطة: `list`, `view`, `create`, `update`, `delete`, `approve`,
`reject`, `void`, `reverse`, `refund`, `close`, `reopen`, `import`, `export`, `download`, `print`,
`send`, `authenticate`, `logout`, `revoke`. أي اسم لا يطابق يبقى **فعل أعمال خاصاً** كما هو
(§10.2 الفقرة الأخيرة) ويُراجَع.

**قواعد مُلزِمة عند التنقيح اليدوي:**

1. **لا حذف نهائيّ في السجلات المالية** (§10.2). كل `*.delete` مقترح على كيان ماليّ يُحوَّل إلى
   `void` / `reverse` / `archive`. الجرد يُظهر 18 نقطة `delete`/`remove` — تُصنَّف واحدةً-واحدةً.
2. **`list` لا يشمل `view` ولا العكس** (لا اشتمال ضمنيّ، §8.5).
3. **الإرسال/الطباعة/التصدير صلاحيات مستقلّة** لا تحت قراءة (§10.5، §29.12).
4. **الاعتماد/الإلغاء/العكس** لا تحت تعديل عام (§10.5).

## 2.5 الصلاحيات الحسّاسة الأولية (مرشّحة لـMFA + SoD + تدقيق إلزاميّ)

**76 نقطة** موسومة `SENSITIVE_ACTION`. الأعلى خطراً — للاعتماد من مالك المخاطر:

| الصلاحية المقترحة | النقطة الحالية | البوّابة اليوم | الخطر |
|---|---|---|---|
| `admin.system.reset` | `systemRouter.resetSystem` | `adminProcedure` | **مسح بيانات** |
| `admin.system.delete_backup` | `systemRouter.deleteBackup` | `adminProcedure` | فقد قدرة استعادة |
| `accounting.year_end.close` | `yearEndRouter.close` | `adminProcedure` | إقفال ماليّ |
| `accounting.period_lock.reopen` | `periodLockRouter.unlock` | `adminProcedure` | فتح فترة مقفلة |
| `iam.user.reset_password` · `.reset_two_factor` | `userRouter.*` | `adminProcedure` | استيلاء على حساب |
| `iam.role.delete` | `roleRouter.remove` | `adminProcedure` | تغيير سلطة |
| `treasury.voucher.approve` | `voucherRouter.approve` | `treasuryManagerProcedure` | صرف نقديّ |
| `inventory.stocktake.approve` · `.cancel` | `stocktakeRouter.*` | `managerProcedure` / `adminProcedure` | تسوية مخزون |
| `delivery.consignment.write_off` | `deliveryRouter.writeOff` | `managerProcedure` (raw-role) | شطب عهدة |
| `delivery.consignment.settle` | `deliveryRouter.settle` | `cashierProcedure` (raw-role) | تسوية نقدية |
| `crm.customer.delete` · `purchasing.supplier.delete` | `*.delete` | `managerProcedure` (raw-role) | حذف طرف ماليّ |
| `admin.integration.delete` | `integrationRouter.delete` | `adminProcedure` | قطع تكامل |
| `reports.*.export` | تقارير متعددة | متفاوتة | **تسريب بالجملة** |

## 2.6 بيانات تعريف الصلاحية (§10.4) — المخطط المطلوب

كل سجلّ صلاحية عند الاعتماد يحمل: `code` (ثابت فريد) · `domain` · `resource` · `action` ·
`label_ar` · `description_ar` · `owner` · `sensitivity` (LOW/MEDIUM/HIGH/CRITICAL) ·
`effect_class` (read / write / external) · `requires_mfa` · `mfa_max_age_sec` · `in_sod` ·
`audit_level` · `lifecycle` (active / deprecated / retired) · `version` · `created_at`.

**قاعدة حاكمة (§10.4):** تغيير معنى صلاحية جوهرياً ⇒ **كود جديد أو إصدار جديد**، لا تغيير صامت.

## 2.7 ما لا يدخل الكتالوج

- `FULL/READ/NONE` — ليست صلاحيات بل مستويات وحدة قديمة (§29.3: لا تُحذف بياناتها قبل نجاح
  الانتقال، لكنها لا تدخل الكتالوج الجديد قيمةً تنفيذية).
- أسماء الأدوار الأحد عشر — حزم إدارية (§11.1).
- `isOwner` — عَلَم تجاوز، **ليس صلاحية**؛ مصيره قرار مالك (ح-١).
- `canSeeCost` — يُفكَّك إلى `reports.cost.view` + قيود حقول (§13.2)، لا يبقى دالّة على اسم الدور.

## 2.8 بوابة الخروج (§23-المرحلة 2)

- [ ] كل نقطة حسّاسة مرتبطة بصلاحية ثابتة
- [ ] لا wildcard ولا فعل حسّاس مدفون داخل قراءة أو تعديل عام
- [ ] كل تشارك صلاحية بين نقطتين مُعلَّل ومُوثَّق
- [ ] الكتالوج معتمد من كل مالك مجال (28 توقيعاً)
- [ ] الـ18 نقطة `delete` مُصنَّفة (حذف صلب مبرَّر ⇔ `void`/`reverse`/`archive`)
