/**
 * /apply — استمارة التقديم على وظيفة **العامّة** (خارج تخطيط التطبيق، بلا تسجيل دخول).
 *
 * تُركَّب كمسار عام مكشوف (ليست خلف <Protected>): أي زائر يفتح الرابط فيملأ بياناته،
 * فيصل طلبه إلى مسار التوظيف بمصدر external ومرحلة «جديد» عبر trpc.recruitment.submit.
 * مستقلّة بتنسيقها (inline styles + خط Cairo + RTL) — لا تفترض AppLayout ولا الثيم.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { errMsg } from "@/lib/notify";

const COMPANY = "الرؤية العربية للتجارة العامة";
const SUBTITLE = "المكتبة العربية للطباعة والقرطاسية";

const page: React.CSSProperties = {
  minHeight: "100vh",
  background: "linear-gradient(160deg,#0b0d16 0%,#141826 100%)",
  color: "#e9ecf5",
  fontFamily: '"Cairo", system-ui, sans-serif',
  direction: "rtl",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  padding: "32px 16px",
};
const card: React.CSSProperties = {
  width: "min(680px, 100%)",
  background: "#ffffff",
  color: "#1b2030",
  borderRadius: 18,
  boxShadow: "0 30px 80px -30px rgba(0,0,0,.6)",
  overflow: "hidden",
};
const header: React.CSSProperties = {
  textAlign: "center",
  padding: "26px 24px 18px",
  borderBottom: "1px solid #eef0f5",
  background: "linear-gradient(180deg,#f7f8fc,#ffffff)",
};
const body: React.CSSProperties = { padding: "22px 24px 28px" };
const grid: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 };
const fieldWrap: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };
const labelCss: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: "#3a4153" };
const inputCss: React.CSSProperties = {
  height: 42,
  borderRadius: 10,
  border: "1px solid #d8dce6",
  background: "#fff",
  padding: "0 12px",
  fontFamily: "inherit",
  fontSize: 14,
  color: "#1b2030",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};
const taCss: React.CSSProperties = { ...inputCss, height: "auto", minHeight: 90, padding: "10px 12px", resize: "vertical" };
const submitCss = (disabled: boolean): React.CSSProperties => ({
  marginTop: 22,
  width: "100%",
  height: 48,
  borderRadius: 12,
  border: "none",
  background: disabled ? "#9aa0b8" : "#3f46d6",
  color: "#fff",
  fontFamily: "inherit",
  fontWeight: 800,
  fontSize: 16,
  cursor: disabled ? "not-allowed" : "pointer",
  transition: "background .15s",
});

function Field({
  label,
  required,
  full,
  children,
}: {
  label: string;
  required?: boolean;
  full?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div style={{ ...fieldWrap, gridColumn: full ? "1 / -1" : undefined }}>
      <label style={labelCss}>
        {label} {required && <span style={{ color: "#dc2626" }}>*</span>}
      </label>
      {children}
    </div>
  );
}

export default function JobApply() {
  const [name, setName] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [experience, setExperience] = useState("");
  const [education, setEducation] = useState("");
  const [notes, setNotes] = useState("");
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const apply = trpc.recruitment.submit.useMutation({
    onSuccess: () => setDone(true),
    onError: (e) => setErr(errMsg(e)),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!name.trim()) {
      setErr("الاسم مطلوب");
      return;
    }
    apply.mutate({
      name: name.trim(),
      jobTitle: jobTitle.trim() || undefined,
      phone: phone.trim() || undefined,
      email: email.trim() || undefined,
      experience: experience.trim() || undefined,
      education: education.trim() || undefined,
      notes: notes.trim() || undefined,
    });
  }

  if (done) {
    return (
      <div style={page}>
        <div style={{ ...card, maxWidth: 480, textAlign: "center" }}>
          <div style={{ ...body, padding: "44px 28px" }}>
            <div
              style={{
                width: 76,
                height: 76,
                margin: "0 auto 18px",
                borderRadius: "50%",
                background: "#dcfce7",
                color: "#16a34a",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 40,
                fontWeight: 900,
              }}
            >
              ✓
            </div>
            <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>شكراً لتقديمك</h1>
            <p style={{ fontSize: 14.5, color: "#5b6275", lineHeight: 2, margin: "12px 0 0" }}>
              وصلنا طلبك بنجاح. سيراجعه فريق الموارد البشرية في {COMPANY}، وسنتواصل معك إن كان مناسباً للوظيفة.
            </p>
            <button
              onClick={() => {
                setDone(false);
                setName(""); setJobTitle(""); setPhone(""); setEmail("");
                setExperience(""); setEducation(""); setNotes("");
              }}
              style={{
                marginTop: 22,
                border: "1px solid #d8dce6",
                background: "#fff",
                color: "#3a4153",
                borderRadius: 10,
                padding: "10px 20px",
                fontFamily: "inherit",
                fontWeight: 700,
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              تقديم طلب آخر
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={page}>
      <div style={card}>
        <div style={header}>
          <div style={{ fontSize: 20, fontWeight: 900, color: "#1b2030" }}>{COMPANY}</div>
          <div style={{ fontSize: 13, color: "#7b8194", marginTop: 4 }}>{SUBTITLE}</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#3f46d6", marginTop: 12 }}>استمارة التقديم على وظيفة</div>
        </div>

        <form style={body} onSubmit={submit}>
          {err && (
            <div
              style={{
                background: "#fef2f2",
                border: "1px solid #fecaca",
                color: "#b91c1c",
                borderRadius: 10,
                padding: "10px 12px",
                fontSize: 13.5,
                marginBottom: 16,
              }}
            >
              {err}
            </div>
          )}

          <div style={grid}>
            <Field label="الاسم الثلاثي واللقب" required full>
              <input style={inputCss} value={name} onChange={(e) => setName(e.target.value)} placeholder="الاسم الكامل" />
            </Field>
            <Field label="الوظيفة المطلوبة">
              <input style={inputCss} value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="مثال: مصمم جرافيك" />
            </Field>
            <Field label="رقم الهاتف">
              <input style={{ ...inputCss, direction: "ltr", textAlign: "right" }} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07XX ..." inputMode="tel" />
            </Field>
            <Field label="البريد الإلكتروني">
              <input style={{ ...inputCss, direction: "ltr", textAlign: "right" }} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
            </Field>
            <Field label="سنوات الخبرة">
              <input style={inputCss} value={experience} onChange={(e) => setExperience(e.target.value)} placeholder="مثال: ٣ سنوات" />
            </Field>
            <Field label="أعلى مؤهل دراسي">
              <input style={inputCss} value={education} onChange={(e) => setEducation(e.target.value)} placeholder="مثال: بكالوريوس" />
            </Field>
            <Field label="نبذة / ملاحظات" full>
              <textarea style={taCss} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="خبرات سابقة، مهارات، أي معلومة تودّ إضافتها…" />
            </Field>
          </div>

          <button type="submit" style={submitCss(apply.isPending)} disabled={apply.isPending}>
            {apply.isPending ? "جارٍ الإرسال…" : "إرسال الطلب"}
          </button>

          <p style={{ fontSize: 12, color: "#9aa0b8", textAlign: "center", marginTop: 14, lineHeight: 1.9 }}>
            ستُستخدم بياناتك لغرض التوظيف فقط. الحقول التي عليها <span style={{ color: "#dc2626" }}>*</span> إلزامية.
          </p>
        </form>
      </div>
    </div>
  );
}
