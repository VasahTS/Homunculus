// Classic UI fork: Group Studio.
//
// A page of its own (like the Card Browser) where groups are made and set up. The list of groups is
// on the left; the chosen group has a header (avatars, name, Open chat, Duplicate / Delete) and tabs:
// Setup (name, mode, narrator, how the story starts, role, story style), Cast, Scene (the Scene
// trackers), Chats, Agents and Settings (profile, prompts, who replies). The rules live elsewhere: the
// profile in classic-group-profile.js, Narrated mode and cast sheets in classic-group-campaign.js, the
// story start in classic-group-start.js, the Scene panel in classic-scene.js; this file is only the page.
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
import { listPresets, chosenPresetId, choosePreset, activePreset, openFieldsEditor, FIELDS_CHANGED_EVENT } from './classic-scene-fields.js';
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
import { normalizeStart, getStart, saveStart, usableOpenings, isEmptyStart, openChatState, applyToOpenChat as applyStartToOpenChat } from './classic-group-start.js';
import { listVars, normalizeStyle, getStyle, saveStyle, styleText, conflicts as styleConflicts, openVarsEditor, STYLE_HELP, STYLE_CHANGED_EVENT } from './classic-story-style.js';
import { BLOCKS as PROMPT_BLOCKS, getPlacement, setPlacement, resetPlacement, status as blockStatus, preview as blockPreview, presetMacrosOf, missingSections, addSectionsToPreset, wrap, PROMPTS_CHANGED_EVENT } from './classic-prompt-blocks.js';
import {
    CAST_STATES,
    DEFAULT_TURN_PROMPT,
    defaultRolePrompt,
    castMembers,
    createBuiltinNarrator,
    defaultSheet,
    editCastSheet,
    getCampaign,
    narratorAvatar,
    normalizeCampaign,
    roleInPreset,
    saveCampaign,
    updateBuiltinNarrator,
} from './classic-group-campaign.js';

const VIEW_ID = 'ct-group-studio';

const TABS = [
    { id: 'setup', label: 'Setup', icon: 'fa-wand-magic-sparkles' },
    { id: 'cast', label: 'Cast', icon: 'fa-users' },
    { id: 'scene', label: 'Scene', icon: 'fa-masks-theater' },
    { id: 'chats', label: 'Chats', icon: 'fa-comments', existingOnly: true },
    { id: 'agents', label: 'Agents', icon: 'fa-robot' },
    { id: 'settings', label: 'Settings', icon: 'fa-gear' },
];
// Tabs that became sections of Settings (callers may still ask for them).
const TAB_ALIASES = { profile: 'settings', behavior: 'settings', prompts: 'settings' };

const SCENE_TRACKERS = [
    {
        kind: 'world',
        templateId: 'tpl-homunculus-scene-world',
        icon: 'fa-earth-americas',
        title: 'World',
        text: 'Time, place, weather, quests, items.',
    },
    {
        kind: 'cast',
        templateId: 'tpl-homunculus-scene-characters',
        icon: 'fa-user-group',
        title: 'Characters',
        text: 'Who is here: looks, outfit, mood.',
    },
    {
        kind: 'plot',
        templateId: 'tpl-homunculus-scene-plot',
        icon: 'fa-diagram-project',
        title: 'Plot',
        text: 'Threads, goals, secrets and your beats.',
        presets: false,
    },
    {
        kind: 'map',
        templateId: 'tpl-homunculus-scene-map',
        icon: 'fa-map',
        title: 'Map',
        text: 'Places visited and known, and the way between them.',
        presets: false,
    },
];

const HELP = {
    prompts: `<p>What Homunculus adds to the prompt: role instructions, story style, your plan, the scene and the cast.</p>
<p>Each one goes where its <b>section</b> is in your Chat Completion preset (the Prompt Manager list), like any other part of the preset. The Default preset already has them; for other presets, press <b>Add them to my preset</b>.</p>
<p>The switch turns a block off. <b>Details</b> shows what is sent and lets you place it without a section.</p>
<p>These settings are the same for every group.</p>`,
    profile: '<p>Applied when you open one of this group\'s chats (the group\'s settings). Anything on <b>Keep current</b> is left alone, and leaving the group puts your own preset and persona back.</p>',
    protagonist: '<p>Optional. A character the story follows most. The AI writes them like everyone else; they are not you.</p>',
    trackerProfile: '<p>The connection profile this tracker uses. A cheap, fast model is enough.</p>',
    promptSections: `<p>A section is a prompt in your Chat Completion preset (the Prompt Manager list). Each Homunculus section holds only a macro, like <code>{{storyStyle}}</code>.</p>
<p>With the section in the preset, the block goes exactly where the section is, and it is not added anywhere else. Drag it up or down, or switch it off, in the Prompt Manager.</p>
<p>The Default preset already comes with them. Other presets get them with this button.</p>
<p>The sections are added to the preset you are using now. Save the preset to keep them in its file.</p>`,
    promptWhere: `<ul>
<li><b>Where my preset has it</b>: only where your preset has the macro (its section). Nothing is added anywhere else.</li>
<li><b>End of the Main Prompt</b>: added after your preset's Main Prompt.</li>
<li><b>In the chat, near the end</b>: added between the last messages, where the AI follows it most.</li>
</ul>`,
    promptDepth: '<p>How many messages from the end. 0 = after the last message, 1 = just before the last message.</p>',
    promptRole: '<p>Who "says" the block in the chat. <b>System</b> works for most models.</p>',
    page: `<p>Make and set up your groups here.</p>
<p>Pick a group on the left, or press <b>New group</b>. Changes to an existing group are saved right away.</p>
<p><b>Settings</b> and <b>Agents</b> are applied when you open one of the group's chats, and your own settings come back when you leave (or turn the group's settings off in the bar above the chat).</p>`,
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
    start: `<p>How every new chat of this group begins.</p>
<ul>
<li><b>Scenario</b>: where and when the story starts and what is going on. The AI reads it before every reply.</li>
<li><b>Opening message</b>: the first message of the chat. Press <b>+</b> to write more: they become swipes, so you pick one with the arrows. Empty: the characters' own greetings are used.</li>
</ul>
<p><b>Load from the Vault</b> fills both from a saved scenario and adds its lorebooks to the group. <b>Save to the Vault</b> keeps them for other groups.</p>
<p>A chat that already started keeps its own start. Press <b>New chat</b> to begin again with this one.</p>`,
    speaker: '<p>Which member sends the opening message. In a Narrated group it is always the narrator.</p>',
    chatScenario: '<p>Only the open chat. Use it when this chat went somewhere else and needs its own scenario. New chats still start with the group\'s scenario above.</p>',
    npcPick: `<p>NPCs saved in the Vault. Click one to add it.</p>
<ul>
<li>An NPC that already has a character card joins right away.</li>
<li>One without a card gets one first: you check the card, then it joins.</li>
</ul>
<p>In a Narrated group the NPC's sheet becomes its cast sheet.</p>`,
    role: `<ul>
<li><b>Player</b>: you are {{user}}, a character in the story. Your messages are what your character says and does.</li>
<li><b>Co-author</b>: {{user}} is still a character, but your messages are <b>directions</b>. The AI writes {{user}} like everyone else, in their own voice, spread through the reply.</li>
<li><b>Director</b>: there is no {{user}} in the story. You stay outside, like a god: give directions for anyone, or press <b>Let them act</b> (on the bar above the chat) and just watch.</li>
</ul>
<p>Co-author and Director send role instructions to the AI (open <b>Instructions for the AI</b> to read or change them). Turn on <b>Scene: Plot</b> in the Scene tab to plan beats.</p>`,
    roleSend: '<p>Off: only the main character and "when I send nothing" lines are sent. A preset with its own &lt;author_vs_protagonist&gt; or &lt;author_mode&gt; prompt is found by itself, so you rarely need this.</p>',
    idle: '<p>What happens on a turn without a direction: when you press <b>Let them act</b>, use auto-play, or send an empty message.</p>',
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
<p>Switching one on here only turns it on for this group (while its settings are on). Your other chats are not changed.</p>`,
    scenePreset: `<p>What this tracker writes down and what the Scene panel shows. <b>Standard</b> fits most stories; pick another one (for example <b>Superpowers</b>) or click <b>Edit fields</b> to make your own.</p>
<p>The preset is saved in this group. Changing it takes effect from the next update.</p>`,
    sceneSend: '<p>When this is on, a short copy of the scene goes to the AI before each reply, so it remembers outfits, wounds, the time and the quests. Turn it off to keep the panel just for you.</p>',
    chats: `<p>Every chat of this group. Branches are listed under the chat they came from.</p>
<p><b>Open</b> switches to that chat. <b>New chat</b> starts a fresh one with the group's opening (Setup), or the greetings when it has none.</p>`,
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

/** A collapsed section ("▸ title"); stays open across re-renders. */
function more(key, title, ...children) {
    const details = el('details', 'ct-gs-more');
    details.open = state.openMore.has(key);
    details.addEventListener('toggle', () => {
        if (details.open) state.openMore.add(key);
        else state.openMore.delete(key);
    });
    const summary = el('summary', '');
    if (typeof title === 'string') summary.textContent = title;
    else summary.append(title);
    details.append(summary, ...children.filter(Boolean));
    return details;
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

/** Gives a text box as many rows as its text needs, between min and max, and keeps that while typing. */
function fitRows(area, min, max) {
    const fit = () => {
        const lines = area.value.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 110)), 0);
        area.rows = Math.min(max, Math.max(min, lines + 1));
    };
    fit();
    area.addEventListener('input', fit);
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
        style: normalizeStyle(null),
        start: normalizeStart(null),
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
    /** Which opening message the Setup shows (index into start.openings). */
    opening: 0,
    npcSearch: '',
    /** The Vault's NPCs for the Cast tab (null = not loaded yet). */
    npcs: null,
    /** Keys of the collapsed sections the user opened. */
    openMore: new Set(),
    /** New group: 'pick' shows the starting points before the Setup; null shows the Setup. */
    guide: null,
    /** The starting point picked on the 'pick' screen (simple, narrated, write, scratch). */
    guideChoice: null,
    /** The starting point that filled the open New group form. */
    guideApplied: null,
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
            style: getStyle(g),
            start: getStart(g),
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
        state.draft.campaign = normalizeCampaign({ ...current, ...patch, narrator: { ...current.narrator, ...(patch.narrator ?? {}) }, roleText: { ...current.roleText, ...(patch.roleText ?? {}) } });
        render();
        return;
    }
    await saveCampaign(g.id, patch);
    render();
}

async function setStyle(patch) {
    const g = group();
    if (!g) {
        const current = state.draft.style;
        const values = { ...current.values, ...(patch.values ?? {}) };
        for (const [key, val] of Object.entries(patch.values ?? {})) if (!val) delete values[key];
        state.draft.style = normalizeStyle({ ...current, ...patch, values });
        render();
        return;
    }
    await saveStyle(g.id, patch);
    render();
}

/**
 * Changes how the story starts. Text edits save without re-rendering (the page is not rebuilt under
 * the cursor); pass rerender for changes that alter the layout. A saved group's open chat that has not
 * started yet gets the new start right away.
 */
async function setStart(patch, { rerender = false } = {}) {
    const g = group();
    if (!g) {
        state.draft.start = normalizeStart({ ...state.draft.start, ...patch });
        if (rerender) renderAfterClick();
        return;
    }
    await saveStart(g.id, patch);
    await applyStartToOpenChat(g, { scenario: 'scenario' in patch, opening: 'openings' in patch || 'speaker' in patch });
    if (rerender) renderAfterClick();
}

// A text box saves when it loses focus, which happens when the mouse goes down on a button. Rebuilding
// the page right then would remove that button before its click lands, so the rebuild waits.
let pointerIsDown = false;
document.addEventListener('pointerdown', () => { pointerIsDown = true; }, true);
document.addEventListener('pointerup', () => { pointerIsDown = false; }, true);
function renderAfterClick() {
    if (!pointerIsDown) {
        render();
        return;
    }
    document.addEventListener('pointerup', () => setTimeout(() => state.open && render(), 0), { once: true, capture: true });
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
        : isActive(g.id) ? 'Group settings on in the open chat'
            : String(selected_group) === String(g.id) ? 'Open now · group settings off' : '';
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
        return on ? `${on}/${SCENE_TRACKERS.length}` : '';
    }
    if (id === 'chats') return String(group()?.chats?.length ?? '');
    return '';
}

// ───────────────────────── Setup tab ─────────────────────────

function renderSetup(body, t) {
    if (t.isNew && state.guideApplied) {
        const from = el('div', 'ct-gs-guide-from');
        from.append(el('span', '', `Filled in from "${GUIDE_TITLES[state.guideApplied] ?? 'a starting point'}". Everything stays editable.`));
        from.append(button('ct-gm-link', 'Change starting point', '', () => {
            state.guide = 'pick';
            state.guideChoice = state.guideApplied;
            render();
        }));
        body.append(from);
    }
    const basics = card(t.isNew ? 'New group' : 'Basics', HELP.page);
    const name = el('input', 'text_pole');
    name.id = 'ct-gs-group-name';
    name.type = 'text';
    name.placeholder = !t.isNew ? 'Group name' : t.members.length ? `Name (optional) · if empty: ${suggestedName(t)}` : 'Name (optional), e.g. The Ashen Road';
    name.value = t.name;
    name.addEventListener(t.isNew ? 'input' : 'change', () => void setName(name.value));
    basics.append(field('Name', '', name));

    const modeHead = el('div', 'ct-gs-field-head');
    modeHead.append(el('span', 'ct-gs-label', 'Mode'), helpButton('Mode', HELP.mode));
    const tiles = el('div', 'ct-gs-tiles');
    tiles.setAttribute('role', 'radiogroup');
    tiles.setAttribute('aria-label', 'Mode');
    for (const [mode, icon, title, text] of [
        ['ensemble', 'fa-users', 'Ensemble', 'Everyone replies in turn.'],
        ['narrated', 'fa-feather-pointed', 'Narrated', 'One narrator voices everyone.'],
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
    body.append(renderStartCard(t));
    body.append(renderRoleCard(t));
    body.append(renderStyleCard(t));
}

const escapeHtml = text => String(text ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[char]);

function renderStartCard(t) {
    const start = t.start;
    const g = group();
    const filled = !isEmptyStart(start);
    const aside = el('div', 'ct-gs-card-actions');
    aside.append(button('ct-cb-btn', '<i class="fa-solid fa-vault"></i><span>Load from the Vault</span>', 'Use a scenario saved in the Vault', () => void loadFromVault()));
    if (filled) aside.append(button('ct-cb-btn', '<i class="fa-solid fa-floppy-disk"></i><span>Save to the Vault</span>', 'Keep this start to use it in other groups', () => void saveStartToVault()));
    const section = card('How the story starts', HELP.start, { aside, className: 'ct-gs-start' });
    if (start.vaultName) {
        const from = el('div', 'ct-gs-from');
        from.innerHTML = '<i class="fa-solid fa-vault" aria-hidden="true"></i>';
        from.append(el('span', '', `From "${start.vaultName}" in the Vault`));
        section.append(from);
    }

    const scenario = el('textarea', 'text_pole');
    scenario.id = 'ct-gs-start-scenario';
    scenario.rows = 4;
    scenario.placeholder = 'Where and when the story starts, e.g. The party reaches the border fort of Varn at dusk, three days late.';
    scenario.value = start.scenario;
    fitRows(scenario, 4, 12);
    scenario.addEventListener('change', () => void setStart({ scenario: scenario.value }));
    section.append(field('Scenario', '', scenario));
    section.append(renderOpeningField(t));

    if (g) {
        const chatState = openChatState(g);
        const chatScenario = String(chat_metadata?.scenario ?? '').trim();
        if (filled && chatState === 'fresh' && chatScenario === start.scenario.trim()) {
            const ok = el('p', 'ct-gs-start-status is-ok');
            ok.innerHTML = '<i class="fa-solid fa-check" aria-hidden="true"></i>';
            ok.append(el('span', '', 'The open chat starts this way too.'));
            section.append(ok);
        }
        if (chatState === 'started' && filled) {
            const row = el('div', 'ct-gs-inline-note ct-gs-start-status');
            row.append(el('span', '', 'The open chat already started and keeps its own start.'));
            row.append(button('menu_button ct-gs-btn', '<i class="fa-solid fa-plus"></i> New chat', 'Start a new chat of this group with this start', async () => {
                const id = g.id;
                close();
                await createNewGroupChat(id);
            }));
            section.append(row);
        }
        if (chatState === 'started' || (chatState === 'fresh' && chatScenario !== start.scenario.trim())) {
            const own = el('textarea', 'text_pole');
            own.id = 'ct-gs-chat-scenario';
            own.setAttribute('aria-label', 'Scenario of the open chat');
            own.value = chatScenario;
            fitRows(own, 3, 10);
            own.addEventListener('change', async () => {
                chat_metadata.scenario = own.value.trim();
                await saveMetadata();
                toastr.success('Scenario saved for the open chat.');
            });
            section.append(more('chat-scenario', `Scenario of the open chat${chatScenario ? '' : ' · empty'}`, field('Only this chat', HELP.chatScenario, own)));
        }
    }
    return section;
}

function renderOpeningField(t) {
    const start = t.start;
    const openings = start.openings.length ? start.openings : [''];
    const index = Math.min(Math.max(state.opening, 0), openings.length - 1);
    const wrap = el('div', 'ct-gs-field ct-gs-opening');
    const head = el('div', 'ct-gs-field-head ct-gs-opening-head');
    const label = el('label', 'ct-gs-label', 'Opening message');
    label.htmlFor = 'ct-gs-start-opening';
    head.append(label);

    const area = el('textarea', 'text_pole ct-gs-opening-text');
    const pills = el('div', 'ct-gs-pills');
    pills.setAttribute('role', 'group');
    pills.setAttribute('aria-label', 'Opening messages');
    openings.forEach((text, i) => {
        const isOn = i === index;
        const pill = button(`ct-gs-pill${isOn ? ' is-on' : ''}${text.trim() ? '' : ' is-empty'}`, String(i + 1), i === 0 ? 'Opening 1 (the one shown first)' : `Opening ${i + 1} (a swipe)`, () => {
            state.opening = i;
            render();
        });
        pill.setAttribute('aria-pressed', String(isOn));
        pills.append(pill);
    });
    const addButton = button('ct-gs-pill ct-gs-pill-add', '<i class="fa-solid fa-plus"></i>', 'Write another opening (it becomes a swipe)', async () => {
        const next = [...openings];
        next[index] = area.value;
        state.opening = next.length;
        await setStart({ openings: [...next, ''] }, { rerender: true });
        requestAnimationFrame(() => document.getElementById('ct-gs-start-opening')?.focus());
    });
    pills.append(addButton, button('ct-gs-icon ct-gs-pill-remove', '<i class="fa-solid fa-trash-can"></i>', `Remove opening ${index + 1}`, () => void removeOpening(index)));
    head.append(pills);
    // The numbers and "+" show once there is something to number, and "+" only after the last one has text.
    const syncPills = () => {
        const lastText = index === openings.length - 1 ? area.value : openings[openings.length - 1];
        pills.hidden = openings.length < 2 && !area.value.trim();
        addButton.hidden = !String(lastText).trim();
    };

    const narrated = t.campaign.mode === 'narrated';
    if (narrated) {
        head.append(el('span', 'ct-gs-opening-by', 'Sent by the narrator'));
    } else if (t.members.length > 1) {
        const by = el('label', 'ct-gs-opening-by');
        by.append(el('span', '', 'Sent by'));
        const select = el('select', 'text_pole');
        select.id = 'ct-gs-start-speaker';
        const disabled = new Set(t.disabled);
        const first = t.members.find(avatar => !disabled.has(avatar)) ?? t.members[0];
        select.append(option('', `First member (${characterName(first)})`, !start.speaker || !t.members.includes(start.speaker)));
        for (const avatar of t.members) select.append(option(avatar, characterName(avatar), avatar === start.speaker));
        select.addEventListener('change', () => void setStart({ speaker: select.value }));
        by.append(select);
        head.append(by, helpButton('Sent by', HELP.speaker));
    }
    wrap.append(head);

    area.id = 'ct-gs-start-opening';
    area.rows = 7;
    area.setAttribute('aria-label', `Opening message ${index + 1}`);
    area.placeholder = index === 0
        ? 'The first message of every new chat. Leave it empty to use the characters\' own greetings.'
        : 'Another way the story can open. It becomes a swipe of the first one.';
    area.value = openings[index];
    fitRows(area, 7, 18);
    area.addEventListener('change', () => {
        const next = [...openings];
        next[index] = area.value;
        if (!area.value.trim() && next.length > 1) {
            next.splice(index, 1);
            state.opening = Math.max(0, index - 1);
            void setStart({ openings: next }, { rerender: true });
            return;
        }
        void setStart({ openings: next });
    });
    area.addEventListener('input', syncPills);
    syncPills();
    wrap.append(area);
    return wrap;
}

async function removeOpening(index) {
    const openings = [...target().start.openings];
    const text = String(openings[index] ?? '');
    if (text.trim()) {
        const answer = await new Popup(`<div class="ct-gm-ask"><h3>Remove opening ${index + 1}?</h3><p>${escapeHtml(text.trim().slice(0, 160))}${text.trim().length > 160 ? '…' : ''}</p></div>`, POPUP_TYPE.CONFIRM, '', { okButton: 'Remove', cancelButton: 'Cancel' }).show();
        if (answer !== POPUP_RESULT.AFFIRMATIVE) return;
    }
    openings.splice(index, 1);
    state.opening = Math.max(0, Math.min(index, openings.length - 1));
    await setStart({ openings }, { rerender: true });
}

async function loadFromVault() {
    const vault = globalThis.HomunculusVault;
    if (!vault?.pickScenario) {
        toastr.error('The Vault is not loaded.');
        return;
    }
    const scenario = await vault.pickScenario();
    if (!scenario) return;
    if (!isEmptyStart(target().start)) {
        const answer = await new Popup(`<div class="ct-gm-ask"><h3>Use "${escapeHtml(scenario.name)}"?</h3><p>The scenario and opening messages here are replaced by the ones from the Vault.</p></div>`, POPUP_TYPE.CONFIRM, '', { okButton: 'Replace', cancelButton: 'Cancel' }).show();
        if (answer !== POPUP_RESULT.AFFIRMATIVE) return;
    }
    await loadScenario(scenario);
}

/** Fills the start from a Vault scenario and adds its lorebooks to the group. */
async function loadScenario(scenario) {
    const vault = globalThis.HomunculusVault;
    const t = target();
    const done = [];
    if (t.isNew && !state.draft.name.trim()) state.draft.name = scenario.name;
    const known = new Set(Array.isArray(world_names) ? world_names : []);
    const found = scenario.lorebooks.filter(name => known.has(name));
    const missing = scenario.lorebooks.filter(name => !known.has(name));
    const lorebooks = [...new Set([...t.profile.lorebooks, ...found])];
    if (lorebooks.length !== t.profile.lorebooks.length) {
        await setProfile({ lorebooks });
        done.push(`lorebook${found.length === 1 ? '' : 's'} ${found.join(', ')}`);
    }
    state.opening = 0;
    await setStart({
        scenario: vault?.scenarioText ? vault.scenarioText(scenario) : scenario.setting,
        openings: [...scenario.firstMessages],
        vaultId: scenario.id,
        vaultName: scenario.name,
    }, { rerender: true });
    const openings = scenario.firstMessages.length;
    done.unshift('scenario', ...(openings ? [`${openings} opening${openings === 1 ? '' : 's'}`] : []));
    toastr.success(`Loaded "${scenario.name}": ${done.join(', ')}.`);
    if (missing.length) toastr.warning(`Not found in your lorebooks: ${missing.join(', ')}.`);
}

async function saveStartToVault() {
    const vault = globalThis.HomunculusVault;
    if (!vault?.saveScenarioFromStart) {
        toastr.error('The Vault is not loaded.');
        return;
    }
    const t = target();
    const saved = await vault.saveScenarioFromStart({
        name: t.name.trim() || 'New scenario',
        text: t.start.scenario,
        firstMessages: usableOpenings(t.start),
        lorebooks: t.profile.lorebooks,
        vaultId: t.start.vaultId,
    });
    if (saved) await setStart({ vaultId: saved.id, vaultName: saved.name }, { rerender: true });
}

// ───────────────────────── New group: starting points ─────────────────────────

const GUIDE_CHOICES = [
    {
        id: 'simple',
        icon: 'fa-comments',
        title: 'Simple group chat',
        line: 'Everyone replies in turn and you play your persona. Nothing extra.',
        sets: ['Everyone replies', 'You: Player', 'No Scene panel'],
    },
    {
        id: 'narrated',
        icon: 'fa-feather-pointed',
        title: 'Narrated adventure',
        line: 'One narrator voices the whole cast and keeps track of the world for you.',
        sets: ['Built-in narrator', 'You: Player', 'Scene panel: world + characters'],
    },
    {
        id: 'write',
        icon: 'fa-pen-nib',
        title: 'Write a story together',
        line: 'You guide the story and the AI writes it. The characters act on their own; step in whenever you want.',
        sets: ['You: Director (you guide, nobody plays)', 'Plot panel with your planned beats', 'Let them act and Auto-play'],
    },
];
const GUIDE_TITLES = { simple: 'Simple group chat', narrated: 'Narrated adventure', write: 'Write a story together', scratch: 'Start from scratch' };
const ROLE_NAMES = { player: 'Player', coauthor: 'Co-author', author: 'Director' };

function guideCard(choice) {
    const isOn = state.guideChoice === choice.id;
    const node = button(`ct-gs-guide-card${isOn ? ' is-on' : ''}`, `<span class="ct-gs-guide-icon"><i class="fa-solid ${choice.icon}" aria-hidden="true"></i></span>`, '', () => {
        state.guideChoice = choice.id;
        render();
    });
    node.setAttribute('aria-pressed', String(isOn));
    node.append(el('span', 'ct-gs-guide-title', choice.title), el('span', 'ct-gs-guide-line', choice.line), el('span', 'ct-gs-guide-kicker', 'Sets up'));
    const list = el('span', 'ct-gs-guide-sets');
    for (const item of choice.sets) list.append(el('span', '', item));
    node.append(list);
    return node;
}

/** The first screen of a new group: pick a starting point (it only fills in the Setup). */
function renderGuide(page) {
    const wrap = el('div', 'ct-gs-guide');
    const head = el('div', 'ct-gs-guide-head');
    head.append(el('h2', 'ct-gs-guide-heading', 'How do you want to play?'), el('p', 'ct-gs-guide-sub', 'Pick a starting point. It only fills in the setup; you can change everything afterwards.'));
    const grid = el('div', 'ct-gs-guide-grid');
    const standard = el('div', 'ct-gs-guide-group');
    standard.append(el('span', 'ct-gs-guide-group-title', 'Standard SillyTavern'), el('span', 'ct-gs-guide-group-sub', 'The group chat SillyTavern already has.'));
    const added = el('div', 'ct-gs-guide-group ct-gs-guide-group-wide');
    added.append(el('span', 'ct-gs-guide-group-title', 'Added by Homunculus'), el('span', 'ct-gs-guide-group-sub', 'Modes this project adds on top of SillyTavern.'));
    grid.append(standard, added, ...GUIDE_CHOICES.map(guideCard));
    const actions = el('div', 'ct-gs-guide-actions');
    const next = button('ct-cb-btn is-primary ct-gs-guide-next', '<span>Continue</span>', '', () => void applyGuide(state.guideChoice));
    next.disabled = !state.guideChoice;
    const others = el('div', 'ct-gs-guide-others');
    const scratch = button(`ct-gs-guide-scratch${state.guideChoice === 'scratch' ? ' is-on' : ''}`, '<span>Start from scratch</span>', '', () => {
        state.guideChoice = 'scratch';
        render();
    });
    scratch.setAttribute('aria-pressed', String(state.guideChoice === 'scratch'));
    scratch.append(el('span', 'ct-gs-guide-muted', ' · empty setup, everything off'));
    const vault = button('ct-gm-link', 'Or start from a scenario in the Vault', '', async () => {
        await loadFromVault();
        if (!isEmptyStart(state.draft.start)) {
            state.guide = null;
            state.guideApplied = null;
            render();
        }
    });
    others.append(scratch, vault);
    actions.append(next, others);
    wrap.append(head, grid, actions);
    page.append(wrap);
}

/** Fills the New group form from a starting point; the name and the characters already picked stay. */
async function applyGuide(choice) {
    if (!choice) return;
    const before = state.draft;
    const narrator = narratorAvatar(before.campaign);
    state.draft = emptyDraft();
    state.draft.name = before.name;
    state.draft.members = before.members.filter(avatar => avatar !== narrator);
    state.draft.disabled = before.disabled.filter(avatar => state.draft.members.includes(avatar));
    state.draft.start = before.start;
    state.guide = null;
    state.guideApplied = choice;
    state.tab = 'setup';
    if (choice === 'narrated' || choice === 'write') {
        state.draft.behavior.generation_mode = 0;
        state.draft.campaign = normalizeCampaign({
            ...state.draft.campaign,
            mode: 'narrated',
            role: choice === 'write' ? 'author' : 'player',
            narrator: { ...state.draft.campaign.narrator, type: 'builtin' },
        });
        const kinds = choice === 'write' ? ['world', 'cast', 'plot'] : ['world', 'cast'];
        for (const tracker of SCENE_TRACKERS.filter(item => kinds.includes(item.kind))) await setTracker(tracker, true);
    }
    render();
    root?.querySelector('.ct-gs-body')?.scrollTo?.(0, 0);
}

/** A name for a group left unnamed: the Vault scenario, else the cast ("Aria & Bram", "Harley Quinn & co."). */
function suggestedName(t) {
    if (t.start?.vaultName) return t.start.vaultName;
    const narrator = narratorAvatar(t.campaign);
    const cast = t.members.filter(avatar => avatar !== narrator).map(characterName);
    const narrated = t.campaign.mode === 'narrated';
    if (!cast.length) {
        if (narrated && t.campaign.narrator.type === 'card' && narrator) return characterName(narrator);
        return narrated ? 'Narrated story' : 'New group';
    }
    if (cast.length === 1) return narrated ? `${cast[0]} & co.` : cast[0];
    if (cast.length === 2) return `${cast[0]} & ${cast[1]}`;
    return `${cast[0]}, ${cast[1]} & co.`;
}

function sceneTrackersOn(t) {
    const api = agentsApi();
    if (!api?.getAgents) return [];
    const agents = api.getAgents();
    return SCENE_TRACKERS.filter(tracker => agents.some(agent => agent.sourceTemplateId === tracker.templateId && agentOnInGroup(t.profile, agent))).map(tracker => tracker.title);
}

/** What the new group has and still needs ("Ready to play"). state: ok | todo | optional. */
function readyChecks(t) {
    const c = t.campaign;
    const narrator = narratorAvatar(c);
    const builtin = c.mode === 'narrated' && c.narrator.type === 'builtin';
    const cast = t.members.filter(avatar => avatar !== narrator);
    const checks = [];
    if (cast.length) {
        const names = cast.slice(0, 3).map(characterName).join(', ');
        checks.push({ state: 'ok', text: `Cast: ${names}${cast.length > 3 ? ` +${cast.length - 3}` : ''}`, tab: 'cast' });
    } else if (c.mode === 'narrated') {
        checks.push({ state: 'optional', text: 'Cast (optional): the narrator can invent characters', tab: 'cast' });
    } else {
        checks.push({ state: 'todo', text: 'Add at least one character', tab: 'cast' });
    }
    if (c.mode === 'narrated') {
        if (builtin) checks.push({ state: 'ok', text: 'Narrator: built-in', tab: 'setup' });
        else if (narrator) checks.push({ state: 'ok', text: `Narrator: ${characterName(narrator)}`, tab: 'setup' });
        else checks.push({ state: 'todo', text: 'Choose the narrator', tab: 'setup' });
    } else {
        checks.push({ state: 'ok', text: 'Everyone replies in turn', tab: 'setup' });
    }
    checks.push({ state: 'ok', text: `You: ${ROLE_NAMES[c.role] ?? 'Player'}`, tab: 'setup' });
    const trackers = sceneTrackersOn(t);
    if (trackers.length) checks.push({ state: 'ok', text: `Scene panel: ${trackers.join(', ')}`, tab: 'scene' });
    checks.push(isEmptyStart(t.start) ? { state: 'optional', text: 'Opening message (optional)', tab: 'setup' } : { state: 'ok', text: 'Story start written', tab: 'setup' });
    return checks;
}

const ROLE_TILES = [
    ['player', 'fa-user', 'Player', 'You play {{user}}.'],
    ['coauthor', 'fa-feather', 'Co-author', 'You give directions. The AI writes {{user}} too.'],
    ['author', 'fa-clapperboard', 'Director', 'No {{user}}. You direct from outside, or watch.'],
];

function renderRoleCard(t) {
    const c = t.campaign;
    const section = card('Your role in the story', HELP.role);
    const tiles = el('div', 'ct-gs-tiles ct-gs-tiles-3');
    tiles.setAttribute('role', 'radiogroup');
    tiles.setAttribute('aria-label', 'Your role');
    for (const [role, icon, title, text] of ROLE_TILES) {
        const isOn = c.role === role;
        const tile = button(`ct-gs-tile${isOn ? ' is-on' : ''}`, `<i class="fa-solid ${icon}" aria-hidden="true"></i>`, '', () => {
            if (!isOn) void setCampaign({ role });
        });
        tile.setAttribute('role', 'radio');
        tile.setAttribute('aria-checked', String(isOn));
        const textWrap = el('span', 'ct-gs-tile-text');
        textWrap.append(el('span', 'ct-gs-tile-title', title), el('span', 'ct-gs-tile-desc', text));
        tile.append(textWrap);
        tiles.append(tile);
    }
    section.append(tiles);
    if (c.role === 'player') return section;

    const grid = el('div', 'ct-gs-role-grid');
    if (c.role === 'author') {
        const main = el('select', 'text_pole');
        main.id = 'ct-gs-protagonist';
        main.append(option('', 'None', !c.protagonist));
        const narrator = narratorAvatar(c);
        for (const avatar of t.members.filter(item => item !== narrator)) main.append(option(avatar, characterName(avatar), avatar === c.protagonist));
        main.addEventListener('change', () => void setCampaign({ protagonist: main.value }));
        grid.append(field('Main character', HELP.protagonist, main));
    }
    const idle = el('select', 'text_pole');
    idle.id = 'ct-gs-idle';
    idle.append(option('act', 'The characters act', c.idle === 'act'), option('continue', 'The scene just continues', c.idle === 'continue'));
    idle.addEventListener('change', () => void setCampaign({ idle: idle.value }));
    grid.append(field('When I send nothing', HELP.idle, idle));
    section.append(grid);

    const inPreset = !t.isNew && roleInPreset(group());
    const fallback = defaultRolePrompt(c.role);
    const inside = [];
    if (inPreset) inside.push(el('p', 'ct-gs-note', 'Your preset already has these instructions, so they are not sent twice.'));
    inside.push(checkRow('Send these instructions', c.roleSend, checked => void setCampaign({ roleSend: checked }), HELP.roleSend));
    const area = el('textarea', 'text_pole ct-gs-role-text');
    area.id = `ct-gs-role-text-${c.role}`;
    area.rows = 10;
    area.value = c.roleText[c.role] || fallback;
    area.disabled = !c.roleSend;
    area.addEventListener('change', () => {
        const value = area.value.trim() === fallback.trim() ? '' : area.value;
        void setCampaign({ roleText: { [c.role]: value } });
    });
    inside.push(area);
    if (c.roleText[c.role]) inside.push(button('menu_button ct-gs-btn', '<i class="fa-solid fa-rotate-left"></i> Restore the default text', '', () => void setCampaign({ roleText: { [c.role]: '' } })));
    const summary = `Instructions for the AI${inPreset ? ' · in your preset' : c.roleText[c.role] ? ' · edited' : ''}`;
    section.append(more(`role-${c.role}`, summary, ...inside));
    return section;
}

function renderStyleCard(t) {
    const style = t.style;
    const aside = button('ct-cb-btn', '<i class="fa-solid fa-sliders"></i><span>Edit options</span>', 'Change the options or add your own', async () => {
        if (await openVarsEditor()) render();
    });
    const section = card('Story style', STYLE_HELP, { aside });
    for (const variable of listVars()) {
        const row = el('div', 'ct-gs-style-row');
        const label = el('div', 'ct-gs-style-label');
        label.append(el('span', 'ct-gs-label', variable.label));
        const chips = el('div', 'ct-gs-style-options');
        chips.setAttribute('role', 'group');
        chips.setAttribute('aria-label', variable.label);
        for (const item of variable.options) {
            const isOn = style.values[variable.id] === item.id;
            const chipButton = button(`ct-gs-style-chip${isOn ? ' is-on' : ''}`, '', item.text, () => void setStyle({ values: { [variable.id]: isOn ? '' : item.id } }));
            chipButton.textContent = item.label;
            chipButton.setAttribute('aria-pressed', String(isOn));
            chips.append(chipButton);
        }
        row.append(label, chips);
        section.append(row);
    }
    for (const warning of styleConflicts(style)) section.append(el('p', 'ct-gs-warn', warning));
    const text = wrap('style', styleText(style));
    section.append(more('style-preview', 'What the AI gets', el('pre', 'ct-gs-style-text', text || 'Nothing picked yet.')));
    return section;
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
    builtinBody.append(el('span', 'ct-gs-label', 'Built-in narrator'));
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
    const turnField = field('Turn instruction', HELP.turn, turn);
    if (campaign.narrator.turnPrompt) {
        turnField.append(button('menu_button ct-gs-btn', '<i class="fa-solid fa-rotate-left"></i> Use the default', '', () => void setCampaign({ narrator: { turnPrompt: '' } })));
    }
    section.append(more('narrator-more', 'More narrator options', turnField,
        checkRow('Put the cast in the prompt automatically', campaign.castPlacement === 'prompt', checked => void setCampaign({ castPlacement: checked ? 'prompt' : 'macro' }), HELP.placement)));
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
        const vaultPicker = renderVaultPicker(t);
        if (vaultPicker) body.append(vaultPicker);
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
    const vaultPicker = renderVaultPicker(t);
    if (vaultPicker) body.append(vaultPicker);
}

function renderPicker(t, title) {
    const section = card(title, HELP.add, { className: 'ct-gs-picker' });
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
        // Cards made from Vault NPCs are listed under "From the Vault", not here.
        const fromVault = new Set((state.npcs ?? []).map(npc => npc.characterAvatar).filter(Boolean));
        const pool = characters
            .filter(character => character?.avatar && !t.members.includes(character.avatar) && !fromVault.has(character.avatar))
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

/** "From the Vault": the Vault's NPCs, in an area of their own under the character picker. */
function renderVaultPicker(t) {
    const vault = globalThis.HomunculusVault;
    if (!vault?.listNpcs) return null;
    const aside = button('ct-cb-btn', '<i class="fa-solid fa-vault"></i><span>Open the Vault</span>', '', () => vault.open('npcs'));
    const section = card('From the Vault', HELP.npcPick, { aside, className: 'ct-gs-picker ct-gs-vault-picker' });
    renderNpcPicker(section, t, vault);
    return section;
}

function renderNpcPicker(section, t, vault) {
    if (state.npcs === null) {
        vault.listNpcs().then((list) => {
            state.npcs = list;
        }).catch(() => {
            state.npcs = [];
        }).finally(() => {
            if (state.open && state.tab === 'cast') render();
        });
        section.append(el('p', 'ct-gs-note', 'Opening the Vault…'));
        return;
    }
    if (!state.npcs.length) {
        section.append(el('p', 'ct-gs-note', 'No NPCs in the Vault yet. Save them from the Scene panel or from a scenario.'));
        return;
    }
    const search = el('input', 'text_pole ct-gs-search');
    search.id = 'ct-gs-npc-search';
    search.type = 'search';
    search.placeholder = 'Search NPCs…';
    search.value = state.npcSearch;
    search.setAttribute('aria-label', 'Search Vault NPCs to add');
    const results = el('div', 'ct-gs-candidates');
    const fill = () => {
        results.replaceChildren();
        const term = state.npcSearch.trim().toLowerCase();
        const pool = state.npcs
            .filter((npc) => {
                const linked = vault.npcCharacter(npc);
                return !linked || !t.members.includes(linked.avatar);
            })
            .filter(npc => !term || [npc.name, npc.role, ...npc.tags].join(' ').toLowerCase().includes(term));
        for (const npc of pool.slice(0, 48)) {
            const hasCard = Boolean(vault.npcCharacter(npc));
            const tile = button(`ct-gs-candidate${hasCard ? '' : ' needs-card'}`, '', hasCard ? `Add ${npc.name}` : `Make a character card for ${npc.name}, then add it`, () => void addNpc(npc));
            const text = el('span', 'ct-gs-candidate-text');
            text.append(el('span', 'ct-gs-candidate-name', npc.name), el('span', 'ct-gs-candidate-sub', hasCard ? (npc.role || 'Has a card') : 'No card yet'));
            const add = el('span', 'ct-gs-candidate-add', hasCard ? '+' : '');
            if (!hasCard) add.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i>';
            tile.append(vault.npcFace(npc, 'ct-gs-candidate-img'), text, add);
            results.append(tile);
        }
        if (pool.length > 48) results.append(el('p', 'ct-gs-note ct-gs-candidates-more', `${pool.length - 48} more. Type a name to find them.`));
        if (!pool.length) results.append(el('p', 'ct-gs-note', term ? 'No NPCs match.' : 'Every NPC with a card is already in this group.'));
    };
    search.addEventListener('input', () => {
        state.npcSearch = search.value;
        fill();
    });
    if (state.npcs.length > 8) section.append(search);
    section.append(results);
    fill();
}

/** Adds a Vault NPC to the group, making its character card first when it has none. */
async function addNpc(npc) {
    const vault = globalThis.HomunculusVault;
    let character = vault.npcCharacter(npc);
    const madeNow = !character;
    if (madeNow) {
        try {
            const saved = await vault.makeCharacterFromNpc(npc);
            if (!saved) return;
            character = vault.npcCharacter(saved);
        } catch (error) {
            toastr.error(String(error?.message ?? error), 'Could not make the character');
            return;
        }
        if (!character) return;
    }
    const t = target();
    if (!t.members.includes(character.avatar)) await setMembers([...t.members, character.avatar], t.disabled);
    const after = target();
    const narrated = after.campaign.mode === 'narrated';
    if (narrated) {
        const entry = after.campaign.cast[character.avatar] ?? { state: CAST_STATES.SCENE, sheet: '', line: '' };
        if (!entry.sheet) await setCampaign({ cast: { ...after.campaign.cast, [character.avatar]: { ...entry, sheet: vault.npcSheetText(npc) } } });
    }
    if (!madeNow) toastr.success(`${character.name} joined the ${narrated ? 'cast' : 'group'}.`);
}

// ───────────────────────── Scene tab ─────────────────────────

function renderSceneTab(body, t) {
    const api = agentsApi();
    const sceneApi = globalThis.HomunculusScene;
    const g = group();
    const isOpenChat = g && String(selected_group) === String(g.id);
    const aside = sceneApi && isOpenChat && sceneApi.isAvailable()
        ? button('ct-cb-btn', `<i class="fa-solid fa-masks-theater"></i><span>${sceneApi.isOpen() ? 'Hide' : 'Show'} the panel</span>`, '', () => {
            sceneApi.toggle();
            render();
        })
        : null;
    const intro = card('Scene panel', HELP.scene, { aside, intro: 'Trackers fill a panel beside the chat. Turn on the ones you want.' });
    if (!api?.getAgents) {
        intro.append(el('p', 'ct-gs-warn', 'In-Chat Agents are not loaded, so the Scene trackers can\'t run.'));
        body.append(intro);
        return;
    }
    if (g && isOpenChat && !isActive(g.id) && t.profile.agents.mode !== AGENT_MODES.KEEP) {
        const row = el('div', 'ct-gs-warn ct-gs-inline-note');
        row.append(el('span', '', 'The group\'s settings are off in the open chat, so its trackers are not running there.'));
        row.append(button('menu_button ct-gs-btn', 'Use the group\'s settings', '', async () => {
            await enterHere();
            render();
        }));
        intro.append(row);
    }
    body.append(intro);

    const grid = el('div', 'ct-gs-tracker-grid');
    for (const tracker of SCENE_TRACKERS) grid.append(renderTrackerCard(tracker, t, isOpenChat));
    body.append(grid);
}

/** One line on what a field preset records ("About: Description, Traits · Stats: Age, Height…"). */
function presetSummary(kind, preset) {
    if (kind === 'world') {
        const on = ['time', 'location', 'weather', 'quests', 'inventory', 'factions'].filter(key => preset.modules[key]).map(key => (key === 'inventory' ? 'items' : key));
        return [...on, ...preset.fields.map(item => item.label.toLowerCase())].join(', ');
    }
    return preset.sections.filter(section => section.fields.length).map(section => `${section.label}: ${section.fields.map(item => item.label).join(', ')}`).join(' · ');
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
        // Not made yet: switching it on adds the agent.
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
    section.append(field('Model', HELP.trackerProfile, profileSelect));

    const g = group();
    const fieldKind = tracker.kind === 'cast' ? 'cast' : 'world';
    if (tracker.presets === false) {
        // no field presets for this tracker
    } else if (g) {
        const presetSelect = el('select', 'text_pole');
        presetSelect.id = `ct-gs-tracker-preset-${tracker.kind}`;
        const chosen = chosenPresetId(fieldKind, g.id);
        const fallback = activePreset(fieldKind, null);
        presetSelect.append(option('', `Default (${fallback.name})`, !chosen));
        for (const preset of listPresets(fieldKind)) presetSelect.append(option(preset.id, preset.builtin ? preset.name : `${preset.name} (mine)`, preset.id === chosen));
        presetSelect.addEventListener('change', async () => {
            await choosePreset(fieldKind, presetSelect.value, g.id);
            toastr.success('Field preset saved for this group.');
            render();
        });
        const fieldsRow = el('div', 'ct-gs-preset-row');
        fieldsRow.append(presetSelect, button('menu_button ct-gs-btn', '<i class="fa-solid fa-table-list"></i> Edit fields', 'See, change or make field presets', async () => {
            await openFieldsEditor(fieldKind, { groupId: g.id });
            render();
        }));
        const used = activePreset(fieldKind, g.id);
        fieldsRow.title = presetSummary(fieldKind, used);
        section.append(field('Fields', HELP.scenePreset, fieldsRow));
    } else {
        // A new group picks its field preset after it is made.
    }

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
    const section = card('When this group is open', HELP.profile);

    if (!t.isNew) section.append(checkRow('Ask before using the group\'s settings', shouldAsk(state.groupId), checked => setShouldAsk(state.groupId, checked), HELP.ask));

    const presets = getPresetManager('openai')?.getAllPresets?.() ?? [];
    const preset = el('select', 'text_pole');
    preset.id = 'ct-gs-preset';
    preset.append(option('', 'Keep current', !profile.preset));
    for (const name of presets) preset.append(option(name, name, name === profile.preset));
    if (profile.preset && !presets.includes(profile.preset)) preset.append(option(profile.preset, `${profile.preset} (missing)`, true));
    preset.addEventListener('change', () => void setProfile({ preset: preset.value }));
    section.append(field('Chat Completion preset', HELP.preset, preset));

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
    section.append(field('Extra lorebooks', HELP.lorebooks, lore));
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
    if (profile.agents.mode === AGENT_MODES.KEEP) section.append(el('p', 'ct-gs-note', 'Your usual agents run here. Pick "Only these" or "Add to my usual" to choose.'));

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

// ───────────────────────── Prompts tab ─────────────────────────

const PLACEMENTS = [['macro', 'Where my preset has it'], ['main', 'End of the Main Prompt'], ['chat', 'In the chat, near the end']];

/** The short status shown on a prompt row: [text, kind]. */
function promptStatus(block) {
    const current = blockStatus(block.id);
    const placement = getPlacement(block.id);
    if (current === 'off') return ['Off', 'muted'];
    if (current === 'preset-macro') return ['In your preset', 'good'];
    if (current === 'no-place') return ['Not sent: no place in your preset', 'warn'];
    const where = placement.mode === 'chat' ? `In the chat (depth ${placement.depth})` : 'End of the Main Prompt';
    return current === 'empty' ? [`${where} · nothing now`, 'muted'] : [where, 'good'];
}

function openLastPromptItemization() {
    const buttons = [...document.querySelectorAll('#chat .mes .mes_prompt')];
    const last = buttons[buttons.length - 1];
    if (!last) {
        toastr.info('Generate a reply first. Then this shows exactly what was sent.');
        return;
    }
    close();
    last.click();
}

function renderPromptRow(block, t) {
    const placement = getPlacement(block.id);
    const current = blockStatus(block.id);
    const row = el('div', `ct-gs-prow${placement.enabled ? '' : ' is-off'}`);
    row.dataset.block = block.id;
    const head = el('div', 'ct-gs-prow-head');
    const onOff = toggleSwitch('', placement.enabled, enabled => setPlacement(block.id, { enabled }));
    onOff.querySelector('input').setAttribute('aria-label', `Send ${block.label}`);
    const [statusText, kind] = promptStatus(block);
    const title = el('span', 'ct-gs-prow-title');
    const name = el('span', 'ct-gs-prow-name', block.label);
    name.title = block.about;
    title.append(name, el('span', `ct-gs-prow-status is-${kind}`, statusText));

    const inside = [];
    const where = el('select', 'text_pole');
    where.id = `ct-gs-prompt-where-${block.id}`;
    for (const [value, label] of PLACEMENTS) where.append(option(value, value === 'macro' ? `${label} ({{${block.macro}}})` : label, placement.mode === value));
    where.addEventListener('change', () => setPlacement(block.id, { mode: where.value }));
    const placeRow = el('div', 'ct-gs-prompt-row');
    placeRow.append(field('Where', HELP.promptWhere, where));
    if (placement.mode === 'chat') {
        const depth = el('input', 'text_pole');
        depth.type = 'number';
        depth.min = '0';
        depth.max = '50';
        depth.value = String(placement.depth);
        depth.id = `ct-gs-prompt-depth-${block.id}`;
        depth.addEventListener('change', () => setPlacement(block.id, { depth: Math.min(50, Math.max(0, Number.parseInt(depth.value, 10) || 0)) }));
        placeRow.append(field('Depth', HELP.promptDepth, depth));
        const role = el('select', 'text_pole');
        role.id = `ct-gs-prompt-role-${block.id}`;
        for (const [value, label] of [['system', 'System'], ['user', 'User'], ['assistant', 'AI']]) role.append(option(value, label, placement.role === value));
        role.addEventListener('change', () => setPlacement(block.id, { role: role.value }));
        placeRow.append(field('As', HELP.promptRole, role));
    }
    if (current === 'preset-macro') inside.push(el('p', 'ct-gs-note', `Your preset has ${presetMacrosOf(block.id).map(macro => `{{${macro}}}`).join(', ')}. Move it in the Prompt Manager.`));
    else inside.push(placeRow);
    if (block.id === 'role' && roleInPreset(group())) inside.push(el('p', 'ct-gs-note', 'Your preset has the role prompt itself, so only the extra lines are sent.'));
    if (block.id === 'style') for (const warning of styleConflicts(t.style)) inside.push(el('p', 'ct-gs-warn', warning));
    inside.push(el('pre', 'ct-gs-style-text ct-gs-prow-preview', blockPreview(block.id) || '(nothing in the open chat right now)'));
    const tools = el('div', 'ct-gs-prompt-info');
    const copy = button('ct-cb-btn', `<i class="fa-regular fa-copy"></i><span>{{${block.macro}}}</span>`, 'Copy the macro', () => {
        navigator.clipboard?.writeText(`{{${block.macro}}}`).then(() => toastr.success('Macro copied.')).catch(() => {});
    });
    tools.append(copy, button('ct-cb-btn', '<i class="fa-solid fa-rotate-left"></i><span>Default</span>', 'Back to the default place', () => resetPlacement(block.id)));
    inside.push(tools);
    head.append(onOff, more(`prompt-${block.id}`, title, ...inside));
    row.append(head);
    return row;
}

function renderPromptsCard(t) {
    const aside = button('ct-cb-btn', '<i class="fa-solid fa-magnifying-glass"></i><span>See the last prompt</span>', 'What was sent for the last reply', openLastPromptItemization);
    const section = card('Prompts', HELP.prompts, { aside, className: 'ct-gs-prompts' });
    const missing = missingSections();
    if (missing.length) {
        const row = el('div', 'ct-gs-warn ct-gs-inline-note ct-gs-prompt-sections');
        row.append(el('span', '', `Your preset has no place for ${missing.length === PROMPT_BLOCKS.length ? 'these' : missing.map(block => block.label).join(', ')}.`));
        row.append(button('menu_button ct-gs-btn', '<i class="fa-solid fa-plus"></i> Add them to my preset', '', async () => {
            try {
                const added = await addSectionsToPreset();
                toastr.success(`${added} section${added === 1 ? '' : 's'} added. Save the preset to keep them.`);
            } catch (error) {
                toastr.error(String(error?.message ?? error));
            }
            render();
        }), helpButton('Preset sections', HELP.promptSections));
        section.append(row);
    }
    const list = el('div', 'ct-gs-prow-list');
    for (const block of PROMPT_BLOCKS) list.append(renderPromptRow(block, t));
    section.append(list);
    return section;
}

function renderSettingsTab(body, t) {
    renderProfileTab(body, t);
    body.append(renderPromptsCard(t));
    renderBehaviorTab(body, t);
}

function renderBehaviorTab(body, t) {
    const section = card('Who replies', HELP.behavior);
    if (t.campaign.mode === 'narrated') {
        section.append(el('p', 'ct-gs-note', 'Narrated: the narrator replies to every message.'));
        body.append(section);
        return;
    }
    const strategy = el('select', 'text_pole');
    strategy.id = 'ct-gs-strategy';
    for (const [value, label] of STRATEGIES) strategy.append(option(value, label, value === t.behavior.activation_strategy));
    strategy.addEventListener('change', () => void setBehavior({ activation_strategy: Number(strategy.value) }));
    section.append(field('Order', '', strategy));
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
    footer.hidden = !t.isNew || state.guide === 'pick';
    if (footer.hidden) return;
    footer.classList.add('ct-gs-ready');
    footer.append(el('span', 'ct-gs-ready-kicker', 'Ready to play'));
    const list = el('div', 'ct-gs-ready-list');
    const checks = readyChecks(t);
    const icons = { ok: 'fa-circle-check', todo: 'fa-circle-exclamation', optional: 'fa-circle-minus' };
    const labels = { ok: 'Done', todo: 'To do', optional: 'Optional' };
    for (const check of checks) {
        const html = `<i class="fa-solid ${icons[check.state]}" aria-hidden="true"></i><span class="sr-only">${labels[check.state]}: </span>`;
        const item = button(`ct-gs-ready-item is-${check.state}`, html, '', () => {
            if (check.tab && check.tab !== state.tab) {
                state.tab = check.tab;
                render();
                root.querySelector('.ct-gs-body').scrollTop = 0;
            }
        });
        item.append(el('span', '', check.text));
        list.append(item);
    }
    footer.append(list);
    const left = checks.filter(check => check.state === 'todo').length;
    const label = left ? `${left} thing${left === 1 ? '' : 's'} left` : 'Create group and open chat';
    const createButton = button('ct-cb-btn is-primary', `<i class="fa-solid fa-check" aria-hidden="true"></i><span>${label}</span>`, '', () => void createGroupNow());
    createButton.id = 'ct-gs-create';
    createButton.disabled = left > 0 || state.creating;
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
    const body = root.querySelector('.ct-gs-body');
    const keepScroll = body.scrollTop;
    const focusedId = document.activeElement?.id;
    body.replaceChildren();
    const guiding = t.isNew && state.guide === 'pick';
    const nav = root.querySelector('.ct-gs-tabs');
    nav.hidden = guiding;
    if (guiding) {
        body.removeAttribute('aria-labelledby');
        const guidePage = el('div', 'ct-gs-page ct-gs-page-guide');
        renderGuide(guidePage);
        body.append(guidePage);
        renderFooter(t);
        body.scrollTop = keepScroll;
        if (focusedId) document.getElementById(focusedId)?.focus();
        return;
    }
    renderTabs(t);
    body.setAttribute('aria-labelledby', `ct-gs-tab-${state.tab}`);
    const page = el('div', `ct-gs-page ct-gs-page-${state.tab}`);
    ({
        setup: renderSetup,
        cast: renderCastTab,
        scene: renderSceneTab,
        chats: renderChatsTab,
        agents: renderAgentsTab,
        settings: renderSettingsTab,
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
async function attachSettings(groupId, profile, campaign, start) {
    const made = findGroup(groupId);
    if (!made) return;
    made.homunculus_profile = structuredClone(profile);
    made.homunculus_campaign = structuredClone(campaign);
    if (start && !isEmptyStart(start)) made.homunculus_start = normalizeStart({ ...start, openings: usableOpenings(start) });
    await editGroup(made.id, true, false);
}

async function createGroupNow() {
    const t = target();
    if (!t.isNew || state.creating) return;
    const builtinNeeded = t.campaign.mode === 'narrated' && t.campaign.narrator.type === 'builtin' && !t.campaign.narrator.builtinAvatar;
    if (!t.members.length && !builtinNeeded) return;
    if (readyChecks(t).some(check => check.state === 'todo')) return;
    state.creating = true;
    renderFooter(t);
    try {
        if (builtinNeeded) {
            const avatar = await createBuiltinNarrator(t.name.trim() || 'group', t.campaign.narrator.style);
            t.campaign = normalizeCampaign({ ...t.campaign, narrator: { ...t.campaign.narrator, builtinAvatar: avatar } });
            t.members = [avatar, ...t.members];
        }
        const data = await postGroup({
            name: t.name.trim() || suggestedName(t),
            members: t.members,
            allow_self_responses: t.behavior.allow_self_responses,
            activation_strategy: t.behavior.activation_strategy,
            generation_mode: t.behavior.generation_mode,
            disabled_members: t.disabled,
        });
        // The start is attached before the chat opens: the first chat is filled from it (classic-group-start.js).
        await attachSettings(data.id, t.profile, t.campaign, t.start);
        if (Object.keys(t.style.values).length || !t.style.inject) await saveStyle(data.id, t.style);
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
        await attachSettings(data.id, getProfile(g), getCampaign(g), getStart(g));
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
 * @param {string} [tab] setup, cast, scene, chats, agents or settings (profile, behavior and prompts open Settings)
 */
function open(groupId = openGroupId ?? selected_group, tab = '') {
    const id = groupId ? String(groupId) : null;
    if (id && findGroup(id)) {
        if (state.mode !== 'edit' || state.groupId !== id) {
            state.charSearch = '';
            state.npcSearch = '';
            state.agentSearch = '';
            state.chats = null;
            state.menuOpen = false;
            state.opening = 0;
        }
        state.mode = 'edit';
        state.groupId = id;
    } else if (state.mode !== 'new') {
        state.mode = 'new';
        state.draft = emptyDraft();
        state.guide = 'pick';
        state.guideChoice = null;
        state.guideApplied = null;
    }
    const wanted = TAB_ALIASES[tab] ?? tab;
    if (wanted && TABS.some(item => item.id === wanted)) state.tab = wanted;
    show();
}

/**
 * Opens the New group form.
 * @param {{ scenarioId?: string, name?: string }} [options] start from a Vault scenario
 */
function create(options = {}) {
    if (state.mode !== 'new' || options.scenarioId) {
        state.draft = emptyDraft();
        state.charSearch = '';
        state.npcSearch = '';
        state.agentSearch = '';
        // A scenario from the Vault already says how the story starts, so its form opens on the Setup.
        state.guide = options.scenarioId ? null : 'pick';
        state.guideChoice = null;
        state.guideApplied = null;
    }
    if (options.scenarioId) {
        state.draft.name = String(options.name ?? '');
        void globalThis.HomunculusVault?.getItem?.('scenarios', String(options.scenarioId)).then((scenario) => {
            if (scenario && state.mode === 'new') return loadScenario(scenario);
        });
    }
    state.mode = 'new';
    state.groupId = null;
    state.tab = 'setup';
    state.menuOpen = false;
    state.opening = 0;
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
    document.addEventListener(FIELDS_CHANGED_EVENT, rerender);
    document.addEventListener(STYLE_CHANGED_EVENT, rerender);
    document.addEventListener(PROMPTS_CHANGED_EVENT, rerender);
    document.addEventListener('homunculus:vault-changed', () => {
        state.npcs = null;
        if (state.tab === 'cast') rerender();
    });
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
