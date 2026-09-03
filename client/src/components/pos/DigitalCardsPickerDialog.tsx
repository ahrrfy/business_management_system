// سلة مزوّد واحدة؛ مرجع واحد مع بقاء كل بطاقة مثيلاً مستقلاً.
import { MoneyInput } from "@/components/form/MoneyInput";
import { AppSelect } from "@/components/ui/AppSelect";
import { D, fmtAr, moneyInput } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";
import { digitalOfferingDescription, normalizeDigitalSaleReference } from "@shared/digitalSale";
import { CreditCard, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { StudentDetailsDialog, type StudentSnapshot } from "./StudentDetailsDialog";

export type PosCard = RouterOutputs["digitalCards"]["pos"]["listCards"][number];
export type ConfirmedCard = RouterOutputs["digitalCards"]["pos"]["confirmCard"];
export type DigitalBasketCapture = {
  providerBasketKey: string;
  providerReference: string;
  lines: { card: ConfirmedCard; student?: StudentSnapshot }[];
};
type DraftLine = { key: string; card: PosCard; quantity: number; student?: StudentSnapshot };
const C = {
  bg: "var(--pos-bg)", card: "var(--pos-card)", border: "var(--pos-border)",
  muted: "var(--pos-muted)", mutedFg: "var(--pos-muted-fg)", fg: "var(--pos-fg)",
  primary: "var(--pos-primary)", primaryFg: "var(--pos-primary-fg)", overlay: "var(--pos-overlay)",
} as const;
const field: CSSProperties = { minHeight: 42, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", background: C.card, color: C.fg, fontFamily: "inherit" };
const button: CSSProperties = { ...field, cursor: "pointer", fontWeight: 700 };
const primary: CSSProperties = { ...button, background: C.primary, color: C.primaryFg, borderColor: C.primary };
const cell: CSSProperties = { padding: "8px 10px", borderBottom: `1px solid ${C.border}`, textAlign: "start" };

export function DigitalCardsPickerDialog({ open, branchId, offline, onClose, onPickBasket, existingReferences = [], existingCardCount = 0 }: {
  open: boolean; branchId: number; offline: boolean; onClose: () => void;
  onPickBasket: (basket: DigitalBasketCapture) => void;
  existingReferences?: { providerId: number; providerReference: string }[];
  existingCardCount?: number;
}) {
  const [providerId, setProviderId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<DraftLine[]>([]);
  const [providerReference, setProviderReference] = useState("");
  const [awaitingStudent, setAwaitingStudent] = useState<PosCard | null>(null);
  const [picking, setPicking] = useState(false);
  const [reporting, setReporting] = useState<PosCard | null>(null);
  const [reportShare, setReportShare] = useState("");
  const [reportNotes, setReportNotes] = useState("");
  // الإغلاق وتبديل الفرع والانقطاع تُبطل الرد المتأخر؛ لا إضافة جزئية.
  const requestRef = useRef(0);
  const busyRef = useRef(false);
  const utils = trpc.useUtils();
  useEffect(() => {
    requestRef.current += 1; busyRef.current = false; setPicking(false);
    if (open) {
      setProviderId(null); setSearch(""); setDraft([]); setProviderReference("");
      setAwaitingStudent(null); setReporting(null); setReportShare(""); setReportNotes("");
    }
    return () => { requestRef.current += 1; };
  }, [open, branchId]);
  useEffect(() => {
    if (offline) { requestRef.current += 1; busyRef.current = false; setPicking(false); setAwaitingStudent(null); }
  }, [offline]);
  const list = trpc.digitalCards.pos.listCards.useQuery({ branchId, category: "ALL" },
    { enabled: open && !offline, staleTime: 0, refetchOnMount: "always", refetchOnWindowFocus: true });
  const providers = useMemo(() => {
    const seen = new Map<number, string>();
    for (const card of list.data ?? []) seen.set(card.providerId, card.providerName);
    return Array.from(seen, ([id, name]) => ({ id, name }));
  }, [list.data]);
  const cards = (list.data ?? []).filter((card) => card.providerId === providerId && card.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const quantity = draft.reduce((n, line) => n + line.quantity, 0);
  const total = draft.reduce((sum, line) => sum.plus(D(line.card.sellPrice ?? 0).times(line.quantity)), D(0));
  const reportMut = trpc.digitalCards.pricing.reportMismatch.useMutation({
    onSuccess: () => { setReporting(null); notify.ok("أُرسل البلاغ للمدير", "السعر الحاليّ لم يتغيّر حتى يُعتمد."); },
    onError: (error) => notify.err(error),
  });
  function close() {
    requestRef.current += 1; busyRef.current = false; setPicking(false); setAwaitingStudent(null); onClose();
  }
  function add(card: PosCard, student?: StudentSnapshot) {
    if (busyRef.current || offline || quantity + existingCardCount >= 50 || card.providerId !== providerId || card.availability !== "READY") return;
    if (card.requiresStudentData && !student) { setAwaitingStudent(card); return; }
    setDraft((previous) => {
      if (previous.reduce((count, line) => count + line.quantity, existingCardCount) >= 50) return previous;
      const existing = !student && previous.find((line) => line.card.offeringId === card.offeringId && !line.student);
      return existing ? previous.map((line) => line.key === existing.key ? { ...line, quantity: line.quantity + 1 } : line)
        : [...previous, { key: crypto.randomUUID(), card, quantity: 1, student }];
    });
  }
  async function addBasket() {
    if (busyRef.current || offline || !draft.length || providerId == null) return;
    const reference = normalizeDigitalSaleReference(providerReference);
    if (!reference) return notify.err("رقم عملية المزوّد مطلوب قبل إضافة السلة");
    if (existingReferences.some((r) => r.providerId === providerId && normalizeDigitalSaleReference(r.providerReference).toLocaleLowerCase("en") === reference.toLocaleLowerCase("en"))) return notify.err("رقم العملية موجود في سلة أخرى للمزوّد نفسه");
    busyRef.current = true; setPicking(true);
    const request = ++requestRef.current;
    try {
      const fresh = new Map<number, ConfirmedCard>();
      for (const line of draft) {
        if (!fresh.has(line.card.offeringId)) fresh.set(line.card.offeringId, await utils.client.digitalCards.pos.confirmCard.query({ branchId, offeringId: line.card.offeringId }));
        if (request !== requestRef.current) return;
      }
      if (draft.some((line) => !D(line.card.sellPrice ?? 0).eq(fresh.get(line.card.offeringId)!.sellPrice))) {
        setDraft((previous) => previous.map((line) => ({ ...line, card: fresh.get(line.card.offeringId)! })));
        notify.warn("تغيّرت أسعار بعض البطاقات", "راجِع الأسعار والإجمالي المحدّثين ثم أضف السلة مجدداً."); return;
      }
      if (draft.some((line) => fresh.get(line.card.offeringId)!.providerId !== providerId || (fresh.get(line.card.offeringId)!.requiresStudentData && !line.student))) {
        notify.err("تغيّرت بيانات البطاقة؛ احذفها من السلة وأعد إضافتها ببياناتها الحالية."); return;
      }
      const checked = await utils.client.digitalCards.pos.validateReference.query({ branchId, offeringId: draft[0].card.offeringId, providerReference: reference });
      if (request !== requestRef.current) return;
      onPickBasket({ providerBasketKey: crypto.randomUUID(), providerReference: checked.providerReference,
        lines: draft.flatMap((line) => Array.from({ length: line.quantity }, () => ({ card: fresh.get(line.card.offeringId)!, student: line.student }))) });
      close();
    } catch (error) { if (request === requestRef.current) notify.err(error); }
    finally { if (request === requestRef.current) { busyRef.current = false; setPicking(false); } }
  }
  if (!open) return null;
  return <div role="dialog" aria-modal="true" aria-label="الكروت والاشتراكات" dir="rtl"
    onKeyDownCapture={(event) => { if (["F2", "F3", "F4", "F9", "F12"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); event.nativeEvent.stopImmediatePropagation(); } }}
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); if (reporting) setReporting(null); else if (awaitingStudent) setAwaitingStudent(null); else close(); } }}
    style={{ position: "fixed", inset: 0, zIndex: 60, background: C.overlay, display: "grid", placeItems: "center", padding: 16 }}>
    <div style={{ width: "min(1100px, 100%)", maxHeight: "92vh", overflowY: "auto", background: C.bg, color: C.fg, border: `1px solid ${C.border}`, borderRadius: 8 }}>
      <header style={{ display: "flex", alignItems: "center", gap: 10, padding: 16, borderBottom: `1px solid ${C.border}` }}><CreditCard aria-hidden size={20} /><strong style={{ flex: 1 }}>الكروت والاشتراكات — سلة المزوّد</strong><button style={button} aria-label="إغلاق" onClick={close}><X aria-hidden size={18} /></button></header>
      {offline ? <p style={{ padding: 24 }}>البيع الرقميّ يحتاج اتصالاً بالخادم — أعد الاتصال لإكمال السلة.</p> : <div style={{ padding: 16, display: "grid", gap: 14 }}>
        <label style={{ display: "grid", gap: 6 }}>المزوّد
          <AppSelect value={providerId == null ? "" : String(providerId)} onValueChange={(value) => setProviderId(value ? Number(value) : null)} disabled={draft.length > 0 || picking} style={field}>
            <option value="">اختر المزوّد أولاً</option>{providers.map((provider) => <option key={provider.id} value={String(provider.id)}>{provider.name}</option>)}
          </AppSelect>
          {draft.length > 0 && <small style={{ color: C.mutedFg }}>كل سلة تخص مزوّداً واحداً. أضف هذه السلة ثم افتح سلة جديدة للمزوّد الآخر.</small>}
        </label>
        <input aria-label="بحث في الكروت" placeholder="ابحث باسم الكرت أو الاشتراك…" value={search} onChange={(event) => setSearch(event.target.value)} style={field} />
        {list.isLoading && <p>{ACTION_LABELS.loading}</p>}
        {list.isError && <div role="alert">تعذّر تحميل البطاقات. تحقّق من الاتصال والصلاحية. <button style={button} onClick={() => void list.refetch()}>إعادة المحاولة</button></div>}
        {!list.isLoading && !list.isError && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 8, maxHeight: 260, overflowY: "auto" }}>
          {cards.map((card) => <div key={card.offeringId} style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: 12, display: "grid", gap: 6, background: C.card }}>
            <strong>{card.name}</strong><small>{digitalOfferingDescription(card)}</small>
            <span>{card.sellPrice == null ? "لا سعر منشور" : `${fmtAr(card.sellPrice)} د.ع`}</span>
            <button style={primary} disabled={picking || quantity + existingCardCount >= 50 || card.availability !== "READY"} onClick={() => add(card)}>{card.availability === "READY" ? "إضافة" : card.availability === "NO_PRICE" ? "لا سعر منشور" : "السعر يحتاج تحديثاً"}</button>
            <button style={{ ...button, minHeight: 30, padding: 4, fontSize: 12 }} onClick={() => { setReporting(card); setReportShare(""); setReportNotes(""); }}>سعر الجهاز مختلف؟</button>
          </div>)}
          {!cards.length && <p style={{ color: C.mutedFg }}>{providerId == null ? "اختر المزوّد لعرض بطاقاته واشتراكاته." : "لا بطاقات مطابقة متاحة لهذا المزوّد."}</p>}
        </div>}
        <section aria-label="البطاقات المختارة" style={{ border: `1px solid ${C.border}`, borderRadius: 6, overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead style={{ background: C.muted }}><tr><th style={cell}>البطاقة / الاشتراك</th><th style={cell}>الكمية</th><th style={cell}>سعر البيع</th><th style={cell}>الإجمالي</th><th style={cell}></th></tr></thead>
            <tbody>{draft.map((line) => <tr key={line.key}>
              <td style={cell}><strong>{line.card.name}</strong><small style={{ display: "block" }}>{digitalOfferingDescription(line.card)}</small>{line.student && <small style={{ display: "block" }}>{line.student.studentName} · <span dir="ltr">{line.student.studentPhone}</span></small>}</td>
              <td style={cell}>{line.student ? <span title="أضف اشتراكاً آخر لإدخال بيانات طالب آخر">1</span> : <input aria-label={`كمية ${line.card.name}`} type="number" min={1} max={50 - existingCardCount} value={line.quantity} disabled={picking} onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isInteger(value) && value > 0 && quantity - line.quantity + value + existingCardCount <= 50) setDraft((previous) => previous.map((item) => item.key === line.key ? { ...item, quantity: value } : item));
              }} style={{ ...field, width: 76 }} />}</td>
              <td style={cell}>{fmtAr(line.card.sellPrice ?? 0)}</td><td style={cell}>{fmtAr(D(line.card.sellPrice ?? 0).times(line.quantity).toFixed(2))}</td>
              <td style={cell}><button style={button} disabled={picking} aria-label={`حذف ${line.card.name}`} onClick={() => setDraft((previous) => previous.filter((item) => item.key !== line.key))}><X aria-hidden size={16} /></button></td>
            </tr>)}{!draft.length && <tr><td colSpan={5} style={cell}>أضف البطاقات وحدّد الكميات؛ رقم العملية واحد لهذه السلة.</td></tr>}</tbody>
          </table>
        </section>
        <label style={{ display: "grid", gap: 5 }}>رقم عملية المزوّد لهذه السلة
          <input value={providerReference} disabled={picking} onChange={(event) => setProviderReference(event.target.value)} maxLength={120} placeholder="امسح أو اكتب رقم العملية الخارجية" dir="ltr" style={field} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void addBasket(); } }} />
          <small style={{ color: C.mutedFg }}>مرجع واحد لجميع بطاقات السلة، للمطابقة مع جهاز المزوّد. لا يوجد تحقق من منصته.</small>
        </label>
        <small style={{ color: C.mutedFg }}>الحد الأقصى 50 بطاقة في الفاتورة؛ المضاف سابقاً: {existingCardCount}.</small>
        <footer style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}><strong style={{ flex: 1 }}>{quantity} بطاقة · الإجمالي {fmtAr(total.toFixed(2))} د.ع</strong><button style={button} onClick={close}>إلغاء</button><button style={primary} disabled={picking || !draft.length || !providerReference.trim()} onClick={() => void addBasket()}>{picking ? ACTION_LABELS.verifying : "إضافة السلة إلى الفاتورة"}</button></footer>
      </div>}
    </div>
    {reporting && <div role="dialog" aria-modal="true" aria-label="بلاغ تغيّر سعر المزوّد" style={{ position: "fixed", inset: 0, zIndex: 62, background: C.overlay, display: "grid", placeItems: "center", padding: 16 }}>
      <div style={{ width: "min(440px, 100%)", background: C.bg, color: C.fg, padding: 20, borderRadius: 8, display: "grid", gap: 12 }}>
        <strong>بلاغ تغيّر سعر المزوّد — {reporting.name}</strong><p>أدخل المبلغ الذي يخصمه جهاز المزوّد. البلاغ لا يغيّر سعر البيع حتى يعتمد المدير السعر.</p>
        <label>حصة المزوّد على الجهاز<MoneyInput value={reportShare} onChange={setReportShare} style={field} /></label><label>ملاحظة (اختياري)<input value={reportNotes} onChange={(event) => setReportNotes(event.target.value)} style={{ ...field, width: "100%" }} /></label>
        <div style={{ display: "flex", gap: 8 }}><button style={button} onClick={() => setReporting(null)}>إلغاء</button><button style={primary} disabled={reportMut.isPending} onClick={() => {
          if (!moneyInput(reportShare).gt(0)) return notify.err("أدخل المبلغ الظاهر على الجهاز");
          reportMut.mutate({ branchId, offeringId: reporting.offeringId, reportedProviderShare: reportShare, notes: reportNotes.trim() || null });
        }}>{reportMut.isPending ? ACTION_LABELS.sending : "إرسال البلاغ"}</button></div>
      </div>
    </div>}
    <StudentDetailsDialog open={awaitingStudent != null} cardName={awaitingStudent?.name ?? ""} onCancel={() => setAwaitingStudent(null)} onConfirm={(student) => { if (awaitingStudent) add(awaitingStudent, student); setAwaitingStudent(null); }} />
  </div>;
}
