// Classic UI fork: the Characters page of the Lantern layout.
//
// List mode: SillyTavern's own character list, styled as a gallery (css/classic-layout.css).
// Edit mode: SillyTavern's own editor form, framed like the design draft:
//   left   - portrait, name, quick buttons, numbered section nav, token budget
//   center - the real form, split into titled sections (Identity, First message, Who they are,
//            Alternate greetings, Details)
//   right  - live preview of the first message as it will look in the chat, plus tips.
// Every field is still SillyTavern's own input, so saving and autosave work exactly as before.
// All of this is hidden outside the Lantern layout.

const SECTIONS = Object.freeze([
    { panel: 'char-info', title: 'Identity', desc: 'Name, picture, tags and quick actions.' },
    { panel: 'greetings', title: 'First message', desc: 'How a chat begins. Alternate greetings give every chat a different start.' },
    { panel: 'definitions', title: 'Who they are', desc: 'What the model needs to know to play them well. The description matters most.' },
    { panel: 'metadata', title: 'Details', desc: 'Creator, version and notes for whoever uses the card.' },
]);

let built = false;
let previewTimer = 0;
let lastLayout = null;

function ctx() {
    try {
        return globalThis.SillyTavern?.getContext?.() ?? null;
    } catch {
        return null;
    }
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch]));
}

const $id = id => document.getElementById(id);
const panelEl = name => document.querySelector(`#form_create [data-sb-character-editor-panel="${name}"]`);

function isLantern() {
    return document.body.classList.contains('ct-layout-lanterna');
}

/* ------------------------------------------------------------------------------------------- */
/* Mode: list / edit / other                                                                     */
/* ------------------------------------------------------------------------------------------- */

function isShown(element) {
    return Boolean(element) && element.style.display !== 'none' && getComputedStyle(element).display !== 'none';
}

function syncMode() {
    const editing = isShown($id('rm_ch_create_block'));
    const listing = isShown($id('rm_characters_block'));
    document.body.classList.toggle('ct-char-edit', editing);
    document.body.classList.toggle('ct-char-list', listing && !editing);
    if (editing) {
        refreshSide();
        schedulePreview();
    }
}

/* ------------------------------------------------------------------------------------------- */
/* Building the frame                                                                            */
/* ------------------------------------------------------------------------------------------- */

function buildSectionHeads() {
    // Reading order of the Lantern editor (the classic editor shows one section at a time, so order is free there).
    let previous = null;
    for (const section of SECTIONS) {
        const panel = panelEl(section.panel);
        if (!panel) continue;
        if (previous && previous.nextElementSibling !== panel) previous.after(panel);
        previous = panel;
    }
    SECTIONS.forEach((section, i) => {
        const panel = panelEl(section.panel);
        if (!panel || panel.querySelector(':scope > .ct-sec-head')) return;
        panel.classList.add('ct-sec');
        panel.dataset.ctSection = String(i + 1);
        const head = document.createElement('div');
        head.className = 'ct-sec-head';
        head.innerHTML = `<span class="ct-sec-num" aria-hidden="true">${i + 1}</span><div><h3>${section.title}</h3><p>${section.desc}</p></div>`;
        panel.prepend(head);
    });
}

function buildSide() {
    const block = $id('rm_ch_create_block');
    if (!block || $id('ct-editor-side')) return;
    const side = document.createElement('aside');
    side.id = 'ct-editor-side';
    side.setAttribute('aria-label', 'Character overview');
    side.innerHTML = `
        <button type="button" class="ct-ed-back" data-ct-ed="list"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i>All characters</button>
        <div class="ct-ed-orb">
            <span class="ct-ed-orb-ring" aria-hidden="true"></span>
            <button type="button" class="ct-ed-orb-img" data-ct-ed="avatar" title="Change picture" aria-label="Change picture"><img alt="" src=""><span class="ct-ed-orb-edit"><i class="fa-solid fa-image" aria-hidden="true"></i>Change</span></button>
        </div>
        <div class="ct-ed-name"></div>
        <div class="ct-ed-actions">
            <button type="button" class="ct-ed-btn is-accent" data-ct-ed="chat"><i class="fa-solid fa-comment" aria-hidden="true"></i>Chat</button>
            <button type="button" class="ct-ed-btn" data-ct-ed="lore" title="Character lorebook"><i class="fa-solid fa-book-atlas" aria-hidden="true"></i>Lore</button>
        </div>
        <nav class="ct-ed-nav" aria-label="Editor sections">
            ${SECTIONS.map((section, i) => `<button type="button" class="ct-ed-nav-item" data-ct-ed="goto" data-ct-sec="${section.panel}"><span class="ct-ed-nav-num">${i + 1}</span><span class="ct-ed-nav-label">${section.title}</span><span class="ct-ed-nav-state" aria-hidden="true"></span></button>`).join('')}
        </nav>
        <div class="ct-ed-tokens">
            <div class="ct-ed-tokens-top"><b>Token budget</b><span class="ct-ed-tokens-num">–</span></div>
            <div class="ct-ed-bar" role="img" aria-label="Permanent tokens compared with the context size"><span></span></div>
            <p class="ct-ed-tokens-help">Permanent tokens are sent with every message. Fewer leaves more room for the story.</p>
        </div>`;
    block.prepend(side);

    const preview = document.createElement('aside');
    preview.id = 'ct-editor-preview';
    preview.setAttribute('aria-label', 'Preview');
    preview.innerHTML = `
        <h4 class="ct-ed-h">How it looks in the chat</h4>
        <div class="ct-ed-card ct-ed-chat">
            <div class="ct-ed-chat-head"><img alt="" src=""><b></b></div>
            <div class="ct-ed-chat-text mes_text"></div>
        </div>
        <h4 class="ct-ed-h">Tips for this character</h4>
        <div class="ct-ed-card ct-ed-tips"></div>`;
    block.append(preview);

    side.addEventListener('click', onSideClick);
}

function onSideClick(event) {
    const target = /** @type {HTMLElement} */ (event.target).closest('[data-ct-ed]');
    if (!target) return;
    const action = target.dataset.ctEd;
    if (action === 'list') $id('rm_button_characters')?.click();
    else if (action === 'avatar') $id('add_avatar_button')?.click();
    else if (action === 'chat') globalThis.HomunculusClassicHome?.showChat?.();
    else if (action === 'lore') $id('world_button')?.click();
    else if (action === 'goto') {
        const panel = panelEl(target.dataset.ctSec);
        const scroller = $id('form_create');
        if (panel && scroller) {
            scroller.scrollTo({ top: panel.offsetTop - 12, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        }
    }
}

/* First message: its own section in the Lantern editor; after the description in the classic one. */
function placeFirstMessage() {
    const layout = isLantern() ? 'lanterna' : 'classic';
    if (layout === lastLayout) return;
    lastLayout = layout;
    const firstMessage = $id('firstMessageWrapper');
    if (!firstMessage) return;
    if (layout === 'lanterna') {
        const greetings = panelEl('greetings');
        const head = greetings?.querySelector(':scope > .ct-sec-head');
        if (head) head.after(firstMessage);
    } else {
        $id('descriptionWrapper')?.after(firstMessage);
    }
}

/* ------------------------------------------------------------------------------------------- */
/* Live parts                                                                                    */
/* ------------------------------------------------------------------------------------------- */

const value = id => (/** @type {HTMLInputElement|HTMLTextAreaElement|null} */ ($id(id)))?.value ?? '';
const roughTokens = text => Math.round(String(text).length / 3.8);

function sectionStates() {
    const context = ctx();
    const character = context?.characters?.[context?.characterId];
    const alternates = character?.data?.alternate_greetings?.length ?? 0;
    return {
        'char-info': value('character_name_pole').trim() ? 'ok' : 'warn',
        greetings: value('firstmessage_textarea').trim() ? 'ok' : 'warn',
        definitions: roughTokens(value('description_textarea')) >= 60 ? 'ok' : 'warn',
        metadata: '',
        alternates,
    };
}

function refreshSide() {
    const side = $id('ct-editor-side');
    if (!side) return;
    const avatarSrc = /** @type {HTMLImageElement|null} */ ($id('avatar_load_preview'))?.getAttribute('src') ?? '';
    const name = value('character_name_pole').trim() || 'New character';
    side.querySelector('.ct-ed-orb-img img')?.setAttribute('src', avatarSrc);
    side.querySelector('.ct-ed-name').textContent = name;

    const states = sectionStates();
    for (const item of side.querySelectorAll('.ct-ed-nav-item')) {
        const state = states[item.dataset.ctSec];
        item.dataset.state = state || '';
        item.querySelector('.ct-ed-nav-state').innerHTML = state === 'ok' ? '<i class="fa-solid fa-check"></i>' : state === 'warn' ? '<i class="fa-solid fa-circle"></i>' : '';
    }

    const total = Number(($id('result_info_total_tokens')?.textContent ?? '').replace(/\D/g, ''));
    const permanent = Number(($id('result_info_permanent_tokens')?.textContent ?? '').replace(/\D/g, ''));
    const maxContext = Number(ctx()?.maxContext) || 0;
    const numEl = side.querySelector('.ct-ed-tokens-num');
    const bar = /** @type {HTMLElement|null} */ (side.querySelector('.ct-ed-bar span'));
    if (permanent || total) {
        numEl.textContent = `${(permanent || total).toLocaleString()} permanent${maxContext ? ` / ${maxContext.toLocaleString()}` : ''}`;
        const share = maxContext ? Math.min(100, ((permanent || total) / maxContext) * 100) : 0;
        if (bar) {
            bar.style.transform = `scaleX(${share / 100})`;
            bar.dataset.level = share > 50 ? 'high' : share > 25 ? 'mid' : 'low';
        }
    } else {
        numEl.textContent = '–';
        if (bar) bar.style.transform = 'scaleX(0)';
    }

    renderTips(states);
}

function renderTips(states) {
    const tips = $id('ct-editor-preview')?.querySelector('.ct-ed-tips');
    if (!tips) return;
    const descTokens = roughTokens(value('description_textarea'));
    const examples = value('mes_example_textarea').trim();
    const list = [];
    if (descTokens < 60) list.push(['warn', 'The description is very short. Appearance, history and way of speaking help a lot.']);
    else if (descTokens > 1500) list.push(['warn', `The description is long (about ${descTokens} tokens). Trimming it leaves more room for the story.`]);
    else list.push(['ok', `Description of about ${descTokens} tokens. Good size.`]);
    if (!value('firstmessage_textarea').trim()) list.push(['warn', 'No first message yet. The chat will start empty.']);
    list.push(states.alternates > 0 ? ['ok', `${states.alternates} alternate greeting${states.alternates > 1 ? 's' : ''}: chats can start differently.`] : ['warn', 'Only one greeting. An alternate one keeps new chats from feeling the same.']);
    list.push(examples ? ['ok', 'Has dialogue examples.'] : ['warn', 'No dialogue examples. Two short exchanges teach the model their voice.']);
    tips.innerHTML = list.map(([kind, text]) => `<div class="ct-ed-tip is-${kind}"><i class="fa-solid ${kind === 'ok' ? 'fa-check' : 'fa-exclamation'}" aria-hidden="true"></i><span>${escapeHtml(text)}</span></div>`).join('');
}

function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = window.setTimeout(renderPreview, 160);
}

async function renderPreview() {
    const preview = $id('ct-editor-preview');
    if (!preview || !document.body.classList.contains('ct-char-edit')) return;
    const context = ctx();
    const name = value('character_name_pole').trim() || 'Character';
    const avatarSrc = /** @type {HTMLImageElement|null} */ ($id('avatar_load_preview'))?.getAttribute('src') ?? '';
    preview.querySelector('.ct-ed-chat-head img')?.setAttribute('src', avatarSrc);
    preview.querySelector('.ct-ed-chat-head b').textContent = name;
    const textBox = preview.querySelector('.ct-ed-chat-text');
    const raw = value('firstmessage_textarea');
    if (!raw.trim()) {
        textBox.innerHTML = '<p class="ct-ed-empty">Write a first message to see it here.</p>';
        return;
    }
    try {
        const text = context?.substituteParams ? context.substituteParams(raw, context.name1, name) : raw;
        const { messageFormatting } = await import('../script.js');
        textBox.innerHTML = messageFormatting(text, name, false, false, null);
    } catch {
        textBox.textContent = raw;
    }
}

/* ------------------------------------------------------------------------------------------- */
/* Start-up                                                                                      */
/* ------------------------------------------------------------------------------------------- */

function build() {
    if (built || !$id('form_create')) return;
    built = true;
    buildSectionHeads();
    buildSide();
    placeFirstMessage();

    const observe = (id, attributes) => {
        const element = $id(id);
        if (element) new MutationObserver(syncMode).observe(element, { attributes: true, attributeFilter: attributes });
    };
    observe('rm_ch_create_block', ['style', 'class']);
    observe('rm_characters_block', ['style', 'class']);
    observe('rm_group_chats_block', ['style', 'class']);

    const avatar = $id('avatar_load_preview');
    if (avatar) new MutationObserver(() => { refreshSide(); schedulePreview(); }).observe(avatar, { attributes: true, attributeFilter: ['src'] });
    for (const id of ['result_info_total_tokens', 'result_info_permanent_tokens']) {
        const element = $id(id);
        if (element) new MutationObserver(() => refreshSide()).observe(element, { childList: true, characterData: true, subtree: true });
    }
    $id('form_create')?.addEventListener('input', () => {
        refreshSide();
        schedulePreview();
    });

    // Scroll spy: highlight the section being read.
    const scroller = $id('form_create');
    scroller?.addEventListener('scroll', () => {
        const side = $id('ct-editor-side');
        if (!side) return;
        let current = SECTIONS[0].panel;
        for (const section of SECTIONS) {
            const panel = panelEl(section.panel);
            if (panel && panel.offsetTop - scroller.scrollTop <= 140) current = section.panel;
        }
        for (const item of side.querySelectorAll('.ct-ed-nav-item')) {
            item.classList.toggle('is-current', item.dataset.ctSec === current);
        }
    }, { passive: true });

    document.addEventListener('ct:appearance-changed', () => {
        placeFirstMessage();
        syncMode();
    });
    syncMode();
}

/* In the Lantern gallery a click on a character opens its editor (Homunculus only selects it). */
function bindGalleryClicks() {
    document.addEventListener('click', (event) => {
        if (!isLantern()) return;
        const card = /** @type {HTMLElement} */ (event.target).closest?.('#rm_print_characters_block .character_select');
        if (!card) return;
        const chid = Number(card.getAttribute('data-chid'));
        const started = Date.now();
        const timer = window.setInterval(() => {
            const context = ctx();
            if (Number(context?.characterId) === chid) {
                window.clearInterval(timer);
                if (!document.body.classList.contains('ct-char-edit')) $id('rm_button_selected_ch')?.click();
            } else if (Date.now() - started > 4000) {
                window.clearInterval(timer);
            }
        }, 60);
    });
}

function bindEvents() {
    const context = ctx();
    if (!context?.eventSource || !context?.event_types) return false;
    const { eventSource, event_types } = context;
    eventSource.on(event_types.APP_READY, () => { build(); syncMode(); });
    eventSource.on(event_types.CHAT_CHANGED, () => { syncMode(); });
    eventSource.on(event_types.CHARACTER_EDITED, () => { refreshSide(); schedulePreview(); });
    return true;
}

function init() {
    build();
    bindGalleryClicks();
    if (!bindEvents()) {
        const timer = window.setInterval(() => { if (bindEvents()) window.clearInterval(timer); }, 100);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}
