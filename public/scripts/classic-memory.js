// Classic UI fork: Memory drawer (brain icon). Two tabs:
//
//  Chapters  Several summaries per chat ("chapters"). Each one covers a range of messages, can be
//            written by the AI or by hand, and can be switched on or off. The switched-on chapters
//            are added to the prompt where the user chooses: before/after the main prompt, inside the
//            chat at a chosen depth, or only where {{chapters}} is written (e.g. a "Past Events"
//            entry in the Prompt Manager). Summarized messages can be hidden from the AI.
//            Stored per chat in chat_metadata.classic_memory; settings in extension_settings.classicMemory.
//
//  Recall    A simple face for SillyTavern's Vector Storage "chat messages" memory: it finds old
//            messages that look like the current moment and adds them to the prompt. The controls
//            here drive Vector Storage's own inputs, so both screens always agree.

import { helpButton, closeHelp } from './classic-help.js';

const PROMPT_KEY = 'classic_chapters';
const META_KEY = 'classic_memory';

const DEFAULT_PROMPT = `You are the archivist of an ongoing roleplay story. Summarize the transcript below as one chapter of the story.

Rules:
- Write in past tense, third person, as a short narrative recap.
- Keep what matters later: key events, decisions, promises, secrets revealed, changes in relationships, injuries, items gained or lost, places visited and anything left unresolved.
- Keep names exactly as written. Do not invent anything that is not in the transcript.
- Aim for about {{words}} words.

Answer in this exact shape:
Title: <a short chapter title>
<the summary>`;

const DEFAULTS = Object.freeze({
    position: 'after',
    depth: 4,
    role: 'system',
    template: 'Story so far (chapter summaries):\n{{chapters}}',
    prompt: DEFAULT_PROMPT,
    profileId: '',
    words: 250,
    maxTokens: 1200,
    hideAfter: true,
    keepVisible: 6,
    autoEnabled: false,
    autoEvery: 40,
    newMode: 'since',
    lastN: 40,
});

const POSITIONS = {
    before: { label: 'Before the main prompt', type: 2 },
    after: { label: 'After the main prompt', type: 0 },
    depth: { label: 'Inside the chat, at a depth', type: 1 },
    macro: { label: 'Only where I write {{chapters}}', type: -1 },
};
const ROLES = { system: 0, user: 1, assistant: 2 };

const HELP = {
    memory: `<p><b>Chapters</b> are summaries of parts of the story. They keep the AI aware of what happened long ago, even after those messages stop fitting in its memory.</p>
<p><b>Recall</b> finds old messages that look like what is happening now and shows them to the AI again.</p>
<p>Use both together: chapters give the big picture, Recall brings back exact old details.</p>`,
    chapters: `<ul>
<li>A chapter summarizes a range of messages. Make one whenever a part of the story ends.</li>
<li>The switch on each chapter decides if the AI sees it.</li>
<li>Click a chapter to read or edit it. Your edits are kept.</li>
<li><b>Hide messages after summarizing</b> takes the old messages out of what the AI reads (they stay on screen, greyed). This saves room in the prompt; the chapter replaces them.</li>
</ul>`,
    newChapter: `<ul>
<li><b>Since the last chapter:</b> everything after the previous chapter, except the newest messages you keep visible.</li>
<li><b>Last messages:</b> the most recent messages, by count.</li>
<li><b>Custom range:</b> message numbers as shown on each message (#0 is the first).</li>
<li><b>Generate</b> asks the AI to write it. <b>Write it myself</b> opens an empty chapter.</li>
</ul>`,
    placement: `<p>Where the switched-on chapters go in the prompt:</p>
<ul>
<li><b>Before / After the main prompt:</b> with the character and system instructions.</li>
<li><b>Inside the chat, at a depth:</b> placed among the messages. Depth 0 is after the last message; depth 4 is four messages up.</li>
<li><b>Only where I write {{chapters}}:</b> nothing is added by itself. Write <code>{{chapters}}</code> in any prompt, for example a Prompt Manager entry called "Past Events", and the chapters appear there.</li>
</ul>
<p>The <b>template</b> wraps the chapters; <code>{{chapters}}</code> is replaced by them.</p>`,
    instructions: `<p>How the AI writes chapters.</p>
<ul>
<li><b>Connection:</b> which saved connection profile writes them. "Current connection" uses the one you chat with.</li>
<li><b>Length</b> is a target in words. <b>Max tokens</b> is a hard limit for the answer.</li>
<li>In the instructions, <code>{{words}}</code> is replaced by the length. The AI also gets the previous chapters for context.</li>
</ul>`,
    auto: '<p>Creates a chapter by itself when enough new messages pile up after the last chapter, using the same settings as "Since the last chapter".</p>',
    recall: `<p>Recall turns each old message into a "meaning fingerprint" (an embedding). When you send a message, it looks for old messages with similar meaning and adds the best matches to the prompt.</p>
<ul>
<li>It needs an <b>embedding source</b>. "Local (Transformers)" runs on this computer and needs nothing else.</li>
<li>It works per chat and fills itself as you chat. <b>Index this chat now</b> processes an older chat at once.</li>
</ul>`,
    recallTuning: `<ul>
<li><b>Memories to add:</b> how many old messages can come back each turn.</li>
<li><b>Search with the last:</b> how many recent messages describe "what is happening now".</li>
<li><b>Skip the newest:</b> recent messages are already in the prompt, so they are not searched.</li>
<li><b>Minimum similarity:</b> 0 to 1. Higher means only very close matches come back.</li>
<li><b>Also remember hidden messages:</b> lets Recall find messages you hid (for example after making a chapter).</li>
</ul>`,
};

// ───────────────────────── Data ─────────────────────────

const ctx = () => {
    try {
        return globalThis.SillyTavern?.getContext?.();
    } catch {
        return null;
    }
};

function settings() {
    const ext = ctx()?.extensionSettings;
    if (!ext) return { ...DEFAULTS };
    ext.classicMemory ??= {};
    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (ext.classicMemory[key] === undefined) ext.classicMemory[key] = value;
    }
    return ext.classicMemory;
}

function saveSettings() {
    ctx()?.saveSettingsDebounced?.();
}

function hasChat() {
    const context = ctx();
    return Boolean(context?.getCurrentChatId?.() ?? context?.chatId);
}

function chat() {
    return ctx()?.chat ?? [];
}

/** @returns {{ chapters: any[] }} */
function store() {
    const meta = ctx()?.chatMetadata;
    if (!meta) return { chapters: [] };
    meta[META_KEY] ??= { chapters: [] };
    if (!Array.isArray(meta[META_KEY].chapters)) meta[META_KEY].chapters = [];
    return meta[META_KEY];
}

function chapters() {
    return store().chapters.slice().sort((a, b) => (a.from - b.from) || (a.created - b.created));
}

async function saveChat() {
    const context = ctx();
    if (!context) return;
    if (typeof context.saveMetadata === 'function') await context.saveMetadata();
    else context.saveMetadataDebounced?.();
}

const estimateTokens = value => Math.ceil(String(value ?? '').length / 3.6);
const uid = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);

function chaptersText() {
    const list = chapters().filter(c => c.enabled !== false && String(c.text || '').trim());
    if (!list.length) return '';
    return list.map((c) => {
        const number = chapters().indexOf(c) + 1;
        const title = c.title ? `: ${c.title}` : '';
        return `Chapter ${number}${title}\n${String(c.text).trim()}`;
    }).join('\n\n');
}

function injectionText() {
    const body = chaptersText();
    if (!body) return '';
    const template = String(settings().template || '{{chapters}}');
    return template.includes('{{chapters}}') ? template.replaceAll('{{chapters}}', body) : `${template}\n${body}`;
}

/** Puts the switched-on chapters into the prompt (or clears them). */
function applyInjection() {
    const context = ctx();
    if (!context?.setExtensionPrompt) return;
    const s = settings();
    const text = hasChat() ? injectionText() : '';
    const position = POSITIONS[s.position] ?? POSITIONS.after;
    context.setExtensionPrompt(PROMPT_KEY, text, position.type, Number(s.depth) || 0, false, ROLES[s.role] ?? 0);
}

// ───────────────────────── Ranges ─────────────────────────

function lastIndex() {
    return chat().length - 1;
}

function nextStart() {
    const list = chapters();
    return list.length ? Math.max(...list.map(c => Number(c.to))) + 1 : 0;
}

/** The range "New chapter" would use, or null when there is nothing to summarize. */
function plannedRange() {
    const s = settings();
    const last = lastIndex();
    if (last < 0) return null;
    let from;
    let to;
    if (s.newMode === 'last') {
        to = last;
        from = Math.max(0, last - Math.max(1, Number(s.lastN) || 1) + 1);
    } else if (s.newMode === 'custom') {
        from = Math.max(0, Math.min(last, Number(state.customFrom) || 0));
        to = Math.max(from, Math.min(last, Number(state.customTo ?? last)));
    } else {
        from = nextStart();
        to = last - Math.max(0, Number(s.keepVisible) || 0);
    }
    return to >= from ? { from, to } : null;
}

// ───────────────────────── Writing chapters ─────────────────────────

function transcript(from, to) {
    const lines = [];
    for (let i = from; i <= to; i++) {
        const message = chat()[i];
        if (!message || typeof message.mes !== 'string' || !message.mes.trim()) continue;
        const name = message.name || (message.is_user ? 'User' : 'Character');
        lines.push(`[#${i}] ${name}: ${message.mes.trim()}`);
    }
    return lines.join('\n\n');
}

function stripThinking(value) {
    return String(value ?? '')
        .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
        .replace(/^[\s\S]*?<\/(think|thinking)>/i, '')
        .trim();
}

function parseAnswer(answer) {
    const textValue = stripThinking(answer);
    const match = textValue.match(/^\s*(?:\*\*)?Title(?:\*\*)?\s*:\s*(.+)\n+([\s\S]*)$/i);
    if (match) return { title: match[1].replace(/\*+/g, '').trim().slice(0, 120), text: match[2].trim() };
    return { title: '', text: textValue };
}

async function generateSummary(from, to) {
    const s = settings();
    const context = ctx();
    const body = transcript(from, to);
    if (!body) throw new Error('There are no messages with text in that range.');
    const previous = chapters().filter(c => c.enabled !== false && Number(c.to) < from && c.text).slice(-3)
        .map(c => `${c.title ? `${c.title}: ` : ''}${c.text}`).join('\n\n');
    const system = String(s.prompt || DEFAULT_PROMPT).replaceAll('{{words}}', String(Number(s.words) || 250));
    const user = `${previous ? `Previous chapters (for context only, do not repeat them):\n${previous}\n\n` : ''}Transcript, messages #${from} to #${to}:\n\n${body}`;
    const maxTokens = Math.max(200, Number(s.maxTokens) || 1200);

    let answer = '';
    if (s.profileId && context?.ConnectionManagerRequestService) {
        const result = await context.ConnectionManagerRequestService.sendRequest(s.profileId, [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ], maxTokens);
        answer = typeof result === 'string' ? result : result?.content ?? '';
    } else if (context?.generateRaw) {
        answer = await context.generateRaw({ prompt: user, systemPrompt: system, responseLength: maxTokens });
    } else {
        throw new Error('The app is not ready to generate yet.');
    }
    const parsed = parseAnswer(answer);
    if (!parsed.text) throw new Error('The AI returned an empty answer.');
    return parsed;
}

async function setHidden(from, to, hidden) {
    if (to < from) return;
    const context = ctx();
    await context?.executeSlashCommandsWithOptions?.(`/${hidden ? 'hide' : 'unhide'} ${from}-${to}`, { handleParserErrors: true, handleExecutionErrors: true, source: 'classic-memory' });
}

/** Creates a chapter. mode: 'ai' or 'manual'. */
async function createChapter(range, mode, { quiet = false } = {}) {
    if (!range || state.busy) return null;
    const s = settings();
    const chapter = { id: uid(), title: '', text: '', from: range.from, to: range.to, enabled: true, created: Date.now(), hidden: false, source: mode };
    if (mode === 'ai') {
        state.busy = `Writing a chapter for messages #${range.from}–#${range.to}...`;
        render();
        try {
            const result = await generateSummary(range.from, range.to);
            chapter.title = result.title;
            chapter.text = result.text;
        } catch (error) {
            console.error('[Memory] Chapter generation failed', error);
            toastr.error(String(error?.message ?? error), 'Could not write the chapter');
            return null;
        } finally {
            state.busy = '';
        }
    }
    store().chapters.push(chapter);
    if (mode === 'ai' && s.hideAfter) {
        const hideTo = Math.min(range.to, lastIndex() - Math.max(0, Number(s.keepVisible) || 0));
        if (hideTo >= range.from) {
            await setHidden(range.from, hideTo, true);
            chapter.hidden = true;
            chapter.hiddenTo = hideTo;
        }
    }
    await saveChat();
    applyInjection();
    state.openId = mode === 'manual' ? chapter.id : state.openId;
    render();
    if (!quiet) toastr.success(chapter.title || `Messages #${range.from}–#${range.to}`, mode === 'ai' ? 'Chapter written' : 'Chapter added');
    return chapter;
}

async function regenerate(id) {
    const chapter = store().chapters.find(c => c.id === id);
    if (!chapter || state.busy) return;
    state.busy = `Rewriting "${chapter.title || 'chapter'}"...`;
    render();
    try {
        const result = await generateSummary(chapter.from, chapter.to);
        chapter.title = result.title || chapter.title;
        chapter.text = result.text;
        chapter.source = 'ai';
        await saveChat();
        applyInjection();
    } catch (error) {
        toastr.error(String(error?.message ?? error), 'Could not rewrite the chapter');
    } finally {
        state.busy = '';
        render();
    }
}

async function removeChapter(id) {
    const list = store().chapters;
    const index = list.findIndex(c => c.id === id);
    if (index < 0) return;
    const chapter = list[index];
    const context = ctx();
    const answer = await context?.callGenericPopup?.(
        `Delete chapter "${chapter.title || `#${chapter.from}–#${chapter.to}`}"?${chapter.hidden ? '<br><small>Its messages will be shown to the AI again.</small>' : ''}`,
        context?.POPUP_TYPE?.CONFIRM ?? 2,
    );
    if (!answer) return;
    list.splice(index, 1);
    if (chapter.hidden) await setHidden(chapter.from, chapter.hiddenTo ?? chapter.to, false);
    await saveChat();
    applyInjection();
    render();
}

async function toggleHidden(id) {
    const chapter = store().chapters.find(c => c.id === id);
    if (!chapter) return;
    const to = chapter.hiddenTo ?? chapter.to;
    await setHidden(chapter.from, to, !chapter.hidden);
    chapter.hidden = !chapter.hidden;
    if (chapter.hidden) chapter.hiddenTo = to;
    await saveChat();
    render();
}

let autoRunning = false;
async function maybeAutoChapter() {
    const s = settings();
    if (!s.autoEnabled || autoRunning || state.busy || !hasChat()) return;
    const from = nextStart();
    const to = lastIndex() - Math.max(0, Number(s.keepVisible) || 0);
    if (to - from + 1 < Math.max(5, Number(s.autoEvery) || 40)) return;
    autoRunning = true;
    try {
        const chapter = await createChapter({ from, to }, 'ai', { quiet: true });
        if (chapter) toastr.info(chapter.title || `Messages #${from}–#${to}`, 'New chapter written automatically');
    } finally {
        autoRunning = false;
    }
}

// ───────────────────────── Recall (Vector Storage) ─────────────────────────

const vectors = () => ctx()?.extensionSettings?.vectors ?? null;
const vectorsLoaded = () => Boolean(document.getElementById('vectors_enabled_chats'));

/** Changes a Vector Storage setting through its own control, so its screen and ours agree. */
function setVector(id, value) {
    const control = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
    if (!control) return false;
    if (control.type === 'checkbox') control.checked = Boolean(value);
    else control.value = String(value);
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
}

function setVectorPosition(value) {
    const radio = /** @type {HTMLInputElement|null} */ (document.querySelector(`input[name="vectors_position"][value="${value}"]`));
    if (!radio) return;
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
}

function vectorSourceLabel() {
    const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('vectors_source'));
    return select?.selectedOptions?.[0]?.textContent?.trim() || vectors()?.source || 'not set';
}

function openVectorSettings() {
    /** @type {HTMLElement|null} */ (document.querySelector('#extensions-settings-button .drawer-toggle'))?.click();
    setTimeout(() => {
        const block = document.getElementById('vectors_chats_settings') ?? document.getElementById('vectors_source');
        const drawer = block?.closest('.inline-drawer');
        const toggle = drawer?.querySelector('.inline-drawer-toggle');
        if (drawer && !drawer.querySelector('.inline-drawer-content')?.checkVisibility?.()) /** @type {HTMLElement} */ (toggle)?.click();
        block?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 350);
}

// ───────────────────────── Rendering ─────────────────────────

const state = {
    tab: 'chapters',
    busy: '',
    openId: null,
    customFrom: 0,
    customTo: null,
};

/** @type {HTMLElement|null} */ let root = null;

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

function profiles() {
    const ext = ctx()?.extensionSettings?.connectionManager;
    return Array.isArray(ext?.profiles) ? ext.profiles.slice().sort((a, b) => String(a.name).localeCompare(String(b.name))) : [];
}

function sectionHead(title, helpKey, extra = '') {
    return `<div class="ct-mem-head"><h4>${title}</h4><span class="ct-mem-help" data-help="${helpKey}" data-title="${esc(title.replace(/<[^>]+>/g, ''))}"></span>${extra}</div>`;
}

function renderChaptersTab() {
    const s = settings();
    if (!hasChat()) {
        return '<div class="ct-mem-empty"><i class="fa-solid fa-comments"></i><b>Open a chat first</b><p>Chapters belong to a chat. Pick a character or a group and come back here.</p></div>';
    }
    const list = chapters();
    const injected = injectionText();
    const range = plannedRange();
    const last = lastIndex();
    const busy = Boolean(state.busy);
    const posLabel = POSITIONS[s.position]?.label ?? POSITIONS.after.label;

    const cards = list.map((c, i) => {
        const open = state.openId === c.id;
        return `<article class="ct-mem-chapter${c.enabled === false ? ' is-off' : ''}${open ? ' is-open' : ''}" data-id="${esc(c.id)}">
            <div class="ct-mem-chapter-top">
                <label class="ct-mem-switch" title="${c.enabled === false ? 'The AI does not see this chapter' : 'The AI sees this chapter'}"><input type="checkbox" data-act="enable"${c.enabled === false ? '' : ' checked'}><span></span></label>
                <button type="button" class="ct-mem-chapter-title" data-act="open">
                    <span class="ct-mem-num">Chapter ${i + 1}</span>
                    <span class="ct-mem-title">${esc(c.title || 'Untitled')}</span>
                    <span class="ct-mem-meta">Messages #${c.from}–#${c.to} · ~${estimateTokens(c.text)} tokens${c.hidden ? ' · <i class="fa-solid fa-eye-slash"></i> hidden from AI' : ''}${c.source === 'manual' ? ' · written by you' : ''}</span>
                </button>
                <i class="fa-solid fa-chevron-down ct-mem-caret"></i>
            </div>
            ${open ? `<div class="ct-mem-chapter-body">
                <input class="text_pole ct-mem-title-input" data-field="title" value="${esc(c.title)}" placeholder="Chapter title">
                <textarea class="text_pole ct-mem-text" data-field="text" rows="8" placeholder="What happened in this part of the story...">${esc(c.text)}</textarea>
                <div class="ct-mem-row ct-mem-range-edit">
                    <span>Messages</span><input class="text_pole" type="number" min="0" max="${Math.max(0, last)}" data-field="from" value="${c.from}">
                    <span>to</span><input class="text_pole" type="number" min="0" max="${Math.max(0, last)}" data-field="to" value="${c.to}">
                </div>
                <div class="ct-mem-actions">
                    <button type="button" class="menu_button" data-act="regen"${busy ? ' disabled' : ''}><i class="fa-solid fa-wand-magic-sparkles"></i>Rewrite with AI</button>
                    <button type="button" class="menu_button" data-act="hide"><i class="fa-solid fa-eye${c.hidden ? '' : '-slash'}"></i>${c.hidden ? 'Show messages to AI' : 'Hide messages from AI'}</button>
                    <button type="button" class="menu_button ct-mem-danger" data-act="delete"><i class="fa-solid fa-trash"></i>Delete</button>
                </div>
            </div>` : ''}
        </article>`;
    }).join('');

    const profileOptions = ['<option value="">Current connection</option>', ...profiles().map(p => `<option value="${esc(p.id)}"${p.id === s.profileId ? ' selected' : ''}>${esc(p.name)}</option>`)].join('');

    return `
    <div class="ct-mem-summary">
        <div><b>${list.length}</b> chapter${list.length === 1 ? '' : 's'} · <b>${list.filter(c => c.enabled !== false).length}</b> on · ~<b>${estimateTokens(injected)}</b> tokens in the prompt</div>
        <div class="ct-mem-summary-sub">${esc(posLabel)}${s.position === 'depth' ? ` (depth ${Number(s.depth) || 0})` : ''}</div>
        <button type="button" class="menu_button" data-act="preview"${injected ? '' : ' disabled'}><i class="fa-solid fa-eye"></i>Preview</button>
    </div>

    <section class="ct-mem-card">
        ${sectionHead('New chapter', 'newChapter')}
        <div class="ct-mem-modes">
            <label><input type="radio" name="ct_mem_mode" value="since"${s.newMode === 'since' ? ' checked' : ''}><span>Since the last chapter</span></label>
            <label><input type="radio" name="ct_mem_mode" value="last"${s.newMode === 'last' ? ' checked' : ''}><span>Last <input class="text_pole ct-mem-inline" type="number" min="1" max="9999" data-setting="lastN" value="${Number(s.lastN) || 40}"> messages</span></label>
            <label><input type="radio" name="ct_mem_mode" value="custom"${s.newMode === 'custom' ? ' checked' : ''}><span>From #<input class="text_pole ct-mem-inline" type="number" min="0" data-custom="from" value="${Number(state.customFrom) || 0}"> to #<input class="text_pole ct-mem-inline" type="number" min="0" data-custom="to" value="${state.customTo ?? Math.max(0, last)}"></span></label>
        </div>
        <div class="ct-mem-range">${range ? `Will cover messages <b>#${range.from}</b> to <b>#${range.to}</b> (${range.to - range.from + 1} messages).` : last < 0 ? 'This chat has no messages yet.' : 'Nothing new to summarize yet.'}</div>
        <label class="checkbox_label ct-mem-check"><input type="checkbox" data-setting="hideAfter"${s.hideAfter ? ' checked' : ''}><span>Hide summarized messages from the AI, keeping the last <input class="text_pole ct-mem-inline" type="number" min="0" max="200" data-setting="keepVisible" value="${Number(s.keepVisible) || 0}"> visible</span></label>
        <div class="ct-mem-actions">
            <button type="button" class="menu_button ct-mem-primary" data-act="generate"${range && !busy ? '' : ' disabled'}><i class="fa-solid fa-wand-magic-sparkles"></i>Generate chapter</button>
            <button type="button" class="menu_button" data-act="manual"${range && !busy ? '' : ' disabled'}><i class="fa-solid fa-pen"></i>Write it myself</button>
        </div>
        ${busy ? `<div class="ct-mem-busy"><i class="fa-solid fa-spinner fa-spin"></i>${esc(state.busy)}</div>` : ''}
    </section>

    <section class="ct-mem-list">${cards || '<div class="ct-mem-empty small"><i class="fa-solid fa-book-open"></i><p>No chapters yet. When a part of the story ends, make one above.</p></div>'}</section>

    <details class="ct-mem-card ct-mem-fold">
        <summary>${sectionHead('Automatic chapters', 'auto', `<span class="ct-mem-pill">${s.autoEnabled ? 'On' : 'Off'}</span>`)}</summary>
        <label class="checkbox_label ct-mem-check"><input type="checkbox" data-setting="autoEnabled"${s.autoEnabled ? ' checked' : ''}><span>Write a chapter by itself every <input class="text_pole ct-mem-inline" type="number" min="5" max="1000" data-setting="autoEvery" value="${Number(s.autoEvery) || 40}"> new messages</span></label>
    </details>

    <details class="ct-mem-card ct-mem-fold">
        <summary>${sectionHead('Where chapters go in the prompt', 'placement')}</summary>
        <div class="ct-mem-modes">
            ${Object.entries(POSITIONS).map(([key, p]) => `<label><input type="radio" name="ct_mem_pos" value="${key}"${s.position === key ? ' checked' : ''}><span>${esc(p.label)}</span></label>`).join('')}
        </div>
        <div class="ct-mem-row${s.position === 'depth' ? '' : ' is-disabled'}">
            <span>Depth</span><input class="text_pole ct-mem-inline" type="number" min="0" max="1000" data-setting="depth" value="${Number(s.depth) || 0}">
            <span>as</span><select class="text_pole ct-mem-inline-select" data-setting="role">
                ${Object.keys(ROLES).map(r => `<option value="${r}"${s.role === r ? ' selected' : ''}>${r}</option>`).join('')}
            </select>
        </div>
        <label class="ct-mem-label">Template <small>({{chapters}} is replaced by the chapters)</small></label>
        <textarea class="text_pole" rows="3" data-setting="template">${esc(s.template)}</textarea>
    </details>

    <details class="ct-mem-card ct-mem-fold">
        <summary>${sectionHead('How the AI writes chapters', 'instructions')}</summary>
        <div class="ct-mem-grid2">
            <label class="ct-mem-label">Connection<select class="text_pole" data-setting="profileId">${profileOptions}</select></label>
            <label class="ct-mem-label">Length (words)<input class="text_pole" type="number" min="30" max="3000" data-setting="words" value="${Number(s.words) || 250}"></label>
            <label class="ct-mem-label">Max tokens<input class="text_pole" type="number" min="200" max="32000" data-setting="maxTokens" value="${Number(s.maxTokens) || 1200}"></label>
        </div>
        <label class="ct-mem-label">Instructions <button type="button" class="ct-mem-link" data-act="reset-prompt">Reset to default</button></label>
        <textarea class="text_pole" rows="10" data-setting="prompt">${esc(s.prompt)}</textarea>
    </details>`;
}

function renderRecallTab() {
    if (!vectorsLoaded() || !vectors()) {
        return '<div class="ct-mem-empty"><i class="fa-solid fa-plug-circle-xmark"></i><b>Vector Storage is turned off</b><p>Recall uses the Vector Storage extension. Turn it on in <b>Extensions &rarr; Manage extensions</b>, then reload.</p></div>';
    }
    const v = vectors();
    const on = Boolean(v.enabled_chats);
    const pos = Number(v.position);
    return `
    <div class="ct-mem-summary">
        <div class="ct-mem-big-switch">
            <label class="ct-mem-switch"><input type="checkbox" data-vector="vectors_enabled_chats"${on ? ' checked' : ''}><span></span></label>
            <div><b>Recall older messages</b><div class="ct-mem-summary-sub">${on ? 'On for all chats' : 'Off'} · Embedding source: ${esc(vectorSourceLabel())}</div></div>
        </div>
        <button type="button" class="menu_button" data-act="vector-settings"><i class="fa-solid fa-gear"></i>Advanced</button>
    </div>

    <section class="ct-mem-card${on ? '' : ' is-dim'}">
        ${sectionHead('How much to recall', 'recallTuning')}
        <div class="ct-mem-grid2">
            <label class="ct-mem-label">Memories to add<input class="text_pole" type="number" min="1" max="50" data-vector="vectors_insert" value="${Number(v.insert) || 3}"></label>
            <label class="ct-mem-label">Search with the last … messages<input class="text_pole" type="number" min="1" max="50" data-vector="vectors_query" value="${Number(v.query) || 2}"></label>
            <label class="ct-mem-label">Skip the newest … messages<input class="text_pole" type="number" min="1" max="9999" data-vector="vectors_protect" value="${Number(v.protect) || 5}"></label>
            <label class="ct-mem-label">Minimum similarity (0–1)<input class="text_pole" type="number" min="0" max="1" step="0.05" data-vector="vectors_score_threshold" value="${Number(v.score_threshold ?? 0.25)}"></label>
        </div>
        <label class="checkbox_label ct-mem-check"><input type="checkbox" data-vector="vectors_keep_hidden"${v.keep_hidden ? ' checked' : ''}><span>Also remember hidden messages (for example the ones a chapter hid)</span></label>
    </section>

    <section class="ct-mem-card${on ? '' : ' is-dim'}">
        ${sectionHead('Where memories go in the prompt', 'placement')}
        <div class="ct-mem-modes">
            <label><input type="radio" name="ct_vec_pos" value="2"${pos === 2 ? ' checked' : ''}><span>Before the main prompt</span></label>
            <label><input type="radio" name="ct_vec_pos" value="0"${pos === 0 ? ' checked' : ''}><span>After the main prompt</span></label>
            <label><input type="radio" name="ct_vec_pos" value="1"${pos === 1 ? ' checked' : ''}><span>Inside the chat, at depth <input class="text_pole ct-mem-inline" type="number" min="0" max="9999" data-vector="vectors_depth" value="${Number(v.depth) || 0}"></span></label>
        </div>
        <label class="ct-mem-label">Template <small>({{text}} is replaced by the recalled messages)</small></label>
        <textarea class="text_pole" rows="2" data-vector="vectors_template">${esc(v.template)}</textarea>
    </section>

    <section class="ct-mem-card">
        ${sectionHead('This chat', 'recall')}
        <div class="ct-mem-actions">
            <button type="button" class="menu_button" data-act="vectorize"${hasChat() ? '' : ' disabled'}><i class="fa-solid fa-layer-group"></i>Index this chat now</button>
            <button type="button" class="menu_button ct-mem-danger" data-act="purge"${hasChat() ? '' : ' disabled'}><i class="fa-solid fa-eraser"></i>Forget this chat's memories</button>
        </div>
    </section>`;
}

function render() {
    if (!root) return;
    closeHelp();
    const scroller = root.closest('.drawer-content') ?? root;
    const scroll = scroller.scrollTop;
    const focused = /** @type {HTMLElement|null} */ (document.activeElement && root.contains(document.activeElement) ? document.activeElement : null);
    const focusKey = focused ? (focused.dataset.setting || focused.dataset.vector || focused.dataset.field || focused.dataset.custom || '') : '';
    const openFolds = [...root.querySelectorAll('details.ct-mem-fold')].map(d => d.open);

    const context = ctx();
    const chatName = hasChat() ? (context?.groupId ? context?.groups?.find(g => g.id === context.groupId)?.name : context?.name2) || 'This chat' : '';
    root.innerHTML = `
        <div class="ct-mem-header">
            <div class="ct-mem-heading"><i class="fa-solid fa-brain"></i><h3>Memory</h3><span class="ct-mem-help" data-help="memory" data-title="Memory"></span></div>
            <div class="ct-mem-chat">${chatName ? `<i class="fa-solid fa-comment"></i>${esc(chatName)}` : ''}</div>
        </div>
        <div class="ct-mem-tabs" role="tablist">
            <button type="button" role="tab" class="${state.tab === 'chapters' ? 'is-active' : ''}" data-tab="chapters"><i class="fa-solid fa-book"></i>Chapters</button>
            <button type="button" role="tab" class="${state.tab === 'recall' ? 'is-active' : ''}" data-tab="recall"><i class="fa-solid fa-magnifying-glass"></i>Recall</button>
        </div>
        <div class="ct-mem-body">${state.tab === 'recall' ? renderRecallTab() : renderChaptersTab()}</div>`;

    for (const slot of root.querySelectorAll('.ct-mem-help')) {
        const key = slot.getAttribute('data-help');
        slot.replaceWith(helpButton(slot.getAttribute('data-title') || 'Memory', HELP[key] ?? ''));
    }
    root.querySelectorAll('details.ct-mem-fold').forEach((d, i) => { if (openFolds[i]) d.open = true; });
    scroller.scrollTop = scroll;
    if (focusKey) {
        const again = /** @type {HTMLInputElement|null} */ (root.querySelector(`[data-setting="${focusKey}"], [data-vector="${focusKey}"], [data-custom="${focusKey}"], .is-open [data-field="${focusKey}"]`));
        again?.focus();
    }
}

function onInput(event) {
    const target = /** @type {HTMLInputElement} */ (event.target);
    const s = settings();
    if (target.dataset.setting) {
        const key = target.dataset.setting;
        s[key] = target.type === 'checkbox' ? target.checked : target.type === 'number' ? Number(target.value) : target.value;
        saveSettings();
        applyInjection();
        if (event.type === 'change' || target.type === 'checkbox') render();
        else updateLiveBits();
        return;
    }
    if (target.dataset.custom) {
        state[target.dataset.custom === 'from' ? 'customFrom' : 'customTo'] = Number(target.value);
        updateLiveBits();
        return;
    }
    if (target.dataset.vector) {
        setVector(target.dataset.vector, target.type === 'checkbox' ? target.checked : target.value);
        if (target.type === 'checkbox') render();
        return;
    }
    if (target.dataset.field) {
        const id = target.closest('[data-id]')?.getAttribute('data-id');
        const chapter = store().chapters.find(c => c.id === id);
        if (!chapter) return;
        const field = target.dataset.field;
        if (field === 'from' || field === 'to') chapter[field] = Math.max(0, Number(target.value) || 0);
        else chapter[field] = target.value;
        if (field === 'text' && chapter.source === 'ai') chapter.source = 'edited';
        ctx()?.saveMetadataDebounced?.();
        applyInjection();
        if (event.type === 'change') render();
        return;
    }
    if (target.name === 'ct_mem_mode') {
        s.newMode = target.value;
        saveSettings();
        render();
    } else if (target.name === 'ct_mem_pos') {
        s.position = target.value;
        saveSettings();
        applyInjection();
        render();
    } else if (target.name === 'ct_vec_pos') {
        setVectorPosition(target.value);
    }
}

/** Updates the small texts that depend on numbers being typed, without redrawing the inputs. */
function updateLiveBits() {
    const range = plannedRange();
    const box = root?.querySelector('.ct-mem-range');
    if (box) box.innerHTML = range ? `Will cover messages <b>#${range.from}</b> to <b>#${range.to}</b> (${range.to - range.from + 1} messages).` : 'Nothing new to summarize yet.';
    for (const act of ['generate', 'manual']) {
        const button = /** @type {HTMLButtonElement|null} */ (root?.querySelector(`[data-act="${act}"]`));
        if (button) button.disabled = !range || Boolean(state.busy);
    }
}

async function onClick(event) {
    const target = /** @type {HTMLElement} */ (event.target);
    const tab = target.closest('[data-tab]');
    if (tab) {
        state.tab = tab.getAttribute('data-tab');
        render();
        return;
    }
    const actor = target.closest('[data-act]');
    if (!actor || actor.matches('input')) return;
    const act = actor.getAttribute('data-act');
    const id = actor.closest('[data-id]')?.getAttribute('data-id');
    switch (act) {
        case 'open':
            state.openId = state.openId === id ? null : id;
            render();
            break;
        case 'generate':
            await createChapter(plannedRange(), 'ai');
            break;
        case 'manual':
            await createChapter(plannedRange(), 'manual');
            break;
        case 'regen':
            await regenerate(id);
            break;
        case 'hide':
            await toggleHidden(id);
            break;
        case 'delete':
            await removeChapter(id);
            break;
        case 'preview': {
            const context = ctx();
            const box = document.createElement('div');
            box.className = 'ct-mem-preview';
            const head = document.createElement('h3');
            head.textContent = `What the AI receives (~${estimateTokens(injectionText())} tokens)`;
            const pre = document.createElement('pre');
            pre.textContent = injectionText();
            box.append(head, pre);
            await context?.callGenericPopup?.(box, context?.POPUP_TYPE?.TEXT ?? 1, '', { wide: true, large: true, allowVerticalScrolling: true });
            break;
        }
        case 'reset-prompt':
            settings().prompt = DEFAULT_PROMPT;
            saveSettings();
            render();
            break;
        case 'vector-settings':
            openVectorSettings();
            break;
        case 'vectorize':
            /** @type {HTMLElement|null} */ (document.getElementById('vectors_vectorize_all'))?.click();
            break;
        case 'purge':
            /** @type {HTMLElement|null} */ (document.getElementById('vectors_purge'))?.click();
            break;
    }
}

function onToggle(event) {
    const target = /** @type {HTMLInputElement} */ (event.target);
    if (target.dataset.act !== 'enable') return;
    const id = target.closest('[data-id]')?.getAttribute('data-id');
    const chapter = store().chapters.find(c => c.id === id);
    if (!chapter) return;
    chapter.enabled = target.checked;
    void saveChat();
    applyInjection();
    render();
}

// ───────────────────────── Setup ─────────────────────────

function registerMacro() {
    const context = ctx();
    const handler = () => (hasChat() ? chaptersText() : '');
    try {
        context?.registerMacro?.('chapters', handler, 'Classic UI Memory: the switched-on chapter summaries of this chat.');
    } catch (error) {
        console.warn('[Memory] Could not register {{chapters}} (legacy macros)', error);
    }
    try {
        context?.macros?.register?.('chapters', {
            handler,
            description: 'Classic UI Memory: the switched-on chapter summaries of this chat.',
            returns: 'Chapter summaries',
            exampleUsage: '{{chapters}}',
        });
    } catch { /* already registered or engine not available */ }
}

function mount() {
    const holder = document.getElementById('ct_memory');
    if (!holder || root) return;
    root = holder;
    root.classList.add('ct-mem');
    root.addEventListener('click', event => void onClick(event));
    root.addEventListener('input', onInput);
    root.addEventListener('change', (event) => {
        const target = /** @type {HTMLInputElement} */ (event.target);
        if (target.dataset.act === 'enable') return onToggle(event);
        if (target.type === 'radio' || target.tagName === 'SELECT' || target.dataset.field || target.type === 'number') onInput(event);
    });
    render();
}

function init() {
    mount();
    const wait = window.setInterval(() => {
        const context = ctx();
        if (!context?.eventSource || !context?.event_types) return;
        window.clearInterval(wait);
        const { eventSource, event_types } = context;
        eventSource.on(event_types.APP_READY, () => {
            mount();
            settings();
            registerMacro();
            applyInjection();
            render();
        });
        eventSource.on(event_types.CHAT_CHANGED, () => {
            state.openId = null;
            state.customFrom = 0;
            state.customTo = null;
            applyInjection();
            render();
        });
        const refresh = () => {
            if (root?.closest('.drawer-content')?.classList.contains('openDrawer') && !root.contains(document.activeElement)) render();
        };
        for (const type of [event_types.MESSAGE_RECEIVED, event_types.MESSAGE_SENT, event_types.MESSAGE_DELETED]) {
            if (type) eventSource.on(type, refresh);
        }
        if (event_types.MESSAGE_RECEIVED) eventSource.on(event_types.MESSAGE_RECEIVED, () => setTimeout(() => void maybeAutoChapter(), 500));
        if (event_types.GENERATION_STARTED) eventSource.on(event_types.GENERATION_STARTED, applyInjection);
        // Re-read the drawer whenever it is opened.
        document.querySelector('#ct-memory-button .drawer-toggle')?.addEventListener('click', () => setTimeout(render, 30));
    }, 100);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}

globalThis.SillyBunnyClassicMemory = {
    open() {
        const toggle = /** @type {HTMLElement|null} */ (document.querySelector('#ct-memory-button .drawer-toggle'));
        const content = document.getElementById('ct_memory_block');
        if (toggle && !content?.classList.contains('openDrawer')) toggle.click();
    },
    chaptersText,
    applyInjection,
};
