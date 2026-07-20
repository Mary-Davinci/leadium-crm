import { CircleAlert, Inbox, LoaderCircle } from "lucide-react";
import { Button } from "./button";

type PageStateProps = {
  kind?: "loading" | "error" | "empty";
  title: string;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
  compact?: boolean;
};

export function PageState({
  kind = "empty",
  title,
  detail,
  actionLabel,
  onAction,
  compact = false
}: PageStateProps) {
  const Icon = kind === "loading" ? LoaderCircle : kind === "error" ? CircleAlert : Inbox;

  return (
    <div
      className={`ui-page-state ui-page-state-${kind} ${compact ? "compact" : ""}`}
      role={kind === "error" ? "alert" : "status"}
    >
      <span className="ui-page-state-icon" aria-hidden="true">
        <Icon size={compact ? 17 : 21} className={kind === "loading" ? "ui-spin" : ""} />
      </span>
      <div className="ui-page-state-copy">
        <strong>{title}</strong>
        {detail ? <span>{detail}</span> : null}
      </div>
      {actionLabel && onAction ? (
        <Button size="sm" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}
