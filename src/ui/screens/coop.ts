/**
 * Co-op lobby (lazy chunk: title.ts imports it on demand, and it pulls in src/net).
 *
 *   choose  → [Host a room] | [code input + Join]
 *   lobby   → room code + share/copy invite, connection status (state · tier · RTT),
 *             two seats, hero pick (only Inker playable), ready-up, host-only Start.
 *
 * Start does not launch gameplay yet (wave 2): it calls `onStart(info)` and emits `coop:start`.
 * Test hooks: the card carries data-state / data-tier / data-role; buttons have data-act.
 */

import { load, save } from '../../core/storage';
import {
  createRoom,
  HEROES,
  inviteUrl,
  joinRoom,
  type NetSession,
  normalizeRoomCode,
  PLAYABLE_HEROES,
  type PlayerInfo,
  type SessionStatus,
  type StartInfo,
} from '../../net';
import { frag, h } from '../dom';
import { ICON_SHARE } from '../icons';
import { Screen, type UIEnv } from './screen';
import './coop.css';

export interface CoopHandlers {
  /** Leave the lobby (screen is already hidden). */
  onBack(): void;
  /** Both players agreed to start (host pressed Start). */
  onStart?(info: StartInfo & { code: string; role: 'host' | 'guest' }): void;
  /** Open straight into join mode with this code (invite link). */
  joinCode?: string | null;
}

type Mode = 'choose' | 'lobby';

const ERR_KEYS: Record<string, string> = {
  full: 'coop.error.full',
  version: 'coop.error.version',
  'host-left': 'coop.error.hostLeft',
  timeout: 'coop.error.timeout',
};

export class CoopScreen extends Screen {
  private hd: CoopHandlers | null = null;
  private mode: Mode = 'choose';
  private session: NetSession | null = null;
  private offs: (() => void)[] = [];
  private codeDraft = '';
  private codeError = false;
  private starting = false;
  private langOff: (() => void) | null = null;
  private statusEl: HTMLElement | null = null;
  private lobbyEl: HTMLElement | null = null;
  /** The remembered hero (last pick, solo or co-op) is applied once per session. */
  private heroApplied = false;

  constructor(env: UIEnv) {
    super(env);
  }

  show(hd: CoopHandlers): void {
    this.hd = hd;
    this.mode = 'choose';
    this.starting = false;
    const code = normalizeRoomCode(hd.joinCode ?? null);
    this.mount();
    this.langOff = this.env.i18n.onChange(() => this.refresh());
    if (code) this.join(code);
    else this.focusFirst('.cx-btn.primary');
  }

  hide(): void {
    this.langOff?.();
    this.langOff = null;
    this.unbind();
    this.unmount();
  }

  private back(): void {
    this.leave();
    this.hide();
    this.hd?.onBack();
  }

  private leave(): void {
    this.unbind();
    this.session?.close();
    this.session = null;
  }

  private unbind(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }

  // ── actions ─────────────────────────────────────────────────────────────────────────────

  private host(): void {
    this.attach(createRoom());
  }

  private join(code: string): void {
    const c = normalizeRoomCode(code);
    if (!c) {
      this.codeError = true;
      this.refresh();
      return;
    }
    this.codeDraft = c;
    this.attach(joinRoom(c));
  }

  private attach(s: NetSession): void {
    this.leave();
    this.session = s;
    this.heroApplied = false;
    this.mode = 'lobby';
    this.codeError = false;
    this.offs.push(
      s.on('status', (st) => this.renderStatus(st)),
      s.on('roster', () => this.renderLobby()),
      s.on('state', () => this.renderLobby()),
      s.on('start', (info) => this.onStart(info)),
    );
    this.refresh();
    void s.start();
  }

  private onStart(info: StartInfo): void {
    const s = this.session!;
    this.starting = true;
    this.renderLobby();
    const role = s.role;
    this.env.bus?.emit('coop:start', {
      code: s.code,
      role,
      slot: info.slot,
      seed: info.seed,
      at: info.at,
      heroes: info.players.map((p) => p.hero),
    });
    this.hd?.onStart?.({ ...info, code: s.code, role });
  }

  private async share(): Promise<void> {
    const s = this.session;
    if (!s) return;
    const url = inviteUrl(s.code);
    const t = this.env.t;
    const data = { title: 'INKWAKE', text: t('coop.shareText', { code: s.code }), url };
    if (
      typeof navigator !== 'undefined' &&
      navigator.share &&
      (!navigator.canShare || navigator.canShare(data))
    ) {
      try {
        await navigator.share(data);
        return;
      } catch (e) {
        if ((e as DOMException)?.name === 'AbortError') return;
      }
    }
    await this.copy(url);
  }

  private async copy(text: string): Promise<void> {
    const t = this.env.t;
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // legacy fallback (older iOS / insecure origins)
      const ta = h('textarea', {
        readonly: true,
        style: 'position:fixed;opacity:0;left:-999px',
      }) as HTMLTextAreaElement;
      ta.value = text;
      document.body.append(ta);
      ta.select();
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      ta.remove();
    }
    this.env.toast(ok ? t('coop.copied') : t('coop.copyFail'), { ms: 2200 });
    if (!ok) this.el?.querySelector<HTMLInputElement>('.coop-link')?.select();
  }

  // ── rendering ───────────────────────────────────────────────────────────────────────────

  protected build(): HTMLElement {
    const t = this.env.t;
    const body = h('div', { class: 'cx-panel modal-body coop-body' });
    const card = h(
      'div',
      { class: 'modal-card coop-card', 'data-role': this.session?.role ?? '' },
      h('h2', { id: 'coop-h', class: 'cx-caption modal-head' }, t('coop.title')),
      body,
    );
    const el = h(
      'section',
      {
        class: 'ui-screen scr-modal scr-coop',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'coop-h',
      },
      h('div', { class: 'cx-scrim' }),
      card,
    );
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.back();
      }
    });
    if (this.mode === 'choose') body.append(...this.buildChoose());
    else {
      this.statusEl = h('p', { class: 'coop-status', role: 'status', 'aria-live': 'polite' });
      this.lobbyEl = h('div', { class: 'coop-lobby' });
      body.append(...this.buildRoom().filter((n): n is Node => !!n), this.statusEl, this.lobbyEl);
      // fill live parts after mount (refresh() swaps the element in)
      queueMicrotask(() => {
        this.renderLobby();
        if (this.session) this.renderStatus(this.session.status());
      });
    }
    return el;
  }

  private buildChoose(): Node[] {
    const t = this.env.t;
    const input = h('input', {
      class: 'coop-code-input',
      id: 'coop-code',
      inputmode: 'text',
      autocomplete: 'off',
      autocapitalize: 'characters',
      spellcheck: 'false',
      maxlength: '7',
      placeholder: 'ABC234',
      'aria-invalid': String(this.codeError),
      'aria-describedby': this.codeError ? 'coop-code-err' : null,
    }) as HTMLInputElement;
    input.value = this.codeDraft;
    input.addEventListener('input', () => {
      this.codeDraft = input.value.toUpperCase();
      input.value = this.codeDraft;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.join(input.value);
    });
    return [
      h('p', { class: 'coop-sub' }, t('coop.subtitle')),
      this.btn(h('button', { class: 'cx-btn primary', 'data-act': 'host' }, t('coop.host')), () =>
        this.host(),
      ),
      h(
        'div',
        { class: 'set-section coop-join' },
        h('h3', null, t('coop.joinTitle')),
        h('label', { for: 'coop-code', class: 'ui-sr' }, t('coop.codeLabel')),
        h(
          'div',
          { class: 'coop-join-row' },
          input,
          this.btn(h('button', { class: 'cx-btn', 'data-act': 'join' }, t('coop.join')), () =>
            this.join(input.value),
          ),
        ),
        this.codeError ? h('p', { class: 'coop-err', id: 'coop-code-err' }, t('coop.invalidCode')) : null,
      ),
      h(
        'div',
        { class: 'modal-foot' },
        this.btn(h('button', { class: 'cx-btn small', 'data-act': 'back' }, t('common.back')), () =>
          this.back(),
        ),
      ),
    ];
  }

  private buildRoom(): (Node | null)[] {
    const t = this.env.t;
    const s = this.session!;
    const link = h('input', {
      class: 'coop-link',
      readonly: true,
      'aria-label': t('coop.copy'),
    }) as HTMLInputElement;
    link.value = inviteUrl(s.code);
    link.addEventListener('focus', () => link.select());
    return [
      h(
        'div',
        { class: 'coop-code' },
        h('small', null, t('coop.codeLabel')),
        h('b', { class: 'cx-display', 'data-code': s.code }, s.code),
      ),
      s.role === 'host'
        ? h(
            'div',
            { class: 'coop-share' },
            this.btn(
              h(
                'button',
                { class: 'cx-btn small', 'data-act': 'share' },
                frag(ICON_SHARE),
                h('span', null, t('coop.share')),
              ),
              () => void this.share(),
            ),
            this.btn(
              h('button', { class: 'cx-btn small', 'data-act': 'copy' }, t('coop.copy')),
              () => void this.copy(link.value),
            ),
            link,
          )
        : null,
    ];
  }

  private renderStatus(st: SessionStatus): void {
    const el = this.statusEl;
    if (!el?.isConnected) return;
    const t = this.env.t;
    const card = this.el?.querySelector<HTMLElement>('.coop-card');
    if (card) {
      card.dataset.state = st.state;
      card.dataset.tier = st.tier;
    }
    let text: string;
    if (st.state === 'reconnecting') text = t('coop.state.reconnecting', { s: st.rejoinLeftS ?? 0 });
    else if (st.state === 'failed') text = t(ERR_KEYS[st.error ?? ''] ?? 'coop.error.generic');
    else if ((st.state === 'waiting' || st.state === 'connecting') && st.role === 'guest' && st.phase)
      text = t(`coop.phase.${st.phase === 'connected' || st.phase === 'failed' ? 'signaling' : st.phase}`);
    else text = t(`coop.state.${st.state}`);
    const bits: (string | Node)[] = [h('span', { class: 'coop-dot', 'data-s': st.state }), text];
    if (st.state === 'connected') {
      bits.push(h('span', { class: 'coop-tier', 'data-tier': st.tier }, t(`coop.tier.${st.tier}`)));
      if (!Number.isNaN(st.rtt))
        bits.push(h('span', { class: 'coop-rtt' }, t('coop.rtt', { ms: Math.round(st.rtt) })));
    }
    el.replaceChildren(...bits);
  }

  private renderLobby(): void {
    const box = this.lobbyEl;
    const s = this.session;
    if (!box?.isConnected || !s) return;
    const t = this.env.t;
    const me = s.me;
    if (me && !this.heroApplied) {
      this.heroApplied = true;
      const last = load<{ id: string }>('hero', { id: 'inker' }).id as PlayerInfo['hero'];
      if (last !== me.hero && PLAYABLE_HEROES.includes(last)) s.pick(last);
    }
    const seat = (slot: 0 | 1, p: PlayerInfo | undefined) =>
      h(
        'li',
        {
          class: 'coop-seat',
          'data-slot': slot,
          'data-ready': String(!!p?.ready),
          'data-on': String(!!p?.connected),
        },
        h('b', null, slot === s.slot ? t('coop.you') : t('coop.partner')),
        h('small', null, slot === 0 ? t('coop.hostTag') : t('coop.guestTag')),
        p
          ? h(
              'span',
              null,
              t(`coop.hero.${p.hero}`),
              ' · ',
              p.connected ? (p.ready ? t('coop.ready') : t('coop.notReady')) : '…',
            )
          : h('span', { class: 'coop-empty' }, t('coop.empty')),
      );
    const players = s.players;
    const failed = s.state === 'failed' || s.state === 'closed';

    const heroes = h(
      'div',
      { class: 'cx-seg coop-heroes', role: 'radiogroup', 'aria-label': t('coop.pickHero') },
      ...HEROES.map((hero) => {
        const playable = PLAYABLE_HEROES.includes(hero);
        const b = h(
          'button',
          {
            role: 'radio',
            'aria-checked': String(me?.hero === hero),
            disabled: !playable || !me,
            title: playable ? null : t('coop.soon'),
            'data-hero': hero,
          },
          h('span', null, t(`coop.hero.${hero}`)),
          playable ? null : h('small', null, t('coop.soon')),
        );
        return this.btn(b, () => {
          if (!s.pick(hero)) return;
          save('hero', { id: hero });
          this.renderLobby();
        });
      }),
    );

    const ready = me?.ready ?? false;
    const actions: Node[] = [];
    if (failed) {
      actions.push(
        this.btn(h('button', { class: 'cx-btn', 'data-act': 'retry' }, t('coop.retry')), () => {
          if (s.role === 'host') this.host();
          else this.join(s.code);
        }),
      );
    } else if (this.starting) {
      actions.push(h('p', { class: 'coop-wait' }, t('coop.starting')));
    } else {
      actions.push(
        this.btn(
          h(
            'button',
            {
              class: `cx-btn${ready ? ' ink' : ''}`,
              'data-act': 'ready',
              'aria-pressed': String(ready),
              disabled: s.state !== 'connected',
            },
            ready ? t('coop.unready') : t('coop.readyUp'),
          ),
          () => {
            s.setReady(!ready);
            this.renderLobby();
          },
        ),
      );
      if (s.role === 'host')
        actions.push(
          this.btn(
            h(
              'button',
              { class: 'cx-btn primary', 'data-act': 'start', disabled: !s.canStart() },
              t('coop.start'),
            ),
            () => {
              s.requestStart();
            },
          ),
        );
      const hint =
        s.state !== 'connected'
          ? null
          : s.role === 'guest' && ready
            ? t('coop.waitHost')
            : !players.every((p) => p.ready) || players.length < 2
              ? t('coop.waitReady')
              : null;
      if (hint) actions.push(h('p', { class: 'coop-wait' }, hint));
    }

    box.replaceChildren(
      h(
        'ul',
        { class: 'coop-seats' },
        seat(
          0,
          players.find((p) => p.slot === 0),
        ),
        seat(
          1,
          players.find((p) => p.slot === 1),
        ),
      ),
      h('div', { class: 'set-section' }, h('h3', null, t('coop.pickHero')), heroes),
      h('div', { class: 'coop-actions' }, ...actions),
      h(
        'div',
        { class: 'modal-foot' },
        this.btn(h('button', { class: 'cx-btn small', 'data-act': 'leave' }, t('coop.leave')), () =>
          this.back(),
        ),
      ),
    );
  }
}
