// Classic UI fork: the Scene panel.
//
// A side panel that stays open beside the chat and shows what the two Scene trackers see: who is
// in the scene and how they look (the "Scene: Characters" agent, a [CAST] JSON block) and the world
// state (the "Scene: World" agent, a [WORLD] JSON block). Both are ordinary In-Chat Agents made from
// bundled templates, so their prompt, connection profile and history are edited in the agent editor,
// and they are switched on per group in the Group Studio (Scene tab) or in the Agents drawer.
//
// The panel reads the latest finished result of each tracker from the chat (results are saved per
// message and swipe by the companion runner), lets the user edit it (the edit is written back into
// that result, so the next update starts from it), and sends a compact copy to the AI before each
// reply (present characters in full, absent ones as one line, the world as short lines).

import {
    eventSource,
    event_types,
    chat,
    characters,
    name1,
    default_avatar,
    getThumbnailUrl,
    getCurrentChatId,
    saveSettingsDebounced,
    setExtensionPrompt,
    extension_prompt_types,
} from '../script.js';
import { extension_settings } from './extensions.js';
import { selected_group } from './group-chats.js';
import { user_avatar, getUserAvatar } from './personas.js';
import { helpButton, closeHelp } from './classic-help.js';

export const SCENE_TEMPLATES = Object.freeze({
    world: 'tpl-homunculus-scene-world',
    cast: 'tpl-homunculus-scene-characters',
});
const TAGS = Object.freeze({ world: 'WORLD', cast: 'CAST' });
const PROMPT_KEY = 'homunculus_scene';
const APPEARANCE = Object.freeze([
    ['face', 'Face'],
    ['hair', 'Hair'],
    ['eyes', 'Eyes'],
    ['body', 'Body'],
    ['outfit', 'Outfit'],
    ['accessories', 'Accessories'],
    ['marks', 'Marks'],
]);
const CHARACTER_KEYS = new Set(['name', 'present', 'role', 'mood', 'appearance', 'notes']);
const WORLD_KEYS = new Set(['time', 'location', 'weather', 'quests', 'inventory', 'factions']);
const QUEST_STATES = Object.freeze(['active', 'completed', 'failed']);

const HELP = {
    panel: `<p>What is happening in the story right now, kept up to date by two <b>Scene trackers</b>.</p>
<ul>
<li><b>Scene: Characters</b> tracks who is in the scene and how they look.</li>
<li><b>Scene: World</b> tracks time, place, weather, quests, items and anything else its prompt asks for.</li>
</ul>
<p>Both are In-Chat Agents: after each reply they make their own AI call. Change their prompt or connection profile in the agent editor (the sliders button here, or Group Studio → Scene).</p>
<p>Everything is saved in the message it came from, so swipes, deleting and branches keep the right scene. You can edit anything here; the next update starts from your edit.</p>`,
    cast: `<ul>
<li><b>In scene</b>: characters present right now. The AI gets their whole description.</li>
<li><b>Not here</b>: characters met before who left. The AI only gets one line, so it remembers they exist.</li>
</ul>
<p>Each card shows everything the tracker knows; the arrow folds it to one line. Click the name to open the full sheet (with <b>Edit</b> at the bottom).</p>
<p>A dot marks what changed in the last update.</p>
<p>A new NPC is only added when they have a proper name and actually did or said something.</p>`,
    appearance: '<p>How the character looks right now. The tracker updates it when the story changes it (new clothes, a wound, a lost weapon) and leaves a part empty when the story never said it.</p>',
    quests: '<p>Tasks and goals from the story. The tracker adds one when a task is clearly given or taken on, and marks it completed or failed when the story resolves it.</p>',
    items: '<p>Notable things the player carries. The tracker adds items that are clearly taken, bought or given, and removes the ones lost or used up.</p>',
    world: `<p>The rest of the world state. Any field the World tracker's prompt asks for shows here.</p>
<p>To add your own field (for example "Corruption"), add it to the tracker's prompt in the agent editor.</p>`,
    send: `<p>When this is on, a short copy of the scene goes to the AI before each reply: present characters in full, absent ones as one line, and the world as short lines.</p>
<p>Turn it off to keep the panel just for you.</p>`,
};

// ───────────────────────── Data ─────────────────────────

function settings() {
    const st = extension_settings.homunculusScene && typeof extension_settings.homunculusScene === 'object'
        ? extension_settings.homunculusScene
        : (extension_settings.homunculusScene = {});
    if (typeof st.open !== 'boolean') st.open = true;
    if (typeof st.inject !== 'boolean') st.inject = true;
    if (typeof st.tab !== 'string') st.tab = 'cast';
    if (typeof st.filter !== 'string') st.filter = 'all';
    if (typeof st.questFilter !== 'string') st.questFilter = 'active';
    if (!st.collapsed || typeof st.collapsed !== 'object') st.collapsed = {};
    // Character cards opened or closed by hand (by name). Without an entry: open when in scene.
    if (!st.cards || typeof st.cards !== 'object') st.cards = {};
    return st;
}

const agentsApi = () => globalThis.HomunculusAgents ?? null;
const str = value => (value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value));

/** Saved agents made from the Scene template of this kind ('world' or 'cast'). */
export function sceneAgents(kind) {
    const api = agentsApi();
    if (!api?.getAgents) return [];
    return api.getAgents().filter(agent => String(agent?.sourceTemplateId ?? '') === SCENE_TEMPLATES[kind]);
}

/** The tracker of this kind that runs in the open chat, or null. */
export function enabledAgent(kind) {
    const api = agentsApi();
    return sceneAgents(kind).find(agent => api?.isAgentEnabledForCurrentScope?.(agent)) ?? null;
}

function stripFence(text) {
    return String(text ?? '').replace(/```(?:json)?/gi, '').trim();
}

/** The JSON object inside a tracker answer ([TAG]{...}[/TAG], or just {...}). */
export function parseBlock(kind, content) {
    const text = String(content ?? '');
    const tag = TAGS[kind];
    const match = text.match(new RegExp(`\\[${tag}\\]([\\s\\S]*?)(?:\\[\\/${tag}\\]|$)`, 'i'));
    const inner = stripFence(match ? match[1] : text);
    const start = inner.indexOf('{');
    const end = inner.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
        const data = JSON.parse(inner.slice(start, end + 1));
        return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch {
        return null;
    }
}

export function formatBlock(kind, data) {
    return `[${TAGS[kind]}]\n${JSON.stringify(data, null, 1)}\n[/${TAGS[kind]}]`;
}

/**
 * The latest finished result of a tracker kind in the open chat.
 * @param {'world'|'cast'} kind
 * @param {{ skip?: number }} [options] skip: how many newer results to pass over (1 = the one before)
 */
export function findResult(kind, { skip = 0 } = {}) {
    const api = agentsApi();
    if (!api?.getCompanionResults) return null;
    const ids = new Set(sceneAgents(kind).map(agent => agent.id));
    if (!ids.size) return null;
    let skipped = 0;
    for (let index = chat.length - 1; index >= 0; index--) {
        const results = api.getCompanionResults(chat[index]);
        for (const [agentId, result] of Object.entries(results)) {
            if (!ids.has(agentId) || result?.status !== 'done') continue;
            const data = parseBlock(kind, result.content);
            if (!data) continue;
            if (skipped++ < skip) break;
            return { messageIndex: index, agentId, data };
        }
    }
    return null;
}

function isPending(kind) {
    const api = agentsApi();
    const ids = new Set(sceneAgents(kind).map(agent => agent.id));
    for (let index = chat.length - 1; index >= Math.max(0, chat.length - 3); index--) {
        const results = api?.getCompanionResults?.(chat[index]) ?? {};
        if (Object.entries(results).some(([agentId, result]) => ids.has(agentId) && result?.status === 'pending')) return true;
    }
    return false;
}

const characterList = data => (Array.isArray(data?.characters) ? data.characters.filter(item => item && typeof item === 'object') : []);
const isPresent = character => character.present !== false && character.present !== 'false';
const isPlayer = character => str(character.role).toLowerCase() === 'player' || (name1 && str(character.name).trim().toLowerCase() === String(name1).toLowerCase());
const keyOf = name => str(name).trim().toLowerCase();

/** Whether the panel has anything to show in the open chat. */
export function isAvailable() {
    if (!getCurrentChatId?.()) return false;
    return Boolean(enabledAgent('world') || enabledAgent('cast') || findResult('world') || findResult('cast'));
}

// ───────────────────────── Prompt ─────────────────────────

function oneLine(value) {
    if (Array.isArray(value)) return value.map(item => (item && typeof item === 'object' ? Object.values(item).map(str).filter(Boolean).join(' ') : str(item))).filter(Boolean).join(', ');
    if (value && typeof value === 'object') return Object.entries(value).filter(([, v]) => str(v).trim()).map(([k, v]) => `${k}: ${str(v)}`).join('; ');
    return str(value).replace(/\s+/g, ' ').trim();
}

function castPrompt(data) {
    const here = [];
    const away = [];
    for (const character of characterList(data)) {
        const name = str(character.name).trim();
        if (!name) continue;
        const tags = [str(character.role).trim(), str(character.mood).trim()].filter(Boolean).join(', ');
        if (!isPresent(character)) {
            away.push(tags ? `${name} (${tags})` : name);
            continue;
        }
        const look = APPEARANCE.map(([key, label]) => [label, str(character.appearance?.[key]).trim()]).filter(([, v]) => v).map(([label, v]) => `${label}: ${v}`);
        const lines = [`- ${name}${tags ? ` (${tags})` : ''}`];
        if (look.length) lines.push(`  ${look.join('; ')}`);
        if (str(character.notes).trim()) lines.push(`  Notes: ${str(character.notes).trim()}`);
        here.push(lines.join('\n'));
    }
    const parts = [];
    if (here.length) parts.push(`In this scene:\n${here.join('\n')}`);
    if (away.length) parts.push(`Known, not in this scene: ${away.join('; ')}`);
    return parts.join('\n');
}

function worldPrompt(data) {
    const lines = [];
    const head = [['Time', data.time], ['Location', data.location], ['Weather', data.weather]].filter(([, v]) => str(v).trim()).map(([k, v]) => `${k}: ${str(v).trim()}`);
    if (head.length) lines.push(head.join(' · '));
    const quests = (Array.isArray(data.quests) ? data.quests : []).filter(q => q && str(q.title).trim() && str(q.status || 'active').toLowerCase() === 'active');
    if (quests.length) lines.push(`Active quests: ${quests.map(q => (str(q.note).trim() ? `${str(q.title).trim()} (${str(q.note).trim()})` : str(q.title).trim())).join('; ')}`);
    const items = oneLine(Array.isArray(data.inventory) ? data.inventory.filter(Boolean) : []);
    if (items) lines.push(`Carrying: ${items}`);
    const factions = (Array.isArray(data.factions) ? data.factions : []).filter(f => f && str(f.name).trim());
    if (factions.length) lines.push(`Factions: ${factions.map(f => (str(f.standing).trim() ? `${str(f.name).trim()} (${str(f.standing).trim()})` : str(f.name).trim())).join('; ')}`);
    for (const [key, value] of Object.entries(data)) {
        if (WORLD_KEYS.has(key)) continue;
        const text = oneLine(value);
        if (text) lines.push(`${humanize(key)}: ${text}`);
    }
    return lines.join('\n');
}

function feedbackOn(agent) {
    return Boolean(agent?.companion?.feedback?.enabled);
}

/** The scene text sent before each reply (empty when nothing should be sent). */
export function scenePrompt() {
    if (!settings().inject || !getCurrentChatId?.()) return '';
    const parts = [];
    const worldAgent = enabledAgent('world');
    if (worldAgent && !feedbackOn(worldAgent)) {
        const text = worldPrompt(findResult('world')?.data ?? {});
        if (text) parts.push(text);
    }
    const castAgent = enabledAgent('cast');
    if (castAgent && !feedbackOn(castAgent)) {
        const text = castPrompt(findResult('cast')?.data ?? {});
        if (text) parts.push(text);
    }
    return parts.length ? `[Current scene, for continuity. Do not repeat it back.]\n${parts.join('\n')}` : '';
}

function applyPrompt() {
    setExtensionPrompt(PROMPT_KEY, scenePrompt(), extension_prompt_types.IN_PROMPT, 0, false);
}

// ───────────────────────── Writing edits back ─────────────────────────

async function saveData(kind, mutate) {
    const latest = findResult(kind);
    const api = agentsApi();
    if (!latest || !api?.setCompanionResultContent) {
        toastr.warning('There is no tracker result to edit yet. Press "Update now" first.');
        return false;
    }
    const next = structuredClone(latest.data);
    if (mutate(next) === false) return false;
    const ok = await api.setCompanionResultContent(latest.messageIndex, latest.agentId, formatBlock(kind, next));
    if (!ok) toastr.error('Could not save the change.');
    return ok;
}

// ───────────────────────── Helpers ─────────────────────────

function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function button(className, html, title, onClick) {
    const node = el('button', className);
    node.type = 'button';
    node.innerHTML = html;
    if (title) {
        node.title = title;
        node.setAttribute('aria-label', title);
    }
    node.addEventListener('click', onClick);
    return node;
}

function humanize(key) {
    const text = String(key).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function hue(text) {
    let hash = 0;
    for (const ch of String(text)) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
    return hash;
}

function avatarFor(character, className = 'ct-sc-avatar') {
    const name = str(character?.name).trim();
    let src = '';
    if (character && isPlayer(character) && user_avatar) {
        src = getThumbnailUrl('persona', user_avatar);
    } else if (name) {
        const card = characters.find(c => keyOf(c?.name) === keyOf(name));
        if (card?.avatar) src = getThumbnailUrl('avatar', card.avatar);
    }
    if (src) {
        const img = el('img', className);
        img.alt = '';
        img.loading = 'lazy';
        img.src = src;
        img.addEventListener('error', () => {
            img.src = default_avatar;
        }, { once: true });
        return img;
    }
    const initial = el('span', `${className} ct-sc-initial`, (name.charAt(0) || '?').toUpperCase());
    initial.style.setProperty('--ct-sc-hue', String(hue(name)));
    initial.setAttribute('aria-hidden', 'true');
    return initial;
}

/** Big picture for the character sheet: the full card/persona image, falling back to the small one. */
function portraitFor(character) {
    const name = str(character?.name).trim();
    let full = '';
    if (character && isPlayer(character) && user_avatar) {
        full = getUserAvatar(user_avatar);
    } else if (name) {
        const card = characters.find(c => keyOf(c?.name) === keyOf(name));
        if (card?.avatar) full = `characters/${encodeURIComponent(card.avatar)}`;
    }
    if (!full) return avatarFor(character, 'ct-sc-portrait');
    const img = el('img', 'ct-sc-portrait');
    img.alt = '';
    img.src = full;
    img.addEventListener('error', () => img.replaceWith(avatarFor(character, 'ct-sc-portrait')), { once: true });
    return img;
}

function chip(label, count, isOn, onClick) {
    const b = button(`ct-sc-filter${isOn ? ' is-on' : ''}`, '', '', onClick);
    b.append(el('span', '', label));
    if (count !== null) b.append(el('span', 'ct-sc-filter-count', String(count)));
    b.setAttribute('aria-pressed', String(isOn));
    return b;
}

function autoGrow(area) {
    const fit = () => {
        area.style.height = 'auto';
        area.style.height = `${Math.min(area.scrollHeight + 2, 320)}px`;
    };
    area.addEventListener('input', fit);
    requestAnimationFrame(fit);
}

function textField(label, value, { multiline = false, placeholder = '', id = '' } = {}) {
    const wrap = el('label', 'ct-sc-field');
    wrap.append(el('span', 'ct-sc-field-label', label));
    const control = el(multiline ? 'textarea' : 'input', 'text_pole');
    if (!multiline) control.type = 'text';
    else control.rows = 1;
    if (id) control.id = id;
    control.value = value;
    control.placeholder = placeholder;
    wrap.append(control);
    if (multiline) autoGrow(control);
    return { wrap, control };
}

// ───────────────────────── State ─────────────────────────

const view = {
    search: '',
    /** null, or { type: 'character' | 'quest', key, draft, isNew } */
    peek: null,
    narrowOpen: false,
    busy: false,
};
let root = null;
let strip = null;
let renderQueued = false;
const narrowQuery = window.matchMedia('(max-width: 999px)');

function isWide() {
    return !narrowQuery.matches;
}

export function isOpen() {
    return isWide() ? settings().open : view.narrowOpen;
}

export function toggle(force) {
    const next = typeof force === 'boolean' ? force : !isOpen();
    if (isWide()) {
        settings().open = next;
        saveSettingsDebounced();
    } else {
        view.narrowOpen = next;
    }
    render();
    globalThis.HomunculusGroupProfile?.refreshBar?.();
}

function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
        renderQueued = false;
        render();
    });
}

// ───────────────────────── Rendering ─────────────────────────

function build() {
    root = el('aside', 'ct-scene');
    root.id = 'ct-scene';
    root.setAttribute('aria-label', 'Scene');
    strip = button('ct-scene-strip', '', 'Open the Scene panel', () => toggle(true));
    strip.id = 'ct-scene-strip';
    document.body.append(root, strip);
}

function renderHeader(status) {
    const head = el('header', 'ct-sc-head');
    const titles = el('div', 'ct-sc-titles');
    const titleRow = el('div', 'ct-sc-title-row');
    titleRow.append(el('h2', 'ct-sc-title', 'Scene'), helpButton('Scene', HELP.panel));
    titles.append(titleRow, el('div', 'ct-sc-status', status));
    const actions = el('div', 'ct-sc-actions');
    const update = button('ct-sc-icon', `<i class="fa-solid fa-rotate${view.busy ? ' fa-spin' : ''}"></i>`, 'Update now: run the Scene trackers on the last message', () => void updateNow());
    update.disabled = view.busy || !(enabledAgent('world') || enabledAgent('cast'));
    const st = settings();
    const send = button(`ct-sc-icon${st.inject ? ' is-on' : ''}`, '<i class="fa-solid fa-paper-plane"></i>', st.inject ? 'Sending the scene to the AI (click to stop)' : 'Not sending the scene to the AI (click to send)', () => {
        st.inject = !st.inject;
        saveSettingsDebounced();
        applyPrompt();
        render();
    });
    send.setAttribute('aria-pressed', String(st.inject));
    const setup = button('ct-sc-icon', '<i class="fa-solid fa-sliders"></i>', selected_group ? 'Set up the trackers (Group Studio → Scene)' : 'Edit the trackers (agent editor)', openSetup);
    const close = button('ct-sc-icon', `<i class="fa-solid ${isWide() ? 'fa-angles-right' : 'fa-xmark'}"></i>`, 'Hide the Scene panel', () => toggle(false));
    actions.append(update, send, helpButton('Send to the AI', HELP.send), setup, close);
    head.append(titles, actions);
    return head;
}

function renderWorldStrip(world) {
    const row = el('div', 'ct-sc-world');
    const items = [
        ['fa-clock', 'Time', world?.time],
        ['fa-location-dot', 'Location', world?.location],
        ['fa-cloud-sun', 'Weather', world?.weather],
    ].filter(([, , value]) => str(value).trim());
    for (const [icon, label, value] of items) {
        const item = el('div', 'ct-sc-world-item');
        item.title = label;
        item.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i>`;
        item.append(el('span', 'ct-sc-sr', `${label}: `), el('span', 'ct-sc-world-text', str(value).trim()));
        row.append(item);
    }
    return items.length ? row : null;
}

function renderTabs(tabs, active) {
    const nav = el('div', 'ct-sc-tabs');
    nav.setAttribute('role', 'tablist');
    for (const tab of tabs) {
        const b = button(`ct-sc-tab${tab.id === active ? ' is-on' : ''}`, '', '', () => {
            settings().tab = tab.id;
            saveSettingsDebounced();
            view.peek = null;
            render();
        });
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', String(tab.id === active));
        b.append(el('span', '', tab.label));
        if (tab.count) b.append(el('span', 'ct-sc-tab-count', String(tab.count)));
        nav.append(b);
    }
    return nav;
}

function renderCast(body, cast, previous) {
    const st = settings();
    const list = characterList(cast);
    const before = new Map(characterList(previous).map(character => [keyOf(character.name), JSON.stringify(character)]));
    const changed = character => Boolean(previous) && before.get(keyOf(character.name)) !== JSON.stringify(character);

    const toolbar = el('div', 'ct-sc-toolbar');
    const search = el('input', 'text_pole ct-sc-search');
    search.type = 'search';
    search.id = 'ct-sc-search';
    search.placeholder = 'Search characters…';
    search.value = view.search;
    search.setAttribute('aria-label', 'Search characters');
    search.addEventListener('input', () => {
        view.search = search.value;
        render();
    });
    const here = list.filter(isPresent);
    const away = list.filter(character => !isPresent(character));
    const filters = el('div', 'ct-sc-filters');
    filters.setAttribute('role', 'group');
    filters.setAttribute('aria-label', 'Show');
    for (const [id, label, count] of [['all', 'All', list.length], ['here', 'In scene', here.length], ['away', 'Not here', away.length]]) {
        filters.append(chip(label, count, st.filter === id, () => {
            st.filter = id;
            saveSettingsDebounced();
            render();
        }));
    }
    const titleRow = el('div', 'ct-sc-section-head');
    titleRow.append(el('span', 'ct-sc-kicker', 'Characters'), helpButton('Characters', HELP.cast));
    if (list.length) {
        const anyOpen = list.some(isCardOpen);
        titleRow.append(el('span', 'ct-sc-grow', ''), button('ct-sc-link', anyOpen
            ? '<i class="fa-solid fa-angles-up" aria-hidden="true"></i> Fold all'
            : '<i class="fa-solid fa-angles-down" aria-hidden="true"></i> Show all', anyOpen ? 'Fold every card to one line' : 'Show the details of every card', () => {
            for (const character of list) st.cards[keyOf(character.name)] = !anyOpen;
            saveSettingsDebounced();
            render();
        }));
    }
    toolbar.append(titleRow, search, filters);
    body.append(toolbar);

    const term = view.search.trim().toLowerCase();
    const matches = character => !term || [character.name, character.role, character.mood, character.notes, ...Object.values(character.appearance && typeof character.appearance === 'object' ? character.appearance : {})]
        .map(str).join(' ').toLowerCase().includes(term);
    const groupsToShow = [
        ['here', 'In scene', here],
        ['away', 'Not here', away],
    ].filter(([id]) => st.filter === 'all' || st.filter === id);

    let shown = 0;
    for (const [id, label, items] of groupsToShow) {
        const visible = items.filter(matches);
        if (!visible.length && st.filter === 'all') continue;
        const collapsed = Boolean(st.collapsed[id]);
        const section = el('section', 'ct-sc-group');
        const head = button(`ct-sc-group-head${collapsed ? ' is-collapsed' : ''}`, '', '', () => {
            st.collapsed[id] = !collapsed;
            saveSettingsDebounced();
            render();
        });
        head.setAttribute('aria-expanded', String(!collapsed));
        head.innerHTML = '<i class="fa-solid fa-chevron-down" aria-hidden="true"></i>';
        head.append(el('span', '', label), el('span', 'ct-sc-group-count', String(visible.length)));
        section.append(head);
        if (!collapsed) {
            const rows = el('div', 'ct-sc-rows');
            for (const character of visible) rows.append(characterCard(character, changed(character) ? previousOf(previous, character) : null, changed(character)));
            if (!visible.length) rows.append(el('p', 'ct-sc-empty-line', term ? 'No one matches.' : 'No one.'));
            section.append(rows);
        }
        body.append(section);
        shown += visible.length;
    }
    if (!list.length) body.append(el('p', 'ct-sc-empty-line', 'No characters yet. They appear after the Characters tracker runs.'));
    else if (!shown && term) body.append(el('p', 'ct-sc-empty-line', 'No one matches.'));

    body.append(button('ct-sc-add', '<i class="fa-solid fa-plus"></i> Add a character', '', () => openPeek('character', '', true)));
}

function previousOf(previous, character) {
    return characterList(previous).find(item => keyOf(item.name) === keyOf(character.name)) ?? {};
}

function isCardOpen(character) {
    const saved = settings().cards[keyOf(character.name)];
    return typeof saved === 'boolean' ? saved : isPresent(character);
}

/** The fields that differ from the previous update (empty when there is no previous update). */
function changedFields(character, before) {
    const out = new Set();
    if (!before) return out;
    for (const key of ['role', 'mood', 'notes', 'present']) {
        if (str(character[key]).trim() !== str(before[key]).trim()) out.add(key);
    }
    const now = character.appearance && typeof character.appearance === 'object' ? character.appearance : {};
    const then = before.appearance && typeof before.appearance === 'object' ? before.appearance : {};
    for (const key of new Set([...Object.keys(now), ...Object.keys(then)])) {
        if (str(now[key]).trim() !== str(then[key]).trim()) out.add(`look.${key}`);
    }
    return out;
}

/**
 * Everything the tracker knows about a character, as label/value lines.
 * @param {object} character
 * @param {Set<string>} changes from changedFields()
 * @param {{ full?: boolean }} options full = the character sheet (sections, unknown parts listed)
 */
function characterDetails(character, changes, { full = false } = {}) {
    const box = el('div', `ct-sc-details${full ? ' is-full' : ''}`);
    const fact = (list, label, value, changed) => {
        const row = el('div', `ct-sc-fact${changed ? ' is-changed' : ''}`);
        const dt = el('dt', '', label);
        if (changed) {
            dt.append(el('span', 'ct-sc-dot', ''));
            row.title = 'Changed in the last update';
        }
        row.append(dt, el('dd', '', value));
        list.append(row);
    };
    const section = (title, help) => {
        if (!full) return box;
        const head = el('div', 'ct-sc-section-head');
        head.append(el('span', 'ct-sc-kicker', title));
        if (help) head.append(helpButton(title, help));
        box.append(head);
        return box;
    };

    const about = el('dl', 'ct-sc-facts');
    if (full && str(character.role).trim()) fact(about, 'Role', str(character.role).trim(), changes.has('role'));
    if (str(character.mood).trim()) fact(about, 'Mood', str(character.mood).trim(), changes.has('mood'));
    for (const key of Object.keys(character).filter(k => !CHARACTER_KEYS.has(k))) {
        const value = character[key];
        if (value === null || typeof value === 'object' || !str(value).trim()) continue;
        fact(about, humanize(key), str(value).trim(), false);
    }
    if (about.childElementCount) {
        section('About');
        box.append(about);
    }

    const look = character.appearance && typeof character.appearance === 'object' ? character.appearance : {};
    const extraLook = Object.keys(look).filter(key => !APPEARANCE.some(([k]) => k === key));
    const lookFields = [...APPEARANCE, ...extraLook.map(key => [key, humanize(key)])];
    const known = lookFields.filter(([key]) => str(look[key]).trim());
    const unknown = lookFields.filter(([key]) => !str(look[key]).trim() && APPEARANCE.some(([k]) => k === key));
    if (known.length || full) {
        section('Appearance', HELP.appearance);
        const list = el('dl', 'ct-sc-facts');
        for (const [key, label] of known) fact(list, label, str(look[key]).trim(), changes.has(`look.${key}`));
        if (known.length) box.append(list);
        if (full && unknown.length) box.append(el('p', 'ct-sc-unknown', `Not known yet: ${unknown.map(([, label]) => label.toLowerCase()).join(', ')}.`));
    }

    const notes = str(character.notes).trim();
    if (notes) {
        section('Notes');
        const note = el('p', `ct-sc-notes${changes.has('notes') ? ' is-changed' : ''}`, notes);
        if (changes.has('notes')) note.title = 'Changed in the last update';
        box.append(note);
    }
    if (!box.childElementCount) box.append(el('p', 'ct-sc-unknown', 'Nothing known yet.'));
    return box;
}

function characterCard(character, before, changed) {
    const present = isPresent(character);
    const key = keyOf(character.name);
    const name = str(character.name).trim() || 'Unnamed';
    const open = isCardOpen(character);
    const card = el('article', `ct-sc-card${present ? ' is-here' : ''}${changed ? ' is-changed' : ''}${open ? ' is-open' : ''}`);

    const head = el('div', 'ct-sc-card-head');
    const main = button('ct-sc-card-main', '', `Open ${name}`, () => openPeek('character', key));
    main.append(avatarFor(character));
    const text = el('span', 'ct-sc-row-text');
    const nameLine = el('span', 'ct-sc-row-name');
    nameLine.append(el('span', 'ct-sc-row-name-text', name));
    if (isPlayer(character)) nameLine.append(el('span', 'ct-sc-you', 'YOU'));
    if (changed) nameLine.append(el('span', 'ct-sc-dot', ''));
    text.append(nameLine);
    const role = str(character.role).trim();
    const sub = open ? role : [role, str(character.mood).trim()].filter(Boolean).join(' · ');
    if (sub) text.append(el('span', 'ct-sc-row-sub', sub));
    const outfit = str(character.appearance?.outfit).trim();
    if (!open && present && outfit) text.append(el('span', 'ct-sc-row-sub ct-sc-row-outfit', outfit));
    main.append(text);
    main.setAttribute('aria-label', `Open ${name}: ${present ? 'in scene' : 'not here'}${changed ? ', changed in the last update' : ''}`);

    const fold = button('ct-sc-card-fold', '<i class="fa-solid fa-chevron-down" aria-hidden="true"></i>', open ? 'Fold to one line' : 'Show details', () => {
        settings().cards[key] = !open;
        saveSettingsDebounced();
        render();
    });
    fold.setAttribute('aria-expanded', String(open));
    head.append(main, el('span', `ct-sc-pill${present ? ' is-here' : ''}`, present ? 'Here' : 'Away'), fold);
    card.append(head);
    if (open) card.append(characterDetails(character, changedFields(character, before)));
    return card;
}

function renderQuests(body, world) {
    const st = settings();
    const quests = (Array.isArray(world?.quests) ? world.quests : []).map((quest, index) => ({ quest: quest && typeof quest === 'object' ? quest : { title: str(quest) }, index }));
    const status = q => (QUEST_STATES.includes(str(q.status).toLowerCase()) ? str(q.status).toLowerCase() : 'active');
    const head = el('div', 'ct-sc-toolbar');
    const titleRow = el('div', 'ct-sc-section-head');
    titleRow.append(el('span', 'ct-sc-kicker', 'Quests'), helpButton('Quests', HELP.quests));
    const active = quests.filter(({ quest }) => status(quest) === 'active');
    const filters = el('div', 'ct-sc-filters');
    for (const [id, label, count] of [['active', 'Active', active.length], ['done', 'Done', quests.length - active.length], ['all', 'All', quests.length]]) {
        filters.append(chip(label, count, st.questFilter === id, () => {
            st.questFilter = id;
            saveSettingsDebounced();
            render();
        }));
    }
    head.append(titleRow, filters);
    body.append(head);
    const visible = quests.filter(({ quest }) => st.questFilter === 'all' || (st.questFilter === 'active') === (status(quest) === 'active'));
    const list = el('div', 'ct-sc-rows');
    for (const { quest, index } of visible) {
        const s = status(quest);
        const card = button(`ct-sc-quest is-${s}`, '', '', () => openPeek('quest', String(index)));
        const top = el('span', 'ct-sc-quest-top');
        top.append(el('span', 'ct-sc-quest-title', str(quest.title).trim() || 'Untitled quest'), el('span', `ct-sc-pill is-${s}`, s === 'active' ? 'Active' : s === 'completed' ? 'Done' : 'Failed'));
        card.append(top);
        if (str(quest.note).trim()) card.append(el('span', 'ct-sc-row-sub', str(quest.note).trim()));
        list.append(card);
    }
    if (!visible.length) list.append(el('p', 'ct-sc-empty-line', quests.length ? 'Nothing here.' : 'No quests yet.'));
    body.append(list, button('ct-sc-add', '<i class="fa-solid fa-plus"></i> Add a quest', '', () => openPeek('quest', '', true)));
}

function itemLabel(item) {
    if (item && typeof item === 'object') {
        const name = str(item.name ?? item.item ?? item.title).trim();
        const qty = str(item.qty ?? item.quantity ?? item.count).trim();
        return name ? (qty && qty !== '1' ? `${name} ×${qty}` : name) : oneLine(item);
    }
    return str(item).trim();
}

function renderItems(body, world) {
    const items = (Array.isArray(world?.inventory) ? world.inventory : []).map((item, index) => ({ item, index })).filter(({ item }) => itemLabel(item));
    const head = el('div', 'ct-sc-section-head');
    head.append(el('span', 'ct-sc-kicker', 'Carrying'), helpButton('Items', HELP.items));
    body.append(head);
    const list = el('ul', 'ct-sc-items');
    for (const { item, index } of items) {
        const li = el('li', 'ct-sc-item');
        li.append(el('i', 'fa-solid fa-cube'), el('span', 'ct-sc-item-text', itemLabel(item)));
        li.firstElementChild.setAttribute('aria-hidden', 'true');
        li.append(button('ct-sc-x', '<i class="fa-solid fa-xmark"></i>', `Remove ${itemLabel(item)}`, () => void saveData('world', (data) => {
            data.inventory = (Array.isArray(data.inventory) ? data.inventory : []).filter((_, i) => i !== index);
        })));
        list.append(li);
    }
    if (!items.length) body.append(el('p', 'ct-sc-empty-line', 'Nothing carried yet.'));
    body.append(list);
    const add = el('form', 'ct-sc-add-row');
    const input = el('input', 'text_pole');
    input.type = 'text';
    input.placeholder = 'Add an item…';
    input.setAttribute('aria-label', 'Add an item');
    add.append(input, button('menu_button ct-sc-add-btn', 'Add', '', () => add.requestSubmit()));
    add.addEventListener('submit', (event) => {
        event.preventDefault();
        const name = input.value.trim();
        if (!name) return;
        void saveData('world', (data) => {
            data.inventory = [...(Array.isArray(data.inventory) ? data.inventory : []), name];
        });
    });
    body.append(add);
}

function renderWorld(body, world) {
    const head = el('div', 'ct-sc-section-head');
    head.append(el('span', 'ct-sc-kicker', 'World'), helpButton('World', HELP.world));
    body.append(head);
    const form = el('div', 'ct-sc-form');
    for (const [key, label] of [['time', 'Time'], ['location', 'Location'], ['weather', 'Weather']]) {
        const { wrap, control } = textField(label, str(world?.[key]), { id: `ct-sc-world-${key}` });
        control.addEventListener('change', () => void saveData('world', (data) => {
            data[key] = control.value.trim();
        }));
        form.append(wrap);
    }
    body.append(form);

    const factions = (Array.isArray(world?.factions) ? world.factions : []).filter(f => f && typeof f === 'object');
    const fHead = el('div', 'ct-sc-section-head');
    fHead.append(el('span', 'ct-sc-kicker', 'Factions'));
    body.append(fHead);
    const fList = el('div', 'ct-sc-rows');
    factions.forEach((faction, index) => {
        const row = el('div', 'ct-sc-faction');
        const name = el('input', 'text_pole');
        name.value = str(faction.name);
        name.setAttribute('aria-label', 'Faction name');
        const standing = el('input', 'text_pole');
        standing.value = str(faction.standing);
        standing.placeholder = 'Standing';
        standing.setAttribute('aria-label', `How ${str(faction.name) || 'this faction'} stands with you`);
        const commit = () => void saveData('world', (data) => {
            const list = Array.isArray(data.factions) ? data.factions : [];
            const target = list.filter(f => f && typeof f === 'object')[index];
            if (!target) return false;
            target.name = name.value.trim();
            target.standing = standing.value.trim();
        });
        name.addEventListener('change', commit);
        standing.addEventListener('change', commit);
        row.append(name, standing, button('ct-sc-x', '<i class="fa-solid fa-xmark"></i>', `Remove ${str(faction.name)}`, () => void saveData('world', (data) => {
            const target = (Array.isArray(data.factions) ? data.factions : []).filter(f => f && typeof f === 'object')[index];
            data.factions = (data.factions ?? []).filter(f => f !== target);
        })));
        fList.append(row);
    });
    if (!factions.length) fList.append(el('p', 'ct-sc-empty-line', 'No factions yet.'));
    body.append(fList, button('ct-sc-add', '<i class="fa-solid fa-plus"></i> Add a faction', '', () => void saveData('world', (data) => {
        data.factions = [...(Array.isArray(data.factions) ? data.factions : []), { name: 'New faction', standing: '' }];
    })));

    const extra = Object.entries(world ?? {}).filter(([key]) => !WORLD_KEYS.has(key));
    if (!extra.length) return;
    const xHead = el('div', 'ct-sc-section-head');
    xHead.append(el('span', 'ct-sc-kicker', 'More'));
    body.append(xHead);
    const xForm = el('div', 'ct-sc-form');
    for (const [key, value] of extra) {
        const simple = value === null || ['string', 'number', 'boolean'].includes(typeof value);
        const lines = Array.isArray(value) && value.every(v => typeof v === 'string');
        const { wrap, control } = textField(humanize(key), simple ? str(value) : lines ? value.join('\n') : JSON.stringify(value, null, 1), { multiline: !simple });
        if (lines) wrap.append(el('span', 'ct-sc-hint', 'One per line'));
        control.addEventListener('change', () => void saveData('world', (data) => {
            if (simple) {
                data[key] = typeof value === 'number' && control.value.trim() !== '' && Number.isFinite(Number(control.value)) ? Number(control.value) : control.value.trim();
                return;
            }
            if (lines) {
                data[key] = control.value.split('\n').map(line => line.trim()).filter(Boolean);
                return;
            }
            try {
                data[key] = JSON.parse(control.value);
            } catch {
                toastr.warning(`"${humanize(key)}" is not valid JSON, so it was not saved.`);
                return false;
            }
        }));
        xForm.append(wrap);
    }
    body.append(xForm);
}

function renderEmpty(body) {
    const box = el('div', 'ct-sc-empty');
    box.innerHTML = '<i class="fa-solid fa-masks-theater" aria-hidden="true"></i>';
    const anyOn = enabledAgent('world') || enabledAgent('cast');
    box.append(el('p', 'ct-sc-empty-title', anyOn ? 'Nothing tracked yet' : 'The Scene trackers are off here'));
    box.append(el('p', 'ct-sc-empty-text', anyOn
        ? 'The trackers run after the next reply. You can also run them now on the last message.'
        : 'Switch on "Scene: World" and "Scene: Characters" for this chat to fill this panel.'));
    if (anyOn) {
        const go = button('menu_button ct-sc-empty-btn', '<i class="fa-solid fa-rotate"></i> Update now', '', () => void updateNow());
        go.disabled = view.busy;
        box.append(go);
    } else {
        box.append(button('menu_button ct-sc-empty-btn', '<i class="fa-solid fa-sliders"></i> Set up', '', openSetup));
    }
    body.append(box);
}

// ───────────────────────── Peek drawer ─────────────────────────

function openPeek(type, key, isNew = false) {
    let draft;
    if (type === 'character') {
        const found = isNew ? null : characterList(findResult('cast')?.data).find(character => keyOf(character.name) === key);
        if (!isNew && !found) return;
        draft = structuredClone(found ?? { name: '', present: true, role: '', mood: '', appearance: {}, notes: '' });
        if (!draft.appearance || typeof draft.appearance !== 'object') draft.appearance = {};
        view.peek = { type, key, draft, isNew, mode: isNew ? 'edit' : 'view' };
        render();
        if (isNew) requestAnimationFrame(() => root?.querySelector('.ct-sc-peek input, .ct-sc-peek textarea')?.focus());
        else requestAnimationFrame(() => root?.querySelector('.ct-sc-peek .ct-sc-peek-edit')?.focus());
        return;
    } else {
        const quests = Array.isArray(findResult('world')?.data?.quests) ? findResult('world').data.quests : [];
        const found = isNew ? null : quests[Number(key)];
        if (!isNew && found === undefined) return;
        draft = found && typeof found === 'object' ? structuredClone(found) : { title: str(found), status: 'active', note: '' };
    }
    view.peek = { type, key, draft, isNew, mode: 'edit' };
    render();
    requestAnimationFrame(() => root?.querySelector('.ct-sc-peek input, .ct-sc-peek textarea')?.focus());
}

function closePeek() {
    view.peek = null;
    render();
}

/** Character sheet → edit form (a fresh copy of the saved character). */
function editPeek() {
    const peek = view.peek;
    const found = characterList(findResult('cast')?.data).find(character => keyOf(character.name) === peek?.key);
    if (!peek || !found) return;
    peek.draft = structuredClone(found);
    if (!peek.draft.appearance || typeof peek.draft.appearance !== 'object') peek.draft.appearance = {};
    peek.mode = 'edit';
    render();
    requestAnimationFrame(() => root?.querySelector('.ct-sc-peek input, .ct-sc-peek textarea')?.focus());
}

/** Cancel in the edit form: back to the sheet for a saved character, back to the list otherwise. */
function cancelPeek() {
    const peek = view.peek;
    if (peek?.type === 'character' && !peek.isNew && peek.mode === 'edit') {
        peek.mode = 'view';
        render();
        return;
    }
    closePeek();
}

async function savePeek() {
    const peek = view.peek;
    if (!peek) return;
    if (peek.type === 'character') {
        const draft = peek.draft;
        if (!str(draft.name).trim()) {
            toastr.warning('Give the character a name.');
            return;
        }
        draft.name = str(draft.name).trim();
        const ok = await saveData('cast', (data) => {
            const list = Array.isArray(data.characters) ? data.characters : (data.characters = []);
            const clash = list.findIndex(character => keyOf(character?.name) === keyOf(draft.name));
            if (peek.isNew) {
                if (clash !== -1) {
                    toastr.warning(`${draft.name} is already in the list.`);
                    return false;
                }
                list.push(draft);
                return;
            }
            const index = list.findIndex(character => keyOf(character?.name) === peek.key);
            if (index === -1) return false;
            if (clash !== -1 && clash !== index) {
                toastr.warning(`${draft.name} is already in the list.`);
                return false;
            }
            list[index] = draft;
        });
        if (ok) {
            view.peek = { type: 'character', key: keyOf(draft.name), draft, isNew: false, mode: 'view' };
            render();
        }
        return;
    }
    const draft = peek.draft;
    if (!str(draft.title).trim()) {
        toastr.warning('Give the quest a title.');
        return;
    }
    const ok = await saveData('world', (data) => {
        const list = Array.isArray(data.quests) ? data.quests : (data.quests = []);
        if (peek.isNew) list.push(draft);
        else if (list[Number(peek.key)] !== undefined) list[Number(peek.key)] = draft;
        else return false;
    });
    if (ok) closePeek();
}

async function deletePeek() {
    const peek = view.peek;
    if (!peek || peek.isNew) return closePeek();
    const ok = peek.type === 'character'
        ? await saveData('cast', (data) => {
            data.characters = (Array.isArray(data.characters) ? data.characters : []).filter(character => keyOf(character?.name) !== peek.key);
        })
        : await saveData('world', (data) => {
            data.quests = (Array.isArray(data.quests) ? data.quests : []).filter((_, i) => i !== Number(peek.key));
        });
    if (ok) closePeek();
}

function renderSheet(peek) {
    const cast = findResult('cast');
    const character = characterList(cast?.data).find(item => keyOf(item.name) === peek.key);
    const panel = el('div', 'ct-sc-peek ct-sc-sheet');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Character');
    const head = el('div', 'ct-sc-peek-head');
    head.append(button('ct-sc-icon', '<i class="fa-solid fa-arrow-left"></i>', 'Back to the list', closePeek));
    head.append(el('span', 'ct-sc-kicker ct-sc-grow', 'Character'));
    const body = el('div', 'ct-sc-peek-body');
    if (!character) {
        body.append(el('p', 'ct-sc-empty-line', 'This character is no longer in the scene list.'));
        panel.append(head, body);
        return panel;
    }
    const previous = findResult('cast', { skip: 1 });
    const before = previous ? characterList(previous.data).find(item => keyOf(item.name) === peek.key) ?? {} : null;
    const changes = changedFields(character, before);
    const present = isPresent(character);

    const hero = el('div', `ct-sc-hero${present ? ' is-here' : ''}`);
    hero.append(portraitFor(character));
    const titles = el('div', 'ct-sc-hero-text');
    const nameLine = el('div', 'ct-sc-hero-name');
    nameLine.append(el('span', '', str(character.name).trim() || 'Unnamed'));
    if (isPlayer(character)) nameLine.append(el('span', 'ct-sc-you', 'YOU'));
    titles.append(nameLine);
    const tags = el('div', 'ct-sc-hero-tags');
    tags.append(el('span', `ct-sc-pill${present ? ' is-here' : ''}`, present ? 'In scene' : 'Not here'));
    if (changes.size) tags.append(el('span', 'ct-sc-pill is-active', 'Changed in the last update'));
    titles.append(tags);
    hero.append(titles);
    body.append(hero, characterDetails(character, changes, { full: true }));

    const foot = el('div', 'ct-sc-peek-foot');
    const presence = button('menu_button ct-sc-btn', present ? '<i class="fa-solid fa-person-walking-arrow-right"></i> Mark not here' : '<i class="fa-solid fa-person-walking-arrow-loop-left"></i> Mark in scene', present ? 'Move to Not here' : 'Move to In scene', () => void saveData('cast', (data) => {
        const item = (Array.isArray(data.characters) ? data.characters : []).find(c => keyOf(c?.name) === peek.key);
        if (!item) return false;
        item.present = !present;
    }));
    const edit = button('menu_button ct-sc-btn is-primary ct-sc-peek-edit', '<i class="fa-solid fa-pen"></i> Edit', `Edit ${str(character.name).trim()}`, editPeek);
    foot.append(presence, el('span', 'ct-sc-grow', ''), edit);
    panel.append(head, body, foot);
    panel.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.stopPropagation();
            closePeek();
        }
    });
    return panel;
}

function renderPeek() {
    const peek = view.peek;
    if (peek.type === 'character' && peek.mode === 'view') return renderSheet(peek);
    const panel = el('div', 'ct-sc-peek');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', peek.type === 'character' ? 'Character' : 'Quest');
    const draft = peek.draft;
    const head = el('div', 'ct-sc-peek-head');
    head.append(button('ct-sc-icon', '<i class="fa-solid fa-arrow-left"></i>', peek.type === 'character' && !peek.isNew ? 'Back to the character' : 'Back to the list', cancelPeek));
    const body = el('div', 'ct-sc-peek-body');

    if (peek.type === 'character') {
        head.append(avatarFor(draft, 'ct-sc-peek-avatar'));
        const titles = el('div', 'ct-sc-peek-titles');
        titles.append(el('div', 'ct-sc-peek-name', str(draft.name).trim() || 'New character'));
        if (isPlayer(draft)) titles.append(el('span', 'ct-sc-you', 'YOU'));
        head.append(titles);

        const presence = el('div', 'ct-sc-segment');
        presence.setAttribute('role', 'group');
        presence.setAttribute('aria-label', 'In the scene?');
        for (const [value, label] of [[true, 'In scene'], [false, 'Not here']]) {
            const on = isPresent(draft) === value;
            const b = button(on ? 'is-on' : '', label, '', () => {
                draft.present = value;
                render();
            });
            b.setAttribute('aria-pressed', String(on));
            presence.append(b);
        }
        body.append(presence);

        const bind = (field, control, target = draft) => control.addEventListener('input', () => {
            target[field] = control.value;
        });
        for (const [field, label, placeholder] of [['name', 'Name', 'Their name in the story'], ['role', 'Role', 'ally, rival, shopkeeper…'], ['mood', 'Mood', 'How they feel right now']]) {
            const { wrap, control } = textField(label, str(draft[field]), { placeholder, id: `ct-sc-peek-${field}` });
            bind(field, control);
            body.append(wrap);
        }
        const appHead = el('div', 'ct-sc-section-head');
        appHead.append(el('span', 'ct-sc-kicker', 'Appearance'), helpButton('Appearance', HELP.appearance));
        body.append(appHead);
        const grid = el('div', 'ct-sc-form');
        const extraLook = Object.keys(draft.appearance).filter(key => !APPEARANCE.some(([k]) => k === key));
        for (const [field, label] of [...APPEARANCE, ...extraLook.map(key => [key, humanize(key)])]) {
            const { wrap, control } = textField(label, str(draft.appearance[field]), { multiline: true, placeholder: 'Not known yet', id: `ct-sc-peek-look-${field}` });
            bind(field, control, draft.appearance);
            grid.append(wrap);
        }
        body.append(grid);
        const notes = textField('Notes', str(draft.notes), { multiline: true, placeholder: 'One short line worth remembering', id: 'ct-sc-peek-notes' });
        bind('notes', notes.control);
        body.append(notes.wrap);
        for (const key of Object.keys(draft).filter(k => !CHARACTER_KEYS.has(k))) {
            const value = draft[key];
            if (value !== null && typeof value === 'object') continue;
            const { wrap, control } = textField(humanize(key), str(value));
            bind(key, control);
            body.append(wrap);
        }
    } else {
        const titles = el('div', 'ct-sc-peek-titles');
        titles.append(el('div', 'ct-sc-peek-name', peek.isNew ? 'New quest' : (str(draft.title).trim() || 'Quest')));
        head.append(titles);
        const title = textField('Title', str(draft.title), { id: 'ct-sc-peek-title' });
        title.control.addEventListener('input', () => {
            draft.title = title.control.value;
        });
        const statusWrap = el('label', 'ct-sc-field');
        statusWrap.append(el('span', 'ct-sc-field-label', 'Status'));
        const select = el('select', 'text_pole');
        for (const value of QUEST_STATES) {
            const option = el('option', '', humanize(value));
            option.value = value;
            option.selected = (str(draft.status).toLowerCase() || 'active') === value;
            select.append(option);
        }
        select.addEventListener('change', () => {
            draft.status = select.value;
        });
        statusWrap.append(select);
        const note = textField('Note', str(draft.note), { multiline: true, placeholder: 'What is left to do', id: 'ct-sc-peek-note' });
        note.control.addEventListener('input', () => {
            draft.note = note.control.value;
        });
        body.append(title.wrap, statusWrap, note.wrap);
    }

    const foot = el('div', 'ct-sc-peek-foot');
    if (!peek.isNew) foot.append(button('ct-sc-danger', '<i class="fa-solid fa-trash-can"></i> Delete', peek.type === 'character' ? 'Remove from the list' : 'Delete the quest', () => void deletePeek()));
    foot.append(el('span', 'ct-sc-grow', ''), button('menu_button ct-sc-btn', 'Cancel', '', cancelPeek), button('menu_button ct-sc-btn is-primary', '<i class="fa-solid fa-check"></i> Save', '', () => void savePeek()));
    panel.append(head, body, foot);
    panel.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.stopPropagation();
            cancelPeek();
        }
    });
    return panel;
}

// ───────────────────────── Panel ─────────────────────────

function statusText(world, cast) {
    if (isPending('world') || isPending('cast')) return 'Updating…';
    const latest = [world, cast].filter(Boolean).sort((a, b) => b.messageIndex - a.messageIndex)[0];
    if (!latest) return 'Nothing tracked yet';
    return `As of message #${latest.messageIndex}`;
}

function renderStrip(cast, world) {
    strip.replaceChildren();
    strip.innerHTML = '<i class="fa-solid fa-angles-left" aria-hidden="true"></i><i class="fa-solid fa-masks-theater ct-sc-strip-icon" aria-hidden="true"></i>';
    const here = characterList(cast?.data).filter(isPresent).length;
    if (cast) {
        const count = el('span', 'ct-sc-strip-count', String(here));
        count.title = `${here} in scene`;
        strip.append(el('i', 'fa-solid fa-user-group ct-sc-strip-icon'), count);
    }
    const quests = (Array.isArray(world?.data?.quests) ? world.data.quests : []).filter(q => (str(q?.status).toLowerCase() || 'active') === 'active').length;
    if (world) strip.append(el('i', 'fa-solid fa-scroll ct-sc-strip-icon'), el('span', 'ct-sc-strip-count', String(quests)));
    strip.append(el('span', 'ct-sc-strip-label', 'Scene'));
}

export function render() {
    if (!root) build();
    const available = isAvailable();
    const open = isOpen();
    const showRail = available && open;
    document.body.classList.toggle('ct-scene-on', showRail);
    document.body.classList.toggle('ct-scene-strip-on', available && !open && isWide());
    root.hidden = !showRail;
    strip.hidden = !(available && !open && isWide());
    if (!available) {
        view.peek = null;
        root.replaceChildren();
        return;
    }
    const world = findResult('world');
    const cast = findResult('cast');
    if (!showRail) {
        renderStrip(cast, world);
        return;
    }
    closeHelp();
    const oldBody = root.querySelector('.ct-sc-body');
    const keepScroll = oldBody?.scrollTop ?? 0;
    const focusedId = document.activeElement?.id && root.contains(document.activeElement) ? document.activeElement.id : '';
    const caret = focusedId && 'selectionStart' in document.activeElement ? /** @type {HTMLInputElement} */ (document.activeElement).selectionStart : null;

    const parts = [renderHeader(statusText(world, cast))];
    const worldRow = renderWorldStrip(world?.data);
    if (worldRow) parts.push(worldRow);
    const hasCast = Boolean(cast || enabledAgent('cast'));
    const hasWorld = Boolean(world || enabledAgent('world'));
    const tabs = [];
    if (hasCast) tabs.push({ id: 'cast', label: 'Cast', count: characterList(cast?.data).filter(isPresent).length });
    if (hasWorld) {
        tabs.push({ id: 'quests', label: 'Quests', count: (Array.isArray(world?.data?.quests) ? world.data.quests : []).filter(q => (str(q?.status).toLowerCase() || 'active') === 'active').length });
        tabs.push({ id: 'items', label: 'Items', count: (Array.isArray(world?.data?.inventory) ? world.data.inventory : []).filter(Boolean).length });
        tabs.push({ id: 'world', label: 'World', count: 0 });
    }
    const st = settings();
    const active = tabs.some(tab => tab.id === st.tab) ? st.tab : tabs[0]?.id;
    const body = el('div', 'ct-sc-body');
    if (!world && !cast) {
        renderEmpty(body);
    } else {
        parts.push(renderTabs(tabs, active));
        const needs = active === 'cast' ? cast : world;
        if (!needs) renderEmpty(body);
        else if (active === 'cast') renderCast(body, cast.data, findResult('cast', { skip: 1 })?.data ?? null);
        else if (active === 'quests') renderQuests(body, world.data);
        else if (active === 'items') renderItems(body, world.data);
        else renderWorld(body, world.data);
    }
    parts.push(body);
    if (view.peek) parts.push(renderPeek());
    root.classList.toggle('has-peek', Boolean(view.peek));
    root.replaceChildren(...parts);
    body.scrollTop = keepScroll;
    if (focusedId) {
        const target = document.getElementById(focusedId);
        if (target) {
            target.focus();
            if (caret !== null && 'setSelectionRange' in target) /** @type {HTMLInputElement} */ (target).setSelectionRange(caret, caret);
        }
    }
}

// ───────────────────────── Actions ─────────────────────────

function openSetup() {
    if (selected_group && globalThis.HomunculusGroupStudio?.open) {
        globalThis.HomunculusGroupStudio.open(selected_group, 'scene');
        return;
    }
    const agent = enabledAgent('world') ?? enabledAgent('cast') ?? sceneAgents('world')[0] ?? sceneAgents('cast')[0];
    if (agent) agentsApi()?.openAgentEditor?.(agent.id);
    else toastr.info('Open the Agents drawer and add "Scene: World" and "Scene: Characters" from the templates.');
}

/** Runs the Scene trackers that are on here on the last message. */
export async function updateNow() {
    const api = agentsApi();
    const agents = [enabledAgent('world'), enabledAgent('cast')].filter(Boolean);
    if (!api?.runCompanionAgentOnMessage || !agents.length || view.busy) return;
    const index = api.getLatestValidCompanionMessageIndex?.() ?? chat.length - 1;
    if (index < 0) {
        toastr.info('There are no messages to read yet.');
        return;
    }
    view.busy = true;
    render();
    try {
        for (const agent of agents) await api.runCompanionAgentOnMessage(agent.id, index);
    } catch (error) {
        toastr.error(String(error?.message ?? error), 'Scene update failed');
    } finally {
        view.busy = false;
        render();
    }
}

function init() {
    const refresh = () => {
        applyPrompt();
        queueRender();
        globalThis.HomunculusGroupProfile?.refreshBar?.();
    };
    for (const name of ['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'GENERATION_ENDED', 'GROUP_UPDATED', 'APP_READY']) {
        if (event_types[name]) eventSource.on(event_types[name], refresh);
    }
    eventSource.on(event_types.CHAT_CHANGED, () => {
        view.peek = null;
        view.search = '';
    });
    eventSource.on(event_types.GENERATION_STARTED, applyPrompt);
    eventSource.on('in_chat_agent_companion_results_updated', refresh);
    document.addEventListener('homunculus:group-profile-changed', refresh);
    narrowQuery.addEventListener?.('change', () => queueRender());
}

init();

globalThis.HomunculusScene = {
    render,
    refresh: () => {
        applyPrompt();
        render();
        globalThis.HomunculusGroupProfile?.refreshBar?.();
    },
    toggle,
    isOpen,
    isAvailable,
    updateNow,
    findResult,
    scenePrompt,
    enabledAgent,
    sceneAgents,
    SCENE_TEMPLATES,
};
