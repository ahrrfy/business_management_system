import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  PERMISSION_MODULES,
  ROLE_TEMPLATES,
  accessLabel,
  type AccessLevel,
  type PermissionMap,
  type RoleKey,
} from "@/lib/permissionsModel";
import { cn } from "@/lib/utils";

/**
 * محرّر صلاحيات تفاعلي — v3-add-screens.
 *
 * - لكل وحدة ٣ أزرار: كامل · قراءة · لا وصول.
 * - يبدأ من قالب الدور؛ كل تخصيص يدوي يُوسم بـ«مخصّص» في الصف.
 * - زرّ «إعادة لقالب الدور» يمسح كل التخصيصات.
 *
 * الإنفاذ الحقيقي على الخادم — هذا الجدول واجهي يهيّئ الـoverride JSON.
 */
export interface PermissionMatrixProps {
  role: RoleKey;
  /** قيم فعليّة (قالب الدور مدموجاً مع overrides). يأتي مُحلَّلاً من `resolvePermissions`. */
  permissions: PermissionMap;
  /** يُستدعى بقيمة وحدة مفردة عند تغييرها. الحالة الأم تعيد بناء `permissions`. */
  onChange: (moduleKey: string, level: AccessLevel) => void;
  /** يُستدعى لمسح كل التخصيصات (إعادة لقالب الدور). */
  onReset: () => void;
}

const LEVELS: AccessLevel[] = ["FULL", "READ", "NONE"];

const LEVEL_STYLES: Record<AccessLevel, string> = {
  FULL: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20",
  READ: "bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20",
  NONE: "bg-muted text-muted-foreground hover:bg-muted/80",
};

const LEVEL_ACTIVE: Record<AccessLevel, string> = {
  FULL: "bg-emerald-600 text-white hover:bg-emerald-600",
  READ: "bg-amber-500 text-white hover:bg-amber-500",
  NONE: "bg-foreground text-background hover:bg-foreground",
};

export function PermissionMatrix({ role, permissions, onChange, onReset }: PermissionMatrixProps) {
  const template = ROLE_TEMPLATES[role] || ROLE_TEMPLATES.user;
  const customCount = PERMISSION_MODULES.reduce(
    (acc, m) => acc + (permissions[m.key] !== template[m.key] ? 1 : 0),
    0
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          ابدأ من قالب الدور المختار، ثم خصّص أيّ وحدة بالنقر على «كامل / قراءة / لا وصول».
        </p>
        {customCount > 0 && (
          <Button type="button" variant="ghost" size="sm" onClick={onReset} className="text-xs">
            إعادة لقالب الدور ({customCount} مخصّص)
          </Button>
        )}
      </div>

      <div className="rounded-md border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-right font-medium px-3 py-2 text-xs text-muted-foreground w-2/5">الوحدة</th>
              <th className="text-center font-medium px-2 py-2 text-xs text-muted-foreground">الوصول</th>
              <th className="text-right font-medium px-3 py-2 text-xs text-muted-foreground w-20">حالة</th>
            </tr>
          </thead>
          <tbody>
            {PERMISSION_MODULES.map((m) => {
              const current = permissions[m.key] || "NONE";
              const isCustom = current !== template[m.key];
              return (
                <tr key={m.key} className="border-t">
                  <td className="px-3 py-2 align-top">
                    <div className="font-medium">{m.label}</div>
                    {m.description && (
                      <div className="text-[11px] text-muted-foreground mt-0.5">{m.description}</div>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex items-center justify-center gap-1">
                      {LEVELS.map((lv) => (
                        <button
                          key={lv}
                          type="button"
                          onClick={() => onChange(m.key, lv)}
                          aria-pressed={current === lv}
                          className={cn(
                            "h-7 px-2.5 rounded-md text-xs font-medium transition-colors",
                            current === lv ? LEVEL_ACTIVE[lv] : LEVEL_STYLES[lv]
                          )}
                        >
                          {accessLabel(lv)}
                        </button>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {isCustom && (
                      <Badge variant="outline" className="text-[10px] border-primary text-primary">
                        مخصّص
                      </Badge>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
