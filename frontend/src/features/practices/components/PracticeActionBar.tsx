type Props = {
  busy: boolean;
  statusDraft: string;
  assigneeDraft: string;
  nextStatuses: string[];
  assignees: string[];
  onStartCall: () => void;
  onWrite: () => void;
  onCreateTask: () => void;
  onPickStatus: (value: string) => void;
  onPickAssignee: (value: string) => void;
};

export function PracticeActionBar({
  busy,
  statusDraft,
  assigneeDraft,
  nextStatuses,
  assignees,
  onStartCall,
  onWrite,
  onCreateTask,
  onPickStatus,
  onPickAssignee
}: Props) {
  return (
    <section className="pd-action-bar">
      <button type="button" disabled={busy} onClick={onStartCall}>
        📞 Chiamata
      </button>
      <button type="button" className="secondary" onClick={onWrite}>
        ✉ Scrivi
      </button>
      <button type="button" className="secondary" disabled={busy} onClick={onCreateTask}>
        📨 Crea task
      </button>

      <div className="pd-inline-control pd-dropdown-control">
        <select value={statusDraft} onChange={(event) => onPickStatus(event.target.value)}>
          <option value="">Cambia stato ▼</option>
          {nextStatuses.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </div>

      <div className="pd-inline-control pd-dropdown-control">
        <select value={assigneeDraft} onChange={(event) => onPickAssignee(event.target.value)}>
          <option value="">Assegna ▼</option>
          {assignees.map((assignee) => (
            <option key={assignee} value={assignee}>
              {assignee}
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}
