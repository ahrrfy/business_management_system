import { PurchaseApprovalQueue } from "@/components/purchases/PurchaseApprovalQueue";
import { trpc } from "@/lib/trpc";

export default function PurchaseApprovals() {
  const me = trpc.auth.me.useQuery();
  return <PurchaseApprovalQueue currentUserId={me.data?.id} />;
}
