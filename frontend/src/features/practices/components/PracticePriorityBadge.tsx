import { Priority } from "../pratiche.types";
import { urgencyLabels } from "../pratiche.utils";

export function PracticePriorityBadge({ priority }: { priority: Priority }) {
  return (
    <span className={`pr-priority pr-priority-${priority}`}>
      <span className="pr-priority-dot" aria-hidden="true" />
      {urgencyLabels[priority]}
    </span>
  );
}
