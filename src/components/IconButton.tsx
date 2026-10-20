import type { LucideIcon } from "lucide-react";

interface Props {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  disabled?: boolean;
  badge?: string;
  onClick?(): void;
}

export default function IconButton({ icon: Icon, label, active, disabled, badge, onClick }: Props) {
  return (
    <button
      className={`icon-btn${active ? " active" : ""}`}
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      data-tip={label}
    >
      <Icon size={18} strokeWidth={1.75} />
      {badge && <span className="badge">{badge}</span>}
    </button>
  );
}
