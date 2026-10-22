export function Stars({ value, size = 15 }: { value: number; size?: number }) {
  const full = Math.round(value);
  return (
    <span aria-label={`${value} out of 5 stars`} style={{ color: "#e0951b", fontSize: size, letterSpacing: 1 }}>
      {"★★★★★".slice(0, full)}
      <span style={{ color: "var(--border)" }}>{"★★★★★".slice(full)}</span>
    </span>
  );
}

export function StarInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <span role="radiogroup" aria-label="Rating" className="row" style={{ gap: 2 }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} star${n > 1 ? "s" : ""}`}
          className="link"
          style={{ fontSize: 26, color: n <= value ? "#e0951b" : "var(--border)" }}
          onClick={() => onChange(n)}
        >
          ★
        </button>
      ))}
    </span>
  );
}
