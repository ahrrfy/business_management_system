import { useState } from "react";
import { Link } from "wouter";
import { useReducedMotion } from "framer-motion";
import type { ApplicationModule } from "@/lib/moduleRegistry";
import type { ModuleTelemetry } from "./dashboardTelemetry";
import { CreativeModuleIcon } from "./CreativeModuleIcon";

function getBadgeStyles(tone: ModuleTelemetry["badgeTone"]) {
  switch (tone) {
    case "emerald":
      return {
        bg: "color-mix(in oklch, var(--sec2-ink) 14%, var(--dash-card-bg))",
        color: "var(--sec2-ink)",
        border: "color-mix(in oklch, var(--sec2-ink) 26%, transparent)",
        dot: "var(--sec2-ink)",
      };
    case "amber":
      return {
        bg: "color-mix(in oklch, var(--sem-warn) 14%, var(--dash-card-bg))",
        color: "var(--sem-warn)",
        border: "color-mix(in oklch, var(--sem-warn) 26%, transparent)",
        dot: "var(--sem-warn)",
      };
    case "rose":
      return {
        bg: "color-mix(in oklch, var(--sem-neg) 14%, var(--dash-card-bg))",
        color: "var(--sem-neg)",
        border: "color-mix(in oklch, var(--sem-neg) 26%, transparent)",
        dot: "var(--sem-neg)",
      };
    case "blue":
      return {
        bg: "color-mix(in oklch, var(--sec1-ink) 14%, var(--dash-card-bg))",
        color: "var(--sec1-ink)",
        border: "color-mix(in oklch, var(--sec1-ink) 26%, transparent)",
        dot: "var(--sec1-ink)",
      };
    case "neutral":
    default:
      return {
        bg: "color-mix(in oklch, var(--dash-muted) 12%, var(--dash-card-bg))",
        color: "var(--dash-muted)",
        border: "color-mix(in oklch, var(--dash-card-bord) 60%, transparent)",
        dot: "var(--dash-muted)",
      };
  }
}

export function ModuleCard({
  module,
  accent,
  gradient,
  telemetry,
}: {
  module: ApplicationModule;
  accent: string;
  gradient?: readonly [string, string];
  telemetry?: ModuleTelemetry;
}) {
  const shouldReduceMotion = useReducedMotion();
  const [isHovered, setIsHovered] = useState(false);
  const badgeStyle = telemetry ? getBadgeStyles(telemetry.badgeTone) : null;

  const gradientStart = gradient ? gradient[0] : accent;
  const gradientEnd = gradient ? gradient[1] : accent;

  return (
    <Link
      href={module.href}
      aria-label={telemetry ? `${module.label} — ${telemetry.text}` : module.label}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onFocus={() => setIsHovered(true)}
      onBlur={() => setIsHovered(false)}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: "10px 8px 8px",
        minHeight: 110,
        borderRadius: 14,
        background: isHovered
          ? `linear-gradient(180deg, color-mix(in oklch, ${accent} 18%, var(--dash-card-bg)) 0%, color-mix(in oklch, ${accent} 6%, var(--dash-card-bg)) 100%)`
          : `linear-gradient(180deg, color-mix(in oklch, ${accent} 6%, var(--dash-card-bg)) 0%, var(--dash-card-bg) 65%)`,
        border: `1px solid ${
          isHovered
            ? `color-mix(in oklch, ${accent} 85%, var(--dash-card-bord))`
            : `color-mix(in oklch, ${accent} 22%, var(--dash-card-bord))`
        }`,
        position: "relative",
        overflow: "hidden",
        textDecoration: "none",
        color: "inherit",
        boxShadow: isHovered
          ? `0 16px 32px -8px color-mix(in oklch, ${accent} 42%, transparent), 0 4px 12px -2px color-mix(in oklch, ${accent} 22%, transparent)`
          : `0 2px 6px -1px color-mix(in oklch, ${accent} 12%, transparent), 0 1px 2px 0 rgba(0, 0, 0, 0.03)`,
        transform: isHovered && !shouldReduceMotion ? "translateY(-4px)" : "none",
        transition:
          "background 220ms ease, border-color 220ms ease, box-shadow 220ms ease, transform 220ms cubic-bezier(0.16, 1, 0.3, 1)",
      }}
      className="group focus:outline-none focus:ring-2 focus:ring-primary/40"
    >
      {/* شريط القسم اللوني الدقيق أعلى البطاقة مع إضاءة متوهجة عند التحويم */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: isHovered ? 3.5 : 3,
          background: `linear-gradient(90deg, ${gradientStart}, ${gradientEnd})`,
          opacity: isHovered ? 1 : 0.85,
          boxShadow: isHovered ? `0 0 14px 2px ${accent}` : "none",
          transition: "all 200ms ease",
        }}
      />

      {/* شارة المؤشر التشغيلي الحي في الزاوية العلوية */}
      {telemetry && badgeStyle && (
        <span
          style={{
            position: "absolute",
            top: 7,
            left: 7,
            zIndex: 2,
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "2px 6px",
            borderRadius: 9999,
            fontSize: "0.625rem",
            fontWeight: 800,
            background: badgeStyle.bg,
            color: badgeStyle.color,
            border: `1px solid ${
              isHovered
                ? `color-mix(in oklch, ${badgeStyle.color} 45%, transparent)`
                : badgeStyle.border
            }`,
            boxShadow: isHovered
              ? `0 2px 8px -1px color-mix(in oklch, ${badgeStyle.color} 30%, transparent)`
              : "none",
            whiteSpace: "nowrap",
            transition: "all 180ms ease",
          }}
        >
          {telemetry.pulse && (
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: "50%",
                backgroundColor: badgeStyle.dot,
                boxShadow: `0 0 6px ${badgeStyle.dot}`,
              }}
              className="animate-pulse motion-reduce:animate-none"
            />
          )}
          <span>{telemetry.text}</span>
        </span>
      )}

      {/* شعار البطاقة: تباين لوني قوي مشرق وحيوي مبهج */}
      <span
        aria-hidden
        style={{
          width: 52,
          height: 52,
          borderRadius: 14,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: isHovered ? "#ffffff" : accent,
          background: isHovered
            ? `linear-gradient(135deg, ${gradientStart}, ${gradientEnd})`
            : `linear-gradient(135deg, color-mix(in oklch, ${accent} 22%, var(--dash-card-bg)) 0%, color-mix(in oklch, ${accent} 9%, var(--dash-card-bg)) 100%)`,
          border: `1.5px solid ${
            isHovered ? accent : `color-mix(in oklch, ${accent} 32%, transparent)`
          }`,
          boxShadow: isHovered
            ? `0 10px 24px -2px color-mix(in oklch, ${accent} 65%, transparent), 0 2px 8px rgba(0, 0, 0, 0.18)`
            : `0 4px 12px -2px color-mix(in oklch, ${accent} 25%, transparent)`,
          filter: isHovered ? "drop-shadow(0 1px 2px rgba(0, 0, 0, 0.35))" : "none",
          transform: isHovered && !shouldReduceMotion ? "scale(1.10)" : "none",
          transition:
            "transform 220ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 220ms ease, background 220ms ease, border-color 220ms ease, color 220ms ease",
          flexShrink: 0,
        }}
      >
        <CreativeModuleIcon
          module={module}
          isHovered={isHovered}
          shouldReduceMotion={shouldReduceMotion}
        />
      </span>

      {/* اسم الوحدة: تباين لوني دقيق ومبهج */}
      <span
        style={{
          fontSize: "0.84375rem",
          fontWeight: isHovered ? 900 : 800,
          lineHeight: 1.25,
          letterSpacing: "-0.01em",
          color: isHovered ? accent : "var(--dash-text)",
          marginTop: 6,
          display: "-webkit-box",
          WebkitLineClamp: 1,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          textOverflow: "ellipsis",
          width: "100%",
          padding: "0 4px",
          transition: "color 180ms ease",
        }}
      >
        {module.label}
      </span>

      {/* وصف فرعي دقيق مركز يزداد وضوحاً عند التحويم */}
      <span
        style={{
          fontSize: "0.6875rem",
          color: isHovered ? "var(--dash-text)" : "var(--dash-muted)",
          lineHeight: 1.25,
          display: "-webkit-box",
          WebkitLineClamp: 1,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          textOverflow: "ellipsis",
          width: "100%",
          padding: "0 4px",
          marginTop: 2,
          transition: "color 180ms ease",
        }}
      >
        {module.description}
      </span>
    </Link>
  );
}
