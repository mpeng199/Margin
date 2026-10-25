import { useState } from 'react';
import { defineWebModule } from '@web/lib/module';
import { Page } from '@web/app/Page';
import { useApi, useAction } from '@web/lib/query';
import { Section, Group, Item, Button, Input, Empty } from '@web/ui';

function TemplatePage() {
  const items = useApi<{ id: string; title: string }[]>('/api/_template/items');
  const add = useAction('post', '/api/_template/items');
  const [title, setTitle] = useState('');
  return (
    <Page title="Template" width="narrow">
      <Section title="Items" why="Example of a why-line with its source (Author 2020).">
        <Group>
          {items.data?.length ? items.data.map((i) => <Item key={i.id}><div className="title">{i.title}</div></Item>) : <Empty>No items yet.</Empty>}
        </Group>
        <div className="row" style={{ marginTop: 12 }}>
          <Input className="grow" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New item" />
          <Button variant="primary" disabled={!title} onClick={() => { add.mutate({ title } as any); setTitle(''); }}>Add</Button>
        </div>
      </Section>
    </Page>
  );
}

function SummaryWidget() {
  const items = useApi<unknown[]>('/api/_template/items');
  return <Section title="Template"><Group pad>{items.data?.length ?? 0} items</Group></Section>;
}

export default defineWebModule({
  id: '_template',
  routes: [{ path: '/template', component: TemplatePage }],
  widgets: { summary: SummaryWidget },
  commands: [{ id: 'template.open', label: 'Open template', group: 'Template', run: () => '/template' }],
});
