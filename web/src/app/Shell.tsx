import { useEffect, useMemo } from 'react';
import { Link, Route, Switch, useLocation, Redirect } from 'wouter';
import { Icon, Button } from '../ui';
import { useModules, useDay, useHotkey, isTyping } from '../lib/hooks';
import { webModules } from '../lib/webModule';
import { useAction, useApi } from '../lib/query';
import { fmtTime } from '../lib/format';
import { Palette } from './Palette';
import { CaptureSheet } from './CaptureSheet';
import { Page } from './Page';
import { openPalette, openCapture } from './palette-store';
import { ChangeSetsPage, ChangeSetPage } from './ChangeSets';
import { SettingsPage } from './Settings';
import { WidgetSlot } from './WidgetSlot';
import { CapturePanel } from './CapturePanel';

export function Shell() {
  const modules = useModules();
  const day = useDay();
  const [loc, navigate] = useLocation();
  const mode = day.data?.mode ?? 'day';
  const workAllowed = day.data?.workAllowed ?? true;
  const onboarded = useOnboarded();

  useEffect(() => {
    document.documentElement.dataset.mode = mode === 'evening' && !day.data?.unlockedUntil ? 'evening' : mode;
  }, [mode, day.data?.unlockedUntil]);

  useHotkey('Mod+k', () => openPalette());
  useHotkey('Mod+n', () => openCapture());
  useHotkey('Mod+,', () => navigate('/settings'));
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (isTyping(e) || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 9) {
        const entry = navMain[n - 1];
        if (entry) { e.preventDefault(); navigate(entry.path); }
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });
  // Electron menu → route
  useEffect(() => {
    const w = window as any;
    w.margin?.onNavigate?.((path: string) => navigate(path));
    w.margin?.onCapture?.(() => openCapture());
  }, [navigate]);

  const enabled = (modules.data ?? []).filter((m) => m.enabled);
  const nav = enabled.flatMap((m) => m.nav).sort((a, b) => a.order - b.order);
  const navMain = nav.filter((n) => n.section === 'main');
  const navSecondary = nav.filter((n) => n.section === 'secondary');
  const workPaths = useMemo(() => new Set(nav.filter((n) => n.work).map((n) => n.path)), [nav]);
  const enabledIds = new Set(enabled.map((m) => m.id));
  const routes = webModules.filter((w) => enabledIds.has(w.id)).flatMap((w) => w.routes ?? []);
  const sidebars = webModules.filter((w) => enabledIds.has(w.id) && w.sidebar);

  if (loc === '/capture-panel') return <CapturePanel />;
  if (!modules.data || !day.data) return <div className="app no-sidebar"><div className="main" /></div>;
  if (onboarded === false && !loc.startsWith('/onboarding') && enabledIds.has('onboarding')) return <Redirect to="/onboarding" />;

  const evening = mode === 'evening' && !workAllowed;
  const locked = !workAllowed;
  const isWork = (path: string) => workPaths.has(path) || routes.some((r) => r.work && matchPath(r.path, path));
  const fullscreen = loc.startsWith('/onboarding');

  return (
    <div className={`app ${evening || fullscreen ? 'no-sidebar' : ''}`}>
      {!evening && !fullscreen ? (
        <aside className="sidebar" aria-label="Sidebar">
          <nav>
            {navMain.map((n) => <NavItem key={n.id} n={n} locked={locked && !!n.work} current={loc === n.path || (n.path !== '/' && loc.startsWith(n.path + '/'))} />)}
            {sidebars.map((w) => { const S = w.sidebar!; return <S key={w.id} locked={locked} />; })}
            <div style={{ flex: 1 }} />
            {navSecondary.map((n) => <NavItem key={n.id} n={n} locked={locked && !!n.work} current={loc.startsWith(n.path)} />)}
          </nav>
        </aside>
      ) : <div />}
      {evening && !loc.startsWith('/help') && !loc.startsWith('/settings') && !loc.startsWith('/shutdown') ? (
        <EveningView />
      ) : locked && isWork(loc) ? (
        <StopGate mode={mode} />
      ) : (
        <Switch>
          <Route path="/changes" component={ChangeSetsPage} />
          <Route path="/changes/:id">{(p) => <ChangeSetPage id={p.id} />}</Route>
          <Route path="/settings">{() => <SettingsPage />}</Route>
          <Route path="/settings/:module">{(p) => <SettingsPage module={p.module} />}</Route>
          {routes.map((r) => <Route key={r.path} path={r.path} component={r.component} />)}
          <Route path="/"><Redirect to={mode === 'offday' ? '/offday' : '/today'} /></Route>
          <Route><Page title="Not found"><p className="muted">Nothing lives at {loc}.</p></Page></Route>
        </Switch>
      )}
      <Palette nav={nav} />
      <CaptureSheet />
    </div>
  );
}

function NavItem({ n, current, locked }: { n: any; current: boolean; locked: boolean }) {
  return (
    <Link href={n.path} className={`side-item ${locked ? 'locked' : ''}`} aria-current={current ? 'page' : undefined}>
      <Icon name={locked ? 'Moon' : n.icon} size={16} />
      <span>{n.label}</span>
    </Link>
  );
}

function matchPath(pattern: string, path: string) {
  const re = new RegExp('^' + pattern.replace(/:[^/]+/g, '[^/]+') + '$');
  return re.test(path);
}

/** undefined while loading; true when onboarding is finished or the module is off. */
function useOnboarded(): boolean | undefined {
  const modules = useModules();
  const has = modules.data?.some((m) => m.id === 'onboarding' && m.enabled);
  const { data } = useApi<{ completed: boolean }>(has ? '/api/onboarding/state' : null, { staleTime: 60_000 });
  if (!modules.data) return undefined;
  if (!has) return true;
  return data?.completed;
}

/** Evening mode: only capture, leisure, and the lights-out countdown. Work takes a deliberate tap. */
function EveningView() {
  const day = useDay();
  const brk = useAction('post', '/api/day/break-stop');
  const settings = useApi<{ breakStopUnlockMin: number }>('/api/settings/day');
  const [, navigate] = useLocation();
  const done = !!day.data?.shutdownAt;
  return (
    <div className="main evening-main">
      <div className="toolbar"><div className="actions"><Button variant="plain" icon="LifeBuoy" onClick={() => navigate('/help')}>Get help</Button></div></div>
      <div className="content">
        <div className="content-narrow evening-stack">
          <WidgetSlot slot="evening" />
          <div className="evening-foot">
            {!done && <p className="muted small">Shutdown isn’t logged yet. It takes about ten minutes.</p>}
            <button className="btn plain small" onClick={() => brk.mutate({ view: 'evening' } as any)}>
              I’m breaking my stop
            </button>
            <p className="faint tiny">Opens work views for {settings.data?.breakStopUnlockMin ?? 45} minutes and logs it. No judgment, just data.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function StopGate({ mode }: { mode: string }) {
  const day = useDay();
  const brk = useAction('post', '/api/day/break-stop');
  const [loc, navigate] = useLocation();
  const off = mode === 'offday';
  return (
    <Page title={off ? 'Off-day' : 'Evening'} width="narrow">
      <div className="gate">
        <Icon name={off ? 'Sunrise' : 'Moon'} size={28} strokeWidth={1.5} />
        <h2>{off ? 'Today is your day off.' : `Your stop was ${day.data ? fmtTime(day.data.anchors.effectiveStop) : ''}.`}</h2>
        <p className="muted">{off ? 'Work views are hidden until tomorrow.' : 'Work views stay closed until morning.'}</p>
        <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
          <Button onClick={() => navigate(off ? '/offday' : '/')}>{off ? 'Back to Off-day' : 'Back to Evening'}</Button>
          <Button variant="plain" onClick={() => brk.mutate({ view: loc } as any)}>I’m breaking my stop</Button>
        </div>
        <p className="faint tiny" style={{ marginTop: 10 }}>Logged without commentary. It shows up in your weekly review.</p>
      </div>
    </Page>
  );
}
