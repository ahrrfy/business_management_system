import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppSelect } from "@/components/ui/AppSelect";
import { Search } from "lucide-react";
import { moduleLabel, stageLabel } from "./operationPermissionMatrixHelpers";

interface OperationPermissionFiltersProps {
  id: string;
  mode: "role" | "user";
  query: string;
  domain: string;
  stage: string;
  filter: string;
  domains: string[];
  stages: string[];
  hasDailyTasks?: boolean;
  setQuery: (next: string) => void;
  setDomain: (next: string) => void;
  setStage: (next: string) => void;
  setFilter: (next: string) => void;
}

export function OperationPermissionFilters({
  id,
  mode,
  query,
  domain,
  stage,
  filter,
  domains,
  stages,
  hasDailyTasks,
  setQuery,
  setDomain,
  setStage,
  setFilter,
}: OperationPermissionFiltersProps) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
      <div className="space-y-1">
        <Label htmlFor={`${id}-query`}>بحث عن عملية أو مورد</Label>
        <div className="relative">
          <Search
            className="absolute end-2.5 top-2.5 size-4 text-muted-foreground"
            aria-hidden
          />
          <Input
            id={`${id}-query`}
            className="pe-9"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="مثال: إسناد التوصيل، مرتجع"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-domain`}>مجال العمل</Label>
        <AppSelect id={`${id}-domain`} value={domain} onValueChange={setDomain}>
          <option value="">كل المجالات</option>
          {domains.map((item) => (
            <option key={item} value={item}>
              {moduleLabel(item)}
            </option>
          ))}
        </AppSelect>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-stage`}>مرحلة دورة العمل</Label>
        <AppSelect id={`${id}-stage`} value={stage} onValueChange={setStage}>
          <option value="">كل المراحل</option>
          {stages.map((item) => (
            <option key={item} value={item}>
              {stageLabel(item)}
            </option>
          ))}
        </AppSelect>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-filter`}>حالة التفويض</Label>
        <AppSelect id={`${id}-filter`} value={filter} onValueChange={setFilter}>
          <option value="all">كل العمليات</option>
          {hasDailyTasks && <option value="daily">المهام اليومية الافتراضية</option>}
          <option value="allow">المفوّضة فقط</option>
          <option value="deny">الممنوعة فقط</option>
          <option value="blocked">مختارة ومحجوبة بإذن التكلفة</option>
          {mode === "user" && (
            <option value="overrides">الاستثناءات الفردية فقط</option>
          )}
        </AppSelect>
      </div>
    </div>
  );
}
