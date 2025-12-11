import * as React from "react";

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function Switch({ checked, onCheckedChange, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={`
        relative inline-flex h-6 w-11 items-center rounded-full
        transition-colors focus-visible:outline-none focus-visible:ring-2
        focus-visible:ring-ring focus-visible:ring-offset-2
        disabled:cursor-not-allowed disabled:opacity-50
        ${checked ? "bg-primary" : "bg-input"}
      `}
    >
      <span
        className={`
          inline-block h-5 w-5 transform rounded-full bg-background
          shadow-lg transition-transform
          ${checked ? "translate-x-5" : "translate-x-0.5"}
        `}
      />
    </button>
  );
}
