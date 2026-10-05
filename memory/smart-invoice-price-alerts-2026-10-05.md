# ذاكرة تنبيهات الأسعار الذكية في سطور فاتورة البيع المتقدمة

**التاريخ:** ٥ أكتوبر ٢٠٢٦  
**طلب السحب:** [PR #1401](https://github.com/ahrrfy/business_management_system/pull/1401)  
**الالتزام المدموج في `main`:** `e113b44f` (squash)  
**الحالة:** ✅ مدموج ومنشور على الإنتاج بـ `pnpm prod:deploy` (٢٥١٫٧ ث، بلا هجرات)؛ رأس الإنتاج = `e113b44f`، والواجهة تردّ ٢٠٠.

---

## ١. الطلب
إدخال «ذكاء» في حقول فواتير البيع والشراء المتقدمة: تنبيه الموظف بآخر سعر بيع لهذا العميل وما شابه. المنفَّذ فعلاً هو **جانب البيع** (`/sales/new`)؛ الشراء لم يُمسّ.

## ٢. ما بُني
- `shared/priceAlerts.ts` — مقيِّم نقيّ بـ `decimal.js`: `evaluateSalePriceAlerts` و`pickReferenceSale` و`daysSince` و`PRICE_ALERT_THRESHOLDS` (١٪ مساوٍ، ٥٪ تنبيه، ١٥٪ تنبيه قوي).
- `server/services/pricing/lineInsights.ts` — `getSaleLineInsights(db, …)`: آخر ≤٣ مبيعات لكل (صنف × وحدة) للعميل بنافذة `row_number()`؛ تستبعد `VOIDED_INVOICE_STATUSES` والهدايا والأسعار الصفرية، وتُبقي المُرتجَع؛ تُرجع السعر/التاريخ/رقم الفاتورة/الخصم الفعلي فقط — **لا تكلفة ولا هامش**.
- `server/routers/saleRouter.ts` — `sales.lineInsights` (query) على `salesCorrectionProcedure` (سابقة `lookupForCorrection`)، يمرّر `ctx.scopedBranchId/scopedOwnerId` إلى الخدمة.
- `client/src/components/invoice/useSaleLineInsights.ts` (جلب مجمَّع واحد) و`LinePriceHints.tsx` (`SaleLastPriceHints`, `ContractPriceHint`, `PurchaseInsightHints` منقولة حرفياً من `ProductTable`) وربطها في `ProductTable.tsx`.
- **تلميح السعر التعاقدي:** من حالة السطر نفسها (`priceSource==="CONTRACT"` و`referencePrice`) — شارة «سعر تعاقدي»، وإن عُدّل السعر تنبيه + زر «استعد». لا استعلام جديد.
- الاختبارات: ٢٦ وحدة (`shared/__tests__/priceAlerts.test.ts`، `client/.../__tests__/linePriceHints.test.tsx`، مسجَّلة في `vitest.unit.config.ts`) + ٩ اختبارات قاعدة (`server/services/__tests__/lineInsights.test.ts`).

## ٣. قرارات وحقائق مُتحقَّقة (لا تُعاد إلا بدليل)
- **إرشادي فقط:** لا يمنع الحفظ. المانع الوحيد لبيع تحت التكلفة هو بوّابة الخادم `priceOverrideApproved` (`server/services/sale/create.ts` ~٩٦١) وهي على مستوى الفاتورة.
- **تنبيه الهامش/تحت التكلفة حُذف عمداً:** عمود «هامش%» الملوّن موجود أصلاً في `ProductTable`.
- **النطاق:** غير المحصور (مدير/أدمن) يرى كل مبيعات العميل عبر الشركة؛ المحصور بفرع/موظف يرى ضمن نطاقه فقط. لذلك نصّ حالة الغياب «لا بيع سابق **ظاهر لك**…» لا «أول بيع».
- **مقارنة بنفس وحدة الصفّ فقط** (`productUnitId`).
- **`invoiceItems.unitCost` لكل وحدة أساس**، و`discountAmount` للسطر = إجمالي خصم السطر (كمية × خصم الوحدة)؛ لذا الخصم الفعلي = `discountPercent` إن >٠ وإلا `discountAmount ÷ (سعر × كمية)`.
- **سعر الشراء `purchaseOrderItems.unitPrice` بالدينار دائماً** (سعر الدولار في `usdUnitPrice` و`agreedRate`) — لا خلط عملة في `PurchaseInsightHints` (ادّعاء مراجع رُفض بدليل `drizzle/schema.ts:5262` و`purchase/order.ts:228-243`).
- **أسطر التصحيح لا تحمل `priceSource/referencePrice`** (تُبنى في `SalesInvoiceNew` بلا هما) فلا يظهر لها تلميح تعاقدي مضلِّل.
- الفاتورة قيد التصحيح تبقى CONFIRMED حتى الحفظ ⇒ تُستثنى بـ `excludeInvoiceId`.

## ٤. مراجعة Codex (٥ ملاحظات P2 — عولجت كلها في `41604949` قبل الدمج)
خصم بمبلغٍ كان يظهر «بلا خصم»؛ كاش ٦٠ث يُخفي بيعاً حُفظ للتوّ (`staleTime: 0` و`settled` تُصبح false أثناء إعادة الجلب)؛ قصّ ٢٠٠ مفتاح كان يُظهر «أول بيع» لما لم يُطلب (`covered`)؛ نصّ «أول بيع» المطلق؛ إخفاء المرجع وزرّ «استخدم» عند السعر الفارغ.

## ٥. دروس تشغيلية
- حارس `check:message-drift` يربط نصّاً يفحصه اختبار بنصّ المكوّن: تغيير نصّ تلميحٍ يلزمه تحديث نمط الاختبار **ولا يُبقى نمط قديم يشير إلى النصّ المحذوف** (أسقط pre-commit مرّة).
- دمج `main`: ظهر `BLOCKED` رغم CI أخضر وفيه ٥ محادثات مراجعة غير محلولة، ثم صار `CLEAN` بعد معالجتها وحلّها وإعادة CI على الالتزام الجديد (`strict` يشترط فرعاً محدَّثاً). **لم يُفحَص أيّهما السبب الفعليّ** — الحماية الكلاسيكية لا تُظهر شرط حلّ المحادثات؛ حلّ المحادثات بـ`gh api graphql` مع `resolveReviewThread`.
- على ويندوز: `pnpm exec vitest` يفشل بـ `ERR_PACKAGE_IMPORT_NOT_DEFINED #module-evaluator` لتجاوز المسار ٢٦٠ حرفاً في worktrees الطويلة؛ الحل: `node <المستودع الرئيسي>\node_modules\vitest\vitest.mjs run …` من مجلد الـ worktree مع `TZ=UTC`.
- النشر: `ssh alroya-erp "sudo -iu deploy bash -lc 'cd /home/deploy/erp && pnpm prod:deploy'"`؛ يعيد رمز خروج ١ في PowerShell بسبب stderr رغم نجاحه — الحَكَم سطر «✓ اكتمل النشر».

## ٦. غير منفَّذ (مرشّحات لاحقة)
- ذكاء الشراء: نسبة التغيّر عن آخر شراء، زر «استخدم آخر سعر»، مقارنة مع WAVG الحالي (الكلفة الحالية متاحة على سطر الشراء كـ`costBase`).
- مقارنة بين وحدات مختلفة (سعر لكل وحدة أساس) بوسم «من وحدة أخرى».
- `COST_DRIFT` (تغيّر التكلفة منذ آخر بيع) — يلزم إرجاع تكلفة من الخادم **لمن يرى التكلفة فقط** (`canSeeCostForUser`) مع تحويل الوحدة الأساس إلى وحدة الصفّ.
- حصر نطاق قناة الاستقبال/الطباعة (`invoiceCorrectionScope`) على الاستعلام — لم يُطبَّق.
- جولة بصرية في المتصفح على `/sales/new` — **لم تُنفَّذ** (التحقق بالاختبارات وCI فقط).
- `/seo` لا ينطبق على شاشات ERP خلف تسجيل الدخول؛ إن قُصد المتجر الإلكتروني فهو عمل مستقل.
