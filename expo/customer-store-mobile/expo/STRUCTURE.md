# هيكل المشروع

```text
customer-store-mobile/
├── app/                  # مسارات Expo Router والشاشات
│   ├── (tabs)/            # الرئيسية، التصنيفات، السلة، الطلبات، الحساب
│   ├── checkout.tsx       # إتمام الطلب وTurnstile
│   ├── product/[id].tsx   # تفاصيل المنتج
│   ├── verify-phone.tsx   # تحقق الهاتف وOTP
│   └── wishlist.tsx       # المفضلة والمشاركة
├── components/            # بطاقات المنتج، حقل هاتف العراق، السلة الجانبية، UI
├── lib/                   # عقود API، السلة، جلسة العميل، Firebase، التسعير
├── tests/                 # Vitest لعقود السلة والتسعير والهاتف وFirebase
├── assets/images/         # الأيقونة وSplash وأصول الهوية
├── docs/                  # التحقيقات وسجلات الجودة وعمليات التشغيل
├── expo/                  # هذا الدليل التشغيلي
├── app.config.ts          # هوية Expo ومعرفات iOS/Android وملفات Firebase
├── eas.json               # ملفات تعريف APK وiOS الداخلي وAAB
└── todo.md                # سجل تاريخي للبنود المنجزة والمعلقة
```

## طبقات الوظيفة

| الطبقة | الملفات المحورية | المسؤولية |
|---|---|---|
| التنقل والواجهة | `app/`, `components/` | صفحات RTL، التفاعل، حالة التحميل والأخطاء. |
| التجارة | `lib/cart-context.tsx`, `components/product-card.tsx` | الكميات، السلة، تأكيد الإضافة، التسعير المرئي. |
| الربط | `lib/storefront-api.ts` | طلبات الكتالوج والكتابة المحمية وعقد ترويسات العميل الأصلي. |
| هوية العميل | `lib/customer-session.ts`, `lib/secure-store-keys.ts` | جلسة العميل المتحقق منها ومفاتيح التخزين الآمن. |
| الهاتف | `lib/iraqi-phone.ts`, `components/iraqi-phone-input.tsx` | تطبيع الرقم العراقي وإدخال LTR داخل RTL. |
| Firebase | `lib/firebase-phone-auth.native.ts`, `GoogleService-Info.plist` | Phone OTP في البناء الأصلي فقط. |
| الجودة | `tests/`, `docs/forensics/` | عقود الانحدار، سجل أدلة واختبارات جهاز. |

## حدود المسؤولية

تطبيق العملاء لا يقرأ صلاحيات إدارية ولا يتصل بقاعدة البيانات مباشرة. كل بيانات التجارة تمر عبر API المتجر العامة والعقود الخادمية المتخصصة. التغييرات في `lib/storefront-api.ts` أو عقود الخادم تتطلب اختباراً حياً قبل اعتمادها.
