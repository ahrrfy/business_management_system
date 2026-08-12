// «كيف تعمل العمولات؟» — شرح مبسَّط مشترك بين شاشات وحدة الأهداف والعمولات الأربع.
//
// لماذا: مصطلحات الوحدة (عتبة/شريحة/قاعدة فعلية/تشغيلة/إسناد/مرحَّل) دقيقة محاسبياً لكنها
// غير مفهومة لمستخدم المتجر. هذا الشريط يشرح الدورة بأربع خطوات + قاموس مصطلحات + مثال
// محلول بالأرقام، مطويّاً افتراضياً كي لا يزاحم الشاشة (الحالة محفوظة لكل متصفّح).
import { useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { BookOpen, ChevronDown, ClipboardList, Target, Calculator, Wallet } from "lucide-react";

const STORAGE_KEY = "commissions.guide.open";

const STEPS = [
  {
    icon: ClipboardList,
    title: "١) الخطة",
    body: "تحدّد كم يستحق البائع مقابل مبيعاته. تُكتب مرّة واحدة وتُربط بعدد من الموظفين.",
  },
  {
    icon: Target,
    title: "٢) الهدف الشهري",
    body: "مبلغ المبيعات المطلوب من الموظف في الشهر. يلزم فقط للخطط التي تحتسب «حسب نسبة تحقيق الهدف».",
  },
  {
    icon: Calculator,
    title: "٣) الاحتساب الشهري",
    body: "في نهاية الشهر يجمع النظام مبيعات كل موظف من الفواتير، يطرح مرتجعاته، ثم يطبّق خطته ويخرج مبلغ عمولته.",
  },
  {
    icon: Wallet,
    title: "٤) الصرف",
    body: "بعد أن يعتمد الاحتسابَ شخصٌ غير الذي احتسبه، يظهر المبلغ بنداً باسم «عمولة» داخل مسيّر رواتب الشهر نفسه.",
  },
] as const;

const GLOSSARY: { term: string; meaning: string }[] = [
  { term: "صافي المبيعات", meaning: "مبيعات الموظف خلال الشهر ناقص مرتجعاته." },
  {
    term: "المبلغ المحتسَب عليه",
    meaning: "صافي المبيعات بعد استثناء حصص بضاعة الأمانة، مضافاً إليه المرحَّل من الشهر السابق. هو المبلغ الذي تُضرب فيه النسبة.",
  },
  { term: "نسبة تحقيق الهدف", meaning: "المبلغ المحتسَب عليه ÷ الهدف الشهري × ١٠٠. مثلاً ٨ ملايين من هدف ١٠ ملايين = ٨٠٪." },
  {
    term: "المستوى (الشريحة)",
    meaning: "درجة في الخطة لها حدّ أدنى ونسبة. يأخذ الموظف نسبة أعلى مستوى بلغه — والنسبة تُحتسب على كامل المبلغ لا على ما زاد عن الحدّ.",
  },
  {
    term: "المرحَّل",
    meaning: "إن زادت المرتجعات على المبيعات صار الشهر بالسالب، فيُنقَل الفارق السالب إلى الشهر القادم بدل إلغائه.",
  },
  { term: "احتساب الشهر (التشغيلة)", meaning: "كشف عمولات شهر واحد لكل الموظفين معاً. يبدأ «مسوّدة» قابلة للتعديل ثم يصير «معتمداً» مقفلاً." },
  { term: "ربط الموظف بالخطة (الإسناد)", meaning: "تحديد الخطة التي يعمل بها الموظف ابتداءً من شهر معيّن. لكل موظف خطة واحدة فعّالة." },
];

export function CommissionGuide() {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });

  function toggle(next: boolean) {
    setOpen(next);
    try {
      localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    } catch {
      /* تخزين محلي معطَّل (وضع خاص) — الشرح يبقى يعمل بلا حفظ تفضيل. */
    }
  }

  return (
    <Collapsible open={open} onOpenChange={toggle}>
      <div className="rounded-lg border bg-accent/30">
        <CollapsibleTrigger
          aria-label={open ? "إخفاء شرح العمولات والأهداف" : "عرض شرح العمولات والأهداف"}
          className="flex w-full items-center gap-2 p-3 text-start text-sm font-medium hover:bg-accent/50 rounded-lg"
        >
          <BookOpen className="size-4 shrink-0 text-primary" aria-hidden />
          <span>كيف تعمل العمولات والأهداف؟ — شرح مبسّط بمثال</span>
          <span className="flex-1" />
          <ChevronDown className={`size-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="space-y-4 border-t p-4 text-sm">
            {/* الدورة بأربع خطوات */}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {STEPS.map((s) => (
                <div key={s.title} className="rounded-md border bg-background p-3">
                  <div className="mb-1 flex items-center gap-2 font-medium">
                    <s.icon className="size-4 shrink-0 text-primary" aria-hidden />
                    {s.title}
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">{s.body}</p>
                </div>
              ))}
            </div>

            {/* مثال محلول */}
            <div className="rounded-md border border-primary/30 bg-background p-3">
              <div className="mb-2 font-medium">مثال محلول</div>
              <p className="text-xs text-muted-foreground">
                خطة «مبيعات المعرض» بمستويين: من ٧٠٪ من الهدف ⇒ ١٪ · من ١٠٠٪ ⇒ ٢٪ + مكافأة ثابتة ٥٠٬٠٠٠ د.ع.
                موظف هدفه ١٠٬٠٠٠٬٠٠٠ د.ع، باع خلال الشهر ١٢٬٠٠٠٬٠٠٠ ورجع عليه ٢٬٠٠٠٬٠٠٠.
              </p>
              <ol className="mt-2 space-y-1 text-xs">
                <li>
                  <span className="text-muted-foreground">صافي المبيعات = </span>
                  <span className="tabular-nums" dir="ltr">12,000,000 − 2,000,000 = 10,000,000</span>
                </li>
                <li>
                  <span className="text-muted-foreground">نسبة تحقيق الهدف = </span>
                  <span className="tabular-nums" dir="ltr">10,000,000 ÷ 10,000,000 = 100%</span>
                </li>
                <li>
                  <span className="text-muted-foreground">المستوى المطبَّق = </span>
                  الثاني (من ١٠٠٪) ⇒ ٢٪ + ٥٠٬٠٠٠
                </li>
                <li>
                  <span className="text-muted-foreground">العمولة = </span>
                  <span className="font-bold tabular-nums text-money-positive" dir="ltr">
                    10,000,000 × 2% = 200,000 + 50,000 = 250,000
                  </span>
                  <span className="text-muted-foreground"> د.ع</span>
                </li>
              </ol>
              <p className="mt-2 text-xs text-muted-foreground">
                انتبه: النسبة تُضرب في <span className="font-medium text-foreground">كامل</span> المبلغ المحتسَب عليه، لا في الجزء الزائد عن حدّ المستوى فقط.
              </p>
            </div>

            {/* قاموس المصطلحات */}
            <div>
              <div className="mb-2 font-medium">معاني المصطلحات</div>
              <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                {GLOSSARY.map((g) => (
                  <div key={g.term} className="text-xs">
                    <dt className="font-medium">{g.term}</dt>
                    <dd className="text-muted-foreground">{g.meaning}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
