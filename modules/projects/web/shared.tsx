import { useCallback, useState, type ReactNode } from 'react';
import { queryClient } from '@web/lib/query';
import { Field, Input, TextArea, Icon, Tag } from '@web/ui';
import type { Project, Phase, Milestone, StatusChange, Status, Maintenance, Template } from '../model';
import { PALETTE } from '../model';
import type { Task } from '../../todoist/manifest';

export type { Project, Phase, Milestone, StatusChange, Status, Maintenance, Task, Template };

export interface Spent { from: string; to: string; focusMin: number; eventMin: number; actualMin: number; budgetMin: number; over: boolean }
export type NextMilestone = (Milestone & { daysAway: number }) | null;
export interface SummaryProject extends Project { nextMilestone: NextMilestone; spent: Spent | null }
export interface Summary {
  projects: SummaryProject[];
  wip: { limit: number; count: number; exceeded: boolean; full: boolean; activeIds: string[] };
  canAdd: { allowed: boolean; reason?: string };
  restartDue: string[];
  proposed: Project[];
  tradeoffs: Project[];
}
export interface Detail extends Project { phases: Phase[]; milestones: Milestone[]; nextMilestone: NextMilestone }
export interface WaitingLite { id: string; what: string; who: string; since: string; due: string | null }
export interface Overview {
  project: Project;
  nextMilestone: NextMilestone;
  currentPhase: Phase | null;
  budget: Spent;
  openLoops: { openTasks: number; overdue: number; waiting: WaitingLite[] };
  hotspots: { id: string; content: string; carryCount: number; due: string | null; nextAction: string | null }[];
  statusLog: StatusChange[];
}
export interface PlanPreview { title: string; summary: string; changes: { kind: string; title: string }[] }

export const STATUS_LABEL: Record<Status, string> = { core: 'Core', maintain: 'Maintain', pause: 'Paused', drop: 'Dropped', proposed: 'Proposed' };
export const STATUS_TONE: Record<Status, 'accent' | 'amber' | undefined> = { core: 'accent', maintain: undefined, pause: undefined, drop: undefined, proposed: 'amber' };
export const StatusTag = ({ status }: { status: Status }) => <Tag tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Tag>;

export const COLOR_NAMES = ['Blue', 'Green', 'Orange', 'Purple', 'Teal', 'Indigo', 'Brown', 'Cyan', 'Yellow', 'Gray'];
export const ICONS = ['Folder', 'GraduationCap', 'Send', 'FlaskConical', 'Users', 'Microscope', 'BookOpen', 'Atom', 'HeartHandshake', 'MapPin', 'Leaf', 'Workflow', 'Box', 'CalendarClock', 'Briefcase', 'Code', 'Palette', 'Music', 'Dumbbell', 'Globe'];

export const Dot = ({ color, size = 10 }: { color: string; size?: number }) => <span className="pj-dot" style={{ background: color, width: size, height: size }} aria-hidden="true" />;

/** Run an API call with a busy flag and the server's message kept for inline display (validation text is written to be shown as is). */
export function useSend() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    setBusy(true); setError(null);
    try { const out = await fn(); void queryClient.invalidateQueries(); return out; }
    catch (e: any) { setError(e?.message ?? 'Something went wrong. Try again.'); return null; }
    finally { setBusy(false); }
  }, []);
  return { busy, error, run, setError };
}
export const ErrorLine = ({ error }: { error: string | null }) => (error ? <p className="pj-err" role="alert">{error}</p> : null);

export function Swatches({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="pj-swatches" role="radiogroup" aria-label="Color">
      {PALETTE.map((c, i) => (
        <button key={c} type="button" role="radio" aria-checked={c === value} aria-label={COLOR_NAMES[i]} title={COLOR_NAMES[i]} className="pj-swatch" style={{ background: c }} onClick={() => onChange(c)}>
          {c === value && <Icon name="Check" size={12} strokeWidth={3} />}
        </button>
      ))}
    </div>
  );
}

export function MaintenanceFields({ value, onChange }: { value: Maintenance; onChange: (m: Maintenance) => void }) {
  return (
    <>
      <Field label="Smallest weekly action" hint="The least that keeps this alive.">
        <TextArea rows={2} value={value.action} onChange={(e) => onChange({ ...value, action: e.target.value })} />
      </Field>
      <div className="form-grid">
        <Field label="Weekly cap (minutes)"><Input type="number" min={5} step={5} value={value.capMin || ''} onChange={(e) => onChange({ ...value, capMin: Number(e.target.value) })} /></Field>
        <Field label="Who has been told"><Input value={value.told} onChange={(e) => onChange({ ...value, told: e.target.value })} placeholder="Name or group" /></Field>
      </div>
    </>
  );
}

export const emptyMaintenance = (m?: Maintenance | null): Maintenance => m ?? { action: '', capMin: 60, told: '' };
export const Row = ({ children }: { children: ReactNode }) => <div className="pj-row-actions">{children}</div>;
