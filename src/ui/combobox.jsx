import { useState } from 'react';
import { cn } from './cn.js';
import { Input } from './input.jsx';

// A text box with a filtered suggestion list. Free text stays valid: the list
// only suggests. `options` are { value, label, group? }; `onSelect` gets the
// chosen option. Selection fires on mousedown so it lands before the blur that
// closes the list.
export function Combobox({ id, value, onChange, onSelect, options, placeholder, className, selectedValue }) {
  const [open, setOpen] = useState(false);
  const q = (value || '').toLowerCase();
  const shown = options.filter((o) => o.label.toLowerCase().includes(q));
  const groups = [...new Set(shown.map((o) => o.group || ''))];
  const listId = `${id}-list`;
  return (
    <div className={cn('relative', className)}>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={open && shown.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && shown.length > 0 && (
        <div
          id={listId}
          role="listbox"
          className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-md border border-border bg-bg-1 p-1"
        >
          {groups.map((g) => (
            <div key={g}>
              {g && <div className="px-3 pt-2 pb-1 text-xs font-semibold text-text-dim">{g}</div>}
              {shown.filter((o) => (o.group || '') === g).map((o) => (
                <div
                  key={o.value}
                  role="option"
                  aria-selected={selectedValue === o.value}
                  className="flex min-h-11 cursor-pointer items-center rounded-md px-3 text-sm hover:bg-bg-2 aria-selected:text-accent"
                  onMouseDown={() => { onSelect(o); setOpen(false); }}
                >
                  {o.label}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
