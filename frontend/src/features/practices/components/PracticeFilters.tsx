import { Workflow } from "../pratiche.types";

export type PracticeFiltersProps = {
  isAdmin: boolean;
  practiceView: "active" | "ready" | "closed";
  workflow: Workflow | null;
  assignees: string[];
  search: string;
  onSearchChange: (value: string) => void;
  statusFilter: string;
  onStatusFilterChange: (value: string) => void;
  assignedFilter: string;
  onAssignedFilterChange: (value: string) => void;
  priorityFilter: string;
  onPriorityFilterChange: (value: string) => void;
  showExtraFilters: boolean;
  onToggleExtraFilters: () => void;
  callOutcomeFilter: string;
  onCallOutcomeFilterChange: (value: string) => void;
  documentFilter: boolean;
  onDocumentFilterChange: (value: boolean) => void;
  paymentFilter: boolean;
  onPaymentFilterChange: (value: boolean) => void;
};

export function PracticeFilters({
  isAdmin,
  practiceView,
  workflow,
  assignees,
  search,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  assignedFilter,
  onAssignedFilterChange,
  priorityFilter,
  onPriorityFilterChange,
  showExtraFilters,
  onToggleExtraFilters,
  callOutcomeFilter,
  onCallOutcomeFilterChange,
  documentFilter,
  onDocumentFilterChange,
  paymentFilter,
  onPaymentFilterChange
}: PracticeFiltersProps) {
  return (
    <>
      <div className={`pr-filters ${isAdmin ? "" : "pr-filters-compact"}`}>
        <label className="pr-search-field">
          <span className="pr-search-icon" aria-hidden="true">
            <svg viewBox="0 0 16 16">
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5 14 14" />
            </svg>
          </span>
          <input value={search} onChange={(e) => onSearchChange(e.target.value)} placeholder="Cerca nelle pratiche..." />
        </label>
        <select value={statusFilter} onChange={(e) => onStatusFilterChange(e.target.value)}>
          <option value="">Tutti gli stati</option>
          {workflow?.statuses.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
        {isAdmin ? (
          <select value={assignedFilter} onChange={(e) => onAssignedFilterChange(e.target.value)}>
            <option value="">Tutti gli assegnati</option>
            {assignees.map((assignee) => (
              <option key={assignee} value={assignee}>
                {assignee}
              </option>
            ))}
          </select>
        ) : null}
        <select value={priorityFilter} onChange={(e) => onPriorityFilterChange(e.target.value)}>
          <option value="">Tutte le priorita</option>
          <option value="alta">Alta</option>
          <option value="media">Media</option>
          <option value="bassa">Bassa</option>
          {practiceView === "active" ? (
            <>
              <option value="overdue">In ritardo</option>
              <option value="today">Da fare oggi</option>
              <option value="callbacks">Da richiamare</option>
            </>
          ) : null}
        </select>
        <button
          type="button"
          className={`pr-filter-toggle ${showExtraFilters ? "active" : ""}`}
          onClick={onToggleExtraFilters}
        >
          <span className="pr-filter-toggle-icon" aria-hidden="true">
            <svg viewBox="0 0 16 16">
              <path d="M2 4h12M4.5 8h7M6.5 12h3" />
            </svg>
          </span>
          Extra filtri
        </button>
      </div>

      {showExtraFilters ? (
        <div className={`pr-filters pr-filters-extra ${practiceView === "active" ? "" : "pr-filters-extra-compact"}`}>
          <select value={callOutcomeFilter} onChange={(e) => onCallOutcomeFilterChange(e.target.value)}>
            <option value="">Tutti gli esiti chiamata</option>
            <option value="completed">Completata</option>
            <option value="no_answer">Nessuna risposta</option>
            <option value="busy">Occupato</option>
            <option value="call_back">Da richiamare</option>
            <option value="interested">Interessato</option>
            <option value="not_interested">Non interessato</option>
          </select>
          {practiceView === "active" ? (
            <>
              <label className="pr-check">
                <input type="checkbox" checked={documentFilter} onChange={(e) => onDocumentFilterChange(e.target.checked)} />
                Documenti mancanti
              </label>
              <label className="pr-check">
                <input type="checkbox" checked={paymentFilter} onChange={(e) => onPaymentFilterChange(e.target.checked)} />
                Pagamenti in scadenza
              </label>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
