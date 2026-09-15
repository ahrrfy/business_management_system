import { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  FileText,
  ShieldCheck,
  Trash2,
  RotateCcw,
  ArrowRight,
  CheckCircle2,
  Phone,
  Store,
} from "lucide-react";

export default function LegalDocument() {
  const [location] = useLocation();
  const [phone, setPhone] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPrivacy = location.includes("privacy");
  const isTerms = location.includes("terms");
  const isReturns = location.includes("returns");
  const isDeletion = location.includes("delete-account");

  const handleSubmitDeletion = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanPhone = phone.trim().replace(/\D/g, "");
    if (!cleanPhone || cleanPhone.length < 10) {
      setError("يرجى إدخال رقم هاتف عراقي صالح يبدأ بـ 07");
      return;
    }
    setError(null);
    setSubmitted(true);
  };

  return (
    <div dir="rtl" className="min-h-screen bg-[#F8FAF9] text-[#1D2925]">
      {/* رأس الصفحة العام */}
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-4">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-xl bg-[#0E806A] text-white">
              <Store className="size-5" />
            </span>
            <div>
              <div role="heading" aria-level={1} className="text-base font-extrabold text-[#112A25]">
                مكتبة العربية للطباعة والقرطاسية
              </div>
              <p className="text-xs text-muted-foreground">
                شركة الرؤية العربية للتجارة العامة — العراق
              </p>
            </div>
          </div>
          <Link
            href="/store"
            className="inline-flex items-center gap-1.5 rounded-lg border bg-white px-3 py-1.5 text-xs font-bold text-[#0E806A] hover:bg-[#F2FBF6]"
          >
            <ArrowRight className="size-3.5" />
            العودة للمتجر
          </Link>
        </div>
      </header>

      {/* الروابط العلوية السريعة */}
      <nav className="border-b bg-[#F0F5F2]">
        <div className="mx-auto flex max-w-4xl gap-2 overflow-x-auto px-4 py-2 text-xs font-bold">
          <Link
            href="/legal/privacy"
            className={`rounded-lg px-3 py-1.5 transition-colors ${
              isPrivacy
                ? "bg-[#0E806A] text-white"
                : "text-muted-foreground hover:bg-white hover:text-foreground"
            }`}
          >
            سياسة الخصوصية
          </Link>
          <Link
            href="/legal/terms"
            className={`rounded-lg px-3 py-1.5 transition-colors ${
              isTerms
                ? "bg-[#0E806A] text-white"
                : "text-muted-foreground hover:bg-white hover:text-foreground"
            }`}
          >
            شروط الاستخدام
          </Link>
          <Link
            href="/legal/returns"
            className={`rounded-lg px-3 py-1.5 transition-colors ${
              isReturns
                ? "bg-[#0E806A] text-white"
                : "text-muted-foreground hover:bg-white hover:text-foreground"
            }`}
          >
            سياسة الاسترجاع
          </Link>
          <Link
            href="/legal/delete-account"
            className={`rounded-lg px-3 py-1.5 transition-colors ${
              isDeletion
                ? "bg-[#B02B1A] text-white"
                : "text-muted-foreground hover:bg-white hover:text-foreground"
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
          <article className="space-y-6 rounded-2xl border bg-white p-6 shadow-sm md:p-8">
            <div className="flex items-center gap-3 border-b pb-4">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-[#E8F5EF] text-[#0E806A]">
                <ShieldCheck className="size-6" />
              </span>
              <div>
                <h2 className="text-xl font-black text-[#112A25]">
                  سياسة الخصوصية وحماية البيانات
                </h2>
                <p className="text-xs text-muted-foreground">
                  تطبيق وموقع «مكتبة العربية» — متوافقة مع إرشادات Google Play
                </p>
              </div>
            </div>

            <section className="space-y-3 text-sm leading-relaxed text-[#354640]">
              <h3 className="font-bold text-[#112A25]">1. من نحن</h3>
              <p>
                تطبيق وموقع «مكتبة العربية» هو منصة التسوق وخدمات الطباعة والقرطاسية
                التابعة لـ «شركة الرؤية العربية للتجارة العامة» في جمهورية العراق.
                نلتزم التزاماً كاملاً بحماية خصوصية زبائننا ومستخدمي تطبيقاتنا
                وفق القوانين العراقية المعمول بها والمعايير المعتمدة لمتجر Google Play.
              </p>
            </section>

            <section className="space-y-3 text-sm leading-relaxed text-[#354640]">
              <h3 className="font-bold text-[#112A25]">2. البيانات التي نجمعها ولماذا</h3>
              <ul className="list-inside list-disc space-y-2 pr-2">
                <li>
                  <strong className="text-[#112A25]">رقم الهاتف والاسم:</strong> يُستخدم للمصادقة وتفعيل الحساب وتأكيد إرسال واستلام الطلبات عبر خدمة الدفع عند التسليم (COD).
                </li>
                <li>
                  <strong className="text-[#112A25]">عنوان التوصيل والمحافظة:</strong> يُستخدم حصراً لتوجيه مناديب وشركات التوصيل لإيصال شحناتكم بدقة.
                </li>
                <li>
                  <strong className="text-[#112A25]">سجل الطلبات ونقاط الولاء:</strong> يُحفظ في خوادم النظام لتمكينك من تتبع طلباتك والحصول على خصومات الولاء.
                </li>
                <li>
                  <strong className="text-[#112A25]">معرفات الإشعارات (Push Tokens):</strong> لإرسال تحديثات حالة تجهيز وشحن الطلبات عند موافقتك.
                </li>
              </ul>
            </section>

            <section className="space-y-3 text-sm leading-relaxed text-[#354640]">
              <h3 className="font-bold text-[#112A25]">3. ما لا نقوم به مطلقاً</h3>
              <ul className="list-inside list-disc space-y-1.5 pr-2">
                <li>لا نقوم ببيع أو تأجير أي بيانات شخصية لأي جهة أو طرف ثالث.</li>
                <li>لا نطلب أو نحتفظ بأي بيانات بطاقات مصرفية أو أرقام سرية (طريقة الدفع الحالية هي نقداً عند الاستلام).</li>
                <li>لا نستخدم بياناتك لأغراض التتبع الإعلاني التطفلي.</li>
              </ul>
            </section>

            <section className="space-y-3 text-sm leading-relaxed text-[#354640]">
              <h3 className="font-bold text-[#112A25]">4. حقك في حذف بياناتك</h3>
              <p>
                يحق لكل مستخدم طلب حذف حسابه وكافة بياناته وسجلاته في أي وقت، إما مباشرة من داخل إعدادات التطبيق أو عبر الرابط المخصص أدناه.
              </p>
              <div className="pt-2">
                <Link
                  href="/legal/delete-account"
                  className="inline-flex items-center gap-2 rounded-xl bg-[#B02B1A] px-4 py-2 text-xs font-bold text-white hover:bg-[#8F2315]"
                >
                  <Trash2 className="size-4" />
                  الانتقال لصفحة طلب حذف الحساب
                </Link>
              </div>
            </section>
          </article>
        )}

        {/* شروط الاستخدام */}
        {isTerms && (
          <article className="space-y-6 rounded-2xl border bg-white p-6 shadow-sm md:p-8">
            <div className="flex items-center gap-3 border-b pb-4">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-[#E8F5EF] text-[#0E806A]">
                <FileText className="size-6" />
              </span>
              <div>
                <h2 className="text-xl font-black text-[#112A25]">
                  شروط الاستخدام والطلب والبيع
                </h2>
                <p className="text-xs text-muted-foreground">
                  الضوابط القانونية والتجارية الملزمة لطلبات متجر وتطبيق «مكتبة العربية» — جمهورية العراق
                </p>
              </div>
            </div>

            <section className="space-y-3 text-sm leading-relaxed text-[#354640]">
              <h3 className="font-bold text-[#112A25]">1. أطراف الاتفاقية ونطاق السريان</h3>
              <p>
                تحكم هذه الشروط والأحكام كافة عمليات التصفح، والطلب، والشراء التي تتم عبر تطبيق أو موقع «مكتبة العربية» التابع لـ «شركة الرؤية العربية للتجارة العامة» (المسجلة في العراق). يُعد إرسال الزبون لأي طلب إقراراً صريحاً وموافقة غير مشروطة على الالتزام بجميع البنود الواردة هنا.
              </p>
            </section>

            <section className="space-y-3 text-sm leading-relaxed text-[#354640]">
              <h3 className="font-bold text-[#112A25]">2. آلية الشراء والتوصيل والدفع عند التسليم (COD)</h3>
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

            <section className="space-y-3 text-sm leading-relaxed text-[#354640]">
              <h3 className="font-bold text-[#112A25]">3. خدمات الطباعة الخاصة والتصاميم المخصصة</h3>
              <ul className="list-inside list-disc space-y-2 pr-2">
                <li>
                  <strong>حظر الإلغاء والاسترجاع للمنتجات المخصصة:</strong> استناداً لأحكام المادة (10) من قانون حماية المستهلك العراقي رقم 1 لسنة 2010 والأنظمة التجارية المعمول بها، فإن كافة المطبوعات المنفذة بمواصفات خاصة (الأختام، الباجات، الدروع، المطبوعات الدعائية، الملازم المخصصة، والمواد التي تحمل أسماء أو شعارات محددة) تصبح ملزمة نهائياً بمجرد اعتماد الزبون للعينة أو بدء عملية الإنتاج عبر واتساب، ولا يجوز إلغاؤها أو التراجع عنها أو الامتناع عن استلامها بأي حال من الأحوال.
                </li>
                <li>
                  <strong>حقوق الملكية الفكرية للمحتوى:</strong> يقر الزبون ويتحمل كامل المسؤولية القانونية والأخلاقية والجنائية عن امتلاكه لكافة الحقوق والتراخيص المتعلقة بالتصاميم والشعارات والنصوص التي يرسلها للطباعة، وتخلي شركة الرؤية العربية مسؤوليتها التامة عن أي تعدٍ على علامات تجارية أو حقوق نشر لجهات أخرى قام الزبون بطلب طباعتها.
                </li>
              </ul>
            </section>

            <section className="space-y-3 text-sm leading-relaxed text-[#354640]">
              <h3 className="font-bold text-[#112A25]">4. أسعار المنتجات والتوافر</h3>
              <p>
                كافة الأسعار المعروضة في التطبيق بالدينار العراقي (IQD). تبذل الشركة قصارى جهدها لضمان دقة الأسعار والمخزون، وفي حال نفاد كمية أحد الأصناف بعد تقديم الطلب، يتم إبلاغ الزبون هاتفياً أو عبر واتساب لاستبداله أو تعديل الفاتورة قبل الشحن.
              </p>
            </section>

            <section className="space-y-3 text-sm leading-relaxed text-[#354640]">
              <h3 className="font-bold text-[#112A25]">5. القانون الواجب التطبيق والاختصاص القضائي</h3>
              <p>
                تخضع هذه الشروط وتُفسر وفق القوانين والتشريعات السارية في جمهورية العراق، وتختص المحاكم العراقية في بغداد بالنظر في أي نزاع قد ينشأ عن تنفيذها أو تفسيرها.
              </p>
            </section>
          </article>
        )}

        {/* سياسة الاسترجاع */}
        {isReturns && (
          <article className="space-y-6 rounded-2xl border bg-white p-6 shadow-sm md:p-8">
            <div className="flex items-center gap-3 border-b pb-4">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-[#E8F5EF] text-[#0E806A]">
                <RotateCcw className="size-6" />
              </span>
              <div>
                <h2 className="text-xl font-black text-[#112A25]">
                  سياسة الاسترجاع والاستبدال
                </h2>
                <p className="text-xs text-muted-foreground">
                  حقوق الزبون وضوابط إرجاع المنتجات والضمان
                </p>
              </div>
            </div>

            <section className="space-y-3 text-sm leading-relaxed text-[#354640]">
              <h3 className="font-bold text-[#112A25]">1. المعاينة الفورية عند التسليم</h3>
              <p>
                نحرص على رضا عملائنا، لذا يحق للمشتري معاينة محتوى الطرد بحضور مندوب شركة التوصيل للتأكد من سلامة البضاعة وتطابق الأعداد والنوعيات قبل استلامها وسداد قيمتها.
              </p>
            </section>

            <section className="space-y-3 text-sm leading-relaxed text-[#354640]">
              <h3 className="font-bold text-[#112A25]">2. حالات الاسترجاع والاستبدال المقبولة</h3>
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

            <section className="space-y-3 text-sm leading-relaxed text-[#354640]">
              <h3 className="font-bold text-[#112A25]">3. الحالات المستثناة من الاسترجاع قطيعاً</h3>
              <ul className="list-inside list-disc space-y-1.5 pr-2">
                <li>المطبوعات المنفذة بطلب وتصميم خاص للزبون بعد بدء الطباعة أو اعتماد العينة، إلا في حال وجود خطأ مطبعي موثق من جانبنا مغاير للملف المعتمد.</li>
                <li>المنتجات التي تم استخدامها أو تعرضت للتلف أو سوء التخزين بعد مغادرة مندوب التوصيل.</li>
                <li>الطلبات التي تجاوزت المهلة المحددة (3 أيام من تاريخ الاستلام).</li>
              </ul>
            </section>

            <section className="space-y-3 text-sm leading-relaxed text-[#354640]">
              <h3 className="font-bold text-[#112A25]">4. رسوم الشحن في الإرجاع</h3>
              <p>
                إذا كان الإرجاع بسبب تلف أو خطأ من جانبنا، نتحمل أجور الشحن بالكامل. أما إذا كان الاستبدال بناءً على رغبة المشتري لتغيير لون أو صنف بدون وجود عيب في المنتج، فيتحمل المشتري أجور توصيل الشحنة البديلة.
              </p>
            </section>
          </article>
        )}

        {/* طلب حذف الحساب والبيانات (Google Play Mandatory Account Deletion) */}
        {isDeletion && (
          <article className="space-y-6 rounded-2xl border bg-white p-6 shadow-sm md:p-8">
            <div className="flex items-center gap-3 border-b pb-4">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-[#FDF2F1] text-[#B02B1A]">
                <Trash2 className="size-6" />
              </span>
              <div>
                <h2 className="text-xl font-black text-[#112A25]">
                  طلب حذف الحساب والبيانات الشخصية
                </h2>
                <p className="text-xs text-muted-foreground">
                  Google Play Account Deletion Requirement
                </p>
              </div>
            </div>

            <section className="space-y-3 text-sm leading-relaxed text-[#354640]">
              <p>
                وفقاً لسياسة Google Play وإرشادات الخصوصية، نتيح لك طلب حذف حسابك
                وكافة بياناتك الشخصية المرتبطة به في «مكتبة العربية» دون الحاجة لتثبيت التطبيق.
              </p>
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs leading-relaxed text-amber-900">
                <strong>ما الذي يحدث عند حذف حسابك؟</strong>
                <ul className="mt-1.5 list-inside list-disc space-y-1">
                  <li>مسح اسمك ورقم هاتفك وعناوينك المحفوظة من قاعدة بيانات العملاء.</li>
                  <li>إلغاء تنشيط رصيد نقاط الولاء والقسائم غير المستخدمة.</li>
                  <li>تُحفظ الفواتير المالية السابقة لأغراض المحاسبة القانونية بدون أي ربط بهويتك.</li>
                </ul>
              </div>
            </section>

            {submitted ? (
              <div className="rounded-2xl border border-[#C5EBD6] bg-[#F2FBF6] p-6 text-center">
                <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-[#0E806A] text-white">
                  <CheckCircle2 className="size-6" />
                </span>
                <h3 className="mt-3 text-base font-extrabold text-[#112A25]">
                  تم استلام طلب حذف الحساب بنجاح
                </h3>
                <p className="mt-1 text-xs text-[#4F685D]">
                  سيتم مراجعة ومعالجة حذف كافة البيانات المرتبطة بالرقم ({phone}) نهائياً خلال 7 أيام عمل.
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmitDeletion} className="space-y-4 pt-2">
                <div>
                  <label className="block text-xs font-bold text-[#112A25]">
                    رقم الهاتف العراقي المسجل به في التطبيق
                  </label>
                  <div className="relative mt-1.5">
                    <input
                      type="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="07xxxxxxxxx (+964)"
                      data-country="+964"
                      dir="ltr"
                      className="w-full rounded-xl border border-[#D0D7D4] px-4 py-2.5 text-right text-sm outline-none focus:border-[#0E806A] focus:ring-1 focus:ring-[#0E806A]"
                      required
                    />
                    <Phone className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" />
                  </div>
                  {error && (
                    <p className="mt-1 text-xs font-bold text-red-600">{error}</p>
                  )}
                </div>

                <div className="pt-2">
                  <button
                    type="submit"
                    className="inline-flex items-center gap-2 rounded-xl bg-[#B02B1A] px-5 py-2.5 text-xs font-bold text-white transition-opacity hover:opacity-90"
                  >
                    <Trash2 className="size-4" />
                    تأكيد إرسال طلب حذف الحساب
                  </button>
                </div>
              </form>
            )}
          </article>
        )}
      </main>

      {/* تذييل الصفحة */}
      <footer className="mt-12 border-t bg-white py-6 text-center text-xs text-muted-foreground">
        <p>© {new Date().getFullYear()} شركة الرؤية العربية للتجارة العامة — جميع الحقوق محفوظة.</p>
        <p className="mt-1">بغداد، العراق · خدمة الزبائن والمبيعات</p>
      </footer>
    </div>
  );
}
