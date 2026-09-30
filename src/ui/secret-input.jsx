import { useState } from 'react';
import { Button } from './button.jsx';
import { Input } from './input.jsx';

// A credential box: masked, with a reveal toggle. The value stays in the
// caller's state (localStorage); this only decides how it is drawn.
export function SecretInput({ id, value, onChange, placeholder, ...props }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="flex gap-2">
      <Input
        id={id}
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        {...props}
      />
      <Button variant="outline" aria-pressed={shown} aria-label={shown ? 'Hide key' : 'Show key'} onClick={() => setShown((v) => !v)}>
        {shown ? 'Hide' : 'Show'}
      </Button>
    </div>
  );
}
