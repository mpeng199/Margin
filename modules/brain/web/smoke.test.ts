import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { test, expect } from 'vitest';
import { queryClient } from '@web/lib/query';
import mod from './index';
import { Markdown } from './Markdown';

const render = (el: any, path = '/brain', search = '') =>
  renderToString(h(QueryClientProvider, { client: queryClient }, h(Router as any, { ssrPath: path, ssrSearch: search }, el)));

test('Markdown renders links and tags, and never raw HTML, scripts or remote images', () => {
  const html = render(h(Markdown, {
    known: new Set(['lim lab']),
    text: [
      'See [[Lim Lab]] and [[Lim Lab#Poster|the poster]], [[Nowhere]], #school and `[[code]]`.',
      '[bad](wiki:%ZZ) [js](javascript:alert(1)) [web](https://example.com) <b onclick="x()">bold</b>',
      '![pixel](https://tracker.example/p.gif)',
    ].join('\n\n'),
  }));
  expect(html).toContain('href="/brain?open=Lim%20Lab"');
  expect(html).toContain('>the poster</a>');
  expect(html).toMatch(/class="brain-wikilink missing"[^>]*>Nowhere/);
  expect(html).toContain('href="/brain?tag=school"');
  expect(html).toContain('<code>[[code]]</code>');
  expect(html).toContain('href="/brain?open=%25ZZ"');
  expect(html).not.toContain('javascript:');
  expect(html).toContain('href="https://example.com" target="_blank"');
  expect(html).not.toContain('<b');
  expect(html).not.toContain('<img');
  expect(html).toContain('>pixel</a>');
});

test('the Brain page renders the list and a note with its compiled part and backlinks', () => {
  const note = {
    id: 'n1', title: 'Routine', area: 'Me', date: null, pinned: true, private: false, generated: true,
    updatedAt: '2026-11-02T09:00:00-05:00', createdAt: '2026-11-02T09:00:00-05:00', compiledAt: '2026-11-02T09:00:00-05:00', deletedAt: null,
    body: 'My own line about [[About me]].', auto: '## Anchors\n- Wake: 6:00 AM', wellbeing: 'Slept 8h.', tags: ['sleep'], source: 'margin:routine',
    backlinks: [{ id: 'n2', title: 'About me', area: 'Me', snippet: 'Start here' }], links: [{ title: 'About me', id: 'n2' }, { title: 'Nowhere', id: null }],
  };
  queryClient.setQueryData(['/api/brain/notes?'], { notes: [{ ...note, snippet: 'Anchors' }], total: 1 });
  queryClient.setQueryData(['/api/brain/areas'], [{ area: 'Me', count: 2 }]);
  queryClient.setQueryData(['/api/brain/tags'], [{ tag: 'sleep', count: 1 }]);
  queryClient.setQueryData(['/api/brain/titles'], [{ id: 'n1', title: 'Routine', area: 'Me' }, { id: 'n2', title: 'About me', area: 'Me' }]);
  queryClient.setQueryData(['/api/brain/notes/n1'], note);
  const page = mod.routes!.find((r) => r.path === '/brain/:id')!.component;
  const html = render(h(page, { params: { id: 'n1' } }), '/brain/n1');
  expect(html).toContain('Routine');
  expect(html).toContain('From Margin');
  expect(html).toContain('Wake: 6:00 AM');
  expect(html).toContain('Slept 8h.');
  expect(html).toContain('Linked from');
  expect(html).toContain('Not written yet');
  expect(html).toContain('#sleep');
  expect(render(h(mod.routes![0].component, {}), '/brain')).toContain('Choose a note');
});
