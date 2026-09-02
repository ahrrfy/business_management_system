import { ShieldCheck } from "lucide-react";

export function GovernanceRequestNotice({
  children,
}: {
  children?: React.ReactNode;
}) {
  return (
    <div
      role="note"
      className="flex items-start gap-2 rounded-md border bg-muted/25 p-3 text-sm"
    >
      <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
      <p>
        {children ??
          "إنشاء الطلب صفري الأثر. لا يتحرّك مخزون أو رصيد مورد أو نقد، ولا تُرحّل مصاريف، إلا بعد اعتماد مستخدم مستقل وإعادة فحص نسخة المستند داخل المعاملة."}
      </p>
    </div>
  );
}
