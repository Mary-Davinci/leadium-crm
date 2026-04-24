type Props = {
  noteDraft: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
};

export function PracticeNotesCard({ noteDraft, busy, onChange, onSave }: Props) {
  return (
    <section className="pd-card pd-card-notes">
      <h5>Note pratica</h5>
      <textarea
        className="pd-notes-input"
        value={noteDraft}
        onChange={(event) => onChange(event.target.value)}
        rows={5}
        placeholder="Scrivi qualcosa sui dettagli di questa pratica..."
      />
      <p className="pd-note-meta">Autore: operatore · {new Date().toLocaleString("it-IT")}</p>
      <div className="pd-actions">
        <button type="button" disabled={busy} onClick={onSave}>
          Salva nota
        </button>
      </div>
    </section>
  );
}
