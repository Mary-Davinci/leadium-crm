import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { buildPracticeUrl } from "../features/practices/practice-links";
import type { Lead } from "../features/practices/pratiche.types";
import { getTaskBoardCache, isTaskBoardCacheFresh, setTaskBoardCache } from "../store/crm-store";

const key = (value?: string | null) => String(value || "").trim().toLocaleLowerCase("it");

/**
 * Reuses the same /api/tasks/board endpoint (and shared cache) the Dashboard already calls --
 * fetched lazily on first focus rather than on every route change, so the header doesn't add a
 * network request to pages that never touch search.
 */
export function GlobalSearch() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [leads, setLeads] = useState<Lead[]>(() => getTaskBoardCache()?.data.leads || []);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function ensureData() {
    if (isTaskBoardCacheFresh() && getTaskBoardCache()?.data) return;
    setLoading(true);
    try {
      const data = await api<{ leads: Lead[]; tasks: any[] }>("/api/tasks/board");
      const nextLeads = Array.isArray(data.leads) ? data.leads : [];
      setTaskBoardCache(Array.isArray(data.tasks) ? data.tasks : [], nextLeads);
      setLeads(nextLeads);
    } catch {
      // Search stays best-effort: if the fetch fails, whatever was already cached (possibly
      // nothing) is still searchable, and the empty state below explains why there's nothing.
    } finally {
      setLoading(false);
    }
  }

  const results = useMemo(() => {
    const q = key(query);
    if (!q) return [];
    return leads
      .filter((lead) => key(lead.fullName).includes(q) || key(lead.phone).includes(q))
      .slice(0, 6);
  }, [leads, query]);

  function goToLead(lead: Lead) {
    navigate(buildPracticeUrl(lead.id));
    setQuery("");
    setOpen(false);
  }

  function handleSubmit(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (results[0]) goToLead(results[0]);
  }

  return (
    <div className="gsearch" ref={containerRef}>
      <form className="gsearch-field" onSubmit={handleSubmit} role="search">
        <Search className="gsearch-icon" size={15} aria-hidden="true" />
        <input
          type="search"
          value={query}
          onFocus={() => {
            setOpen(true);
            void ensureData();
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          placeholder="Cerca cliente o pratica..."
          aria-label="Ricerca globale"
        />
      </form>
      {open && query ? (
        <div className="gsearch-results" role="listbox" aria-label="Risultati ricerca">
          {loading && !leads.length ? <p className="gsearch-empty">Caricamento...</p> : null}
          {!loading && !results.length ? (
            <p className="gsearch-empty">{leads.length ? "Nessun risultato." : "Apri una pagina come Pratiche per popolare la ricerca."}</p>
          ) : null}
          {results.map((lead) => (
            <button type="button" className="gsearch-result" key={lead.id} onClick={() => goToLead(lead)}>
              <strong>{lead.fullName}</strong>
              <span>{lead.phone}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
