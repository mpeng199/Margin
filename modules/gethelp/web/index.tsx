import './gethelp.css';
import { useState } from 'react';
import { Link } from 'wouter';
import { defineWebModule } from '@web/lib/module';
import { Page } from '@web/app/Page';
import { useApi, useAction } from '@web/lib/query';
import { Section, Group, Item, Button, Banner, Sheet, Field, Input, Segmented, Icon } from '@web/ui';
import { RED_FLAGS, reasonLabel } from '../flags';
import type { HelpState } from '../manifest';

const useHelp = () => useApi<HelpState>('/api/gethelp/state');
const digits = (phone: string) => phone.replace(/[^\d+]/g, '');
const who = (name: string) => (name === 'Trusted adult' ? 'your trusted adult' : name);

/** 988 first, then the trusted adult. Used by the Today card and the page. */
function Reach({ contact, large }: { contact: HelpState['contact']; large?: boolean }) {
  const size = large ? ' large' : '';
  return (
    <>
      <a className={`btn primary gh-red${size}`} href="tel:988"><Icon name="Phone" size={14} />988 Call</a>
      <a className={`btn primary gh-red${size}`} href="sms:988"><Icon name="MessageSquare" size={14} />988 Text</a>
      {contact && !large && (
        <>
          <a className="btn" href={`tel:${digits(contact.phone)}`}>Call {who(contact.name)}</a>
          <a className="btn" href={`sms:${digits(contact.phone)}`}>Text {who(contact.name)}</a>
        </>
      )}
    </>
  );
}

/** Yes/no list from the spec. Any yes opens Get help on the server. Answering is optional. */
export function RedFlagCheck({ onResult }: { onResult?: (r: { opened: boolean; yes: string[] }) => void }) {
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<{ opened: boolean } | null>(null);
  const post = useAction<{ answers: Record<string, boolean> }, { opened: boolean; yes: string[] }>('post', '/api/gethelp/red-flags', (r) => { setResult(r); onResult?.(r); });
  const answered = Object.keys(answers).length;
  return (
    <div>
      <Group>
        {RED_FLAGS.map((f) => (
          <Item key={f.id} className="gh-flag">
            <div className="title">{f.text}</div>
            <Segmented label={f.text} value={answers[f.id] === undefined ? '' : answers[f.id] ? 'yes' : 'no'}
              options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]}
              onChange={(v) => { setAnswers({ ...answers, [f.id]: v === 'yes' }); setResult(null); }} />
          </Item>
        ))}
      </Group>
      <div className="row" style={{ marginTop: 'var(--s3)' }}>
        <Button variant="primary" className="gh-red" disabled={!answered || post.isPending} onClick={() => post.mutate({ answers })}>Save My Answers</Button>
        <span className="faint tiny">You can skip any of these.</span>
      </div>
      {result && (
        <p className="gh-result" role="status">
          {result.opened
            ? 'Thank you for telling me. Get help stays open on Today. 988 is there any time, and it can help to tell someone you trust too.'
            : 'Thanks for checking in with yourself. This list stays here if anything changes.'}
        </p>
      )}
    </div>
  );
}

function ContactSheet({ initial, open, onClose }: { initial: HelpState['contact']; open: boolean; onClose: () => void }) {
  const [name, setName] = useState(initial && initial.name !== 'Trusted adult' ? initial.name : '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const save = useAction('patch', '/api/settings/gethelp', onClose);
  const put = (n: string, p: string) => save.mutate({ trustedAdultName: n.trim(), trustedAdultPhone: p.trim() } as any);
  return (
    <Sheet open={open} onClose={onClose} title="Someone you trust"
      subtitle="A parent, relative, coach, or counselor you could call or text. This stays on this Mac."
      footer={<>
        {initial && <Button variant="danger" onClick={() => put('', '')}>Remove</Button>}
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!phone.trim() || save.isPending} onClick={() => put(name, phone)}>Save</Button>
      </>}>
      <div className="stack">
        <Field label="Name"><Input style={{ width: '100%' }} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Phone number"><Input style={{ width: '100%' }} type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && phone.trim()) put(name, phone); }} /></Field>
      </div>
    </Sheet>
  );
}

function HelpPage() {
  const { data } = useHelp();
  const [editing, setEditing] = useState(false);
  const c = data?.contact ?? null;
  const reason = data?.open && data.reason && data.reason !== 'requested' ? reasonLabel(data.reason) : null;
  return (
    <Page title="Get help" width="narrow">
      <div className="gh-hero">
        <Icon name="LifeBuoy" size={22} className="gh-icon" />
        <h2>If things feel heavy, you don’t have to sort it out alone.</h2>
        <p>988 is the Suicide &amp; Crisis Lifeline. It’s free, private, and open all day and night. You can call or text, even if you’re not sure it’s serious enough.</p>
        <div className="gh-actions"><Reach contact={null} large /></div>
        <p className="tiny">If you’re in immediate danger, call 911.</p>
        {reason && <p className="tiny faint">Why this is open today: {reason}</p>}
      </div>

      {data && <Section title="Someone you trust" why="Telling one person is often the hardest part, and the most useful.">
        <Group>
          {c ? (
            <Item>
              <div className="title">{c.name}<div className="sub num">{c.phone}</div></div>
              <a className="btn" href={`tel:${digits(c.phone)}`}>Call</a>
              <a className="btn" href={`sms:${digits(c.phone)}`}>Text</a>
              <Button variant="plain" onClick={() => setEditing(true)}>Change</Button>
            </Item>
          ) : (
            <Item>
              <div className="title">Pick one person you could call or text when things are hard.</div>
              <Button onClick={() => setEditing(true)}>Add Someone</Button>
            </Item>
          )}
        </Group>
      </Section>}

      <Section title="Signs it’s worth telling someone" why="Answering is optional, and your answers stay on this Mac.">
        <RedFlagCheck />
      </Section>

      <Section title="What Margin is, and isn’t">
        <Group pad className="gh-note">
          <p>Burnout and depression overlap heavily (r ≈ .80; Bianchi 2021). That’s why Margin never calls what you’re going through “just burnout.”</p>
          <p>Margin is a planner, not a medical tool. It can’t diagnose anything or replace a doctor, a counselor, or someone who knows you. If this has lasted a few weeks, or you’re not sure, talking to one of them is a good next step.</p>
        </Group>
      </Section>

      {editing && <ContactSheet initial={c} open onClose={() => setEditing(false)} />}
    </Page>
  );
}

/** Today banner: only while Get help is open for today and hasn't been dismissed. */
function HelpCard() {
  const { data } = useHelp();
  const dismiss = useAction('post', '/api/gethelp/dismiss');
  if (!data?.open) return null;
  const reason = data.reason && data.reason !== 'requested' ? reasonLabel(data.reason) : undefined;
  return (
    <Banner tone="red" icon="LifeBuoy" why={reason}
      action={<Button onClick={() => dismiss.mutate({} as any)} disabled={dismiss.isPending}>Dismiss for Today</Button>}>
      <strong>You don’t have to sort this out alone.</strong>
      <div className="small muted">Talking to someone could help today. 988 is free and open all day and night.</div>
      <div className="gh-links">
        <Reach contact={data.contact} />
        <Link className="btn plain" href="/help">More support</Link>
      </div>
    </Banner>
  );
}

export default defineWebModule({
  id: 'gethelp',
  routes: [{ path: '/help', component: HelpPage, work: false }],
  widgets: { card: HelpCard },
  commands: [{ id: 'gethelp.open', label: 'Get help', group: 'Help', run: () => '/help' }],
});
