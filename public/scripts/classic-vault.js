// Classic UI fork: the Vault.
//
// A page of its own (like the Group Studio) with things you can reuse across groups and chats:
// - Scenarios: the setting, the NPCs of the story, several first messages, a start time, lorebooks
//   and tags. A scenario can start a new group, be used in the open chat (scenario text + opening
//   message as swipes) or be made from one of your character cards.
// - NPCs: a character sheet with the fields of a Scene preset (description, traits, stats,
//   appearance…) plus background, personality, speech, relationships and goals. NPCs can be saved
//   from the Scene panel or from a scenario, filled in by the AI, and turned into a real character card.
//
// Items are JSON files on the server (src/endpoints/homunculus-vault.js), one per item.
// globalThis.HomunculusVault is used by the Group Studio and the Scene panel.

import {
    chat,
    chat_metadata,
    characters,
    getCharacters,
    getRequestHeaders,
    getThumbnailUrl,
    getCurrentChatId,
    reloadCurrentChat,
    saveChatConditional,
    saveMetadata,
    this_chid,
    eventSource,
    event_types,
    saveSettingsDebounced,
    selectCharacterById,
} from '../script.js';
import { extension_settings } from './extensions.js';
import { groups, selected_group } from './group-chats.js';
import { world_names } from './world-info.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { helpButton, closeHelp } from './classic-help.js';
import { getMessageTimeStamp } from './RossAscends-mods.js';
import { download, getFileText } from './utils.js';
import { listPresets, findPreset, castFields, getValue, setValue, listValue, isFilled } from './classic-scene-fields.js';
import { askAi, connectionProfiles, getCampaign, narratorAvatar } from './classic-group-campaign.js';
import { getProfile, saveProfile } from './classic-group-profile.js';

const VIEW_ID = 'ct-vault';
const API = '/api/homunculus/vault';
export const VAULT_CHANGED_EVENT = 'homunculus:vault-changed';
const DEFAULT_PRESET = 'builtin-cast-standard';

const TABS = [
    { id: 'scenarios', label: 'Scenarios', icon: 'fa-map', single: 'scenario' },
    { id: 'npcs', label: 'NPCs', icon: 'fa-user-group', single: 'NPC' },
];

const SHEET_SECTIONS = Object.freeze([
    { key: 'background', label: 'Background', hint: 'Where they come from and what shaped them, in 2 to 4 sentences.', color: '#9fd39a', icon: 'fa-book' },
    { key: 'personality', label: 'Personality', hint: 'How they think and behave, what they want and fear, in 2 to 4 sentences.', color: '#c9a0dc', icon: 'fa-brain' },
    { key: 'speech', label: 'Speech', hint: 'How they talk (vocabulary, rhythm, accent, habits) and one short example line in quotes.', color: '#8fc7e8', icon: 'fa-comment' },
    { key: 'relationships', label: 'Relationships', hint: 'Their ties to other named characters, one per line ("Aria: protects her like a daughter").', color: '#e08f8f', icon: 'fa-people-arrows' },
    { key: 'goals', label: 'Goals', hint: 'What they are trying to do right now and in the long run.', color: '#e0b46c', icon: 'fa-flag' },
]);

const BLOCK_COLORS = ['#e0b46c', '#c9a0dc', '#8fc7e8', '#9fd39a', '#e08fb8', '#7fd1c7', '#e08f8f'];

const HELP = {
    page: `<p>Things you can reuse in any group or chat.</p>
<ul>
<li><b>Scenarios</b>: a setting, its NPCs and one or more first messages. Start a new group from one, or use it in the chat that is open.</li>
<li><b>NPCs</b>: character sheets. Save them from the Scene panel or a scenario, let the AI fill the gaps, and turn them into real character cards.</li>
</ul>
<p>Everything is saved as files in your user data folder (<code>homunculus-vault</code>), so backups include it.</p>`,
    setting: '<p>Where and when the story happens and what the situation is. It becomes the <b>scenario</b> of the chat, so the AI reads it before every reply.</p>',
    npcs: '<p>The characters of this scenario that are not group members. They are listed in the chat\'s scenario so the AI knows them. <b>Save to NPCs</b> keeps a full sheet of one in the NPCs tab.</p>',
    firstMessages: '<p>The opening messages. When the scenario is used in a chat, the first one becomes the opening message and the others its swipes, so you can pick one with the arrows.</p>',
    startTime: '<p>When the story starts, in your own words ("Day 1, 06:00", "Winter, 1890"). It is added to the scenario text.</p>',
    lorebooks: '<p>Lorebooks that belong to this scenario. In a group they are added to the group\'s lorebooks (Group Studio → Profile).</p>',
    tags: '<p>Words to find and filter your items, separated by commas ("fantasy, horror").</p>',
    preset: '<p>Which fields the sheet has. It uses the same presets as the Scene panel, so an NPC saved from the panel keeps all its fields.</p>',
    fill: '<p>Asks the AI to write the fields that are still empty, based on what the sheet already says (and the scenarios it is in). Fields you filled are never changed.</p>',
    makeCharacter: '<p>Makes a normal character card from this sheet: it shows in Characters, and you can chat with it alone or add it to any group. The NPC stays in the Vault and remembers its card.</p>',
};

const state = {
    open: false,
    tab: 'scenarios',
    items: { scenarios: null, npcs: null },
    selected: { scenarios: null, npcs: null },
    editing: null,
    search: '',
    filter: 'all',
    opening: 0,
    busy: false,
};
let root = null;
let returnFocus = null;

// ───────────────────────── Helpers ─────────────────────────

const str = value => (typeof value === 'string' ? value : value == null ? '' : String(value));
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const splitList = text => str(text).split(/[,\n]/).map(item => item.trim()).filter(Boolean);
const unique = list => [...new Set(list)];
const findGroup = id => groups.find(group => String(group.id) === String(id));
const characterByAvatar = avatar => characters.find(character => character.avatar === avatar);

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

function card(title, help = '', { aside = null, className = '' } = {}) {
    const section = el('section', `ct-gs-card${className ? ` ${className}` : ''}`);
    const head = el('div', 'ct-gs-card-head');
    const titleRow = el('div', 'ct-gs-title-row');
    titleRow.append(el('h3', 'ct-gs-title', title));
    if (help) titleRow.append(helpButton(title, help));
    head.append(titleRow);
    if (aside) head.append(aside);
    section.append(head);
    return section;
}

function field(labelText, help, control, note = '') {
    const wrap = el('div', 'ct-gs-field');
    const head = el('div', 'ct-gs-field-head');
    const label = el('label', 'ct-gs-label', labelText);
    if (control.id) label.htmlFor = control.id;
    head.append(label);
    if (help) head.append(helpButton(labelText, help));
    wrap.append(head, control);
    if (note) wrap.append(el('div', 'ct-gs-note', note));
    return wrap;
}

let fieldCounter = 0;
function input(value, onInput, { placeholder = '', type = 'text' } = {}) {
    const node = el('input', 'text_pole');
    node.type = type;
    node.id = `ct-vlt-f${++fieldCounter}`;
    node.value = str(value);
    node.placeholder = placeholder;
    node.addEventListener('input', () => onInput(node.value));
    return node;
}

function textarea(value, onInput, { placeholder = '', rows = 3 } = {}) {
    const node = el('textarea', 'text_pole');
    node.id = `ct-vlt-f${++fieldCounter}`;
    node.rows = rows;
    node.value = str(value);
    node.placeholder = placeholder;
    node.addEventListener('input', () => onInput(node.value));
    return node;
}

function chips(list, className = 'ct-gs-chip') {
    const wrap = el('div', 'ct-gs-chips');
    for (const item of list) wrap.append(el('span', className, item));
    return wrap;
}

function formatDate(time) {
    const date = new Date(Number(time) || 0);
    if (!Number(time)) return '';
    return date.toLocaleDateString([], { day: 'numeric', month: 'short', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

function settings() {
    extension_settings.homunculusVault ??= {};
    return extension_settings.homunculusVault;
}

// ───────────────────────── Data ─────────────────────────

export function normalizeScenario(raw = {}) {
    const npcs = (Array.isArray(raw.npcs) ? raw.npcs : []).filter(npc => npc && typeof npc === 'object').map(npc => ({
        name: str(npc.name).trim(),
        role: str(npc.role).trim(),
        description: str(npc.description).trim(),
        relationship: str(npc.relationship).trim(),
        traits: listValue(npc.traits),
        npcId: str(npc.npcId),
    })).filter(npc => npc.name);
    const firstMessages = (Array.isArray(raw.firstMessages) ? raw.firstMessages : [raw.firstMessage]).map(str).filter(text => text.trim());
    return {
        id: str(raw.id) || uid(),
        type: 'scenario',
        v: 1,
        name: str(raw.name).trim() || 'Untitled scenario',
        description: str(raw.description).trim(),
        tags: listValue(raw.tags),
        favorite: Boolean(raw.favorite),
        source: str(raw.source) || 'manual',
        sourceName: str(raw.sourceName),
        setting: str(raw.setting),
        npcs,
        firstMessages,
        startTime: str(raw.startTime).trim(),
        lorebooks: listValue(raw.lorebooks),
        notes: str(raw.notes),
        createdAt: Number(raw.createdAt) || Date.now(),
        updatedAt: Number(raw.updatedAt) || Date.now(),
    };
}

export function normalizeNpc(raw = {}) {
    const data = raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? structuredClone(raw.data) : {};
    data.name = str(raw.name || data.name).trim() || 'Unnamed';
    const sheet = {};
    for (const section of SHEET_SECTIONS) sheet[section.key] = str(raw.sheet?.[section.key]);
    return {
        id: str(raw.id) || uid(),
        type: 'npc',
        v: 1,
        name: data.name,
        role: str(raw.role ?? data.role).trim(),
        tags: listValue(raw.tags),
        favorite: Boolean(raw.favorite),
        source: str(raw.source) || 'manual',
        sourceName: str(raw.sourceName),
        presetId: str(raw.presetId) || DEFAULT_PRESET,
        data,
        sheet,
        characterAvatar: str(raw.characterAvatar),
        createdAt: Number(raw.createdAt) || Date.now(),
        updatedAt: Number(raw.updatedAt) || Date.now(),
    };
}

const normalizeFor = (kind, raw) => (kind === 'scenarios' ? normalizeScenario(raw) : normalizeNpc(raw));

async function request(path, body) {
    const response = await fetch(`${API}/${path}`, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`The Vault could not ${path} (${response.status}).`);
    return response.json();
}

async function load(kind, { force = false } = {}) {
    if (state.items[kind] && !force) return state.items[kind];
    const list = await request('list', { kind });
    state.items[kind] = (Array.isArray(list) ? list : []).map(raw => normalizeFor(kind, raw));
    return state.items[kind];
}

export async function listItems(kind) {
    return [...await load(kind)];
}

export async function getItem(kind, id) {
    return (await load(kind)).find(item => item.id === id) ?? null;
}

async function saveItem(kind, item) {
    const clean = normalizeFor(kind, { ...item, updatedAt: Date.now() });
    await request('save', { kind, item: clean });
    const list = await load(kind);
    const index = list.findIndex(other => other.id === clean.id);
    if (index >= 0) list[index] = clean; else list.push(clean);
    document.dispatchEvent(new CustomEvent(VAULT_CHANGED_EVENT, { detail: { kind, id: clean.id } }));
    return clean;
}

async function deleteItem(kind, id) {
    await request('delete', { kind, id });
    const list = await load(kind);
    const index = list.findIndex(item => item.id === id);
    if (index >= 0) list.splice(index, 1);
    document.dispatchEvent(new CustomEvent(VAULT_CHANGED_EVENT, { detail: { kind, id } }));
}

function sortItems(list) {
    return [...list].sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.updatedAt - a.updatedAt);
}

function npcPreset(npc) {
    return findPreset('cast', npc.presetId) ?? findPreset('cast', DEFAULT_PRESET) ?? listPresets('cast')[0];
}

/** 'character' | 'full' | 'basic' */
function npcLevel(npc) {
    if (npc.characterAvatar && characterByAvatar(npc.characterAvatar)) return 'character';
    const required = castFields(npcPreset(npc)).filter(f => f.required);
    const filled = required.every(f => isFilled(f, getValue(npc.data, f.section, f.key)));
    const sheetFilled = SHEET_SECTIONS.filter(s => str(npc.sheet[s.key]).trim()).length >= 3;
    return filled && sheetFilled ? 'full' : 'basic';
}

const LEVEL_LABEL = { character: 'Is a character', full: 'Full sheet', basic: 'Basic' };

function scenariosWithNpc(npc) {
    const key = npc.name.toLowerCase();
    return (state.items.scenarios ?? []).filter(scenario => scenario.npcs.some(item => item.npcId === npc.id || item.name.toLowerCase() === key));
}

// ───────────────────────── Using a scenario ─────────────────────────

/** The scenario text a chat gets from a Vault scenario. */
export function scenarioText(scenario) {
    const parts = [];
    if (scenario.setting.trim()) parts.push(scenario.setting.trim());
    if (scenario.startTime) parts.push(`The story starts: ${scenario.startTime}.`);
    if (scenario.npcs.length) {
        const lines = scenario.npcs.map((npc) => {
            const bits = [npc.role, npc.description, npc.relationship ? `Relationship: ${npc.relationship}` : '', npc.traits.length ? `Traits: ${npc.traits.join(', ')}` : ''].filter(Boolean);
            return `- ${npc.name}${bits.length ? `: ${bits.join('. ').replace(/\.\./g, '.')}` : ''}`;
        });
        parts.push(`Other characters in this story:\n${lines.join('\n')}`);
    }
    return parts.join('\n\n');
}

function openingSpeaker() {
    if (selected_group) {
        const group = findGroup(selected_group);
        if (!group) return null;
        const campaign = getCampaign(group);
        const disabled = new Set(group.disabled_members ?? []);
        const avatar = campaign.mode === 'narrated' ? narratorAvatar(campaign) : (group.members ?? []).find(item => !disabled.has(item));
        return characterByAvatar(avatar) ?? null;
    }
    return this_chid !== undefined ? characters[this_chid] ?? null : null;
}

function canReplaceOpening() {
    return chat.length === 0 || (chat.length === 1 && !chat[0]?.is_user && !chat[0]?.is_system);
}

/**
 * Uses a scenario in the open chat.
 * @param {ReturnType<typeof normalizeScenario>} scenario
 * @param {{ setScenario?: boolean, replaceOpening?: boolean, addLorebooks?: boolean, quiet?: boolean }} options
 */
export async function applyScenarioToOpenChat(scenario, { setScenario = true, replaceOpening = true, addLorebooks = true, quiet = false } = {}) {
    if (!getCurrentChatId()) {
        toastr.info('Open a chat first.');
        return false;
    }
    const done = [];
    if (setScenario) {
        chat_metadata.scenario = scenarioText(scenario);
        await saveMetadata();
        done.push('scenario');
    }
    if (addLorebooks && scenario.lorebooks.length && selected_group) {
        const group = findGroup(selected_group);
        const known = scenario.lorebooks.filter(name => world_names?.includes(name));
        if (group && known.length) {
            const current = getProfile(group).lorebooks;
            const next = unique([...current, ...known]);
            if (next.length !== current.length) {
                await saveProfile(group.id, { lorebooks: next });
                done.push('lorebooks');
            }
        }
    }
    if (replaceOpening && scenario.firstMessages.length && canReplaceOpening()) {
        const speaker = openingSpeaker();
        if (speaker) {
            const sendDate = getMessageTimeStamp();
            const message = chat[0] && !chat[0].is_user ? chat[0] : {
                name: speaker.name,
                is_user: false,
                is_system: false,
                force_avatar: selected_group ? getThumbnailUrl('avatar', speaker.avatar) : undefined,
                original_avatar: speaker.avatar,
                send_date: sendDate,
                extra: {},
            };
            const swipes = [...scenario.firstMessages];
            message.mes = swipes[0];
            message.swipes = swipes;
            message.swipe_id = 0;
            message.swipe_info = swipes.map(() => ({ send_date: message.send_date ?? sendDate, gen_started: void 0, gen_finished: void 0, extra: {} }));
            if (!chat.length) chat.push(message);
            await saveChatConditional();
            await reloadCurrentChat();
            done.push(swipes.length > 1 ? `${swipes.length} first messages` : 'first message');
        }
    }
    if (!quiet) toastr.success(done.length ? `Used "${scenario.name}": ${done.join(', ')}.` : 'Nothing to change in this chat.');
    document.dispatchEvent(new CustomEvent(VAULT_CHANGED_EVENT, { detail: { kind: 'scenarios', id: scenario.id, used: true } }));
    return true;
}

/** Asks what to use from a scenario in the open chat, then uses it. */
export async function useScenarioInOpenChat(scenarioOrId) {
    const scenario = typeof scenarioOrId === 'string' ? await getItem('scenarios', scenarioOrId) : scenarioOrId;
    if (!scenario) return false;
    if (!getCurrentChatId()) {
        toastr.info('Open a chat first, then use the scenario there.');
        return false;
    }
    const wrap = el('div', 'ct-gm-ask');
    wrap.append(el('h3', '', `Use "${scenario.name}" in this chat?`));
    const options = [];
    const option = (key, text, checked, enabled = true, note = '') => {
        const label = el('label', 'ct-gs-check');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = checked && enabled;
        box.disabled = !enabled;
        label.append(box, el('span', '', text));
        wrap.append(label);
        if (note) wrap.append(el('div', 'ct-gs-note', note));
        options.push([key, box]);
    };
    const hasScenario = Boolean(str(chat_metadata?.scenario).trim());
    option('setScenario', 'Set the scenario of this chat (setting, start time and NPCs)', true, true, hasScenario ? 'This chat already has a scenario; it will be replaced.' : '');
    const canOpen = canReplaceOpening() && scenario.firstMessages.length > 0;
    option('replaceOpening', `Use the ${scenario.firstMessages.length > 1 ? `${scenario.firstMessages.length} first messages as the opening (with swipes)` : 'first message as the opening'}`, true, canOpen,
        !scenario.firstMessages.length ? 'This scenario has no first message.' : canOpen ? '' : 'Only possible in a chat that has no messages yet besides the greeting. Start a new chat to use it.');
    if (scenario.lorebooks.length) option('addLorebooks', `Add its lorebooks to the group (${scenario.lorebooks.join(', ')})`, true, Boolean(selected_group), selected_group ? '' : 'Only in a group chat.');
    const result = await new Popup(wrap, POPUP_TYPE.CONFIRM, '', { okButton: 'Use it', cancelButton: 'Cancel' }).show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return false;
    const choice = Object.fromEntries(options.map(([key, box]) => [key, box.checked]));
    return applyScenarioToOpenChat(scenario, { setScenario: false, replaceOpening: false, addLorebooks: false, ...choice });
}

/** Saves the open chat's scenario (and its opening message with swipes) as a new Vault scenario. */
export async function saveChatScenario({ name = '' } = {}) {
    if (!getCurrentChatId()) {
        toastr.info('Open a chat first.');
        return null;
    }
    const setting = str(chat_metadata?.scenario).trim();
    const opening = chat[0] && !chat[0].is_user && !chat[0].is_system ? chat[0] : null;
    const firstMessages = opening ? (Array.isArray(opening.swipes) && opening.swipes.length ? opening.swipes : [opening.mes]).map(str).filter(text => text.trim()) : [];
    if (!setting && !firstMessages.length) {
        toastr.info('This chat has no scenario or opening message to save yet.');
        return null;
    }
    const group = selected_group ? findGroup(selected_group) : null;
    const scenario = await saveItem('scenarios', {
        name: name || group?.name || (this_chid !== undefined ? characters[this_chid]?.name : '') || 'Saved scenario',
        source: group ? 'group' : 'manual',
        sourceName: group?.name ?? '',
        setting,
        firstMessages,
        lorebooks: group ? getProfile(group).lorebooks : [],
    });
    toastr.success(`Saved "${scenario.name}" in the Vault.`, '', { onclick: () => open('scenarios', scenario.id) });
    return scenario;
}

// ───────────────────────── NPC actions ─────────────────────────

/** Saves a character from the Scene panel as an NPC (asks before overwriting one with the same name). */
export async function saveNpcFromScene(character, { presetId = '', sourceName = '' } = {}) {
    if (!character || !str(character.name).trim()) return null;
    const list = await load('npcs');
    const name = str(character.name).trim();
    const existing = list.find(npc => npc.name.toLowerCase() === name.toLowerCase());
    const data = structuredClone(character);
    delete data.present;
    let base = null;
    if (existing) {
        const answer = await new Popup(`<div class="ct-gm-ask"><h3>${escapeText(name)} is already in the Vault</h3><p>Update the saved sheet with what the Scene panel has now? The background, speech and other full-sheet parts are kept.</p></div>`, POPUP_TYPE.CONFIRM, '', {
            okButton: 'Update it',
            cancelButton: 'Cancel',
            customButtons: [{ text: 'Save as a new NPC', result: 3, appendAtEnd: false }],
        }).show();
        if (answer === POPUP_RESULT.AFFIRMATIVE) base = existing;
        else if (answer !== 3) return null;
    }
    const npc = await saveItem('npcs', {
        ...(base ?? {}),
        id: base?.id ?? uid(),
        name,
        role: str(character.role).trim() || base?.role || '',
        presetId: presetId || base?.presetId || DEFAULT_PRESET,
        data: { ...(base?.data ?? {}), ...data },
        source: base?.source ?? 'scene',
        sourceName: base?.sourceName || sourceName,
    });
    toastr.success(`${name} is saved in the Vault (NPCs).`, '', { onclick: () => open('npcs', npc.id) });
    return npc;
}

function escapeText(text) {
    const node = document.createElement('span');
    node.textContent = str(text);
    return node.innerHTML;
}

async function saveScenarioNpc(scenario, index) {
    const entry = scenario.npcs[index];
    if (!entry) return;
    const npcs = await load('npcs');
    let npc = npcs.find(item => item.id === entry.npcId) ?? npcs.find(item => item.name.toLowerCase() === entry.name.toLowerCase());
    if (!npc) {
        npc = await saveItem('npcs', {
            name: entry.name,
            role: entry.role,
            source: 'scenario',
            sourceName: scenario.name,
            data: { name: entry.name, role: entry.role, description: entry.description, traits: entry.traits },
            sheet: { relationships: entry.relationship },
        });
        toastr.success(`${entry.name} is saved in the NPCs tab.`);
    }
    const next = structuredClone(scenario);
    next.npcs[index].npcId = npc.id;
    await saveItem('scenarios', next);
    return npc;
}

function npcSummaryForScenario(npc) {
    return {
        name: npc.name,
        role: npc.role,
        description: str(npc.data.description),
        relationship: str(npc.sheet.relationships).split('\n')[0] ?? '',
        traits: listValue(npc.data.traits),
        npcId: npc.id,
    };
}

async function addNpcToScenario(npc) {
    const scenarios = sortItems(await load('scenarios'));
    if (!scenarios.length) {
        toastr.info('Make a scenario first (Scenarios tab).');
        return;
    }
    const select = el('select', 'text_pole');
    for (const scenario of scenarios) select.append(new Option(scenario.name, scenario.id));
    const wrap = el('div', 'ct-gm-ask');
    wrap.append(el('h3', '', `Add ${npc.name} to a scenario`), select);
    const result = await new Popup(wrap, POPUP_TYPE.CONFIRM, '', { okButton: 'Add', cancelButton: 'Cancel' }).show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;
    const scenario = scenarios.find(item => item.id === select.value);
    if (!scenario) return;
    const next = structuredClone(scenario);
    const index = next.npcs.findIndex(item => item.npcId === npc.id || item.name.toLowerCase() === npc.name.toLowerCase());
    if (index >= 0) next.npcs[index] = { ...next.npcs[index], ...npcSummaryForScenario(npc) };
    else next.npcs.push(npcSummaryForScenario(npc));
    await saveItem('scenarios', next);
    toastr.success(`${npc.name} added to "${scenario.name}".`);
    render();
}

function npcAsText(npc) {
    const preset = npcPreset(npc);
    const lines = [`Name: ${npc.name}`];
    if (npc.role) lines.push(`Role: ${npc.role}`);
    for (const f of castFields(preset)) {
        const value = getValue(npc.data, f.section, f.key);
        if (!isFilled(f, value)) continue;
        lines.push(`${f.label}: ${f.type === 'list' ? listValue(value).join(', ') : str(value).trim()}`);
    }
    for (const section of SHEET_SECTIONS) {
        if (str(npc.sheet[section.key]).trim()) lines.push(`${section.label}: ${npc.sheet[section.key].trim()}`);
    }
    return lines.join('\n');
}

function parseJson(text) {
    const raw = str(text).replace(/^[\s\S]*?```(?:json)?\s*/i, (match) => (match.includes('```') ? '' : match)).replace(/```[\s\S]*$/, '');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('The AI did not answer with JSON.');
    return JSON.parse(raw.slice(start, end + 1));
}

async function fillNpcWithAi(npc, profileId) {
    const preset = npcPreset(npc);
    const missing = [];
    for (const f of castFields(preset)) {
        if (!isFilled(f, getValue(npc.data, f.section, f.key))) missing.push({ path: f.path, label: f.label, type: f.type, hint: f.hint });
    }
    for (const section of SHEET_SECTIONS) {
        if (!str(npc.sheet[section.key]).trim()) missing.push({ path: `sheet.${section.key}`, label: section.label, type: 'text', hint: section.hint });
    }
    if (!missing.length) {
        toastr.info('Every field of this sheet is already filled.');
        return null;
    }
    const scenarios = scenariosWithNpc(npc);
    const context = scenarios.map(scenario => `Scenario "${scenario.name}": ${scenario.setting.trim().slice(0, 1500)}`).join('\n\n');
    const system = [
        'You complete character sheets for a role-play story. Answer with one JSON object and nothing else.',
        'Keys are the field paths listed by the user. Lists are JSON arrays of short strings; everything else is a string.',
        'Stay consistent with everything the sheet already says. Be concrete and specific: numbers with units for age, height and weight; colors, materials and shapes for looks. Never vague words like "tall", "lean" or "average" on their own.',
        'Invent what is missing, but keep it plausible for the setting.',
    ].join('\n');
    const user = [
        'CURRENT SHEET:',
        npcAsText(npc),
        context ? `\nSTORY CONTEXT:\n${context}` : '',
        '\nFIELDS TO WRITE (path: what to write):',
        ...missing.map(item => `- ${item.path} (${item.type === 'list' ? 'list' : 'text'}): ${item.label}. ${item.hint}`),
    ].join('\n');
    const answer = parseJson(await askAi(profileId, system, user, 1600));
    const next = structuredClone(npc);
    let count = 0;
    for (const item of missing) {
        let value = answer[item.path];
        if (value === undefined) {
            const [first, second] = item.path.split('.');
            value = second ? answer[first]?.[second] : undefined;
        }
        if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) continue;
        if (item.path.startsWith('sheet.')) {
            next.sheet[item.path.slice(6)] = Array.isArray(value) ? value.join('\n') : str(value).trim();
        } else {
            const [section, key] = item.path.includes('.') ? item.path.split('.') : ['about', item.path];
            setValue(next.data, section, key, item.type === 'list' ? listValue(value) : (Array.isArray(value) ? value.join(', ') : str(value).trim()));
        }
        count++;
    }
    if (!count) throw new Error('The AI answer had none of the missing fields.');
    const saved = await saveItem('npcs', next);
    toastr.success(`Filled ${count} field${count === 1 ? '' : 's'}. Check them and edit anything you don't like.`);
    return saved;
}

function characterParts(npc) {
    const preset = npcPreset(npc);
    const about = [];
    if (str(npc.data.description).trim()) about.push(str(npc.data.description).trim());
    const describe = [];
    for (const section of preset.sections) {
        if (section.id === 'about') continue;
        const lines = section.fields
            .map(f => [f, getValue(npc.data, section.id, f.key)])
            .filter(([f, value]) => isFilled(f, value))
            .map(([f, value]) => `${f.label}: ${f.type === 'list' ? listValue(value).join(', ') : str(value).trim()}`);
        if (lines.length) describe.push(`${section.label}\n${lines.join('\n')}`);
    }
    const description = [
        [npc.role ? `${npc.name} — ${npc.role}.` : '', ...about].filter(Boolean).join(' '),
        ...describe,
        npc.sheet.background ? `Background\n${npc.sheet.background.trim()}` : '',
        npc.sheet.relationships ? `Relationships\n${npc.sheet.relationships.trim()}` : '',
        npc.sheet.goals ? `Goals\n${npc.sheet.goals.trim()}` : '',
    ].filter(Boolean).join('\n\n');
    const traits = listValue(npc.data.traits);
    const personality = [traits.length ? `Traits: ${traits.join(', ')}` : '', npc.sheet.personality.trim(), npc.sheet.speech ? `Speech: ${npc.sheet.speech.trim()}` : ''].filter(Boolean).join('\n\n');
    return { description, personality };
}

async function makeCharacter(npc) {
    const parts = characterParts(npc);
    const scenarios = scenariosWithNpc(npc);
    const wrap = el('div', 'ct-vlt-make');
    wrap.append(el('h3', '', `New character card from ${npc.name}`));
    wrap.append(el('p', 'ct-gs-note', 'Check and change anything before the card is made. The NPC stays in the Vault and is linked to the card.'));
    const nameBox = input(npc.name, () => {});
    const descBox = textarea(parts.description, () => {}, { rows: 9 });
    const persBox = textarea(parts.personality, () => {}, { rows: 4 });
    const scenarioSelect = el('select', 'text_pole');
    scenarioSelect.id = `ct-vlt-f${++fieldCounter}`;
    scenarioSelect.append(new Option('No scenario', ''));
    for (const scenario of scenarios) scenarioSelect.append(new Option(scenario.name, scenario.id, false, scenarios.length === 1));
    const firstBox = textarea('', () => {}, { rows: 5, placeholder: 'The message the character starts a chat with. Leave empty, or let the AI write one.' });
    const profileSelect = profilePicker();
    const write = button('menu_button ct-gs-btn', '<i class="fa-solid fa-wand-magic-sparkles"></i> Write it with AI', '', async () => {
        write.disabled = true;
        write.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Writing…';
        try {
            const scenario = scenarios.find(item => item.id === scenarioSelect.value);
            const system = 'You write the first message of a role-play character card: the opening scene the character starts a chat with. Write in third person past tense, 2 to 4 paragraphs, with the character speaking at least once in their own voice. Address the other person as {{user}}. Answer with the message only.';
            const user = `CHARACTER:\n${npcAsText({ ...npc, name: nameBox.value.trim() || npc.name })}${scenario ? `\n\nSCENARIO:\n${scenarioText(scenario)}` : ''}`;
            const text = str(await askAi(profileSelect.value, system, user, 900)).trim();
            if (!text) throw new Error('The AI returned an empty answer.');
            firstBox.value = text;
        } catch (error) {
            toastr.error(String(error?.message ?? error), 'Could not write the first message');
        } finally {
            write.disabled = false;
            write.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Write it with AI';
        }
    });
    const firstHead = el('div', 'ct-vlt-row');
    firstHead.append(profileSelect, write);
    wrap.append(
        field('Name', '', nameBox),
        field('Description', '', descBox),
        field('Personality', '', persBox),
        field('Scenario', '<p>The scenario text written into the card. Pick one of the Vault scenarios this NPC is in, or none.</p>', scenarioSelect),
        field('First message', '', firstBox),
        firstHead,
    );
    const result = await new Popup(wrap, POPUP_TYPE.CONFIRM, '', { okButton: 'Create character', cancelButton: 'Cancel', wide: true, large: true, leftAlign: true, allowVerticalScrolling: true }).show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return null;
    const scenario = scenarios.find(item => item.id === scenarioSelect.value);
    const form = new FormData();
    form.append('ch_name', nameBox.value.trim() || npc.name);
    form.append('description', descBox.value.trim());
    form.append('personality', persBox.value.trim());
    form.append('scenario', scenario ? scenarioText(scenario) : '');
    form.append('first_mes', firstBox.value.trim());
    form.append('mes_example', '');
    form.append('creator_notes', 'Made from a Homunculus Vault NPC.');
    form.append('tags', unique(['NPC', ...npc.tags, ...(scenario ? [scenario.name] : [])]).join(','));
    if (scenario?.lorebooks?.length === 1 && world_names?.includes(scenario.lorebooks[0])) form.append('world', scenario.lorebooks[0]);
    const headers = getRequestHeaders();
    delete headers['Content-Type'];
    const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
    if (!response.ok) throw new Error(`Could not make the character (${response.status}).`);
    const avatar = (await response.text()).trim();
    await getCharacters();
    const saved = await saveItem('npcs', { ...npc, characterAvatar: avatar });
    toastr.success(`${saved.name} is now a character. Find it in Characters.`);
    return saved;
}

function profilePicker() {
    const select = el('select', 'text_pole ct-vlt-profile');
    select.id = `ct-vlt-f${++fieldCounter}`;
    select.title = 'Connection profile used for the AI';
    select.setAttribute('aria-label', 'Connection profile used for the AI');
    const last = str(settings().profileId);
    select.append(new Option('Current connection', ''));
    for (const profile of connectionProfiles()) select.append(new Option(profile.name, profile.id, false, profile.id === last));
    select.addEventListener('change', () => {
        settings().profileId = select.value;
        saveSettingsDebounced();
    });
    return select;
}

// ───────────────────────── Import / export ─────────────────────────

function exportItem(kind, item) {
    const name = `${item.name.replace(/[^\w\- ]+/g, '').trim() || 'vault'}.${kind === 'scenarios' ? 'scenario' : 'npc'}.json`;
    download(JSON.stringify({ homunculusVault: 1, kind, item }, null, 2), name, 'application/json');
}

async function importFiles() {
    const picker = el('input');
    picker.type = 'file';
    picker.accept = '.json,application/json';
    picker.multiple = true;
    picker.addEventListener('change', async () => {
        let count = 0;
        for (const file of picker.files ?? []) {
            try {
                const parsed = JSON.parse(await getFileText(file));
                const entries = Array.isArray(parsed) ? parsed : [parsed];
                for (const entry of entries) {
                    const kind = entry?.kind === 'npcs' || entry?.item?.type === 'npc' || entry?.type === 'npc' ? 'npcs' : 'scenarios';
                    const item = entry?.item ?? entry;
                    if (!item || typeof item !== 'object' || !str(item.name).trim()) continue;
                    const exists = (await load(kind)).some(other => other.id === item.id);
                    await saveItem(kind, { ...item, id: exists ? uid() : item.id, source: item.source || 'import' });
                    state.tab = kind;
                    count++;
                }
            } catch (error) {
                toastr.error(`${file.name}: ${error?.message ?? error}`, 'Could not import');
            }
        }
        if (count) toastr.success(`Imported ${count} item${count === 1 ? '' : 's'}.`);
        render();
    });
    picker.click();
}

async function pickCharacter() {
    const list = [...characters].filter(character => character?.avatar).sort((a, b) => str(a.name).localeCompare(str(b.name)));
    if (!list.length) {
        toastr.info('You have no characters yet.');
        return null;
    }
    const wrap = el('div', 'ct-vlt-pick');
    wrap.append(el('h3', '', 'Make a scenario from a character'));
    wrap.append(el('p', 'ct-gs-note', 'The card\'s scenario (or description), first message and alternate greetings become the scenario. The card itself is not changed.'));
    const search = el('input', 'text_pole');
    search.type = 'search';
    search.placeholder = 'Search characters…';
    search.setAttribute('aria-label', 'Search characters');
    const grid = el('div', 'ct-vlt-pick-list');
    const findNpcs = el('label', 'ct-gs-check');
    const findBox = el('input');
    findBox.type = 'checkbox';
    findBox.checked = true;
    findNpcs.append(findBox, el('span', '', 'Find the NPCs with AI (reads the card and lists the other characters in it)'));
    const profileSelect = profilePicker();
    let chosen = null;
    let popup = null;
    const fill = () => {
        grid.replaceChildren();
        const term = search.value.trim().toLowerCase();
        for (const character of list.filter(item => !term || str(item.name).toLowerCase().includes(term)).slice(0, 80)) {
            const item = button('ct-vlt-pick-item', '', `Use ${character.name}`, () => {
                chosen = character;
                popup?.complete(POPUP_RESULT.AFFIRMATIVE);
            });
            const img = el('img');
            img.alt = '';
            img.loading = 'lazy';
            img.src = getThumbnailUrl('avatar', character.avatar);
            item.append(img, el('span', '', character.name));
            grid.append(item);
        }
    };
    search.addEventListener('input', fill);
    const aiRow = el('div', 'ct-vlt-row');
    aiRow.append(findNpcs, profileSelect);
    wrap.append(search, aiRow, grid);
    fill();
    popup = new Popup(wrap, POPUP_TYPE.TEXT, '', { okButton: 'Cancel', wide: true, large: true, allowVerticalScrolling: true });
    await popup.show();
    return chosen ? { character: chosen, findNpcs: findBox.checked, profileId: profileSelect.value } : null;
}

async function scenarioFromCharacter() {
    const choice = await pickCharacter();
    if (!choice) return;
    const { character } = choice;
    const data = character.data ?? {};
    const greetings = [character.first_mes, ...(Array.isArray(data.alternate_greetings) ? data.alternate_greetings : [])].map(str).filter(text => text.trim());
    const world = str(data.extensions?.world || character.world);
    let npcs = [];
    state.busy = true;
    render();
    try {
        if (choice.findNpcs) {
            const system = [
                'You read a role-play character card and list the characters in it. Answer with one JSON object and nothing else: {"npcs":[{"name":"","role":"","description":"","relationship":"","traits":[""]}]}',
                'Include every named character with a real part in the story (the card\'s main character too, if it is one person). Skip {{user}}, unnamed extras and groups.',
                'description: one or two concrete sentences. relationship: how they relate to the others or to {{user}}. traits: 3 to 5 short traits.',
            ].join('\n');
            const card = [`Name: ${character.name}`, `Description: ${str(character.description)}`, `Personality: ${str(character.personality)}`, `Scenario: ${str(character.scenario)}`, `First message: ${str(character.first_mes).slice(0, 3000)}`].join('\n\n');
            try {
                const answer = parseJson(await askAi(choice.profileId, system, card, 1500));
                npcs = Array.isArray(answer.npcs) ? answer.npcs : [];
            } catch (error) {
                toastr.warning(`The NPCs could not be found (${error?.message ?? error}). Add them by hand.`);
            }
        }
        const scenario = await saveItem('scenarios', {
            name: character.name,
            description: str(data.creator_notes || character.creatorcomment).replace(/\s+/g, ' ').trim().slice(0, 200),
            tags: Array.isArray(data.tags) ? data.tags.slice(0, 8) : [],
            source: 'card',
            sourceName: character.name,
            setting: str(character.scenario).trim() || str(character.description).trim(),
            npcs,
            firstMessages: greetings,
            lorebooks: world ? [world] : [],
        });
        state.tab = 'scenarios';
        state.selected.scenarios = scenario.id;
        state.opening = 0;
        toastr.success(`Scenario "${scenario.name}" made from the card. Check the setting and the NPCs.`);
    } finally {
        state.busy = false;
        render();
    }
}

// ───────────────────────── Page ─────────────────────────

function build() {
    root = el('div', 'ct-cb ct-gs ct-vlt');
    root.id = 'ct-vault-page';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Vault');
    root.innerHTML = `
        <header class="ct-cb-header">
            <button type="button" class="ct-cb-btn ct-cb-back" title="Back"><i class="fa-solid fa-arrow-left"></i></button>
            <div class="ct-cb-titles">
                <div class="ct-cb-kicker">Vault</div>
                <div class="ct-cb-title"><span>Scenarios and NPCs</span></div>
                <div class="ct-cb-sub"></div>
            </div>
            <div class="ct-gs-head-actions"></div>
        </header>
        <nav class="ct-gs-tabs ct-vlt-tabs" role="tablist" aria-label="Vault"></nav>
        <div class="ct-gs-shell">
            <aside class="ct-gs-side" aria-label="Items"></aside>
            <div class="ct-gs-main">
                <div class="ct-gs-body" role="tabpanel"></div>
            </div>
        </div>`;
    root.querySelector('.ct-cb-titles .ct-cb-title').append(helpButton('Vault', HELP.page));
    root.querySelector('.ct-cb-back').addEventListener('click', close);
    document.body.append(root);
}

function tabInfo() {
    return TABS.find(tab => tab.id === state.tab) ?? TABS[0];
}

function renderHeader() {
    const s = state.items.scenarios?.length ?? 0;
    const n = state.items.npcs?.length ?? 0;
    root.querySelector('.ct-cb-sub').textContent = `${s} scenario${s === 1 ? '' : 's'} · ${n} NPC${n === 1 ? '' : 's'}`;
    const actions = root.querySelector('.ct-gs-head-actions');
    actions.replaceChildren();
    actions.append(button('ct-cb-btn', '<i class="fa-solid fa-file-import"></i><span>Import</span>', 'Import a scenario or NPC file (.json)', () => void importFiles()));
    if (state.tab === 'scenarios') actions.append(button('ct-cb-btn', '<i class="fa-solid fa-id-card"></i><span>From a character</span>', 'Make a scenario from one of your character cards', () => void scenarioFromCharacter()));
    actions.append(button('ct-cb-btn is-primary', `<i class="fa-solid fa-plus"></i><span>New ${tabInfo().single}</span>`, '', () => startEdit(null)));
}

function renderTabs() {
    const nav = root.querySelector('.ct-vlt-tabs');
    nav.replaceChildren();
    for (const tab of TABS) {
        const isOn = tab.id === state.tab;
        const b = button(`ct-gs-tab${isOn ? ' is-on' : ''}`, `<i class="fa-solid ${tab.icon}" aria-hidden="true"></i><span>${tab.label}</span>`, '', () => {
            if (state.tab === tab.id) return;
            if (!confirmLeaveEdit()) return;
            state.tab = tab.id;
            state.editing = null;
            state.search = '';
            state.filter = 'all';
            render();
        });
        b.id = `ct-vlt-tab-${tab.id}`;
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', String(isOn));
        const count = state.items[tab.id]?.length;
        if (count) b.append(el('span', 'ct-gs-tab-badge', String(count)));
        nav.append(b);
    }
}

function confirmLeaveEdit() {
    if (!state.editing?.dirty) return true;
    // eslint-disable-next-line no-alert
    return window.confirm('Leave without saving your changes?');
}

function matches(item) {
    const term = state.search.trim().toLowerCase();
    if (state.filter === 'favorites' && !item.favorite) return false;
    if (state.filter.startsWith('tag:') && !item.tags.includes(state.filter.slice(4))) return false;
    if (state.filter.startsWith('level:') && npcLevel(item) !== state.filter.slice(6)) return false;
    if (!term) return true;
    const hay = [item.name, item.description, item.role, item.tags.join(' '), item.sourceName, ...(item.npcs ?? []).map(npc => npc.name)].map(str).join(' ').toLowerCase();
    return hay.includes(term);
}

function renderSide() {
    const side = root.querySelector('.ct-gs-side');
    side.replaceChildren();
    const kind = state.tab;
    const list = state.items[kind];
    const search = el('input', 'text_pole ct-gs-search');
    search.type = 'search';
    search.id = 'ct-vlt-search';
    search.placeholder = kind === 'scenarios' ? 'Name, tag, NPC…' : 'Name, role, tag…';
    search.value = state.search;
    search.setAttribute('aria-label', `Search ${tabInfo().label}`);
    search.addEventListener('input', () => {
        state.search = search.value;
        fillList();
    });
    const filters = el('div', 'ct-vlt-filters');
    const filterChip = (id, label) => {
        const isOn = state.filter === id;
        const b = button(`ct-vlt-filter${isOn ? ' is-on' : ''}`, '', '', () => {
            state.filter = isOn ? 'all' : id;
            renderSide();
        });
        b.textContent = label;
        b.setAttribute('aria-pressed', String(isOn));
        filters.append(b);
    };
    filterChip('all', 'All');
    filterChip('favorites', '★ Favorites');
    if (kind === 'npcs') {
        filterChip('level:full', 'Full sheet');
        filterChip('level:basic', 'Basic');
        filterChip('level:character', 'Is a character');
    }
    const tagCounts = new Map();
    for (const item of list ?? []) for (const tag of item.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    for (const [tag] of [...tagCounts].sort((a, b) => b[1] - a[1]).slice(0, 8)) filterChip(`tag:${tag}`, tag);
    const listEl = el('div', 'ct-gs-group-list ct-vlt-list');
    const fillList = () => {
        listEl.replaceChildren();
        if (!list) {
            listEl.append(el('p', 'ct-gs-note', 'Loading…'));
            return;
        }
        const items = sortItems(list).filter(matches);
        for (const item of items) {
            const isOn = state.selected[kind] === item.id && !state.editing?.isNew;
            const row = button(`ct-gs-group ct-vlt-item${isOn ? ' is-on' : ''}`, '', '', () => select(item.id));
            if (isOn) row.setAttribute('aria-current', 'true');
            row.append(itemFace(kind, item));
            const text = el('span', 'ct-gs-group-text');
            const top = el('span', 'ct-vlt-item-top');
            top.append(el('span', 'ct-gs-group-name', item.name));
            if (item.favorite) top.append(el('span', 'ct-vlt-star', '★'));
            text.append(top);
            if (kind === 'scenarios') {
                text.append(el('span', 'ct-gs-group-meta', [item.tags[0], `${item.npcs.length} NPC${item.npcs.length === 1 ? '' : 's'}`, `${item.firstMessages.length} opening${item.firstMessages.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ')));
            } else {
                const level = npcLevel(item);
                text.append(el('span', 'ct-gs-group-meta', [item.role, item.sourceName].filter(Boolean).join(' · ') || 'NPC'));
                text.append(el('span', `ct-vlt-level is-${level}`, LEVEL_LABEL[level]));
            }
            row.append(text);
            listEl.append(row);
        }
        if (!items.length) listEl.append(el('p', 'ct-gs-note', list.length ? 'Nothing matches.' : kind === 'scenarios' ? 'No scenarios yet. Press New scenario, or make one from a character.' : 'No NPCs yet. Save one from the Scene panel or a scenario, or press New NPC.'));
    };
    side.append(search, filters, listEl);
    fillList();
}

function itemFace(kind, item) {
    if (kind === 'npcs') return npcFace(item, 'ct-vlt-face');
    const face = el('span', 'ct-vlt-face ct-vlt-face-scenario');
    face.innerHTML = '<i class="fa-solid fa-map" aria-hidden="true"></i>';
    return face;
}

function npcFace(npc, className) {
    const linked = npc.characterAvatar && characterByAvatar(npc.characterAvatar);
    if (linked) {
        const img = el('img', className);
        img.alt = '';
        img.loading = 'lazy';
        img.src = getThumbnailUrl('avatar', npc.characterAvatar);
        return img;
    }
    const face = el('span', `${className} ct-vlt-initial`, npc.name.slice(0, 1).toUpperCase());
    let hash = 0;
    for (const char of npc.name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    face.style.setProperty('--vlt-c', BLOCK_COLORS[hash % BLOCK_COLORS.length]);
    return face;
}

function select(id) {
    if (!confirmLeaveEdit()) return;
    state.selected[state.tab] = id;
    state.editing = null;
    state.opening = 0;
    render();
}

function current() {
    const list = state.items[state.tab] ?? [];
    return list.find(item => item.id === state.selected[state.tab]) ?? null;
}

function render() {
    if (!root) return;
    closeHelp();
    renderHeader();
    renderTabs();
    renderSide();
    const body = root.querySelector('.ct-gs-body');
    const keepScroll = body.scrollTop;
    body.replaceChildren();
    body.setAttribute('aria-labelledby', `ct-vlt-tab-${state.tab}`);
    const page = el('div', 'ct-gs-page ct-vlt-page');
    if (state.busy) page.append(el('p', 'ct-gs-note ct-vlt-busy', 'Working…'));
    if (!state.items[state.tab]) {
        page.append(el('p', 'ct-gs-note', 'Loading…'));
    } else if (state.editing) {
        (state.tab === 'scenarios' ? renderScenarioForm : renderNpcForm)(page, state.editing);
    } else {
        const item = current();
        if (item) (state.tab === 'scenarios' ? renderScenario : renderNpc)(page, item);
        else renderEmpty(page);
    }
    body.append(page);
    body.scrollTop = keepScroll;
}

function renderEmpty(page) {
    const box = el('div', 'ct-vlt-empty');
    const isScenario = state.tab === 'scenarios';
    box.innerHTML = `<i class="fa-solid ${isScenario ? 'fa-map' : 'fa-user-group'}" aria-hidden="true"></i>`;
    box.append(el('h3', '', isScenario ? 'Pick a scenario on the left' : 'Pick an NPC on the left'));
    box.append(el('p', 'ct-gs-note', isScenario
        ? 'A scenario keeps a setting, its NPCs and first messages, so you can start new groups or chats from it.'
        : 'NPCs are character sheets you keep between stories. Save them from the Scene panel (character sheet → Save to Vault) or from a scenario.'));
    const actions = el('div', 'ct-vlt-row');
    actions.append(button('ct-cb-btn is-primary', `<i class="fa-solid fa-plus"></i><span>New ${tabInfo().single}</span>`, '', () => startEdit(null)));
    if (isScenario) actions.append(button('ct-cb-btn', '<i class="fa-solid fa-id-card"></i><span>From a character</span>', '', () => void scenarioFromCharacter()));
    box.append(actions);
    page.append(box);
}

function detailHead(item, kind) {
    const head = el('div', 'ct-vlt-head');
    if (kind === 'npcs') head.append(npcFace(item, 'ct-vlt-portrait'));
    const text = el('div', 'ct-vlt-head-text');
    const nameRow = el('div', 'ct-vlt-name-row');
    nameRow.append(el('h2', 'ct-vlt-name', item.name));
    if (kind === 'npcs' && item.role) nameRow.append(el('span', 'ct-vlt-role', item.role));
    const star = button(`ct-vlt-fav${item.favorite ? ' is-on' : ''}`, item.favorite ? '★' : '☆', item.favorite ? 'Remove from favorites' : 'Add to favorites', async () => {
        await saveItem(kind, { ...item, favorite: !item.favorite });
        render();
    });
    star.setAttribute('aria-pressed', String(item.favorite));
    nameRow.append(star);
    text.append(nameRow);
    const sourceText = {
        manual: 'Made by hand',
        card: `Made from the card ${item.sourceName}`,
        scene: `Saved from the Scene panel${item.sourceName ? ` of ${item.sourceName}` : ''}`,
        scenario: `Saved from the scenario ${item.sourceName}`,
        group: `Saved from the group ${item.sourceName}`,
        import: 'Imported',
    }[item.source] ?? item.source;
    text.append(el('div', 'ct-gs-note', [sourceText, `updated ${formatDate(item.updatedAt)}`].filter(Boolean).join(' · ')));
    if (kind === 'scenarios' && item.description) text.append(el('p', 'ct-vlt-desc', item.description));
    if (kind === 'npcs' && str(item.data.description).trim()) text.append(el('p', 'ct-vlt-desc', str(item.data.description).trim()));
    if (kind === 'npcs') {
        const traits = listValue(item.data.traits);
        if (traits.length) text.append(chips(traits, 'ct-gs-chip ct-vlt-trait'));
    }
    if (item.tags.length) text.append(chips(item.tags.map(tag => `#${tag}`), 'ct-gs-chip ct-vlt-tag'));
    head.append(text);
    return head;
}

function actionBar(actions) {
    const bar = el('div', 'ct-vlt-actions');
    for (const action of actions) {
        if (action === 'spacer') {
            bar.append(el('span', 'ct-vlt-grow'));
            continue;
        }
        const b = button(`ct-cb-btn${action.primary ? ' is-primary' : ''}${action.danger ? ' is-danger' : ''}`, `<i class="fa-solid ${action.icon}"></i><span>${action.label}</span>`, action.title ?? '', action.onClick);
        if (action.disabled) {
            b.disabled = true;
            if (action.why) b.title = action.why;
        }
        bar.append(b);
    }
    return bar;
}

async function duplicate(kind, item) {
    const copy = await saveItem(kind, { ...structuredClone(item), id: uid(), name: `${item.name} (copy)`, createdAt: Date.now(), characterAvatar: '' });
    state.selected[kind] = copy.id;
    render();
}

async function remove(kind, item) {
    const answer = await new Popup(`<div class="ct-gm-ask"><h3>Delete "${escapeText(item.name)}"?</h3><p>It is removed from the Vault. Chats, groups and characters made from it are not changed.</p></div>`, POPUP_TYPE.CONFIRM, '', { okButton: 'Delete', cancelButton: 'Cancel' }).show();
    if (answer !== POPUP_RESULT.AFFIRMATIVE) return;
    await deleteItem(kind, item.id);
    state.selected[kind] = null;
    render();
}

// ───────────────────────── Scenario view ─────────────────────────

function renderScenario(page, scenario) {
    const main = card('Scenario', '', { className: 'ct-vlt-card' });
    main.querySelector('.ct-gs-card-head').replaceWith(detailHead(scenario, 'scenarios'));

    const settingHead = el('div', 'ct-gs-field-head');
    settingHead.append(el('span', 'ct-vlt-label', 'Setting'), helpButton('Setting', HELP.setting));
    main.append(settingHead, el('div', 'ct-vlt-text', scenario.setting.trim() || 'No setting yet.'));

    const facts = el('div', 'ct-vlt-facts');
    const fact = (label, value) => {
        const box = el('div', 'ct-vlt-fact');
        box.append(el('span', 'ct-vlt-label', label), el('span', '', value));
        facts.append(box);
    };
    fact('Starts', scenario.startTime || '—');
    fact('Lorebooks', scenario.lorebooks.length ? scenario.lorebooks.map(name => (world_names?.includes(name) ? name : `${name} (missing)`)).join(', ') : '—');
    fact('Opening messages', String(scenario.firstMessages.length));
    main.append(facts);
    page.append(main);

    const npcCard = card(`NPCs (${scenario.npcs.length})`, HELP.npcs);
    if (!scenario.npcs.length) npcCard.append(el('p', 'ct-gs-note', 'No NPCs in this scenario. Edit it to add some.'));
    const grid = el('div', 'ct-vlt-npc-grid');
    const npcs = state.items.npcs ?? [];
    scenario.npcs.forEach((entry, index) => {
        const box = el('div', 'ct-vlt-npc');
        const top = el('div', 'ct-vlt-npc-top');
        top.append(el('span', 'ct-vlt-npc-name', entry.name));
        if (entry.role) top.append(el('span', 'ct-gs-note', entry.role));
        box.append(top);
        if (entry.description) box.append(el('div', 'ct-vlt-npc-desc', entry.description));
        if (entry.relationship) box.append(el('div', 'ct-gs-note', entry.relationship));
        if (entry.traits.length) box.append(chips(entry.traits, 'ct-gs-chip ct-vlt-trait'));
        const saved = npcs.find(npc => npc.id === entry.npcId) ?? npcs.find(npc => npc.name.toLowerCase() === entry.name.toLowerCase());
        const links = el('div', 'ct-vlt-row');
        if (saved) {
            links.append(button('ct-gm-link', 'Open in NPCs', '', () => open('npcs', saved.id)));
            links.append(el('span', `ct-vlt-level is-${npcLevel(saved)}`, LEVEL_LABEL[npcLevel(saved)]));
        } else {
            links.append(button('ct-gm-link', 'Save to NPCs', `Keep ${entry.name} in the NPCs tab`, async () => {
                await saveScenarioNpc(scenario, index);
                render();
            }));
        }
        box.append(links);
        grid.append(box);
    });
    npcCard.append(grid);
    page.append(npcCard);

    const openingCount = scenario.firstMessages.length;
    const index = Math.min(state.opening, Math.max(0, openingCount - 1));
    const nav = el('div', 'ct-vlt-row');
    if (openingCount > 1) {
        nav.append(button('ct-vlt-icon', '<i class="fa-solid fa-chevron-left"></i>', 'Previous first message', () => {
            state.opening = (index - 1 + openingCount) % openingCount;
            render();
        }));
        nav.append(el('span', 'ct-gs-note', `${index + 1} of ${openingCount}`));
        nav.append(button('ct-vlt-icon', '<i class="fa-solid fa-chevron-right"></i>', 'Next first message', () => {
            state.opening = (index + 1) % openingCount;
            render();
        }));
    }
    const openingCard = card(`First messages${openingCount ? '' : ' (none)'}`, HELP.firstMessages, { aside: nav });
    openingCard.append(el('div', 'ct-vlt-text ct-vlt-opening', openingCount ? scenario.firstMessages[index] : 'No first message. Edit the scenario to add one, or the group members\' greetings are used.'));
    page.append(openingCard);

    if (scenario.notes.trim()) {
        const notes = card('Notes');
        notes.append(el('div', 'ct-vlt-text', scenario.notes));
        page.append(notes);
    }

    const hasChat = Boolean(getCurrentChatId());
    page.append(actionBar([
        { icon: 'fa-people-group', label: 'New group from this', primary: true, onClick: () => newGroupFromScenario(scenario) },
        { icon: 'fa-comments', label: 'Use in the open chat', disabled: !hasChat, why: 'Open a chat first', onClick: async () => {
            if (await useScenarioInOpenChat(scenario)) close();
        } },
        'spacer',
        { icon: 'fa-pen', label: 'Edit', onClick: () => startEdit(scenario) },
        { icon: 'fa-clone', label: 'Duplicate', onClick: () => void duplicate('scenarios', scenario) },
        { icon: 'fa-file-export', label: 'Export', onClick: () => exportItem('scenarios', scenario) },
        { icon: 'fa-trash-can', label: 'Delete', danger: true, onClick: () => void remove('scenarios', scenario) },
    ]));
}

function newGroupFromScenario(scenario) {
    const studio = globalThis.HomunculusGroupStudio;
    if (!studio?.create) {
        toastr.error('The Group Studio is not loaded.');
        return;
    }
    close();
    studio.create({ scenarioId: scenario.id, name: scenario.name });
}

// ───────────────────────── Scenario form ─────────────────────────

function startEdit(item) {
    if (!confirmLeaveEdit()) return;
    const kind = state.tab;
    const draft = item ? structuredClone(item) : normalizeFor(kind, { name: '', id: uid() });
    if (!item) draft.name = '';
    if (kind === 'scenarios' && !draft.firstMessages.length) draft.firstMessages = [''];
    state.editing = { isNew: !item, item: draft, dirty: false };
    render();
    requestAnimationFrame(() => root?.querySelector('.ct-vlt-form input')?.focus());
}

function markDirty() {
    if (state.editing) state.editing.dirty = true;
}

function formFooter(onSave) {
    const bar = el('div', 'ct-vlt-actions ct-vlt-form-foot');
    bar.append(el('span', 'ct-vlt-grow'));
    bar.append(button('ct-cb-btn', '<span>Cancel</span>', '', () => {
        state.editing = null;
        render();
    }));
    const save = button('ct-cb-btn is-primary', '<i class="fa-solid fa-check"></i><span>Save</span>', '', async () => {
        save.disabled = true;
        try {
            await onSave();
        } catch (error) {
            toastr.error(String(error?.message ?? error), 'Could not save');
        } finally {
            save.disabled = false;
        }
    });
    save.classList.add('ct-vlt-save');
    bar.append(save);
    return bar;
}

function renderScenarioForm(page, editing) {
    const s = editing.item;
    const form = el('div', 'ct-vlt-form');
    const basics = card(editing.isNew ? 'New scenario' : `Edit: ${s.name}`);
    const nameBox = input(s.name, (v) => {
        s.name = v;
        markDirty();
    }, { placeholder: 'e.g. The Ashen Road' });
    basics.append(field('Name', '', nameBox));
    basics.append(field('Short description', '', input(s.description, (v) => {
        s.description = v;
        markDirty();
    }, { placeholder: 'One line shown in the list, e.g. A party flees north after the Guild burns the river ports.' })));
    basics.append(field('Tags', HELP.tags, input(s.tags.join(', '), (v) => {
        s.tags = splitList(v);
        markDirty();
    }, { placeholder: 'fantasy, travel' })));
    form.append(basics);

    const settingCard = card('Setting', HELP.setting);
    settingCard.append(textarea(s.setting, (v) => {
        s.setting = v;
        markDirty();
    }, { rows: 7, placeholder: 'Where and when the story happens, and the situation at the start.' }));
    settingCard.append(field('Starts', HELP.startTime, input(s.startTime, (v) => {
        s.startTime = v;
        markDirty();
    }, { placeholder: 'Day 1, 06:00' })));
    const loreWrap = el('div', 'ct-gs-chips');
    const drawLore = () => {
        loreWrap.replaceChildren();
        for (const name of s.lorebooks) {
            const chip = el('span', `ct-gs-chip${world_names?.includes(name) ? '' : ' is-missing'}`, name);
            chip.append(button('ct-gs-chip-x', '×', `Remove ${name}`, () => {
                s.lorebooks = s.lorebooks.filter(item => item !== name);
                markDirty();
                drawLore();
            }));
            loreWrap.append(chip);
        }
        const add = el('select', 'text_pole ct-vlt-inline-select');
        add.setAttribute('aria-label', 'Add a lorebook');
        add.append(new Option('+ Add a lorebook…', ''));
        for (const name of (world_names ?? []).filter(item => !s.lorebooks.includes(item))) add.append(new Option(name, name));
        add.addEventListener('change', () => {
            if (!add.value) return;
            s.lorebooks = [...s.lorebooks, add.value];
            markDirty();
            drawLore();
        });
        loreWrap.append(add);
    };
    drawLore();
    const loreField = el('div', 'ct-gs-field');
    const loreHead = el('div', 'ct-gs-field-head');
    loreHead.append(el('span', 'ct-gs-label', 'Lorebooks'), helpButton('Lorebooks', HELP.lorebooks));
    loreField.append(loreHead, loreWrap);
    settingCard.append(loreField);
    form.append(settingCard);

    const npcCard = card('NPCs', HELP.npcs);
    const npcList = el('div', 'ct-vlt-npc-edit-list');
    const drawNpcs = () => {
        npcList.replaceChildren();
        s.npcs.forEach((npc, index) => {
            const row = el('div', 'ct-vlt-npc-edit');
            const grid = el('div', 'ct-vlt-npc-edit-grid');
            grid.append(
                field('Name', '', input(npc.name, (v) => {
                    npc.name = v;
                    markDirty();
                })),
                field('Role', '', input(npc.role, (v) => {
                    npc.role = v;
                    markDirty();
                }, { placeholder: 'Tracker, 41' })),
                field('Relationship', '', input(npc.relationship, (v) => {
                    npc.relationship = v;
                    markDirty();
                }, { placeholder: 'Aria\'s old mentor' })),
                field('Traits', '', input(npc.traits.join(', '), (v) => {
                    npc.traits = splitList(v);
                    markDirty();
                }, { placeholder: 'patient, secretive' })),
            );
            row.append(grid, field('Description', '', textarea(npc.description, (v) => {
                npc.description = v;
                markDirty();
            }, { rows: 2 })));
            const tools = el('div', 'ct-vlt-row');
            tools.append(el('span', 'ct-vlt-grow'));
            tools.append(button('ct-gm-link', 'Remove this NPC', '', () => {
                s.npcs.splice(index, 1);
                markDirty();
                drawNpcs();
            }));
            row.append(tools);
            npcList.append(row);
        });
        if (!s.npcs.length) npcList.append(el('p', 'ct-gs-note', 'No NPCs yet.'));
    };
    drawNpcs();
    const addRow = el('div', 'ct-vlt-row');
    addRow.append(button('menu_button ct-gs-btn', '<i class="fa-solid fa-plus"></i> Add an NPC', '', () => {
        s.npcs.push({ name: '', role: '', description: '', relationship: '', traits: [], npcId: '' });
        markDirty();
        drawNpcs();
        npcList.querySelector('.ct-vlt-npc-edit:last-child input')?.focus();
    }));
    const fromVault = el('select', 'text_pole ct-vlt-inline-select');
    fromVault.setAttribute('aria-label', 'Add an NPC from the Vault');
    fromVault.append(new Option('+ From the NPCs tab…', ''));
    for (const npc of sortItems(state.items.npcs ?? [])) fromVault.append(new Option(npc.name, npc.id));
    fromVault.addEventListener('change', () => {
        const npc = (state.items.npcs ?? []).find(item => item.id === fromVault.value);
        fromVault.value = '';
        if (!npc) return;
        s.npcs.push(npcSummaryForScenario(npc));
        markDirty();
        drawNpcs();
    });
    if ((state.items.npcs ?? []).length) addRow.append(fromVault);
    npcCard.append(npcList, addRow);
    form.append(npcCard);

    const openingCard = card('First messages', HELP.firstMessages);
    const openingList = el('div', 'ct-vlt-opening-list');
    const drawOpenings = () => {
        openingList.replaceChildren();
        s.firstMessages.forEach((text, index) => {
            const row = el('div', 'ct-vlt-opening-edit');
            const head = el('div', 'ct-vlt-row');
            head.append(el('span', 'ct-vlt-label', index === 0 ? 'First message' : `Alternative ${index}`), el('span', 'ct-vlt-grow'));
            if (index > 0) head.append(button('ct-vlt-icon', '<i class="fa-solid fa-arrow-up"></i>', 'Move up', () => {
                [s.firstMessages[index - 1], s.firstMessages[index]] = [s.firstMessages[index], s.firstMessages[index - 1]];
                markDirty();
                drawOpenings();
            }));
            if (index < s.firstMessages.length - 1) head.append(button('ct-vlt-icon', '<i class="fa-solid fa-arrow-down"></i>', 'Move down', () => {
                [s.firstMessages[index + 1], s.firstMessages[index]] = [s.firstMessages[index], s.firstMessages[index + 1]];
                markDirty();
                drawOpenings();
            }));
            head.append(button('ct-vlt-icon', '<i class="fa-solid fa-xmark"></i>', 'Remove this message', () => {
                s.firstMessages.splice(index, 1);
                markDirty();
                drawOpenings();
            }));
            row.append(head, textarea(text, (v) => {
                s.firstMessages[index] = v;
                markDirty();
            }, { rows: 5, placeholder: 'The message the story opens with.' }));
            openingList.append(row);
        });
    };
    drawOpenings();
    openingCard.append(openingList, button('menu_button ct-gs-btn', '<i class="fa-solid fa-plus"></i> Add a first message', '', () => {
        s.firstMessages.push('');
        markDirty();
        drawOpenings();
        openingList.querySelector('.ct-vlt-opening-edit:last-child textarea')?.focus();
    }));
    form.append(openingCard);

    const notesCard = card('Notes');
    notesCard.append(textarea(s.notes, (v) => {
        s.notes = v;
        markDirty();
    }, { rows: 3, placeholder: 'Anything for yourself (not sent to the AI).' }));
    form.append(notesCard);

    form.append(formFooter(async () => {
        if (!s.name.trim()) {
            toastr.warning('Give the scenario a name.');
            nameBox.focus();
            return;
        }
        s.firstMessages = s.firstMessages.filter(text => text.trim());
        s.npcs = s.npcs.filter(npc => npc.name.trim());
        const saved = await saveItem('scenarios', s);
        state.selected.scenarios = saved.id;
        state.editing = null;
        state.opening = 0;
        toastr.success('Scenario saved.');
        render();
    }));
    page.append(form);
}

// ───────────────────────── NPC view ─────────────────────────

function renderNpc(page, npc) {
    const preset = npcPreset(npc);
    const main = card('NPC', '', { className: 'ct-vlt-card' });
    main.querySelector('.ct-gs-card-head').replaceWith(detailHead(npc, 'npcs'));
    const level = npcLevel(npc);
    const levelRow = el('div', 'ct-vlt-row');
    levelRow.append(el('span', `ct-vlt-level is-${level}`, LEVEL_LABEL[level]));
    if (level === 'character') levelRow.append(el('span', 'ct-gs-note', `Card: ${characterByAvatar(npc.characterAvatar)?.name ?? npc.characterAvatar}`));
    main.append(levelRow);

    const missing = [];
    for (const section of preset.sections) {
        if (section.id === 'about') continue;
        const filled = section.fields.map(f => [f, getValue(npc.data, section.id, f.key)]).filter(([f, value]) => isFilled(f, value));
        for (const f of section.fields) if (f.required && !isFilled(f, getValue(npc.data, section.id, f.key))) missing.push(f.label);
        if (!filled.length) continue;
        const stats = filled.filter(([f]) => f.type === 'stat');
        const blocks = filled.filter(([f]) => f.type !== 'stat');
        main.append(el('div', 'ct-vlt-section-title', section.label));
        if (stats.length) {
            const tiles = el('div', 'ct-vlt-tiles');
            for (const [f, value] of stats) {
                const tile = el('div', 'ct-vlt-tile');
                tile.append(el('span', 'ct-vlt-label', f.label), el('span', 'ct-vlt-tile-value', str(value).trim()));
                tiles.append(tile);
            }
            main.append(tiles);
        }
        if (blocks.length) main.append(blockGrid(blocks.map(([f, value], index) => ({ label: f.label, icon: f.icon, color: BLOCK_COLORS[index % BLOCK_COLORS.length], value: f.type === 'list' ? listValue(value) : str(value).trim() }))));
    }
    const sheet = SHEET_SECTIONS.filter(section => str(npc.sheet[section.key]).trim());
    for (const section of SHEET_SECTIONS) if (!str(npc.sheet[section.key]).trim()) missing.push(section.label);
    if (sheet.length) {
        main.append(el('div', 'ct-vlt-section-title', 'Full sheet'));
        main.append(blockGrid(sheet.map(section => ({ label: section.label, icon: section.icon, color: section.color, value: npc.sheet[section.key].trim() }))));
    }
    for (const f of castFields(preset).filter(item => item.section === 'about')) if (f.required && !isFilled(f, getValue(npc.data, 'about', f.key))) missing.unshift(f.label);
    if (missing.length) main.append(el('p', 'ct-gs-note ct-vlt-missing', `Not filled yet: ${missing.join(', ')}.`));
    page.append(main);

    const aiCard = card('Fill the gaps with AI', HELP.fill);
    const aiRow = el('div', 'ct-vlt-row');
    const profileSelect = profilePicker();
    const go = button('menu_button ct-gs-btn', '<i class="fa-solid fa-wand-magic-sparkles"></i> Fill the gaps', '', async () => {
        go.disabled = true;
        go.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Writing…';
        try {
            await fillNpcWithAi(npc, profileSelect.value);
        } catch (error) {
            toastr.error(String(error?.message ?? error), 'Could not fill the sheet');
        } finally {
            render();
        }
    });
    go.disabled = !missing.length;
    aiRow.append(el('span', 'ct-gs-note ct-vlt-grow', missing.length ? `${missing.length} field${missing.length === 1 ? '' : 's'} to write.` : 'Every field is filled.'), profileSelect, go);
    aiCard.append(aiRow);
    page.append(aiCard);

    const used = scenariosWithNpc(npc);
    if (used.length) {
        const usedCard = card('In scenarios');
        const row = el('div', 'ct-vlt-row');
        for (const scenario of used) row.append(button('ct-gm-link', scenario.name, '', () => open('scenarios', scenario.id)));
        usedCard.append(row);
        page.append(usedCard);
    }

    const linked = npc.characterAvatar && characterByAvatar(npc.characterAvatar);
    page.append(actionBar([
        linked
            ? { icon: 'fa-user', label: 'Open the character', primary: true, onClick: () => openCharacter(npc.characterAvatar) }
            : { icon: 'fa-user-plus', label: 'Turn into a character…', primary: true, title: 'Make a character card from this sheet', onClick: async () => {
                try {
                    await makeCharacter(npc);
                } catch (error) {
                    toastr.error(String(error?.message ?? error), 'Could not make the character');
                }
                render();
            } },
        { icon: 'fa-map', label: 'Add to a scenario', onClick: () => void addNpcToScenario(npc) },
        'spacer',
        { icon: 'fa-pen', label: 'Edit', onClick: () => startEdit(npc) },
        { icon: 'fa-clone', label: 'Duplicate', onClick: () => void duplicate('npcs', npc) },
        { icon: 'fa-file-export', label: 'Export', onClick: () => exportItem('npcs', npc) },
        { icon: 'fa-trash-can', label: 'Delete', danger: true, onClick: () => void remove('npcs', npc) },
    ]));
}

function blockGrid(blocks) {
    const grid = el('div', 'ct-vlt-blocks');
    for (const block of blocks) {
        const box = el('div', 'ct-vlt-block');
        box.style.setProperty('--vlt-c', block.color);
        const label = el('div', 'ct-vlt-block-label');
        label.innerHTML = block.icon ? `<i class="fa-solid ${block.icon}" aria-hidden="true"></i>` : '';
        label.append(el('span', '', block.label));
        box.append(label);
        if (Array.isArray(block.value)) box.append(chips(block.value));
        else box.append(el('div', 'ct-vlt-block-text', block.value));
        grid.append(box);
    }
    return grid;
}

async function openCharacter(avatar) {
    const id = characters.findIndex(character => character.avatar === avatar);
    if (id < 0) {
        toastr.warning('That character is not in your library any more.');
        return;
    }
    close();
    await selectCharacterById(id);
}

// ───────────────────────── NPC form ─────────────────────────

function renderNpcForm(page, editing) {
    const npc = editing.item;
    const form = el('div', 'ct-vlt-form');
    const basics = card(editing.isNew ? 'New NPC' : `Edit: ${npc.name}`);
    const nameBox = input(npc.name === 'Unnamed' ? '' : npc.name, (v) => {
        npc.name = v;
        npc.data.name = v;
        markDirty();
    }, { placeholder: 'Name' });
    basics.append(field('Name', '', nameBox));
    basics.append(field('Role', '', input(npc.role, (v) => {
        npc.role = v;
        npc.data.role = v;
        markDirty();
    }, { placeholder: 'Tracker, ferry keeper, ship AI…' })));
    basics.append(field('Tags', HELP.tags, input(npc.tags.join(', '), (v) => {
        npc.tags = splitList(v);
        markDirty();
    }, { placeholder: 'fantasy, guild' })));
    const presetSelect = el('select', 'text_pole');
    presetSelect.id = `ct-vlt-f${++fieldCounter}`;
    for (const preset of listPresets('cast')) presetSelect.append(new Option(preset.name, preset.id, false, preset.id === npc.presetId));
    presetSelect.addEventListener('change', () => {
        npc.presetId = presetSelect.value;
        markDirty();
        render();
    });
    basics.append(field('Fields', HELP.preset, presetSelect));
    form.append(basics);

    const preset = npcPreset(npc);
    for (const section of preset.sections) {
        const sectionCard = card(section.label);
        const tiles = el('div', 'ct-vlt-form-grid');
        for (const f of section.fields) {
            const value = getValue(npc.data, section.id, f.key);
            const set = (v) => {
                setValue(npc.data, section.id, f.key, f.type === 'list' ? splitList(v) : v);
                markDirty();
            };
            const control = f.type === 'text'
                ? textarea(value, set, { rows: 2, placeholder: f.hint })
                : input(f.type === 'list' ? listValue(value).join(', ') : value, set, { placeholder: f.type === 'list' ? `${f.hint} (separate with commas)` : f.hint });
            const wrap = field(`${f.label}${f.required ? '' : ' (optional)'}`, '', control);
            if (f.type === 'text') wrap.classList.add('ct-vlt-wide');
            tiles.append(wrap);
        }
        sectionCard.append(tiles);
        form.append(sectionCard);
    }

    const sheetCard = card('Full sheet');
    for (const section of SHEET_SECTIONS) {
        sheetCard.append(field(section.label, '', textarea(npc.sheet[section.key], (v) => {
            npc.sheet[section.key] = v;
            markDirty();
        }, { rows: 3, placeholder: section.hint })));
    }
    form.append(sheetCard);

    form.append(formFooter(async () => {
        if (!str(npc.name).trim() || npc.name === 'Unnamed') {
            toastr.warning('Give the NPC a name.');
            nameBox.focus();
            return;
        }
        const saved = await saveItem('npcs', npc);
        state.selected.npcs = saved.id;
        state.editing = null;
        toastr.success('NPC saved.');
        render();
    }));
    page.append(form);
}

// ───────────────────────── Open / close ─────────────────────────

async function refreshData() {
    try {
        await Promise.all([load('scenarios', { force: true }), load('npcs', { force: true })]);
    } catch (error) {
        toastr.error(String(error?.message ?? error), 'Vault');
        state.items.scenarios ??= [];
        state.items.npcs ??= [];
    }
    if (state.open) render();
}

/**
 * Opens the Vault.
 * @param {'scenarios'|'npcs'} [tab]
 * @param {string} [id] item to show
 */
export function open(tab = '', id = '') {
    if (!root) build();
    if (tab && TABS.some(item => item.id === tab)) {
        if (state.tab !== tab) state.editing = null;
        state.tab = tab;
    }
    if (id) {
        state.selected[state.tab] = id;
        state.editing = null;
        state.opening = 0;
    }
    const home = globalThis.HomunculusClassicHome;
    if (!state.open) {
        home?.closeHome?.();
        globalThis.HomunculusGroupStudio?.close?.();
        state.open = true;
        returnFocus = document.activeElement;
        document.body.classList.add('ct-cb-open');
        root.classList.add('is-open');
        home?.setView?.(VIEW_ID);
        setButtonState(true);
        void refreshData();
    }
    render();
}

export function close() {
    if (!state.open) return;
    state.open = false;
    state.editing = null;
    closeHelp();
    root?.classList.remove('is-open');
    document.body.classList.remove('ct-cb-open');
    setButtonState(false);
    const home = globalThis.HomunculusClassicHome;
    if (home?.getView?.() === VIEW_ID) home.setView('chat');
    if (returnFocus instanceof HTMLElement && document.contains(returnFocus)) returnFocus.focus();
}

function toggle() {
    if (state.open) close(); else open();
}

function setButtonState(isOpen) {
    const wrap = document.getElementById(VIEW_ID);
    wrap?.classList.toggle('is-open', isOpen);
    const icon = wrap?.querySelector('.drawer-icon');
    icon?.classList.toggle('openIcon', isOpen);
    icon?.classList.toggle('closedIcon', !isOpen);
}

function addTopButton() {
    const holder = document.getElementById('top-settings-holder');
    if (!holder || document.getElementById(VIEW_ID)) return;
    const wrap = el('div', 'drawer');
    wrap.id = VIEW_ID;
    wrap.innerHTML = '<div class="ct-home-toggle" role="button" tabindex="0" title="Vault: scenarios and NPCs" aria-label="Vault"><div class="drawer-icon fa-solid fa-vault fa-fw closedIcon"></div></div>';
    const anchor = document.getElementById('ct-group-studio') ?? document.getElementById('rightNavHolder');
    if (anchor?.parentElement === holder) anchor.after(wrap); else holder.append(wrap);
    const toggleEl = wrap.querySelector('.ct-home-toggle');
    toggleEl.addEventListener('click', toggle);
    toggleEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
        }
    });
}

function init() {
    addTopButton();
    // The Group Studio adds its button on load too; wait a tick so the Vault sits right after it.
    setTimeout(() => {
        const wrap = document.getElementById(VIEW_ID);
        const studio = document.getElementById('ct-group-studio');
        if (wrap && studio && studio.nextElementSibling !== wrap) studio.after(wrap);
    }, 0);
    document.addEventListener('ct:view-changed', (event) => {
        if (state.open && event.detail?.view !== VIEW_ID) close();
    });
    document.addEventListener('click', (event) => {
        const toggleEl = /** @type {HTMLElement} */ (event.target)?.closest?.('#top-settings-holder > .drawer > .drawer-toggle');
        if (state.open && toggleEl) close();
    }, true);
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || !state.open) return;
        if (document.querySelector('.ct-help-card, dialog[open]')) return;
        if (state.editing) return;
        close();
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        if (state.open) render();
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}

globalThis.HomunculusVault = {
    open,
    close,
    listItems,
    getItem,
    scenarioText,
    applyScenarioToOpenChat,
    useScenarioInOpenChat,
    saveChatScenario,
    saveNpcFromScene,
    VAULT_CHANGED_EVENT,
};
