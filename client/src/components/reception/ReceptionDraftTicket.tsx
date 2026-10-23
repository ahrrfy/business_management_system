import { notify } from "@/lib/notify";
import { fmtDate } from "@/lib/date";
import { trpc } from "@/lib/trpc";
import { printDraftTicket } from "@/lib/printing/draftTicket";
import { lineTotal } from "@/components/reception/cartMath";
export interface ReceptionDraftTicketInput {
  utils: ReturnType<typeof trpc.useUtils>;
}
export async function ReceptionDraftTicket(
  { utils }: ReceptionDraftTicketInput,
  draftId: number,
) {
  try {
    const d = await utils.reception.draftGet.fetch(
      { draftId },
      { staleTime: 0 },
    );
    await printDraftTicket({
      draftNumber: d.draftNumber,
      date: fmtDate(new Date(d.createdAt as unknown as string)),
      contactName: d.contactName,
      contactPhone: d.contactPhone,
      items: d.lines.map((l) => ({
        name: l.title ?? "بند",
        quantity: Number(l.quantity),
        total: String(l.lineTotal),
      })),
      total: String(d.total),
      notes: d.notes,
    });
  } catch (e) {
    notify.err(e, "تعذّرت طباعة تذكرة المسوّدة");
  }
}
