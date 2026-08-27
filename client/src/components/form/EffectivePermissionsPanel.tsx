import { trpc } from "@/lib/trpc";
import { accessLabel } from "@shared/permissions";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { EffectiveAccessPreview } from "./EffectiveAccessPreview";

/**
 * لوحة «الأثر الفعليّ الحاليّ» لحساب (طبقة الشفافية ش١) — تستهلك users.effectivePermissions الخادميّ
 * فتعرض **الصلاحيات المحلولة الفعّالة ومصدر كل قيمة** (قالب/دور مخصّص/تخصيص فرديّ/تجاوز admin). تجيب
 * المالك «لماذا يرى هذا الحساب هذا؟» بدقّة — وهي المعلومة التي لا يستطيع العميل حسابها لأصحاب الأدوار
 * المخصّصة (خريطة الدور خادمية). قراءة بحتة.
 */

const SOURCE_LABEL: Record<string, { label: string; cls: string }> = {
  template: { label: "قالب الفئة", cls: "bg-muted text-muted-foreground" },
  customRole: { label: "دور مخصّص", cls: "bg-indigo-100 text-indigo-700" },
  individual: { label: "تخصيص فرديّ", cls: "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]" },
  admin: { label: "مدير النظام", cls: "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]" },
};
const LEVEL_CLS: Record<string, string> = {
  FULL: "text-[var(--sem-pos)] font-semibold",
  READ: "text-[var(--sem-info)]",
  NONE: "text-muted-foreground",
};

export function EffectivePermissionsPanel({ userId }: { userId: number }) {
  const q = trpc.users.effectivePermissions.useQuery({ userId }, { enabled: userId > 0 });
  const data = q.data;
  if (q.isLoading) return <div className="text-xs text-muted-foreground">جارٍ حساب الأثر الفعليّ…</div>;
  if (!data) return null;

  // نُظهر الوحدات المؤثّرة (غير NONE) أولاً، ثم يمكن للمالك رؤية الكل — نكتفي بغير NONE لتقليل الضجيج.
  const active = data.modules.filter((m) => m.level !== "NONE");

  return (
    <div className="space-y-3">
      {data.customRoleInactive && (
        <div className="flex items-start gap-2 rounded-md border border-[var(--stock-low)] badge-stock-low p-2 text-xs">
          <AlertTriangle aria-hidden className="size-4 mt-0.5 shrink-0" />
          <span>دور هذا الحساب المخصّص <b>مُعطَّل</b> — يعمل حالياً بصلاحيات فئته الأساس الكاملة. فعّل الدور أو أسنِد دوراً آخر.</span>
        </div>
      )}

      {/* ملخّص القسم الفعليّ — من الملخّص المحسوب خادمياً (يصدق على الأدوار المخصّصة). */}
      <EffectiveAccessPreview
        role={data.effectiveRole}
        summary={data.access}
        title="الوصول الفعليّ الحاليّ (من الحالة المحفوظة)"
      />

      {/* جدول الوحدات المؤثّرة + مصدر كل قيمة */}
      <div className="rounded-lg border overflow-hidden">
        <div className="flex items-center gap-1.5 bg-muted/40 px-3 py-1.5 text-xs font-semibold">
          <ShieldCheck aria-hidden className="size-3.5" /> الوحدات المؤثّرة ومصدر كل صلاحية
        </div>
        <table className="w-full text-xs">
          <thead className="bg-muted/20 text-muted-foreground">
            <tr><th className="p-1.5 text-start">الوحدة</th><th className="p-1.5 text-start">المستوى</th><th className="p-1.5 text-start">المصدر</th></tr>
          </thead>
          <tbody>
            {active.map((m) => {
              const src = SOURCE_LABEL[m.source] ?? SOURCE_LABEL.template;
              return (
                <tr key={m.key} className="border-t">
                  <td className="p-1.5">{m.label}</td>
                  <td className={`p-1.5 ${LEVEL_CLS[m.level]}`}>{accessLabel(m.level)}</td>
                  <td className="p-1.5"><span className={`inline-block rounded-full px-1.5 py-0.5 ${src.cls}`}>{src.label}</span></td>
                </tr>
              );
            })}
            {active.length === 0 && (
              <tr><td colSpan={3} className="p-2 text-center text-muted-foreground">لا وحدات مؤثّرة — قراءة محدودة فقط.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
