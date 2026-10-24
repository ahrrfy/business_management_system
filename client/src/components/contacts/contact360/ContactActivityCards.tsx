import { Link } from "wouter";
import { MessageSquare, Receipt } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { fmt } from "@/lib/money";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { receptionChannelLabel } from "@shared/receptionChannel";
import { invoiceStatusLabel } from "@shared/invoiceStatus";
import { SectionCard } from "./ContactSection";
import type { Contact360Data } from "./types";
export function InvoicesCard({
  invoices,
}: {
  invoices: Extract<Contact360Data, { kind: "customer" }>["invoices"];
}) {
  return (
    <SectionCard icon={Receipt} title="آخر الفواتير">
      {invoices.length === 0 ? (
        <p className="text-xs text-muted-foreground">لا فواتير.</p>
      ) : (
        <ul className="space-y-1">
          {invoices.map((inv) => (
            <li key={inv.id}>
              <Link
                href={`/invoices/${inv.id}`}
                className="grid min-w-0 grid-cols-2 items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
              >
                <span className="min-w-0 break-all font-mono text-xs" dir="ltr">
                  {inv.invoiceNumber}
                </span>
                <span className="min-w-0 break-words text-xs text-muted-foreground">
                  {fmtDate(inv.invoiceDate)}
                </span>
                <span className="min-w-0 break-all tabular-nums" dir="ltr">
                  {fmt(inv.total)}
                </span>
                <Badge variant="neutral" className="shrink-0">
                  {invoiceStatusLabel(inv.status)}
                </Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/* ═══════════ المحادثات ═══════════ */

export function ConversationsCard({
  conversations,
}: {
  conversations: Contact360Data["conversations"];
}) {
  return (
    <SectionCard icon={MessageSquare} title="المحادثات">
      {conversations.length === 0 ? (
        <p className="text-xs text-muted-foreground">لا محادثات.</p>
      ) : (
        <ul className="space-y-1">
          {conversations.map((c) => (
            <li key={c.id}>
              <Link
                href="/crm?tab=inbox"
                className="grid min-w-0 grid-cols-2 items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
              >
                <span className="shrink-0">
                  {receptionChannelLabel(c.channel)}
                </span>
                <span className="min-w-0 break-words text-xs text-muted-foreground">
                  {c.lastMessagePreview ?? "—"}
                </span>
                <span
                  className="min-w-0 break-words text-xs text-muted-foreground"
                  dir="ltr"
                >
                  {fmtDateTime(c.lastMessageAt)}
                </span>
                {c.unreadCount > 0 && (
                  <Badge variant="destructive" className="shrink-0">
                    {c.unreadCount}
                  </Badge>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
