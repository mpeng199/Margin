/**
 * projects — shared types and static data (statuses, palette, built-in templates, onboarding seeds).
 * Pure: no database, no Ctx. The web half imports the types from here too.
 */
import { addDays, type ISODate } from '../../src/core/time';

export const STATUSES = ['core', 'maintain', 'pause', 'drop', 'proposed'] as const;
export type Status = (typeof STATUSES)[number];
export const SEPARATIONS = ['hidden', 'milestones', 'everything'] as const;
export type Separation = (typeof SEPARATIONS)[number];
export type MilestoneKind = 'milestone' | 'deadline';

export interface Maintenance { action: string; capMin: number; told: string }
export interface TodoistLink { type: 'project' | 'label'; id?: string; name?: string }

export interface Project {
  id: string;
  name: string;
  color: string;
  /** lucide-react icon name, PascalCase. */
  icon: string;
  status: Status;
  isSchool: boolean;
  purpose: string;
  goal: string;
  maintenance: Maintenance | null;
  restartDate: ISODate | null;
  todoist: TodoistLink | null;
  calendarId: string | null;
  separation: Separation;
  weeklyBudgetMin: number;
  /** Typical weekly minutes the project takes. "Yes requires a no" trades projects of equal or larger size. */
  sizeMin: number;
  order: number;
  pinned: boolean;
  archived: boolean;
  templateId: string | null;
  createdAt: string;
}
/** End is inclusive here; Google's all-day end is exclusive, the service converts. */
export interface Phase { id: string; projectId: string; title: string; start: ISODate; end: ISODate; gcalEventId: string | null }
export interface Milestone { id: string; projectId: string; title: string; kind: MilestoneKind; date: ISODate; gcalEventId: string | null; done: boolean }
export interface StatusChange { id: string; projectId: string; from: Status | null; to: Status; at: string; note: string }

export interface TemplateData {
  /** Day offsets from the project's start date (inclusive on both ends). */
  phases: { title: string; startOffset: number; endOffset: number }[];
  milestones: { title: string; offset: number; kind: MilestoneKind }[];
  maintenance: Maintenance | null;
  icon?: string;
  color?: string;
  sizeMin?: number;
  weeklyBudgetMin?: number;
}
export interface Template { id: string; name: string; description: string; builtin: boolean; data: TemplateData }

/** System-palette hues. No red: red is reserved for Get help. */
export const PALETTE = ['#007aff', '#34c759', '#ff9500', '#af52de', '#5ac8fa', '#5856d6', '#a2845e', '#30b0c7', '#ffcc00', '#8e8e93'];

export const BUILTIN_TEMPLATES: Template[] = [
  {
    id: 'application-cycle', name: 'Application cycle', builtin: true,
    description: 'Research, drafting, revision and submission for a set of applications, with the decision wait at the end.',
    data: {
      icon: 'Send', sizeMin: 300, weeklyBudgetMin: 300,
      phases: [
        { title: 'Research and shortlist', startOffset: 0, endOffset: 13 },
        { title: 'Drafting', startOffset: 14, endOffset: 55 },
        { title: 'Revision', startOffset: 56, endOffset: 75 },
        { title: 'Submission', startOffset: 76, endOffset: 89 },
        { title: 'Decisions', startOffset: 90, endOffset: 150 },
      ],
      milestones: [
        { title: 'Shortlist final', offset: 13, kind: 'milestone' },
        { title: 'Recommenders asked', offset: 21, kind: 'milestone' },
        { title: 'First drafts done', offset: 55, kind: 'milestone' },
        { title: 'Applications due', offset: 89, kind: 'deadline' },
        { title: 'Decisions expected', offset: 150, kind: 'milestone' },
      ],
      maintenance: { action: 'Check the next deadline and finish one item on its checklist.', capMin: 60, told: '' },
    },
  },
  {
    id: 'research-paper', name: 'Research paper', builtin: true,
    description: 'Literature, methods and data, drafting, then revision and submission.',
    data: {
      icon: 'FlaskConical', sizeMin: 360, weeklyBudgetMin: 360,
      phases: [
        { title: 'Literature review', startOffset: 0, endOffset: 20 },
        { title: 'Methods and data', startOffset: 21, endOffset: 50 },
        { title: 'Drafting', startOffset: 51, endOffset: 80 },
        { title: 'Revise and submit', startOffset: 81, endOffset: 100 },
      ],
      milestones: [
        { title: 'Outline approved', offset: 20, kind: 'milestone' },
        { title: 'Data collected', offset: 50, kind: 'milestone' },
        { title: 'Draft to mentor', offset: 80, kind: 'milestone' },
        { title: 'Submission', offset: 100, kind: 'deadline' },
      ],
      maintenance: { action: 'One work session on the current phase.', capMin: 90, told: '' },
    },
  },
  {
    id: 'student-org', name: 'Student org', builtin: true,
    description: 'Plan the term, run events on a steady rhythm, hand off cleanly.',
    data: {
      icon: 'Users', sizeMin: 120, weeklyBudgetMin: 120,
      phases: [
        { title: 'Plan the term', startOffset: 0, endOffset: 13 },
        { title: 'Run events', startOffset: 14, endOffset: 75 },
        { title: 'Wrap up and hand off', startOffset: 76, endOffset: 89 },
      ],
      milestones: [
        { title: 'Term plan agreed', offset: 13, kind: 'milestone' },
        { title: 'Monthly event', offset: 30, kind: 'milestone' },
        { title: 'Monthly event', offset: 60, kind: 'milestone' },
        { title: 'Hours and handoff notes in', offset: 89, kind: 'deadline' },
      ],
      maintenance: { action: 'Minimum required hours, batched into one event a month.', capMin: 120, told: '' },
    },
  },
];

export interface SeedSuggestion {
  key: string;
  name: string;
  status: Exclude<Status, 'proposed'>;
  isSchool: boolean;
  color: string;
  icon: string;
  templateId?: string;
  maintenance?: Maintenance;
  restartDate?: ISODate;
  sizeMin: number;
  weeklyBudgetMin: number;
  /** One short line shown under the name during onboarding. */
  note?: string;
}

/** Days a seeded Pause lasts when nobody picked a date: roughly the start of Rebuild (SPEC 4.10, month 3+). */
export const DEFAULT_PAUSE_DAYS = 60;

/**
 * SPEC 5's seed list with suggested statuses from the burnout plan (SPEC 4.5).
 * Told-lines name who needs to hear about the reduced scope; edit them in the project's Overview.
 */
export function seedSuggestions(today: ISODate): SeedSuggestion[] {
  const restart = addDays(today, DEFAULT_PAUSE_DAYS);
  const side = (key: string, name: string, color: string, icon: string): SeedSuggestion => ({
    key, name, status: 'pause', isSchool: false, color, icon, sizeMin: 180, weeklyBudgetMin: 0, restartDate: restart,
    maintenance: { action: 'Leisure only: no deadlines, no estimates, stop when it stops being fun.', capMin: 180, told: 'Nobody; nothing is promised' },
    note: 'Pause all but one side project. The one you keep becomes leisure, with no deadlines.',
  });
  return [
    { key: 'school', name: 'School', status: 'core', isSchool: true, color: PALETTE[0], icon: 'GraduationCap', sizeMin: 0, weeklyBudgetMin: 0, note: 'Core. Homework has its own lane in Today.' },
    {
      key: 'applications', name: 'Summer 2027 applications', status: 'core', isSchool: false, color: PALETTE[2], icon: 'Send', templateId: 'application-cycle',
      sizeMin: 300, weeklyBudgetMin: 300, note: 'Core while deadlines are open.',
    },
    {
      key: 'shp', name: 'Columbia Science Honors Program', status: 'core', isSchool: false, color: PALETTE[3], icon: 'Atom', sizeMin: 240, weeklyBudgetMin: 240,
      note: 'Core if attendance is required.',
      maintenance: { action: 'Attend the Saturday session. No extra work between sessions.', capMin: 240, told: 'Program coordinator' },
    },
    {
      key: 'lim-lab', name: 'Lim Lab (Mount Sinai)', status: 'maintain', isSchool: false, color: PALETTE[1], icon: 'Microscope', sizeMin: 780, weeklyBudgetMin: 780,
      note: 'Core or Maintain. Keep the standing block; Maintain keeps you inside the 2-project limit.',
      maintenance: { action: 'The standing lab block only, plus one written update to Dr. Lim each week.', capMin: 780, told: 'Dr. Lim' },
    },
    {
      key: 'delphic', name: 'Delphic Medicine', status: 'maintain', isSchool: false, color: PALETTE[4], icon: 'BookOpen', sizeMin: 300, weeklyBudgetMin: 50,
      note: 'Maintain, run through owners: intake and reviewers, editing and production, outreach, operations.',
      maintenance: { action: 'One 20-min owner check-in plus 30 min of decisions, Sundays.', capMin: 50, told: 'Delphic owners' },
    },
    {
      key: 'red-cross', name: 'Hunter Red Cross Club', status: 'maintain', isSchool: false, color: PALETTE[6], icon: 'HeartHandshake', sizeMin: 90, weeklyBudgetMin: 30,
      note: 'Maintain at the minimum required hours, batched into one event a month.',
      maintenance: { action: 'Minimum required hours, batched into one event a month.', capMin: 120, told: 'Club officers' },
    },
    {
      key: 'waypoint', name: 'WaypointNYC', status: 'pause', isSchool: false, color: PALETTE[7], icon: 'MapPin', sizeMin: 120, weeklyBudgetMin: 0, restartDate: restart,
      note: 'Pause, or a minimal Maintain.',
      maintenance: { action: 'Answer one message a week; nothing else.', capMin: 30, told: 'WaypointNYC lead' },
    },
    side('serene', 'Serene', PALETTE[5], 'Leaf'),
    side('toxreadout', 'ToxReadout', PALETTE[8], 'Biohazard'),
    side('localflow', 'LocalFlow', PALETTE[9], 'Workflow'),
    side('blender-web', 'Blender and web work', PALETTE[0], 'Box'),
    side('margin', 'Margin (this app)', PALETTE[1], 'CalendarClock'),
  ];
}

export const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'project';
export const isDate = (s: unknown): s is ISODate => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
