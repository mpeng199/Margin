import { useModules } from '../lib/hooks';
import { webModules } from '../lib/webModule';

/** Renders every enabled module's widgets declared for a slot, in manifest order. */
export function WidgetSlot({ slot, props }: { slot: string; props?: Record<string, unknown> }) {
  const { data } = useModules();
  const decls = (data ?? [])
    .filter((m) => m.enabled)
    .flatMap((m) => m.widgets.filter((w) => w.slot === slot).map((w) => ({ ...w, module: m.id })))
    .sort((a, b) => a.order - b.order);
  return (
    <>
      {decls.map((d) => {
        const C = webModules.find((w) => w.id === d.module)?.widgets?.[d.id];
        return C ? <C key={`${d.module}.${d.id}`} {...props} /> : null;
      })}
    </>
  );
}
