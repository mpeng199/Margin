import { QueryClient, useQuery, useMutation, type UseQueryOptions } from '@tanstack/react-query';
import { api } from './api';
import { toast } from '../ui/toast';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, refetchOnWindowFocus: true, retry: 1 },
    mutations: { onError: (e: any) => toast(e?.message ?? 'Something went wrong') },
  },
});

/** GET a daemon path. The key is the path itself, so any event refetches it. */
export function useApi<T = any>(path: string | null, opts: Partial<UseQueryOptions<T>> = {}) {
  return useQuery<T>({ queryKey: [path], queryFn: () => api.get<T>(path!), enabled: !!path, ...opts } as UseQueryOptions<T>);
}

/** POST/PATCH/PUT/DELETE then refetch everything (local data, cheap). */
export function useAction<TBody = any, TOut = any>(method: 'post' | 'patch' | 'put' | 'del', path: string | ((b: TBody) => string), onDone?: (out: TOut) => void) {
  return useMutation<TOut, Error, TBody>({
    mutationFn: (body: TBody) => {
      const p = typeof path === 'function' ? path(body) : path;
      return method === 'del' ? api.del<TOut>(p) : (api as any)[method](p, body);
    },
    onSuccess: (out) => { void queryClient.invalidateQueries(); onDone?.(out); },
  });
}

/** Server-sent events: refetch when anything changes; the shell also uses this stream for notifications. */
export function connectLiveUpdates() {
  let es: EventSource | null = null;
  let timer: number | undefined;
  const open = () => {
    es = new EventSource('/api/stream?client=web');
    es.addEventListener('bus', () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => void queryClient.invalidateQueries(), 120);
    });
    es.onerror = () => { es?.close(); setTimeout(open, 2000); };
  };
  open();
}
