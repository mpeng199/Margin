import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { test, expect } from 'vitest';
import { queryClient } from '@web/lib/query';
import mod from './index';
import deleg, { People } from '../../delegation/web';

const p = { id: 'p1', name: 'Delphic', color: '#007aff', icon: 'BookOpen', status: 'maintain', isSchool: false, purpose: 'Run the journal', goal: 'Issue 3', maintenance: { action: 'Check in', capMin: 50, told: 'Owners' }, restartDate: null, todoist: { type: 'project', id: 't1', name: 'Delphic' }, calendarId: 'c1', separation: 'milestones', weeklyBudgetMin: 60, sizeMin: 300, order: 0, pinned: true, archived: false, templateId: null, createdAt: '2026-10-01' };
const ms = { id: 'm1', projectId: 'p1', title: 'Draft due', kind: 'deadline', date: '2026-11-05', gcalEventId: null, done: false };
const ph = { id: 'ph1', projectId: 'p1', title: 'Drafting', start: '2026-10-20', end: '2026-11-10', gcalEventId: null };
const spent = { from: '2026-10-25', to: '2026-10-31', focusMin: 30, eventMin: 20, actualMin: 50, budgetMin: 60, over: false };
const task = (id: string, extra: any = {}) => ({ id, content: `Task ${id}`, description: '', projectId: 't1', projectName: 'Delphic', sectionId: 's1', sectionName: 'Intake', parentId: null, priority: 4, labels: [], due: { date: '2026-10-28', time: null, recurring: false, string: '' }, deadline: null, durationMin: null, estimateMin: 45, checked: false, completedAt: null, meta: { estimateMin: 45, mustDoDate: null, optional: false, homework: null, carryCount: 2, lastCarryDate: null, nextAction: null, owner: 'Sam' }, url: '', ...extra });
const seed = (k: string, v: unknown) => queryClient.setQueryData([k], v);
seed('/api/projects', [p, { ...p, id: 'p2', name: 'Paused one', status: 'pause', restartDate: '2026-12-20' }]);
seed('/api/projects/summary', { projects: [{ ...p, nextMilestone: { ...ms, daysAway: 11 }, spent }], wip: { limit: 2, count: 1, exceeded: false, full: false, activeIds: [] }, canAdd: { allowed: false, reason: 'Adding projects is locked. Recovery phase.' }, restartDue: [], proposed: [{ ...p, id: 'p3', name: 'Proposed one', status: 'proposed' }], tradeoffs: [p] });
seed('/api/projects/p1', { ...p, phases: [ph], milestones: [ms], nextMilestone: { ...ms, daysAway: 11 } });
seed('/api/projects/p1/overview', { project: p, nextMilestone: { ...ms, daysAway: 11 }, currentPhase: ph, budget: spent, openLoops: { openTasks: 4, overdue: 1, waiting: [{ id: 'w1', what: 'Reviewer list', who: 'Sam', since: '2026-10-20', due: null }] }, hotspots: [{ id: 't2', content: 'Hard one', carryCount: 3, due: null, nextAction: 'Email' }], statusLog: [{ id: 's', projectId: 'p1', from: 'core', to: 'maintain', at: '2026-10-10T10:00:00-04:00', note: '' }] });
seed('/api/projects/p1/tasks', { link: p.todoist, sections: [{ id: 's1', name: 'Intake' }], tasks: [task('a'), task('b', { parentId: 'a' })] });
seed('/api/projects/p1/timeline', { today: '2026-10-25', phases: [ph], milestones: [ms], sessions: [{ id: 'x', title: 'Focus', start: '2026-10-26T10:00:00-04:00', end: '2026-10-26T11:00:00-04:00', source: 'focus' }], tasks: [{ id: 'a', content: 'Task a', date: '2026-10-28', recurring: false, priority: 4 }] });
seed('/api/delegation/functions?projectId=p1', [{ id: 'f1', projectId: 'p1', name: 'Intake', owner: 'Sam', decisionRights: 'Accept or reject', dueDate: null, goodEnough: 'Triaged in 3 days', cadence: 'weekly', checkinMin: 20, lastCheckin: null, nextCheckin: '2026-10-20', order: 0, createdAt: '' }]);
seed('/api/delegation/scripts', [{ id: 's', title: 'At capacity', body: 'I am at capacity.', order: 0, builtin: true }]);
seed('/api/delegation/draft/available', { enabled: true });

const render = (el: any, path: string, search = '') => renderToString(h(QueryClientProvider, { client: queryClient }, h(Router as any, { ssrPath: path, ssrSearch: search }, el)));
const route = (m: any, path: string) => m.routes.find((r: any) => r.path === path).component;

test('renders', () => {
  expect(render(h(mod.sidebar!, { locked: false }), '/projects/p1')).toContain('Delphic');
  const list = render(h(route(mod, '/projects')), '/projects');
  expect(list).toContain('Adding projects is locked');
  expect(list).toContain('Activate…');
  for (const v of ['', 'tasks', 'timeline', 'calendar', 'people', 'notes', 'log']) {
    const html = render(h(route(mod, '/projects/:id'), { params: { id: 'p1' } }), '/projects/p1', v ? `v=${v}` : '');
    expect(html).toContain('Delphic');
    if (v === 'timeline') { expect(html).toContain('Drafting'); expect(html).toContain('Draft due'); }
    if (v === 'tasks') expect(html).toContain('Task a');
  }
  expect(render(h(People, { projectId: 'p1' }), '/')).toContain('Accept or reject');
  const scripts = render(h(route(deleg, '/scripts')), '/scripts');
  expect(scripts).toContain('Copy to Clipboard'); expect(scripts).toContain('Draft with Claude');
});
