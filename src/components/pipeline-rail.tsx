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
  const total = PIPELINE_STEPS.length;
  const doneCount = PIPELINE_STEPS.filter((s) => statuses[s.id] === "done").length;
  const runningStep = PIPELINE_STEPS.find((s) => statuses[s.id] === "running");
  const errorStep = PIPELINE_STEPS.find((s) => statuses[s.id] === "error");
  const isAllDone = doneCount === total;
  const isComplete = isAllDone && !running && !errorStep;
  const progress = (doneCount / total) * 100;

  // Counter always updates to the active step (0 when idle)
  const activeStepNum = isComplete
    ? total
    : runningStep
      ? runningStep.id
      : doneCount;

  // Determine what single item to show under the progress bar
  let displayStep: (typeof PIPELINE_STEPS)[number] | null = null;
  let displayStatus: StepStatus | "complete" = "idle";

  if (isComplete) {
    displayStatus = "complete";
  } else if (runningStep) {
    displayStep = runningStep;
    displayStatus = "running";
  } else if (errorStep) {
    displayStep = errorStep;
    displayStatus = "error";
  } else if (isAllDone) {
    // Brief check on the final step while the last delay runs
    displayStep = PIPELINE_STEPS[total - 1];
    displayStatus = "done";
  } else if (doneCount > 0) {
    // Brief check on the just-finished step
    displayStep = PIPELINE_STEPS.find((s) => s.id === doneCount) ?? null;
    displayStatus = "done";
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">Pipeline</p>
        <p className="font-mono text-xs tabular-nums text-muted-foreground">
          {activeStepNum}/{total}
        </p>
      </div>
      <Progress value={progress} />

      {displayStatus === "complete" ? (
        <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
          <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-success/25 text-foreground">
            <Check className="size-3.5" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium leading-snug">Pipeline complete</p>
            <p className="text-xs text-muted-foreground">Final HTML is ready.</p>
          </div>
        </div>
      ) : displayStep ? (
        <div
          className={cn(
            "flex gap-2.5 rounded-lg px-2 py-1.5 transition-colors duration-150",
            displayStatus === "running" && "bg-accent",
          )}
        >
          <span
            className={cn(
              "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium tabular-nums",
              displayStatus === "done" && "bg-success/25 text-foreground",
              displayStatus === "running" && "bg-primary text-primary-foreground",
              displayStatus === "error" && "bg-destructive/20 text-destructive",
            )}
            aria-hidden
          >
            {displayStatus === "done" ? (
              <Check className="size-3.5" />
            ) : displayStatus === "running" ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : displayStatus === "error" ? (
              <CircleAlert className="size-3.5" />
            ) : (
              displayStep.id
            )}
          </span>
          <div className="min-w-0">
            <p
              className={cn(
                "text-sm font-medium leading-snug",
                displayStatus === "running" && "shimmer-text",
              )}
            >
              {displayStep.title}
            </p>
            <p className="text-xs text-muted-foreground line-clamp-3 sm:truncate">
              {details[displayStep.id] || displayStep.blurb}
            </p>
          </div>
        </div>
      ) : (
        <p className="px-2 text-xs text-muted-foreground">Ready to start the pipeline.</p>
      )}

      {running ? (
        <p className="text-xs text-muted-foreground">
          Each step waits for the previous one. Do not close this tab.
        </p>
      ) : null}
    </div>
  );
}
