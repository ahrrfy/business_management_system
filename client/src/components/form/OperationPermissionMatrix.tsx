import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { OperationalCaps } from "@shared/atomicPermissions";
import { type OperationPolicy } from "@shared/operationPermissions";
import { ShieldCheck } from "lucide-react";
import { OperationPermissionFilters } from "@/components/form/OperationPermissionFilters";
import { OperationPermissionVisibility } from "@/components/form/OperationPermissionVisibility";
import { OperationPermissionRow } from "@/components/form/OperationPermissionRow";
import { moduleLabel, operations, requiresCost, stageLabel } from "./operationPermissionMatrixHelpers";
export { editableOperationPolicy, individualOperationOverrides } from "./operationPermissionMatrixHelpers";

export interface OperationPermissionMatrixProps {
  value: OperationPolicy | null;
  onChange: (policy: OperationPolicy) => void;
  mode: "role" | "user";
  inherited?: OperationPolicy;
  baseline?: OperationPolicy | null;
  disabled?: boolean;
  dailyOperationPaths?: readonly string[];
  operationalCaps?: OperationalCaps | null;
  inheritedOperationalCaps?: OperationalCaps | null;
  onOperationalCapsChange?: (caps: OperationalCaps | null) => void;
}

/** جدول صف واحد لكل عملية؛ بلا صفحات فرعية أو مجموعات إجبارية مطوية. */
export function OperationPermissionMatrix({
  value, onChange, mode, inherited, baseline, disabled,
  dailyOperationPaths = [], operationalCaps, inheritedOperationalCaps,
  onOperationalCapsChange,
}: OperationPermissionMatrixProps) {
  const id = useId();
  const daily = useMemo(() => new Set(dailyOperationPaths), [dailyOperationPaths]);
  const [query, setQuery] = useState("");
  const [domain, setDomain] = useState("");
  const [stage, setStage] = useState("");
  const [filter, setFilter] = useState(daily.size ? "daily" : "all");
  useEffect(() => {
    if (!daily.size && filter === "daily") setFilter("all");
  }, [daily.size, filter]);
  const visibilityAllowed = (policy: OperationPolicy | null | undefined) =>
    (policy?.dataVisibility?.purchaseCost ?? (mode === "user" ? inherited?.dataVisibility?.purchaseCost : false)) === true &&
    (policy?.dataVisibility?.profitMargin ?? (mode === "user" ? inherited?.dataVisibility?.profitMargin : false)) === true;
  const costAllowed = visibilityAllowed(value);
  const effective = (key: string, policy = value) =>
    policy?.grants[key] ?? (mode === "user" ? inherited?.grants[key] === true : false);
  const previous = (key: string) =>
    baseline?.grants[key] ?? (mode === "user" ? inherited?.grants[key] === true : false);
  const domains = useMemo(() => Array.from(new Set(operations.map((item) => item.domain))), []);
  const stages = useMemo(() => Array.from(new Set(operations.map((item) => item.lifecycleStage))), []);
  const currentAllowed = (operation: (typeof operations)[number]) =>
    effective(operation.key) && (!requiresCost(operation) || costAllowed);
  const hasIndividualOverride = (key: string) =>
    value?.grants[key] !== undefined || value?.recordScopes?.[key] !== undefined;
  const term = query.trim().toLocaleLowerCase();
  const visible = operations
    .filter((operation) => {
      if (domain && operation.domain !== domain) return false;
      if (stage && operation.lifecycleStage !== stage) return false;
      const granted = currentAllowed(operation);
      if (filter === "daily" && !daily.has(operation.path)) return false;
      if (filter === "allow" && !granted) return false;
      if (filter === "deny" && granted) return false;
      if (filter === "blocked" && (!effective(operation.key) || granted)) return false;
      if (filter === "overrides" && !hasIndividualOverride(operation.key)) return false;
      return !term || `${operation.label} ${operation.resource} ${moduleLabel(operation.domain)} ${stageLabel(operation.lifecycleStage)} ${operation.path} ${operation.key}`.toLocaleLowerCase().includes(term);
    })
    .sort((a, b) => Number(daily.has(b.path)) - Number(daily.has(a.path)) || a.resource.localeCompare(b.resource, "ar") || a.label.localeCompare(b.label, "ar"));
  const permitted = operations.filter(currentAllowed).length;
  const previousAllowed = (operation: (typeof operations)[number]) =>
    previous(operation.key) && (!requiresCost(operation) || visibilityAllowed(baseline));
  const added = operations.filter((operation) => currentAllowed(operation) && !previousAllowed(operation)).length;
  const removed = operations.filter((operation) => !currentAllowed(operation) && previousAllowed(operation)).length;

  function setGrants(keys: string[], selection: "allow" | "deny" | "inherit") {
    const grants = { ...(value?.grants ?? {}) };
    for (const key of keys) {
      if (selection === "allow" && !costAllowed && operations.some((item) => item.key === key && requiresCost(item))) continue;
      if (selection === "inherit") delete grants[key];
      else grants[key] = selection === "allow";
    }
    onChange({ ...(value ?? { version: 1 }), grants });
  }
  function setVisibility(selection: "allow" | "deny" | "inherit") {
    const dataVisibility = { ...(value?.dataVisibility ?? {}) };
    if (selection === "inherit") {
      delete dataVisibility.purchaseCost;
      delete dataVisibility.profitMargin;
    } else {
      dataVisibility.purchaseCost = selection === "allow";
      dataVisibility.profitMargin = selection === "allow";
    }
    onChange({ ...(value ?? { version: 1, grants: {} }), dataVisibility });
  }
  function restoreInheritance(keys: string[]) {
    const grants = { ...(value?.grants ?? {}) };
    const recordScopes = { ...(value?.recordScopes ?? {}) };
    for (const key of keys) { delete grants[key]; delete recordScopes[key]; }
    onChange({ ...(value ?? { version: 1 }), grants, recordScopes });
  }
  function setScope(key: string, selection: string) {
    const recordScopes = { ...(value?.recordScopes ?? {}) };
    if (selection === "inherit") delete recordScopes[key];
    else recordScopes[key] = selection as "OWN" | "BRANCH";
    onChange({ ...(value ?? { version: 1, grants: {} }), recordScopes });
  }

  return (
    <div className="space-y-3" dir="rtl">
      <p className="text-sm text-muted-foreground">
        {mode === "user"
          ? "كل صف يرث قرار الدور، ويمكن منحه أو منعه أو وضع سقف فردي من الصفحة نفسها."
          : "كل صف عملية مستقلة. التفويض يحدد من يستطيع التنفيذ، والسقف يحدد متى ينتقل إلى الاعتماد."}
      </p>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border bg-muted/30 p-3 text-sm" aria-live="polite">
        <span className="inline-flex items-center gap-1.5"><ShieldCheck className="size-4" aria-hidden />{permitted} عملية مفوّضة من {operations.length}</span>
        <span>أثر الحفظ: منح {added}، منع {removed}</span>
        {!!daily.size && <span>{daily.size} مهمة يومية افتراضية</span>}
      </div>
      <OperationPermissionVisibility id={id} mode={mode} disabled={disabled}
        costVisibility={value?.dataVisibility?.purchaseCost}
        inheritedCostVisibility={inherited?.dataVisibility?.purchaseCost === true}
        setVisibility={setVisibility} />
      <OperationPermissionFilters id={id} mode={mode} query={query} domain={domain} stage={stage} filter={filter}
        domains={domains} stages={stages} hasDailyTasks={daily.size > 0}
        setQuery={setQuery} setDomain={setDomain} setStage={setStage} setFilter={setFilter} />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span>{visible.length} عملية مطابقة</span>
        <Button type="button" size="sm" variant="outline" disabled={disabled || !visible.length} onClick={() => setGrants(visible.map((item) => item.key), "allow")}>منح النتائج المصفّاة</Button>
        <Button type="button" size="sm" variant="outline" disabled={disabled || !visible.length} onClick={() => setGrants(visible.map((item) => item.key), "deny")}>منع النتائج المصفّاة</Button>
        {mode === "user" && <Button type="button" size="sm" variant="outline" disabled={disabled || !visible.length} onClick={() => restoreInheritance(visible.map((item) => item.key))}>إعادة النتائج إلى وراثة الدور</Button>}
      </div>
      <div className="overflow-x-auto border">
        <div className="min-w-[980px]">
          <div className="grid grid-cols-[minmax(210px,1.4fr)_minmax(150px,1fr)_150px_240px_180px] gap-3 border-b bg-muted/40 px-3 py-2 text-xs font-semibold">
            <span>العملية</span><span>المورد والمرحلة</span><span>التفويض</span><span>قرار التنفيذ والسقف</span><span>نطاق السجلات</span>
          </div>
          <div className="divide-y">
            {visible.map((operation) => (
              <OperationPermissionRow key={operation.key} id={id} operation={operation} value={value} inherited={inherited}
                mode={mode} disabled={disabled} costAllowed={costAllowed} effective={effective}
                setGrants={setGrants} setScope={setScope} isDaily={daily.has(operation.path)}
                operationalCaps={operationalCaps} inheritedOperationalCaps={inheritedOperationalCaps}
                onOperationalCapsChange={onOperationalCapsChange} />
            ))}
            {!visible.length && <p className="p-4 text-center text-sm text-muted-foreground">لا عمليات تطابق البحث والتصفية.</p>}
          </div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">العمليات المحجوزة للمالك وإدارة النظام لا تُمنح من هذه المصفوفة. شروط الفرع والوردية وحالة المستند وفصل المهام تُفحص عند التنفيذ.</p>
    </div>
  );
}
