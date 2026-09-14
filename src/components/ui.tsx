import type { SessionStatus } from "../types";
import { statusDotClass } from "../lib/statusTone";
import { choiceOptionClass, QUIET_BUTTON_CLASS, textButtonClass } from "../lib/ui";

export function StatusDot({
  status,
  title,
}: {
  status: SessionStatus;
  title?: string;
}) {
  return <span title={title} className={statusDotClass(status)} />;
}

export function QuietButton({
  label,
  title,
  onClick,
  disabled,
}: {
  label: string;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={QUIET_BUTTON_CLASS}
    >
      {label}
    </button>
  );
}

export function TextButton({
  label,
  title,
  onClick,
  disabled,
  primary,
}: {
  label: string;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={textButtonClass(primary)}
    >
      {label}
    </button>
  );
}

export function Choice<T extends string>({
  label,
  hint,
  options,
  value,
  onChoose,
}: {
  label: string;
  hint: string;
  options: readonly T[];
  value: T;
  onChoose: (option: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[12px] font-medium text-ink">{label}</h3>
        <span className="text-[10px] text-ink-faint">{hint}</span>
      </div>
      <div className="flex flex-wrap items-center gap-0.5 self-start rounded-md border border-line p-0.5">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onChoose(option)}
            className={choiceOptionClass(option === value)}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}
