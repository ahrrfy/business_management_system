import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { ROLE_OPTIONS } from "@/pages/Users";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

/**
 * منتقي حساب نظام موجود لربطه بموظف — على نمط SmartCustomerInput لكن بلا «إنشاء جديد»
 * (الربط يختار حساباً قائماً فقط). يعرض الحسابات النشطة غير المرتبطة بأي موظف.
 */

export interface SmartUserValue {
  userId: number | null;
  /** نصّ معروض (الاسم + معرّف الدخول). */
  label: string;
}

export interface SmartUserInputProps {
  value: SmartUserValue;
  onChange: (v: SmartUserValue) => void;
  /** الموظف الجاري تعديله — يسمح بإظهار حسابه المرتبط ضمن النتائج (للتعديل). */
  employeeId?: number;
  placeholder?: string;
  className?: string;
}

interface LinkableUser {
  id: number;
  name: string | null;
  email: string | null;
  username: string | null;
  role: string;
}

const roleLabel = (role: string) => ROLE_OPTIONS.find((r) => r.value === role)?.label ?? role;
const userLabel = (u: { name: string | null; username: string | null; email: string | null }) =>
  `${u.name ?? ""}${u.username ? ` (${u.username})` : u.email ? ` (${u.email})` : ""}`.trim();

export function SmartUserInput({ value, onChange, employeeId, placeholder, className }: SmartUserInputProps) {
  const [q, setQ] = useState(value.label || "");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setQ(value.label || "");
  }, [value.userId, value.label]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const trimmed = q.trim();
  const list = trpc.employees.linkableUsers.useQuery(
    { q: trimmed || undefined, limit: 8, employeeId },
    { staleTime: 30_000 },
  );
  const suggestions = (list.data ?? []) as LinkableUser[];
  const noMatch = !list.isLoading && suggestions.length === 0;

  function selectUser(u: LinkableUser) {
    const label = userLabel(u);
    onChange({ userId: u.id, label });
    setQ(label);
    setOpen(false);
  }
  function clear() {
    onChange({ userId: null, label: "" });
    setQ("");
  }

  return (
    <div ref={wrapRef} className={cn("relative", className)}>
      <div className="relative">
        <Input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
            if (value.userId) onChange({ userId: null, label: e.target.value });
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder || "ابحث باسم المستخدم أو البريد"}
          aria-autocomplete="list"
          aria-expanded={open}
        />
        {value.userId && (
          <button
            type="button"
            onClick={clear}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-destructive"
            aria-label="مسح اختيار الحساب"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        )}
      </div>

      {open && (
        <div className="absolute z-20 top-full mt-1 w-full rounded-md border bg-popover shadow-md max-h-72 overflow-auto">
          {list.isLoading && <div className="px-3 py-2 text-sm text-muted-foreground">جارٍ البحث…</div>}
          {!list.isLoading && suggestions.length > 0 && (
            <ul className="py-1">
              {suggestions.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => selectUser(u)}
                    className="w-full text-right px-3 py-2 hover:bg-accent flex items-center justify-between gap-2"
                  >
                    <div className="flex flex-col items-start min-w-0">
                      <span className="text-sm font-medium truncate max-w-[200px]">{u.name ?? "—"}</span>
                      <span className="text-[11px] text-muted-foreground" dir="ltr">{u.username || u.email || ""}</span>
                    </div>
                    <Badge variant="outline" className="text-[10px] shrink-0">{roleLabel(u.role)}</Badge>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {noMatch && <div className="px-3 py-2 text-sm text-muted-foreground">لا توجد حسابات غير مرتبطة مطابقة.</div>}
        </div>
      )}
    </div>
  );
}
