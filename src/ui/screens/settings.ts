/** Settings panel: every option of PLAN §3.6, persisted immediately (SettingsStore emits events). */
import type { Settings } from '../../core/types';
import { h, s } from '../dom';
import type { SettingKey } from '../settings';
import { Screen } from './screen';

export class SettingsScreen extends Screen {
  private onClose: (() => void) | null = null;
  private scrollTop = 0;

  show(onClose: () => void): void {
    this.onClose = onClose;
    this.mount();
    this.focusFirst('.modal-body button, .modal-body input');
  }

  hide(): void {
    this.unmount();
  }

  close(): void {
    this.hide();
    this.onClose?.();
  }

  override refresh(): void {
    if (!this.visible) return;
    this.scrollTop = this.el?.querySelector('.modal-body')?.scrollTop ?? 0;
    super.refresh();
    const body = this.el?.querySelector('.modal-body');
    if (body) body.scrollTop = this.scrollTop;
  }

  protected build(): HTMLElement {
    const t = this.env.t;
    const st = this.env.settings;

    const range = (key: 'master' | 'music' | 'sfx') => {
      const id = `set-${key}`;
      const val = h(
        'span',
        { class: 'range-val', 'aria-hidden': 'true' },
        String(Math.round(st.get(key) * 100)),
      );
      const input = h('input', {
        id,
        class: 'cx-range',
        type: 'range',
        min: '0',
        max: '100',
        step: '5',
        value: String(Math.round(st.get(key) * 100)),
        style: `--v:${st.get(key)}`,
      });
      input.addEventListener('input', () => {
        const v = Number(input.value) / 100;
        input.style.setProperty('--v', String(v));
        val.textContent = input.value;
        st.set(key, v);
      });
      input.addEventListener('change', () => this.env.sfx(key === 'music' ? 'ui_hover' : 'ui_click'));
      return h(
        'div',
        { class: 'set-row' },
        h('label', { for: id }, t(`settings.${key}`)),
        h('div', { class: 'range-wrap' }, input, val),
      );
    };

    const toggle = (key: 'vibration' | 'leftHanded' | 'reduceMotion' | 'misregistration') => {
      const id = `set-${key}`;
      const box = h(
        'button',
        {
          id,
          class: 'cx-check',
          role: 'switch',
          'aria-checked': String(st.get(key)),
          'aria-labelledby': `${id}-l`,
        },
        s(
          'svg',
          { viewBox: '0 0 54 52', 'aria-hidden': 'true' },
          s('path', { d: 'M8 26 L21 41 L48 4', pathLength: '1' }),
        ),
      );
      this.btn(box, () => {
        const v = !st.get(key);
        st.set(key, v as Settings[typeof key]);
        box.setAttribute('aria-checked', String(v));
        if (key === 'vibration' && v) this.env.haptic([30, 40, 30]);
      });
      return h(
        'div',
        { class: 'set-row toggle' },
        h('span', { class: 'lbl', id: `${id}-l` }, t(`settings.${key}`)),
        box,
        h('span', { class: 'hint' }, t(`settings.${key}Hint`)),
      );
    };

    const seg = <K extends SettingKey>(
      key: K,
      label: string,
      opts: [Settings[K], string][],
      hint?: () => string,
    ) => {
      const hintEl = hint ? h('span', { class: 'hint' }, hint()) : null;
      const group = h('div', { class: 'cx-seg', role: 'radiogroup', 'aria-label': label });
      const buttons = opts.map(([v, text]) => {
        const b = h('button', { role: 'radio', 'aria-checked': String(st.get(key) === v) }, text);
        if (key === 'lang') b.setAttribute('lang', String(v));
        return this.btn(b, () => {
          st.set(key, v);
          for (const o of buttons) o.setAttribute('aria-checked', String(o === b));
          if (hintEl && hint) hintEl.textContent = hint();
        });
      });
      group.append(...buttons);
      return h('div', { class: 'set-row seg' }, h('span', { class: 'lbl' }, label), group, hintEl);
    };

    const section = (title: string, ...rows: HTMLElement[]) =>
      h('fieldset', { class: 'set-section' }, h('h3', null, title), ...rows);

    const done = this.btn(h('button', { class: 'cx-btn primary' }, t('common.done')), () => this.close());

    const el = h(
      'section',
      {
        class: 'ui-screen scr-modal scr-settings',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'set-h',
      },
      h('div', { class: 'cx-scrim' }),
      h(
        'div',
        { class: 'modal-card' },
        h('h2', { id: 'set-h', class: 'cx-caption modal-head' }, t('settings.title')),
        h(
          'div',
          { class: 'cx-panel modal-body' },
          section(t('settings.sound'), range('master'), range('music'), range('sfx')),
          section(t('settings.controls'), toggle('vibration'), toggle('leftHanded')),
          section(
            t('settings.visuals'),
            toggle('reduceMotion'),
            toggle('misregistration'),
            seg('quality', t('settings.quality'), [
              ['auto', t('settings.qualityAuto')],
              ['low', t('settings.qualityLow')],
              ['high', t('settings.qualityHigh')],
            ]),
          ),
          section(
            t('settings.game'),
            seg('lang', t('settings.language'), [
              ['tr', 'Türkçe'],
              ['en', 'English'],
            ]),
            seg(
              'difficulty',
              t('settings.difficulty'),
              [
                ['story', t('settings.difficultyStory')],
                ['normal', t('settings.difficultyNormal')],
              ],
              () =>
                this.env.t(
                  st.get('difficulty') === 'story'
                    ? 'settings.difficultyStoryHint'
                    : 'settings.difficultyNormalHint',
                ),
            ),
          ),
          h('div', { class: 'modal-foot' }, done),
        ),
      ),
    );
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.close();
      }
    });
    return el;
  }
}
