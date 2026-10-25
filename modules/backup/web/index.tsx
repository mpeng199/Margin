import { useState } from 'react';
import { defineWebModule } from '@web/lib/module';
import { useApi, useAction } from '@web/lib/query';
import { Section, Group, Item, Button, Select, Empty } from '@web/ui';

function BackupPanel() {
  const list = useApi<{ file: string; bytes: number }[]>('/api/backup/list');
  const tables = useApi<string[]>('/api/backup/tables');
  const now = useAction('post', '/api/backup/now');
  const reveal = useAction('post', '/api/backup/reveal');
  const [table, setTable] = useState('td_completions');
  return (
    <>
      <Section title="Backups" why="A copy of the database every night, kept on this Mac." end={<><Button onClick={() => reveal.mutate({} as any)}>Show in Finder</Button><Button onClick={() => now.mutate({} as any)}>Back Up Now</Button></>}>
        <Group>
          {list.data?.length ? list.data.slice(0, 7).map((b) => (
            <Item key={b.file}><div className="title num">{b.file}</div><span className="meta">{(b.bytes / 1024).toFixed(0)} KB</span></Item>
          )) : <Empty>No backups yet. The first one runs tonight at 3:00 AM.</Empty>}
        </Group>
      </Section>
      <Section title="Export" why="Everything Margin stores, as JSON or one table as CSV.">
        <Group>
          <Item><div className="title">All data (JSON)</div><a className="btn" href="/api/backup/export.json" download>Export JSON</a></Item>
          <Item>
            <div className="title">One table (CSV)</div>
            <Select value={table} onChange={(e) => setTable(e.target.value)} aria-label="Table">{(tables.data ?? []).map((t) => <option key={t}>{t}</option>)}</Select>
            <a className="btn" href={`/api/backup/export/${table}.csv`} download>Export CSV</a>
          </Item>
        </Group>
      </Section>
    </>
  );
}

export default defineWebModule({ id: 'backup', settingsPanel: BackupPanel });
