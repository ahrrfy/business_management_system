/**
 * **مسارُ الطلب في سطرٍ واحد** (قرار المالك ١/٩/٢٦: «مسير الطلب سلس ومفهوم وبسيط ونظاميّ»).
 *
 * كانت الشاشةُ تعرض **حالةً** واحدة (`RECEIVED`/`IN_PROGRESS`/…) وشريطَ أزرارٍ يظهر ويختفي،
 * فلا يعرف الموظّفُ أين هو من الطريق ولا ما الذي يمنعه. وأسوأُ ذلك اعتمادُ التصميم: زرُّ
 * «بدء التنفيذ» يُعطَّل بعبارة «بانتظار اعتماد التصميم» بلا أن يقول **من** يعتمد ولا **أين**.
 *
 * هنا الطريقُ كلُّه مرئيّ: ما تمّ، وأين نحن، وما بقي — والخطوةُ المتعثّرة تحمل سببَها نصّاً.
 * مكوّنُ عرضٍ محض: لا استعلام ولا طفرة، والقرارُ يبقى للشاشة.
 */
import { Check, CircleDashed, Loader2, Lock } from "lucide-react";

export type FlowStepState = "DONE" | "CURRENT" | "BLOCKED" | "PENDING";

export interface WorkOrderFlowStep {
  key: string;
  label: string;
  state: FlowStepState;
  /** يظهر تحت الخطوة الحالية/المتعثّرة فقط — لا نُغرق السطر بشروحٍ لخطواتٍ انتهت. */
  hint?: string | null;
}

const STATE_DOT: Record<FlowStepState, string> = {
  DONE: "border-[var(--sem-pos)] bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]",
  CURRENT: "border-primary bg-primary text-primary-foreground",
  BLOCKED: "border-[var(--sem-warn)] bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]",
  PENDING: "border-border bg-muted text-muted-foreground",
};

const STATE_LABEL: Record<FlowStepState, string> = {
  DONE: "منجزة",
  CURRENT: "الخطوة الحالية",
  BLOCKED: "متوقّفة",
  PENDING: "لاحقة",
};

function StepIcon({ state }: { state: FlowStepState }) {
  if (state === "DONE") return <Check aria-hidden className="size-3.5" />;
  if (state === "CURRENT") return <Loader2 aria-hidden className="size-3.5" />;
  if (state === "BLOCKED") return <Lock aria-hidden className="size-3.5" />;
  return <CircleDashed aria-hidden className="size-3.5" />;
}

export function WorkOrderFlowStepper({ steps }: { steps: readonly WorkOrderFlowStep[] }) {
  const active = steps.find((step) => step.state === "BLOCKED" || step.state === "CURRENT") ?? null;
  return (
    <div className="rounded-lg border p-3">
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-2">
        {steps.map((step, index) => (
          <li key={step.key} className="flex items-center gap-1">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-2xs font-bold ${STATE_DOT[step.state]}`}
              title={STATE_LABEL[step.state]}
            >
              <StepIcon state={step.state} />
              {step.label}
              <span className="sr-only"> — {STATE_LABEL[step.state]}</span>
            </span>
            {index < steps.length - 1 && (
              <span aria-hidden className="h-px w-3 bg-border sm:w-5" />
            )}
          </li>
        ))}
      </ol>
      {active?.hint && (
        <p
          className={`mt-2 text-2xs font-bold ${
            active.state === "BLOCKED" ? "text-[var(--sem-warn)]" : "text-muted-foreground"
          }`}
        >
          {active.hint}
        </p>
      )}
    </div>
  );
}
