'use client';

import { useEffect, useRef, useState } from 'react';

export interface SelectOption {
  value: string;
  label: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  /** Show a clear "— none —" choice at the top (for optional fields). */
  allowEmpty?: boolean;
  disabled?: boolean;
}

/**
 * Theme-matched searchable dropdown (combobox). Replaces native <select> so long lists
 * (LED products, display catalog, clients…) can be typed-to-filter. No external deps.
 */
export default function SearchSelect({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  allowEmpty = false,
  disabled = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.value === value);

  // Close on click-away / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    inputRef.current?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const filtered = query
    ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : options;

  const choose = (v: string) => {
    onChange(v);
    setOpen(false);
    setQuery('');
  };

  return (
    <div className="ss" ref={ref}>
      <button
        type="button"
        className="ss-trigger"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={selected ? '' : 'muted'}>{selected ? selected.label : placeholder}</span>
        <span className="ss-caret">▾</span>
      </button>
      {open && (
        <div className="ss-pop">
          <input
            ref={inputRef}
            className="ss-search"
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && filtered[0]) {
                e.preventDefault();
                choose(filtered[0].value);
              }
            }}
          />
          <div className="ss-list">
            {allowEmpty && (
              <div className={`ss-opt${value === '' ? ' sel' : ''}`} onClick={() => choose('')}>
                — none —
              </div>
            )}
            {filtered.length === 0 && <div className="ss-empty">No matches</div>}
            {filtered.map((o) => (
              <div
                key={o.value}
                className={`ss-opt${o.value === value ? ' sel' : ''}`}
                onClick={() => choose(o.value)}
              >
                {o.label}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
