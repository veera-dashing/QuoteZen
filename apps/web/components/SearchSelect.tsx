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
  /**
   * Optional inline "create new" action, rendered as a pinned row at the foot of the popover.
   * Receives the current search text so the caller can pre-fill the new record's name. Omit to get
   * a plain picker (every existing usage is unchanged).
   */
  onCreate?: (query: string) => void;
  /** Label for the create row when the search box is empty (e.g. "New client"). */
  createLabel?: string;
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
  onCreate,
  createLabel = 'New',
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

  // Hand the typed text to the caller so a "create" form can open pre-filled, then reset the picker.
  const create = () => {
    if (!onCreate) return;
    const typed = query.trim();
    setOpen(false);
    setQuery('');
    onCreate(typed);
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
              if (e.key !== 'Enter') return;
              // Enter takes the top match; with nothing matching, it falls through to "create".
              if (filtered[0]) {
                e.preventDefault();
                choose(filtered[0].value);
              } else if (onCreate) {
                e.preventDefault();
                create();
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
          {/* Pinned outside .ss-list so it stays visible while the options scroll. */}
          {onCreate && (
            <div className="ss-create" onClick={create} title={`Create a new ${createLabel.toLowerCase()}`}>
              {query.trim() ? `+ Create “${query.trim()}”` : `+ ${createLabel}`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
