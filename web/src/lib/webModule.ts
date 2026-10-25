/** Discovers every module's web half (modules/<id>/web/index.tsx). Import types/helpers from ./module. */
import type { WebModule } from './module';
export type { WebModule, WebCommand } from './module';
export { defineWebModule } from './module';

const found = import.meta.glob<{ default: WebModule }>(['../../../modules/*/web/index.tsx', '!../../../modules/_*/web/index.tsx'], { eager: true });
export const webModules: WebModule[] = Object.values(found).map((m) => m.default).filter(Boolean);
export const webModule = (id: string) => webModules.find((m) => m.id === id);
