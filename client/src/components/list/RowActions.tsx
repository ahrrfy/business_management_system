// إجراءات الصف الموحّدة (تعديل/حذف/نسخ/عرض/طباعة) — قائمة ⋯ أو أزرار سطرية.
// التأكيد على الإجراءات الخطِرة يُستدعى في onSelect عبر await confirm() (المكوّن نفسه «غبيّ»).
//   <RowActions actions={[
//     { key: "edit", label: "تعديل", icon: Pencil, href: `/customers/${id}/edit` },
//     { key: "del", label: "تعطيل", icon: Ban, variant: "destructive", onSelect: () => toggle(id) },
//   ]} />
import * as React from "react";
import { MoreHorizontal } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type RowAction = {
  key: string;
  label: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  /** إجراء فوري (للحذف الخطِر: await confirm() داخله ثم mutate). */
  onSelect?: () => void;
  /** تنقّل (wouter) بدل onSelect. */
  href?: string;
  variant?: "default" | "destructive";
  disabled?: boolean;
  hidden?: boolean;
};

export type RowActionsProps = {
  actions: RowAction[];
  /** menu = قائمة ⋯ · inline = أزرار · auto = قائمة إن كانت الإجراءات الظاهرة > ٢. */
  mode?: "menu" | "inline" | "auto";
  label?: string;
  align?: "start" | "end";
};

export function RowActions({
  actions,
  mode = "auto",
  label = "إجراءات",
  align = "end",
}: RowActionsProps) {
  const visible = actions.filter((a) => !a.hidden);
  if (visible.length === 0) return null;
  const useMenu = mode === "menu" || (mode === "auto" && visible.length > 2);

  if (!useMenu) {
    return (
      <div className="flex justify-center gap-1">
        {visible.map((a) => {
          const Icon = a.icon;
          const inner = (
            <>
              {Icon && <Icon className="size-4" />}
              {a.label}
            </>
          );
          if (a.href) {
            return (
              <Button key={a.key} asChild variant="outline" size="sm">
                <Link href={a.href}>{inner}</Link>
              </Button>
            );
          }
          return (
            <Button
              key={a.key}
              variant={a.variant === "destructive" ? "ghost" : "outline"}
              size="sm"
              disabled={a.disabled}
              onClick={a.onSelect}
              className={
                a.variant === "destructive"
                  ? "text-destructive hover:text-destructive"
                  : undefined
              }
            >
              {inner}
            </Button>
          );
        })}
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align}>
        {visible.map((a) => {
          const Icon = a.icon;
          const inner = (
            <>
              {Icon && <Icon className="size-4" />}
              {a.label}
            </>
          );
          if (a.href) {
            return (
              <DropdownMenuItem key={a.key} asChild variant={a.variant} disabled={a.disabled}>
                <Link href={a.href}>{inner}</Link>
              </DropdownMenuItem>
            );
          }
          return (
            <DropdownMenuItem
              key={a.key}
              variant={a.variant}
              disabled={a.disabled}
              onSelect={() => a.onSelect?.()}
            >
              {inner}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
