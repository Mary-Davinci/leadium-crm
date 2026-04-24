type Props = {
  phone: string;
  email?: string;
  source?: string;
  assignedTo?: string;
};

export function PracticeCustomerCard({ phone, email, source, assignedTo }: Props) {
  return (
    <section className="pd-card pd-card-client">
      <h5>Dettagli cliente</h5>
      <div className="pd-contact-list">
        <p>📞 {phone || "-"}</p>
        <p>✉ {email || "-"}</p>
        <p>📍 {source || "-"}</p>
        <p>👤 {assignedTo || "operatore"}</p>
      </div>
    </section>
  );
}
