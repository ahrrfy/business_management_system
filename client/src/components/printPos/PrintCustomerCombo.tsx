import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";

export interface PrintCustomerComboProps {
  C: {
    card: string;
    border: string;
    primary: string;
    primarySoft: string;
    muted: string;
    mutedFg: string;
    fg: string;
  };
  customerId: number | null;
  setCustomerId: (id: number | null) => void;
}

export function PrintCustomerCombo({ C, customerId, setCustomerId }: PrintCustomerComboProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);
  const dq = useDebouncedValue(q.trim(), 250);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const search = trpc.customers.search.useQuery(
    { q: dq || undefined, limit: 20 },
    { enabled: open, staleTime: 30_000 },
  );

  const picked = trpc.customers.get.useQuery(
    { customerId: customerId ?? 0 },
    { enabled: customerId != null, staleTime: 60_000 },
  );

  const rows = search.data?.rows ?? [];
  const label = customerId == null ? "عميل نقدي" : (picked.data?.name ?? `#${customerId}`);
  const active = customerId != null;

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="اختيار العميل"
        style={{
          height: 36,
          borderRadius: 9,
          border: `1.5px solid ${active ? C.primary : C.border}`,
          background: active ? C.primarySoft : C.card,
          color: active ? C.primary : C.mutedFg,
          fontFamily: "inherit",
          fontSize: 12.5,
          fontWeight: 700,
          padding: "0 8px",
          outline: "none",
          cursor: "pointer",
          maxWidth: 160,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </button>
      {open && (
        <div
          role="listbox"
          style={{
            position: "absolute",
            top: 40,
            left: 0,
            minWidth: 240,
            zIndex: 50,
            background: C.card,
            border: `1px solid ${C.border}`,
            borderRadius: 10,
            boxShadow: "0 10px 30px rgba(0,0,0,.18)",
            overflow: "hidden",
          }}
        >
          <div style={{ padding: 7 }}>
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="ابحث بالاسم أو الهاتف…"
              style={{
                width: "100%",
                height: 32,
                borderRadius: 7,
                border: `1px solid ${C.border}`,
                background: C.muted,
                color: C.fg,
                fontFamily: "inherit",
                fontSize: 12.5,
                padding: "0 8px",
                outline: "none",
              }}
            />
          </div>
          <div style={{ maxHeight: 210, overflowY: "auto" }}>
            <div
              role="option"
              aria-selected={customerId == null}
              onClick={() => {
                setCustomerId(null);
                setOpen(false);
                setQ("");
              }}
              style={{
                padding: "8px 10px",
                cursor: "pointer",
                fontSize: 12.5,
                fontWeight: 700,
                color: C.mutedFg,
                borderBottom: `1px solid ${C.border}`,
              }}
            >
              عميل نقدي
            </div>
            {search.isFetching && rows.length === 0 && (
              <div style={{ padding: "12px 10px", textAlign: "center", fontSize: 12, color: C.mutedFg }}>
                جارٍ البحث…
              </div>
            )}
            {!search.isFetching && rows.length === 0 && (
              <div style={{ padding: "12px 10px", textAlign: "center", fontSize: 12, color: C.mutedFg }}>
                لا نتائج
              </div>
            )}
            {rows.map((c) => (
              <div
                key={c.id}
                role="option"
                aria-selected={c.id === customerId}
                onClick={() => {
                  setCustomerId(c.id);
                  setOpen(false);
                  setQ("");
                }}
                style={{
                  padding: "8px 10px",
                  cursor: "pointer",
                  fontSize: 12.5,
                  borderBottom: `1px solid ${C.border}`,
                  background: c.id === customerId ? C.primarySoft : "transparent",
                  color: C.fg,
                }}
              >
                <div style={{ fontWeight: 700 }}>{c.name}</div>
                <div style={{ fontSize: 11, color: C.mutedFg }}>{c.phone || "بلا هاتف"}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
