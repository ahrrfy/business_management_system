// نافذة «الكروت والاشتراكات» داخل نقطة البيع (ش٥).
// تعرض السعر فقط — الخادم لا يرسل تكلفةً ولا هامشاً ولا رصيد محفظة أصلاً (posCards.ts).
// الضغط على بطاقة يؤكّد سعرها من الخادم ثم يضيف **مثيلاً مستقلاً** للسلة بمفتاح سطر خاص،
// لأن بيع كرتين من الفئة نفسها يحتاج مرجعَي تنفيذ منفصلين (§٨.٣).
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { CreditCard, GraduationCap, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { StudentDetailsDialog, type StudentSnapshot } from "./StudentDetailsDialog";

export type PosCard = RouterOutputs["digitalCards"]["pos"]["listCards"][number];
export type ConfirmedCard = RouterOutputs["digitalCards"]["pos"]["confirmCard"];

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

type Category = "FAVORITES" | "TELECOM" | "GLOBAL" | "EDUCATIONAL" | "ALL";

const TABS: { key: Category; label: string }[] = [
  { key: "FAVORITES", label: "الأكثر استخداماً" },
  { key: "TELECOM", label: "اتصالات" },
  { key: "GLOBAL", label: "عالمية" },
  { key: "EDUCATIONAL", label: "تعليمية" },
  { key: "ALL", label: "الكل" },
];

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

export function DigitalCardsPickerDialog({
  open,
  branchId,
  offline,
  onClose,
  onPick,
}: {
  open: boolean;
  branchId: number;
  /** أثناء الانقطاع لا بيع رقميّ إطلاقاً — الشبكة والأسعار تأتيان من الخادم حصراً. */
  offline: boolean;
  onClose: () => void;
  onPick: (card: ConfirmedCard, student?: StudentSnapshot) => void;
}) {
  const [category, setCategory] = useState<Category>("FAVORITES");
  const [providerId, setProviderId] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [confirming, setConfirming] = useState<PosCard | null>(null);
  /** الكرت المؤكَّد سعره والمنتظِر بيانات الطالب (اشتراك تعليميّ) — §٨.٣. */
  const [awaitingStudent, setAwaitingStudent] = useState<ConfirmedCard | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 200);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (open) {
      setQ(""); setDebouncedQ(""); setConfirming(null); setAwaitingStudent(null);
      setReporting(null); setReportShare(""); setReportNotes("");
      setTimeout(() => searchRef.current?.focus(), 40);
    }
  }, [open]);

  const list = trpc.digitalCards.pos.listCards.useQuery(
    { branchId, category, providerId: providerId ?? undefined, q: debouncedQ || undefined },
    { enabled: open && !offline },
  );

  const utils = trpc.useUtils();
  const [picking, setPicking] = useState(false);

  // بلاغ «سعر الجهاز مختلف» (§٧.٥): الكاشير يرى شاشة جهاز المزوّد فيلاحظ تغيّر الحصة قبل المدير.
  // البلاغ **لا يغيّر سعراً** — يفتح قراراً لدى المدير في تبويب «أسعار اليوم».
  const [reporting, setReporting] = useState<PosCard | null>(null);
  const [reportShare, setReportShare] = useState("");
  const [reportNotes, setReportNotes] = useState("");
  const reportMut = trpc.digitalCards.pricing.reportMismatch.useMutation({
    onSuccess: () => {
      setReporting(null); setReportShare(""); setReportNotes("");
      notify.ok("أُرسل البلاغ للمدير", "السعر الحاليّ لم يتغيّر — البيع يستمرّ به حتى يُعتمد.");
    },
    onError: (e) => notify.err(e),
  });

  const cards = list.data ?? [];
  // قائمة المزوّدين تُبنى من نتيجة «كل المزوّدين» كي لا تختفي الأزرار بمجرّد التصفية بأحدهم.
  const allForBranch = trpc.digitalCards.pos.listCards.useQuery(
    { branchId, category: "ALL" },
    { enabled: open && !offline },
  );
  const providers = useMemo(() => {
    const seen = new Map<number, string>();
    for (const c of allForBranch.data ?? []) seen.set(c.providerId, c.providerName);
    return Array.from(seen, ([id, name]) => ({ id, name }));
  }, [allForBranch.data]);

  async function confirmAndAdd(card: PosCard) {
    if (picking) return;
    setPicking(true);
    try {
      // السعر يُعاد تأكيده من الخادم لحظة الإضافة — لا نثق بما عُرض قبل ثوانٍ.
      const fresh = await utils.digitalCards.pos.confirmCard.fetch({ branchId, offeringId: card.offeringId });
      if (fresh.requiresStudentData) {
        // تأكيد السعر ثم بيانات الطالب ثم الإضافة (لا يُضاف سطرٌ تعليميّ بلا بياناته).
        setConfirming(null);
        setAwaitingStudent(fresh);
        return;
      }
      onPick(fresh);
      setConfirming(null);
      onClose();
    } catch (e) {
      notify.err(e);
    } finally {
      setPicking(false);
    }
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="الكروت والاشتراكات"
      onClick={(e) => { if (e.target === e.currentTarget && !confirming && !reporting) onClose(); }}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        if (reporting) setReporting(null);
        else if (confirming) setConfirming(null);
        else onClose();
      }}
      style={{
        position: "fixed", inset: 0, background: C.overlay, zIndex: 60,
        display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(1100px, 100%)", maxHeight: "min(88vh, 900px)", background: C.bg,
          border: `1px solid ${C.border}`, borderRadius: 14, display: "flex", flexDirection: "column",
          overflow: "hidden", boxShadow: "0 24px 64px rgba(0,0,0,.35)",
        }}
      >
        {/* الرأس */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: `1px solid ${C.border}`, background: C.card }}>
          <CreditCard aria-hidden size={20} color={C.primary} />
          <span style={{ fontWeight: 800, fontSize: 17, color: C.fg }}>الكروت والاشتراكات</span>
          <div style={{ flex: 1 }} />
          <button
            onClick={onClose}
            aria-label="إغلاق"
            style={{ width: 40, height: 40, border: "none", background: "none", cursor: "pointer", color: C.mutedFg, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
          >
            <X aria-hidden size={20} />
          </button>
        </div>

        {offline ? (
          <div style={{ padding: 40, textAlign: "center", color: C.mutedFg, fontSize: 15 }}>
            البيع الرقميّ يحتاج اتصالاً بالخادم — السعر والتنفيذ لا يُعملان دون اتصال.
          </div>
        ) : (
          <>
            {/* البحث + التبويبات + مرشّح المزوّد */}
            <div style={{ padding: "10px 16px", display: "flex", flexDirection: "column", gap: 10, borderBottom: `1px solid ${C.border}` }}>
              <div style={{ position: "relative" }}>
                <Search aria-hidden size={17} style={{ position: "absolute", insetInlineStart: 12, top: "50%", transform: "translateY(-50%)", color: C.mutedFg }} />
                <input
                  ref={searchRef}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="ابحث باسم الكرت أو المزوّد…"
                  aria-label="بحث في الكروت"
                  style={{
                    width: "100%", height: 44, paddingInlineStart: 38, paddingInlineEnd: 12,
                    border: `1.5px solid ${C.border}`, borderRadius: 10, background: C.card,
                    color: C.fg, fontSize: 15, fontFamily: "inherit",
                  }}
                />
              </div>

              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {TABS.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => setCategory(t.key)}
                    style={{
                      height: 38, padding: "0 14px", borderRadius: 9, cursor: "pointer", fontFamily: "inherit",
                      fontSize: 14, fontWeight: 700,
                      border: `1.5px solid ${category === t.key ? C.primary : C.border}`,
                      background: category === t.key ? C.primary : C.card,
                      color: category === t.key ? C.primaryFg : C.fg,
                    }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {providers.length > 1 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ fontSize: 12.5, color: C.mutedFg }}>المزوّد:</span>
                  <button
                    onClick={() => setProviderId(null)}
                    style={{
                      height: 32, padding: "0 12px", borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 13,
                      border: `1px solid ${providerId == null ? C.primary : C.border}`,
                      background: providerId == null ? C.primarySoft : C.card, color: C.fg,
                    }}
                  >
                    الكل
                  </button>
                  {providers.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setProviderId(providerId === p.id ? null : p.id)}
                      style={{
                        height: 32, padding: "0 12px", borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 13,
                        border: `1px solid ${providerId === p.id ? C.primary : C.border}`,
                        background: providerId === p.id ? C.primarySoft : C.card, color: C.fg,
                      }}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* الشبكة */}
            <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
              {list.isLoading && <div style={{ textAlign: "center", color: C.mutedFg, padding: 30 }}>جارٍ التحميل…</div>}
              {!list.isLoading && cards.length === 0 && (
                <div style={{ textAlign: "center", color: C.mutedFg, padding: 30, fontSize: 14.5 }}>
                  {debouncedQ ? "لا نتائج مطابقة." : "لا بطاقات متاحة في هذا القسم لهذا الفرع."}
                </div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 12 }}>
                {cards.map((card) => {
                  const ready = card.availability === "READY";
                  return (
                    <button
                      key={card.offeringId}
                      onClick={() => ready && setConfirming(card)}
                      disabled={!ready}
                      style={{
                        textAlign: "start", padding: 12, borderRadius: 12, fontFamily: "inherit",
                        border: `1.5px solid ${ready ? C.border : C.amber}`,
                        background: ready ? C.card : C.amberSoft,
                        cursor: ready ? "pointer" : "not-allowed",
                        display: "flex", flexDirection: "column", gap: 6, minHeight: 118,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {card.offeringType === "EDUCATIONAL_SUBSCRIPTION" && (
                          <GraduationCap aria-hidden size={15} color={C.primary} />
                        )}
                        <span style={{ fontSize: 11.5, color: C.mutedFg, fontWeight: 600 }}>{card.providerName}</span>
                      </div>
                      <span style={{ fontSize: 15, fontWeight: 800, color: C.fg, lineHeight: 1.3 }}>{card.name}</span>
                      <div style={{ flex: 1 }} />
                      {ready ? (
                        <span style={{ fontSize: 20, fontWeight: 900, color: C.fg, direction: "ltr" }}>
                          {fmt(Number(card.sellPrice))}
                        </span>
                      ) : (
                        <span style={{ fontSize: 12.5, fontWeight: 800, color: "#241900", background: C.amber, borderRadius: 6, padding: "3px 8px", alignSelf: "flex-start" }}>
                          {card.availability === "NO_PRICE" ? "لا سعر منشور" : "السعر يحتاج تحديثاً"}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>

      {/* تأكيد السعر */}
      {confirming && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "fixed", inset: 0, background: C.overlay, zIndex: 61,
            display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
          }}
        >
          <div style={{ width: "min(400px, 100%)", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 14, padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
            <span style={{ fontSize: 16, fontWeight: 800, color: C.fg }}>تأكيد إضافة الكرت</span>
            <div style={{ background: C.muted, borderRadius: 10, padding: 14, display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: C.fg }}>{confirming.name}</span>
              <span style={{ fontSize: 12.5, color: C.mutedFg }}>{confirming.providerName}</span>
              <span style={{ fontSize: 26, fontWeight: 900, color: C.fg, direction: "ltr" }}>
                {fmt(Number(confirming.sellPrice))} <span style={{ fontSize: 13, fontWeight: 600, color: C.mutedFg }}>د.ع</span>
              </span>
            </div>
            {confirming.requiresStudentData && (
              <span style={{ fontSize: 12.5, color: C.mutedFg }}>
                اشتراك تعليمي — ستُطلب بيانات الطالب قبل إتمام البيع.
              </span>
            )}
            <button
              onClick={() => { setReporting(confirming); setConfirming(null); }}
              style={{ alignSelf: "flex-start", border: "none", background: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 700, color: C.primary, textDecoration: "underline" }}
            >
              سعر الجهاز مختلف؟ أبلِغ المدير
            </button>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => setConfirming(null)}
                style={{ flex: 1, height: 46, borderRadius: 10, border: `1.5px solid ${C.border}`, background: C.card, color: C.fg, fontFamily: "inherit", fontSize: 15, fontWeight: 700, cursor: "pointer" }}
              >
                إلغاء
              </button>
              <button
                autoFocus
                onClick={() => void confirmAndAdd(confirming)}
                disabled={picking}
                style={{ flex: 1, height: 46, borderRadius: 10, border: "none", background: picking ? C.muted : C.primary, color: picking ? C.mutedFg : C.primaryFg, fontFamily: "inherit", fontSize: 15, fontWeight: 800, cursor: picking ? "not-allowed" : "pointer" }}
              >
                {picking ? "جارٍ الإضافة…" : "إضافة للسلة"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* بلاغ تغيّر سعر المزوّد — يفتح قراراً لدى المدير ولا يمسّ السعر النافذ. */}
      {reporting && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{ position: "fixed", inset: 0, background: C.overlay, zIndex: 61, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
        >
          <div style={{ width: "min(420px, 100%)", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 14, padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
            <span style={{ fontSize: 16, fontWeight: 800, color: C.fg }}>بلاغ تغيّر سعر المزوّد</span>
            <span style={{ fontSize: 13, color: C.mutedFg, lineHeight: 1.6 }}>
              {reporting.name} — أدخِل المبلغ الذي يخصمه <strong>جهاز المزوّد</strong> فعلاً الآن. البلاغ لا يغيّر
              سعر البيع؛ يراه المدير في «أسعار اليوم» فيعتمده أو يرفضه.
            </span>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <label style={{ fontSize: 13, fontWeight: 700, color: C.fg }} htmlFor="dc-report-share">حصة المزوّد على الجهاز</label>
              <input
                id="dc-report-share"
                value={reportShare}
                onChange={(e) => setReportShare(e.target.value.replace(/[^\d.]/g, ""))}
                inputMode="decimal"
                dir="ltr"
                autoFocus
                style={{ width: "100%", height: 46, padding: "0 12px", borderRadius: 10, border: `1.5px solid ${C.border}`, background: C.card, color: C.fg, fontSize: 16, fontFamily: "inherit", outline: "none" }}
              />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <label style={{ fontSize: 13, fontWeight: 700, color: C.fg }} htmlFor="dc-report-notes">ملاحظة (اختياري)</label>
              <input
                id="dc-report-notes"
                value={reportNotes}
                onChange={(e) => setReportNotes(e.target.value)}
                dir="auto"
                style={{ width: "100%", height: 46, padding: "0 12px", borderRadius: 10, border: `1.5px solid ${C.border}`, background: C.card, color: C.fg, fontSize: 15, fontFamily: "inherit", outline: "none" }}
              />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => { setReporting(null); setReportShare(""); setReportNotes(""); }}
                style={{ flex: 1, height: 46, borderRadius: 10, border: `1.5px solid ${C.border}`, background: C.card, color: C.fg, fontFamily: "inherit", fontSize: 15, fontWeight: 700, cursor: "pointer" }}
              >
                إلغاء
              </button>
              <button
                disabled={reportMut.isPending}
                onClick={() => {
                  if (!reporting) return;
                  if (!reportShare || Number(reportShare) <= 0) return notify.err("أدخِل المبلغ الظاهر على الجهاز");
                  reportMut.mutate({
                    branchId,
                    offeringId: reporting.offeringId,
                    reportedProviderShare: reportShare,
                    notes: reportNotes.trim() || null,
                  });
                }}
                style={{ flex: 1, height: 46, borderRadius: 10, border: "none", background: reportMut.isPending ? C.muted : C.primary, color: reportMut.isPending ? C.mutedFg : C.primaryFg, fontFamily: "inherit", fontSize: 15, fontWeight: 800, cursor: reportMut.isPending ? "not-allowed" : "pointer" }}
              >
                {reportMut.isPending ? "جارٍ الإرسال…" : "إرسال البلاغ"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* بيانات الطالب للاشتراك التعليميّ — لا كتابة في القاعدة، لقطةٌ تُحمَل في سطر السلة (ش٦). */}
      <StudentDetailsDialog
        open={awaitingStudent != null}
        cardName={awaitingStudent?.name ?? ""}
        onCancel={() => setAwaitingStudent(null)}
        onConfirm={(snapshot) => {
          if (!awaitingStudent) return;
          onPick(awaitingStudent, snapshot);
          setAwaitingStudent(null);
          onClose();
        }}
      />
    </div>
  );
}
