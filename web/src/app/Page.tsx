import { useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { IconButton, Kbd, Icon } from '../ui';
import { useApi } from '../lib/query';
import { openPalette } from './palette-store';

/** Every screen renders inside a Page: toolbar (title + actions) and a scrolling content area. */
export function Page({ title, actions, children, width = 'wide', subtitle }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; width?: 'narrow' | 'wide' | 'full' }) {
  const [scrolled, setScrolled] = useState(false);
  const [, navigate] = useLocation();
  const pending = useApi<any[]>('/api/changesets?status=pending', { staleTime: 10_000 });
  const n = pending.data?.length ?? 0;
  const update = useApi<{ available: boolean; phase: string }>('/api/update/status', { staleTime: 60_000 });
  return (
    <div className="main">
      <div className={`toolbar ${scrolled ? 'scrolled' : ''}`}>
        <h1>{title}</h1>
        {subtitle && <span className="muted small">{subtitle}</span>}
        <div className="actions">
          {actions}
          {update.data?.available && (
            <button className="btn" onClick={() => navigate('/settings/update')} title="A new version of Margin is ready">
              <Icon name="ArrowDownToLine" size={14} /> Update
            </button>
          )}
          {n > 0 && (
            <button className="btn" onClick={() => navigate('/changes')} title="Changes waiting for your review">
              <span className="pill-count">{n}</span> To review
            </button>
          )}
          <button className="btn plain" onClick={openPalette} aria-label="Command palette" title="Command palette">
            <Kbd>⌘K</Kbd>
          </button>
          <IconButton icon="LifeBuoy" label="Get help" onClick={() => navigate('/help')} />
        </div>
      </div>
      <div className="content" onScroll={(e) => setScrolled((e.target as HTMLElement).scrollTop > 2)}>
        <div className={width === 'narrow' ? 'content-narrow' : width === 'wide' ? 'content-wide' : ''}>{children}</div>
      </div>
    </div>
  );
}
