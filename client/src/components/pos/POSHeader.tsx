// رأس الكاشير: العلامة + زرّ الكروت + البحث الذكيّ بالمسح + شارة آخر فاتورة.
// استُخرج حرفياً من client/src/pages/POS.tsx (برنامج v2 «السهل الممتنع» م١ — PR-A) بلا تغيير
// سلوكيّ: الصفحةُ العملاقة (٣٧٨٣ سطراً) قُسِّمت مكوّنياً كي تنزل تحت خطّ أساس `check:page-size`
// ومقياس الاحتكاك D4، وتبقى كلّ الحالة المالية عند الأب (POS.tsx) وتصل عبر props.

import type { RouterOutputs } from "@/lib/trpc";
import { useEffect, useRef } from "react";
import { Store, Search, X, CreditCard } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { SHOP, fmt, type PosColors as C } from "./posShared";

export interface POSHeaderProps {
  C: C;
  search: string; setSearch: (s: string) => void;
  showDrop: boolean; setShowDrop: (v: boolean) => void;
  results: RouterOutputs["catalog"]["posList"];
  searching: boolean;
  /** النتائج مطابقة لنص البحث الحالي (لا طلب معلّقاً ولا تأجيلاً) ⇒ Enter آمن */
  searchSettled: boolean;
  addToCart: (row: RouterOutputs["catalog"]["posList"][number]) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  handleScanKeyDown: (e: React.KeyboardEvent<HTMLInputElement>, curVal: string, setValue: (s: string) => void) => void;
  lastInv: { num: string; total: number } | null;
  /** فتح شبكة «الكروت والاشتراكات» (ش٥) — معطَّل أثناء الانقطاع (البيع الرقميّ أونلاين حصراً). */
  onOpenCards: () => void;
  cardsDisabled: boolean;
  cardsDisabledReason?: string;
  branchName: string;
}

export function POSHeader({ C, search, setSearch, showDrop, setShowDrop, results, searching, searchSettled, addToCart, searchRef, handleScanKeyDown, lastInv, onOpenCards, cardsDisabled, cardsDisabledReason, branchName }: POSHeaderProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function h(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setShowDrop(false);
    }
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [setShowDrop]);

  const stockColor = (stock: number) =>
    stock < 5 ? C.danger : stock < 15 ? C.amber : C.mutedFg;

  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, padding: "7px 14px", minHeight: 64, flexShrink: 0, background: C.card, borderBottom: `1px solid ${C.border}`, position: "relative", zIndex: 40 }}>

      {/* Brand */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <div style={{ width: 40, height: 40, borderRadius: "50%", background: C.primary, color: C.primaryFg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Store aria-hidden size={20} /></div>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 800, lineHeight: 1.2, color: C.fg }}>{SHOP}</div>
          <div style={{ fontSize: 11, color: C.mutedFg, lineHeight: 1.2 }}>نقطة البيع</div>
        </div>
      </div>

      <div style={{ width: 1, height: 28, background: C.border, flexShrink: 0 }} />

      {/* الكروت والاشتراكات (ش٥) — مدخل نافذة البطاقات الرقمية داخل نفس نقطة البيع والوردية */}
      <button
        onClick={onOpenCards}
        disabled={cardsDisabled}
        title={cardsDisabled ? cardsDisabledReason : "الكروت والاشتراكات (F3)"}
        style={{
          height: 50, padding: "0 14px", borderRadius: 10, flexShrink: 0, fontFamily: "inherit",
          fontSize: 14, fontWeight: 800, display: "inline-flex", alignItems: "center", gap: 7,
          border: `1.5px solid ${cardsDisabled ? C.border : C.primary}`,
          background: cardsDisabled ? C.muted : C.primarySoft,
          color: cardsDisabled ? C.mutedFg : C.fg,
          cursor: cardsDisabled ? "not-allowed" : "pointer",
        }}
      >
        <CreditCard aria-hidden size={18} /> الكروت والاشتراكات
      </button>

      {/* Search with smart scan */}
      <div ref={wrapRef} style={{ flex: "1 1 460px", minWidth: 240, position: "relative" }}>
        <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
          <span style={{ position: "absolute", right: 13, zIndex: 1, color: C.mutedFg, display: "flex", pointerEvents: "none" }} aria-hidden><Search size={17} /></span>
          <input
            ref={searchRef} autoFocus
            placeholder="ابحث بالاسم أو SKU أو امسح الباركود… (F2)"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setShowDrop(true); }}
            onFocus={(e) => { if (search) setShowDrop(true); e.target.style.borderColor = C.primary; }}
            onBlur={(e) => (e.target.style.borderColor = C.primary)}
            onKeyDown={(e) => {
              handleScanKeyDown(e, search, setSearch);
              if (e.defaultPrevented) return;
              // Enter يضيف أول نتيجة — فقط حين تطابق النتائج نصَّ البحث الحالي
              // (أثناء التأجيل/الجلب قد تكون النتائج لاستعلام أقدم ⇒ إضافة خاطئة).
              if (e.key === "Enter" && searchSettled && results.length > 0) addToCart(results[0]);
              if (e.key === "Escape") { setSearch(""); setShowDrop(false); }
            }}
            style={{ width: "100%", height: 50, border: `2px solid ${C.primary}`, borderRadius: 10, background: C.primarySoft, boxShadow: `inset 0 0 0 1px ${C.primary}22`, color: C.fg, fontFamily: "inherit", fontSize: 14.5, outline: "none", paddingRight: 44, paddingLeft: search ? 44 : 14 }}
          />
          {search && (
            <button onClick={() => { setSearch(""); setShowDrop(false); searchRef.current?.focus(); }}
              aria-label="مسح البحث"
              style={{ position: "absolute", left: 8, background: "none", border: "none", cursor: "pointer", color: C.mutedFg, display: "flex", padding: 4 }}><X aria-hidden size={16} /></button>
          )}
        </div>

        {/* Dropdown — نتائج، أو حالة واضحة (قصير/جارٍ البحث/لا نتائج) بدل الصمت */}
        {showDrop && search.trim().length > 0 && (
          <div style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, left: 0, background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: "0 10px 36px rgb(0 0 0/.18)", zIndex: 60, maxHeight: "60vh", overflowY: "auto" }}>
            {results.length === 0 && (
              <div style={{ padding: "14px 16px", fontSize: 12.5, color: C.mutedFg, textAlign: "center" }}>
                {search.trim().length < 2
                  ? "اكتب حرفين فأكثر للبحث…"
                  : searching
                    ? "جارٍ البحث…"
                    : `لا نتائج لـ «${search.trim()}» — جرّب كلمة أقصر أو امسح الباركود`}
              </div>
            )}
            {results.map((p) => (
              <div key={p.productUnitId} onClick={() => addToCart(p)}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", cursor: "pointer", borderBottom: `1px solid ${C.border}`, minHeight: 60 }}
                onMouseEnter={(e) => (e.currentTarget.style.background = C.muted)}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13.5, color: C.fg }}>
                    {p.productName}
                    {/* شارتا نوع السطر: «خِدمة» معلومة و«أمانة» تنبيهٌ محاسبيّ ⇒ توكنا
                        `--sem-info`/`--sem-warn` مع خلفيّتيهما: زوجٌ مُعايَرٌ على ≥٤.٥:١ نصّاً في
                        الوضعين، بينما زوج الكاشير `C.amber` على `C.amberSoft` يبلغ ~٣.٢:١ في
                        الفاتح فلا يصلح نصّاً هنا. دلالةٌ لا هويّةَ سطحٍ ⇒ لا تكسران لوحة الكاشير. */}
                    {p.isService && (
                      <span style={{ fontSize: 10, fontWeight: 700, color: "var(--sem-info)", background: "var(--sem-info-bg)", padding: "1px 6px", borderRadius: 4, marginRight: 6, verticalAlign: "middle" }}>خِدمة</span>
                    )}
                    {p.isConsignment && (
                      <span style={{ fontSize: 10, fontWeight: 700, color: "var(--sem-warn)", background: "var(--sem-warn-bg)", padding: "1px 6px", borderRadius: 4, marginRight: 6, verticalAlign: "middle" }}>أمانة</span>
                    )}
                  </div>
                  <div style={{ fontSize: 11.5, color: C.mutedFg, marginTop: 2 }}>
                    {p.sku} · {p.unitName}
                    {!p.isService && (
                      <span style={{ marginRight: 10, color: stockColor(p.availableBase ?? p.stockBase) }}>
                        {branchName} · فعلي: {fmt(p.stockBase)} · محجوز: {fmt(p.reservedBase ?? 0)} · متاح للبيع: {fmt(p.availableBase ?? p.stockBase)}
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ textAlign: "left", flexShrink: 0, marginRight: 16 }}>
                  {p.price == null
                    ? <span style={{ fontSize: 12, color: C.danger }}>بلا سعر</span>
                    : <>
                        <div style={{ fontWeight: 900, color: C.primary, fontSize: 17, direction: "ltr" }}>{fmt(Number(p.price))}</div>
                        <div style={{ fontSize: 11, color: C.mutedFg, textAlign: "center" }}>د.ع</div>
                      </>
                  }
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Last invoice badge */}
      {lastInv && (
        <div style={{ display: "flex", alignItems: "center", gap: 4, background: "var(--pos-branch-bg)", border: "1px solid var(--pos-branch-bord)", borderRadius: 8, padding: "3px 6px 3px 12px", flexShrink: 0, lineHeight: 1.3 }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            <span style={{ fontSize: 10, color: C.mutedFg, fontWeight: 600 }}>آخر فاتورة</span>
            <span style={{ fontSize: 15, fontWeight: 900, direction: "ltr", color: C.primary }}>{fmt(lastInv.total)}</span>
            <span style={{ fontSize: 9.5, color: C.mutedFg }}>{lastInv.num}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <CopyButton value={lastInv.num} title="نسخ رقم آخر فاتورة" successMessage="تم نسخ رقم الفاتورة" />
            <CopyButton value={lastInv.total} title="نسخ إجمالي آخر فاتورة" successMessage="تم نسخ الإجمالي" />
          </div>
        </div>
      )}

    </div>
  );
}
