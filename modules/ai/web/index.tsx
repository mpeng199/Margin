import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import Markdown from 'react-markdown';
import { DateTime } from 'luxon';
import { defineWebModule } from '@web/lib/module';
import { Page } from '@web/app/Page';
import { useApi, useAction, queryClient } from '@web/lib/query';
import { api } from '@web/lib/api';
import { Section, Group, Item, Button, Input, TextArea, Segmented, Toggle, Tag, Banner, Empty, Spinner, Icon, toast } from '@web/ui';
import './ai.css';

type Provider = 'off' | 'plan' | 'api';
interface Settings { provider: Provider; planningModel: string; fastModel: string; monthlyBudgetUsd: number; shareWellbeing: boolean }
interface Status { provider: Provider; enabled: boolean; hasKey: boolean; shareWellbeing: boolean; budget: { monthlyUsd: number; spentUsd: number; remainingUsd: number } }
interface PlanInfo {
  cli: { found: boolean; path: string | null; version: string | null; source: string | null; hint: string | null };
  login: { loggedIn: boolean; method: string | null; plan: string | null; detail: string } | null;
}
interface UsageRow { feature: string; provider: 'plan' | 'api'; calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number }
interface Usage { month: string; byFeature: UsageRow[]; api: { calls: number; costUsd: number }; plan: { calls: number }; budget: { monthlyUsd: number; spentUsd: number } }
interface RunOut { text: string; changeSetId?: string; toolCalls: { name: string; kind: 'read' | 'propose'; ok: boolean; note?: string }[]; careShown?: boolean; stopped?: string }
interface Msg { role: 'user' | 'assistant'; content: string; run?: RunOut }

const PROVIDERS: { value: Provider; label: string }[] = [{ value: 'off', label: 'Off' }, { value: 'plan', label: 'Claude plan' }, { value: 'api', label: 'API key' }];
const EXPLAIN: Record<Provider, string> = {
  off: 'Claude is off. Nothing is sent to Claude, and the rest of Margin works the same.',
  plan: 'Uses the Claude Code app that is signed in on this Mac, with your Claude plan. Requests count against your plan’s usage limits, the same ones as claude.ai and Claude Code, and there is no separate bill. At the limit, Claude pauses until it resets. The monthly budget below does not apply.',
  api: 'Uses an API key from the Anthropic Console. Requests are billed to that account per use, separately from any Claude plan. Margin keeps a monthly budget (below) and refuses a request that would pass it. Dollar amounts here are estimates, not a bill.',
};
const FEATURE: Record<string, string> = {
  ask: 'Ask', plan_day: 'Plan my day', weekly_summary: 'Weekly summary', shutdown_actions: 'Shutdown next actions',
  parse_capture: 'Quick capture', draft_message: 'Draft a message', test: 'Connection tests',
};
const usd = (n: number) => (n < 0.005 ? 'under $0.01' : `$${n.toFixed(2)}`);
const tokens = (r: UsageRow) => (r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens).toLocaleString('en-US');

// ---------------------------------------------------------------- settings
function PlanLogin() {
  const [info, setInfo] = useState<PlanInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    try { setInfo((await api.get<{ plan: PlanInfo }>('/api/ai/status?plan=1')).plan); } catch (e: any) { toast(e.message); } finally { setBusy(false); }
  };
  useEffect(() => { void check(); }, []);
  const cli = info?.cli, login = info?.login;
  return (
    <>
      <Item>
        <div className="title">
          <div>Claude Code</div>
          <div className="sub">{!info ? 'Checking…' : cli!.found ? `Version ${cli!.version ?? 'unknown'}${cli!.source ? ` · ${cli!.source}` : ''}` : 'Not found on this Mac'}</div>
        </div>
        {busy ? <Spinner /> : info && <Tag tone={cli!.found ? 'green' : 'amber'}>{cli!.found ? 'Found' : 'Not installed'}</Tag>}
        <Button variant="plain" disabled={busy} onClick={check}>Check Again</Button>
      </Item>
      {info && !cli!.found && (
        <Item style={{ alignItems: 'flex-start' }}>
          <div className="ai-prose">
            <p><strong>Plan login runs through Claude Code, and it isn’t installed here.</strong> Install it in Terminal with <span className="ai-code">npm install -g @anthropic-ai/claude-code</span>, sign in with <span className="ai-code">claude auth login</span>, then choose Check Again.</p>
            {cli!.hint && <p className="faint">{cli!.hint}</p>}
          </div>
        </Item>
      )}
      {cli?.found && (
        <Item>
          <div className="title">
            <div>Sign-in</div>
            <div className="sub">{login ? login.detail : 'Couldn’t read the sign-in state.'}</div>
          </div>
          {login && <Tag tone={login.loggedIn && login.method === 'claude.ai' ? 'green' : 'amber'}>{login.loggedIn ? (login.method === 'claude.ai' ? `Plan login${login.plan ? ` · ${login.plan}` : ''}` : 'Not a plan login') : 'Not signed in'}</Tag>}
        </Item>
      )}
      {cli?.found && cli.hint && <Item><span className="faint small">{cli.hint}</span></Item>}
    </>
  );
}

function ApiKey({ hasKey }: { hasKey: boolean }) {
  const [key, setKey] = useState('');
  const save = useAction<{ key: string | null }>('post', '/api/ai/key', (o: any) => { setKey(''); toast(o.hasKey ? 'Key saved in Keychain' : 'Key removed'); });
  return (
    <>
      <Item>
        <div className="title">
          <div>API key</div>
          <div className="sub">{hasKey ? 'Saved in Keychain. Margin can’t show it again; paste a new one to replace it.' : 'Create a key in the Anthropic Console under API keys, then paste it here. It goes straight to the macOS Keychain.'}</div>
        </div>
        {hasKey ? <><Tag tone="green">Saved in Keychain</Tag><Button variant="plain" disabled={save.isPending} onClick={() => save.mutate({ key: null })}>Remove</Button></> : <Tag tone="amber">No key yet</Tag>}
      </Item>
      <Item>
        <form className="ai-keyrow" onSubmit={(e) => { e.preventDefault(); if (key.trim()) save.mutate({ key: key.trim() }); }}>
          <Input type="password" autoComplete="off" spellCheck={false} aria-label="API key" placeholder={hasKey ? 'Paste a new key to replace it' : 'sk-ant-…'} value={key} onChange={(e) => setKey(e.target.value)} />
          <Button variant="primary" onClick={() => key.trim() && save.mutate({ key: key.trim() })} disabled={!key.trim() || save.isPending}>Save Key</Button>
        </form>
      </Item>
    </>
  );
}

function TestConnection() {
  const [res, setRes] = useState<{ ok: boolean; message: string; ms: number } | null>(null);
  const test = useAction<void, { ok: boolean; message: string; ms: number }>('post', '/api/ai/test', setRes);
  return (
    <Item>
      <div className="title">
        <div>Test connection</div>
        <div className="sub">{res ? `${res.message}${res.ms ? ` (${(res.ms / 1000).toFixed(1)} s)` : ''}` : 'Sends one tiny request to check that sign-in or the key works. It uses a few tokens.'}</div>
      </div>
      {res && <Tag tone={res.ok ? 'green' : 'amber'}>{res.ok ? 'Connected' : 'Didn’t connect'}</Tag>}
      <Button disabled={test.isPending} onClick={() => { setRes(null); test.mutate(undefined); }}>{test.isPending ? 'Testing…' : 'Test Connection'}</Button>
    </Item>
  );
}

function Models({ s, status }: { s: Settings; status?: Status }) {
  const models = useApi<string[]>('/api/ai/models', { staleTime: 600_000 });
  const patch = useAction<Partial<Settings>>('patch', '/api/settings/ai', () => toast('Saved'));
  const [planning, setPlanning] = useState(s.planningModel);
  const [fast, setFast] = useState(s.fastModel);
  const [budget, setBudget] = useState(String(s.monthlyBudgetUsd));
  useEffect(() => { setPlanning(s.planningModel); setFast(s.fastModel); setBudget(String(s.monthlyBudgetUsd)); }, [s.planningModel, s.fastModel, s.monthlyBudgetUsd]);
  const b = Number(budget);
  const valid = planning.trim() !== '' && fast.trim() !== '' && Number.isFinite(b) && b >= 1 && b <= 500;
  const dirty = planning !== s.planningModel || fast !== s.fastModel || b !== s.monthlyBudgetUsd;
  const unknown = (m: string) => !!models.data && !models.data.includes(m) && ' Margin has no price for this model, so its cost is estimated like Sonnet 5.5.';
  return (
    <Section title="Models and budget" end={<><Button disabled={!dirty} onClick={() => { setPlanning(s.planningModel); setFast(s.fastModel); setBudget(String(s.monthlyBudgetUsd)); }}>Revert</Button>
      <Button variant="primary" disabled={!dirty || !valid || patch.isPending} onClick={() => patch.mutate({ planningModel: planning.trim(), fastModel: fast.trim(), monthlyBudgetUsd: b })}>Save</Button></>}>
      <Group>
        <Item>
          <div className="title"><div>Planning model</div><div className="sub">Plans your day, writes the weekly review, and answers Ask.{unknown(planning)}</div></div>
          <Input className="ai-model" list="ai-models" aria-label="Planning model" spellCheck={false} value={planning} onChange={(e) => setPlanning(e.target.value)} />
        </Item>
        <Item>
          <div className="title"><div>Fast model</div><div className="sub">Parses capture text, drafts shutdown next actions, and short messages.{unknown(fast)}</div></div>
          <Input className="ai-model" list="ai-models" aria-label="Fast model" spellCheck={false} value={fast} onChange={(e) => setFast(e.target.value)} />
        </Item>
        <Item>
          <div className="title">
            <div>Monthly budget</div>
            <div className="sub">API key only. Margin refuses a request once this month’s estimated spend would pass it. Plan login follows your plan’s limits instead.{status && s.provider === 'api' ? ` Used so far: ${usd(status.budget.spentUsd)}.` : ''}</div>
          </div>
          <span className="muted">$</span>
          <Input className="ai-num num" type="number" min={1} max={500} step={1} aria-label="Monthly budget in dollars" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </Item>
      </Group>
      <datalist id="ai-models">{(models.data ?? []).map((m) => <option key={m} value={m} />)}</datalist>
    </Section>
  );
}

function Privacy({ s }: { s: Settings }) {
  const tools = useApi<{ module: string; name: string; kind: 'read' | 'propose' }[]>('/api/ai/tools');
  const patch = useAction<Partial<Settings>>('patch', '/api/settings/ai');
  const t = tools.data ?? [];
  return (
    <Section title="Privacy" why="Sleep and mood are the most personal data in Margin, so they stay out unless you choose otherwise.">
      <Group>
        <Item>
          <div className="title"><div>Share check-in, sleep and mood with Claude</div><div className="sub">Off by default. A change applies to the next request.</div></div>
          <Toggle checked={s.shareWellbeing} label="Share check-in, sleep and mood with Claude" onChange={(v) => patch.mutate({ shareWellbeing: v })} />
        </Item>
        <Item style={{ alignItems: 'flex-start' }}>
          <div className="ai-prose">
            <p><strong>What Claude sees when it is on.</strong> A short summary with each request (today’s date, your projects and phases), anything you type in Ask, and whatever it reads through the tools below: tasks (names, projects, due dates, labels, estimates, must-do dates), calendar events, each day’s capacity and hard stop, habit and focus totals.</p>
            {s.shareWellbeing
              ? <p><strong>Also sent, because sharing is on:</strong> sleep hours, bedtime and wake time, morning energy and mood, and the weekly review scores (energy, dread, effective). Claude may mention them in plans and summaries.</p>
              : <p><strong>Withheld:</strong> sleep hours, bedtime and wake time, morning energy, mood, dread and cynicism ratings, and the weekly review scores. Margin removes any field with those names from everything Claude sees, and doesn’t offer the check-in tools.</p>}
            <p><strong>Never sent:</strong> your API key or any sign-in token; they stay in the Keychain. Everything Claude does see goes to Anthropic, through the provider you chose above.</p>
            <p>If what you type in Ask mentions self-harm or hopelessness, Margin opens Get help first and shows a short care message.</p>
          </div>
        </Item>
        {t.length > 0 && (
          <Item>
            <details>
              <summary>Tools Claude can use ({t.filter((x) => x.kind === 'read').length} read, {t.filter((x) => x.kind === 'propose').length} propose)</summary>
              <div className="ai-toolnames">{t.map((x) => <Tag key={x.name} tone={x.kind === 'propose' ? 'accent' : undefined}>{x.name}</Tag>)}</div>
              <p className="faint tiny" style={{ marginTop: 8 }}>Read tools return data. Propose tools only queue a change for your review; nothing is applied until you apply it.</p>
            </details>
          </Item>
        )}
      </Group>
    </Section>
  );
}

function UsageThisMonth() {
  const u = useApi<Usage>('/api/ai/usage');
  const d = u.data;
  if (!d) return null;
  const month = DateTime.fromFormat(d.month, 'yyyy-MM').toFormat('LLLL yyyy');
  return (
    <Section title={`Usage in ${month}`} why="Estimated from token counts. Not a bill.">
      <Group>
        {d.byFeature.length === 0 && <Item><span className="muted">Nothing used yet this month.</span></Item>}
        {d.byFeature.map((r) => (
          <Item key={`${r.feature}-${r.provider}`}>
            <div className="title"><div>{FEATURE[r.feature] ?? r.feature}</div><div className="sub num">{r.calls} {r.calls === 1 ? 'request' : 'requests'} · {tokens(r)} tokens</div></div>
            <Tag tone={r.provider === 'api' ? undefined : 'accent'}>{r.provider === 'api' ? 'API key' : 'Plan'}</Tag>
            <span className="meta num" style={{ minWidth: 76, textAlign: 'right' }}>{r.provider === 'api' ? usd(r.costUsd) : 'Plan limits'}</span>
          </Item>
        ))}
        {d.api.calls > 0 && <Item><span className="small muted num">API key: about {usd(d.budget.spentUsd)} of your {usd(d.budget.monthlyUsd)} budget.</span></Item>}
        {d.plan.calls > 0 && <Item><span className="small muted">Plan login: {d.plan.calls} {d.plan.calls === 1 ? 'request' : 'requests'}. These count against your Claude plan’s limits. Margin can’t see how much of the limit is left.</span></Item>}
      </Group>
    </Section>
  );
}

function AiPanel() {
  const settings = useApi<Settings>('/api/settings/ai');
  const status = useApi<Status>('/api/ai/status');
  const patch = useAction<Partial<Settings>>('patch', '/api/settings/ai');
  const s = settings.data;
  if (!s) return null;
  return (
    <div className="ai-panel">
      <Section title="Claude" why="Optional. Anything Claude suggests waits for your review; nothing is applied on its own.">
        <Group>
          <Item>
            <div className="title">Provider</div>
            <Segmented<Provider> label="Claude provider" value={s.provider} options={PROVIDERS} onChange={(v) => patch.mutate({ provider: v })} />
          </Item>
          <Item style={{ alignItems: 'flex-start' }}><p className="ai-prose">{EXPLAIN[s.provider]}</p></Item>
          {s.provider === 'plan' && <PlanLogin />}
          {s.provider === 'api' && <ApiKey hasKey={!!status.data?.hasKey} />}
          {s.provider !== 'off' && <TestConnection />}
        </Group>
      </Section>
      {s.provider !== 'off' && <Models s={s} status={status.data} />}
      <Privacy s={s} />
      <UsageThisMonth />
    </div>
  );
}

// ---------------------------------------------------------------- ask
const STOPPED: Record<string, string> = {
  budget: 'Stopped at your monthly budget. Raise it in Settings → Claude to keep going.',
  max_tokens: 'The answer hit its length limit and was cut off. Ask for a shorter version.',
  max_rounds: 'Claude ran out of steps before finishing. Ask again, or narrow the question.',
  refusal: 'Claude declined to answer that.',
};
const STARTERS = ['What should I do first tonight?', 'Does this week fit my capacity?', 'Which tasks keep getting carried over?'];
let saved: Msg[] = []; // survives navigating to a proposal and back

function Reply({ m }: { m: Msg }) {
  const [, navigate] = useLocation();
  const r = m.run;
  return (
    <div className="ai-msg">
      <div className="ai-md"><Markdown>{m.content}</Markdown></div>
      {!!r?.toolCalls.length && (
        <div className="ai-tools tiny muted">
          Used
          {[...new Map(r.toolCalls.map((c) => [c.name, c])).values()].map((c) => (
            <Tag key={c.name} tone={c.ok ? (c.kind === 'propose' ? 'accent' : undefined) : 'amber'}>{c.name}{c.kind === 'propose' && c.note ? ` · ${c.note}` : c.ok ? '' : ' · failed'}</Tag>
          ))}
        </div>
      )}
      {r?.changeSetId && (
        <Banner tone="amber" icon="ListChecks" action={<Button variant="primary" onClick={() => navigate(`/changes/${r.changeSetId}`)}>Review Changes</Button>}>
          Claude proposed changes. Nothing is applied until you review them.
        </Banner>
      )}
      {r?.careShown && (
        <Banner icon="LifeBuoy" action={<Button onClick={() => navigate('/help')}>Open Get Help</Button>}>The Get help page is ready whenever you want it.</Banner>
      )}
      {r?.stopped && STOPPED[r.stopped] && <p className="small muted">{STOPPED[r.stopped]}</p>}
    </div>
  );
}

function AskPage() {
  const status = useApi<Status>('/api/ai/status');
  const [, navigate] = useLocation();
  const [msgs, setMsgs] = useState<Msg[]>(saved);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { saved = msgs; end.current?.scrollIntoView({ block: 'end' }); }, [msgs, busy, error]);

  const send = async (raw: string) => {
    const q = raw.trim();
    if (!q || busy) return;
    const next: Msg[] = [...msgs, { role: 'user', content: q }];
    setMsgs(next); setText(''); setError(null); setBusy(true);
    try {
      // Last 19 turns so the history starts with a person turn and ends with one.
      const messages = next.slice(-19).map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));
      const run = await api.post<RunOut>('/api/ai/run', { feature: 'ask', input: { messages } });
      setMsgs([...next, { role: 'assistant', content: run.text || 'No answer came back. Try asking again.', run }]);
      void queryClient.invalidateQueries();
    } catch (e: any) {
      setMsgs(msgs); setText(q); setError(e.message ?? 'That didn’t go through. Try again.');
    } finally { setBusy(false); }
  };

  const st = status.data;
  const actions = msgs.length > 0 ? <Button variant="plain" onClick={() => { setMsgs([]); setError(null); }}>New Chat</Button> : undefined;
  if (!st) return <Page title="Ask" width="narrow"><span /></Page>;
  if (!st.enabled) {
    return (
      <Page title="Ask" width="narrow">
        <Empty action={<Button variant="primary" onClick={() => navigate('/settings/ai')}>Open Claude Settings</Button>}>
          <p><strong>{st.provider === 'api' ? 'Claude is set to use an API key, but none is saved yet.' : 'Claude is off.'}</strong></p>
          <p style={{ maxWidth: 460, margin: '8px auto 0' }}>Ask lets you question your tasks, schedule and capacity, and have Claude propose changes that you review. Turn it on in Settings → Claude, with your Claude plan or an API key. Margin works the same without it.</p>
        </Empty>
      </Page>
    );
  }
  return (
    <Page title="Ask" subtitle="Claude can read your plan and propose changes" width="narrow" actions={actions}>
      <div className="ai-chat">
        {msgs.length === 0 && (
          <Section title="Try asking">
            <Group>{STARTERS.map((q) => <Item key={q} onClick={() => void send(q)}><Icon name="Sparkles" size={14} /><div className="title">{q}</div></Item>)}</Group>
          </Section>
        )}
        {msgs.map((m, i) => (m.role === 'user'
          ? <div key={i} className="ai-msg user"><div className="ai-bubble">{m.content}</div></div>
          : <Reply key={i} m={m} />))}
        {busy && <div className="ai-msg"><span className="row muted small"><Spinner /> Claude is working.{st.provider === 'plan' ? ' Plan login can take up to a minute.' : ''}</span></div>}
        {error && (
          <Banner tone="amber" icon="TriangleAlert" action={/Settings/.test(error) ? <Button onClick={() => navigate('/settings/ai')}>Open Settings</Button> : undefined}>{error}</Banner>
        )}
        <div className="ai-composer" ref={end}>
          <TextArea rows={2} autoFocus maxLength={4000} aria-label="Message to Claude" placeholder="Ask about your day, your week, or a project" value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(text); } }} />
          <Button variant="primary" icon="ArrowUp" disabled={!text.trim() || busy} onClick={() => void send(text)}>Send</Button>
        </div>
        <p className="faint tiny">Enter sends, Shift+Enter adds a line. Claude only proposes; you apply or discard each change.</p>
      </div>
    </Page>
  );
}

export default defineWebModule({
  id: 'ai',
  routes: [{ path: '/ask', component: AskPage, work: true }],
  settingsPanel: AiPanel,
  commands: [{ id: 'ai.ask', label: 'Ask Claude', group: 'Claude', run: () => '/ask' }],
});
