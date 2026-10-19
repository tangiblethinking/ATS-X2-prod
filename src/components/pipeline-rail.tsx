import { Check, CircleAlert, LoaderCircle } from "lucide-react";
import { PIPELINE_STEPS, type StepId, type StepStatus } from "@/lib/pipeline-types";
import { cn } from "@/lib/utils";
import { Progress } from "@/components/ui/progress";

type Props = {
  statuses: Record<StepId, StepStatus>;
  details: Partial<Record<StepId, string>>;
  running: boolean;
};

export function PipelineRail({ statuses, details, running }: Props) {
  const doneCount = PIPELINE_STEPS.filter((s) => statuses[s.id] === "done").length;
  const progress = (doneCount / PIPELINE_STEPS.length) * 100;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">Pipeline</p>
        <p className="font-mono text-xs tabular-nums text-muted-foreground">
          {doneCount}/{PIPELINE_STEPS.length}
        </p>
      </div>
      <Progress value={progress} />
      <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-1">
        {PIPELINE_STEPS.map((step, index) => {
          const status = statuses[step.id];
          return (
            <li
              key={step.id}
              className={cn(
                "flex gap-2.5 rounded-lg px-2 py-1.5 transition-colors duration-150",
                status === "running" && "bg-accent",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium tabular-nums",
                  status === "done" && "bg-success/25 text-foreground",
                  status === "running" && "bg-primary text-primary-foreground",
                  status === "error" && "bg-destructive/20 text-destructive",
                  status === "idle" && "bg-secondary text-muted-foreground",
                )}
                aria-hidden
              >
                {status === "done" ? (
                  <Check className="size-3.5" />
                ) : status === "running" ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : status === "error" ? (
                  <CircleAlert className="size-3.5" />
                ) : (
                  index + 1
                )}
              </span>
              <div className="min-w-0">
                <p
                  className={cn(
                    "text-sm font-medium leading-snug",
                    status === "idle" && "text-muted-foreground",
                    status === "running" && "shimmer-text",
                  )}
                >
                  {step.title}
                </p>
                <p className="text-xs text-muted-foreground line-clamp-3 sm:truncate">
                  {details[step.id] || step.blurb}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
      {running ? (
        <p className="text-xs text-muted-foreground">
          Each step waits for the previous one. Do not close this tab.
        </p>
      ) : null}
    </div>
  );
}
