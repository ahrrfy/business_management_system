import type { RouterOutputs } from "@/lib/trpc";
export type PartyKind = "customer" | "supplier";
export type Contact360Data = RouterOutputs["contacts"]["contact360"];
export type PersonRow = RouterOutputs["contacts"]["persons"]["list"][number];
export type ContactPanelProps = {
  kind: PartyKind;
  id: number;
  onClose: () => void;
  onOpenContact: (kind: PartyKind, id: number) => void;
};
