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
    chat_metadata,
    characters,
    name1,
    default_avatar,
    getThumbnailUrl,
    getCurrentChatId,
    saveSettingsDebounced,
} from '../script.js';
import { extension_settings, saveMetadataDebounced } from './extensions.js';
import { groups, selected_group } from './group-chats.js';
import { user_avatar, getUserAvatar } from './personas.js';
import { helpButton, closeHelp } from './classic-help.js';
import { set as setPromptBlock } from './classic-prompt-blocks.js';
import { activePreset, castFields, getValue, setValue, listValue, isFilled, FIELDS_CHANGED_EVENT } from './classic-scene-fields.js';

export const SCENE_TEMPLATES = Object.freeze({
    world: 'tpl-homunculus-scene-world',
    cast: 'tpl-homunculus-scene-characters',
    plot: 'tpl-homunculus-scene-plot',
});
const TAGS = Object.freeze({ world: 'WORLD', cast: 'CAST', plot: 'PLOT' });
const BEATS_KEY = 'homunculus_beats';
const THREAD_STATES = Object.freeze(['brewing', 'active', 'done', 'failed']);
const BEAT_STATES = Object.freeze([['planned', 'Planned'], ['steer', 'Steer toward'], ['hold', 'Not yet']]);
const CORE_CAST_KEYS = Object.freeze(['name', 'present', 'role', 'mood', 'notes']);
const WORLD_MODULE_KEYS = Object.freeze(['time', 'location', 'weather', 'quests', 'inventory', 'factions']);
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
<p>Drag a card (or press Alt+↑ / Alt+↓ on it) to change the order; drop it in the other group to move someone in or out of the scene. The order is saved per chat.</p>
<p>A dot marks what changed in the last update.</p>
<p>A new NPC is only added when they have a proper name and actually did or said something.</p>`,
    appearance: `<p>How the character looks right now, so you can picture them at a glance.</p>
<p>The tracker always fills face, hair, eyes, build and outfit: from the story first, then the character card or cast sheet, and if neither says, it picks details that fit and keeps them. When the story changes something (new clothes, a wound, a lost weapon) it updates that part.</p>`,
    traits: '<p>A few words for who they are inside (brave, sarcastic, loyal to Mira…). The tracker takes them from the character card first, then from how they act in the story, and keeps them unless the story shows a real change.</p>',
    other: '<p>Things the tracker wrote that the current field preset does not list (for example from another preset). They stay saved; they just are not part of the preset.</p>',
    quests: '<p>Tasks and goals from the story. The tracker adds one when a task is clearly given or taken on, and marks it completed or failed when the story resolves it.</p>',
    items: '<p>Notable things the player carries. The tracker adds items that are clearly taken, bought or given, and removes the ones lost or used up.</p>',
    world: `<p>The rest of the world state. Any field the World tracker's prompt asks for shows here.</p>
<p>To add your own field (for example "Corruption"), add it to the tracker's prompt in the agent editor.</p>`,
    plot: `<p>The shape of the story, for you as the author.</p>
<ul>
<li><b>Threads</b>: open arcs and questions, kept by the <b>Scene: Plot</b> tracker (brewing, active, done, failed). Click the status to change it.</li>
<li><b>What each character wants</b>: their goal and what they will try next on their own.</li>
<li><b>Your planned beats</b>: your own outline. <b>Steer toward</b> tells the AI to move the story there; <b>Not yet</b> tells it to keep that from happening for now. The tracker ticks a beat when the story reaches it.</li>
<li><b>Who knows what</b>: secrets, and who is still in the dark.</li>
</ul>`,
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
export function findResult(kind, { skip = 0, before = chat.length } = {}) {
    const api = agentsApi();
    if (!api?.getCompanionResults) return null;
    const ids = new Set(sceneAgents(kind).map(agent => agent.id));
    if (!ids.size) return null;
    let skipped = 0;
    for (let index = Math.min(before, chat.length) - 1; index >= 0; index--) {
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
/** Keys a character can hold under the active preset (core keys, About fields and section objects). */
function knownCastKeys(preset = activePreset('cast')) {
    const keys = new Set(CORE_CAST_KEYS);
    for (const section of preset.sections) {
        if (section.id === 'about') section.fields.forEach(field => keys.add(field.key));
        else keys.add(section.id);
    }
    return keys;
}
/** World keys the active preset uses (modules that are on and its own fields). */
function knownWorldKeys(preset = activePreset('world')) {
    return new Set([...WORLD_MODULE_KEYS, ...preset.fields.map(field => field.key)]);
}
const worldModuleOn = (key, preset = activePreset('world')) => preset.modules[key] !== false;
const isPresent = character => character.present !== false && character.present !== 'false';
const isPlayer = character => str(character.role).toLowerCase() === 'player' || (name1 && str(character.name).trim().toLowerCase() === String(name1).toLowerCase());
const keyOf = name => str(name).trim().toLowerCase();

/** Whether the panel has anything to show in the open chat. */
export function isAvailable() {
    if (!getCurrentChatId?.()) return false;
    return Boolean(enabledAgent('world') || enabledAgent('cast') || enabledAgent('plot') || findResult('world') || findResult('cast') || findResult('plot'));
}

// ───────────────────────── Plot: the author's planned beats ─────────────────────────

const openRole = () => globalThis.HomunculusGroupCampaign?.openRole?.() ?? 'player';

/** The author's planned beats of the open chat ({ id, title, status: planned|steer|hold|done }). */
export function getBeats() {
    const list = Array.isArray(chat_metadata?.[BEATS_KEY]) ? chat_metadata[BEATS_KEY] : [];
    return list.filter(beat => beat && str(beat.title).trim()).map(beat => ({
        id: str(beat.id) || Math.random().toString(36).slice(2, 9),
        title: str(beat.title).trim(),
        status: ['planned', 'steer', 'hold', 'done'].includes(beat.status) ? beat.status : 'planned',
    }));
}

function saveBeats(list) {
    chat_metadata[BEATS_KEY] = list;
    saveMetadataDebounced();
    applyPrompt();
    render();
}

function beatsMacro() {
    const beats = getBeats();
    if (!beats.length) return '(none)';
    const label = { planned: 'planned', steer: 'STEER TOWARD', hold: 'NOT YET', done: 'done' };
    return beats.map(beat => `- [${label[beat.status]}] ${beat.title}`).join('\n');
}

/** Instructions from the planned beats, sent before each reply (steer toward / not yet). */
function beatsPrompt() {
    const beats = getBeats();
    const steer = beats.filter(beat => beat.status === 'steer').map(beat => beat.title);
    const hold = beats.filter(beat => beat.status === 'hold').map(beat => beat.title);
    const parts = [];
    if (steer.length) parts.push(`Steer the story toward these beats, naturally and without rushing: ${steer.join('; ')}.`);
    if (hold.length) parts.push(`Do not let these happen yet: ${hold.join('; ')}.`);
    return parts.join('\n');
}

/** Ticks the beats the Plot tracker says the story reached. */
function syncBeatsDone() {
    const plot = findResult('plot');
    const done = (Array.isArray(plot?.data?.beatsDone) ? plot.data.beatsDone : []).map(item => keyOf(item)).filter(Boolean);
    if (!done.length) return;
    const beats = getBeats();
    let changed = false;
    for (const beat of beats) {
        if (beat.status !== 'done' && done.includes(keyOf(beat.title))) {
            beat.status = 'done';
            changed = true;
        }
    }
    if (changed) {
        chat_metadata[BEATS_KEY] = beats;
        saveMetadataDebounced();
    }
}

// ───────────────────────── Prompt ─────────────────────────

function oneLine(value) {
    if (Array.isArray(value)) return value.map(item => (item && typeof item === 'object' ? Object.values(item).map(str).filter(Boolean).join(' ') : str(item))).filter(Boolean).join(', ');
    if (value && typeof value === 'object') return Object.entries(value).filter(([, v]) => str(v).trim()).map(([k, v]) => `${k}: ${str(v)}`).join('; ');
    return str(value).replace(/\s+/g, ' ').trim();
}

function castPrompt(data) {
    const preset = activePreset('cast');
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
        const lines = [`- ${name}${tags ? ` (${tags})` : ''}`];
        for (const section of preset.sections) {
            const parts = [];
            for (const field of section.fields) {
                const value = getValue(character, section.id, field.key);
                if (!isFilled(field, value)) continue;
                const text = field.type === 'list' ? listValue(value).join(', ') : oneLine(value);
                if (section.id === 'about' && field.key === 'description') lines.push(`  ${text}`);
                else parts.push(`${field.label}: ${text}`);
            }
            if (!parts.length) continue;
            lines.push(section.id === 'about' ? `  ${parts.join('; ')}` : `  ${section.label}: ${parts.join('; ')}`);
        }
        if (str(character.notes).trim()) lines.push(`  Notes: ${str(character.notes).trim()}`);
        here.push(lines.join('\n'));
    }
    const parts = [];
    if (here.length) parts.push(`In this scene:\n${here.join('\n')}`);
    if (away.length) parts.push(`Known, not in this scene: ${away.join('; ')}`);
    return parts.join('\n');
}

function worldPrompt(data) {
    const preset = activePreset('world');
    const on = key => worldModuleOn(key, preset);
    const lines = [];
    const head = [['time', 'Time'], ['location', 'Location'], ['weather', 'Weather']].filter(([key]) => on(key) && str(data[key]).trim()).map(([key, label]) => `${label}: ${str(data[key]).trim()}`);
    if (head.length) lines.push(head.join(' · '));
    const quests = on('quests') ? (Array.isArray(data.quests) ? data.quests : []).filter(q => q && str(q.title).trim() && str(q.status || 'active').toLowerCase() === 'active') : [];
    if (quests.length) lines.push(`Active quests: ${quests.map(q => (str(q.note).trim() ? `${str(q.title).trim()} (${str(q.note).trim()})` : str(q.title).trim())).join('; ')}`);
    const items = on('inventory') ? oneLine(Array.isArray(data.inventory) ? data.inventory.filter(Boolean) : []) : '';
    if (items) lines.push(`Carrying: ${items}`);
    const factions = on('factions') ? (Array.isArray(data.factions) ? data.factions : []).filter(f => f && str(f.name).trim()) : [];
    if (factions.length) lines.push(`Factions: ${factions.map(f => (str(f.standing).trim() ? `${str(f.name).trim()} (${str(f.standing).trim()})` : str(f.name).trim())).join('; ')}`);
    for (const field of preset.fields) {
        const text = field.type === 'list' ? listValue(data[field.key]).join(', ') : oneLine(data[field.key]);
        if (text) lines.push(`${field.label}: ${text}`);
    }
    const known = knownWorldKeys(preset);
    for (const [key, value] of Object.entries(data)) {
        if (known.has(key)) continue;
        const text = oneLine(value);
        if (text) lines.push(`${humanize(key)}: ${text}`);
    }
    return lines.join('\n');
}

function plotPrompt(data) {
    const lines = [];
    const threads = (Array.isArray(data.threads) ? data.threads : []).filter(item => item && str(item.title).trim() && ['active', 'brewing'].includes(str(item.status || 'active').toLowerCase()));
    if (threads.length) lines.push(`Open threads: ${threads.map(item => `${str(item.title).trim()}${str(item.note).trim() ? ` (${str(item.note).trim()})` : ''}`).join('; ')}`);
    const goals = (Array.isArray(data.goals) ? data.goals : []).filter(item => item && str(item.name).trim());
    if (goals.length) lines.push(`What the characters want: ${goals.map(item => `${str(item.name).trim()}: ${[str(item.want).trim(), str(item.next).trim() ? `next: ${str(item.next).trim()}` : ''].filter(Boolean).join(', ')}`).join('; ')}`);
    const secrets = (Array.isArray(data.secrets) ? data.secrets : []).filter(item => item && str(item.fact).trim());
    if (secrets.length) lines.push(`Secrets: ${secrets.map(item => `${str(item.fact).trim()} (known by ${listValue(item.knows).join(', ') || 'nobody'}; unaware: ${listValue(item.unaware).join(', ') || 'everyone else'})`).join('; ')}`);
    return lines.join('\n');
}

function feedbackOn(agent) {
    return Boolean(agent?.companion?.feedback?.enabled);
}

/** The scene text sent before each reply (empty when nothing should be sent). */
export function scenePrompt({ before = chat.length } = {}) {
    if (!settings().inject || !getCurrentChatId?.()) return '';
    const parts = [];
    const worldAgent = enabledAgent('world');
    if (worldAgent && !feedbackOn(worldAgent)) {
        const text = worldPrompt(findResult('world', { before })?.data ?? {});
        if (text) parts.push(text);
    }
    const castAgent = enabledAgent('cast');
    if (castAgent && !feedbackOn(castAgent)) {
        const text = castPrompt(findResult('cast', { before })?.data ?? {});
        if (text) parts.push(text);
    }
    const plotAgent = enabledAgent('plot');
    if (plotAgent && !feedbackOn(plotAgent)) {
        const text = plotPrompt(findResult('plot', { before })?.data ?? {});
        if (text) parts.push(text);
    }
    return parts.length ? `For continuity. Do not repeat it back.\n${parts.join('\n')}` : '';
}

function applyPrompt() {
    setPromptBlock('scene', scenePrompt());
    setPromptBlock('beats', getCurrentChatId?.() ? beatsPrompt() : '');
}

/**
 * Before a reply is generated. A swipe or regenerate replaces the last reply, so the scene sent to
 * the AI must be the one from before that reply: never what an earlier swipe of it recorded.
 */
function applyPromptForGeneration(type) {
    const last = chat[chat.length - 1];
    const replacing = ['swipe', 'regenerate'].includes(String(type)) && last && !last.is_user;
    setPromptBlock('scene', scenePrompt(replacing ? { before: chat.length - 1 } : {}));
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
    const preset = activePreset('world');
    const items = [
        ['fa-clock', 'Time', world?.time, 'time'],
        ['fa-location-dot', 'Location', world?.location, 'location'],
        ['fa-cloud-sun', 'Weather', world?.weather, 'weather'],
    ].filter(([, , value, key]) => worldModuleOn(key, preset) && str(value).trim());
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

// ───────────────────────── Card order (drag and drop) ─────────────────────────

const ORDER_KEY = 'homunculus_scene_order';

function savedOrder() {
    const order = chat_metadata?.[ORDER_KEY];
    return Array.isArray(order) ? order.map(keyOf) : [];
}

/** Characters in the order the user dragged them (new ones keep the tracker's order, after those). */
function sortByOrder(list) {
    const order = savedOrder();
    if (!order.length) return list;
    const rank = new Map(order.map((key, index) => [key, index]));
    return list
        .map((character, index) => ({ character, index, rank: rank.has(keyOf(character.name)) ? rank.get(keyOf(character.name)) : order.length + index }))
        .sort((a, b) => a.rank - b.rank || a.index - b.index)
        .map(item => item.character);
}

/**
 * Moves one character before another (or to the end of a group) and saves the order in the chat.
 * Dropping into the other group also moves them in or out of the scene.
 * @param {string} key character being moved
 * @param {string|null} beforeKey character it goes in front of, or null for the end of the group
 * @param {boolean} toPresent the group it lands in
 */
async function moveCharacter(key, beforeKey, toPresent) {
    const list = sortByOrder(characterList(findResult('cast')?.data));
    const moving = list.find(character => keyOf(character.name) === key);
    if (!moving || key === beforeKey) return;
    const keys = list.map(character => keyOf(character.name)).filter(k => k !== key);
    let at = beforeKey ? keys.indexOf(beforeKey) : -1;
    if (at === -1) {
        // End of the group: after the last member of that group.
        const groupKeys = list.filter(character => isPresent(character) === toPresent && keyOf(character.name) !== key).map(character => keyOf(character.name));
        const last = groupKeys.length ? keys.indexOf(groupKeys[groupKeys.length - 1]) : -1;
        at = last === -1 ? (toPresent ? 0 : keys.length) : last + 1;
    }
    keys.splice(at, 0, key);
    chat_metadata[ORDER_KEY] = keys;
    saveMetadataDebounced();
    if (isPresent(moving) !== toPresent) {
        await saveData('cast', (data) => {
            const item = (Array.isArray(data.characters) ? data.characters : []).find(c => keyOf(c?.name) === key);
            if (!item) return false;
            item.present = toPresent;
        });
    } else {
        render();
    }
}

const drag = { key: '', fromPresent: true };

function clearDropMarks() {
    root?.querySelectorAll('.is-drop-before, .is-drop-after, .is-drop-target').forEach(node => node.classList.remove('is-drop-before', 'is-drop-after', 'is-drop-target'));
}

/** Where a drop over this card lands: before it or after it (by the pointer's half). */
function dropSpot(card, event) {
    const box = card.getBoundingClientRect();
    return event.clientY < box.top + box.height / 2 ? 'before' : 'after';
}

function makeDraggable(card, character) {
    const key = keyOf(character.name);
    const present = isPresent(character);
    card.draggable = true;
    card.dataset.key = key;
    card.addEventListener('dragstart', (event) => {
        if (/** @type {HTMLElement} */ (event.target).closest?.('input, textarea')) return;
        drag.key = key;
        drag.fromPresent = present;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', str(character.name));
        requestAnimationFrame(() => {
            card.classList.add('is-dragging');
            root?.classList.add('is-card-dragging');
        });
    });
    card.addEventListener('dragend', () => {
        drag.key = '';
        card.classList.remove('is-dragging');
        root?.classList.remove('is-card-dragging');
        clearDropMarks();
    });
    card.addEventListener('dragover', (event) => {
        if (!drag.key || drag.key === key) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const spot = dropSpot(card, event);
        if (!card.classList.contains(`is-drop-${spot}`)) {
            clearDropMarks();
            card.classList.add(`is-drop-${spot}`);
        }
    });
    card.addEventListener('drop', (event) => {
        if (!drag.key || drag.key === key) return;
        event.preventDefault();
        event.stopPropagation();
        const moving = drag.key;
        const spot = dropSpot(card, event);
        clearDropMarks();
        let beforeKey = key;
        if (spot === 'after') {
            let next = card.nextElementSibling;
            while (next && (!next.classList.contains('ct-sc-card') || /** @type {HTMLElement} */ (next).dataset.key === moving)) next = next.nextElementSibling;
            beforeKey = next ? /** @type {HTMLElement} */ (next).dataset.key : null;
        }
        void moveCharacter(moving, beforeKey, present);
    });
}

/** A whole group (also when empty or folded) takes drops at its end. */
function makeDropZone(section, toPresent) {
    section.addEventListener('dragover', (event) => {
        if (!drag.key) return;
        event.preventDefault();
        const target = /** @type {HTMLElement} */ (event.target);
        if (!target.closest('.ct-sc-card')) {
            clearDropMarks();
            section.classList.add('is-drop-target');
        }
    });
    section.addEventListener('dragleave', (event) => {
        if (!section.contains(/** @type {Node} */ (event.relatedTarget))) section.classList.remove('is-drop-target');
    });
    section.addEventListener('drop', (event) => {
        if (!drag.key) return;
        event.preventDefault();
        const moving = drag.key;
        clearDropMarks();
        void moveCharacter(moving, null, toPresent);
    });
}

/** Alt+↑ / Alt+↓ on a card moves it one place within its group. */
function moveByKey(character, step) {
    const present = isPresent(character);
    const group = sortByOrder(characterList(findResult('cast')?.data)).filter(c => isPresent(c) === present).map(c => keyOf(c.name));
    const index = group.indexOf(keyOf(character.name));
    const target = index + step;
    if (index === -1 || target < 0 || target >= group.length) return;
    const beforeKey = step < 0 ? group[target] : (group[target + 1] ?? null);
    void moveCharacter(keyOf(character.name), beforeKey, present);
}

function renderCast(body, cast, previous) {
    const st = settings();
    const list = sortByOrder(characterList(cast));
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
    const flatten = value => (value && typeof value === 'object' ? Object.values(value).flatMap(flatten) : [str(value)]);
    const matches = character => !term || flatten(character).join(' ').toLowerCase().includes(term);
    const groupsToShow = [
        ['here', 'In scene', here],
        ['away', 'Not here', away],
    ].filter(([id]) => st.filter === 'all' || st.filter === id);

    let shown = 0;
    for (const [id, label, items] of groupsToShow) {
        const visible = items.filter(matches);
        if (!visible.length && st.filter === 'all') {
            // Hidden until a card is dragged: lets you drop someone into an empty group.
            if (!list.length || term) continue;
            const zone = el('section', 'ct-sc-group ct-sc-drop-zone');
            zone.append(el('p', 'ct-sc-drop-hint', id === 'here' ? 'Drop here: in the scene' : 'Drop here: not in the scene'));
            makeDropZone(zone, id === 'here');
            body.append(zone);
            continue;
        }
        const collapsed = Boolean(st.collapsed[id]);
        const section = el('section', 'ct-sc-group');
        makeDropZone(section, id === 'here');
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
    for (const field of castFields()) {
        const now = getValue(character, field.section, field.key);
        const then = getValue(before, field.section, field.key);
        const same = field.type === 'list' ? listValue(now).join('|') === listValue(then).join('|') : str(now).trim() === str(then).trim();
        if (!same) out.add(field.path);
    }
    return out;
}

/** Built-in colors for the usual appearance parts; other fields get a color from their name. */
const TONES = new Set(['face', 'hair', 'eyes', 'body', 'outfit', 'accessories', 'marks']);
const TYPE_ICON = { text: 'fa-circle-dot', stat: 'fa-hashtag', list: 'fa-list-ul' };

function styleField(node, field) {
    if (TONES.has(field.key)) node.classList.add(`is-${field.key}`);
    else node.style.setProperty('--ct-tone', `hsl(${hue(field.key)} 62% 68%)`);
}

function fieldLabel(field, changed, changedTag) {
    const head = el('div', 'ct-sc-look-label');
    head.innerHTML = `<i class="fa-solid ${field.icon || TYPE_ICON[field.type] || 'fa-circle-dot'}" aria-hidden="true"></i>`;
    head.append(el('span', '', field.label));
    if (changed) head.append(changedTag());
    return head;
}

/**
 * Everything the tracker knows about a character, laid out by the active field preset:
 * About text and lists at the top, mood as a pill, short values as tiles, text as colored blocks
 * (label over text) and lists as chips. full = the character sheet (headers for every section,
 * role, missing fields and data the preset does not know).
 * @param {object} character
 * @param {Set<string>} changes from changedFields()
 * @param {{ full?: boolean }} options
 */
function characterDetails(character, changes, { full = false } = {}) {
    const preset = activePreset('cast');
    const box = el('div', `ct-sc-details${full ? ' is-full' : ''}`);
    const changedTag = () => {
        const tag = el('span', 'ct-sc-new', 'updated');
        tag.title = 'Changed in the last update';
        return tag;
    };
    const header = (title, help) => {
        const head = el('div', 'ct-sc-section-head');
        head.append(el('span', 'ct-sc-kicker', title));
        if (help) head.append(helpButton(title, help));
        box.append(head);
    };
    const chips = (items, changed) => {
        const row = el('div', `ct-sc-traits${changed ? ' is-changed' : ''}`);
        for (const item of items) row.append(el('span', 'ct-sc-trait', item));
        if (changed) row.append(changedTag());
        return row;
    };
    const textBlock = (field, value, changed) => {
        const item = el('div', `ct-sc-look-item${changed ? ' is-changed' : ''}`);
        styleField(item, field);
        item.append(fieldLabel(field, changed, changedTag), el('div', 'ct-sc-look-text', value));
        item.dataset.field = field.path ?? field.key;
        return item;
    };
    const listBlock = (field, items, changed) => {
        const item = el('div', `ct-sc-look-item${changed ? ' is-changed' : ''}`);
        styleField(item, field);
        item.append(fieldLabel(field, changed, changedTag), chips(items, false));
        item.dataset.field = field.path ?? field.key;
        return item;
    };
    const statTile = (field, value, changed) => {
        const tile = el('div', `ct-sc-stat${changed ? ' is-changed' : ''}`);
        styleField(tile, field);
        const label = el('div', 'ct-sc-stat-label');
        label.innerHTML = `<i class="fa-solid ${field.icon || TYPE_ICON.stat}" aria-hidden="true"></i>`;
        label.append(el('span', '', field.label));
        if (changed) label.append(el('span', 'ct-sc-dot', ''));
        tile.append(label, el('div', 'ct-sc-stat-value', value));
        if (changed) tile.title = 'Changed in the last update';
        tile.dataset.field = field.path ?? field.key;
        return tile;
    };

    // About: description and other text first, then the lists (traits) as chips.
    const about = preset.sections.find(section => section.id === 'about');
    const aboutFields = (about?.fields ?? []).map(field => ({ ...field, section: 'about', path: field.key }));
    if (!full) {
        const tiles = el('div', 'ct-sc-stats');
        for (const field of aboutFields) {
            const value = getValue(character, 'about', field.key);
            if (!isFilled(field, value)) continue;
            const changed = changes.has(field.path);
            if (field.type === 'list') {
                box.append(chips(listValue(value), changed));
            } else if (field.type === 'stat') {
                tiles.append(statTile(field, str(value).trim(), changed));
            } else {
                const text = el('p', 'ct-sc-desc', str(value).trim());
                if (changed) text.title = 'Changed in the last update';
                box.append(text);
            }
        }
        if (tiles.childElementCount) box.append(tiles);
    }

    const mood = str(character.mood).trim();
    if (mood) {
        const line = el('div', `ct-sc-mood${changes.has('mood') ? ' is-changed' : ''}`);
        line.innerHTML = '<i class="fa-solid fa-masks-theater" aria-hidden="true"></i>';
        line.append(el('span', 'ct-sc-mood-text', mood));
        if (changes.has('mood')) line.append(changedTag());
        line.title = 'Mood right now';
        box.append(line);
    }

    if (full) {
        const list = el('div', 'ct-sc-look');
        if (str(character.role).trim()) list.append(textBlock({ key: 'role', label: 'Role', type: 'text', icon: 'fa-id-badge' }, str(character.role).trim(), changes.has('role')));
        const tiles = el('div', 'ct-sc-stats');
        for (const field of aboutFields.filter(item => item.type !== 'list')) {
            const value = getValue(character, 'about', field.key);
            if (!isFilled(field, value)) continue;
            if (field.type === 'stat') tiles.append(statTile(field, str(value).trim(), changes.has(field.path)));
            else list.append(textBlock(field, str(value).trim(), changes.has(field.path)));
        }
        if (list.childElementCount || tiles.childElementCount) {
            header(about?.label || 'About');
            if (tiles.childElementCount) box.append(tiles);
            if (list.childElementCount) box.append(list);
        }
        for (const field of aboutFields.filter(item => item.type === 'list')) {
            const value = listValue(getValue(character, 'about', field.key));
            header(field.label, field.key === 'traits' ? HELP.traits : '');
            if (value.length) box.append(chips(value, changes.has(field.path)));
            else box.append(el('p', 'ct-sc-unknown', 'Nothing yet. Press Update now, or add it with Edit.'));
        }
    }

    // The other sections, in the preset's order.
    for (const section of preset.sections.filter(item => item.id !== 'about')) {
        const fields = section.fields.map(field => ({ ...field, section: section.id, path: `${section.id}.${field.key}` }));
        const filled = fields.filter(field => isFilled(field, getValue(character, section.id, field.key)));
        if (!filled.length) continue;
        if (full || !['stats', 'appearance'].includes(section.id)) header(section.label, section.id === 'appearance' && full ? HELP.appearance : '');
        const tiles = el('div', 'ct-sc-stats');
        const list = el('div', 'ct-sc-look');
        for (const field of filled) {
            const value = getValue(character, section.id, field.key);
            const changed = changes.has(field.path);
            if (field.type === 'stat') tiles.append(statTile(field, str(value).trim(), changed));
            else if (field.type === 'list') list.append(listBlock(field, listValue(value), changed));
            else list.append(textBlock(field, str(value).trim(), changed));
        }
        if (tiles.childElementCount) box.append(tiles);
        if (list.childElementCount) box.append(list);
    }

    const missing = castFields(preset).filter(field => field.required && !isFilled(field, getValue(character, field.section, field.key)));
    if (missing.length) {
        box.append(el('p', 'ct-sc-unknown', `Waiting for the tracker: ${missing.map(field => field.label.toLowerCase()).join(', ')}. Press Update now to fill it in.`));
    }

    const notes = str(character.notes).trim();
    if (notes) {
        if (full) header('Notes');
        const note = el('p', `ct-sc-notes${changes.has('notes') ? ' is-changed' : ''}`, notes);
        if (changes.has('notes')) note.title = 'Changed in the last update';
        box.append(note);
    }

    // Data the preset does not know (another preset was used, or the prompt was edited): on the sheet.
    if (full) {
        const known = knownCastKeys(preset);
        const other = el('div', 'ct-sc-look');
        const add = (key, label, value) => {
            const text = Array.isArray(value) ? listValue(value).join(', ') : oneLine(value);
            if (text) other.append(textBlock({ key, label, type: 'text' }, text, false));
        };
        for (const [key, value] of Object.entries(character)) {
            if (known.has(key) || value === null || value === undefined) continue;
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                for (const [sub, subValue] of Object.entries(value)) add(sub, `${humanize(key)} · ${humanize(sub)}`, subValue);
            } else {
                add(key, humanize(key), value);
            }
        }
        for (const section of preset.sections.filter(item => item.id !== 'about')) {
            const holder = character[section.id];
            if (!holder || typeof holder !== 'object' || Array.isArray(holder)) continue;
            for (const [sub, subValue] of Object.entries(holder)) {
                if (!section.fields.some(field => field.key === sub)) add(sub, `${section.label} · ${humanize(sub)}`, subValue);
            }
        }
        if (other.childElementCount) {
            header('Other', HELP.other);
            box.append(other);
        }
    }
    return box;
}

function characterCard(character, before, changed) {
    const present = isPresent(character);
    const key = keyOf(character.name);
    const name = str(character.name).trim() || 'Unnamed';
    const open = isCardOpen(character);
    const card = el('article', `ct-sc-card${present ? ' is-here' : ''}${changed ? ' is-changed' : ''}${open ? ' is-open' : ''}`);
    makeDraggable(card, character);

    const head = el('div', 'ct-sc-card-head');
    const main = button('ct-sc-card-main', '', `Open ${name}`, () => openPeek('character', key));
    main.id = `ct-sc-card-${key.replace(/[^a-z0-9_-]+/g, '-')}`;
    main.addEventListener('keydown', (event) => {
        if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        moveByKey(character, event.key === 'ArrowUp' ? -1 : 1);
    });
    const grip = el('span', 'ct-sc-grip');
    grip.innerHTML = '<i class="fa-solid fa-grip-vertical" aria-hidden="true"></i>';
    grip.title = 'Drag to reorder';
    main.append(grip, avatarFor(character));
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
    main.setAttribute('aria-label', `Open ${name}: ${present ? 'in scene' : 'not here'}${changed ? ', changed in the last update' : ''}. Alt plus arrow keys to move.`);

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

function renderPlot(body, plot) {
    const data = plot ?? {};
    const head = el('div', 'ct-sc-section-head');
    head.append(el('span', 'ct-sc-kicker', 'Plot'), helpButton('Plot', HELP.plot));
    body.append(head);
    if (!enabledAgent('plot') && !plot) {
        const note = el('div', 'ct-sc-plot-note');
        note.append(el('span', '', 'Threads, goals and secrets come from the Scene: Plot tracker. Your planned beats below work without it.'));
        note.append(button('menu_button ct-sc-btn', '<i class="fa-solid fa-sliders"></i> Set up', 'Open Group Studio → Scene', openSetup));
        body.append(note);
    }

    // Threads
    body.append(el('div', 'ct-sc-plot-title', 'Threads'));
    const threads = (Array.isArray(data.threads) ? data.threads : []).map((thread, index) => ({ thread, index })).filter(({ thread }) => thread && str(thread.title).trim());
    const threadList = el('div', 'ct-sc-rows');
    const statusOf = thread => (THREAD_STATES.includes(str(thread.status).toLowerCase()) ? str(thread.status).toLowerCase() : 'active');
    for (const { thread, index } of threads.sort((a, b) => THREAD_STATES.indexOf(statusOf(a.thread) === 'brewing' ? 'active' : statusOf(a.thread)) - THREAD_STATES.indexOf(statusOf(b.thread) === 'brewing' ? 'active' : statusOf(b.thread)))) {
        const status = statusOf(thread);
        const row = el('div', `ct-sc-thread is-${status}`);
        const pill = button(`ct-sc-pill ct-sc-thread-pill is-${status}`, '', `Status: ${status}. Click to change`, () => void saveData('plot', (next) => {
            const item = next.threads?.[index];
            if (!item) return false;
            item.status = THREAD_STATES[(THREAD_STATES.indexOf(status) + 1) % THREAD_STATES.length];
        }));
        pill.textContent = status;
        const text = el('div', 'ct-sc-thread-text');
        text.append(el('span', 'ct-sc-quest-title', str(thread.title).trim()));
        if (str(thread.note).trim()) text.append(el('span', 'ct-sc-row-sub', str(thread.note).trim()));
        row.append(pill, text, button('ct-sc-x', '<i class="fa-solid fa-xmark"></i>', `Remove ${str(thread.title).trim()}`, () => void saveData('plot', (next) => {
            if (!Array.isArray(next.threads)) return false;
            next.threads.splice(index, 1);
        })));
        threadList.append(row);
    }
    if (!threads.length) threadList.append(el('p', 'ct-sc-empty-line', plot ? 'No threads yet.' : 'Nothing tracked yet.'));
    body.append(threadList);
    if (plot) body.append(addRow('ct-sc-new-thread', 'New thread…', 'Add a thread', title => void saveData('plot', (next) => {
        next.threads = Array.isArray(next.threads) ? next.threads : [];
        next.threads.push({ title, status: 'active', note: '' });
    })));

    // Goals
    const goals = (Array.isArray(data.goals) ? data.goals : []).filter(item => item && str(item.name).trim());
    body.append(el('div', 'ct-sc-plot-title', 'What each character wants'));
    const goalList = el('div', 'ct-sc-rows');
    for (const goal of goals) {
        const box = el('div', 'ct-sc-goal');
        box.append(el('div', 'ct-sc-goal-name', str(goal.name).trim()));
        if (str(goal.want).trim()) {
            const line = el('div', 'ct-sc-goal-line');
            line.append(el('span', 'ct-sc-goal-label is-want', 'Wants'), el('span', '', str(goal.want).trim()));
            box.append(line);
        }
        if (str(goal.next).trim()) {
            const line = el('div', 'ct-sc-goal-line');
            line.append(el('span', 'ct-sc-goal-label is-next', 'Next'), el('span', '', str(goal.next).trim()));
            box.append(line);
        }
        goalList.append(box);
    }
    if (!goals.length) goalList.append(el('p', 'ct-sc-empty-line', plot ? 'No goals noted yet.' : 'Nothing tracked yet.'));
    body.append(goalList);

    // Planned beats
    const beats = getBeats();
    body.append(el('div', 'ct-sc-plot-title', 'Your planned beats'));
    const beatList = el('div', 'ct-sc-rows');
    beats.forEach((beat, index) => {
        const row = el('div', `ct-sc-beat is-${beat.status}`);
        const box = el('input');
        box.type = 'checkbox';
        box.checked = beat.status === 'done';
        box.setAttribute('aria-label', `Done: ${beat.title}`);
        box.addEventListener('change', () => {
            const next = getBeats();
            next[index].status = box.checked ? 'done' : 'planned';
            saveBeats(next);
        });
        const select = el('select', 'text_pole ct-sc-beat-status');
        select.setAttribute('aria-label', `When: ${beat.title}`);
        select.disabled = beat.status === 'done';
        for (const [value, label] of BEAT_STATES) {
            const node = el('option', '', label);
            node.value = value;
            node.selected = beat.status === value;
            select.append(node);
        }
        if (beat.status === 'done') {
            const node = el('option', '', 'Done');
            node.value = 'done';
            node.selected = true;
            select.append(node);
        }
        select.addEventListener('change', () => {
            const next = getBeats();
            next[index].status = select.value;
            saveBeats(next);
        });
        row.append(box, el('span', 'ct-sc-beat-title', beat.title), select, button('ct-sc-x', '<i class="fa-solid fa-xmark"></i>', `Remove ${beat.title}`, () => {
            const next = getBeats();
            next.splice(index, 1);
            saveBeats(next);
        }));
        beatList.append(row);
    });
    if (!beats.length) beatList.append(el('p', 'ct-sc-empty-line', 'Write where you want the story to go. "Steer toward" moves the story there; "Not yet" holds it back.'));
    body.append(beatList, addRow('ct-sc-new-beat', 'New beat, e.g. "Bram\'s secret comes out"…', 'Add a beat', (title) => {
        saveBeats([...getBeats(), { id: Math.random().toString(36).slice(2, 9), title, status: 'planned' }]);
    }));

    // Secrets
    const secrets = (Array.isArray(data.secrets) ? data.secrets : []).filter(item => item && str(item.fact).trim());
    body.append(el('div', 'ct-sc-plot-title', 'Who knows what'));
    const secretList = el('div', 'ct-sc-rows');
    for (const secret of secrets) {
        const box = el('div', 'ct-sc-secret');
        box.append(el('div', 'ct-sc-goal-name', str(secret.fact).trim()));
        const knows = listValue(secret.knows);
        const unaware = listValue(secret.unaware);
        if (knows.length) {
            const line = el('div', 'ct-sc-goal-line');
            line.append(el('span', 'ct-sc-goal-label is-knows', 'Knows'), el('span', '', knows.join(', ')));
            box.append(line);
        }
        if (unaware.length) {
            const line = el('div', 'ct-sc-goal-line');
            line.append(el('span', 'ct-sc-goal-label is-unaware', 'Doesn\'t know'), el('span', '', unaware.join(', ')));
            box.append(line);
        }
        secretList.append(box);
    }
    if (!secrets.length) secretList.append(el('p', 'ct-sc-empty-line', plot ? 'No secrets noted.' : 'Nothing tracked yet.'));
    body.append(secretList);
}

function addRow(id, placeholder, label, onAdd) {
    const row = el('div', 'ct-sc-add-row');
    const input = el('input', 'text_pole');
    input.id = id;
    input.type = 'text';
    input.placeholder = placeholder;
    input.setAttribute('aria-label', label);
    const add = () => {
        const value = input.value.trim();
        if (!value) return;
        input.value = '';
        onAdd(value);
    };
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            add();
        }
    });
    row.append(input, button('menu_button ct-sc-btn', '<i class="fa-solid fa-plus"></i>', label, add));
    return row;
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
    const preset = activePreset('world');
    const form = el('div', 'ct-sc-form');
    for (const [key, label] of [['time', 'Time'], ['location', 'Location'], ['weather', 'Weather']].filter(([key]) => worldModuleOn(key, preset))) {
        const { wrap, control } = textField(label, str(world?.[key]), { id: `ct-sc-world-${key}` });
        control.addEventListener('change', () => void saveData('world', (data) => {
            data[key] = control.value.trim();
        }));
        form.append(wrap);
    }
    if (form.childElementCount) body.append(form);

    // The preset's own fields (shown even when empty, with the instruction as a hint).
    if (preset.fields.length) {
        const pHead = el('div', 'ct-sc-section-head');
        pHead.append(el('span', 'ct-sc-kicker', preset.name));
        body.append(pHead);
        const pForm = el('div', 'ct-sc-form');
        for (const field of preset.fields) {
            const isList = field.type === 'list';
            const value = world?.[field.key];
            const { wrap, control } = textField(field.label, isList ? listValue(value).join('\n') : str(value), {
                multiline: true,
                placeholder: field.hint ? field.hint.split(/(?<=\.)\s/)[0] : '',
                id: `ct-sc-world-${field.key}`,
            });
            if (isList) wrap.append(el('span', 'ct-sc-hint', 'One per line'));
            control.addEventListener('change', () => void saveData('world', (data) => {
                data[field.key] = isList ? control.value.split('\n').map(item => item.trim()).filter(Boolean) : control.value.trim();
            }));
            pForm.append(wrap);
        }
        body.append(pForm);
    }

    if (worldModuleOn('factions', preset)) renderFactions(body, world);
    renderWorldExtras(body, world, preset);
}

function renderFactions(body, world) {
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
}

function renderWorldExtras(body, world, preset) {
    const known = knownWorldKeys(preset);
    const extra = Object.entries(world ?? {}).filter(([key]) => !known.has(key));
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
        draft = structuredClone(found ?? { name: '', present: true, role: '', description: '', traits: [], mood: '', appearance: {}, notes: '' });
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

/**
 * Chips with × plus a box to add more (Enter or comma), like a tag field.
 * @param {object} draft the character being edited
 * @param {{ key: string, label: string, hint?: string, section: string }} field list field of the preset
 */
function listEditor(draft, field) {
    const values = listValue(getValue(draft, field.section, field.key));
    const store = () => setValue(draft, field.section, field.key, [...values]);
    store();
    const wrap = el('div', 'ct-sc-field');
    const labelRow = el('div', 'ct-sc-section-head');
    labelRow.append(el('span', 'ct-sc-field-label', field.label), helpButton(field.label, field.key === 'traits' ? HELP.traits : `<p>${(field.hint || 'A list of short items.').replace(/[<>&]/g, '')}</p>`));
    const box = el('div', 'ct-sc-trait-edit text_pole');
    const input = el('input', 'ct-sc-trait-input');
    input.type = 'text';
    input.id = `ct-sc-peek-${field.section}-${field.key}`;
    input.placeholder = values.length ? 'Add…' : 'Type and press Enter to add';
    input.setAttribute('aria-label', `Add to ${field.label}`);
    const paint = () => {
        box.querySelectorAll('.ct-sc-trait').forEach(node => node.remove());
        for (const [index, item] of values.entries()) {
            const chipNode = el('span', 'ct-sc-trait');
            chipNode.append(el('span', '', item), button('ct-sc-trait-x', '<i class="fa-solid fa-xmark" aria-hidden="true"></i>', `Remove ${item}`, () => {
                values.splice(index, 1);
                store();
                paint();
                input.focus();
            }));
            box.insertBefore(chipNode, input);
        }
    };
    const add = () => {
        for (const part of input.value.split(/[,;]/).map(item => item.trim()).filter(Boolean)) {
            if (!values.some(item => item.toLowerCase() === part.toLowerCase())) values.push(part);
        }
        input.value = '';
        store();
        paint();
    };
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            add();
        } else if (event.key === 'Backspace' && !input.value && values.length) {
            values.pop();
            store();
            paint();
        }
    });
    input.addEventListener('blur', add);
    box.addEventListener('click', (event) => {
        if (event.target === box) input.focus();
    });
    box.append(input);
    paint();
    wrap.append(labelRow, box);
    return wrap;
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
    foot.append(presence);
    // Homunculus Vault (scripts/classic-vault.js): keep this character as an NPC sheet.
    if (globalThis.HomunculusVault?.saveNpcFromScene && !isPlayer(character)) {
        foot.append(button('menu_button ct-sc-btn', '<i class="fa-solid fa-vault"></i> Save to Vault', `Save ${str(character.name).trim()} in the Vault (NPCs)`, () => {
            const group = selected_group ? groups.find(item => String(item.id) === String(selected_group)) : null;
            void globalThis.HomunculusVault.saveNpcFromScene(character, { presetId: activePreset('cast').id, sourceName: group?.name ?? '' });
        }));
    }
    foot.append(el('span', 'ct-sc-grow', ''), edit);
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
        const line = (field, label, placeholder) => {
            const { wrap, control } = textField(label, str(draft[field]), { placeholder, id: `ct-sc-peek-${field}` });
            bind(field, control);
            body.append(wrap);
        };
        line('name', 'Name', 'Their name in the story');
        line('role', 'Role', 'ally, rival, shopkeeper…');
        const preset = activePreset('cast');
        for (const section of preset.sections) {
            if (section.id !== 'about' || !section.fields.length) {
                const sectionHead = el('div', 'ct-sc-section-head');
                sectionHead.append(el('span', 'ct-sc-kicker', section.label));
                if (section.id === 'appearance') sectionHead.append(helpButton('Appearance', HELP.appearance));
                body.append(sectionHead);
            }
            const form = el('div', `ct-sc-form${section.fields.some(item => item.type === 'stat') ? ' has-stats' : ''}`);
            for (const field of section.fields) {
                const def = { ...field, section: section.id };
                if (field.type === 'list') {
                    form.append(listEditor(draft, def));
                    continue;
                }
                const { wrap, control } = textField(field.label, str(getValue(draft, section.id, field.key)), {
                    multiline: field.type === 'text',
                    placeholder: field.hint ? field.hint.split(/(?<=\.)\s/)[0] : 'Not known yet',
                    id: `ct-sc-peek-${section.id}-${field.key}`,
                });
                if (field.type === 'stat') wrap.classList.add('is-stat');
                control.addEventListener('input', () => setValue(draft, section.id, field.key, control.value));
                form.append(wrap);
            }
            body.append(form);
            if (section.id === 'about') line('mood', 'Mood', 'How they feel right now');
        }
        if (!preset.sections.some(section => section.id === 'about')) line('mood', 'Mood', 'How they feel right now');
        const notes = textField('Notes', str(draft.notes), { multiline: true, placeholder: 'One short line worth remembering', id: 'ct-sc-peek-notes' });
        bind('notes', notes.control);
        body.append(notes.wrap);
        // Values the preset does not list stay editable as plain text.
        const known = knownCastKeys(preset);
        const extras = [];
        for (const [key, value] of Object.entries(draft)) {
            if (known.has(key) || value === null || value === undefined) continue;
            if (typeof value !== 'object') extras.push([draft, key, humanize(key), value]);
            else if (!Array.isArray(value)) for (const [sub, subValue] of Object.entries(value)) if (subValue === null || typeof subValue !== 'object') extras.push([value, sub, `${humanize(key)} · ${humanize(sub)}`, subValue]);
        }
        for (const section of preset.sections.filter(item => item.id !== 'about')) {
            const holder = draft[section.id];
            if (!holder || typeof holder !== 'object' || Array.isArray(holder)) continue;
            for (const [sub, subValue] of Object.entries(holder)) {
                if (!section.fields.some(field => field.key === sub) && (subValue === null || typeof subValue !== 'object')) extras.push([holder, sub, `${section.label} · ${humanize(sub)}`, subValue]);
            }
        }
        if (extras.length) {
            const otherHead = el('div', 'ct-sc-section-head');
            otherHead.append(el('span', 'ct-sc-kicker', 'Other'), helpButton('Other', HELP.other));
            body.append(otherHead);
            for (const [target, key, label, value] of extras) {
                const { wrap, control } = textField(label, str(value), { multiline: true });
                bind(key, control, target);
                body.append(wrap);
            }
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

function statusText(world, cast, plot = null) {
    if (isPending('world') || isPending('cast') || isPending('plot')) return 'Updating…';
    const latest = [world, cast, plot].filter(Boolean).sort((a, b) => b.messageIndex - a.messageIndex)[0];
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
    const plot = findResult('plot');
    if (!showRail) {
        renderStrip(cast, world);
        return;
    }
    closeHelp();
    const oldBody = root.querySelector('.ct-sc-body');
    const keepScroll = oldBody?.scrollTop ?? 0;
    const focusedId = document.activeElement?.id && root.contains(document.activeElement) ? document.activeElement.id : '';
    const caret = focusedId && 'selectionStart' in document.activeElement ? /** @type {HTMLInputElement} */ (document.activeElement).selectionStart : null;

    const parts = [renderHeader(statusText(world, cast, plot))];
    const worldRow = renderWorldStrip(world?.data);
    if (worldRow) parts.push(worldRow);
    const hasCast = Boolean(cast || enabledAgent('cast'));
    const hasWorld = Boolean(world || enabledAgent('world'));
    // Co-author and Author: the Quests tab becomes Plot (Player gets Plot too when its tracker is on).
    const authorRole = openRole() !== 'player';
    const hasPlot = authorRole || Boolean(plot || enabledAgent('plot'));
    const plotTab = { id: 'plot', label: 'Plot', count: (Array.isArray(plot?.data?.threads) ? plot.data.threads : []).filter(item => item && ['active', 'brewing'].includes(str(item.status || 'active').toLowerCase())).length };
    const tabs = [];
    if (hasCast) tabs.push({ id: 'cast', label: 'Cast', count: characterList(cast?.data).filter(isPresent).length });
    if (hasPlot && authorRole) tabs.push(plotTab);
    if (hasWorld) {
        const worldPreset = activePreset('world');
        if (!authorRole && worldModuleOn('quests', worldPreset)) tabs.push({ id: 'quests', label: 'Quests', count: (Array.isArray(world?.data?.quests) ? world.data.quests : []).filter(q => (str(q?.status).toLowerCase() || 'active') === 'active').length });
        if (hasPlot && !authorRole) tabs.push(plotTab);
        if (worldModuleOn('inventory', worldPreset)) tabs.push({ id: 'items', label: 'Items', count: (Array.isArray(world?.data?.inventory) ? world.data.inventory : []).filter(Boolean).length });
        tabs.push({ id: 'world', label: 'World', count: 0 });
    }
    const st = settings();
    if (hasPlot && !hasWorld && !authorRole) tabs.push(plotTab);
    const body = el('div', 'ct-sc-body');
    const activeTab = tabs.some(tab => tab.id === st.tab) ? st.tab : tabs[0]?.id;
    if (!world && !cast && !plot && activeTab !== 'plot') {
        renderEmpty(body);
    } else {
        parts.push(renderTabs(tabs, activeTab));
        const needs = activeTab === 'cast' ? cast : activeTab === 'plot' ? true : world;
        if (activeTab === 'plot') renderPlot(body, plot?.data ?? null);
        else if (!needs) renderEmpty(body);
        else if (activeTab === 'cast') renderCast(body, cast.data, findResult('cast', { skip: 1 })?.data ?? null);
        else if (activeTab === 'quests') renderQuests(body, world.data);
        else if (activeTab === 'items') renderItems(body, world.data);
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
    const agents = [enabledAgent('world'), enabledAgent('cast'), enabledAgent('plot')].filter(Boolean);
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
    eventSource.on(event_types.GENERATION_STARTED, applyPromptForGeneration);
    document.addEventListener(FIELDS_CHANGED_EVENT, refresh);
    eventSource.on('in_chat_agent_companion_results_updated', () => {
        syncBeatsDone();
        refresh();
    });
    document.addEventListener('homunculus:group-campaign-changed', refresh);
    eventSource.on(event_types.APP_READY, registerPlotMacro);
    document.addEventListener('homunculus:group-profile-changed', refresh);
    narrowQuery.addEventListener?.('change', () => queueRender());
    eventSource.on(event_types.APP_READY, () => setTimeout(() => void turnOnLorebooksOnce(), 2000));
}

/**
 * The Scene trackers were first shipped with "World Info" off, so they never saw lorebook entries
 * (ages, heights, looks written there). Switch it on once in agents made before that, keeping any
 * prompt edits; later the user can turn it off in the agent editor and it stays off.
 */
function registerPlotMacro() {
    const context = globalThis.SillyTavern?.getContext?.();
    const description = 'The author\'s planned beats of the open chat (Scene panel → Plot).';
    try {
        context?.registerMacro?.('scenePlotBeats', () => beatsMacro(), description);
    } catch {
        // legacy macro engine missing
    }
    try {
        context?.macros?.register?.('scenePlotBeats', { handler: () => beatsMacro(), description, returns: description, exampleUsage: '{{scenePlotBeats}}' });
    } catch {
        // new macro engine missing
    }
}

async function turnOnLorebooksOnce() {
    const st = settings();
    if (st.loreFix) return;
    const api = agentsApi();
    if (!api?.getAgents || !api.updateAgent) return;
    const templateIds = new Set(Object.values(SCENE_TEMPLATES));
    for (const agent of api.getAgents()) {
        if (!templateIds.has(String(agent?.sourceTemplateId ?? '')) || agent?.companion?.includeWorldInfo === true) continue;
        await api.updateAgent(agent.id, { companion: { ...(agent.companion ?? {}), includeWorldInfo: true } });
    }
    st.loreFix = 1;
    saveSettingsDebounced();
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
