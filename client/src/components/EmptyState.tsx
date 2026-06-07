// حالة فارغة بنّاءة — بديل عن «لا بيانات» العدائية (§٢.٥).
// تعرض أيقونة + عنوان + وصف + زرّ إجراء اختياري («أضف أوّل…»).
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Link } from "wouter";
import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";

type EmptyStateProps = {
  icon?: LucideIcon;
  title: string;
  description?: string;
  /** زرّ إجراء — إمّا رابط (href) أو نقرة (onClick). */
  actionLabel?: string;
  actionHref?: string;
  onAction?: () => void;
};

export function EmptyState({ icon: Icon = Inbox, title, description, actionLabel, actionHref, onAction }: EmptyStateProps) {
  const action = actionLabel ? (
    actionHref ? (
      <Link href={actionHref}><Button>{actionLabel}</Button></Link>
    ) : (
      <Button onClick={onAction}>{actionLabel}</Button>
    )
  ) : null;

  return (
    <Empty className="py-12">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon className="size-6" aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}
