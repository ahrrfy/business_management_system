import { useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { type OperationPolicy } from "@shared/operationPermissions";
import { ChevronDown, ShieldCheck } from "lucide-react";
import { OperationPermissionFilters } from "@/components/form/OperationPermissionFilters";
import { OperationPermissionVisibility } from "@/components/form/OperationPermissionVisibility";
import { OperationPermissionRow } from "@/components/form/OperationPermissionRow";
import {
  moduleLabel,
  operations,
  requiresCost,
  stageLabel,
} from "./operationPermissionMatrixHelpers";
export {
  editableOperationPolicy,
  individualOperationOverrides,
} from "./operationPermissionMatrixHelpers";

export interface OperationPermissionMatrixProps {
  value: OperationPolicy | null;
  onChange: (policy: OperationPolicy) => void;
  mode: "role" | "user";
  inherited?: OperationPolicy;
  baseline?: OperationPolicy | null;
  disabled?: boolean;
}

/** Role definitions are complete; individual overrides remain sparse and continue inheriting future role edits. */
export function OperationPermissionMatrix({
  value,
  onChange,
  mode,
  inherited,
  baseline,
  disabled,
}: OperationPermissionMatrixProps) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [domain, setDomain] = useState("");
  const [stage, setStage] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(0);
  const visibilityAllowed = (policy: OperationPolicy | null | undefined) =>
    (policy?.dataVisibility?.purchaseCost ??
      (mode === "user" ? inherited?.dataVisibility?.purchaseCost : false)) ===
      true &&
    (policy?.dataVisibility?.profitMargin ??
      (mode === "user" ? inherited?.dataVisibility?.profitMargin : false)) ===
      true;
  const costAllowed = visibilityAllowed(value);
  const effective = (key: string, policy = value) =>
    policy?.grants[key] ??
    (mode === "user" ? inherited?.grants[key] === true : false);
  const previous = (key: string) =>
    baseline?.grants[key] ??
    (mode === "user" ? inherited?.grants[key] === true : false);
  const domains = useMemo(
    () => Array.from(new Set(operations.map((operation) => operation.domain))),
    [],
  );
  const stages = useMemo(
    () =>
      Array.from(
        new Set(operations.map((operation) => operation.lifecycleStage)),
      ),
    [],
  );
  const currentAllowed = (operation: (typeof operations)[number]) =>
    effective(operation.key) && (!requiresCost(operation) || costAllowed);
  const hasIndividualOverride = (key: string) =>
    value?.grants[key] !== undefined || value?.recordScopes?.[key] !== undefined;
  const individualOverrideCount = new Set([
    ...Object.keys(value?.grants ?? {}),
    ...Object.keys(value?.recordScopes ?? {}),
  ]).size;
  const term = query.trim().toLocaleLowerCase();
  const visible = operations.filter((operation) => {
    if (domain && operation.domain !== domain) return false;
    if (stage && operation.lifecycleStage !== stage) return false;
    const granted = currentAllowed(operation);
    if (filter === "allow" && !granted) return false;
    if (filter === "deny" && granted) return false;
    if (filter === "blocked" && (!effective(operation.key) || granted))
      return false;
    if (filter === "overrides" && !hasIndividualOverride(operation.key))
      return false;
    return (
      !term ||
      `${operation.label} ${operation.resource} ${moduleLabel(operation.domain)} ${stageLabel(operation.lifecycleStage)} ${operation.path} ${operation.key}`
        .toLocaleLowerCase()
        .includes(term)
    );
  });
  const groups = useMemo(() => {
    const grouped = new Map<string, typeof visible>();
    for (const operation of visible) {
      const key = `${operation.domain} / ${operation.resource}`;
      const group = grouped.get(key) ?? [];
      group.push(operation);
      grouped.set(key, group);
    }
    return Array.from(grouped.entries());
  }, [visible]);
  const pageSize = 8;
  const pages = Math.max(1, Math.ceil(groups.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const permitted = operations.filter(
    (operation) =>
      effective(operation.key) && (!requiresCost(operation) || costAllowed),
  ).length;
  const costBlocked = visible.filter(
    (operation) => requiresCost(operation) && !costAllowed,
  ).length;
  const previousAllowed = (operation: (typeof operations)[number]) =>
    previous(operation.key) &&
    (!requiresCost(operation) || visibilityAllowed(baseline));
  const added = operations.filter(
    (operation) => currentAllowed(operation) && !previousAllowed(operation),
  ).length;
  const removed = operations.filter(
    (operation) => !currentAllowed(operation) && previousAllowed(operation),
  ).length;

  function setGrants(keys: string[], selection: "allow" | "deny" | "inherit") {
    const grants = { ...(value?.grants ?? {}) };
    for (const key of keys) {
      if (
        selection === "allow" &&
        !costAllowed &&
        operations.some(
          (operation) => operation.key === key && requiresCost(operation),
        )
      )
        continue;
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
    for (const key of keys) {
      delete grants[key];
      delete recordScopes[key];
    }
    onChange({ ...(value ?? { version: 1 }), grants, recordScopes });
  }
  function setScope(key: string, selection: string) {
    const recordScopes = { ...(value?.recordScopes ?? {}) };
    if (selection === "inherit") delete recordScopes[key];
    else recordScopes[key] = selection as "OWN" | "BRANCH";
    onChange({ ...(value ?? { version: 1, grants: {} }), recordScopes });
  }
  const costVisibility = value?.dataVisibility?.purchaseCost;
  const inheritedCostVisibility =
    inherited?.dataVisibility?.purchaseCost === true;

  const resetPage = (set: (next: string) => void) => (next: string) => {
    set(next);
    setPage(0);
  };

  return (
    <div className="space-y-3" dir="rtl">
      <p className="text-sm text-muted-foreground">
        {mode === "user"
          ? "كل عملية ترث تفويض الدور، ويمكن منحها أو منعها لهذا المستخدم وحده. العودة إلى الوراثة تُزيل الاستثناء الفردي."
          : "كل اختيار يفوّض عملية مستقلة. العمليات غير المحددة ممنوعة، وتبقى شروط الفرع وحالة المستند وفصل المهام واجبة عند التنفيذ."}
      </p>
      <div
        className="flex flex-wrap items-center gap-x-5 gap-y-1 border bg-muted/30 p-3 text-sm"
        aria-live="polite"
      >
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck className="size-4" aria-hidden />
          {permitted} عملية مفوّضة من {operations.length}
        </span>
        <span>
          أثر الحفظ: منح {added}، منع {removed}
        </span>
        {mode === "user" && (
          <span>{individualOverrideCount} عملية بتخصيص فردي</span>
        )}
      </div>
      <OperationPermissionVisibility
        id={id}
        mode={mode}
        disabled={disabled}
        costVisibility={costVisibility}
        inheritedCostVisibility={inheritedCostVisibility}
        setVisibility={setVisibility}
      />
      <OperationPermissionFilters
        id={id}
        mode={mode}
        query={query}
        domain={domain}
        stage={stage}
        filter={filter}
        domains={domains}
        stages={stages}
        setQuery={resetPage(setQuery)}
        setDomain={resetPage(setDomain)}
        setStage={resetPage(setStage)}
        setFilter={resetPage(setFilter)}
      />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span>{visible.length} عملية تطابق التصفية</span>
        {costBlocked > 0 && (
          <span className="text-destructive">
            {costBlocked} عملية تتطلب تفعيل عرض التكلفة والربح قبل منحها.
          </span>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || !visible.length}
          onClick={() =>
            setGrants(
              visible.map((item) => item.key),
              "allow",
            )
          }
        >
          منح النتائج المصفّاة
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || !visible.length}
          onClick={() =>
            setGrants(
              visible.map((item) => item.key),
              "deny",
            )
          }
        >
          منع النتائج المصفّاة
        </Button>
        {mode === "user" && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || !visible.length}
            onClick={() => restoreInheritance(visible.map((item) => item.key))}
          >
            إعادة النتائج إلى وراثة الدور
          </Button>
        )}
      </div>
      <div className="space-y-2">
        {groups
          .slice(currentPage * pageSize, (currentPage + 1) * pageSize)
          .map(([key, group]) => (
            <details
              key={key}
              className="border"
              open={!!query.trim() || groups.length === 1}
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 bg-muted/30 px-3 py-2 text-sm font-medium">
                <span>
                  {moduleLabel(group[0].domain) === group[0].resource
                    ? group[0].resource
                    : `${moduleLabel(group[0].domain)} / ${group[0].resource}`}
                </span>
                <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                  {group.filter(currentAllowed).length} / {group.length}
                  <ChevronDown className="size-4" aria-hidden />
                </span>
              </summary>
              <div className="divide-y">
                {group.map((operation) => (
                  <OperationPermissionRow
                    key={operation.key}
                    id={id}
                    operation={operation}
                    value={value}
                    inherited={inherited}
                    mode={mode}
                    disabled={disabled}
                    costAllowed={costAllowed}
                    effective={effective}
                    setGrants={setGrants}
                    setScope={setScope}
                  />
                ))}
              </div>
            </details>
          ))}
        {!groups.length && (
          <p className="border p-4 text-center text-sm text-muted-foreground">
            لا عمليات تطابق البحث والتصفية.
          </p>
        )}
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-between gap-2 text-xs">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            الموارد السابقة
          </Button>
          <span>
            مجموعة الموارد {currentPage + 1} من {pages}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={currentPage + 1 >= pages}
            onClick={() => setPage(currentPage + 1)}
          >
            الموارد التالية
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        العمليات المحجوزة للمالك وإدارة النظام، والتحقق من الهوية، والخدمات
        العامة لا تُمنح من هذه المصفوفة. تفويض العملية لا يغيّر قواعدها
        المحاسبية أو يسمح باعتماد الشخص لمستنده.
      </p>
    </div>
  );
}
