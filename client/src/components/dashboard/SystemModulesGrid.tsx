import { useCallback } from "react";
import { fmtAr } from "@/lib/money";
import { useMediaQuery } from "@/hooks/useMobile";
import type { ApplicationModule } from "@/lib/moduleRegistry";
import {
  Receipt,
  Boxes,
  Landmark,
  Layers,
  ShieldCheck,
} from "lucide-react";
import { ModuleCard } from "./ModuleCard";
import {
  getModuleTelemetry,
  type DashboardTelemetrySource,
} from "./dashboardTelemetry";

export const SYSTEM_SECTIONS = [
  {
    id: 1,
    label: "المبيعات والتحصيل",
    accent: "var(--sec1-ink)",
    gradient: ["#2563eb", "#06b6d4"] as const,
    icon: Receipt,
  },
  {
    id: 2,
    label: "المخزون والمشتريات",
    accent: "var(--sec2-ink)",
    gradient: ["#059669", "#10b981"] as const,
    icon: Boxes,
  },
  {
    id: 3,
    label: "المالية والحسابات",
    accent: "var(--sec3-ink)",
    gradient: ["#7c3aed", "#ec4899"] as const,
    icon: Landmark,
  },
  {
    id: 4,
    label: "التشغيل والقنوات",
    accent: "var(--sec4-ink)",
    gradient: ["#ea580c", "#f59e0b"] as const,
    icon: Layers,
  },
  {
    id: 5,
    label: "الإدارة والنظام",
    accent: "var(--sec5-ink)",
    gradient: ["#0284c7", "#6366f1"] as const,
    icon: ShieldCheck,
  },
] as const;

export function SystemModulesGrid({
  modules,
  telemetrySource,
}: {
  modules: readonly ApplicationModule[];
  telemetrySource?: DashboardTelemetrySource;
}) {
  const isNarrowMobile = useMediaQuery("(max-width: 420px)");
  const isMobile = useMediaQuery("(max-width: 768px)");
  const isTablet = useMediaQuery("(min-width: 769px) and (max-width: 1100px)");

  const getTelemetry = useCallback(
    (moduleId: string) => getModuleTelemetry(moduleId, telemetrySource),
    [telemetrySource],
  );

  const getSectionGridTemplate = useCallback(
    (moduleCount: number) => {
      if (isNarrowMobile) return "repeat(2, minmax(0, 1fr))";
      if (isMobile) return "repeat(3, minmax(0, 1fr))";
      if (isTablet) return "repeat(auto-fit, minmax(160px, 1fr))";

      // سطح المكتب الكبير: توزيع هندسي كامل ومتناظر يملأ عرض الشاشة 100%
      if (moduleCount === 5) return "repeat(5, minmax(0, 1fr))";
      if (moduleCount === 6) return "repeat(6, minmax(0, 1fr))";
      if (moduleCount === 8) return "repeat(4, minmax(0, 1fr))";
      return "repeat(auto-fit, minmax(180px, 1fr))";
    },
    [isNarrowMobile, isMobile, isTablet],
  );

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {SYSTEM_SECTIONS.map((section) => {
        const sectionModules = modules.filter((m) => m.section === section.id);
        if (sectionModules.length === 0) return null;
        const SecIcon = section.icon;
        const gridTemplate = getSectionGridTemplate(sectionModules.length);

        return (
          <section
            key={section.id}
            aria-labelledby={`dashboard-section-${section.id}`}
            style={{ display: "grid", gap: 8 }}
          >
            <header style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                aria-hidden
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 7,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: `linear-gradient(135deg, ${section.gradient[0]}, ${section.gradient[1]})`,
                  color: "#ffffff",
                  boxShadow: `0 3px 10px -2px color-mix(in oklch, ${section.accent} 45%, transparent)`,
                  flexShrink: 0,
                }}
              >
                <SecIcon size={14} strokeWidth={2.4} />
              </span>

              <h3
                id={`dashboard-section-${section.id}`}
                style={{
                  margin: 0,
                  fontSize: "0.875rem",
                  fontWeight: 900,
                  color: "var(--dash-text)",
                  letterSpacing: "-0.01em",
                }}
              >
                {section.label}
              </h3>

              <span
                style={{
                  color: section.accent,
                  fontSize: "0.6875rem",
                  fontWeight: 800,
                  padding: "1.5px 8px",
                  borderRadius: 9999,
                  background: `color-mix(in oklch, ${section.accent} 12%, transparent)`,
                  border: `1px solid color-mix(in oklch, ${section.accent} 25%, transparent)`,
                }}
              >
                {fmtAr(sectionModules.length)} وحدات
              </span>

              <span
                aria-hidden
                style={{
                  flex: 1,
                  height: 1.5,
                  background: `linear-gradient(to left, color-mix(in oklch, ${section.accent} 40%, transparent), transparent)`,
                }}
              />
            </header>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: gridTemplate,
                gap: 10,
              }}
            >
              {sectionModules.map((module) => (
                <ModuleCard
                  key={module.id}
                  module={module}
                  accent={section.accent}
                  gradient={section.gradient}
                  telemetry={getTelemetry(module.id)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export { ModuleCard };
