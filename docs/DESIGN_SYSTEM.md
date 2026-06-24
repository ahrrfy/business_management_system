# نظام التصميم البصري — الرؤية العربية ERP

> **مصدر الحقيقة للهوية البصرية.** الهدف: شاشة واحدة متّسقة عبر النظام كلّه — لا «صفحة تخترع تنسيقها». اقرأه قبل بناء/تعديل أي شاشة. كل انحراف عنه = دَين بصري.

نظام عربي **RTL**، عملة **IQD** (بلا كسور)، خط **Cairo**. الفلسفة: هدوء بصري لساعات عمل طويلة (§٢.٤ من خطة UX) — ألوان دلالية هادئة لا فاقعة، والرقم هو البطل في لوحات المؤشّرات.

---

## ١. الطبقات (مصدر التوكنز)

| الطبقة | الملف | المحتوى |
|---|---|---|
| توكنز الهوية (shadcn) | [`client/src/index.css`](../client/src/index.css) | `--primary` (بنفسجي/أزرق)، `--background/--card/--border/--muted/--ring`، `--radius` (0.625rem)، خط Cairo، RTL، وضع داكن، دفاعات a11y |
| التوكنز الدلالية | [`client/src/lib/theme/tokens.css`](../client/src/lib/theme/tokens.css) | حالات الأعمال: `--money-positive/negative`، `--stock-ok/low/out`، `--status-pending/active/done/cancelled`، ألوان الرسوم، لوحات dash/pos + **أصناف utility جاهزة** |

**القاعدة الحاكمة:** الألوان من التوكنز فقط. **ممنوع** كتابة `bg-emerald-100`/`text-rose-700`/`bg-slate-100`/`border-gray-200` خاماً في الصفحات — تكسر الهوية والوضع الداكن معاً.

---

## ٢. الألوان الدلالية (الاستبدال القانوني)

التوكنز الدلالية موجودة كأصناف utility في `tokens.css` وتعمل في الوضعين تلقائياً. **استعملها بدل الألوان الخام.**

| القصد | ❌ الخام (ممنوع) | ✅ القانوني |
|---|---|---|
| نجاح/موجب | `bg-emerald-100 text-emerald-700` | `<Badge variant="success">` · `text-money-positive` · `badge-status-active` |
| تحذير/منخفض | `bg-amber-100 text-amber-700` | `<Badge variant="warning">` · `text-stock-low` · `badge-stock-low` |
| خطر/سالب | `bg-rose-100 text-rose-700` | `<Badge variant="danger">` · `text-money-negative` · `badge-stock-out` |
| معلومة/قيد الانتظار | `bg-blue-100 text-blue-700` | `<Badge variant="info">` · `badge-status-pending` |
| محايد/ملغى | `bg-gray-100 text-gray-500` | `<Badge variant="neutral">` · `badge-status-cancelled` · `text-muted-foreground` |

شارات الحالة الجاهزة في tokens.css: `badge-stock-ok/low/out`، `badge-status-pending/active/done/cancelled`.
نصوص المبالغ: `text-money-positive` (دائن لنا) · `text-money-negative` (مدين علينا) · `text-money-neutral`.

---

## ٣. الطباعة (Typography)

- الخط: **Cairo** (مُحمَّل عالمياً، لا تُعِد تعريفه).
- العنوان الرئيسي للصفحة: `text-2xl font-bold` (عبر `<PageHeader>` — لا تكتبه يدوياً).
- عنوان بطاقة: `CardTitle` غالباً `text-base`.
- النصّ الأساسي: المقاس الافتراضي (16px)؛ الثانوي `text-sm text-muted-foreground`؛ الدقيق `text-xs`.
- **الأرقام والمبالغ:** دائماً `tabular-nums` + `dir="ltr"` (تمنع اهتزاز الأعمدة وتعرض الأرقام صحيحة في RTL).

---

## ٤. التباعد والبنية (Spacing & Layout)

- المحتوى داخل `<main>` بحشوة `p-3 md:p-6` (من `AppLayout` — لا تكرّرها في الصفحة).
- جذر الصفحة: `<div className="space-y-4">` (التباعد الرأسي القياسي بين الأقسام).
- الشبكات: `gap-3` للمؤشّرات، `gap-4` للبطاقات الكبيرة. سلّم التباعد بمضاعفات 4.
- شبكة المؤشّرات القياسية: `grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3`.
- بلا `max-width` مخصّص في الصفحات — العرض يحكمه `AppLayout` (إلا نماذج الإدخال الضيّقة: `max-w-2xl`).

---

## ٥. المكوّنات القانونية (استعملها — لا تُعِد اختراعها)

| المكوّن | الملف | الغرض |
|---|---|---|
| `PageHeader` | `components/PageHeader.tsx` | رأس صفحة: عنوان + وصف + إجراءات + **مسار تنقّل اختياري** (`breadcrumbs` — للشاشات التفصيلية) |
| `StatCard` | `components/StatCard.tsx` | بطاقة مؤشّر KPI («الرقم هو البطل») |
| `LoadingState` / `ErrorState` / `TableEmptyRow` / `TableSkeleton` | `components/PageState.tsx` | حالات التحميل/الخطأ/الصفّ الفارغ + **صفوف هيكلية للجداول** |
| `EmptyState` | `components/EmptyState.tsx` | حالة فارغة كاملة بنّاءة (أيقونة+عنوان+CTA) |
| `Badge` (success/warning/danger/info/neutral) | `components/ui/badge.tsx` | شارات الحالة الدلالية |
| `ListToolbar` / `SelectionBar` / `DataTable` | `components/` | شريط أدوات القوائم + التحديد المتعدّد + الجداول (`DataTable` يدعم `loading` ⇒ تحميل هيكلي) |
| `Button` / `Card` / `Table` | `components/ui/` | لا تبنِ `<button>`/`<table>` خاماً منسّقاً يدوياً |

### قالب صفحة قائمة قياسي

```tsx
export default function Customers() {
  const q = trpc.customers.list.useQuery(/* … */);
  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState message={q.error.message} onRetry={() => q.refetch()} />;

  return (
    <div className="space-y-4">
      <PageHeader
        title="العملاء"
        description="إدارة العملاء وأرصدتهم"
        actions={<Button size="sm" onClick={() => navigate("/customers/new")}>+ عميل جديد</Button>}
      />
      {/* ListToolbar / DataTable … */}
      {rows.length === 0 && <EmptyState title="لا عملاء بعد" actionLabel="أضف أوّل عميل" actionHref="/customers/new" />}
    </div>
  );
}
```

---

## ٦. حالات العناصر وإمكانية الوصول (مضمونة في الأساس)

- **التركيز:** `:focus-visible` يرسم حلقة `--ring` تلقائياً (دفاع a11y في `index.css`) — لا تُسقط `outline`.
- **النقر:** كل عنصر تفاعلي يحصل على `cursor-pointer` تلقائياً (قاعدة base).
- **الحركة المُقلَّلة:** `prefers-reduced-motion` محترمة عالمياً.
- **التباين:** نصوص ≥ 4.5:1؛ استعمل `text-muted-foreground` لا `opacity-70` (الأخير يكسر WCAG — استعمل `--strong-muted` عند الحاجة).
- **اللون ليس الدليل الوحيد:** اقرن لون الحالة بنصّ/أيقونة دائماً.
- **هدف اللمس:** ≥ 44px للعناصر التفاعلية على الموبايل.

---

## ٧. للمصمّمين القادمين (كنس التوحيد)

عند تمرير شاشة للتوحيد، طبّق بالترتيب:
1. لُفّ الأعلى بـ`<PageHeader>` (احذف h1 اليدوي والـpadding المكرّر).
2. استبدل كل لون خام بالتوكن/الشارة الدلالية المقابلة (جدول §٢).
3. استبدل `جارٍ التحميل…` بـ`<LoadingState>`، ورسالة الخطأ بـ`<ErrorState>`، وصفّ «لا بيانات» بـ`<TableEmptyRow>` أو `<EmptyState>`.
4. وحّد بطاقات المؤشّرات على `<StatCard>` (احذف النسخ المحلّية في Attendance/Payroll/assets/Treasury).
5. تأكّد: `space-y-4` على الجذر، `tabular-nums`+`dir="ltr"` على الأرقام، بلا `max-width` مخصّص.

**معيار القبول:** بحث `bg-(emerald|amber|rose|blue|slate|gray|green|red)-\d` في الصفحة = صفر **شارة/نصّ حالة** خام.

---

## ٨. استثناءات مشروعة (ليست انتهاك هوية)

ليست كل الألوان «الخام» خطأً. تُترَك هذه عمداً لأنها **دلالة غير حالة** بلا توكن مطابق:

- **تدرّج/مقياس رسم بياني:** سلال أعمار الذمم (`ARAging`/`APAging`)، مقاييس gauge، تصوّر WAVG (قبل→يُضاف→بعد) — مقياس متدرّج لا شارة حالة منفصلة.
- **تصنيف فئوي (categorical):** خريطة ألوان الأدوار في `Users` (٩ أدوار بألوان مميّزة) — ترميز تصنيفي لا «نجاح/خطر». تحويله لتوكن حالة خطأ دلالي.
- **لكنات روابط/معلومة:** `text-sky-700` على روابط الأفعال (تعديل/فتح) أو أرقام الكلفة الإعلامية — لا يوجد توكن `info-accent`/`link` بعد (تحسين مشترك مستقبلي محتمل).
- **تظليل صفّ خافت:** `bg-amber-50/50` لإبراز صفّ منخفض المخزون — أصناف `badge-*` تقلب خلفية الصفّ كاملاً وتكسر الإبراز الخفيف.

**شاشات مستبعَدة من الكنس الآلي** (مربوطة بتوكنز خاصّة أو عالية الخطورة — تُراجَع يدوياً): `POS`/`PointOfSale`/`PrintPOS`/`Kiosk`/`CountPortal`/`Reception` (عائلة الكاشير/الكشك، توكنز `pos-*`)، `Dashboard`/`ExecutiveDashboard` (توكنز `dash-*`)، `StocktakeReview` (شاشة معقّدة كبيرة)، و`InvoiceDetail`/`QuotationDetail`/`WorkOrderDetail` (وُحِّدت سابقاً في PR #58).
