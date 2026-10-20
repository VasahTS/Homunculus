// Classic UI fork: Group Studio.
//
// A page of its own (like the Card Browser) where groups are made and set up. The list of groups is
// on the left; the chosen group has a header (avatars, name, Open chat, Duplicate / Delete) and tabs:
// Setup (name, mode, narrator, scenario), Cast, Scene (the Scene trackers), Chats, Profile (preset,
// persona, lorebooks), Agents and Behavior. The rules live elsewhere: the profile in
// classic-group-profile.js, Narrated mode and cast sheets in classic-group-campaign.js, the Scene panel
// in classic-scene.js; this file is only the page.
//
// Open it from its own button in the top bar, the "Create New Chat Group" button in the Characters
// panel, the sliders button in the group panel, "Group Studio" in the bar above a group chat, or with
// globalThis.HomunculusGroupStudio.open(groupId, tab) / .create().

import { helpButton, closeHelp } from './classic-help.js';
import {
    groups,
    selected_group,
    openGroupId,
    openGroupById,
    editGroup,
    deleteGroup,
    getGroupPastChats,
    openGroupChat,
    createNewGroupChat,
    deleteGroupChat,
} from './group-chats.js';
import { getPresetManager } from './preset-manager.js';
import { power_user } from './power-user.js';
import { world_names } from './world-info.js';
import { humanizedDateTime } from './RossAscends-mods.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { extension_settings } from './extensions.js';
import {
    eventSource,
    event_types,
    characters,
    chat_metadata,
    default_avatar,
    getCharacters,
    getRequestHeaders,
    getThumbnailUrl,
    saveMetadata,
    saveSettingsDebounced,
} from '../script.js';
import {
    AGENT_MODES,
    PROFILE_CHANGED_EVENT,
    applyAgentChoice,
    enterHere,
    findGroup,
    getProfile,
    isActive,
    normalizeProfile,
    saveProfile,
    setAgentChoice,
    setShouldAsk,
    shouldAsk,
    skipAskOnce,
} from './classic-group-profile.js';
import {
    CAST_STATES,
    DEFAULT_TURN_PROMPT,
    castMembers,
    createBuiltinNarrator,
    defaultSheet,
    editCastSheet,
    getCampaign,
    narratorAvatar,
    normalizeCampaign,
    saveCampaign,
    updateBuiltinNarrator,
} from './classic-group-campaign.js';

const VIEW_ID = 'ct-group-studio';

const TABS = [
    { id: 'setup', label: 'Setup', icon: 'fa-wand-magic-sparkles' },
    { id: 'cast', label: 'Cast', icon: 'fa-users' },
    { id: 'scene', label: 'Scene', icon: 'fa-masks-theater' },
    { id: 'chats', label: 'Chats', icon: 'fa-comments', existingOnly: true },
    { id: 'profile', label: 'Profile', icon: 'fa-id-card' },
    { id: 'agents', label: 'Agents', icon: 'fa-robot' },
    { id: 'behavior', label: 'Behavior', icon: 'fa-sliders' },
];

const SCENE_TRACKERS = [
    {
        kind: 'world',
        templateId: 'tpl-homunculus-scene-world',
        icon: 'fa-earth-americas',
        title: 'World',
        text: 'Time, place, weather, quests, items and factions. Add your own fields in its prompt.',
    },
    {
        kind: 'cast',
        templateId: 'tpl-homunculus-scene-characters',
        icon: 'fa-user-group',
        title: 'Characters',
        text: 'Who is in the scene, and how they look right now: face, hair, eyes, body, outfit, marks, mood.',
    },
];

const HELP = {
    page: `<p>Make and set up your groups here.</p>
<p>Pick a group on the left, or press <b>New group</b>. Changes to an existing group are saved right away.</p>
<p>The <b>Profile</b> and <b>Agents</b> tabs are applied when you open one of the group's chats ("group mode"), and your own settings come back when you leave.</p>`,
    name: '<p>The name shown in your character list and above the chat. Leave it empty for a new group and the member names are used.</p>',
    mode: `<ul>
<li><b>Ensemble</b>: a normal group chat. Each character replies in turn, with their own card.</li>
<li><b>Narrated</b>: one <b>narrator</b> replies and voices everyone. The other members are the <b>cast</b>: they never reply on their own, and their sheets are given to the narrator instead of their whole cards.</li>
</ul>
<p>You can still make a cast member speak by hand with the member bar under the chat.</p>`,
    narrator: `<p>Who tells the story.</p>
<ul>
<li><b>Use one of my characters</b>: pick a narrator card you already have.</li>
<li><b>Built-in narrator</b>: write how the narrator should tell the story. The Studio keeps a small card for it (named "Narrator (group name)") so you don't have to make one.</li>
</ul>`,
    turn: `<p>The instruction the AI gets right before it writes, in place of the usual group rule "write only as {{char}}" (that rule made the narrator refuse to voice anyone else).</p>
<p>Leave it empty to use the default. <code>{{char}}</code> is the narrator and <code>{{user}}</code> is you.</p>`,
    placement: `<p>On: the cast sheets go into the prompt by themselves.</p>
<p>Off: they only go where your preset writes <code>{{cast}}</code>, so you can place them yourself.</p>`,
    scenario: `<p>The scenario of the open chat. It replaces the cards' scenarios, so the whole group shares one setup.</p>
<p>Each chat and branch keeps its own, so you can start a new chat with a different situation.</p>`,
    members: `<p>The characters in this group.</p>
<ul>
<li>Use the arrows to change the order (used by "List order").</li>
<li>The speech bubble <b>mutes</b> a character: they stay in the group but don't reply on their own.</li>
<li>The <b>×</b> takes a character out of the group.</li>
</ul>`,
    cast: `<ul>
<li><b>In scene</b>: the whole sheet goes to the AI.</li>
<li><b>Offscreen</b>: only one line goes, so the narrator knows they exist.</li>
<li><b>Off</b>: nothing is sent.</li>
</ul>
<p><b>Sheet</b>: a clean version of the card without instructions, scenario or first message. Without one, the card's description and personality are used. The card itself is never changed.</p>`,
    add: '<p>Search your characters by name and click one to add it to the group.</p>',
    scene: `<p>The <b>Scene panel</b> beside the chat shows who is in the scene, what they look like, and the world (time, place, quests, items).</p>
<p>It is filled by two <b>Scene trackers</b>. They are In-Chat Agents, so they work like any agent:</p>
<ul>
<li>After each reply, each one makes its own AI call and saves the result in that message (swipes and branches keep the right scene).</li>
<li><b>Edit prompt</b> opens the agent editor: change what they track, add fields, or make them stricter.</li>
<li>Pick a cheap, fast <b>connection profile</b> for them; they don't need your best model.</li>
</ul>
<p>Switching one on here only turns it on for this group (in group mode). Your other chats are not changed.</p>`,
    sceneSend: '<p>When this is on, a short copy of the scene goes to the AI before each reply, so it remembers outfits, wounds, the time and the quests. Turn it off to keep the panel just for you.</p>',
    chats: `<p>Every chat of this group. Branches are listed under the chat they came from.</p>
<p><b>Open</b> switches to that chat. <b>New chat</b> starts a fresh one with the narrator's (or members') greeting.</p>`,
    ask: `<p>When this is on, opening one of this group's chats shows what will change and asks first.</p>
<p>It only asks when something would actually change. If your current preset has unsaved changes, it always warns you, even with this off.</p>`,
    preset: `<p>The Chat Completion preset (prompts and sampler settings) used in this group, for example an RPG prompt set you don't want in normal chats.</p>
<p>Your API and model stay as they are, unless "Bind to Connection" is on in your preset settings.</p>
<p><b>Keep current</b>: use whatever preset is selected.</p>`,
    persona: `<p>The persona you play as in this group's chats.</p>
<p><b>Keep current</b>: use whatever persona is selected. A persona locked to a chat or character still wins when you leave the group.</p>`,
    lorebooks: `<p>Lorebooks that are scanned while this group's chat is open, on top of your global lorebooks.</p>
<p>They are not added to your global selection, so they stop working as soon as you leave the group.</p>`,
    agents: `<p>Which In-Chat Agents run in this group's chats.</p>
<ul>
<li><b>Keep current</b>: your usual agents for group chats.</li>
<li><b>Only these</b>: only the agents ticked here. Good for a campaign tracker that only makes sense in this story.</li>
<li><b>Add to my usual</b>: your usual agents, plus the ones you tick here, minus the ones you untick here.</li>
</ul>
<p>Your own agent lists are not changed. The pencil opens an agent's editor.</p>`,
    behavior: `<ul>
<li><b>Who replies</b>: Natural order picks whoever is mentioned or fits; List order goes down the member list; Pooled order gives everyone a turn; Manual means nobody replies until you pick someone.</li>
<li><b>Character cards sent</b>: Swap sends only the card of whoever is replying; Join sends every member's card; "include muted" also sends the muted ones.</li>
<li><b>Allow self responses</b>: a character may reply right after itself.</li>
</ul>`,
};

const STRATEGIES = [[0, 'Natural order'], [1, 'List order'], [3, 'Pooled order'], [2, 'Manual']];
const GEN_MODES = [[0, 'Swap: only the speaker\'s card'], [1, 'Join: every member\'s card'], [2, 'Join, include muted members']];

// ───────────────────────── Helpers ─────────────────────────

function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function option(value, label, selected) {
    const node = el('option', '', label);
    node.value = String(value);
    node.selected = selected;
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

/** A card with a title row (title, "?" and optional things on the right). */
function card(title, help = '', { className = '', aside = null, intro = '' } = {}) {
    const section = el('section', `ct-gs-card${className ? ` ${className}` : ''}`);
    const head = el('div', 'ct-gs-card-head');
    const titleRow = el('div', 'ct-gs-title-row');
    titleRow.append(el('h3', 'ct-gs-title', title));
    if (help) titleRow.append(helpButton(title, help));
    head.append(titleRow);
    if (aside) head.append(aside);
    section.append(head);
    if (intro) section.append(el('p', 'ct-gs-intro', intro));
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

function checkRow(text, checked, onChange, help = '') {
    const row = el('div', 'ct-gs-field-head');
    const label = el('label', 'ct-gs-check');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = checked;
    box.addEventListener('change', () => onChange(box.checked));
    label.append(box, el('span', '', text));
    row.append(label);
    if (help) row.append(helpButton(text, help));
    return row;
}

function segment(label, items, value, onPick, small = false) {
    const wrap = el('div', `ct-gs-segment${small ? ' ct-gs-segment-small' : ''}`);
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', label);
    for (const [v, text] of items) {
        const isOn = v === value;
        const b = button(isOn ? 'is-on' : '', text, '', () => {
            if (!isOn) onPick(v);
        });
        b.setAttribute('aria-pressed', String(isOn));
        wrap.append(b);
    }
    return wrap;
}

function toggleSwitch(label, checked, onChange) {
    const wrap = el('label', 'ct-gs-switch');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = checked;
    box.setAttribute('role', 'switch');
    box.addEventListener('change', () => onChange(box.checked));
    wrap.append(box, el('span', 'ct-gs-switch-track', ''), el('span', 'ct-gs-switch-label', label));
    return wrap;
}

function avatarImg(avatar, className = 'ct-gs-avatar') {
    const img = el('img', className);
    img.alt = '';
    img.loading = 'lazy';
    img.src = avatar ? getThumbnailUrl('avatar', avatar) : default_avatar;
    return img;
}

const characterByAvatar = avatar => characters.find(character => character.avatar === avatar);
const characterName = avatar => characterByAvatar(avatar)?.name ?? String(avatar).replace(/\.[^.]+$/, '');

function agentsApi() {
    return globalThis.HomunculusAgents ?? null;
}

function listAgents() {
    const api = agentsApi();
    if (!api?.getAgents) return [];
    return api.getAgents()
        .filter(agent => agent?.id && !api.isAgentHidden?.(agent.id))
        .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));
}

const usualEnabled = agent => Boolean(agentsApi()?.isAgentEnabledIgnoringGroupProfile?.(agent, 'group'));

/** Whether an agent runs in this group (given its profile). */
function agentOnInGroup(profile, agent) {
    const usual = usualEnabled(agent);
    if (profile.agents.mode === AGENT_MODES.KEEP) return usual;
    if (profile.agents.mode === AGENT_MODES.ONLY) return profile.agents.on.includes(agent.id);
    return profile.agents.on.includes(agent.id) || (usual && !profile.agents.off.includes(agent.id));
}

function connectionProfiles() {
    const list = extension_settings.connectionManager?.profiles;
    return Array.isArray(list) ? list.filter(profile => profile?.id).map(profile => ({ id: profile.id, name: String(profile.name || profile.id) })) : [];
}

function formatWhen(value) {
    const time = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
    if (!Number.isFinite(time)) return '';
    const date = new Date(time);
    const sameDay = date.toDateString() === new Date().toDateString();
    return sameDay ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : date.toLocaleDateString([], { day: 'numeric', month: 'short', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

// ───────────────────────── State ─────────────────────────

function emptyDraft() {
    return {
        name: '',
        members: [],
        disabled: [],
        profile: normalizeProfile(null),
        campaign: normalizeCampaign(null),
        behavior: { activation_strategy: 0, generation_mode: 0, allow_self_responses: false },
    };
}

const state = {
    open: false,
    /** 'edit' an existing group or make a 'new' one */
    mode: 'edit',
    groupId: null,
    tab: 'setup',
    draft: emptyDraft(),
    groupSearch: '',
    charSearch: '',
    agentSearch: '',
    creating: false,
    menuOpen: false,
    /** { groupId, list, loading } */
    chats: null,
};
let root = null;
let returnFocus = null;

const group = () => (state.mode === 'edit' ? findGroup(state.groupId) : null);

/** The thing being edited, the same way for a saved group and for a new one. */
function target() {
    const g = group();
    if (g) {
        return {
            isNew: false,
            name: g.name,
            members: Array.isArray(g.members) ? g.members : [],
            disabled: Array.isArray(g.disabled_members) ? g.disabled_members : [],
            profile: getProfile(g),
            campaign: getCampaign(g),
            behavior: {
                activation_strategy: Number(g.activation_strategy ?? 0),
                generation_mode: Number(g.generation_mode ?? 0),
                allow_self_responses: Boolean(g.allow_self_responses),
            },
        };
    }
    return { isNew: true, ...state.draft };
}

async function setMembers(members, disabled) {
    const g = group();
    const cleanDisabled = disabled.filter(avatar => members.includes(avatar));
    if (!g) {
        state.draft.members = members;
        state.draft.disabled = cleanDisabled;
        render();
        return;
    }
    g.members = members;
    g.disabled_members = cleanDisabled;
    await editGroup(g.id, true, true);
    render();
}

async function setName(name) {
    const g = group();
    if (!g) {
        state.draft.name = name;
        renderHeader();
        return;
    }
    const clean = name.trim();
    if (!clean || clean === g.name) return;
    g.name = clean;
    await editGroup(g.id, true, true);
    renderHeader();
    renderSide();
}

async function setBehavior(patch) {
    const g = group();
    if (!g) {
        Object.assign(state.draft.behavior, patch);
        return;
    }
    Object.assign(g, patch);
    await editGroup(g.id, true, false);
}

async function setProfile(patch) {
    const g = group();
    if (!g) {
        state.draft.profile = { ...state.draft.profile, ...patch, agents: { ...state.draft.profile.agents, ...(patch.agents ?? {}) } };
        render();
        return;
    }
    await saveProfile(g.id, patch);
}

async function setCampaign(patch) {
    const g = group();
    if (!g) {
        const current = state.draft.campaign;
        state.draft.campaign = normalizeCampaign({ ...current, ...patch, narrator: { ...current.narrator, ...(patch.narrator ?? {}) } });
        render();
        return;
    }
    await saveCampaign(g.id, patch);
    render();
}

/** Switches Ensemble / Narrated. Narrated sends only the narrator's card (Swap), so the old choice is kept. */
async function setMode(mode) {
    const t = target();
    if (t.campaign.mode === mode) return;
    const g = group();
    if (g) {
        if (mode === 'narrated') {
            await saveCampaign(g.id, { mode, previousGenerationMode: Number(g.generation_mode ?? 0) });
            g.generation_mode = 0;
        } else {
            g.generation_mode = t.campaign.previousGenerationMode ?? Number(g.generation_mode ?? 0);
            await saveCampaign(g.id, { mode, previousGenerationMode: null });
        }
        await editGroup(g.id, true, false);
        render();
        return;
    }
    state.draft.behavior.generation_mode = 0;
    await setCampaign({ mode });
}

/** Picks the narrator. The old narrator leaves the group; the new one goes first in the members. */
async function setNarrator(patch) {
    const t = target();
    const before = narratorAvatar(t.campaign);
    const next = normalizeCampaign({ ...t.campaign, narrator: { ...t.campaign.narrator, ...patch } });
    const after = narratorAvatar(next);
    let members = t.members.filter(avatar => avatar !== before || avatar === after);
    if (after) members = [after, ...members.filter(avatar => avatar !== after)];
    const g = group();
    if (g) {
        await saveCampaign(g.id, { narrator: next.narrator });
    } else {
        state.draft.campaign = next;
    }
    await setMembers(members, t.disabled);
}

async function saveBuiltinStyle(style) {
    const t = target();
    const g = group();
    if (!g) {
        state.draft.campaign = normalizeCampaign({ ...t.campaign, narrator: { ...t.campaign.narrator, style } });
        return;
    }
    try {
        let avatar = t.campaign.narrator.builtinAvatar;
        if (avatar && characters.some(character => character.avatar === avatar)) {
            await updateBuiltinNarrator(avatar, style);
            await saveCampaign(g.id, { narrator: { style } });
        } else {
            avatar = await createBuiltinNarrator(g.name, style);
            await setNarrator({ type: 'builtin', style, builtinAvatar: avatar });
        }
        toastr.success('Narrator saved.');
    } catch (error) {
        toastr.error(String(error?.message ?? error), 'Narrator');
    }
}

async function chooseAgent(agentId, enabled, usual) {
    const g = group();
    if (!g) {
        state.draft.profile = applyAgentChoice(state.draft.profile, agentId, enabled, usual);
        render();
        return;
    }
    setAgentChoice(g.id, agentId, enabled, usual);
}

/** Turns a Scene tracker on or off for this group (adds the agent from its template when needed). */
async function setTracker(tracker, enabled) {
    const api = agentsApi();
    if (!api?.ensureTemplateAgent) {
        toastr.error('In-Chat Agents are not loaded.');
        return;
    }
    const agent = await api.ensureTemplateAgent(tracker.templateId);
    if (!agent) {
        toastr.error('The Scene tracker template is missing.');
        return;
    }
    const t = target();
    const usual = usualEnabled(agent);
    let profile = t.profile;
    if (profile.agents.mode === AGENT_MODES.KEEP) {
        if (enabled === usual) return;
        profile = { ...profile, agents: { mode: AGENT_MODES.ADD, on: [], off: [] } };
    }
    profile = applyAgentChoice(profile, agent.id, enabled, usual);
    await setProfile({ agents: profile.agents });
    globalThis.HomunculusScene?.refresh?.();
    render();
}

// ───────────────────────── Page shell ─────────────────────────

function build() {
    root = el('div', 'ct-cb ct-gs');
    root.id = 'ct-group-studio-page';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Group Studio');
    root.innerHTML = `
        <header class="ct-cb-header">
            <button type="button" class="ct-cb-btn ct-cb-back" title="Back"><i class="fa-solid fa-arrow-left"></i></button>
            <div class="ct-gs-avatars" aria-hidden="true"></div>
            <div class="ct-cb-titles">
                <div class="ct-cb-kicker">Group Studio</div>
                <div class="ct-cb-title"><span class="ct-gs-name"></span></div>
                <div class="ct-cb-sub"></div>
            </div>
            <div class="ct-gs-head-actions"></div>
        </header>
        <div class="ct-gs-shell">
            <aside class="ct-gs-side" aria-label="Groups"></aside>
            <div class="ct-gs-main">
                <nav class="ct-gs-tabs" role="tablist" aria-label="Group settings"></nav>
                <div class="ct-gs-body" role="tabpanel"></div>
                <div class="ct-gs-footer"></div>
            </div>
        </div>`;
    root.querySelector('.ct-cb-titles .ct-cb-title').append(helpButton('Group Studio', HELP.page));
    root.querySelector('.ct-cb-back').addEventListener('click', close);
    root.addEventListener('click', (event) => {
        if (state.menuOpen && !(/** @type {HTMLElement} */ (event.target)).closest?.('.ct-gs-menu-wrap')) {
            state.menuOpen = false;
            renderHeader();
        }
    });
    document.body.append(root);
}

function renderHeader() {
    const t = target();
    const g = group();
    root.querySelector('.ct-gs-name').textContent = t.isNew ? (t.name.trim() || 'New group') : t.name;
    const count = t.members.length;
    const status = t.isNew ? 'Not created yet'
        : isActive(g.id) ? 'Group mode is on in the open chat'
            : String(selected_group) === String(g.id) ? 'Open now · group mode off' : '';
    const mode = t.campaign.mode === 'narrated' ? 'Narrated' : 'Ensemble';
    root.querySelector('.ct-cb-sub').textContent = [mode, `${count} member${count === 1 ? '' : 's'}`, status].filter(Boolean).join(' · ');
    const avatars = root.querySelector('.ct-gs-avatars');
    avatars.replaceChildren(...t.members.slice(0, 5).map(avatar => avatarImg(avatar, '')));
    if (!t.members.length) avatars.append(el('span', 'ct-gs-avatar-empty', ''));
    const actions = root.querySelector('.ct-gs-head-actions');
    actions.replaceChildren();
    if (t.isNew) return;
    actions.append(button('ct-cb-btn is-primary', '<i class="fa-solid fa-comments"></i><span>Open chat</span>', '', async () => {
        const id = g.id;
        close();
        if (String(selected_group) !== String(id)) await openGroupById(id);
    }));
    const wrap = el('div', 'ct-gs-menu-wrap');
    const more = button('ct-cb-btn ct-gs-more', '<i class="fa-solid fa-ellipsis"></i>', 'More', () => {
        state.menuOpen = !state.menuOpen;
        renderHeader();
    });
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', String(state.menuOpen));
    wrap.append(more);
    if (state.menuOpen) {
        const menu = el('div', 'ct-gs-menu');
        menu.setAttribute('role', 'menu');
        const item = (icon, text, onClick, danger = false) => {
            const b = button(`ct-gs-menu-item${danger ? ' is-danger' : ''}`, `<i class="fa-solid ${icon}"></i><span>${text}</span>`, '', () => {
                state.menuOpen = false;
                renderHeader();
                void onClick();
            });
            b.setAttribute('role', 'menuitem');
            menu.append(b);
        };
        item('fa-clone', 'Duplicate group', () => duplicateGroup(g.id));
        item('fa-table-columns', 'Open in the old group panel', async () => {
            const id = g.id;
            close();
            await openGroupById(id);
        });
        item('fa-trash-can', 'Delete group…', () => removeGroup(g.id), true);
        wrap.append(menu);
    }
    actions.append(wrap);
}

function renderSide() {
    const side = root.querySelector('.ct-gs-side');
    side.replaceChildren();
    side.append(button(`ct-cb-btn ct-gs-new${state.mode === 'new' ? ' is-primary' : ''}`, '<i class="fa-solid fa-plus"></i><span>New group</span>', '', () => create()));
    const search = el('input', 'text_pole ct-gs-search');
    search.type = 'search';
    search.placeholder = 'Search groups…';
    search.value = state.groupSearch;
    search.setAttribute('aria-label', 'Search groups');
    const list = el('div', 'ct-gs-group-list');
    const fill = () => {
        list.replaceChildren();
        const term = state.groupSearch.trim().toLowerCase();
        const items = [...groups]
            .filter(g => !term || String(g.name).toLowerCase().includes(term))
            .sort((a, b) => Number(b.date_last_chat ?? 0) - Number(a.date_last_chat ?? 0));
        for (const g of items) {
            const isOn = state.mode === 'edit' && String(g.id) === String(state.groupId);
            const item = button(`ct-gs-group${isOn ? ' is-on' : ''}`, '', '', () => open(g.id));
            if (isOn) item.setAttribute('aria-current', 'true');
            const faces = el('span', 'ct-gs-group-faces');
            faces.append(...(g.members ?? []).slice(0, 3).map(avatar => avatarImg(avatar, '')));
            const text = el('span', 'ct-gs-group-text');
            text.append(el('span', 'ct-gs-group-name', g.name));
            const narrated = getCampaign(g).mode === 'narrated';
            const meta = [narrated ? 'Narrated' : 'Ensemble', `${(g.members ?? []).length} members`];
            if (String(selected_group) === String(g.id)) meta.push('open');
            text.append(el('span', 'ct-gs-group-meta', meta.join(' · ')));
            item.append(faces, text);
            list.append(item);
        }
        if (!items.length) list.append(el('p', 'ct-gs-note', term ? 'No groups match.' : 'No groups yet. Press New group to make one.'));
    };
    search.addEventListener('input', () => {
        state.groupSearch = search.value;
        fill();
    });
    side.append(search, list);
    fill();
}

function visibleTabs(t) {
    return TABS.filter(tab => !(tab.existingOnly && t.isNew));
}

function renderTabs(t) {
    const nav = root.querySelector('.ct-gs-tabs');
    nav.replaceChildren();
    for (const tab of visibleTabs(t)) {
        const isOn = tab.id === state.tab;
        const b = button(`ct-gs-tab${isOn ? ' is-on' : ''}`, `<i class="fa-solid ${tab.icon}" aria-hidden="true"></i><span>${tab.label}</span>`, '', () => {
            state.tab = tab.id;
            render();
            root.querySelector('.ct-gs-body').scrollTop = 0;
        });
        b.id = `ct-gs-tab-${tab.id}`;
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', String(isOn));
        const badge = tabBadge(tab.id, t);
        if (badge) b.append(el('span', 'ct-gs-tab-badge', badge));
        nav.append(b);
    }
}

function tabBadge(id, t) {
    if (id === 'cast') return String(t.members.length);
    if (id === 'scene') {
        const api = agentsApi();
        if (!api?.getAgents) return '';
        const on = SCENE_TRACKERS.filter(tracker => api.getAgents().some(agent => agent.sourceTemplateId === tracker.templateId && agentOnInGroup(t.profile, agent))).length;
        return on ? `${on}/2` : '';
    }
    if (id === 'chats') return String(group()?.chats?.length ?? '');
    return '';
}

// ───────────────────────── Setup tab ─────────────────────────

function renderSetup(body, t) {
    const basics = card(t.isNew ? 'New group' : 'Basics', HELP.page);
    const name = el('input', 'text_pole');
    name.id = 'ct-gs-group-name';
    name.type = 'text';
    name.placeholder = t.isNew ? 'Name (optional), e.g. The Ashen Road' : 'Group name';
    name.value = t.name;
    name.addEventListener(t.isNew ? 'input' : 'change', () => void setName(name.value));
    basics.append(field('Name', HELP.name, name));

    const modeHead = el('div', 'ct-gs-field-head');
    modeHead.append(el('span', 'ct-gs-label', 'Mode'), helpButton('Mode', HELP.mode));
    const tiles = el('div', 'ct-gs-tiles');
    tiles.setAttribute('role', 'radiogroup');
    tiles.setAttribute('aria-label', 'Mode');
    for (const [mode, icon, title, text] of [
        ['ensemble', 'fa-users', 'Ensemble', 'Each character replies in turn, with their own card. A normal group chat.'],
        ['narrated', 'fa-feather-pointed', 'Narrated', 'One narrator replies and voices everyone. The others are the cast.'],
    ]) {
        const isOn = t.campaign.mode === mode;
        const tile = button(`ct-gs-tile${isOn ? ' is-on' : ''}`, `<i class="fa-solid ${icon}" aria-hidden="true"></i>`, '', () => void setMode(mode));
        tile.setAttribute('role', 'radio');
        tile.setAttribute('aria-checked', String(isOn));
        const textWrap = el('span', 'ct-gs-tile-text');
        textWrap.append(el('span', 'ct-gs-tile-title', title), el('span', 'ct-gs-tile-desc', text));
        tile.append(textWrap);
        tiles.append(tile);
    }
    basics.append(modeHead, tiles);
    body.append(basics);

    if (t.campaign.mode === 'narrated') body.append(renderNarratorCard(t));
    if (!t.isNew) body.append(renderScenarioCard());
}

function renderNarratorCard(t) {
    const campaign = t.campaign;
    const narrator = narratorAvatar(campaign);
    const section = card('Narrator', HELP.narrator, { className: 'ct-gs-narrator' });

    const choices = el('div', 'ct-gs-choices');
    const pickCard = el('label', `ct-gs-choice${campaign.narrator.type === 'card' ? ' is-on' : ''}`);
    const cardRadio = el('input');
    cardRadio.type = 'radio';
    cardRadio.name = 'ct-gs-narrator';
    cardRadio.checked = campaign.narrator.type === 'card';
    cardRadio.addEventListener('change', () => void setNarrator({ type: 'card' }));
    const cardBody = el('span', 'ct-gs-choice-body');
    cardBody.append(el('span', 'ct-gs-label', 'Use one of my characters'));
    const cardSelect = el('select', 'text_pole');
    cardSelect.id = 'ct-gs-narrator-card';
    cardSelect.setAttribute('aria-label', 'Narrator character');
    cardSelect.append(option('', 'Pick a character…', !campaign.narrator.avatar));
    for (const character of [...characters].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
        cardSelect.append(option(character.avatar, character.name, character.avatar === campaign.narrator.avatar));
    }
    cardSelect.disabled = campaign.narrator.type !== 'card';
    cardSelect.addEventListener('change', () => void setNarrator({ type: 'card', avatar: cardSelect.value }));
    cardBody.append(cardSelect);
    pickCard.append(cardRadio, cardBody);

    const pickBuiltin = el('label', `ct-gs-choice${campaign.narrator.type === 'builtin' ? ' is-on' : ''}`);
    const builtinRadio = el('input');
    builtinRadio.type = 'radio';
    builtinRadio.name = 'ct-gs-narrator';
    builtinRadio.checked = campaign.narrator.type === 'builtin';
    builtinRadio.addEventListener('change', () => void setNarrator({ type: 'builtin' }));
    const builtinBody = el('span', 'ct-gs-choice-body');
    builtinBody.append(el('span', 'ct-gs-label', 'Built-in narrator'), el('span', 'ct-gs-note', 'No card needed. Write how the narrator should tell the story.'));
    const style = el('textarea', 'text_pole');
    style.id = 'ct-gs-narrator-style';
    style.rows = 3;
    style.placeholder = 'e.g. Third person, past tense. Voice every character and NPC. Keep the world moving.';
    style.value = campaign.narrator.style;
    style.disabled = campaign.narrator.type !== 'builtin';
    style.addEventListener('change', () => void saveBuiltinStyle(style.value));
    builtinBody.append(style);
    pickBuiltin.append(builtinRadio, builtinBody);
    choices.append(pickCard, pickBuiltin);
    section.append(choices);

    if (narrator) {
        const who = el('div', 'ct-gs-narrator-now');
        who.append(avatarImg(narrator), el('span', 'ct-gs-member-name', characterName(narrator)), el('span', 'ct-gs-tag', 'replies'));
        section.append(who);
    } else {
        section.append(el('p', 'ct-gs-warn', campaign.narrator.type === 'builtin'
            ? (t.isNew ? 'The narrator card is made when you create the group.' : 'Write the style and click outside the box to make the narrator.')
            : 'Pick the character who narrates. Until then, the group replies like Ensemble.'));
    }

    const turn = el('textarea', 'text_pole ct-gs-turn');
    turn.id = 'ct-gs-turn-prompt';
    turn.rows = 4;
    turn.placeholder = DEFAULT_TURN_PROMPT;
    turn.value = campaign.narrator.turnPrompt;
    turn.addEventListener('change', () => void setCampaign({ narrator: { turnPrompt: turn.value.trim() } }));
    const turnField = field('Turn instruction', HELP.turn, turn, 'Empty: the default above is used.');
    if (campaign.narrator.turnPrompt) {
        turnField.append(button('menu_button ct-gs-btn', '<i class="fa-solid fa-rotate-left"></i> Use the default', '', () => void setCampaign({ narrator: { turnPrompt: '' } })));
    }
    section.append(turnField);
    section.append(checkRow('Put the cast in the prompt automatically', campaign.castPlacement === 'prompt', checked => void setCampaign({ castPlacement: checked ? 'prompt' : 'macro' }), HELP.placement));
    return section;
}

function renderScenarioCard() {
    const g = group();
    const section = card('Scenario', HELP.scenario, { intro: 'The situation the story starts from, shared by the whole group.' });
    if (String(selected_group) !== String(g.id)) {
        const row = el('div', 'ct-gs-inline-note');
        row.append(el('span', 'ct-gs-note', 'Each chat keeps its own scenario. Open one of this group\'s chats to edit it.'));
        row.append(button('menu_button ct-gs-btn', '<i class="fa-solid fa-comments"></i> Open chat', '', async () => {
            await openGroupById(g.id);
            render();
        }));
        section.append(row);
        return section;
    }
    const area = el('textarea', 'text_pole');
    area.id = 'ct-gs-scenario';
    area.rows = 5;
    area.placeholder = 'e.g. The party travels the Ashen Road toward the border fort of Varn, three days behind the caravan they were hired to guard.';
    area.value = String(chat_metadata?.scenario ?? '');
    area.addEventListener('change', async () => {
        chat_metadata.scenario = area.value.trim();
        await saveMetadata();
        toastr.success('Scenario saved for this chat.');
    });
    section.append(field('Scenario of the open chat', '', area, 'Saved in this chat (and its branches made from now on).'));
    return section;
}

// ───────────────────────── Cast tab ─────────────────────────

function renderCastTab(body, t) {
    if (t.campaign.mode === 'narrated') {
        const campaign = t.campaign;
        const narrator = narratorAvatar(campaign);
        const cast = t.isNew ? t.members.filter(avatar => avatar !== narrator) : castMembers(group(), campaign);
        const section = card(`Cast (${cast.length})`, HELP.cast, { intro: 'They never reply on their own. The narrator gets their sheets and voices them.' });
        const list = el('div', 'ct-gs-member-list');
        if (narrator) {
            const row = el('div', 'ct-gs-member is-narrator');
            const text = el('span', 'ct-gs-member-text');
            text.append(el('span', 'ct-gs-member-name', characterName(narrator)), el('span', 'ct-gs-member-meta-quiet', 'Narrator · replies to every message'));
            row.append(avatarImg(narrator), text, button('menu_button ct-gs-btn', 'Change', 'Change the narrator (Setup tab)', () => {
                state.tab = 'setup';
                render();
            }));
            list.append(row);
        }
        for (const avatar of cast) {
            const entry = campaign.cast[avatar] ?? { state: CAST_STATES.SCENE, sheet: '', line: '' };
            const who = characterName(avatar);
            const row = el('div', `ct-gs-member ct-gs-cast${entry.state === CAST_STATES.OFF ? ' is-muted' : ''}`);
            const text = el('span', 'ct-gs-member-text');
            text.append(el('span', 'ct-gs-member-name', who));
            text.append(el('span', entry.sheet ? 'ct-gs-sheet-ok' : 'ct-gs-sheet-none', entry.sheet ? 'Sheet ready' : (defaultSheet(avatar) ? 'Using card fields' : 'Empty card')));
            const states = segment(`Cast state for ${who}`, [[CAST_STATES.SCENE, 'In scene'], [CAST_STATES.OFFSCREEN, 'Offscreen'], [CAST_STATES.OFF, 'Off']], entry.state,
                value => void setCampaign({ cast: { ...campaign.cast, [avatar]: { ...entry, state: value } } }), true);
            const sheet = button('menu_button ct-gs-btn', entry.sheet ? '<i class="fa-solid fa-file-pen"></i> Edit sheet' : '<i class="fa-solid fa-wand-magic-sparkles"></i> Make sheet', `Cast sheet for ${who}`, async () => {
                const result = await editCastSheet(avatar, entry);
                if (result) await setCampaign({ cast: { ...campaign.cast, [avatar]: { ...entry, ...result } } });
            });
            const remove = button('ct-gs-icon', '<i class="fa-solid fa-xmark"></i>', `Remove ${who}`, () => {
                void setMembers(t.members.filter(x => x !== avatar), t.disabled);
            });
            row.append(avatarImg(avatar), text, states, sheet, remove);
            list.append(row);
        }
        if (!cast.length) list.append(el('p', 'ct-gs-note', 'No cast yet. Add characters below.'));
        section.append(list);
        body.append(section, renderPicker(t, 'Add to the cast'));
        return;
    }

    const section = card(`Members (${t.members.length})`, HELP.members);
    const members = el('div', 'ct-gs-member-list');
    t.members.forEach((avatar, index) => {
        const muted = t.disabled.includes(avatar);
        const who = characterName(avatar);
        const row = el('div', `ct-gs-member${muted ? ' is-muted' : ''}`);
        const text = el('span', 'ct-gs-member-text');
        text.append(el('span', 'ct-gs-member-name', who));
        text.append(el('span', muted ? 'ct-gs-member-meta' : 'ct-gs-member-meta-quiet', muted ? 'Muted: does not reply on its own' : `#${index + 1} in the list`));
        const move = (delta) => {
            const next = [...t.members];
            const [item] = next.splice(index, 1);
            next.splice(index + delta, 0, item);
            void setMembers(next, t.disabled);
        };
        const up = button('ct-gs-icon', '<i class="fa-solid fa-chevron-up"></i>', `Move ${who} up`, () => move(-1));
        up.disabled = index === 0;
        const down = button('ct-gs-icon', '<i class="fa-solid fa-chevron-down"></i>', `Move ${who} down`, () => move(1));
        down.disabled = index === t.members.length - 1;
        const mute = button(`ct-gs-icon${muted ? ' is-warn' : ''}`, `<i class="fa-solid ${muted ? 'fa-comment-slash' : 'fa-comment'}"></i>`, muted ? `Unmute ${who}` : `Mute ${who}`, () => {
            void setMembers(t.members, muted ? t.disabled.filter(x => x !== avatar) : [...t.disabled, avatar]);
        });
        const remove = button('ct-gs-icon', '<i class="fa-solid fa-xmark"></i>', `Remove ${who}`, () => {
            void setMembers(t.members.filter(x => x !== avatar), t.disabled);
        });
        row.append(avatarImg(avatar), text, up, down, mute, remove);
        members.append(row);
    });
    if (!t.members.length) members.append(el('p', 'ct-gs-note', 'No members yet. Add characters below.'));
    section.append(members);
    body.append(section, renderPicker(t, 'Add characters'));
}

function renderPicker(t, title) {
    const section = card(title, HELP.add);
    const search = el('input', 'text_pole ct-gs-search');
    search.id = 'ct-gs-char-search';
    search.type = 'search';
    search.placeholder = 'Search characters…';
    search.value = state.charSearch;
    search.setAttribute('aria-label', 'Search characters to add');
    const results = el('div', 'ct-gs-candidates');
    const fill = () => {
        results.replaceChildren();
        const term = state.charSearch.trim().toLowerCase();
        const pool = characters
            .filter(character => character?.avatar && !t.members.includes(character.avatar))
            .filter(character => !term || String(character.name).toLowerCase().includes(term))
            .sort((a, b) => String(a.name).localeCompare(String(b.name)));
        for (const character of pool.slice(0, 48)) {
            const tile = button('ct-gs-candidate', '', `Add ${character.name}`, () => {
                state.charSearch = '';
                void setMembers([...t.members, character.avatar], t.disabled);
            });
            tile.append(avatarImg(character.avatar, 'ct-gs-candidate-img'), el('span', 'ct-gs-candidate-name', character.name), el('span', 'ct-gs-candidate-add', '+'));
            results.append(tile);
        }
        if (pool.length > 48) results.append(el('p', 'ct-gs-note ct-gs-candidates-more', `${pool.length - 48} more. Type a name to find them.`));
        if (!pool.length) results.append(el('p', 'ct-gs-note', term ? 'No characters match.' : 'Every character is already in this group.'));
    };
    search.addEventListener('input', () => {
        state.charSearch = search.value;
        fill();
    });
    section.append(search, results);
    fill();
    return section;
}

// ───────────────────────── Scene tab ─────────────────────────

function renderSceneTab(body, t) {
    const api = agentsApi();
    const intro = card('Scene panel', HELP.scene, { intro: 'A panel beside the chat with who is in the scene (outfit, body, face, mood) and the world (time, place, quests, items). Two Scene trackers fill it; each one is an agent with its own prompt.' });
    if (!api?.getAgents) {
        intro.append(el('p', 'ct-gs-warn', 'In-Chat Agents are not loaded, so the Scene trackers can\'t run.'));
        body.append(intro);
        return;
    }
    const g = group();
    const isOpenChat = g && String(selected_group) === String(g.id);
    if (g && isOpenChat && !isActive(g.id) && t.profile.agents.mode !== AGENT_MODES.KEEP) {
        const row = el('div', 'ct-gs-warn ct-gs-inline-note');
        row.append(el('span', '', 'Group mode is off in the open chat, so this group\'s trackers are not running there.'));
        row.append(button('menu_button ct-gs-btn', 'Enter group mode', '', async () => {
            await enterHere();
            render();
        }));
        intro.append(row);
    }
    const sceneApi = globalThis.HomunculusScene;
    if (sceneApi && isOpenChat) {
        const row = el('div', 'ct-gs-inline-note');
        row.append(el('span', 'ct-gs-note', sceneApi.isAvailable() ? 'The panel is available in the open chat.' : 'The panel appears in the chat once a tracker is on.'));
        if (sceneApi.isAvailable()) {
            row.append(button('menu_button ct-gs-btn', `<i class="fa-solid fa-masks-theater"></i> ${sceneApi.isOpen() ? 'Hide' : 'Show'} the panel`, '', () => {
                sceneApi.toggle();
                render();
            }));
        }
        intro.append(row);
    }
    intro.append(checkRow('Send the scene to the AI before each reply', extension_settings.homunculusScene?.inject !== false, (checked) => {
        extension_settings.homunculusScene = { ...(extension_settings.homunculusScene ?? {}), inject: checked };
        saveSettingsDebounced();
        sceneApi?.refresh?.();
    }, HELP.sceneSend));
    body.append(intro);

    const grid = el('div', 'ct-gs-tracker-grid');
    for (const tracker of SCENE_TRACKERS) grid.append(renderTrackerCard(tracker, t, isOpenChat));
    body.append(grid);
}

function renderTrackerCard(tracker, t, isOpenChat) {
    const api = agentsApi();
    const agent = api.getAgents().find(item => item.sourceTemplateId === tracker.templateId) ?? null;
    const on = Boolean(agent && agentOnInGroup(t.profile, agent));
    const section = el('section', `ct-gs-card ct-gs-tracker${on ? ' is-on' : ''}`);
    const head = el('div', 'ct-gs-tracker-head');
    head.append(el('span', 'ct-gs-tracker-icon', ''), el('div', 'ct-gs-tracker-titles'));
    head.firstElementChild.innerHTML = `<i class="fa-solid ${tracker.icon}" aria-hidden="true"></i>`;
    head.lastElementChild.append(el('h3', 'ct-gs-title', `Scene: ${tracker.title}`), el('span', 'ct-gs-note', tracker.text));
    section.append(head);
    section.append(toggleSwitch(on ? 'On in this group' : 'Off in this group', on, enabled => void setTracker(tracker, enabled)));

    if (!agent) {
        section.append(el('p', 'ct-gs-note', 'Switch it on to add the tracker to your agents. You can edit its prompt after that.'));
        return section;
    }
    const profileSelect = el('select', 'text_pole');
    profileSelect.id = `ct-gs-tracker-profile-${tracker.kind}`;
    profileSelect.append(option('', 'Agents default', !agent.connectionProfile));
    const profiles = connectionProfiles();
    for (const profile of profiles) profileSelect.append(option(profile.id, profile.name, profile.id === agent.connectionProfile));
    if (agent.connectionProfile && !profiles.some(profile => profile.id === agent.connectionProfile)) profileSelect.append(option(agent.connectionProfile, 'Missing profile', true));
    profileSelect.addEventListener('change', async () => {
        await api.updateAgent?.(agent.id, { connectionProfile: profileSelect.value });
        toastr.success('Connection profile saved.');
    });
    section.append(field('Connection profile', '', profileSelect, 'A cheap, fast model is enough.'));

    const actions = el('div', 'ct-gs-actions');
    actions.append(button('menu_button ct-gs-btn', '<i class="fa-solid fa-pen"></i> Edit prompt', `Open the agent editor for ${agent.name}`, async () => {
        await api.openAgentEditor?.(agent.id);
        render();
    }));
    if (isOpenChat && on) {
        actions.append(button('menu_button ct-gs-btn', '<i class="fa-solid fa-rotate"></i> Update now', 'Run it on the last message of the open chat', async () => {
            const index = api.getLatestValidCompanionMessageIndex?.() ?? -1;
            if (index < 0) {
                toastr.info('The open chat has no messages yet.');
                return;
            }
            toastr.info(`Running ${agent.name}…`);
            await api.runCompanionAgentOnMessage?.(agent.id, index);
            globalThis.HomunculusScene?.refresh?.();
        }));
    }
    section.append(actions);
    return section;
}

// ───────────────────────── Chats tab ─────────────────────────

async function loadChats(groupId) {
    state.chats = { groupId, list: [], loading: true };
    try {
        const list = await getGroupPastChats(groupId);
        if (state.chats?.groupId === groupId) state.chats = { groupId, list, loading: false };
    } catch {
        if (state.chats?.groupId === groupId) state.chats = { groupId, list: [], loading: false };
    }
    if (state.open && state.tab === 'chats') render();
}

function renderChatsTab(body) {
    const g = group();
    const newChat = button('ct-cb-btn is-primary', '<i class="fa-solid fa-plus"></i><span>New chat</span>', '', async () => {
        const id = g.id;
        close();
        if (String(selected_group) !== String(id)) await openGroupById(id);
        await createNewGroupChat(id);
    });
    const section = card('Chats', HELP.chats, { aside: newChat, className: 'ct-gs-chats' });
    if (state.chats?.groupId !== g.id) void loadChats(g.id);
    const data = state.chats?.groupId === g.id ? state.chats : { loading: true, list: [] };
    if (data.loading) {
        section.append(el('p', 'ct-gs-note', 'Loading chats…'));
        body.append(section);
        return;
    }
    const byId = new Map(data.list.map(info => [String(info.file_id ?? String(info.file_name ?? '').replace(/\.jsonl$/, '')), info]));
    const ids = (g.chats ?? []).map(String).filter(id => byId.has(id));
    const roots = [];
    const branches = new Map();
    for (const id of ids) {
        const base = id.replace(/ - Branch #\d+$/, '');
        if (base !== id && byId.has(base)) {
            if (!branches.has(base)) branches.set(base, []);
            branches.get(base).push(id);
        } else {
            roots.push(id);
        }
    }
    const when = id => Number(new Date(byId.get(id)?.last_mes ?? 0).getTime() || byId.get(id)?.last_mes || 0);
    roots.sort((a, b) => when(b) - when(a));
    const list = el('div', 'ct-gs-chat-list');
    const row = (id, isBranch) => {
        const info = byId.get(id);
        const isCurrent = String(selected_group) === String(g.id) && String(g.chat_id) === id;
        const item = el('div', `ct-gs-chat${isBranch ? ' is-branch' : ''}${isCurrent ? ' is-current' : ''}`);
        const text = el('div', 'ct-gs-chat-text');
        const titleLine = el('div', 'ct-gs-chat-title');
        if (isBranch) titleLine.append(el('i', 'fa-solid fa-code-branch'));
        titleLine.append(el('span', 'ct-gs-chat-name', isBranch ? id.replace(/^.* - (Branch #\d+)$/, '$1') : id));
        if (isCurrent) titleLine.append(el('span', 'ct-gs-tag is-accent', 'open now'));
        text.append(titleLine);
        const meta = [`${Number(info?.chat_items ?? 0)} messages`, formatWhen(info?.last_mes), info?.file_size].filter(Boolean).join(' · ');
        text.append(el('div', 'ct-gs-chat-meta', meta));
        const preview = String(info?.mes ?? '').replace(/\s+/g, ' ').trim();
        if (preview) text.append(el('div', 'ct-gs-chat-preview', preview.length > 160 ? `${preview.slice(0, 160)}…` : preview));
        item.append(text);
        const branchCount = branches.get(id)?.length ?? 0;
        if (branchCount) item.append(el('span', 'ct-gs-tag', `${branchCount} branch${branchCount === 1 ? '' : 'es'}`));
        item.append(button(`menu_button ct-gs-btn${isCurrent ? '' : ' is-primary'}`, isCurrent ? 'Go to chat' : 'Open', '', async () => {
            const groupId = g.id;
            close();
            if (String(selected_group) !== String(groupId)) await openGroupById(groupId);
            if (String(g.chat_id) !== id) await openGroupChat(groupId, id);
        }));
        item.append(button('ct-gs-icon', '<i class="fa-solid fa-trash-can"></i>', `Delete chat ${id}`, async () => {
            const ok = await new Popup(`<h3>Delete this chat?</h3><p>${id.replace(/[<>&]/g, '')}</p><p>This can't be undone.</p>`, POPUP_TYPE.CONFIRM, '', { okButton: 'Delete', cancelButton: 'Cancel' }).show();
            if (ok !== POPUP_RESULT.AFFIRMATIVE) return;
            await deleteGroupChat(g.id, id, { jumpToNewChat: String(selected_group) === String(g.id) && String(g.chat_id) === id });
            state.chats = null;
            render();
        }));
        return item;
    };
    for (const id of roots) {
        list.append(row(id, false));
        for (const branch of (branches.get(id) ?? []).sort((a, b) => when(b) - when(a))) list.append(row(branch, true));
    }
    if (!roots.length) list.append(el('p', 'ct-gs-note', 'No chats yet. Press New chat to start one.'));
    section.append(list);
    body.append(section);
}

// ───────────────────────── Profile tab ─────────────────────────

function renderProfileTab(body, t) {
    const profile = t.profile;
    const section = card('Group profile', HELP.page, { intro: 'Applied when you open this group\'s chats. Anything on "Keep current" is left alone. Leaving the group puts your preset and persona back.' });

    if (!t.isNew) section.append(checkRow('Ask before entering group mode', shouldAsk(state.groupId), checked => setShouldAsk(state.groupId, checked), HELP.ask));

    const presets = getPresetManager('openai')?.getAllPresets?.() ?? [];
    const preset = el('select', 'text_pole');
    preset.id = 'ct-gs-preset';
    preset.append(option('', 'Keep current', !profile.preset));
    for (const name of presets) preset.append(option(name, name, name === profile.preset));
    if (profile.preset && !presets.includes(profile.preset)) preset.append(option(profile.preset, `${profile.preset} (missing)`, true));
    preset.addEventListener('change', () => void setProfile({ preset: preset.value }));
    section.append(field('Chat Completion preset', HELP.preset, preset, 'Only the preset. Your API and model stay as they are.'));

    const personas = Object.entries(power_user.personas ?? {}).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    const persona = el('select', 'text_pole');
    persona.id = 'ct-gs-persona';
    persona.append(option('', 'Keep current', !profile.persona));
    for (const [avatar, name] of personas) persona.append(option(avatar, String(name || avatar), avatar === profile.persona));
    if (profile.persona && !Object.hasOwn(power_user.personas ?? {}, profile.persona)) persona.append(option(profile.persona, `${profile.persona} (missing)`, true));
    persona.addEventListener('change', () => void setProfile({ persona: persona.value }));
    section.append(field('Persona', HELP.persona, persona));

    const lore = el('div', 'ct-gs-lore');
    const chips = el('div', 'ct-gs-chips');
    const known = new Set(Array.isArray(world_names) ? world_names : []);
    for (const name of profile.lorebooks) {
        const chip = el('span', `ct-gs-chip${known.has(name) ? '' : ' is-missing'}`);
        chip.append(el('span', '', known.has(name) ? name : `${name} (missing)`));
        chip.append(button('ct-gs-chip-x', '×', `Remove ${name}`, () => void setProfile({ lorebooks: profile.lorebooks.filter(x => x !== name) })));
        chips.append(chip);
    }
    if (!profile.lorebooks.length) chips.append(el('span', 'ct-gs-note', 'No extra lorebooks.'));
    const add = el('select', 'text_pole');
    add.id = 'ct-gs-lore-add';
    add.append(option('', '+ Add a lorebook…', true));
    for (const name of [...known].sort((a, b) => a.localeCompare(b))) {
        if (!profile.lorebooks.includes(name)) add.append(option(name, name, false));
    }
    add.addEventListener('change', () => {
        if (add.value) void setProfile({ lorebooks: [...profile.lorebooks, add.value] });
    });
    lore.append(chips, add);
    section.append(field('Lorebooks', HELP.lorebooks, lore, 'Scanned on top of your global lorebooks while this group\'s chat is open.'));
    body.append(section);
}

// ───────────────────────── Agents tab ─────────────────────────

function renderAgentsTab(body, t) {
    const profile = t.profile;
    const labels = { [AGENT_MODES.KEEP]: 'Keep current', [AGENT_MODES.ONLY]: 'Only these', [AGENT_MODES.ADD]: 'Add to my usual' };
    const section = card('Agents', HELP.agents, { className: 'ct-gs-agents' });
    section.append(segment('How agents change in this group', Object.values(AGENT_MODES).map(mode => [mode, labels[mode]]), profile.agents.mode, (mode) => {
        // "Only these" starts from the agents that are on now, so switching never empties the list.
        const list = mode === AGENT_MODES.ONLY && !profile.agents.on.length
            ? listAgents().filter(usualEnabled).map(agent => agent.id)
            : mode === AGENT_MODES.ADD ? [] : profile.agents.on;
        void setProfile({ agents: { mode, on: list, off: [] } });
    }));
    const hint = {
        [AGENT_MODES.KEEP]: 'This group uses your usual agents for group chats. Pick "Only these" or "Add to my usual" to choose agents for it.',
        [AGENT_MODES.ONLY]: 'Only the ticked agents run in this group.',
        [AGENT_MODES.ADD]: 'Your usual agents run here. Tick more to add them, untick to turn one off just here.',
    }[profile.agents.mode];
    section.append(el('p', 'ct-gs-note', hint));

    const api = agentsApi();
    if (!api?.getAgents) {
        section.append(el('p', 'ct-gs-note', 'In-Chat Agents are not loaded.'));
        body.append(section);
        return;
    }
    const search = el('input', 'text_pole ct-gs-search');
    search.id = 'ct-gs-agent-search';
    search.type = 'search';
    search.placeholder = 'Search agents…';
    search.value = state.agentSearch;
    search.setAttribute('aria-label', 'Search agents');
    const counter = el('div', 'ct-gs-count');
    const list = el('div', 'ct-gs-agent-list');
    const on = new Set(profile.agents.on);
    const off = new Set(profile.agents.off);
    const keep = profile.agents.mode === AGENT_MODES.KEEP;
    const fill = () => {
        list.replaceChildren();
        const term = state.agentSearch.trim().toLowerCase();
        let count = 0;
        for (const agent of listAgents()) {
            const usual = usualEnabled(agent);
            const enabled = agentOnInGroup(profile, agent);
            if (enabled) count++;
            if (term && !`${agent.name} ${agent.description ?? ''}`.toLowerCase().includes(term)) continue;
            const row = el('div', `ct-gs-agent${enabled ? ' is-on' : ''}${keep ? ' is-locked' : ''}`);
            const label = el('label', 'ct-gs-agent-main');
            const box = el('input');
            box.type = 'checkbox';
            box.checked = enabled;
            box.disabled = keep;
            box.addEventListener('change', () => void chooseAgent(agent.id, box.checked, usual));
            const textWrap = el('span', 'ct-gs-agent-text');
            textWrap.append(el('span', 'ct-gs-agent-name', agent.name || agent.id));
            if (agent.description) textWrap.append(el('span', 'ct-gs-agent-desc', String(agent.description)));
            label.append(box, textWrap);
            row.append(label);
            const tagText = profile.agents.mode === AGENT_MODES.ADD && (on.has(agent.id) || off.has(agent.id)) ? 'this group' : usual ? 'usual' : '';
            if (tagText) row.append(el('span', 'ct-gs-tag', tagText));
            row.append(button('ct-gs-icon', '<i class="fa-solid fa-pen"></i>', `Edit ${agent.name || 'agent'}`, async () => {
                await api.openAgentEditor?.(agent.id);
                render();
            }));
            list.append(row);
        }
        if (!list.childElementCount) list.append(el('p', 'ct-gs-note', term ? 'No agents match.' : 'No agents yet.'));
        counter.textContent = `${count} on in this group`;
    };
    search.addEventListener('input', () => {
        state.agentSearch = search.value;
        fill();
    });
    section.append(search, counter, list);
    fill();
    body.append(section);
}

// ───────────────────────── Behavior tab ─────────────────────────

function renderBehaviorTab(body, t) {
    const section = card('Behavior', HELP.behavior);
    if (t.campaign.mode === 'narrated') {
        section.append(el('p', 'ct-gs-note', 'Narrated: the narrator replies to every message, and only the narrator\'s card is sent (the cast goes in as sheets). To make a cast member speak anyway, use the member bar under the chat.'));
        body.append(section);
        return;
    }
    const strategy = el('select', 'text_pole');
    strategy.id = 'ct-gs-strategy';
    for (const [value, label] of STRATEGIES) strategy.append(option(value, label, value === t.behavior.activation_strategy));
    strategy.addEventListener('change', () => void setBehavior({ activation_strategy: Number(strategy.value) }));
    section.append(field('Who replies', '', strategy));
    const mode = el('select', 'text_pole');
    mode.id = 'ct-gs-genmode';
    for (const [value, label] of GEN_MODES) mode.append(option(value, label, value === t.behavior.generation_mode));
    mode.addEventListener('change', () => void setBehavior({ generation_mode: Number(mode.value) }));
    section.append(field('Character cards sent', '', mode));
    section.append(checkRow('Allow self responses', t.behavior.allow_self_responses, checked => void setBehavior({ allow_self_responses: checked })));
    body.append(section);
}

// ───────────────────────── Render ─────────────────────────

function renderFooter(t) {
    const footer = root.querySelector('.ct-gs-footer');
    footer.replaceChildren();
    footer.hidden = !t.isNew;
    if (!t.isNew) return;
    const builtinNeeded = t.campaign.mode === 'narrated' && t.campaign.narrator.type === 'builtin';
    const ready = t.members.length || builtinNeeded;
    footer.append(el('span', 'ct-gs-note', ready ? 'Ready. The chat opens as soon as the group is made.' : 'Add at least one character (Cast tab) to make the group.'));
    const createButton = button('ct-cb-btn is-primary', '<i class="fa-solid fa-check"></i><span>Create group and open chat</span>', '', () => void createGroupNow());
    createButton.id = 'ct-gs-create';
    createButton.disabled = !ready || state.creating;
    footer.append(createButton);
}

function render() {
    if (!root) return;
    closeHelp();
    if (state.mode === 'edit' && !group()) {
        state.mode = 'new';
        state.draft = emptyDraft();
    }
    const t = target();
    if (!visibleTabs(t).some(tab => tab.id === state.tab)) state.tab = 'setup';
    renderHeader();
    renderSide();
    renderTabs(t);
    const body = root.querySelector('.ct-gs-body');
    const keepScroll = body.scrollTop;
    const focusedId = document.activeElement?.id;
    body.replaceChildren();
    body.setAttribute('aria-labelledby', `ct-gs-tab-${state.tab}`);
    const page = el('div', `ct-gs-page ct-gs-page-${state.tab}`);
    ({
        setup: renderSetup,
        cast: renderCastTab,
        scene: renderSceneTab,
        chats: renderChatsTab,
        profile: renderProfileTab,
        agents: renderAgentsTab,
        behavior: renderBehaviorTab,
    })[state.tab](page, t);
    body.append(page);
    renderFooter(t);
    body.scrollTop = keepScroll;
    if (focusedId) document.getElementById(focusedId)?.focus();
}

// ───────────────────────── Create / duplicate / delete ─────────────────────────

async function postGroup(payload) {
    const chatName = humanizedDateTime();
    const response = await fetch('/api/groups/create', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            avatar_url: default_avatar,
            hideMutedSprites: false,
            member_models: {},
            fav: false,
            conversation_settings: {},
            ...payload,
            chat_id: chatName,
            chats: [chatName],
        }),
    });
    if (!response.ok) throw new Error(`The server refused (${response.status}).`);
    const data = await response.json();
    await getCharacters();
    return data;
}

/** The create route keeps only the standard group fields, so the fork's settings are saved right after. */
async function attachSettings(groupId, profile, campaign) {
    const made = findGroup(groupId);
    if (!made) return;
    made.homunculus_profile = structuredClone(profile);
    made.homunculus_campaign = structuredClone(campaign);
    await editGroup(made.id, true, false);
}

async function createGroupNow() {
    const t = target();
    if (!t.isNew || state.creating) return;
    const builtinNeeded = t.campaign.mode === 'narrated' && t.campaign.narrator.type === 'builtin' && !t.campaign.narrator.builtinAvatar;
    if (!t.members.length && !builtinNeeded) return;
    state.creating = true;
    renderFooter(t);
    try {
        if (builtinNeeded) {
            const avatar = await createBuiltinNarrator(t.name.trim() || 'group', t.campaign.narrator.style);
            t.campaign = normalizeCampaign({ ...t.campaign, narrator: { ...t.campaign.narrator, builtinAvatar: avatar } });
            t.members = [avatar, ...t.members];
        }
        const names = t.members.map(characterName).join(', ');
        const data = await postGroup({
            name: t.name.trim() || `Group: ${names}`,
            members: t.members,
            allow_self_responses: t.behavior.allow_self_responses,
            activation_strategy: t.behavior.activation_strategy,
            generation_mode: t.behavior.generation_mode,
            disabled_members: t.disabled,
        });
        await attachSettings(data.id, t.profile, t.campaign);
        skipAskOnce(data.id);
        state.draft = emptyDraft();
        state.mode = 'edit';
        state.groupId = String(data.id);
        toastr.success(`Group "${data.name ?? t.name}" created.`);
        close();
        await openGroupById(data.id);
    } catch (error) {
        console.error('[Homunculus] Group Studio:', error);
        toastr.error(String(error?.message ?? error), 'Could not create the group');
    } finally {
        state.creating = false;
        if (state.open) render();
    }
}

async function duplicateGroup(groupId) {
    const g = findGroup(groupId);
    if (!g) return;
    try {
        const data = await postGroup({
            name: `${g.name} (copy)`,
            members: [...(g.members ?? [])],
            allow_self_responses: Boolean(g.allow_self_responses),
            activation_strategy: Number(g.activation_strategy ?? 0),
            generation_mode: Number(g.generation_mode ?? 0),
            disabled_members: [...(g.disabled_members ?? [])],
            hideMutedSprites: Boolean(g.hideMutedSprites),
            member_models: structuredClone(g.member_models ?? {}),
        });
        await attachSettings(data.id, getProfile(g), getCampaign(g));
        toastr.success(`Made "${data.name}". Its chats start fresh.`);
        open(data.id);
    } catch (error) {
        toastr.error(String(error?.message ?? error), 'Could not duplicate the group');
    }
}

async function removeGroup(groupId) {
    const g = findGroup(groupId);
    if (!g) return;
    const chats = g.chats?.length ?? 0;
    const wrap = el('div', 'ct-gm-ask');
    wrap.append(el('h3', '', `Delete "${g.name}"?`));
    wrap.append(el('p', '', `The group and its ${chats} chat${chats === 1 ? '' : 's'} are deleted. The characters themselves stay in your library.`));
    wrap.append(el('p', 'ct-gm-muted', 'This can\'t be undone.'));
    const answer = await new Popup(wrap, POPUP_TYPE.CONFIRM, '', { okButton: 'Delete group', cancelButton: 'Cancel' }).show();
    if (answer !== POPUP_RESULT.AFFIRMATIVE) return;
    try {
        if (String(selected_group) === String(groupId)) {
            await deleteGroup(groupId);
        } else {
            const response = await fetch('/api/groups/delete', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ id: groupId }) });
            if (!response.ok) throw new Error(`The server refused (${response.status}).`);
            for (const chatId of g.chats ?? []) await eventSource.emit(event_types.GROUP_CHAT_DELETED, chatId);
            await getCharacters();
        }
        toastr.success(`Deleted "${g.name}".`);
        state.mode = 'new';
        state.groupId = null;
        state.draft = emptyDraft();
        state.tab = 'setup';
        render();
    } catch (error) {
        toastr.error(String(error?.message ?? error), 'Could not delete the group');
    }
}

// ───────────────────────── Open / close ─────────────────────────

function show() {
    if (!root) build();
    const home = globalThis.HomunculusClassicHome;
    if (!state.open) {
        home?.closeHome?.();
        state.open = true;
        returnFocus = document.activeElement;
        document.body.classList.add('ct-cb-open');
        root.classList.add('is-open');
        home?.setView?.(VIEW_ID);
        setButtonState(true);
    }
    render();
}

/**
 * Opens the Studio on a group (the open or edited group by default, else the New group form).
 * @param {string|null} [groupId]
 * @param {string} [tab] setup, cast, scene, chats, profile, agents or behavior
 */
function open(groupId = openGroupId ?? selected_group, tab = '') {
    const id = groupId ? String(groupId) : null;
    if (id && findGroup(id)) {
        if (state.mode !== 'edit' || state.groupId !== id) {
            state.charSearch = '';
            state.agentSearch = '';
            state.chats = null;
            state.menuOpen = false;
        }
        state.mode = 'edit';
        state.groupId = id;
    } else if (state.mode !== 'new') {
        state.mode = 'new';
        state.draft = emptyDraft();
    }
    if (tab && TABS.some(item => item.id === tab)) state.tab = tab;
    show();
}

/** Opens the New group form. */
function create() {
    if (state.mode !== 'new') {
        state.draft = emptyDraft();
        state.charSearch = '';
        state.agentSearch = '';
    }
    state.mode = 'new';
    state.groupId = null;
    state.tab = 'setup';
    state.menuOpen = false;
    show();
    requestAnimationFrame(() => document.getElementById('ct-gs-group-name')?.focus());
}

function close() {
    if (!state.open) return;
    state.open = false;
    state.menuOpen = false;
    closeHelp();
    root?.classList.remove('is-open');
    document.body.classList.remove('ct-cb-open');
    setButtonState(false);
    const home = globalThis.HomunculusClassicHome;
    if (home?.getView?.() === VIEW_ID) home.setView('chat');
    if (returnFocus instanceof HTMLElement && document.contains(returnFocus)) returnFocus.focus();
    globalThis.HomunculusScene?.render?.();
}

function toggle() {
    if (state.open) close(); else open(selected_group);
}

// ───────────────────────── Entry points ─────────────────────────

function setButtonState(isOpen) {
    const wrap = document.getElementById(VIEW_ID);
    wrap?.classList.toggle('is-open', isOpen);
    const icon = wrap?.querySelector('.drawer-icon');
    icon?.classList.toggle('openIcon', isOpen);
    icon?.classList.toggle('closedIcon', !isOpen);
}

/** "Group Studio" button in the top bar, next to Characters (the same kind of button as the Card Browser's). */
function addTopButton() {
    const holder = document.getElementById('top-settings-holder');
    if (!holder || document.getElementById(VIEW_ID)) return;
    const wrap = el('div', 'drawer');
    wrap.id = VIEW_ID;
    wrap.innerHTML = '<div class="ct-home-toggle" role="button" tabindex="0" title="Group Studio" aria-label="Group Studio"><div class="drawer-icon fa-solid fa-people-group fa-fw closedIcon"></div></div>';
    const anchor = document.getElementById('rightNavHolder');
    if (anchor?.parentElement === holder) anchor.before(wrap); else holder.append(wrap);
    const toggleEl = wrap.querySelector('.ct-home-toggle');
    toggleEl.addEventListener('click', toggle);
    toggleEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
        }
    });
}

/** The sliders button in the group panel (for the group shown there). */
function addPanelButton() {
    const holder = document.querySelector('#rm_group_chats_block .sb-group-editor-side-actions') ?? document.getElementById('rm_group_scenario')?.parentElement;
    if (!holder || document.getElementById('ct-group-studio-button')) return;
    const b = el('div', 'heightFitContent margin0 menu_button fa-solid fa-fw fa-sliders');
    b.id = 'ct-group-studio-button';
    b.title = 'Open this group in the Group Studio';
    b.tabIndex = 0;
    b.setAttribute('role', 'button');
    const go = () => (openGroupId ? open(openGroupId) : create());
    b.addEventListener('click', go);
    b.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            go();
        }
    });
    holder.append(b);
}

/** "Create New Chat Group" in the Characters panel opens the Studio's New group form. */
function takeOverCreateButton() {
    const createButton = document.getElementById('rm_button_group_chats');
    if (!createButton || createButton.dataset.ctStudio) return;
    createButton.dataset.ctStudio = '1';
    createButton.title = 'Create a new group (Group Studio). Shift-click: old group panel';
    createButton.addEventListener('click', (event) => {
        if (event.shiftKey || event.altKey) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        create();
    }, true);
}

function init() {
    addTopButton();
    addPanelButton();
    takeOverCreateButton();
    const rerender = () => {
        if (state.open) render();
    };
    document.addEventListener(PROFILE_CHANGED_EVENT, rerender);
    document.addEventListener('homunculus:group-campaign-changed', rerender);
    eventSource.on(event_types.GROUP_UPDATED, rerender);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        state.chats = null;
        rerender();
    });
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
        if (state.menuOpen) {
            state.menuOpen = false;
            renderHeader();
            return;
        }
        close();
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}

globalThis.HomunculusGroupStudio = { open, create, close };
