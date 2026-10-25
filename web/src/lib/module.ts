/**
 * Client half of a module: modules/<id>/web/index.tsx default-exports defineWebModule({...}).
 * Nav entries and widget placement are declared in the server manifest; components live here.
 */
import type { ComponentType } from 'react';

export interface WebCommand {
  id: string;
  label: string;
  group?: string;
  shortcut?: string;
  /** Return a path to navigate to, or perform an action. */
  run: (ctx: { navigate: (to: string) => void }) => void | string | Promise<void>;
}
export interface WebModule {
  id: string;
  /** `work: true` routes are gated in Evening mode and on the off-day. */
  routes?: { path: string; component: ComponentType<any>; work?: boolean }[];
  widgets?: Record<string, ComponentType<any>>;
  commands?: WebCommand[];
  /** Replaces the auto-generated settings form for this module. */
  settingsPanel?: ComponentType<any>;
  /** Settings keys the custom panel edits, hidden from the generated form. */
  settingsHide?: string[];
  /** Extra sidebar section (e.g. project tabs). */
  sidebar?: ComponentType<{ locked: boolean }>;
}
export const defineWebModule = (m: WebModule) => m;

