import { z } from 'zod';
import { filtersSchema, funnelSchema, parseReportQuery, queryString, reportStatusSchema, utcDay, type Funnel, type ReportFilters, type ReportQuery, type ReportStatus } from '../shared/report';
interface State {
  applied?: ReportQuery; invalidUrl: boolean; busy: boolean; funnel?: Funnel; status?: ReportStatus; filters?: ReportFilters;
  error?: string; statusError?: string; filtersError?: string; lastSuccess?: number; pausedUntil?: number; stopped: boolean;
}
class ReadFailure extends Error { constructor(public status: number, public retryAfter = 0) { super('report_read_failed'); } }
export class ReportController {
  private state: State = { invalidUrl: false, busy: false, stopped: false };
  private listeners = new Set<() => void>();
  private generation = 0;
  private abort?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private expiry?: ReturnType<typeof setTimeout>;
  private active = false;
  private loadedAt?: number;
  private refreshFilters = false;
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(patch: Partial<State>) { this.state = { ...this.state, ...patch }; this.listeners.forEach((fn) => fn()); }
  start = () => {
    this.active = true; this.readUrl();
    document.addEventListener('visibilitychange', this.visibility);
    window.addEventListener('popstate', this.navigation);
    void this.load(true);
    return () => { this.active = false; this.generation++; this.abort?.abort(); clearTimeout(this.timer); clearTimeout(this.expiry); document.removeEventListener('visibilitychange', this.visibility); window.removeEventListener('popstate', this.navigation); this.state = { ...this.state, busy: false }; };
  };
  private readUrl() {
    if (!location.search) { this.set({ applied: undefined, invalidUrl: false }); return; }
    try { this.set({ applied: parseReportQuery(new URLSearchParams(location.search)), invalidUrl: false, error: undefined }); }
    catch { this.set({ applied: undefined, invalidUrl: true, funnel: undefined, error: 'Некоректні фільтри в URL. Виправте форму або скиньте фільтри.' }); }
  }
  private navigation = () => { this.generation++; this.abort?.abort(); this.set({ busy: false, funnel: undefined, stopped: false }); this.readUrl(); void this.load(true); };
  private visibility = () => {
    clearTimeout(this.timer);
    if (document.hidden) return;
    if (this.loadedAt === undefined || Date.now() - this.loadedAt > 900_000) this.set({ funnel: undefined });
    if (!this.state.stopped && !this.state.busy) void this.load(false);
  };
  apply = (query: ReportQuery) => {
    history.replaceState(null, '', location.pathname + '?' + queryString(query));
    this.generation++; this.abort?.abort();
    this.set({ applied: query, invalidUrl: false, funnel: undefined, error: undefined, busy: false, stopped: false });
    void this.load(false);
  };
  reset = () => {
    history.replaceState(null, '', location.pathname);
    this.generation++; this.abort?.abort();
    this.set({ applied: undefined, invalidUrl: false, funnel: undefined, error: undefined, busy: false, stopped: false });
    void this.load(true);
  };
  refresh = () => { this.set({ stopped: false }); void this.load(true); };
  private schedule() {
    clearTimeout(this.timer);
    if (!this.active || document.hidden || this.state.stopped || this.state.invalidUrl) return;
    this.timer = setTimeout(() => void this.load(false), Math.max(60_000, (this.state.pausedUntil ?? 0) - Date.now()));
  }
  private async load(manual: boolean) {
    if (!this.active || this.state.busy) return;
    this.refreshFilters ||= manual;
    clearTimeout(this.timer);
    const wait = (this.state.pausedUntil ?? 0) - Date.now();
    if (wait > 0) { if (!document.hidden) this.timer = setTimeout(() => void this.load(false), wait); return; }
    const generation = ++this.generation;
    const abort = this.abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 10_000);
    const current = () => this.active && generation === this.generation;
    this.set({ busy: true, pausedUntil: undefined });
    const startedAt = Date.now();
    const fetchDto = async <T>(path: string, schema: z.ZodType<T>): Promise<T> => {
      const response = await fetch('/api/v1/report/' + path, { signal: abort.signal, cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) {
        const raw = response.headers.get('retry-after'); const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
        throw new ReadFailure(response.status, [429, 503].includes(response.status) ? (Number.isSafeInteger(seconds) && seconds > 0 ? seconds : response.status === 429 ? 60 : 30) * 1000 : 0);
      }
      return schema.parse(await response.json());
    };
    const fail = (error: unknown) => {
      if (error instanceof ReadFailure) {
        if ([400, 401, 403].includes(error.status)) this.set({ stopped: true });
        if (error.retryAfter) this.set({ pausedUntil: Math.max(this.state.pausedUntil ?? 0, Date.now() + error.retryAfter) });
      }
    };
    const funnel = async (query: ReportQuery) => {
      try {
        const value = await fetchDto('funnel?' + queryString(query), funnelSchema);
        if (!current()) return;
        if (queryString(value.filters) !== queryString(query) || Date.now() - startedAt > 900_000) throw new Error('response_mismatch');
        this.loadedAt = Date.now();
        this.set({ funnel: value, error: undefined, lastSuccess: value.updated_at });
        clearTimeout(this.expiry);
        this.expiry = setTimeout(() => { if (current()) this.set({ funnel: undefined, error: 'Зріз застарів. Оновіть звіт.' }); }, 900_000);
      } catch (error) { if (current()) { fail(error); this.set({ funnel: undefined, error: 'Не вдалося прочитати звіт. Числа приховано; фільтри збережено.' }); } }
    };
    const status = async () => {
      try {
        const value = await fetchDto('status', reportStatusSchema);
        if (!current()) return;
        this.set({ status: value, statusError: undefined });
        if (!this.state.applied && !this.state.invalidUrl) {
          const day = utcDay(value.updated_at); const query = { from: day, to: day };
          history.replaceState(null, '', location.pathname + '?' + queryString(query));
          this.set({ applied: query });
          if (!this.state.stopped && (this.state.pausedUntil ?? 0) <= Date.now()) await funnel(query);
        }
      } catch (error) { if (current()) { fail(error); this.set({ status: undefined, statusError: 'Технічний стан недоступний.' }); } }
    };
    const filters = async () => {
      try { const value = await fetchDto('filters', filtersSchema); if (current()) this.set({ filters: value, filtersError: undefined }); }
      catch (error) { if (current()) { fail(error); this.set({ filtersError: 'Список фільтрів не оновлено. Попередні варіанти можуть бути застарілими.' }); } }
    };
    const tasks: Promise<void>[] = [status()];
    if (this.state.applied) tasks.push(funnel(this.state.applied));
    if (this.refreshFilters) { this.refreshFilters = false; tasks.push(filters()); }
    await Promise.allSettled(tasks);
    clearTimeout(timeout);
    if (current()) { this.set({ busy: false }); this.schedule(); }
  }
}
