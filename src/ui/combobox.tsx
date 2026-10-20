/**
 * Smart Editable + Suggested ComboBox Controls (`<SmartComboBox />` & `<SmartMultiComboBox />`).
 *
 * Replaces rigid `<select>` or unguided `<input>` controls on product names, product descriptions,
 * dependent riders/products, actuarial age basis selectors, medical conditions, pursuits, occupations
 * and beneficiary relationships. Operators can ALWAYS type any custom free-text value OR filter/pick
 * AI-ranked domain suggestions with category pills and descriptions.
 *
 * Architectural note: Never put `aria-expanded` on non-section widgets because `<Section>` owns
 * section-rail disclosure semantics (`data-combo-open` tracks suggestion popover visibility).
 */
import React, { useMemo, useRef, useState } from 'react';
import type { ComboSuggestionItem } from '../core/autopick';

export interface SmartComboBoxProps {
  value: string;
  onChange: (next: string) => void;
  suggestions: ReadonlyArray<ComboSuggestionItem>;
  placeholder?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
  id?: string;
  name?: string;
  allowCustomNote?: string;
}

export const SmartComboBox: React.FC<SmartComboBoxProps> = ({
  value,
  onChange,
  suggestions,
  placeholder,
  disabled,
  style,
  id,
  name,
  allowCustomNote = 'Editable + AI suggested — pick an option or type any custom text',
}) => {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return suggestions.slice(0, 12);
    const exactMatch = suggestions.some((s) => s.value.toLowerCase() === q);
    if (exactMatch) return suggestions.slice(0, 12);
    return suggestions
      .filter(
        (s) =>
          s.value.toLowerCase().includes(q) ||
          s.label.toLowerCase().includes(q) ||
          (s.category ?? '').toLowerCase().includes(q) ||
          (s.description ?? '').toLowerCase().includes(q),
      )
      .slice(0, 12);
  }, [suggestions, value]);

  const selectItem = (item: ComboSuggestionItem) => {
    onChange(item.value);
    setOpen(false);
  };

  return (
    <span className="smartCombo" data-combo-open={open ? 'true' : 'false'} style={style}>
      <span className="smartComboField">
        <input
          id={id}
          name={name}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          title={allowCustomNote}
          autoComplete="off"
          onFocus={() => {
            if (closeTimer.current) clearTimeout(closeTimer.current);
            setHighlight(0);
            setOpen(true);
          }}
          onBlur={() => {
            closeTimer.current = setTimeout(() => setOpen(false), 150);
          }}
          onChange={(e) => {
            onChange(e.target.value);
            setHighlight(0);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
              setHighlight((h) => (filtered.length > 0 ? (h + 1) % filtered.length : 0));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setOpen(true);
              setHighlight((h) => (filtered.length > 0 ? (h - 1 + filtered.length) % filtered.length : 0));
            } else if (e.key === 'Enter' && open && filtered[highlight]) {
              e.preventDefault();
              selectItem(filtered[highlight]!);
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
        />
        <button
          type="button"
          className="smartComboTrigger"
          disabled={disabled}
          tabIndex={-1}
          title="Toggle suggested values (or type any custom value directly)"
          onMouseDown={(e) => {
            e.preventDefault();
            setOpen((prev) => !prev);
          }}
        >
          ▾
        </button>
      </span>
      {open && !disabled && (
        <div className="smartComboMenu" role="listbox">
          <div className="smartComboHint">{allowCustomNote}</div>
          {filtered.length === 0 ? (
            <div className="smartComboEmpty">
              Using custom value: <b>{value}</b>
            </div>
          ) : (
            filtered.map((item, idx) => (
              <div
                key={`${item.value}-${idx}`}
                role="option"
                aria-selected={item.value === value}
                className={`smartComboItem${idx === highlight ? ' active' : ''}`}
                onMouseEnter={() => setHighlight(idx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectItem(item);
                }}
              >
                <div className="smartComboRow">
                  <b>{item.label}</b>
                  <span className="smartComboBadges">
                    {item.category && <span className="pill">{item.category}</span>}
                    {item.badge && <span className="pill ok">{item.badge}</span>}
                  </span>
                </div>
                {item.description && <div className="smartComboDesc">{item.description}</div>}
              </div>
            ))
          )}
        </div>
      )}
    </span>
  );
};

export interface SmartMultiComboBoxProps {
  values: string[];
  onChange: (next: string[]) => void;
  suggestions: ReadonlyArray<ComboSuggestionItem>;
  placeholder?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
}

export const SmartMultiComboBox: React.FC<SmartMultiComboBoxProps> = ({
  values,
  onChange,
  suggestions,
  placeholder = 'Pick suggested items or type custom code + Enter…',
  disabled,
  style,
}) => {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const available = useMemo(() => {
    const q = query.trim().toLowerCase();
    return suggestions
      .filter(
        (s) =>
          !values.includes(s.value) &&
          (!q ||
            s.value.toLowerCase().includes(q) ||
            s.label.toLowerCase().includes(q) ||
            (s.description ?? '').toLowerCase().includes(q)),
      )
      .slice(0, 10);
  }, [suggestions, values, query]);

  const addValue = (raw: string) => {
    const clean = raw.trim();
    if (!clean) return;
    if (!values.includes(clean)) {
      onChange([...values, clean]);
    }
    setQuery('');
  };

  const removeValue = (target: string) => {
    onChange(values.filter((v) => v !== target));
  };

  return (
    <div className="smartMultiCombo" data-combo-open={open ? 'true' : 'false'} style={style}>
      {values.length > 0 && (
        <div className="smartMultiChips">
          {values.map((v) => (
            <span key={v} className="pill info smartMultiChip">
              <span>{v}</span>
              {!disabled && (
                <button
                  type="button"
                  className="smartChipRemove"
                  title={`Remove ${v}`}
                  onClick={() => removeValue(v)}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      <span className="smartComboField">
        <input
          value={query}
          disabled={disabled}
          placeholder={placeholder}
          autoComplete="off"
          onFocus={() => {
            if (closeTimer.current) clearTimeout(closeTimer.current);
            setOpen(true);
          }}
          onBlur={() => {
            closeTimer.current = setTimeout(() => setOpen(false), 150);
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              if (available[0] && query.trim() && available[0].value.toLowerCase().startsWith(query.trim().toLowerCase())) {
                addValue(available[0].value);
              } else {
                addValue(query);
              }
            } else if (e.key === 'Backspace' && !query && values.length > 0) {
              removeValue(values[values.length - 1]!);
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
        />
        <button
          type="button"
          className="smartComboTrigger"
          disabled={disabled}
          tabIndex={-1}
          title="Show suggested dependent products / options"
          onMouseDown={(e) => {
            e.preventDefault();
            setOpen((prev) => !prev);
          }}
        >
          ▾
        </button>
      </span>
      {open && !disabled && (
        <div className="smartComboMenu" role="listbox">
          <div className="smartComboHint">Click a suggested cover/code or type any custom code + Enter</div>
          {available.map((item, idx) => (
            <div
              key={`${item.value}-${idx}`}
              role="option"
              aria-selected={false}
              className="smartComboItem"
              onMouseDown={(e) => {
                e.preventDefault();
                addValue(item.value);
              }}
            >
              <div className="smartComboRow">
                <b>{item.label}</b>
                <span className="smartComboBadges">
                  {item.category && <span className="pill">{item.category}</span>}
                  {item.badge && <span className="pill ok">{item.badge}</span>}
                </span>
              </div>
              {item.description && <div className="smartComboDesc">{item.description}</div>}
            </div>
          ))}
          {query.trim() && !values.includes(query.trim()) && (
            <div
              className="smartComboItem active"
              onMouseDown={(e) => {
                e.preventDefault();
                addValue(query);
              }}
            >
              <div className="smartComboRow">
                <b>+ Add custom entry &ldquo;{query.trim()}&rdquo;</b>
                <span className="pill warn">Custom</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
