/**
 * Shared UI kit. Modules build screens from these so the app reads as one piece.
 * Vernacular: macOS System Settings (grouped inset lists), not a card grid.
 */
import { icons, Check as CheckIcon, X } from 'lucide-react';
import { useEffect, useRef, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
export { toast } from './toast';

type Btn = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'plain' | 'danger' | 'default'; size?: 'large'; icon?: string; kbd?: string };
export function Button({ variant = 'default', size, icon, kbd, className = '', children, ...rest }: Btn) {
  const cls = ['btn', variant !== 'default' && variant, size, className].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} {...rest}>
      {icon && <Icon name={icon} size={14} />}
      {children}
      {kbd && <span className="kbd">{kbd}</span>}
    </button>
  );
}

export function IconButton({ icon, label, className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string }) {
  return (
    <button type="button" className={`btn icon ${className}`} aria-label={label} title={label} {...rest}>
      <Icon name={icon} size={16} />
    </button>
  );
}

export function Icon({ name, size = 16, strokeWidth = 1.75, className, style }: { name: string; size?: number; strokeWidth?: number; className?: string; style?: React.CSSProperties }) {
  const C = (icons as Record<string, any>)[name] ?? icons.Circle;
  return <C size={size} strokeWidth={strokeWidth} className={className} style={style} aria-hidden="true" />;
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="toggle" disabled={disabled} onClick={() => onChange(!checked)} />;
}

/** Round completion checkbox (Reminders-style). */
export function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} aria-label={label} className="check" onClick={(e) => { e.stopPropagation(); onChange(!checked); }}>
      <CheckIcon size={11} strokeWidth={3} />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small className="faint tiny">{hint}</small>}
    </label>
  );
}
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={`input ${p.className ?? ''}`} />;
export const Select = ({ children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={`select ${p.className ?? ''}`}>{children}</select>;
export const TextArea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={`textarea ${p.className ?? ''}`} />;

/** A titled block. `why` is the one-line reason + source that every core rule carries. */
export function Section({ title, why, end, footer, children, id }: { title?: ReactNode; why?: ReactNode; end?: ReactNode; footer?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="section" id={id}>
      {(title || end) && (
        <header>
          {title && <h2>{title}</h2>}
          {why && <span className="why">{why}</span>}
          {end && <div className="end">{end}</div>}
        </header>
      )}
      {children}
      {footer && <footer>{footer}</footer>}
    </section>
  );
}
export function Group({ children, pad, className = '' }: { children: ReactNode; pad?: boolean; className?: string }) {
  return <div className={`group ${pad ? 'pad' : ''} ${className}`}>{children}</div>;
}
export function Item({ children, onClick, className = '', ...rest }: { children: ReactNode; onClick?: () => void; className?: string } & Record<string, any>) {
  return (
    <div className={`item ${onClick ? 'clickable' : ''} ${className}`} onClick={onClick} {...rest}>
      {children}
    </div>
  );
}
export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return <div className="empty">{children}{action && <div>{action}</div>}</div>;
}

export function Tag({ children, tone }: { children: ReactNode; tone?: 'accent' | 'amber' | 'green' | 'red' | 'dusk' }) {
  return <span className={`tag ${tone ?? ''}`}>{children}</span>;
}
export const Kbd = ({ children }: { children: ReactNode }) => <span className="kbd">{children}</span>;

export function Banner({ tone, icon, children, why, action, onDismiss }: { tone?: 'amber' | 'green' | 'red' | 'dusk'; icon: string; children: ReactNode; why?: ReactNode; action?: ReactNode; onDismiss?: () => void }) {
  return (
    <div className={`banner ${tone ?? ''}`} role={tone === 'red' ? 'alert' : 'status'}>
      <span className="icon"><Icon name={icon} size={16} /></span>
      <div className="body">
        {children}
        {why && <div className="why">{why}</div>}
      </div>
      {action}
      {onDismiss && <button className="btn icon" aria-label="Dismiss for today" title="Dismiss for today" onClick={onDismiss}><X size={14} /></button>}
    </div>
  );
}

/** Modal sheet: one short task, Escape closes, focus moves in. */
export function Sheet({ open, onClose, title, subtitle, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select, button:not(.btn.icon)');
    first?.focus();
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', h, true);
    return () => { window.removeEventListener('keydown', h, true); prev?.focus?.(); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`sheet ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} ref={ref}>
        <header>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </header>
        <div className="sheet-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

/** Load vs capacity as one quiet bar. Amber only when the plan exceeds the day. */
export function CapacityBar({ loadMin, freeMin, compact }: { loadMin: number; freeMin: number; compact?: boolean }) {
  const over = loadMin > freeMin;
  const pct = freeMin > 0 ? Math.min(100, (loadMin / freeMin) * 100) : loadMin > 0 ? 100 : 0;
  return (
    <div className="capbar" data-over={over} style={{ height: compact ? 4 : 6 }} role="meter" aria-valuemin={0} aria-valuemax={freeMin} aria-valuenow={loadMin} aria-label="Planned load versus free time">
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

/** Why-line with source, used under every core rule. */
export function Why({ children, source }: { children: ReactNode; source?: string }) {
  return <span className="why-line">{children}{source && <span className="faint"> ({source})</span>}</span>;
}
