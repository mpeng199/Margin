import { defineWebModule } from '@web/lib/module';
import { Page } from '@web/app/Page';
import { WidgetSlot } from '@web/app/WidgetSlot';
import { useDay } from '@web/lib/hooks';
import { fmtDayLong } from '@web/lib/format';
import { Button } from '@web/ui';
import { openCapture } from '@web/app/palette-store';

function Today() {
  const day = useDay();
  const d = day.data;
  return (
    <Page title="Today" subtitle={d ? fmtDayLong(d.date) : undefined} actions={<Button icon="Plus" onClick={openCapture} kbd="⌘N">Capture</Button>}>
      <div className="today-banners"><WidgetSlot slot="today.banner" /></div>
      <div className="grid2">
        <div><WidgetSlot slot="today.main" /></div>
        <div className="today-side"><WidgetSlot slot="today.side" /></div>
      </div>
    </Page>
  );
}

export default defineWebModule({ id: 'today', routes: [{ path: '/today', component: Today, work: true }] });
