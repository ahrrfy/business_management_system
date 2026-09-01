import { Bell, CheckCheck, ExternalLink } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fmtDateTime } from "@/lib/date";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

const FAMILY_LABELS = {
  OPERATIONS: "تشغيلية",
  ADMIN: "إدارية",
  EMPLOYEE: "الموظف",
  SYSTEM: "النظام",
  APPROVAL: "اعتماد",
} as const;

type NotificationFamily = keyof typeof FAMILY_LABELS;

export function familyLabel(family: string): string {
  return FAMILY_LABELS[family as NotificationFamily] ?? "إشعار";
}

export function notificationBadgeLabel(count: number): string {
  return count > 99 ? "99+" : String(Math.max(0, count));
}

export function safeNotificationRoute(route: string | null | undefined): string {
  return typeof route === "string" && route.startsWith("/") && !route.startsWith("//")
    ? route
    : "/my-work";
}

/**
 * مركز إشعاراتٍ عالمي خفيف: استعلام واحد صغير يتجدد دورياً، ويظهر في سطح المكتب والهاتف.
 * الإشعار يبقى سجلاً؛ طابور القرارات الحي موجود في `/my-work`.
 */
export function NotificationBell({ enabled }: { enabled: boolean }) {
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();
  const notifications = trpc.superApp.notifications.useQuery(
    { limit: 12 },
    {
      enabled,
      refetchInterval: 20_000,
      refetchOnWindowFocus: true,
      staleTime: 10_000,
    },
  );
  const refresh = () => utils.superApp.notifications.invalidate();
  const markRead = trpc.superApp.markNotificationRead.useMutation({ onSuccess: refresh });
  const markAllRead = trpc.superApp.markAllNotificationsRead.useMutation({ onSuccess: refresh });
  const rows = notifications.data?.rows ?? [];
  const unreadCount = notifications.data?.unreadCount ?? 0;

  async function openNotification(id: number, route: string | null) {
    const row = rows.find((item) => item.id === id);
    if (row && !row.readAt) {
      await markRead.mutateAsync({ id });
    }
    setOpen(false);
    navigate(safeNotificationRoute(route));
  }

  if (!enabled) return null;

  return (
    <Popover open={open} onOpenChange={(next) => {
      setOpen(next);
      if (next) void notifications.refetch();
    }}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={unreadCount > 0 ? `الإشعارات: ${unreadCount} غير مقروء` : "الإشعارات"}
          title="الإشعارات"
        >
          <Bell className="size-5" aria-hidden />
          {unreadCount > 0 && (
            <span className="absolute -end-1 -top-1 inline-flex min-w-5 items-center justify-center rounded-full bg-[var(--sem-danger)] px-1 text-[10px] font-black leading-5 text-background tabular-nums">
              {notificationBadgeLabel(unreadCount)}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} dir="rtl" className="w-[min(24rem,calc(100vw-1rem))] p-0 text-start">
        <div className="flex items-center justify-between border-b px-3 py-2.5">
          <div>
            <p className="text-sm font-extrabold">الإشعارات</p>
            <p className="text-[11px] text-muted-foreground">{unreadCount > 0 ? `${unreadCount} غير مقروء` : "كلها مقروءة"}</p>
          </div>
          {unreadCount > 0 && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 gap-1 text-xs"
              disabled={markAllRead.isPending}
              onClick={() => markAllRead.mutate()}
            >
              <CheckCheck className="size-3.5" aria-hidden />
              قراءة الكل
            </Button>
          )}
        </div>

        <ScrollArea className="h-[min(25rem,60vh)]">
          {notifications.isLoading && rows.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-muted-foreground">جارٍ تحميل الإشعارات…</p>
          ) : notifications.isError ? (
            <div className="px-4 py-7 text-center text-xs text-[var(--sem-danger)]">
              <p>تعذّر تحميل الإشعارات.</p>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => notifications.refetch()}>إعادة المحاولة</Button>
            </div>
          ) : rows.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-muted-foreground">لا توجد إشعارات بعد</p>
          ) : (
            <ul className="divide-y">
              {rows.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => void openNotification(row.id, row.route)}
                    className={cn(
                      "flex w-full items-start gap-3 px-3 py-3 text-start transition-colors hover:bg-muted/60",
                      !row.readAt && "bg-[var(--sem-info-bg)]/45",
                    )}
                  >
                    <span className={cn(
                      "mt-1 size-2 shrink-0 rounded-full",
                      row.readAt ? "bg-muted-foreground/30" : "bg-[var(--sem-info)]",
                    )} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="rounded border px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground">
                          {familyLabel(row.family)}
                        </span>
                        <span className="truncate text-xs font-bold">{row.title}</span>
                      </span>
                      <span className="mt-1 line-clamp-2 block text-[11px] leading-5 text-muted-foreground">{row.body}</span>
                      <span className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                        {fmtDateTime(row.createdAt)}
                        <ExternalLink className="size-3" aria-hidden />
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>

        <Button
          type="button"
          variant="ghost"
          className="h-10 w-full rounded-none border-t text-xs font-bold"
          onClick={() => {
            setOpen(false);
            navigate("/my-work");
          }}
        >
          عرض مركز الإشعارات والقرارات
        </Button>
      </PopoverContent>
    </Popover>
  );
}
