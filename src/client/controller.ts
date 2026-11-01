import type { Question, QuizContext, QuizResult, ReadyContext } from '../shared/quiz';
import { normalizeEmail } from '../shared/email';
import { api, ApiFailure } from './api';
import { readDraft, writeDraft, clearDraft, expireDraft, type Draft } from './draft';
const uuid = () => crypto.randomUUID();
const steps: Question[] = ['preferred_gender', 'preferred_ethnicity', 'email'];
export interface Screen {
  kind: 'loading' | 'question' | 'result' | 'stopped'; question?: Question; token: number;
  ready: boolean; busy: boolean; context?: ReadyContext; result?: QuizResult; error?: string;
  warning?: string; restart?: boolean; refresh?: boolean; retry?: boolean; pausedUntil?: number;
}
export function effectiveStep(context: ReadyContext, requested: string | null): Question {
  const step = steps.includes(requested as Question) ? requested as Question : steps[0];
  if (!context.answers.preferred_gender) return steps[0];
  if (step === 'email' && !context.answers.preferred_ethnicity) return steps[1];
  return step;
}
export class QuizController {
  state: Screen = { kind: 'loading', token: 0, ready: false, busy: true };
  private listeners = new Set<() => void>();
  private started = false; private generation = 0; private context?: ReadyContext;
  private entry = { operation_id: uuid(), event_id: uuid(), preland_id: 'demo' }; private entered = false;
  private view?: { operation_id: string; event_id: string; entry_event_id: string; question_id: Question; preland_id: string };
  private viewStarted = 0; private retryAction?: () => Promise<void>; private draft?: Draft;
  private activeUrl = location.href;
  private serverClock = { time: 0, monotonic: 0 };
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private autoCycles = 0; private pauseTimer?: ReturnType<typeof setTimeout>; private oldWork = false;
  private knownUser: string | null = null;
  private contextCheck = 0;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot = () => this.state;
  private update(patch: Partial<Screen>) { this.state = { ...this.state, ...patch }; for (const fn of this.listeners) fn(); }
  private replace(state: Screen) { this.state = state; for (const fn of this.listeners) fn(); }
  start() { if (this.started) return; this.started = true; window.addEventListener('popstate', () => { void this.navigate(); });
    document.addEventListener('visibilitychange', () => { void this.checkVisibleContext(); }); void this.run(() => this.boot(false)); }
  private async checkVisibleContext() {
    const check = ++this.contextCheck;
    if (document.visibilityState !== 'visible' || !this.draft || this.draft.phase === 'done') return;
    this.expireCurrent();
    if (this.state.busy || (this.state.pausedUntil && Date.now() < this.state.pausedUntil)) return;
    const epoch = this.generation; const owner = this.draft.user; const operation = this.draft.b;
    const current = () => check === this.contextCheck && epoch === this.generation
      && this.draft?.b === operation && this.draft.phase !== 'done';
    try {
      // A background probe must not update the clock before its ownership check.
      const context = await api<QuizContext>('/context?preland_id=demo');
      if (!current()) return;
      this.requireReady(context);
      if (context.user_id !== owner) throw new ApiFailure('identity_lost', 'Профіль змінився.');
      this.acceptServerTime(context.server_time);
      this.expireCurrent(); this.scheduleExpiry();
    } catch (error) { if (current()) this.fail(error); }
  }

  private async run(action: () => Promise<void>, retry = false) {
    if (this.state.pausedUntil && Date.now() < this.state.pausedUntil) return;
    this.contextCheck++;
    if (!retry) this.autoCycles = 0;
    this.retryAction = action; this.update({ busy: true, error: undefined, retry: false, pausedUntil: undefined });
    const gen = this.generation;
    try { await action(); if (gen === this.generation) { this.autoCycles = 0; this.update({ busy: false }); } }
    catch (e) { if (gen !== this.generation) return; this.fail(e); }
  }
  private fail(error: unknown) {
    const e = error instanceof ApiFailure ? error : new ApiFailure('local', 'Локальне збереження недоступне. Дію зупинено; відновіть вручну.');
    if (e.code === 'identity_lost') {
      clearTimeout(this.pauseTimer);
      this.generation++; this.context = undefined; this.draft = undefined; this.retryAction = undefined;
      try { clearDraft(); } catch { /* Access loss must hide data even when storage is blocked. */ }
      this.replace({ kind: 'stopped', token: this.generation, busy: false, ready: false, restart: true, error: e.message }); return;
    }
    const limited = ['rate_limited', 'rate_limit_unavailable'].includes(e.code);
    const fallback = e.code === 'rate_limited' ? 60 : 30;
    const delay = limited ? (Number.isFinite(e.retryAfter) && e.retryAfter > 0 ? e.retryAfter : fallback) * 1000 * (1 + Math.random() * .1) : 0;
    const refresh = ['reference_unavailable', 'selection_not_ready', 'step_not_ready', 'operation_expired', 'operation_conflict'].includes(e.code);
    this.update({ busy: false, ready: false, error: e.message, retry: !refresh, refresh, pausedUntil: limited ? Date.now() + delay : undefined });
    if (limited) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = setTimeout(() => { this.update({ pausedUntil: undefined }); if (this.autoCycles++ < 3) this.retry(); }, delay);
    }
  }
  retry = () => { if (this.retryAction) void this.run(this.retryAction, true); };
  restart = () => { this.generation++; this.entered = false; this.entry = { operation_id: uuid(), event_id: uuid(), preland_id: 'demo' }; this.oldWork = false; this.draft = undefined;
    try { clearDraft(); sessionStorage.removeItem('unicorn.identity.user.v1'); sessionStorage.removeItem('unicorn.identity.attempt.v1'); this.knownUser = null; } catch { /* boot will fail closed */ }
    history.replaceState({}, '', location.pathname); this.activeUrl = location.href;
    void this.run(() => this.boot(true)); };
  refresh = () => {
    this.generation++;
    const entry = { operation_id: uuid(), event_id: uuid(), preland_id: 'demo' };
    let prepared = false;
    void this.run(async () => {
      const context = await this.getContext(); this.requireReady(context);
      if (this.context && context.user_id !== this.context.user_id) throw new ApiFailure('identity_lost', 'Профіль змінився.');
      this.context = context;
      if (!prepared) {
        // Resolve the old attempt before allocating the effects of this explicit action.
        if (this.draft && this.draft.phase !== 'done') {
          let existing: QuizResult | null = null;
          try { existing = await this.lookup(this.draft.b); } catch (e) { if (!(e instanceof ApiFailure && e.code === 'operation_expired')) throw e; }
          if (existing) { this.finish(existing); return; }
          if (this.draft.a) { try { await this.lookup(this.draft.a); } catch (e) { if (!(e instanceof ApiFailure && e.code === 'operation_expired')) throw e; } }
        }
        clearDraft(); this.draft = undefined;
        this.entry = entry; this.entered = false; prepared = true;
      }
      // Retry keeps this action's entry/B, even when their server result is unknown.
      if (this.draft) await this.recover();
      else if (context.next_action === 'select_offer') { await this.ensureEntry(); await this.beginBypass(); }
      else this.showQuestion();
    });
  };
  private async getContext() {
    const epoch = this.generation;
    const context = await api<QuizContext>('/context?preland_id=demo');
    if (epoch !== this.generation) return context;
    this.acceptServerTime(context.server_time); return context;
  }
  private acceptServerTime(time: number) {
    this.serverClock = { time: Math.max(time, this.estimatedTime()), monotonic: performance.now() };
  }
  private estimatedTime() { return this.serverClock.time + Math.max(0, performance.now() - this.serverClock.monotonic); }
  private expireCurrent() {
    if (!this.draft || this.draft.phase === 'done') return;
    const expired = expireDraft(this.draft, this.estimatedTime());
    if (expired.phase === 'expired') {
      this.draft = expired;
      try { writeDraft(expired); } catch { try { clearDraft(); } catch { /* never reuse the payload */ } }
      this.retryAction = () => this.recover();
      this.update({ kind: 'loading', context: undefined, ready: false, error: 'Строк надсилання минув. Доступне лише читання результату.', retry: true, refresh: true });
    }
  }
  private scheduleExpiry() {
    clearTimeout(this.expiryTimer);
    if (!this.draft || this.draft.phase === 'done') return;
    const remaining = this.draft.deadline - this.estimatedTime();
    if (remaining <= 0) { this.expireCurrent(); return; }
    this.expiryTimer = setTimeout(() => this.expireCurrent(), Math.ceil(remaining));
  }
  private requireReady(c: QuizContext): asserts c is ReadyContext { if (c.identity_status !== 'ready') throw new ApiFailure('identity_lost', 'Доступ до профілю втрачено. Відновіть його явно.'); }
  private async bootstrap(restart: boolean): Promise<ReadyContext> {
    if (!navigator.locks) throw new ApiFailure('identity_lost', 'Цей браузер не підтримує безпечне створення профілю (Web Locks).');
    try { return await navigator.locks.request('unicorn.identity', { mode: 'exclusive', signal: AbortSignal.timeout(30_000) }, async () => {
      const current = await this.getContext();
      if (current.identity_status === 'ready') return current;
      if (sessionStorage.getItem('unicorn.identity.attempt.v1') !== null
        || (!restart && (current.identity_status === 'invalid' || this.oldWork))) throw new ApiFailure('identity_lost', 'Попередній доступ втрачено. Потрібне явне відновлення.');
      // Mark before sending: a lost response must never trigger another automatic creation.
      this.oldWork = true;
      sessionStorage.setItem('unicorn.identity.attempt.v1', 'pending');
      let created: { user_id: string };
      try { created = await api<{user_id: string}>(restart ? '/identity/restart' : '/identity', undefined, {}); }
      catch (e) { if (e instanceof ApiFailure && ['rate_limited', 'rate_limit_unavailable'].includes(e.code)) {
        this.oldWork = false; sessionStorage.removeItem('unicorn.identity.attempt.v1');
      } throw e; }
      const confirmed = await this.getContext();
      if (confirmed.identity_status !== 'ready' || confirmed.user_id !== created.user_id) throw new ApiFailure('identity_lost', 'Браузер не повернув cookie. Дозвольте cookie перед відновленням.');
      sessionStorage.removeItem('unicorn.identity.attempt.v1');
      return confirmed;
    }); } catch (error) {
      if (error instanceof DOMException && ['TimeoutError', 'AbortError'].includes(error.name)) {
        throw new ApiFailure('bootstrap_lock_timeout', 'Не вдалося дочекатися доступу до створення профілю в іншій вкладці. Повторіть дію вручну.');
      }
      throw error;
    }
  }
  private async boot(restart: boolean) {
    let saved: Draft | null;
    try {
      saved = readDraft(); this.knownUser = sessionStorage.getItem('unicorn.identity.user.v1');
      this.oldWork ||= this.knownUser !== null || sessionStorage.getItem('unicorn.identity.attempt.v1') !== null;
    } catch { this.replace({ kind: 'stopped', token: this.generation, ready: false, busy: false, restart: true, error: 'Чернетка пошкоджена або сховище недоступне. Потрібне явне відновлення.' }); return; }
    this.oldWork ||= saved !== null;
    let context = await this.getContext();
    if (context.identity_status !== 'ready') context = await this.bootstrap(restart);
    this.requireReady(context);
    if (this.knownUser && this.knownUser !== context.user_id && !restart) throw new ApiFailure('identity_lost', 'Профіль у браузері змінився. Потрібне явне відновлення.');
    this.context = context; this.knownUser = context.user_id; this.oldWork = true;
    sessionStorage.setItem('unicorn.identity.user.v1', context.user_id);
    const resultPage = new URL(location.href).searchParams.get('result');
    saved = this.draft && this.draft.phase !== 'done' ? this.draft : saved;
    if (saved && (saved.phase !== 'done' || resultPage === saved.b)) {
      if (saved.user !== context.user_id) throw new ApiFailure('identity_lost', 'Чернетка належить іншому профілю.');
      this.draft = expireDraft(saved, context.server_time);
      if (this.draft.phase === 'expired') { try { writeDraft(this.draft); } catch { try { clearDraft(); } catch { /* no payload displayed */ } } }
      await this.recover(); return;
    }
    if (resultPage) { this.replace({ kind: 'stopped', token: this.generation, busy: false, ready: false, refresh: true, error: 'Немає власної чернетки цього результату. Поверніться до квізу.' }); return; }
    if (context.next_action === 'select_offer') { await this.ensureEntry(); await this.beginBypass(); } else this.showQuestion();
  }
  private async ensureEntry() { if (this.entered) return; await api<QuizResult>('/entries', this.context!.user_id, this.entry); this.entered = true; }
  private showQuestion(requested = new URL(location.href).searchParams.get('step')) {
    const question = effectiveStep(this.context!, requested); const token = ++this.generation;
    const url = new URL(location.href); url.search = ''; url.searchParams.set('step', question); history.replaceState({}, '', url); this.activeUrl = location.href;
    this.view = { operation_id: uuid(), event_id: uuid(), entry_event_id: this.entry.event_id, question_id: question, preland_id: 'demo' };
    this.replace({ kind: 'question', token, question, ready: false, busy: false, context: this.context });
  }
  // React calls only after the actual question DOM has been committed.
  rendered(token: number) {
    if (token !== this.state.token || token === this.viewStarted || !this.view) return; this.viewStarted = token;
    const view = this.view;
    void this.run(async () => { await this.ensureEntry(); if (token !== this.state.token) return;
      await api('/question-views', this.context!.user_id, view); if (token === this.state.token) this.update({ ready: true }); });
  }
  private async navigate() {
    if (this.state.busy || (!this.state.ready && (this.state.retry || this.state.refresh)) || this.draft && this.draft.phase !== 'done') { history.replaceState({}, '', this.activeUrl); return; }
    const owner = this.context?.user_id;
    if (this.state.kind === 'result') { clearDraft(); this.draft = undefined; this.entered = false; this.entry = { operation_id: uuid(), event_id: uuid(), preland_id: 'demo' }; }
    this.generation++; await this.run(async () => { const context = await this.getContext(); this.requireReady(context);
      if (context.user_id !== owner) throw new ApiFailure('identity_lost', 'Профіль змінився.');
      this.context = context;
      if (context.next_action === 'select_offer') { await this.ensureEntry(); await this.beginBypass(); } else this.showQuestion(); });
  }
  back = () => { if (this.state.question === 'email') this.go('preferred_ethnicity'); else this.go('preferred_gender'); };
  private go(question: Question) { history.pushState({}, '', '?step=' + question); this.showQuestion(question); }
  answer(value: string) {
    if (!this.state.ready || this.state.busy || !this.view || this.view.question_id === 'email') return;
    const question = this.view.question_id; const token = this.state.token;
    const owner = this.context!.user_id;
    const payload = { operation_id: uuid(), preland_id: 'demo', view_event_id: this.view.event_id, question_id: question, value };
    void this.run(async () => { await api('/answers', owner, payload); if (token !== this.state.token) return;
      const context = await this.getContext(); this.requireReady(context);
      if (context.user_id !== owner) throw new ApiFailure('identity_lost', 'Профіль змінився.');
      this.context = context;
      this.go(question === 'preferred_gender' ? 'preferred_ethnicity' : 'email'); });
  }
  confirm(email: string) {
    if (!this.state.ready || this.state.busy || !this.view || this.view.question_id !== 'email') return;
    const normalized = normalizeEmail(email); if (!normalized) { this.update({ error: 'Введіть коректну email-адресу.' }); return; }
    const view = this.view;
    void this.run(async () => { const context = await this.getContext(); this.requireReady(context);
      if (context.user_id !== this.context!.user_id) throw new ApiFailure('identity_lost', 'Профіль змінився.');
      this.draft ??= { version: 1, user: context.user_id, preland: 'demo', deadline: context.server_time + 86_400_000, phase: 'a', entry: this.entry.event_id, b: uuid(), a: uuid(), view: view.event_id, email: normalized };
      this.scheduleExpiry(); this.retryAction = () => this.recover(); writeDraft(this.draft); await this.recover(); });
  }
  private async beginBypass() {
    this.draft ??= { version: 1, user: this.context!.user_id, preland: 'demo', deadline: this.context!.server_time + 86_400_000, phase: 'b', entry: this.entry.event_id, b: uuid() };
    this.scheduleExpiry(); writeDraft(this.draft); await this.recover();
  }
  private async lookup(id: string) { try { return await api<QuizResult>('/operations/' + id, this.context!.user_id); } catch (e) { if (e instanceof ApiFailure && e.code === 'operation_not_found') return null; throw e; } }
  private async recover() {
    const epoch = this.generation;
    let draft = this.draft!;
    const context = await this.getContext(); if (epoch !== this.generation) return; this.requireReady(context);
    if (context.user_id !== draft.user) throw new ApiFailure('identity_lost', 'Профіль змінився.');
    this.context = context;
    if (this.draft?.b === draft.b && this.draft.phase === 'expired') draft = this.draft;
    this.draft = draft = expireDraft(draft, this.estimatedTime()); this.scheduleExpiry();
    if (draft.phase === 'expired') { try { writeDraft(draft); } catch { try { clearDraft(); } catch { /* no email rendered */ } } }
    this.update({ kind: 'loading', context: undefined, ready: false });
    const b = await this.lookup(draft.b); if (epoch !== this.generation) return; if (b) { this.finish(b); return; }
    let a: QuizResult | null = null; if (draft.a) a = await this.lookup(draft.a);
    if (epoch !== this.generation) return;
    this.draft = draft = expireDraft(draft, this.estimatedTime());
    if (draft.phase === 'expired') { this.expireCurrent(); throw new ApiFailure('operation_expired', 'Строк надсилання минув. Збережені ключі придатні лише для читання результату.'); }
    if (draft.a && !a) {
      if (draft.phase !== 'a' || !draft.email || !draft.view) throw new ApiFailure('operation_expired', 'Немає даних для безпечного повтору A.');
      writeDraft(draft);
      a = await api('/email-confirmations', draft.user, { operation_id: draft.a, preland_id: 'demo', view_event_id: draft.view, email: draft.email });
    }
    if (epoch !== this.generation) return;
    if (draft.a && a?.code !== 'accepted') throw new ApiFailure('operation_conflict', 'A має несумісний тип результату.');
    this.draft = draft = { ...draft, phase: 'b', email: undefined, view: undefined };
    try { writeDraft(draft); } catch (e) { try { clearDraft(); } catch { /* keep IDs in memory */ } throw e; }
    this.draft = draft = expireDraft(draft, this.estimatedTime());
    if (draft.phase === 'expired') { this.expireCurrent(); throw new ApiFailure('operation_expired', 'Строк надсилання минув.'); }
    const result = await api<QuizResult>('/offer-selections', draft.user, { operation_id: draft.b, preland_id: 'demo', entry_event_id: draft.entry, ...(draft.a ? { completion_operation_id: draft.a } : {}) });
    if (epoch === this.generation) this.finish(result);
  }
  private finish(result: QuizResult) {
    if (result.code === 'accepted') throw new ApiFailure('operation_conflict', 'B має несумісний тип результату.');
    this.draft = { ...this.draft!, phase: 'done', email: undefined, view: undefined };
    let warning: string | undefined; try { writeDraft(this.draft); } catch { warning = 'Результат отримано, але не збережено в браузері. Збережіть ClickID.'; }
    history.replaceState({}, '', '?result=' + this.draft.b); this.activeUrl = location.href; clearTimeout(this.expiryTimer);
    this.replace({ kind: 'result', token: ++this.generation, ready: true, busy: false, result, warning });
  }
  tryAgain = () => { if (this.state.result?.code !== 'no_offer' || !this.draft || this.state.busy || !this.state.ready) return;
    // Allocate once for this explicit action, outside its retry closure.
    const next = { ...this.draft, phase: 'b' as const, b: uuid() };
    this.draft = next;
    void this.run(async () => { const context = await this.getContext(); this.requireReady(context);
      if (context.user_id !== next.user) throw new ApiFailure('identity_lost', 'Профіль змінився.');
      this.context = context;
      if (this.draft === next) this.draft = { ...next, deadline: context.server_time + 86_400_000 };
      writeDraft(this.draft!); await this.recover(); }); };

}
export const quizController = new QuizController();
