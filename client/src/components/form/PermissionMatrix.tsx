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
import { ChevronDown, ChevronLeft, Search, Lock } from "lucide-react";
import { useMemo, useState } from "react";

/**
 * محرّر صلاحيات تفاعلي — ش٤ «دقيق لا بدائيّ»: القائمة المسطّحة (~٢٢ صفّاً) صارت **فئاتٍ قابلة للطيّ**
 * (مبيعات/مخزون/ماليّ/إداريّ) + بحث + أزرار «اضبط الفئة» (كامل/قراءة/لا وصول دفعةً). لكل وحدة ٣ أزرار،
 * تبدأ من قالب الدور، وكل تخصيصٍ عن القالب يُوسم «مخصّص». الإنفاذ الحقيقي خادميّ؛ هذا الجدول يهيّئ الـoverride.
 *
 * ⚠️ الوحدات الإدارية (users/settings) محروسةٌ خادمياً بـadminProcedure الخشن ⇒ منحُها لدورٍ أساسه غير
 * admin «وعدٌ كاذب»؛ تُعرَض مقفلةً «إداريّ — للمدير فقط» فلا تكذب المصفوفة على الإنفاذ.
 */
export interface PermissionMatrixProps {
  role: RoleKey;
  permissions: PermissionMap;
  onChange: (moduleKey: string, level: AccessLevel) => void;
  onReset: () => void;
  /** أساس المقارنة؛ الدور المخصّص يمرّر خريطته بدلاً من قالب فئته. */
  basePermissions?: PermissionMap;
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

/** الوحدات المحروسة خادمياً ببوّابة admin الخشنة — لا يفتحها منحٌ في المصفوفة لدورٍ أساسه غير admin. */
const ADMIN_ONLY = new Set(["users", "settings"]);

/** تجميع الوحدات في فئاتٍ تشغيلية (بقيّة الوحدات تقع تلقائياً في «أخرى»). */
const CATEGORIES: { label: string; keys: string[] }[] = [
  { label: "المبيعات والعملاء", keys: ["pos", "sales", "workorders", "crm", "campaigns", "collections", "channels", "tasks", "store", "courier"] },
  { label: "المخزون والمشتريات", keys: ["inventory", "purchases", "suppliers", "products", "consignments"] },
  { label: "المالية والتقارير", keys: ["treasury", "expenses", "reports", "commissions", "assets"] },
  { label: "الموارد والإدارة", keys: ["hr", "users", "settings"] },
];

type ModuleDef = (typeof PERMISSION_MODULES)[number];

export function PermissionMatrix({ role, permissions, onChange, onReset, basePermissions }: PermissionMatrixProps) {
  const template = basePermissions ?? ROLE_TEMPLATES[role] ?? ROLE_TEMPLATES.user;
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // ش٤ — إصلاح شارة «مخصّص» الكاذبة: `?? "NONE"` على الطرفين (الوحدة الغائبة عن القالب = NONE)
  // مطابقةً حرفيةً لدلالة diffFromTemplate — كانت تُظهر «مخصّص» زوراً لـstore/courier ولا تعود لصفر.
  const isCustom = (key: string) => (permissions[key] ?? "NONE") !== (template[key] ?? "NONE");
  const customCount = PERMISSION_MODULES.reduce((acc, m) => acc + (isCustom(m.key) ? 1 : 0), 0);

  // بناء الفئات مع بقايا «أخرى»، ثم تصفية البحث.
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search aria-hidden className="absolute right-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
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
            <div key={cat.label} className="rounded-md border overflow-hidden">
              <div className="flex items-center justify-between gap-2 bg-muted/50 px-3 py-1.5">
                <button
                  type="button"
                  onClick={() => setCollapsed((c) => ({ ...c, [cat.label]: !c[cat.label] }))}
                  className="flex items-center gap-1.5 text-xs font-semibold"
                  aria-expanded={!isCol}
                >
                  {isCol ? <ChevronLeft aria-hidden className="size-3.5" /> : <ChevronDown aria-hidden className="size-3.5" />}
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
                      className={cn("h-6 px-2 rounded text-[10px] font-medium transition-colors", LEVEL_STYLES[lv])}
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
                        <tr key={m.key} className="border-t">
                          <td className="px-3 py-2 align-top w-2/5">
                            <div className="font-medium flex items-center gap-1.5">
                              {m.label}
                              {adminOnly && <Lock aria-hidden className="size-3 text-muted-foreground" />}
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
                                    "h-7 px-2.5 rounded-md text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
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
  );
}
