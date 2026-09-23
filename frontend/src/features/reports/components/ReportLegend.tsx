type ReportLegendItem = {
  label: string;
  color: string;
  value?: string;
};

export function ReportLegend({ items }: { items: ReportLegendItem[] }) {
  return (
    <div className="rpt-legend">
      {items.map((item) => (
        <span className="rpt-legend-item" key={item.label}>
          <span className="rpt-legend-dot" style={{ background: item.color }} aria-hidden="true" />
          {item.value ? <strong>{item.value}</strong> : null}
          {item.label}
        </span>
      ))}
    </div>
  );
}
