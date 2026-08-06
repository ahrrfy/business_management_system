// نافذة خطوات التنفيذ الخارجيّ (ش٧). تُفتح بعد `prepare` وتعرض الكروت **واحداً واحداً**:
// الموظّف يُصدر الكرت من جهاز المزوّد، يُدخل المرجع إن لزم، ثم يضغط «نجح التنفيذ» فيُسجَّل فوراً.
//
// الضمان الحاكم (§٨.٧): بعد تسجيل نجاحٍ واحد **لا يُتجاهَل شيء**. Escape لا يُغلق النافذة بصمت،
// بل يعرض تحذير المراجعة — لأن الكرت صدر فعلاً وله أثرٌ ماليّ مستحقّ.
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { AlertTriangle, Check, CircleHelp, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type IntentData = RouterOutputs["digitalCards"]["sales"]["getIntent"];
type IntentItem = IntentData["items"][number];

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
  success: "var(--pos-success)",
  amber: "var(--pos-amber)",
  amberSoft: "var(--pos-amber-soft)",
  danger: "var(--pos-danger)",
  dangerSoft: "var(--pos-danger-soft)",
  overlay: "var(--pos-overlay)",
} as const;

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

const STATUS_LABEL: Record<string, string> = {
  PENDING: "بانتظار التنفيذ",
  SUCCESS: "نُفِّذ",
  FAILED: "فشل",
  UNKNOWN: "غير مؤكَّد",
};

export function DigitalFulfillmentDialog({
  intentId,
  onClose,
  onAllExecuted,
}: {
  intentId: number | null;
  /** يُستدعى فقط حين يجوز الإغلاق (لا كرت نُفِّذ بعد، أو بعد إقرار المراجعة). */
  onClose: () => void;
  /** كل البنود نُفِّذت بنجاح — تثبيت الفاتورة يتولّاه المستدعي. */
  onAllExecuted: (intentId: number) => void;
}) {
  const utils = trpc.useUtils();
  const [reference, setReference] = useState("");
  const [warnLeave, setWarnLeave] = useState(false);
  const [activeClaim, setActiveClaim] = useState<{
    intentItemId: number;
    claimToken: string;
    providerIdempotencyKey: string;
    expiresAt: Date | string;
  } | null>(null);
  const refInput = useRef<HTMLInputElement>(null);

  const q = trpc.digitalCards.sales.getIntent.useQuery(
    { intentId: intentId ?? 0 },
    { enabled: intentId != null, refetchOnWindowFocus: false },
  );

  const claim = trpc.digitalCards.sales.claimExecution.useMutation({
    onSuccess: (r) => {
      setActiveClaim(r);
      setTimeout(() => refInput.current?.focus(), 40);
    },
    onError: (e) => notify.err(e),
  });
  const mark = trpc.digitalCards.sales.markExecution.useMutation({
    onSuccess: () => { setReference(""); setActiveClaim(null); void utils.digitalCards.sales.getIntent.invalidate(); },
    onError: (e) => notify.err(e),
  });
  const cancel = trpc.digitalCards.sales.cancelIntent.useMutation({
    onSuccess: (r) => {
      void utils.digitalCards.sales.getIntent.invalidate();
      if (r.outcome === "NEEDS_REVIEW") {
        notify.errBig("انتقلت العملية إلى طابور المراجعة", "كرتٌ صدر فعلاً — لا تُهمَل؛ يعالجها المدير.");
      } else {
        notify.ok("أُلغيت العملية وحُرّر رصيد المحفظة");
      }
      onClose();
    },
    onError: (e) => notify.err(e),
  });

  const items = q.data?.items ?? [];
  const current = items.find((i) => i.fulfillmentStatus === "PENDING") ?? null;
  const anySuccess = items.some((i) => i.fulfillmentStatus === "SUCCESS");
  const allSuccess = items.length > 0 && items.every((i) => i.fulfillmentStatus === "SUCCESS");
  const settledNotAllSuccess = items.length > 0 && !current && !allSuccess;

  useEffect(() => {
    setReference("");
    setActiveClaim(null);
  }, [current?.id]);

  useEffect(() => {
    if (allSuccess && intentId != null) onAllExecuted(intentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allSuccess, intentId]);

  function attemptClose() {
    // §٨.٧: قبل أيّ تنفيذ يجوز التراجع؛ بعده لا تجاهُل — تحذير مراجعة صريح.
    if (anySuccess || activeClaim != null) { setWarnLeave(true); return; }
    if (intentId != null) cancel.mutate({ intentId, reason: "cashier-cancel" });
    else onClose();
  }

  function submit(status: "SUCCESS" | "FAILED" | "UNKNOWN") {
    if (!current || intentId == null || !activeClaim || activeClaim.intentItemId !== current.id || mark.isPending) return;
    if (status === "SUCCESS" && current.referencePolicy === "REQUIRED" && !reference.trim()) {
      notify.err("هذا المزوّد يتطلّب رقم مرجع التنفيذ");
      refInput.current?.focus();
      return;
    }
    mark.mutate({
      intentId,
      intentItemId: current.id,
      claimToken: activeClaim.claimToken,
      status,
      providerReference: current.referencePolicy === "NONE" ? null : reference.trim() || null,
    });
  }

  function beginIssuance() {
    if (!current || intentId == null || claim.isPending) return;
    const cryptoApi = globalThis.crypto;
    if (!cryptoApi?.getRandomValues) {
      notify.err("تعذّر إنشاء رمز إصدار آمن؛ حدّث المتصفح ثم أعد المحاولة");
      return;
    }
    const claimToken = typeof cryptoApi.randomUUID === "function"
      ? cryptoApi.randomUUID()
      : Array.from(cryptoApi.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
    claim.mutate({ intentId, intentItemId: current.id, claimToken });
  }

  if (intentId == null) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="تنفيذ الكروت"
      onKeyDownCapture={(e) => {
        if (!["F2", "F3", "F4", "F9", "F12"].includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
      }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); attemptClose(); } }}
      style={{ position: "fixed", inset: 0, background: C.overlay, zIndex: 64, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
    >
      <div style={{ width: "min(720px, 100%)", maxHeight: "min(90vh, 880px)", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 14, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "12px 16px", borderBottom: `1px solid ${C.border}`, background: C.card }}>
          <span style={{ fontWeight: 800, fontSize: 16, color: C.fg }}>تنفيذ الكروت من جهاز المزوّد</span>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 12.5, color: C.mutedFg }}>
            {items.filter((i) => i.fulfillmentStatus !== "PENDING").length} / {items.length}
          </span>
          <button onClick={attemptClose} aria-label="إغلاق" style={{ width: 40, height: 40, border: "none", background: "none", cursor: "pointer", color: C.mutedFg, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
            <X aria-hidden size={20} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
          {q.isLoading && <div style={{ textAlign: "center", color: C.mutedFg, padding: 24 }}>جارٍ التحميل…</div>}

          {current && (
            <div style={{ background: C.primarySoft, border: `1.5px solid ${C.primary}`, borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
              <span style={{ fontSize: 12.5, color: C.mutedFg, fontWeight: 700 }}>الكرت الحالي</span>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: 19, fontWeight: 900, color: C.fg }}>{current.name}</span>
                <span style={{ fontSize: 13, color: C.mutedFg }}>{current.providerName}</span>
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 22, fontWeight: 900, color: C.fg, direction: "ltr" }}>{fmt(Number(current.sellPrice))}</span>
              </div>
              {current.studentName && (
                <span style={{ fontSize: 13, color: C.fg }}>الطالب: {current.studentName}</span>
              )}

              {!activeClaim && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <span style={{ fontSize: 13.5, color: C.fg, lineHeight: 1.6 }}>
                    اضغط البدء أولاً، ثم أصدر هذه البطاقة مرة واحدة فقط من جهاز المزوّد. إذا كانت مفتوحة في نافذة أخرى سيمنعك النظام.
                  </span>
                  <button
                    onClick={beginIssuance}
                    disabled={claim.isPending}
                    style={{ height: 52, borderRadius: 10, border: "none", background: C.primary, color: C.primaryFg, fontFamily: "inherit", fontSize: 16, fontWeight: 900, cursor: claim.isPending ? "not-allowed" : "pointer" }}
                  >
                    {claim.isPending ? "جارٍ حجز الإصدار…" : "ابدأ إصدار البطاقة"}
                  </button>
                </div>
              )}

              {activeClaim && current.referencePolicy !== "NONE" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <label style={{ fontSize: 13, fontWeight: 700, color: C.fg }} htmlFor="fulfil-ref">
                    مرجع التنفيذ {current.referencePolicy === "REQUIRED" ? "(مطلوب)" : "(اختياري)"}
                  </label>
                  <input
                    id="fulfil-ref"
                    ref={refInput}
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit("SUCCESS"); } }}
                    placeholder="رقم العملية على جهاز المزوّد"
                    dir="ltr"
                    style={{ height: 46, padding: "0 12px", borderRadius: 10, border: `1.5px solid ${C.border}`, background: C.card, color: C.fg, fontSize: 15, fontFamily: "inherit", outline: "none" }}
                  />
                </div>
              )}

              {activeClaim && <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  onClick={() => submit("SUCCESS")}
                  disabled={mark.isPending}
                  style={{ flex: 2, minWidth: 160, height: 50, borderRadius: 10, border: "none", background: C.success, color: "#fff", fontFamily: "inherit", fontSize: 15.5, fontWeight: 800, cursor: mark.isPending ? "not-allowed" : "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7 }}
                >
                  <Check aria-hidden size={18} /> نجح التنفيذ
                </button>
                <button
                  onClick={() => submit("FAILED")}
                  disabled={mark.isPending}
                  style={{ flex: 1, minWidth: 120, height: 50, borderRadius: 10, border: `1.5px solid ${C.danger}`, background: C.card, color: C.danger, fontFamily: "inherit", fontSize: 14.5, fontWeight: 800, cursor: "pointer" }}
                >
                  فشل
                </button>
                <button
                  onClick={() => submit("UNKNOWN")}
                  disabled={mark.isPending}
                  title="الجهاز لم يُظهر نتيجة واضحة — تُراجَع إدارياً"
                  style={{ flex: 1, minWidth: 120, height: 50, borderRadius: 10, border: `1.5px solid ${C.amber}`, background: C.card, color: C.fg, fontFamily: "inherit", fontSize: 14.5, fontWeight: 800, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 }}
                >
                  <CircleHelp aria-hidden size={16} /> غير مؤكَّد
                </button>
              </div>}
            </div>
          )}

          {allSuccess && (
            <div style={{ background: C.primarySoft, border: `1.5px solid ${C.primary}`, borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 15.5, fontWeight: 800, color: C.fg }}>كل الكروت نُفِّذت بنجاح</span>
              <span style={{ fontSize: 13, color: C.mutedFg }}>جارٍ تثبيت الفاتورة وتحصيل المبلغ…</span>
            </div>
          )}

          {settledNotAllSuccess && (
            <div style={{ background: C.amberSoft, border: `1.5px solid ${C.amber}`, borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 15, fontWeight: 800, color: C.fg, display: "inline-flex", alignItems: "center", gap: 7 }}>
                <AlertTriangle aria-hidden size={17} /> بعض الكروت لم تُنفَّذ
              </span>
              <span style={{ fontSize: 13, color: C.fg }}>
                لا تُنشأ فاتورة ما لم تنجح كل البنود. ما صدر فعلاً مسجَّلٌ وينتقل إلى طابور المراجعة الإدارية.
              </span>
            </div>
          )}

          {/* سجلّ البنود */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {items.map((it: IntentItem) => {
              const done = it.fulfillmentStatus === "SUCCESS";
              const bad = it.fulfillmentStatus === "FAILED";
              const unk = it.fulfillmentStatus === "UNKNOWN";
              return (
                <div
                  key={it.id}
                  style={{
                    display: "flex", alignItems: "center", gap: 9, padding: "9px 12px", borderRadius: 9,
                    border: `1px solid ${done ? C.success : bad ? C.danger : unk ? C.amber : C.border}`,
                    background: done ? C.card : bad ? C.dangerSoft : unk ? C.amberSoft : C.muted,
                    opacity: it.id === current?.id ? 1 : 0.92,
                  }}
                >
                  <span style={{ fontSize: 14, fontWeight: 700, color: C.fg, flex: 1, minWidth: 0 }}>
                    {it.name}
                    {it.studentName ? ` — ${it.studentName}` : ""}
                  </span>
                  {it.providerReference && (
                    <span style={{ fontSize: 11.5, color: C.mutedFg, direction: "ltr", fontFamily: "monospace" }}>{it.providerReference}</span>
                  )}
                  <span style={{ fontSize: 12, fontWeight: 800, color: done ? C.success : bad ? C.danger : C.mutedFg, whiteSpace: "nowrap" }}>
                    {STATUS_LABEL[it.fulfillmentStatus] ?? it.fulfillmentStatus}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, padding: 16, borderTop: `1px solid ${C.border}`, background: C.card }}>
          <button
            onClick={attemptClose}
            disabled={cancel.isPending}
            style={{ flex: 1, height: 48, borderRadius: 10, border: `1.5px solid ${C.border}`, background: C.card, color: C.fg, fontFamily: "inherit", fontSize: 15, fontWeight: 700, cursor: "pointer" }}
          >
            {anySuccess || activeClaim ? "إنهاء ونقل للمراجعة" : "إلغاء العملية"}
          </button>
        </div>
      </div>

      {/* تحذير المراجعة — لا تجاهُل بعد تنفيذٍ فعليّ */}
      {warnLeave && (
        <div style={{ position: "fixed", inset: 0, background: C.overlay, zIndex: 65, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{ width: "min(440px, 100%)", background: C.bg, border: `1.5px solid ${C.amber}`, borderRadius: 14, padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
            <span style={{ fontSize: 16, fontWeight: 800, color: C.fg, display: "inline-flex", alignItems: "center", gap: 8 }}>
              <AlertTriangle aria-hidden size={19} /> بدأ إصدار بطاقة
            </span>
            <span style={{ fontSize: 13.5, color: C.fg, lineHeight: 1.6 }}>
              بدأ إصدار بطاقة أو سُجّل نجاح بطاقة واحدة على الأقل، لذلك لا يجوز تجاهل العملية. ستنتقل إلى طابور المراجعة
              الإدارية ويبقى أثرها المالي محفوظاً حتى لو أُغلق المتصفح.
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => setWarnLeave(false)}
                style={{ flex: 1, height: 46, borderRadius: 10, border: `1.5px solid ${C.border}`, background: C.card, color: C.fg, fontFamily: "inherit", fontSize: 15, fontWeight: 700, cursor: "pointer" }}
              >
                متابعة التنفيذ
              </button>
              <button
                onClick={() => { setWarnLeave(false); if (intentId != null) cancel.mutate({ intentId, reason: "cashier-abandoned-after-execution" }); }}
                disabled={cancel.isPending}
                style={{ flex: 1, height: 46, borderRadius: 10, border: "none", background: C.amber, color: "#241900", fontFamily: "inherit", fontSize: 15, fontWeight: 800, cursor: "pointer" }}
              >
                نقلها للمراجعة
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
