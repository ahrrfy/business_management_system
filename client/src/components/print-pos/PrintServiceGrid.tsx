import { useMemo } from "react";
import { Flame, Search } from "lucide-react";
import { categoryIcon, isCustomPriceSku, serviceIcon } from "@/lib/printServices";
import { normalizeSearchText } from "@shared/searchNormalize";
import type { RouterOutputs } from "@/lib/trpc";

type Svc = RouterOutputs["printPos"]["services"][number];

export interface PrintServiceColors {
  card: string;
  border: string;
  primary: string;
  primaryFg: string;
  primarySoft: string;
  muted: string;
  mutedFg: string;
  fg: string;
  amber: string;
}

export interface PrintServiceGridProps {
  C: PrintServiceColors;
  services: Svc[];
  loading: boolean;
  cats: { id: number; name: string }[];
  catId: number | null;
  setCatId: (id: number) => void;
  search: string;
  onAdd: (s: Svc) => void;
  recentIds: number[];
}

const fmt = (n: number) => Number(n || 0).toLocaleString("en-US");

export function ServiceCard({
  C,
  s,
  onAdd,
  hot,
}: {
  C: PrintServiceColors;
  s: Svc;
  onAdd: (s: Svc) => void;
  hot?: boolean;
}) {
  const custom = isCustomPriceSku(s.sku);
  const accent = hot ? C.amber : C.primary;
  const accentSoft = hot ? `color-mix(in oklch, ${C.amber} 12%, transparent)` : C.primarySoft;

  return (
    <button
      onClick={() => onAdd(s)}
      title={`${s.productName} — ${s.unitName}${s.price == null ? "" : ` — ${fmt(Number(s.price))} د.ع`}`}
      style={{
        height: 120,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        justifyContent: "space-between",
        padding: "10px 12px",
        borderRadius: 12,
        cursor: "pointer",
        fontFamily: "inherit",
        textAlign: "right",
        background: hot ? `linear-gradient(180deg, ${accentSoft} 0%, ${C.card} 60%)` : C.card,
        border: `${hot ? 2 : 1.5}px solid ${hot ? accent : C.border}`,
        transition: "transform .07s, border-color .1s, box-shadow .1s",
        boxShadow: hot ? `0 2px 10px ${accentSoft}` : "none",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = accent;
        e.currentTarget.style.boxShadow = `0 6px 18px ${accentSoft}`;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = hot ? accent : C.border;
        e.currentTarget.style.boxShadow = hot ? `0 2px 10px ${accentSoft}` : "none";
      }}
      onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.96)")}
      onMouseUp={(e) => (e.currentTarget.style.transform = "")}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 32,
            height: 32,
            borderRadius: 8,
            background: accentSoft,
            color: accent,
            flexShrink: 0,
          }}
        >
          {(() => {
            const SIcon = serviceIcon(s.sku);
            return <SIcon aria-hidden size={20} strokeWidth={1.8} />;
          })()}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "flex-end" }}>
          {hot && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                fontSize: 9.5,
                fontWeight: 800,
                color: C.amber,
                background: `color-mix(in oklch, ${C.amber} 14%, transparent)`,
                padding: "2px 6px",
                borderRadius: 20,
              }}
            >
              <Flame aria-hidden size={10} />الأكثر
            </span>
          )}
          {custom && (
            <span
              style={{
                fontSize: 9.5,
                fontWeight: 800,
                color: C.amber,
                background: `color-mix(in oklch, ${C.amber} 14%, transparent)`,
                padding: "1px 6px",
                borderRadius: 20,
              }}
            >
              يدوي
            </span>
          )}
        </div>
      </div>
      <div style={{ width: "100%" }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 800,
            color: C.fg,
            lineHeight: 1.25,
            marginBottom: 3,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            wordBreak: "break-word",
          }}
        >
          {s.productName}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <span style={{ fontSize: 10, color: C.mutedFg }}>/ {s.unitName}</span>
          <span style={{ fontSize: 16, fontWeight: 900, color: accent, direction: "ltr" }}>
            {s.price == null ? "—" : fmt(Number(s.price))}
            <span style={{ fontSize: 9.5, color: C.mutedFg, fontWeight: 600 }}> د.ع</span>
          </span>
        </div>
      </div>
    </button>
  );
}

export function PrintServiceGrid({
  C,
  services,
  loading,
  cats,
  catId,
  setCatId,
  search,
  onAdd,
  recentIds,
}: PrintServiceGridProps) {
  const q = search.trim();
  const list = useMemo(() => {
    if (q) {
      const nq = normalizeSearchText(q);
      return services.filter((s) => normalizeSearchText(s.productName).includes(nq));
    }
    return services.filter((s) => (catId === 0 ? s.categoryId == null : s.categoryId === catId));
  }, [services, q, catId]);

  const recentSvcs = useMemo(() => {
    if (q || !recentIds.length) return [];
    const byId = new Map(services.map((s) => [s.productUnitId, s] as const));
    const out: Svc[] = [];
    for (const id of recentIds) {
      const s = byId.get(id);
      if (s && !out.includes(s)) out.push(s);
      if (out.length >= 6) break;
    }
    return out;
  }, [q, recentIds, services]);

  return (
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", background: C.card, borderRadius: 12, border: `1px solid ${C.border}`, overflow: "hidden" }}>
      {!q && (
        <div style={{ display: "flex", gap: 5, padding: "7px 9px", overflowX: "auto", borderBottom: `1px solid ${C.border}`, flexShrink: 0, background: C.muted }}>
          {cats.map((ct) => {
            const active = ct.id === catId;
            return (
              <button
                key={ct.id}
                onClick={() => setCatId(ct.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "0 12px",
                  height: 38,
                  borderRadius: 9,
                  whiteSpace: "nowrap",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 12.5,
                  fontWeight: 800,
                  flexShrink: 0,
                  touchAction: "manipulation",
                  background: active ? C.primary : C.card,
                  color: active ? C.primaryFg : C.fg,
                  border: `${active ? 2 : 1.5}px solid ${active ? C.primary : C.border}`,
                }}
              >
                {(() => {
                  const CIcon = categoryIcon(ct.name);
                  return <CIcon aria-hidden size={15} />;
                })()}
                {ct.name}
              </button>
            );
          })}
        </div>
      )}
      {q && (
        <div style={{ padding: "11px 14px", borderBottom: `1px solid ${C.border}`, fontSize: 13, color: C.mutedFg, background: C.muted }}>
          نتائج البحث عن «<strong style={{ color: C.fg }}>{q}</strong>» — {list.length} خدمة
        </div>
      )}
      <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
        {loading ? (
          <div style={{ padding: "60px 0", textAlign: "center", color: C.mutedFg }}>جارٍ تحميل الخدمات…</div>
        ) : list.length === 0 ? (
          <div style={{ padding: "60px 0", textAlign: "center", color: C.mutedFg }}>
            <div style={{ marginBottom: 10, display: "flex", justifyContent: "center", opacity: 0.55 }}>
              <Search aria-hidden size={40} strokeWidth={1.5} />
            </div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{q ? "لا توجد خدمة بهذا الاسم" : "لا خدمات في هذه الفئة"}</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {recentSvcs.length > 0 && (
              <div style={{ borderRadius: 12, border: `1.5px dashed ${C.amber}`, background: `color-mix(in oklch, ${C.amber} 4%, transparent)`, padding: "10px 12px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, color: C.amber, fontSize: 12, fontWeight: 800 }}>
                  <Flame aria-hidden size={14} />
                  الأكثر استعمالاً <span style={{ color: C.mutedFg, fontWeight: 600 }}>({recentSvcs.length})</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(158px, 1fr))", gap: 8 }}>
                  {recentSvcs.map((s) => <ServiceCard key={`hot-${s.productUnitId}`} C={C} s={s} onAdd={onAdd} hot />)}
                </div>
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(158px, 1fr))", gap: 8 }}>
              {list.map((s) => <ServiceCard key={s.productUnitId} C={C} s={s} onAdd={onAdd} />)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
