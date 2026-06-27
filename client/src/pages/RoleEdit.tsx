import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionMatrix } from "@/components/form/PermissionMatrix";
import {
  PERMISSION_MODULES,
  ROLE_TEMPLATES,
  ROLES,
  type AccessLevel,
  type PermissionMap,
  type RoleKey,
} from "@/lib/permissionsModel";
import { trpc } from "@/lib/trpc";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** الفئات الأساسية المتاحة لدور مخصّص (admin مستثنى — يمنح وصولاً كاملاً يتجاوز التخصيص). */
const BASE_ROLE_OPTIONS = ROLES.filter((r) => r.key !== "admin");

/** يبني خريطة صلاحيات كاملة من قالب فئة أساسية. */
function fullMapFromBase(base: RoleKey): PermissionMap {
  const tpl = ROLE_TEMPLATES[base] ?? ROLE_TEMPLATES.user;
  const out: PermissionMap = {};
  for (const m of PERMISSION_MODULES) out[m.key] = tpl[m.key] ?? "NONE";
  return out;
}

export default function RoleEdit() {
  const [, navigate] = useLocation();
  const [, editParams] = useRoute<{ id: string }>("/roles/:id/edit");
  const utils = trpc.useUtils();
  const roleId = editParams?.id ? Number(editParams.id) : 0;
  const isEdit = roleId > 0;

  const detail = trpc.roles.get.useQuery({ id: roleId }, { enabled: isEdit });

  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [baseRole, setBaseRole] = useState<RoleKey>("cashier");
  const [permissions, setPermissions] = useState<PermissionMap>(() => fullMapFromBase("cashier"));
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (isEdit && detail.data && !loaded) {
      const d = detail.data;
      setLabel(d.label ?? "");
      setDescription(d.description ?? "");
      setBaseRole((d.baseRole as RoleKey) ?? "cashier");
      const map = (d.permissions as PermissionMap) ?? {};
      const full: PermissionMap = {};
      for (const m of PERMISSION_MODULES) full[m.key] = map[m.key] ?? "NONE";
      setPermissions(full);
      setLoaded(true);
    }
  }, [isEdit, detail.data, loaded]);

  const baseInfo = ROLES.find((r) => r.key === baseRole);
  const customCount = useMemo(
    () => PERMISSION_MODULES.reduce((a, m) => a + (permissions[m.key] !== (ROLE_TEMPLATES[baseRole]?.[m.key] ?? "NONE") ? 1 : 0), 0),
    [permissions, baseRole],
  );

  function handleBaseRoleChange(next: RoleKey) {
    setBaseRole(next);
    // غيّر الفئة الأساسية ⇒ أعد ضبط الخريطة لقالبها (نقطة بداية واضحة).
    setPermissions(fullMapFromBase(next));
  }
  function handlePermChange(moduleKey: string, level: AccessLevel) {
    setPermissions((p) => ({ ...p, [moduleKey]: level }));
  }

  const createM = trpc.roles.create.useMutation({
    onSuccess: () => { utils.roles.list.invalidate(); navigate("/roles"); },
    onError: (e) => setError(e.message),
  });
  const updateM = trpc.roles.update.useMutation({
    onSuccess: () => { utils.roles.list.invalidate(); utils.roles.get.invalidate({ id: roleId }); navigate("/roles"); },
    onError: (e) => setError(e.message),
  });
  const pending = createM.isPending || updateM.isPending;

  function submit() {
    setError("");
    if (!label.trim()) { setError("اسم الدور مطلوب."); return; }
    const payload = { label: label.trim(), description: description.trim() || null, baseRole, permissions: permissions as Record<string, AccessLevel> };
    if (isEdit) updateM.mutate({ id: roleId, ...payload });
    else createM.mutate(payload);
  }

  if (isEdit && detail.isLoading) return <div className="p-6 text-center text-muted-foreground">جارٍ تحميل الدور…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{isEdit ? "تعديل دور" : "إضافة دور مخصّص"}</h1>
        <Link href="/roles" className="text-sm text-muted-foreground">← رجوع للأدوار</Link>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">بيانات الدور</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-start">
          <div className="space-y-1">
            <Label htmlFor="label">اسم الدور *</Label>
            <Input id="label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="مثال: مشرف فرع، مسؤول تحصيل" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="base">الفئة الأساسية (المستوى)</Label>
            <select id="base" className={selectCls} value={baseRole} onChange={(e) => handleBaseRoleChange(e.target.value as RoleKey)}>
              {BASE_ROLE_OPTIONS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
            <p className="text-[11px] text-muted-foreground">
              تحدّد البوّابات الخشنة ورؤية التكلفة{baseInfo?.canSeeCost ? " (يرى التكلفة)" : " (لا يرى التكلفة)"}. ابدأ من قالبها ثم خصّص.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="desc">وصف (اختياري)</Label>
            <Input id="desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="وصف موجز لمهام هذا الدور" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            الصلاحيات
            {customCount > 0 && <span className="text-[10px] font-medium text-primary mr-2 align-middle">{customCount} مخصّص عن القالب</span>}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <PermissionMatrix
            role={baseRole}
            permissions={permissions}
            onChange={handlePermChange}
            onReset={() => setPermissions(fullMapFromBase(baseRole))}
          />
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button onClick={submit} disabled={pending}>{pending ? "جارٍ الحفظ…" : isEdit ? "حفظ التعديلات" : "حفظ الدور"}</Button>
        <Link href="/roles"><Button variant="ghost">إلغاء</Button></Link>
      </div>
    </div>
  );
}
