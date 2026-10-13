import { Button } from "@/components/ui/button";
import { AppSelect } from "@/components/ui/AppSelect";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  OperationPermissionMatrix,
  editableOperationPolicy,
} from "@/components/form/OperationPermissionMatrix";
import {
  buildOperationPolicyFromLegacy,
  summarizeOperationModules,
  type OperationPolicy,
} from "@shared/operationPermissions";
import type { OperationalCaps } from "@shared/atomicPermissions";
import { resolveOperationalCaps } from "@shared/atomicPermissions";
import {
  buildDefaultRoleOperationPolicy,
  dailyOperationPaths,
  hasRoleOperationPreset,
} from "@shared/roleOperationPresets";
import { OperationalCapsPanel } from "@/components/permissions/OperationalCapsPanel";
import {
  ROLE_TEMPLATES,
  ROLES,
  applyPermissionOverrides,
  type PermissionMap,
  type RoleKey,
} from "@/lib/permissionsModel";
import { confirm } from "@/lib/confirm";
import { trpc } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";
import { useSaveShortcuts } from "@/hooks/useSaveShortcuts";
import { useUnsavedGuard, bypassUnsavedGuard } from "@/hooks/useUnsavedGuard";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";

const BASE_ROLE_OPTIONS = ROLES.filter((role) => role.key !== "admin");
const emptyPolicy = (): OperationPolicy => ({
  version: 1,
  grants: {},
  dataVisibility: { purchaseCost: false, profitMargin: false },
});

export default function RoleEdit() {
  const [, navigate] = useLocation();
  const [, editParams] = useRoute<{ id: string }>("/roles/:id/edit");
  const utils = trpc.useUtils();
  const roleId = editParams?.id ? Number(editParams.id) : 0;
  const isEdit = roleId > 0;
  const detail = trpc.roles.get.useQuery({ id: roleId }, { enabled: isEdit });
  const rolesList = trpc.roles.list.useQuery();
  const assignedCount = isEdit
    ? Number(
        (rolesList.data?.counts as Record<string, number> | undefined)?.[
          roleId
        ] ?? 0,
      )
    : 0;
  const cloneRoles = rolesList.data?.custom ?? [];
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [baseRole, setBaseRole] = useState<RoleKey>("user");
  const [operationPolicy, setOperationPolicy] =
    useState<OperationPolicy>(emptyPolicy);
  const [initialPolicy, setInitialPolicy] =
    useState<OperationPolicy>(emptyPolicy);
  const [operationalCaps, setOperationalCaps] = useState<OperationalCaps>(() => resolveOperationalCaps("user"));
  const [capsEdited, setCapsEdited] = useState(false);
  const [policyEdited, setPolicyEdited] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const baseline = useRef("");

  useEffect(() => {
    if (!isEdit || !detail.data || loaded) return;
    const row = detail.data;
    const base = (row.baseRole as RoleKey) ?? "user";
    const modules = applyPermissionOverrides(
      ROLE_TEMPLATES[base],
      row.permissions as PermissionMap | null,
    );
    const roleKey = String(row.key ?? base);
    const policy = editableOperationPolicy(
      row.operationPolicy ??
        (hasRoleOperationPreset(roleKey)
          ? buildDefaultRoleOperationPolicy(roleKey, base, modules)
          : buildOperationPolicyFromLegacy(
          base,
          modules,
          row.atomicPermissions as Record<string, boolean> | null,
          row.permissions as PermissionMap | null,
        )),
    );
    const caps = (row.operationalCaps as OperationalCaps | null) ?? resolveOperationalCaps(roleKey, null, null, base);
    setLabel(row.label ?? "");
    setDescription(row.description ?? "");
    setBaseRole(base);
    setOperationPolicy(policy);
    setInitialPolicy(policy);
    setOperationalCaps(caps);
    setCapsEdited(false);
    setRevision(row.operationPolicyRevision ?? 0);
    baseline.current = JSON.stringify({
      label: row.label ?? "",
      description: row.description ?? "",
      baseRole: base,
      operationPolicy: policy,
      operationalCaps: caps,
    });
    setLoaded(true);
  }, [detail.data, isEdit, loaded]);

  const snapshot = JSON.stringify({
    label,
    description,
    baseRole,
    operationPolicy,
    operationalCaps,
  });
  const newBlank =
    !label &&
    !description &&
    baseRole === "user" &&
    JSON.stringify(operationPolicy) === JSON.stringify(emptyPolicy());
  useUnsavedGuard(isEdit ? loaded && snapshot !== baseline.current : !newBlank);
  function changePolicy(policy: OperationPolicy) {
    setOperationPolicy(policy);
    setPolicyEdited(true);
  }
  function cloneFrom(value: string) {
    if (!value) return;
    if (value === "blank") {
      changePolicy(emptyPolicy());
      return;
    }
    if (value.startsWith("builtin:")) {
      const base = value.slice(8) as RoleKey;
      setBaseRole(base);
      changePolicy(
        editableOperationPolicy(
          buildDefaultRoleOperationPolicy(base, base, ROLE_TEMPLATES[base]),
        ),
      );
      setOperationalCaps(resolveOperationalCaps(base));
      setCapsEdited(true);
      return;
    }
    const source = cloneRoles.find(
      (role) => Number(role.id) === Number(value.slice(7)),
    );
    if (!source) return;
    const base = (source.baseRole as RoleKey) ?? "user";
    const modules = applyPermissionOverrides(
      ROLE_TEMPLATES[base],
      source.permissions as PermissionMap | null,
    );
    setBaseRole(base);
    setOperationalCaps((source.operationalCaps as OperationalCaps | null) ?? resolveOperationalCaps(String(source.key ?? base), null, null, base));
    setCapsEdited(true);
    const sourceKey = String(source.key ?? base);
    changePolicy(
      editableOperationPolicy(
        source.operationPolicy ??
          (hasRoleOperationPreset(sourceKey)
            ? buildDefaultRoleOperationPolicy(sourceKey, base, modules)
            : buildOperationPolicyFromLegacy(
                base,
                modules,
                source.atomicPermissions as Record<string, boolean> | null,
                source.permissions as PermissionMap | null,
              )),
      ),
    );
  }
  const create = trpc.roles.create.useMutation({
    onSuccess: async () => {
      await utils.roles.list.invalidate();
      bypassUnsavedGuard();
      navigate("/roles");
    },
    onError: (cause) => setError(cause.message),
  });
  const update = trpc.roles.update.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.roles.list.invalidate(),
        utils.roles.get.invalidate({ id: roleId }),
      ]);
      bypassUnsavedGuard();
      navigate("/roles");
    },
    onError: (cause) => setError(cause.message),
  });
  const pending = create.isPending || update.isPending;
  async function submit() {
    setError("");
    if (!label.trim()) {
      setError("اسم الدور مطلوب.");
      return;
    }
    if (
      isEdit &&
      assignedCount > 0 &&
      !(await confirm({
        variant: "warning",
        title: "تطبيق تعديل الدور",
        description: `سيُطبّق هذا التعديل على ${assignedCount} حساباً مرتبطاً بالدور، وقد يحتاج أصحابها إلى تسجيل الدخول مجدداً. راجع أثر المنح والمنع في المصفوفة قبل الحفظ.`,
        confirmText: "حفظ وتطبيق",
      }))
    )
      return;
    const persistPolicy =
      !isEdit || !!detail.data?.operationPolicy || policyEdited;
    const payload = {
      label: label.trim(),
      description: description.trim() || null,
      baseRole,
      permissions: persistPolicy
        ? summarizeOperationModules(operationPolicy)
        : ((detail.data?.permissions as PermissionMap) ?? {}),
      ...(persistPolicy
        ? { operationPolicy: editableOperationPolicy(operationPolicy) }
        : {}),
      ...(!isEdit || capsEdited ? { operationalCaps } : {}),
    };
    if (isEdit)
      update.mutate({
        id: roleId,
        ...payload,
        expectedOperationPolicyRevision: revision,
      });
    else create.mutate(payload);
  }
  useSaveShortcuts({
    onSave: () => void submit(),
    enabled: !pending && (!isEdit || loaded),
  });
  if (isEdit && detail.isLoading)
    return (
      <div className="p-6 text-center text-muted-foreground">
        {ACTION_LABELS.loading}
      </div>
    );
  if (isEdit && !detail.data)
    return (
      <div className="p-6 text-destructive">
        {detail.error?.message ?? "الدور غير موجود."}
      </div>
    );
  return (
    <div className="space-y-4">
      <PageHeader
        title={isEdit ? "تعديل دور" : "إضافة دور مخصّص"}
        backHref="/roles"
        backLabel="رجوع للأدوار"
      />
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Card>
          <CardHeader>
            <CardTitle className="text-base">بيانات الدور</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="role-label">اسم الدور *</Label>
              <Input
                id="role-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="مثال: مسؤول إسناد التوصيل"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="role-base">الفئة الوظيفية الأساسية</Label>
              <AppSelect
                id="role-base"
                value={baseRole}
                onValueChange={(next) => {
                  const selected = next as RoleKey;
                  setBaseRole(selected);
                  if (!policyEdited) {
                    setOperationPolicy(editableOperationPolicy(buildDefaultRoleOperationPolicy(selected, selected, ROLE_TEMPLATES[selected])));
                    setInitialPolicy(editableOperationPolicy(buildDefaultRoleOperationPolicy(selected, selected, ROLE_TEMPLATES[selected])));
                    setOperationalCaps(resolveOperationalCaps(selected));
                    setCapsEdited(true);
                  }
                }}
              >
                {BASE_ROLE_OPTIONS.map((role) => (
                  <option key={role.key} value={role.key}>
                    {role.label}
                  </option>
                ))}
              </AppSelect>
              <p className="text-xs text-muted-foreground">
                تغيير الفئة لا يبدّل اختيارات التفويض. تبقى الضوابط المحجوزة
                لإدارة النظام خاضعة لفئتها.
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="role-description">الوصف</Label>
              <Input
                id="role-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="المهام والمسؤوليات"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="role-clone">نسخ صلاحيات من دور (اختياري)</Label>
              <AppSelect id="role-clone" value="" onValueChange={cloneFrom}>
                <option value="">اختر نموذجاً للنسخ ثم عدّل</option>
                <option value="blank">إفراغ جميع التفويضات</option>
                <optgroup label="قوالب الفئات الوظيفية">
                  {BASE_ROLE_OPTIONS.map((role) => (
                    <option key={role.key} value={`builtin:${role.key}`}>
                      {role.label}
                    </option>
                  ))}
                </optgroup>
                {cloneRoles.length > 0 && (
                  <optgroup label="الأدوار المحفوظة">
                    {cloneRoles
                      .filter((role) => role.id !== roleId)
                      .map((role) => (
                        <option key={role.id} value={`custom:${role.id}`}>
                          {role.label}
                        </option>
                      ))}
                  </optgroup>
                )}
              </AppSelect>
              <p className="text-xs text-muted-foreground">
                الدور الجديد يبدأ بلا تفويضات. النسخ يغيّر اختيارات هذا الدور
                وحده.
              </p>
            </div>
            {isEdit && (
              <p className="text-sm text-muted-foreground md:col-span-2 lg:col-span-3">
                هذا الدور مرتبط بـ{assignedCount} حساباً. الاستثناءات الفردية
                للمستخدمين تبقى مستقلة عنه.
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              تفويض العمليات ومراحل العمل
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {isEdit && !detail.data?.operationPolicy && (
              <p className="border p-3 text-xs text-muted-foreground">
                عُرضت الصلاحيات الحالية للمراجعة. تعديل اختيارات المصفوفة يحوّل
                الدور إلى تفويض العمليات المستقل عند الحفظ.
              </p>
            )}
            <OperationPermissionMatrix
              mode="role"
              value={operationPolicy}
              baseline={initialPolicy}
              onChange={changePolicy}
              disabled={pending}
              dailyOperationPaths={dailyOperationPaths(String(detail.data?.key ?? baseRole), baseRole)}
              operationalCaps={operationalCaps}
              onOperationalCapsChange={(caps) => {
                setOperationalCaps(caps ?? {});
                setCapsEdited(true);
              }}
            />
          </CardContent>
        </Card>
        <OperationalCapsPanel
          caps={operationalCaps}
          onChange={(caps) => {
            setOperationalCaps(caps);
            setCapsEdited(true);
          }}
          disabled={pending}
        />
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={pending}>
            {pending
              ? ACTION_LABELS.saving
              : isEdit
                ? "حفظ التعديلات"
                : "حفظ الدور"}
          </Button>
          <Link href="/roles">
            <Button type="button" variant="ghost">
              إلغاء
            </Button>
          </Link>
        </div>
      </form>
    </div>
  );
}
