import React, { useState, useMemo, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  PERMISSION_MODULES,
  ROLE_TEMPLATES,
  accessLabel,
  type AccessLevel,
  type PermissionMap,
  type RoleKey,
} from "@/lib/permissionsModel";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronLeft, Search, Lock, Layers, Grid } from "lucide-react";
import {
  deriveAtomicFromLegacyModules,
  deriveLegacyModulesFromAtomic,
  ROLE_DEFAULT_ATOMIC_PERMISSIONS,
  type AtomicPermissionKey,
  type AtomicPermissionsMap,
  type OperationalCaps,
  type SensitiveDataMasking,
} from "@shared/atomicPermissions";
import { PermissionMatrix as InteractiveAtomicMatrix } from "@/components/permissions/PermissionMatrix";

export interface PermissionMatrixProps {
  role: RoleKey;
  permissions: PermissionMap;
  onChange: (moduleKey: string, level: AccessLevel) => void;
  onReset: () => void;
  /** أساس المقارنة؛ الدور المخصّص يمرّر خريطته بدلاً من قالب فئته. */
  basePermissions?: PermissionMap;

  // إضافات شجرة الصلاحيات الذرية التفاعلية والسقوف (R2)
  atomicPermissions?: AtomicPermissionsMap;
  onAtomicChange?: (key: AtomicPermissionKey, granted: boolean) => void;
  onAtomicBulkChange?: (updates: Record<AtomicPermissionKey, boolean>) => void;
  caps?: OperationalCaps | null;
  onCapsChange?: (caps: OperationalCaps) => void;
  masking?: SensitiveDataMasking | null;
  onMaskingChange?: (masking: SensitiveDataMasking) => void;
  defaultMode?: "atomic" | "legacy";
}

const LEVELS: AccessLevel[] = ["FULL", "READ", "NONE"];

const LEVEL_STYLES: Record<AccessLevel, string> = {
  FULL: "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] hover:bg-[var(--sem-pos-bg)]/80",
  READ: "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)] hover:bg-[var(--sem-warn-bg)]/80",
  NONE: "bg-muted text-muted-foreground hover:bg-muted/80",
};
const LEVEL_ACTIVE: Record<AccessLevel, string> = {
  FULL: "bg-[var(--sem-pos)] text-background hover:bg-[var(--sem-pos-hover)]",
  READ: "bg-[var(--sem-warn)] text-background hover:bg-[var(--sem-warn-hover)]",
  NONE: "bg-foreground text-background hover:bg-foreground",
};

const ADMIN_ONLY = new Set(["users", "settings"]);

const CATEGORIES: { label: string; keys: string[] }[] = [
  { label: "المبيعات والعملاء", keys: ["pos", "sales", "workorders", "crm", "campaigns", "collections", "channels", "tasks", "store", "courier"] },
  { label: "المخزون والمشتريات", keys: ["inventory", "purchases", "suppliers", "products", "consignments"] },
  { label: "المالية والتقارير", keys: ["treasury", "expenses", "reports", "commissions", "assets"] },
  { label: "الموارد والإدارة", keys: ["hr", "users", "settings"] },
];

type ModuleDef = (typeof PERMISSION_MODULES)[number];

export function PermissionMatrix({
  role,
  permissions,
  onChange,
  onReset,
  basePermissions,
  atomicPermissions: propAtomicPermissions,
  onAtomicChange,
  onAtomicBulkChange,
  caps,
  onCapsChange,
  masking,
  onMaskingChange,
  defaultMode = "atomic",
}: PermissionMatrixProps) {
  const [activeTab, setActiveTab] = useState<"atomic" | "legacy">(defaultMode);
  const [internalAtomic, setInternalAtomic] = useState<AtomicPermissionsMap>(() => {
    if (propAtomicPermissions) return propAtomicPermissions;
    return deriveAtomicFromLegacyModules(permissions, role);
  });

  const template = basePermissions ?? ROLE_TEMPLATES[role] ?? ROLE_TEMPLATES.user;
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const currentAtomic = propAtomicPermissions || internalAtomic;

  // مزامنة التغييرات الذرية وإسقاطها على الوحدات القديمة تلقائياً
  const handleAtomicSingleChange = useCallback(
    (key: AtomicPermissionKey, granted: boolean) => {
      const nextAtomic = { ...currentAtomic, [key]: granted };
      if (!propAtomicPermissions) {
        setInternalAtomic(nextAtomic);
      }
      onAtomicChange?.(key, granted);

      // اشتقاق وحدات النظام القديمة
      const derivedModules = deriveLegacyModulesFromAtomic(nextAtomic, role);
      for (const [mod, lvl] of Object.entries(derivedModules)) {
        if ((permissions[mod] || "NONE") !== lvl) {
          onChange(mod, lvl);
        }
      }
    },
    [currentAtomic, propAtomicPermissions, onAtomicChange, role, permissions, onChange],
  );

  const handleAtomicBulkChange = useCallback(
    (updates: Record<AtomicPermissionKey, boolean>) => {
      const nextAtomic = { ...currentAtomic, ...updates };
      if (!propAtomicPermissions) {
        setInternalAtomic(nextAtomic);
      }
      onAtomicBulkChange?.(updates);

      // اشتقاق وحدات النظام القديمة
      const derivedModules = deriveLegacyModulesFromAtomic(nextAtomic, role);
      for (const [mod, lvl] of Object.entries(derivedModules)) {
        if ((permissions[mod] || "NONE") !== lvl) {
          onChange(mod, lvl);
        }
      }
    },
    [currentAtomic, propAtomicPermissions, onAtomicBulkChange, role, permissions, onChange],
  );

  const handleResetAll = useCallback(() => {
    const baseAtomic = ROLE_DEFAULT_ATOMIC_PERMISSIONS[role] || ROLE_DEFAULT_ATOMIC_PERMISSIONS.user || {};
    if (!propAtomicPermissions) {
      setInternalAtomic(baseAtomic);
    }
    onReset();
  }, [role, propAtomicPermissions, onReset]);

  // منطق العرض القديم
  const isCustom = (key: string) => (permissions[key] ?? "NONE") !== (template[key] ?? "NONE");
  const customCount = PERMISSION_MODULES.reduce((acc, m) => acc + (isCustom(m.key) ? 1 : 0), 0);

  const grouped = useMemo(() => {
    const byKey = new Map(PERMISSION_MODULES.map((m) => [m.key, m]));
    const used = new Set<string>();
    const cats: { label: string; modules: ModuleDef[] }[] = CATEGORIES.map((c) => {
      const modules = c.keys.map((k) => byKey.get(k)).filter(Boolean) as ModuleDef[];
      modules.forEach((m) => used.add(m.key));
      return { label: c.label, modules };
    });
    const rest = PERMISSION_MODULES.filter((m) => !used.has(m.key));
    if (rest.length) cats.push({ label: "أخرى", modules: rest });
    const q = query.trim();
    if (!q) return cats;
    return cats
      .map((c) => ({ ...c, modules: c.modules.filter((m) => (m.label + " " + (m.description ?? "")).includes(q)) }))
      .filter((c) => c.modules.length);
  }, [query]);

  const setCategory = (modules: ModuleDef[], level: AccessLevel) => {
    for (const m of modules) if (!ADMIN_ONLY.has(m.key)) onChange(m.key, level);
  };

  return (
    <div className="space-y-3">
      {/* Tab Switcher */}
      <div className="flex items-center justify-between border-b border-border pb-2">
        <div className="inline-flex items-center p-0.5 rounded-lg bg-muted text-muted-foreground text-xs font-medium">
          <button
            type="button"
            onClick={() => setActiveTab("atomic")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1 rounded-md transition-all cursor-pointer",
              activeTab === "atomic"
                ? "bg-background text-foreground shadow-xs font-semibold"
                : "hover:text-foreground",
            )}
          >
            <Grid aria-hidden="true" className="size-3.5" />
            <span>المصفوفة الذرية التفاعلية (R2)</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("legacy")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1 rounded-md transition-all cursor-pointer",
              activeTab === "legacy"
                ? "bg-background text-foreground shadow-xs font-semibold"
                : "hover:text-foreground",
            )}
          >
            <Layers aria-hidden="true" className="size-3.5" />
            <span>الوحدات الإجمالية (22 وحدة)</span>
          </button>
        </div>
      </div>

      {activeTab === "atomic" ? (
        <InteractiveAtomicMatrix
          role={role}
          atomicPermissions={currentAtomic}
          onChange={handleAtomicSingleChange}
          onBulkChange={handleAtomicBulkChange}
          onReset={handleResetAll}
          caps={caps}
          onCapsChange={onCapsChange}
          masking={masking}
          onMaskingChange={onMaskingChange}
        />
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="relative flex-1 min-w-[180px] max-w-xs">
              <Search aria-hidden="true" className="absolute right-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="ابحث عن وحدة…"
                className="h-8 pr-7 text-xs"
              />
            </div>
            {customCount > 0 && (
              <Button type="button" variant="ghost" size="sm" onClick={onReset} className="text-xs">
                إعادة لقالب الدور ({customCount} مخصّص)
              </Button>
            )}
          </div>

          <div className="space-y-2">
            {grouped.map((cat) => {
              const isCol = collapsed[cat.label];
              return (
                <div key={cat.label} className="rounded-md border border-border overflow-hidden bg-card">
                  <div className="flex items-center justify-between gap-2 bg-muted/50 px-3 py-1.5">
                    <button
                      type="button"
                      onClick={() => setCollapsed((c) => ({ ...c, [cat.label]: !c[cat.label] }))}
                      className="flex items-center gap-1.5 text-xs font-semibold cursor-pointer"
                      aria-expanded={!isCol}
                    >
                      {isCol ? <ChevronLeft aria-hidden="true" className="size-3.5" /> : <ChevronDown aria-hidden="true" className="size-3.5" />}
                      {cat.label}
                      <span className="text-[10px] font-normal text-muted-foreground">({cat.modules.length})</span>
                    </button>
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] text-muted-foreground">اضبط الكل:</span>
                      {LEVELS.map((lv) => (
                        <button
                          key={lv}
                          type="button"
                          onClick={() => setCategory(cat.modules, lv)}
                          className={cn("h-6 px-2 rounded text-[10px] font-medium transition-colors cursor-pointer", LEVEL_STYLES[lv])}
                        >
                          {accessLabel(lv)}
                        </button>
                      ))}
                    </div>
                  </div>
                  {!isCol && (
                    <table className="w-full text-sm">
                      <tbody>
                        {cat.modules.map((m) => {
                          const current = permissions[m.key] || "NONE";
                          const adminOnly = ADMIN_ONLY.has(m.key);
                          return (
                            <tr key={m.key} className="border-t border-border">
                              <td className="px-3 py-2 align-top w-2/5">
                                <div className="font-medium flex items-center gap-1.5">
                                  {m.label}
                                  {adminOnly && <Lock aria-hidden="true" className="size-3 text-muted-foreground" />}
                                </div>
                                {m.description && <div className="text-[11px] text-muted-foreground mt-0.5">{m.description}</div>}
                                {adminOnly && <div className="text-[10px] text-muted-foreground mt-0.5">إداريّ — للمدير فقط (لا يُفتَح بالمصفوفة).</div>}
                              </td>
                              <td className="px-2 py-2">
                                <div className="flex items-center justify-center gap-1">
                                  {LEVELS.map((lv) => (
                                    <button
                                      key={lv}
                                      type="button"
                                      disabled={adminOnly}
                                      onClick={() => onChange(m.key, lv)}
                                      aria-pressed={current === lv}
                                      className={cn(
                                        "h-7 px-2.5 rounded-md text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer",
                                        current === lv ? LEVEL_ACTIVE[lv] : LEVEL_STYLES[lv],
                                      )}
                                    >
                                      {accessLabel(lv)}
                                    </button>
                                  ))}
                                </div>
                              </td>
                              <td className="px-3 py-2 w-16">
                                {isCustom(m.key) && (
                                  <Badge variant="outline" className="text-[10px] border-primary text-primary">مخصّص</Badge>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })}
            {grouped.length === 0 && <p className="text-xs text-muted-foreground py-2">لا وحدات مطابقة للبحث.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
