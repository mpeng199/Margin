/**
 * app — settings for Margin.app, the Electron shell (shell/main.cjs). The shell reads them from
 * /api/settings/app when it connects and again on every settings.changed, so a change applies at once.
 */
import { z } from 'zod';
import { defineModule } from '../../src/core/types';

export default defineModule({
  id: 'app',
  name: 'Mac app',
  description: 'The Margin window and its menu bar icon.',
  core: true,
  settings: z.object({
    menuBarIcon: z.boolean().default(true)
      .describe('Show Margin in the menu bar. When it’s off, Margin stays in the Dock after you close its window, and ⌃⌥Space still opens Quick Capture.'),
  }),
});
