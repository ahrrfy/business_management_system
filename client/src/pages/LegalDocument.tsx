import React, { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  FileText,
  ShieldCheck,
  Trash2,
  RotateCcw,
  ArrowRight,
  CheckCircle2,
  Loader2,
  Phone,
  Store,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { TurnstileWidget } from "@/components/storefront/TurnstileWidget";

function normalizeIraqiMobileInput(raw: string): string | null {
  const ascii = raw
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  const digits = ascii.replace(/\D/g, "");
  if (digits.startsWith("00964") && digits.length === 15) {
    const candidate = `0${digits.slice(5)}`;
    return /^07\d{9}$/.test(candidate) ? candidate : null;
  }
  if (digits.startsWith("964") && digits.length === 13) {
    const candidate = `0${digits.slice(3)}`;
    return /^07\d{9}$/.test(candidate) ? candidate : null;
  }
  if (digits.startsWith("7") && digits.length === 10) {
    return `0${digits}`;
  }
  return /^07\d{9}$/.test(digits) ? digits : null;
}

export default function LegalDocument() {
  const [location] = useLocation();
  const [phone, setPhone] = useState("");
  const [reason, setReason] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [submissionResult, setSubmissionResult] = useState<{
    requestNumber: string;
    retentionDays: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isPrivacy = location.includes("privacy");
  const isTerms = location.includes("terms");
  const isReturns = location.includes("returns");
  const isDeletion = location.includes("delete-account");

  const settingsQ = trpc.storefront.settings.useQuery(undefined, {
    enabled: isDeletion,
    staleTime: 5 * 60 * 1000,
  });
  const turnstileSiteKey = settingsQ.data?.turnstileSiteKey ?? null;

  const requestDeletionM = trpc.storefront.requestAccountDeletion.useMutation({
    onSuccess: (res) => {
      setError(null);
      setSubmissionResult({
        requestNumber: res.requestNumber,
        retentionDays: res.retentionDays,
      });
    },
    onError: (err) => {
      setTurnstileToken(null);
      setTurnstileResetKey((k) => k + 1);
      setError(err.message || "تعذّر إرسال طلب حذف الحساب — حاول مجدداً.");
    },
  });

  const handleSubmitDeletion = (e: React.FormEvent) => {
    e.preventDefault();
    if (settingsQ.isLoading) {
      setError("جارٍ التحقق من إعدادات الحماية الأمنية، يرجى الانتظار لحظة ثم المحاولة.");
      return;
    }
    const normalizedPhone = normalizeIraqiMobileInput(phone);
    if (!normalizedPhone) {
      setError("يرجى إدخال رقم هاتف عراقي صالح يبدأ بـ 07");
      return;
    }
    if (turnstileSiteKey && !turnstileToken) {
      setError("يرجى إكمال التحقق الأمني قبل إرسال طلب الحذف.");
      return;
    }
    setError(null);
    const trimmedReason = reason.trim();
    requestDeletionM.mutate({
      phone: normalizedPhone,
      reason: trimmedReason ? trimmedReason.slice(0, 500) : undefined,
      turnstileToken: turnstileSiteKey ? turnstileToken : undefined,
    });
  };

  return (
    <div dir="rtl" className="min-h-screen bg-[#f5f5f7] text-[#1d1d1f] dark:bg-slate-950 dark:text-slate-100">
      {/* رأس الصفحة العام */}
      <header className="sticky top-0 z-20 border-b border-slate-900/[0.08] bg-white/80 backdrop-blur-xl dark:border-slate-800 dark:bg-slate-900/80">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-4">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-xl bg-[#1d1d1f] text-white dark:bg-white dark:text-[#1d1d1f]">
              <Store className="size-5" />
            </span>
            <div>
              <div role="heading" aria-level={1} className="text-base font-extrabold text-[#1d1d1f] dark:text-white">
                مكتبة العربية للطباعة والقرطاسية
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                شركة الرؤية العربية للتجارة العامة — العراق
              </p>
            </div>
          </div>
          <Link
            href="/store"
            className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-bold text-[#1d1d1f] transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
          >
            <ArrowRight className="size-3.5" />
            العودة للمتجر
          </Link>
        </div>
      </header>

      {/* الروابط العلوية السريعة */}
      <nav className="border-b border-slate-900/[0.06] bg-white/60 dark:border-slate-800 dark:bg-slate-900/60">
        <div className="mx-auto flex max-w-4xl gap-2 overflow-x-auto px-4 py-2.5 text-xs font-bold">
          <Link
            href="/legal/privacy"
            className={`rounded-full px-3.5 py-1.5 transition-colors ${
              isPrivacy
                ? "bg-[#1d1d1f] text-white dark:bg-white dark:text-[#1d1d1f]"
                : "text-slate-600 hover:bg-white hover:text-[#1d1d1f] dark:text-slate-300"
            }`}
          >
            سياسة الخصوصية
          </Link>
          <Link
            href="/legal/terms"
            className={`rounded-full px-3.5 py-1.5 transition-colors ${
              isTerms
                ? "bg-[#1d1d1f] text-white dark:bg-white dark:text-[#1d1d1f]"
                : "text-slate-600 hover:bg-white hover:text-[#1d1d1f] dark:text-slate-300"
            }`}
          >
            شروط الاستخدام
          </Link>
          <Link
            href="/legal/returns"
            className={`rounded-full px-3.5 py-1.5 transition-colors ${
              isReturns
                ? "bg-[#1d1d1f] text-white dark:bg-white dark:text-[#1d1d1f]"
                : "text-slate-600 hover:bg-white hover:text-[#1d1d1f] dark:text-slate-300"
            }`}
          >
            سياسة الاسترجاع
          </Link>
          <Link
            href="/legal/delete-account"
            className={`rounded-full px-3.5 py-1.5 transition-colors ${
              isDeletion
                ? "bg-[#b43d31] text-white"
                : "text-slate-600 hover:bg-white hover:text-[#1d1d1f] dark:text-slate-300"
            }`}
          >
            طلب حذف الحساب والبيانات
          </Link>
        </div>
      </nav>

      {/* المحتوى الرئيسي */}
      <main className="mx-auto max-w-4xl px-4 py-8">
        {/* سياسة الخصوصية */}
        {isPrivacy && (
          <article className="space-y-6 rounded-2xl border border-slate-900/[0.08] bg-white p-6 shadow-xs md:p-8 dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center gap-3 border-b border-slate-100 pb-4 dark:border-slate-800">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-[#eff6ff] text-[#1e3a8a] dark:bg-blue-950/60 dark:text-blue-400">
                <ShieldCheck className="size-6" />
              </span>
              <div>
                <h2 className="text-xl font-black text-[#1d1d1f] dark:text-white">
                  سياسة الخصوصية وحماية البيانات
                </h2>
                <p className="text-xs text-slate-500">
                  تطبيق وموقع «مكتبة العربية» — متوافقة مع إرشادات Google Play و App Store
                </p>
              </div>
            </div>

            <section className="space-y-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              <h3 className="font-bold text-[#1d1d1f] dark:text-white">1. من نحن</h3>
              <p>
                تطبيق وموقع «مكتبة العربية» هو منصة التسوق وخدمات الطباعة والقرطاسية
                التابعة لـ «شركة الرؤية العربية للتجارة العامة» في جمهورية العراق.
                نلتزم التزاماً كاملاً بحماية خصوصية زبائننا ومستخدمي تطبيقاتنا
                وفق القوانين العراقية المعمول بها والمعايير المعتمدة لمتجر Google Play.
              </p>
            </section>

            <section className="space-y-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              <h3 className="font-bold text-[#1d1d1f] dark:text-white">2. البيانات التي نجمعها ولماذا</h3>
              <ul className="list-inside list-disc space-y-2 pr-2">
                <li>
                  <strong className="text-[#1d1d1f] dark:text-white">بيانات استلام الطلب (الاسم ورقم الهاتف):</strong> يعمل المتجر بنظام التسوق المباشر دون تسجيل حسابات أو كلمات مرور؛ يُطلب الاسم ورقم الهاتف عند تأكيد الطلب فقط للتواصل وتأكيد التسليم عبر خدمة الدفع عند الاستلام (COD).
                </li>
                <li>
                  <strong className="text-[#1d1d1f] dark:text-white">عنوان التوصيل والمحافظة:</strong> يُستخدم حصراً لتوجيه مناديب وشركات التوصيل لإيصال شحناتكم بدقة.
                </li>
                <li>
                  <strong className="text-[#1d1d1f] dark:text-white">سجل الطلبات وتتبّع الشحنات:</strong> يُحفظ في خوادم النظام لتمكينك من تتبع حالة طلبك عبر رمز التتبع الموقّع المرفق بالطلب ولأغراض الضمان والمحاسبة القانونية.
                </li>
                <li>
                  <strong className="text-[#1d1d1f] dark:text-white">معرفات الإشعارات (Push Tokens):</strong> لإرسال تحديثات حالة تجهيز وشحن الطلبات عند موافقتك.
                </li>
              </ul>
            </section>

            <section className="space-y-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              <h3 className="font-bold text-[#1d1d1f] dark:text-white">3. ما لا نقوم به مطلقاً</h3>
              <ul className="list-inside list-disc space-y-1.5 pr-2">
                <li>لا نقوم ببيع أو تأجير أي بيانات شخصية لأي جهة أو طرف ثالث.</li>
                <li>لا نطلب أو نحتفظ بأي بيانات بطاقات مصرفية أو أرقام سرية (طريقة الدفع الحالية هي نقداً عند الاستلام).</li>
                <li>لا نستخدم بياناتك لأغراض التتبع الإعلاني التطفلي.</li>
              </ul>
            </section>

            <section className="space-y-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              <h3 className="font-bold text-[#1d1d1f] dark:text-white">4. حقك في حذف بياناتك</h3>
              <p>
                يعمل المتجر بدون تسجيل حسابات؛ ومع ذلك يحق لكل متسوق سبق له تقديم طلب أن يطلب حذف بيانات تواصله المسجلة بعد انتهاء مدة الاحتفاظ المحاسبي القانونية عبر الرابط المخصص أدناه.
              </p>
              <div className="pt-2">
                <Link
                  href="/legal/delete-account"
                  className="inline-flex items-center gap-2 rounded-xl bg-[#b43d31] px-4 py-2 text-xs font-bold text-white hover:bg-[#922f28]"
                >
                  <Trash2 className="size-4" />
                  الانتقال لنموذج طلب حذف البيانات
                </Link>
              </div>
            </section>
          </article>
        )}

        {/* شروط الاستخدام */}
        {isTerms && (
          <article className="space-y-6 rounded-2xl border border-slate-900/[0.08] bg-white p-6 shadow-xs md:p-8 dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center gap-3 border-b border-slate-100 pb-4 dark:border-slate-800">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-[#eff6ff] text-[#1e3a8a] dark:bg-blue-950/60 dark:text-blue-400">
                <FileText className="size-6" />
              </span>
              <div>
                <h2 className="text-xl font-black text-[#1d1d1f] dark:text-white">
                  شروط الاستخدام والطلب والبيع
                </h2>
                <p className="text-xs text-slate-500">
                  الضوابط القانونية والتجارية الملزمة لطلبات متجر وتطبيق «مكتبة العربية» — جمهورية العراق
                </p>
              </div>
            </div>

            <section className="space-y-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              <h3 className="font-bold text-[#1d1d1f] dark:text-white">1. أطراف الاتفاقية ونطاق السريان</h3>
              <p>
                تحكم هذه الشروط والأحكام كافة عمليات التصفح، والطلب، والشراء التي تتم عبر تطبيق أو موقع «مكتبة العربية» التابع لـ «شركة الرؤية العربية للتجارة العامة» (المسجلة في العراق). يُعد إرسال الزبون لأي طلب إقراراً صريحاً وموافقة غير مشروطة على الالتزام بجميع البنود الواردة هنا.
              </p>
            </section>

            <section className="space-y-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              <h3 className="font-bold text-[#1d1d1f] dark:text-white">2. آلية الشراء والتوصيل والدفع عند التسليم (COD)</h3>
              <ul className="list-inside list-disc space-y-2 pr-2">
                <li>
                  <strong>طبيعة العقد والالتزام:</strong> يُعد تأكيد الطلب إيجاباً وقبولاً ملزماً. يلتزم المشتري بتوفير رقم هاتف فعال وعنوان تسليم دقيق، والتواجد لاستلام الشحنة وسداد قيمتها نقداً لمندوب شركة التوصيل فور الوصول.
                </li>
                <li>
                  <strong>إلغاء الطلب:</strong> يحق للمشتري إلغاء الطلب مجاناً فقط قبل تسليمه إلى شركة التوصيل وخروجه للتوزيع.
                </li>
                <li>
                  <strong>رفض الاستلام غير المبرر:</strong> في حال خروج الطلب للتوصيل ورفض المشتري استلامه أو إغلاق الهاتف أو التهرب من المندوب دون وجود عيب بالبضاعة، يُعد ذلك إخلالاً بالالتزام، ويلتزم المشتري بتحمل أجور الشحن المقررة. وتحتفظ الشركة بحقها القانوني في حظر رقم الهاتف والحساب من الطلب مستقبلاً والمطالبة بالتعويض عن كلفة التوصيل.
                </li>
              </ul>
            </section>

            <section className="space-y-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              <h3 className="font-bold text-[#1d1d1f] dark:text-white">3. خدمات الطباعة الخاصة والتصاميم المخصصة</h3>
              <ul className="list-inside list-disc space-y-2 pr-2">
                <li>
                  <strong>حظر الإلغاء والاسترجاع للمنتجات المخصصة:</strong> استناداً لأحكام المادة (10) من قانون حماية المستهلك العراقي رقم 1 لسنة 2010 والأنظمة التجارية المعمول بها، فإن كافة المطبوعات المنفذة بمواصفات خاصة (الأختام، الباجات، الدروع، المطبوعات الدعائية، الملازم المخصصة، والمواد التي تحمل أسماء أو شعارات محددة) تصبح ملزمة نهائياً بمجرد اعتماد الزبون للعينة أو بدء عملية الإنتاج عبر واتساب، ولا يجوز إلغاؤها أو التراجع عنها أو الامتناع عن استلامها بأي حال من الأحوال.
                </li>
                <li>
                  <strong>حقوق الملكية الفكرية للمحتوى:</strong> يقر الزبون ويتحمل كامل المسؤولية القانونية والأخلاقية والجنائية عن امتلاكه لكافة الحقوق والتراخيص المتعلقة بالتصاميم والشعارات والنصوص التي يرسلها للطباعة، وتخلي شركة الرؤية العربية مسؤوليتها التامة عن أي تعدٍ على علامات تجارية أو حقوق نشر لجهات أخرى قام الزبون بطلب طباعتها.
                </li>
              </ul>
            </section>

            <section className="space-y-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              <h3 className="font-bold text-[#1d1d1f] dark:text-white">4. أسعار المنتجات والتوافر وعروض الأسعار</h3>
              <p>
                كافة الأسعار المعروضة في التطبيق بالدينار العراقي (IQD). تبذل الشركة قصارى جهدها لضمان دقة الأسعار والمخزون، وفي حال نفاد كمية أحد الأصناف بعد تقديم الطلب، يتم إبلاغ الزبون هاتفياً أو عبر واتساب لاستبداله أو تعديل الفاتورة قبل الشحن.
              </p>
              <p>
                <strong>صلاحية عروض الشركات وعروض الأسعار:</strong> الحد الأقصى لفترة سريان عروض الشركات أو عروض الأسعار الصادرة بشكل عام هو <strong>5 أيام</strong> فقط من تاريخ الإصدار، ولا تشمل هذه العروض <strong>ورق الاستنساخ</strong> أو أي أصناف يُتداول بها يومياً وتخضع لتغيّر الأسعار اليومي في السوق.
              </p>
            </section>

            <section className="space-y-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              <h3 className="font-bold text-[#1d1d1f] dark:text-white">5. القانون الواجب التطبيق والاختصاص القضائي</h3>
              <p>
                تخضع هذه الشروط وتُفسر وفق القوانين والتشريعات السارية في جمهورية العراق، وتختص المحاكم العراقية في بغداد بالنظر في أي نزاع قد ينشأ عن تنفيذها أو تفسيرها.
              </p>
            </section>
          </article>
        )}

        {/* سياسة الاسترجاع */}
        {isReturns && (
          <article className="space-y-6 rounded-2xl border border-slate-900/[0.08] bg-white p-6 shadow-xs md:p-8 dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center gap-3 border-b border-slate-100 pb-4 dark:border-slate-800">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-[#eff6ff] text-[#1e3a8a] dark:bg-blue-950/60 dark:text-blue-400">
                <RotateCcw className="size-6" />
              </span>
              <div>
                <h2 className="text-xl font-black text-[#1d1d1f] dark:text-white">
                  سياسة الاسترجاع والاستبدال
                </h2>
                <p className="text-xs text-slate-500">
                  حقوق الزبون وضوابط إرجاع المنتجات والضمان
                </p>
              </div>
            </div>

            <section className="space-y-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              <h3 className="font-bold text-[#1d1d1f] dark:text-white">1. المعاينة الفورية عند التسليم</h3>
              <p>
                نحرص على رضا عملائنا، لذا يحق للمشتري معاينة محتوى الطرد بحضور مندوب شركة التوصيل للتأكد من سلامة البضاعة وتطابق الأعداد والنوعيات قبل استلامها وسداد قيمتها.
              </p>
            </section>

            <section className="space-y-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              <h3 className="font-bold text-[#1d1d1f] dark:text-white">2. حالات الاسترجاع والاستبدال المقبولة</h3>
              <ul className="list-inside list-disc space-y-1.5 pr-2">
                <li>
                  <strong>العيب المصنعي أو التلف:</strong> إذا تبين وجود عيب مصنعي في القرطاسية أو التجهيزات خلال 3 أيام من تاريخ الاستلام، يتم استبدال المنتج بآخر سليم دون أي رسوم إضافية، أو استرجاع قيمته.
                </li>
                <li>
                  <strong>عدم مطابقة الطلب:</strong> إذا وصل منتج مختلف تماماً عن الصنف المطلوب، يتم استبداله مجاناً على نفقة المتجر.
                </li>
                <li>
                  <strong>حالة السلعة المرجعة:</strong> يجب أن تكون المواد القرطاسية غير مستخدمة، وبحالتها الأصلية مع تغليفها وملصقاتها السليمة.
                </li>
              </ul>
            </section>

            <section className="space-y-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              <h3 className="font-bold text-[#1d1d1f] dark:text-white">3. الحالات المستثناة من الاسترجاع قطيعاً</h3>
              <ul className="list-inside list-disc space-y-1.5 pr-2">
                <li>المطبوعات المنفذة بطلب وتصميم خاص للزبون بعد بدء الطباعة أو اعتماد العينة، إلا في حال وجود خطأ مطبعي موثق من جانبنا مغاير للملف المعتمد.</li>
                <li>المنتجات التي تم استخدامها أو تعرضت للتلف أو سوء التخزين بعد مغادرة مندوب التوصيل.</li>
                <li>الطلبات التي تجاوزت المهلة المحددة (3 أيام من تاريخ الاستلام).</li>
              </ul>
            </section>

            <section className="space-y-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              <h3 className="font-bold text-[#1d1d1f] dark:text-white">4. رسوم الشحن في الإرجاع</h3>
              <p>
                إذا كان الإرجاع بسبب تلف أو خطأ من جانبنا، نتحمل أجور الشحن بالكامل. أما إذا كان الاستبدال بناءً على رغبة المشتري لتغيير لون أو صنف بدون وجود عيب في المنتج، فيتحمل المشتري أجور توصيل الشحنة البديلة.
              </p>
            </section>
          </article>
        )}

        {/* طلب حذف الحساب والبيانات (Google Play Mandatory Account Deletion) */}
        {isDeletion && (
          <article className="space-y-6 rounded-2xl border border-slate-900/[0.08] bg-white p-6 shadow-xs md:p-8 dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center gap-3 border-b border-slate-100 pb-4 dark:border-slate-800">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-rose-50 text-[#b43d31]">
                <Trash2 className="size-6" />
              </span>
              <div>
                <h2 className="text-xl font-black text-[#1d1d1f] dark:text-white">
                  طلب حذف الحساب والبيانات الشخصية
                </h2>
                <p className="text-xs text-slate-500">
                  Google Play &amp; App Store Account Deletion Requirement
                </p>
              </div>
            </div>

            <section className="space-y-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              <p>
                وفقاً لسياسة المتاجر الرسمية وإرشادات الخصوصية، نتيح لك تقديم طلب رسمي لحذف حسابك
                وبياناتك الشخصية المرتبطة به في «مكتبة العربية» عبر الويب، كما يتاح الحذف الفوري
                المؤكد عبر رمز التحقق الهاتفي (OTP) مباشرةً من داخل <strong>تطبيق الجوال</strong> (تبويب «حسابي»).
              </p>
              <div className="rounded-xl border border-slate-200 bg-[#f5f5f7] p-4 text-xs leading-relaxed text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
                <strong className="text-[#1d1d1f] dark:text-white">سياسة الحذف والاحتفاظ المحاسبي المعتمدة (365 يوماً):</strong>
                <ul className="mt-1.5 list-inside list-disc space-y-1">
                  <li>إخفاء البيانات الشخصية غير المحاسبية (الاسم، الهاتف، البريد، العناوين، ومعرفات الإشعارات) وتعطيل جميع الجلسات الفعالة.</li>
                  <li>إلغاء تنشيط رصيد نقاط الولاء والقسائم الترويجية غير المستخدمة (يشترط إغلاق الطلبات النشطة وتسوية أي أرصدة معلقة أولاً).</li>
                  <li>الاحتفاظ بالفواتير والأرصدة وسجلات التدقيق القانونية لمدة <strong>سنة واحدة (365 يوماً)</strong> فقط للامتثال المحاسبي والقانوني دون أي استخدام تسويقي.</li>
                </ul>
              </div>
            </section>

            {submissionResult ? (
              <div className="rounded-2xl border border-slate-200 bg-[#f5f5f7] p-6 text-center dark:border-slate-700 dark:bg-slate-800">
                <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-[#1e3a8a] text-white">
                  <CheckCircle2 className="size-6" />
                </span>
                <h3 className="mt-3 text-base font-extrabold text-[#1d1d1f] dark:text-white">
                  تم تسجيل طلب حذف الحساب بنجاح
                </h3>
                <p className="mt-2 text-sm font-black text-[#1e3a8a] dark:text-blue-400" dir="ltr">
                  {submissionResult.requestNumber}
                </p>
                <p className="mt-2 text-xs leading-relaxed text-slate-500 dark:text-slate-300">
                  احتفظ برقم الطلب أعلاه للمتابعة. ستُعالج إدارة الخصوصية إخفاء البيانات الشخصية
                  وتعطيل الجلسات مع تطبيق مهلة الاحتفاظ المحاسبي القانوني ({submissionResult.retentionDays} يوماً).
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmitDeletion} noValidate className="space-y-4 pt-2">
                <div>
                  <label htmlFor="delete-account-phone" className="block text-xs font-bold text-[#1d1d1f] dark:text-white">
                    رقم الهاتف العراقي المسجل به في التطبيق
                  </label>
                  <div className="relative mt-1.5">
                    <input
                      id="delete-account-phone"
                      type="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="07xxxxxxxxx (+964)"
                      data-country="+964"
                      dir="ltr"
                      disabled={requestDeletionM.isPending}
                      className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-right text-sm outline-none focus:border-[#1e3a8a] focus:ring-1 focus:ring-[#1e3a8a] disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800"
                      required
                    />
                    <Phone className="pointer-events-none absolute left-3 top-3 size-4 text-slate-400" />
                  </div>
                </div>

                <div>
                  <label htmlFor="delete-account-reason" className="block text-xs font-bold text-[#1d1d1f] dark:text-white">
                    سبب طلب الحذف (اختياري — بحد أقصى 500 حرف)
                  </label>
                  <textarea
                    id="delete-account-reason"
                    rows={3}
                    maxLength={500}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    disabled={requestDeletionM.isPending}
                    placeholder="يمكنك ذكر سبب الحذف أو أي ملاحظة إضافية لمراجعتها..."
                    className="mt-1.5 w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm outline-none focus:border-[#1e3a8a] focus:ring-1 focus:ring-[#1e3a8a] disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800"
                  />
                </div>

                {turnstileSiteKey && (
                  <div className="pt-1">
                    <TurnstileWidget
                      siteKey={turnstileSiteKey}
                      resetKey={turnstileResetKey}
                      onTokenChange={setTurnstileToken}
                    />
                  </div>
                )}

                {error && (
                  <p role="alert" className="mt-1 text-xs font-bold text-red-600">
                    {error}
                  </p>
                )}

                <div className="pt-2">
                  <button
                    type="submit"
                    disabled={requestDeletionM.isPending || settingsQ.isLoading}
                    className="inline-flex items-center gap-2 rounded-xl bg-[#B02B1A] px-5 py-2.5 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {requestDeletionM.isPending || settingsQ.isLoading ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Trash2 className="size-4" />
                    )}
                    تأكيد إرسال طلب حذف الحساب
                  </button>
                </div>
              </form>
            )}
          </article>
        )}
      </main>

      {/* تذييل الصفحة */}
      <footer className="mt-12 border-t border-slate-200/80 bg-white py-6 text-center text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
        <p>© {new Date().getFullYear()} شركة الرؤية العربية للتجارة العامة — المكتبة العربية. جميع الحقوق محفوظة.</p>
        <p className="mt-1">بغداد، العراق · خدمة الزبائن والمبيعات</p>
      </footer>
    </div>
  );
}
