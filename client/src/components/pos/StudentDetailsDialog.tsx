// نافذة بيانات الطالب للاشتراكات التعليمية (ش٦).
// لا تكتب شيئاً في القاعدة: تُنتج **لقطة** تُحمَل في سطر السلة، وتُثبَّت داخل معاملة البيع لاحقاً —
// فلا يبقى في القاعدة طالبٌ لبيعٍ لم يكتمل. البحث بهاتف الطالب أو بهاتف وليّ الأمر (§٨.٤).
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { GraduationCap, Search, Users, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

export type StudentMatch = RouterOutputs["digitalCards"]["students"]["search"][number];

export type StudentSnapshot = {
  customerId: number | null;
  studentName: string;
  studentPhone: string;
  guardianPhone: string;
  address: string;
  mode: "UPDATE_PROFILE" | "INVOICE_ONLY";
};

const C = {
  bg: "var(--pos-bg)",
  card: "var(--pos-card)",
  border: "var(--pos-border)",
  muted: "var(--pos-muted)",
  mutedFg: "var(--pos-muted-fg)",
  fg: "var(--pos-fg)",
  primary: "var(--pos-primary)",
  primaryFg: "var(--pos-primary-fg)",
  primarySoft: "var(--pos-primary-soft)",
  amber: "var(--pos-amber)",
  amberSoft: "var(--pos-amber-soft)",
  danger: "var(--pos-danger)",
  overlay: "var(--pos-overlay)",
} as const;

const fieldStyle: React.CSSProperties = {
  width: "100%", height: 46, padding: "0 12px", borderRadius: 10,
  border: `1.5px solid ${C.border}`, background: C.card, color: C.fg,
  fontSize: 15, fontFamily: "inherit", outline: "none",
};

const labelStyle: React.CSSProperties = { fontSize: 13, fontWeight: 700, color: C.fg };

export function StudentDetailsDialog({
  open,
  cardName,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  cardName: string;
  onCancel: () => void;
  onConfirm: (snapshot: StudentSnapshot) => void;
}) {
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [studentName, setStudentName] = useState("");
  const [studentPhone, setStudentPhone] = useState("+964");
  const [guardianPhone, setGuardianPhone] = useState("+964");
  const [address, setAddress] = useState("");
  /** اللقطة الأصلية للملفّ المختار — أساس تمييز «هل عُدِّل شيء؟». */
  const [linked, setLinked] = useState<StudentMatch | null>(null);
  const [mode, setMode] = useState<"UPDATE_PROFILE" | "INVOICE_ONLY">("UPDATE_PROFILE");
  const [searchBy, setSearchBy] = useState<"student" | "guardian">("student");
  const [searchTerm, setSearchTerm] = useState("");
  const [debounced, setDebounced] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setCustomerId(null); setStudentName(""); setStudentPhone("+964"); setGuardianPhone("+964"); setAddress("");
    setLinked(null); setMode("UPDATE_PROFILE"); setSearchBy("student"); setSearchTerm(""); setDebounced("");
    setTimeout(() => nameRef.current?.focus(), 40);
  }, [open]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(searchTerm.trim()), 250);
    return () => clearTimeout(t);
  }, [searchTerm]);

  const results = trpc.digitalCards.students.search.useQuery(
    searchBy === "student" ? { studentPhone: debounced } : { guardianPhone: debounced },
    { enabled: open && debounced.length >= 4 },
  );

  const siblings = trpc.digitalCards.students.siblingCount.useQuery(
    { guardianPhone },
    { enabled: open && guardianPhone.trim().length >= 6 },
  );

  // §٨.٤-٢: هاتف الطالب المُدخَل يدوياً قد يخصّ ملفّاً قائماً — الفحص هنا يمنع ازدواج الملفّات
  // قبل الإضافة للسلة. الخادم لا يدمج تلقائياً عند الالتباس، فالقرار يبقى للكاشير.
  const [phoneProbe, setPhoneProbe] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setPhoneProbe(studentPhone.trim()), 350);
    return () => clearTimeout(t);
  }, [studentPhone]);

  const resolved = trpc.digitalCards.students.resolveByPhone.useQuery(
    { studentPhone: phoneProbe },
    { enabled: open && customerId == null && phoneProbe.length >= 8 },
  );

  /** هل انحرفت الحقول عن الملفّ المرتبط؟ عندها فقط يُطرح خيار «تحديث الملفّ / لهذه الفاتورة فقط». */
  const dirty = useMemo(() => {
    if (!linked) return false;
    return (
      studentName.trim() !== linked.studentName.trim() ||
      studentPhone.trim() !== linked.studentPhone.trim() ||
      guardianPhone.trim() !== linked.guardianPhone.trim() ||
      address.trim() !== (linked.address ?? "").trim()
    );
  }, [linked, studentName, studentPhone, guardianPhone, address]);

  function pick(m: StudentMatch) {
    setCustomerId(m.customerId);
    setLinked(m);
    setStudentName(m.studentName);
    setStudentPhone(m.studentPhone);
    setGuardianPhone(m.guardianPhone);
    setAddress(m.address ?? "");
    setMode("UPDATE_PROFILE");
    setSearchTerm(""); setDebounced("");
  }

  function clearLink() {
    setCustomerId(null);
    setLinked(null);
    setMode("UPDATE_PROFILE");
  }

  function submit() {
    const name = studentName.trim();
    const sPhone = studentPhone.trim();
    const gPhone = guardianPhone.trim();
    const addr = address.trim();
    if (!name) return notify.err("اسم الطالب مطلوب");
    if (sPhone.replace(/\D/g, "").length <= 3) return notify.err("هاتف الطالب مطلوب");
    if (gPhone.replace(/\D/g, "").length <= 3) return notify.err("هاتف ولي الأمر مطلوب");
    if (!addr) return notify.err("عنوان الطالب مطلوب");
    onConfirm({
      customerId,
      studentName: name,
      studentPhone: sPhone,
      guardianPhone: gPhone,
      address: addr,
      // بلا ملفّ مرتبط أو بلا تعديل ⇒ لا معنى لـ«لهذه الفاتورة فقط».
      mode: linked && dirty ? mode : "UPDATE_PROFILE",
    });
  }

  /** Enter ينتقل للحقل التالي بدل إرسال النموذج (§٨.٧). */
  function onFieldKey(e: React.KeyboardEvent<HTMLInputElement>, next?: React.RefObject<HTMLInputElement | null>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (next?.current) next.current.focus();
    else submit();
  }

  const phoneRef = useRef<HTMLInputElement>(null);
  const guardianRef = useRef<HTMLInputElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);

  if (!open) return null;
  const matches = results.data ?? [];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="بيانات الطالب"
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }}
      style={{ position: "fixed", inset: 0, background: C.overlay, zIndex: 62, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
    >
      <div style={{ width: "min(680px, 100%)", maxHeight: "min(90vh, 860px)", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 14, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "12px 16px", borderBottom: `1px solid ${C.border}`, background: C.card }}>
          <GraduationCap aria-hidden size={20} color={C.primary} />
          <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
            <span style={{ fontWeight: 800, fontSize: 16, color: C.fg }}>بيانات الطالب</span>
            <span style={{ fontSize: 12, color: C.mutedFg, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{cardName}</span>
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={onCancel} aria-label="إغلاق" style={{ width: 40, height: 40, border: "none", background: "none", cursor: "pointer", color: C.mutedFg, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
            <X aria-hidden size={20} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
          {/* البحث عن ملفّ قائم */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, background: C.muted, borderRadius: 12, padding: 12 }}>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                onClick={() => { setSearchBy("student"); setSearchTerm(""); }}
                style={{ height: 34, padding: "0 12px", borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700, border: `1.5px solid ${searchBy === "student" ? C.primary : C.border}`, background: searchBy === "student" ? C.primary : C.card, color: searchBy === "student" ? C.primaryFg : C.fg }}
              >
                بهاتف الطالب
              </button>
              <button
                onClick={() => { setSearchBy("guardian"); setSearchTerm(""); }}
                style={{ height: 34, padding: "0 12px", borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700, border: `1.5px solid ${searchBy === "guardian" ? C.primary : C.border}`, background: searchBy === "guardian" ? C.primary : C.card, color: searchBy === "guardian" ? C.primaryFg : C.fg }}
              >
                بهاتف ولي الأمر
              </button>
            </div>
            <div style={{ position: "relative" }}>
              <Search aria-hidden size={16} style={{ position: "absolute", insetInlineStart: 11, top: "50%", transform: "translateY(-50%)", color: C.mutedFg }} />
              <input
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder={searchBy === "student" ? "ابحث بهاتف الطالب…" : "ابحث بهاتف ولي الأمر…"}
                aria-label="بحث عن ملفّ طالب"
                dir="ltr"
                style={{ ...fieldStyle, height: 42, paddingInlineStart: 36 }}
              />
            </div>
            {debounced.length >= 4 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {results.isLoading && <span style={{ fontSize: 12.5, color: C.mutedFg }}>جارٍ البحث…</span>}
                {!results.isLoading && matches.length === 0 && (
                  <span style={{ fontSize: 12.5, color: C.mutedFg }}>لا ملفّ مطابق — أكمِل الحقول لإنشاء طالب جديد.</span>
                )}
                {matches.length > 1 && (
                  // §٨.٤-٣: لا اختيار تلقائيّ عند تعدّد النتائج — إخوةٌ لوليٍّ واحد يجب ألّا يُدمجوا.
                  <span style={{ fontSize: 12.5, color: "#241900", background: C.amber, borderRadius: 6, padding: "4px 8px", fontWeight: 700 }}>
                    {matches.length} ملفّات مطابقة — اختر الطالب الصحيح بنفسك (لا يُختار تلقائياً).
                  </span>
                )}
                {matches.map((m) => (
                  <button
                    key={m.customerId}
                    onClick={() => pick(m)}
                    style={{ textAlign: "start", padding: "9px 11px", borderRadius: 9, cursor: "pointer", fontFamily: "inherit", border: `1.5px solid ${customerId === m.customerId ? C.primary : C.border}`, background: customerId === m.customerId ? C.primarySoft : C.card, display: "flex", flexDirection: "column", gap: 2 }}
                  >
                    <span style={{ fontSize: 14.5, fontWeight: 700, color: C.fg }}>{m.studentName}</span>
                    <span style={{ fontSize: 12, color: C.mutedFg, direction: "ltr" }}>{m.studentPhone} · ولي الأمر {m.guardianPhone}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* الحقول */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <label style={labelStyle} htmlFor="st-name">اسم الطالب</label>
              <input id="st-name" ref={nameRef} value={studentName} onChange={(e) => setStudentName(e.target.value)} onKeyDown={(e) => onFieldKey(e, phoneRef)} style={fieldStyle} dir="auto" />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <label style={labelStyle} htmlFor="st-phone">هاتف الطالب</label>
              <input id="st-phone" ref={phoneRef} value={studentPhone} onChange={(e) => setStudentPhone(`+964${e.target.value.replace(/\D/g, "").replace(/^964/, "").replace(/^0+/, "")}`)} onKeyDown={(e) => onFieldKey(e, guardianRef)} style={fieldStyle} dir="ltr" placeholder="+9647xxxxxxxxx" />
              {customerId == null && resolved.data?.kind === "LINK" && (
                <button
                  onClick={() => { setSearchBy("student"); setSearchTerm(studentPhone.trim()); }}
                  style={{ textAlign: "start", fontSize: 12, color: "#241900", background: C.amber, borderRadius: 6, padding: "5px 8px", fontWeight: 700, border: "none", cursor: "pointer", fontFamily: "inherit" }}
                >
                  هذا الهاتف مسجَّل لملفٍّ قائم — اضغط لعرضه بدل إنشاء ملفّ ثانٍ.
                </button>
              )}
              {customerId == null && resolved.data?.kind === "AMBIGUOUS" && (
                <button
                  onClick={() => { setSearchBy("student"); setSearchTerm(studentPhone.trim()); }}
                  style={{ textAlign: "start", fontSize: 12, color: "#241900", background: C.amber, borderRadius: 6, padding: "5px 8px", fontWeight: 700, border: "none", cursor: "pointer", fontFamily: "inherit" }}
                >
                  {resolved.data.candidates.length} ملفّات تحمل هذا الهاتف — اضغط لتختار الصحيح بنفسك.
                </button>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <label style={labelStyle} htmlFor="st-guardian">هاتف ولي الأمر</label>
              <input id="st-guardian" ref={guardianRef} value={guardianPhone} onChange={(e) => setGuardianPhone(`+964${e.target.value.replace(/\D/g, "").replace(/^964/, "").replace(/^0+/, "")}`)} onKeyDown={(e) => onFieldKey(e, addressRef)} style={fieldStyle} dir="ltr" placeholder="+9647xxxxxxxxx" />
              {(siblings.data?.count ?? 0) > 0 && (
                <span style={{ fontSize: 12, color: C.mutedFg, display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <Users aria-hidden size={13} /> لهذا الوليّ {siblings.data?.count} طالب مسجَّل — لا تُسجّل الإخوة في ملفٍّ واحد.
                </span>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <label style={labelStyle} htmlFor="st-address">العنوان</label>
              <input id="st-address" ref={addressRef} value={address} onChange={(e) => setAddress(e.target.value)} onKeyDown={(e) => onFieldKey(e)} style={fieldStyle} dir="auto" />
            </div>
          </div>

          {linked && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, background: C.primarySoft, borderRadius: 12, padding: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 13, color: C.fg, fontWeight: 700 }}>مرتبط بملفّ: {linked.studentName}</span>
                <div style={{ flex: 1 }} />
                <button onClick={clearLink} style={{ height: 30, padding: "0 10px", borderRadius: 7, cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, border: `1px solid ${C.border}`, background: C.card, color: C.fg }}>
                  فكّ الارتباط
                </button>
              </div>
              {dirty && (
                // §٨.٤-٥: التعديل يعرض خيارين صريحين — لا يُكتب في الملفّ إلا باختيارٍ واعٍ.
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {(
                    [
                      { key: "UPDATE_PROFILE" as const, label: "تحديث ملفّ الطالب" },
                      { key: "INVOICE_ONLY" as const, label: "لهذه الفاتورة فقط" },
                    ]
                  ).map((o) => (
                    <button
                      key={o.key}
                      onClick={() => setMode(o.key)}
                      style={{ height: 36, padding: "0 12px", borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700, border: `1.5px solid ${mode === o.key ? C.primary : C.border}`, background: mode === o.key ? C.primary : C.card, color: mode === o.key ? C.primaryFg : C.fg }}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: 8, padding: 16, borderTop: `1px solid ${C.border}`, background: C.card }}>
          <button onClick={onCancel} style={{ flex: 1, height: 48, borderRadius: 10, border: `1.5px solid ${C.border}`, background: C.card, color: C.fg, fontFamily: "inherit", fontSize: 15, fontWeight: 700, cursor: "pointer" }}>
            إلغاء
          </button>
          <button onClick={submit} style={{ flex: 2, height: 48, borderRadius: 10, border: "none", background: C.primary, color: C.primaryFg, fontFamily: "inherit", fontSize: 15, fontWeight: 800, cursor: "pointer" }}>
            إضافة للسلة
          </button>
        </div>
      </div>
    </div>
  );
}
