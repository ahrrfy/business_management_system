import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import {
  AlertTriangle,
  Info,
  Flame,
  CheckCircle2,
  Clock,
  UserCheck,
  Building2,
  Calendar,
} from "lucide-react";
import { fmtDate } from "@/lib/date";

export interface AnnouncementItem {
  id: number;
  title: string;
  body: string;
  priority: "NORMAL" | "IMPORTANT" | "CRITICAL";
  requiresAck: boolean;
  createdAt: string | Date;
  expiresAt?: string | Date | null;
  readAt?: string | Date | null;
  acknowledgedAt?: string | Date | null;
}

interface Props {
  announcement: AnnouncementItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AnnouncementDetailModal({ announcement, open, onOpenChange }: Props) {
  const utils = trpc.useUtils();
  const [isPendingAck, setIsPendingAck] = useState(false);

  const ackMutation = trpc.announcements.acknowledge.useMutation({
    onSuccess: () => {
      notify.ok("تم تسجيل إقرارك الإداري بنجاح");
      setIsPendingAck(false);
      utils.announcements.mine.invalidate();
    },
    onError: (err) => {
      notify.err(err.message || "تعذر تسجيل الإقرار");
      setIsPendingAck(false);
    },
  });

  if (!announcement) return null;

  const handleAcknowledge = () => {
    setIsPendingAck(true);
    ackMutation.mutate({ id: announcement.id });
  };

  const priorityConfig = {
    CRITICAL: {
      label: "عاجل وهام جداً",
      badgeClass: "bg-red-600 text-white hover:bg-red-600",
      icon: Flame,
    },
    IMPORTANT: {
      label: "إعلان إداري هام",
      badgeClass: "bg-amber-600 text-white hover:bg-amber-600",
      icon: AlertTriangle,
    },
    NORMAL: {
      label: "إعلان عام",
      badgeClass: "bg-blue-600 text-white hover:bg-blue-600",
      icon: Info,
    },
  }[announcement.priority] || {
    label: "إعلان",
    badgeClass: "bg-muted text-muted-foreground",
    icon: Info,
  };

  const PriorityIcon = priorityConfig.icon;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dir="rtl" className="max-w-md sm:max-w-lg p-0 overflow-hidden bg-card">
        <DialogHeader className="p-4 sm:p-5 border-b bg-muted/30">
          <div className="flex items-center justify-between gap-2 mb-2">
            <Badge className={priorityConfig.badgeClass}>
              <PriorityIcon className="size-3.5 me-1" aria-hidden />
              {priorityConfig.label}
            </Badge>

            {announcement.requiresAck && (
              <Badge variant="outline" className="border-amber-500/40 text-amber-600 dark:text-amber-400">
                <UserCheck className="size-3 me-1" aria-hidden />
                يتطلب إقراراً رسمياً
              </Badge>
            )}
          </div>

          <DialogTitle className="text-lg sm:text-xl font-bold text-start leading-snug">
            {announcement.title}
          </DialogTitle>

          <div className="flex items-center gap-3 pt-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Calendar className="size-3.5" aria-hidden />
              {fmtDate(announcement.createdAt)}
            </span>
            {announcement.expiresAt && (
              <span className="flex items-center gap-1">
                <Clock className="size-3.5" aria-hidden />
                ينتهي: {fmtDate(announcement.expiresAt)}
              </span>
            )}
          </div>
        </DialogHeader>

        <div className="p-4 sm:p-5 space-y-4 max-h-[60vh] overflow-y-auto text-sm leading-relaxed text-foreground whitespace-pre-wrap">
          {announcement.body}
        </div>

        <DialogFooter className="p-4 border-t bg-muted/20 flex-row items-center justify-between sm:justify-between gap-2">
          <div>
            {announcement.acknowledgedAt ? (
              <span className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-semibold">
                <CheckCircle2 className="size-4" aria-hidden />
                تم إقرارك بتاريخ {fmtDate(announcement.acknowledgedAt)}
              </span>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            {announcement.requiresAck && !announcement.acknowledgedAt && (
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={handleAcknowledge}
                disabled={isPendingAck || ackMutation.isPending}
                className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold"
              >
                <CheckCircle2 className="size-4 me-1" aria-hidden />
                {isPendingAck ? "جارٍ تسجيل الإقرار…" : "تأكيد الاطلاع والإقرار"}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              إغلاق
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
