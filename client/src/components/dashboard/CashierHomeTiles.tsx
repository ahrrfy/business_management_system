import type React from "react";
import { Link } from "wouter";
export const CASHIER_THEME = {
  bg: "var(--dash-bg)",
  cardBg: "var(--dash-card-bg)",
  cardBord: "var(--dash-card-bord)",
  secLine: "var(--dash-sec-line)",
  secLabel: "var(--dash-sec-label)",
  text: "var(--dash-text)",
  sub: "var(--dash-sub)",
  muted: "var(--dash-muted)",
  featuredBg: "var(--dash-featured-bg)",
  featuredBd: "var(--dash-featured-bd)",
} as const;

export interface Tile {
  href: string;
  name: string;
  desc: string;
  /** عدّادٌ يستحقّ نظرةً قبل فتح البطاقة (صفرٌ ⇒ لا يُعرَض — لا ضوضاءَ بلا خبر). */
  badge?: number;
  badgeHint?: string;
  badgeVariant?: "warn" | "success" | "info";
  icon?: React.ComponentType<{
    className?: string;
    style?: React.CSSProperties;
  }>;
}

/** مجموعةُ بطاقاتٍ بعنوانٍ — الفاصلُ بينها هو ما يُنهي «صفَّ أزرارٍ متساوية الوزن». */
export function TileGroup({
  label,
  hint,
  tiles,
}: {
  label: string;
  hint?: string;
  tiles: Tile[];
}) {
  if (tiles.length === 0) return null;
  return (
    <section
      style={{ display: "flex", flexDirection: "column", gap: 10 }}
      aria-label={label}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <h2
          style={{
            fontSize: "0.75rem",
            fontWeight: 800,
            color: CASHIER_THEME.secLabel,
            margin: 0,
            letterSpacing: "0.04em",
          }}
        >
          {label}
        </h2>
        {hint && (
          <span style={{ fontSize: "0.6875rem", color: CASHIER_THEME.muted }}>
            {hint}
          </span>
        )}
        <div
          style={{ flex: 1, height: 1, background: CASHIER_THEME.secLine }}
          aria-hidden
        />
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(100%, 240px), 1fr))",
          gap: 10,
        }}
      >
        {tiles.map((t) => {
          const Icon = t.icon;
          const badgeBg =
            t.badgeVariant === "success"
              ? "var(--sem-pos-bg)"
              : t.badgeVariant === "info"
                ? "var(--sem-info-bg)"
                : "var(--sem-warn-bg)";
          const badgeColor =
            t.badgeVariant === "success"
              ? "var(--sem-pos)"
              : t.badgeVariant === "info"
                ? "var(--sem-info)"
                : "var(--sem-warn)";

          return (
            <Link
              key={t.href}
              href={t.href}
              style={{
                position: "relative",
                background: CASHIER_THEME.cardBg,
                border: `1px solid ${CASHIER_THEME.cardBord}`,
                borderRadius: 12,
                padding: "12px 14px",
                textDecoration: "none",
                display: "flex",
                flexDirection: "column",
                gap: 5,
                minHeight: 72,
                transition: "transform 0.1s ease, border-color 0.15s ease",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {Icon && (
                    <span
                      aria-hidden
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 28,
                        height: 28,
                        borderRadius: 8,
                        background: "var(--muted)",
                        color: "var(--foreground)",
                        flexShrink: 0,
                      }}
                    >
                      <Icon style={{ width: 15, height: 15 }} />
                    </span>
                  )}
                  <span
                    style={{
                      fontSize: "0.875rem",
                      fontWeight: 700,
                      color: CASHIER_THEME.text,
                    }}
                  >
                    {t.name}
                  </span>
                </div>
                {Boolean(t.badge && t.badge > 0) && (
                  <span
                    title={t.badgeHint}
                    style={{
                      minWidth: 22,
                      padding: "1px 7px",
                      borderRadius: 999,
                      background: badgeBg,
                      color: badgeColor,
                      fontSize: "0.6875rem",
                      fontWeight: 800,
                      textAlign: "center",
                    }}
                  >
                    {t.badge && t.badge > 99 ? "99+" : t.badge}
                  </span>
                )}
              </div>
              <div
                style={{
                  fontSize: "0.75rem",
                  color: CASHIER_THEME.muted,
                  lineHeight: 1.45,
                }}
              >
                {t.desc}
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
