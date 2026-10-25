/** today — the Today screen. It owns no data; it lays out widgets other modules declare. */
import { defineModule } from '../../src/core/types';

export default defineModule({
  id: 'today',
  name: 'Today',
  description: 'The Today screen: anchors, check-in, the day’s timeline, must-dos, homework, carry-overs, capacity, alerts.',
  core: true,
  nav: [{ id: 'today', label: 'Today', icon: 'Sun', path: '/today', section: 'main', order: 0, shortcut: 'Mod+1', work: true }],
});
