// إجراءات الصف الموحّدة (تعديل/حذف/نسخ/عرض/طباعة) — قائمة ⋯ أو أزرار سطرية.
// التأكيد على الإجراءات الخطِرة يُستدعى في onSelect عبر await confirm() (المكوّن نفسه «غبيّ»).
//   <RowActions actions={[
//     { key: "edit", label: "تعديل", icon: Pencil, href: `/customers/${id}/edit` },
//     { key: "del", label: "تعطيل", icon: Ban, variant: "destructive", onSelect: () => toggle(id) },
//   ]} />
import * as React from "react";
import { MessageCircle, MoreHorizontal } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { trpc } from "@/lib/trpc";
import { canSeeGate, type RoleGate } from "@/lib/navVisibility";
import type { PermissionMap } from "@shared/permissions";
import { openWhatsApp, preferredWhatsAppPhone } from "@/lib/whatsapp";

export type RowActionKind =
  | "view"
  | "create"
  | "edit"
  | "print"
  | "export"
  | "duplicate"
  | "pay"
  | "contact"
  | "approve"
  | "correct"
  | "convert"
  | "transfer"
  | "reverse"
  | "cancel"
  | "delete"
  | "other";

export type RowContactAction = {
  phone?: string | null;
  whatsapp?: string | null;
  alternativePhones?: Array<string | null | undefined>;
  message: string;
  label?: string;
  hidden?: boolean;
  disabledReason?: string;
  gate?: RoleGate;
};

export type RowAction = {
  key: string;
  /** الدلالة التشغيلية؛ تُستعمل في الجرد والحوكمة ولا تعتمد على صياغة العنوان. */
  kind?: RowActionKind;
  label: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  /** إجراء فوري (للحذف الخطِر: await confirm() داخله ثم mutate). */
  onSelect?: () => void;
  /** تنقّل (wouter) بدل onSelect. */
  href?: string;
  variant?: "default" | "destructive";
  disabled?: boolean;
  /** سبب عدم الإتاحة المؤقتة (حالة السجل/تنفيذ جارٍ)، ويظهر كتلميح. */
  disabledReason?: string;
  hidden?: boolean;
  /**
   * مرآة بوابة الخادم لهذا الإجراء. الواجهة تخفي غير المصرّح به لمنع الارتباك،
   * لكن الإنفاذ الأمني يبقى إلزامياً في procedure الخادم.
   */
  gate?: RoleGate;
};

export type RowActionsProps = {
  actions: RowAction[];
  /** إجراء واتساب موحّد يُضاف إلى القائمة ويظل ظاهراً مع سبب واضح عند غياب الرقم. */
  contact?: RowContactAction;
  /** menu = قائمة ⋯ · inline = أزرار · auto = قائمة إن كانت الإجراءات الظاهرة > ٢. */
  mode?: "menu" | "inline" | "auto";
  label?: string;
  align?: "start" | "end";
};

export function RowActions({
  actions,
  contact,
  mode = "auto",
  label = "إجراءات",
  align = "end",
}: RowActionsProps) {
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role;
  const override = (me.data?.permissionsOverride ?? null) as PermissionMap | null;
  const contactPhone = contact
    ? preferredWhatsAppPhone(contact.whatsapp, contact.phone, ...(contact.alternativePhones ?? []))
    : null;
  const allActions: RowAction[] = contact
    ? [
        ...actions,
        {
          key: "contact-whatsapp",
          kind: "contact",
          label: contact.label ?? "تواصل عبر واتساب",
          icon: MessageCircle,
          hidden: contact.hidden,
          disabled: !contactPhone,
          disabledReason:
            contact.disabledReason ?? "لا يوجد رقم واتساب صالح — أضف الرقم إلى بيانات الطرف أولاً",
          gate: contact.gate,
          onSelect: () => {
            if (contactPhone) openWhatsApp(contactPhone, contact.message);
          },
        },
      ]
    : actions;
  const visible = allActions.filter(
    (a) => !a.hidden && (!a.gate || (!me.isLoading && canSeeGate(a.gate, role, override))),
  );
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
          if (a.href && !a.disabled) {
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
              title={a.disabled ? a.disabledReason : undefined}
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
          if (a.href && !a.disabled) {
            return (
              <DropdownMenuItem key={a.key} asChild variant={a.variant}>
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
              title={a.disabled ? a.disabledReason : undefined}
            >
              {inner}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
