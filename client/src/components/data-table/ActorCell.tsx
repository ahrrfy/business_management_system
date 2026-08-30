import { cn } from "@/lib/utils";
import { UserRound } from "lucide-react";

export type OperationActor = {
  userId?: number | null;
  name?: string | null;
  at?: string | Date | null;
  source?: "user" | "system" | "external" | "device" | "platform" | "legacy";
};

export function actorLabel(actor: OperationActor | null | undefined): string {
  if (!actor) return "غير موثّق";
  if (actor.name?.trim()) return actor.name.trim();
  if (actor.source === "system") return "النظام";
  if (actor.source === "external") return "جهة خارجية";
  if (actor.source === "device") return "جهاز";
  if (actor.source === "platform") return "مدير المنصّة";
  if (actor.userId != null) return `مستخدم #${actor.userId}`;
  return actor.source === "legacy" ? "بيانات قديمة" : "غير موثّق";
}

/** عرض موحّد لمن قام بالعملية؛ لا يخفي السجلات القديمة خلف شرطة مبهمة. */
export function ActorCell({ actor, className }: { actor: OperationActor | null | undefined; className?: string }) {
  const label = actorLabel(actor);
  return (
    <span className={cn("inline-flex max-w-40 items-center gap-1.5 text-start", className)} title={label}>
      <UserRound aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
    </span>
  );
}
