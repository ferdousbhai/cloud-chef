export function DetailsToggle({
  expanded,
  controls,
  onToggle,
  disabled,
}: {
  expanded: boolean;
  controls: string;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={controls}
      className="self-start text-xs text-content-secondary underline underline-offset-4 hover:text-content-primary"
      onClick={onToggle}
      disabled={disabled}
    >
      {expanded ? 'Hide details' : 'Show details'}
    </button>
  );
}
