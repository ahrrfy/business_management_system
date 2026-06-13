/**
 * بناء نصّ مشاركة بيانات حساب مستخدم جديد (واتساب / نسخ) + رابط wa.me.
 *
 * النصّ يجمع ما طلبه المالك: ترحيب باسم المستخدم، **معلوماته** (الصلاحية/الفرع/المسمّى)،
 * **بيانات الدخول** (الرابط/البريد/كلمة المرور)، و**تعليمات أوّلية بسيطة** للدخول وتغيير الكلمة.
 *
 * دالة نقيّة بلا أثر جانبي ⇒ قابلة للاختبار وحدةً (credentialsMessage.test.ts).
 */
export interface CredentialsMessageInput {
  name: string;
  email: string;
  password: string;
  appUrl: string;
  /** تسمية الصلاحية بالعربية (من ROLE_OPTIONS) — اختياري. */
  roleLabel?: string | null;
  /** اسم الفرع، أو null ⇒ «كل الفروع». */
  branchName?: string | null;
  /** المسمّى الوظيفي — اختياري. */
  jobTitle?: string | null;
  /** هل سيُجبَر على تغيير الكلمة عند أول دخول (افتراضي true) — يضبط التعليمات. */
  mustChangePassword?: boolean;
}

/** يبني نصّ الرسالة كاملاً (أسطر مفصولة بـ\n — مناسبة لواتساب والنسخ). */
export function buildCredentialsMessage(o: CredentialsMessageInput): string {
  const L: string[] = [];
  L.push(`أهلاً ${o.name} 👋`);
  L.push("تمّ إنشاء حسابك في نظام الرؤية العربية للأعمال.");
  L.push("");

  // — معلوماتك —
  L.push("👤 معلوماتك:");
  if (o.jobTitle?.trim()) L.push(`• المسمّى: ${o.jobTitle.trim()}`);
  if (o.roleLabel?.trim()) L.push(`• الصلاحية: ${o.roleLabel.trim()}`);
  L.push(`• الفرع: ${o.branchName?.trim() || "كل الفروع"}`);
  L.push("");

  // — بيانات الدخول —
  L.push("🔐 بيانات الدخول:");
  L.push(`🔗 الرابط: ${o.appUrl}`);
  L.push(`📧 البريد: ${o.email}`);
  L.push(`🔑 كلمة المرور: ${o.password}`);
  L.push("");

  // — تعليمات أوّلية —
  L.push("📝 خطوات الدخول:");
  L.push("1) افتح الرابط من متصفّح الهاتف أو الحاسبة.");
  L.push("2) أدخل البريد وكلمة المرور أعلاه.");
  if (o.mustChangePassword !== false) {
    L.push("3) ستُطلب كلمة مرور جديدة عند أول دخول — اخترها واحفظها في مكان آمن.");
  }
  L.push("");
  L.push("⚠️ هذه البيانات سرّية — لا تشاركها مع أحد. لأي مساعدة تواصل مع الإدارة.");

  return L.join("\n");
}

/**
 * رابط واتساب لإرسال نصّ جاهز إلى رقم E.164.
 * يُجرّد الرقم من كل ما عدا الأرقام (wa.me يطلب «مفتاح الدولة + الرقم» بلا + ولا مسافات).
 * يعيد null إن لا رقم صالح ⇒ تعطيل الزر بدل فتح رابط مكسور.
 */
export function whatsappLink(phone: string | null | undefined, text: string): string | null {
  const raw = (phone ?? "").replace(/[^0-9]/g, "");
  if (!raw) return null;
  return `https://wa.me/${raw}?text=${encodeURIComponent(text)}`;
}
