import { useMemo, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { getAuthUser } from "../lib/auth";
import { api } from "../lib/api";
import "../styles/lead-import-page.css";

const NAME_COLUMN = "lascia qui il tuo nome e cognome per ricevere il preventivo";
const EMAIL_COLUMN = "lascia qui la tua email per ricevere il preventivo";
const PHONE_COLUMN = "phone_number";
const DEFAULT_STATUS = "Da contattare";

type LocalInvalidRow = {
  rowNumber: number;
  fullName: string;
  phone: string;
  email: string;
  reason: string;
};

type LeadImportCandidate = {
  rowNumber: number;
  fullName: string;
  phone: string;
  email: string;
  notes: string;
  metadata?: Record<string, unknown> | null;
};

type LeadImportPreviewRow = {
  rowNumber: number;
  fullName: string;
  phone: string;
  email: string;
  notes: string;
  status: "ready" | "invalid" | "duplicate_file" | "duplicate_existing";
  reason?: string;
  metadata?: Record<string, unknown> | null;
  existingLead?: {
    id: string;
    fullName: string;
    phone: string;
    email: string;
    source: string;
    status: string;
  } | null;
};

type LeadImportPreviewResponse = {
  source: string;
  status: string;
  summary: {
    received: number;
    ready: number;
    invalid: number;
    duplicateFile: number;
    duplicateExisting: number;
  };
  rows: LeadImportPreviewRow[];
};

type LeadImportApplyResponse = LeadImportPreviewResponse & {
  created: Array<{
    id: string;
    fullName: string;
    phone: string;
    email: string;
  }>;
};

function cleanText(value: unknown) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizePhone(phone: string) {
  return String(phone || "").replace(/\D+/g, "");
}

function normalizeEmail(email: string) {
  return cleanText(email).toLowerCase();
}

function buildContactKey(phone: string, email: string) {
  const phoneKey = normalizePhone(phone);
  if (phoneKey) return `phone::${phoneKey}`;
  const emailKey = normalizeEmail(email);
  if (emailKey) return `email::${emailKey}`;
  return "";
}

function buildDefaultSource() {
  return `excel_import_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
}

function normalizeSourceInput(value: string) {
  const base = cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const normalized = base || buildDefaultSource();
  return normalized.startsWith("excel_") ? normalized : `excel_${normalized}`;
}

async function readWorkbookRows(file: File) {
  const XLSX = await import("xlsx");
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];
  const sheet = workbook.Sheets[firstSheetName];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
}

function buildMetadataMap(rows: Record<string, unknown>[]) {
  const map = new Map<string, Record<string, unknown>>();
  rows.forEach((row) => {
    const contactKey = buildContactKey(String(row[PHONE_COLUMN] || ""), String(row[EMAIL_COLUMN] || ""));
    if (!contactKey) return;
    map.set(contactKey, row);
  });
  return map;
}

function buildImportCandidates(
  dbRows: Record<string, unknown>[],
  metadataMap: Map<string, Record<string, unknown>>,
  source: string
) {
  const candidates: LeadImportCandidate[] = [];
  const invalidRows: LocalInvalidRow[] = [];
  const seenContacts = new Map<string, number>();

  dbRows.forEach((row, index) => {
    const rowNumber = index + 2;
    const fullName = cleanText(row[NAME_COLUMN]);
    const phone = cleanText(row[PHONE_COLUMN]);
    const email = normalizeEmail(row[EMAIL_COLUMN]);
    const contactKey = buildContactKey(phone, email);

    if (!fullName || !contactKey) {
      invalidRows.push({
        rowNumber,
        fullName,
        phone,
        email,
        reason: "Nome o contatto mancante."
      });
      return;
    }

    if (seenContacts.has(contactKey)) {
      invalidRows.push({
        rowNumber,
        fullName,
        phone,
        email,
        reason: `Duplicata nel file (riga ${seenContacts.get(contactKey)}).`
      });
      return;
    }
    seenContacts.set(contactKey, rowNumber);

    const metadataRow = metadataMap.get(contactKey) || null;
    const metadata = metadataRow
      ? {
          campaignName: cleanText(metadataRow.campaign_name),
          adName: cleanText(metadataRow.ad_name),
          platform: cleanText(metadataRow.platform),
          createdTime: cleanText(metadataRow.created_time),
          externalId: cleanText(metadataRow.id),
          formName: cleanText(metadataRow.form_name)
        }
      : null;

    const notesParts = [`Import Excel: ${source}`];
    if (metadata?.campaignName) notesParts.push(`Campagna: ${metadata.campaignName}`);
    if (metadata?.adName) notesParts.push(`Annuncio: ${metadata.adName}`);
    if (metadata?.platform) notesParts.push(`Piattaforma: ${metadata.platform}`);
    if (metadata?.createdTime) notesParts.push(`Lead creata il: ${metadata.createdTime}`);
    if (metadata?.externalId) notesParts.push(`Lead esterna ID: ${metadata.externalId}`);
    if (metadata?.formName) notesParts.push(`Form: ${metadata.formName}`);

    candidates.push({
      rowNumber,
      fullName,
      phone,
      email,
      notes: notesParts.join("\n"),
      metadata
    });
  });

  return { candidates, invalidRows };
}

function getStatusLabel(status: LeadImportPreviewRow["status"]) {
  if (status === "ready") return "Pronta";
  if (status === "duplicate_existing") return "Gia presente";
  if (status === "duplicate_file") return "Duplicata file";
  return "Non valida";
}

export function LeadImportPage() {
  const authUser = getAuthUser();
  const navigate = useNavigate();
  const [excelFile, setExcelFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [status] = useState(DEFAULT_STATUS);
  const [parsedCandidates, setParsedCandidates] = useState<LeadImportCandidate[]>([]);
  const [localInvalidRows, setLocalInvalidRows] = useState<LocalInvalidRow[]>([]);
  const [preview, setPreview] = useState<LeadImportPreviewResponse | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [source, setSource] = useState(buildDefaultSource);

  const canView = authUser?.role === "admin" || authUser?.role === "super_admin";

  const previewRows = useMemo(() => preview?.rows.slice(0, 30) || [], [preview]);

  function handleFileSelected(file: File | null) {
    if (!file) return;
    setExcelFile(file);
    setPreview(null);
    setParsedCandidates([]);
    setLocalInvalidRows([]);
    setError("");
    setSuccess("");
  }

  async function handlePreview() {
    if (!excelFile) {
      setError("Carica il file Excel prima di generare l'anteprima.");
      return;
    }

    setLoadingPreview(true);
    setApplying(false);
    setError("");
    setSuccess("");

    try {
      const effectiveSource = normalizeSourceInput(excelFile.name.replace(/\.[^.]+$/, ""));
      const rows = await readWorkbookRows(excelFile);
      const metadataMap = buildMetadataMap(rows);
      const local = buildImportCandidates(rows, metadataMap, effectiveSource);

      setParsedCandidates(local.candidates);
      setLocalInvalidRows(local.invalidRows);

      const response = await api<LeadImportPreviewResponse>("/api/lead-import/preview", {
        method: "POST",
        body: JSON.stringify({
          source: effectiveSource,
          status,
          leads: local.candidates
        })
      });

      setSource(response.source);
      setPreview(response);
    } catch (previewError) {
      setPreview(null);
      setParsedCandidates([]);
      setLocalInvalidRows([]);
      setError(previewError instanceof Error ? previewError.message : "Errore generazione anteprima.");
    } finally {
      setLoadingPreview(false);
    }
  }

  async function handleApply() {
    if (!preview || !parsedCandidates.length) {
      setError("Genera prima un'anteprima valida.");
      return;
    }
    if (!preview.summary.ready) {
      setError("Non ci sono lead pronte da importare.");
      return;
    }

    setApplying(true);
    setError("");
    setSuccess("");

    try {
      const response = await api<LeadImportApplyResponse>("/api/lead-import/apply", {
        method: "POST",
        body: JSON.stringify({
          source: preview.source,
          status: preview.status,
          leads: parsedCandidates
        })
      });

      setPreview(response);
      setSuccess(`${response.created.length} lead importate con successo nel batch ${response.source}.`);
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : "Errore import lead.");
    } finally {
      setApplying(false);
    }
  }

  if (!canView) return <Navigate to="/dashboard" replace />;

  return (
    <div className="lead-import-page">
      <div className="lead-import-page-head">
        <h1>Carica lead da Excel</h1>
        <button type="button" className="lead-import-secondary" onClick={() => navigate("/tasks")}>
          Torna a Gestione operativa
        </button>
      </div>

      {error ? <div className="lead-import-alert error">{error}</div> : null}
      {success ? <div className="lead-import-alert success">{success}</div> : null}

      <section className="lead-import-panel lead-import-upload-panel">
        <div className="lead-import-panel-head simple">
          <strong>Caricamento file</strong>
        </div>

        <div className="lead-import-form-grid">
          <div className="lead-import-field">
            <span>File Excel</span>
            <label
              className={`lead-import-filepick ${dragActive ? "drag-active" : ""}`}
              onDragEnter={(event) => {
                event.preventDefault();
                setDragActive(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
                setDragActive(true);
              }}
              onDragLeave={(event) => {
                event.preventDefault();
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                setDragActive(false);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setDragActive(false);
                handleFileSelected(event.dataTransfer.files?.[0] || null);
              }}
            >
              <input
                type="file"
                accept=".xls,.xlsx"
                onChange={(event) => handleFileSelected(event.target.files?.[0] || null)}
              />
              <span className="lead-import-filepick-trigger">Scegli file</span>
              <strong>{excelFile ? excelFile.name : "Nessun file selezionato"}</strong>
            </label>
          </div>
        </div>

        <div className="lead-import-actions">
          <button type="button" className="lead-import-primary" onClick={() => handlePreview()} disabled={loadingPreview}>
            {loadingPreview ? "Analisi in corso..." : "Genera anteprima"}
          </button>
        </div>
      </section>

      {(preview || localInvalidRows.length) ? (
        <section className="lead-import-panel lead-import-preview-panel">
          <div className="lead-import-panel-head simple">
            <strong>Anteprima import</strong>
          </div>

          <div className="lead-import-preview-summary">
            <span className="lead-import-summary-chip ready">{preview?.summary.ready || 0} pronte</span>
            <span className="lead-import-summary-chip warning">
              {(preview?.summary.duplicateExisting || 0) + (preview?.summary.duplicateFile || 0)} duplicate
            </span>
            <span className="lead-import-summary-chip danger">
              {(preview?.summary.invalid || 0) + localInvalidRows.length} errori
            </span>
            <span className="lead-import-summary-chip neutral">{preview?.summary.received || parsedCandidates.length} righe</span>
          </div>

          <div className="lead-import-preview-table">
            <div className="lead-import-preview-head" aria-hidden="true">
              <span>Esito</span>
              <span>Lead</span>
              <span>Contatti</span>
              <span>Dettaglio</span>
            </div>

            <div className="lead-import-preview-body compact">
              {previewRows.map((row) => (
                <article key={`${row.rowNumber}-${row.email}-${row.phone}`} className={`lead-import-preview-row ${row.status}`}>
                  <div className="lead-import-preview-cell">
                    <span className={`lead-import-badge ${row.status}`}>{getStatusLabel(row.status)}</span>
                  </div>

                  <div className="lead-import-preview-cell lead">
                    <strong>{row.fullName || "Lead senza nome"}</strong>
                    <small>Riga {row.rowNumber}</small>
                  </div>

                  <div className="lead-import-preview-cell contacts">
                    <strong>{row.phone || "Telefono mancante"}</strong>
                    <small>{row.email || "Email non disponibile"}</small>
                  </div>

                  <div className="lead-import-preview-cell detail">
                    <span>{row.reason || row.notes.split("\n")[0] || "Pronta per import."}</span>
                  </div>
                </article>
              ))}

              {!previewRows.length && localInvalidRows.length ? (
                localInvalidRows.slice(0, 12).map((row) => (
                  <article key={`invalid-${row.rowNumber}-${row.email}-${row.phone}`} className="lead-import-preview-row invalid">
                    <div className="lead-import-preview-cell">
                      <span className="lead-import-badge invalid">Non valida</span>
                    </div>
                    <div className="lead-import-preview-cell lead">
                      <strong>{row.fullName || "Lead senza nome"}</strong>
                      <small>Riga {row.rowNumber}</small>
                    </div>
                    <div className="lead-import-preview-cell contacts">
                      <strong>{row.phone || "Telefono mancante"}</strong>
                      <small>{row.email || "Email non disponibile"}</small>
                    </div>
                    <div className="lead-import-preview-cell detail">
                      <span>{row.reason}</span>
                    </div>
                  </article>
                ))
              ) : null}
            </div>
          </div>

          {preview && preview.rows.length > 30 ? (
            <p className="lead-import-footnote">Anteprima limitata alle prime 30 righe.</p>
          ) : null}

          <div className="lead-import-actions">
            <button
              type="button"
              className="lead-import-primary"
              onClick={() => handleApply()}
              disabled={!preview?.summary.ready || applying || loadingPreview}
            >
              {applying ? "Import in corso..." : "Importa lead"}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
