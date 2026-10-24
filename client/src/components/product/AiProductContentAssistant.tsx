import { AiContentSession } from "./ai-content/AiContentSession";
import type { ProductContentAssistantProps } from "./ai-content/useProductContentDraft";
export function AiProductContentAssistant(props: ProductContentAssistantProps) {
  return <AiContentSession key={props.productId ?? "new"} {...props} />;
}
