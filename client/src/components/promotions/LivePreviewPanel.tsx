import { useState } from "react";
import { CreditCard, MessageSquare, Receipt, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LiveCardPreview } from "./LiveCardPreview";
import { LiveReceiptPreview } from "./LiveReceiptPreview";
import { LiveWhatsAppPreview } from "./LiveWhatsAppPreview";
import type { PromotionFormData } from "./promotionBuilderTypes";

interface LivePreviewPanelProps {
  data: PromotionFormData;
}

type PreviewTab = "card" | "receipt" | "whatsapp";

export function LivePreviewPanel({ data }: LivePreviewPanelProps) {
  const [activeTab, setActiveTab] = useState<PreviewTab>("card");

  return (
    <Card className="h-full border shadow-sm flex flex-col bg-muted/10">
      <CardHeader className="pb-3 border-b space-y-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-bold flex items-center gap-2">
            <span>لوحة المعاينة التفاعلية الحية</span>
            <Badge variant="outline" className="text-[10px] font-normal gap-1 text-primary border-primary/30">
              <RefreshCw className="size-2.5 animate-spin" />
              <span>متزامن لحظياً</span>
            </Badge>
          </CardTitle>
          <span className="text-xs text-muted-foreground font-mono" dir="ltr">
            {data.sampleCode || `${data.codePrefix}-SAMPLE`}
          </span>
        </div>

        {/* أزرار التبديل بين التبويبات الثلاثة */}
        <div className="grid grid-cols-3 gap-1 bg-muted p-1 rounded-lg text-xs">
          <button
            type="button"
            className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md font-medium transition-all ${
              activeTab === "card"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setActiveTab("card")}
          >
            <CreditCard className="size-3.5" />
            <span>بطاقة 54×84</span>
          </button>

          <button
            type="button"
            className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md font-medium transition-all ${
              activeTab === "receipt"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setActiveTab("receipt")}
          >
            <Receipt className="size-3.5" />
            <span>إيصال 80 مم</span>
          </button>

          <button
            type="button"
            className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md font-medium transition-all ${
              activeTab === "whatsapp"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setActiveTab("whatsapp")}
          >
            <MessageSquare className="size-3.5" />
            <span>واتساب</span>
          </button>
        </div>
      </CardHeader>

      <CardContent className="p-4 flex-1 flex flex-col justify-start items-center overflow-y-auto">
        {activeTab === "card" && <LiveCardPreview data={data} />}
        {activeTab === "receipt" && <LiveReceiptPreview data={data} />}
        {activeTab === "whatsapp" && <LiveWhatsAppPreview data={data} />}
      </CardContent>
    </Card>
  );
}
