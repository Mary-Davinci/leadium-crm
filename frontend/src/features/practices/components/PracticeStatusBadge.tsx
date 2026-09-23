import { getStatusClass, getStatusLabel } from "../pratiche.utils";

export function PracticeStatusBadge({ status }: { status: string }) {
  return <span className={`pr-badge ${getStatusClass(status)}`}>{getStatusLabel(status)}</span>;
}
