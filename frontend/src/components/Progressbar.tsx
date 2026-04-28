interface ProgressBarProps {
  percentage: number;
  label?: string;
}

export default function ProgressBar({ percentage, label }: ProgressBarProps) {
  const clamped = Math.min(100, Math.max(0, percentage));

  return (
    <div style={{ display: "grid", gap: "0.5rem" }}>
      {label && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: "0.88rem",
            color: "var(--text-muted)",
          }}
        >
          <span>{label}</span>
          <span style={{ fontWeight: 600, color: "var(--text-main)" }}>{clamped}%</span>
        </div>
      )}

      {/* Track */}
      <div
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{
          width: "100%",
          height: "0.6rem",
          background: "rgba(19,38,61,0.1)",
          borderRadius: "999px",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${clamped}%`,
            background: "linear-gradient(90deg, var(--accent-strong), var(--wallet-accent))",
            borderRadius: "999px",
            transition: "width 500ms ease",
          }}
        />
      </div>
    </div>
  );
}