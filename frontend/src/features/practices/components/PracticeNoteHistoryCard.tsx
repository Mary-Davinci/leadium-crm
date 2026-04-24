import { NoteEntry } from "../practice-detail.types";

type Props = {
  notes: NoteEntry[];
};

export function PracticeNoteHistoryCard({ notes }: Props) {
  return (
    <section className="pd-card pd-card-history">
      <div className="pd-note-history">
        <h6>Storico note</h6>
        {notes.length ? (
          notes.slice(0, 5).map((note) => (
            <article key={note.id}>
              <strong>{new Date(note.createdAt).toLocaleString("it-IT")}</strong>
              <span>{note.actor}</span>
              <p>{note.text || "(vuota)"}</p>
            </article>
          ))
        ) : (
          <p className="muted">Nessuna nota storica disponibile.</p>
        )}
      </div>
    </section>
  );
}
