// Classic UI fork: Group Studio.
//
// A page of its own (like the Card Browser) where groups are made and set up: the list of groups on
// the left, and for the chosen group its name, members, profile (Chat Completion preset, persona,
// lorebooks, agents) and reply behavior. The rules for applying a profile live in
// classic-group-profile.js; this file is only the page.
//
// Open it from its own button in the top bar, the "Create New Chat Group" button in the Characters
// panel, the sliders button in the group panel, "Edit profile" in the group mode bar, or with
// globalThis.HomunculusGroupStudio.open(groupId) / .create().

import { helpButton, closeHelp } from './classic-help.js';
import { groups, selected_group, openGroupId, openGroupById, editGroup } from './group-chats.js';
import { getPresetManager } from './preset-manager.js';
import { power_user } from './power-user.js';
import { world_names } from './world-info.js';
import { humanizedDateTime } from './RossAscends-mods.js';
import { eventSource, event_types, characters, default_avatar, getCharacters, getRequestHeaders, getThumbnailUrl } from '../script.js';
import {
    AGENT_MODES,
    PROFILE_CHANGED_EVENT,
    applyAgentChoice,
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
    INJECT,
    NPC_MODES,
    WORLD_MODULES,
    castMembers,
    connectionProfiles,
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

const HELP = {
    page: `<p>Make and set up your groups here.</p>
<p>Pick a group on the left, or press <b>New group</b>. Changes to an existing group are saved right away.</p>
<p>The <b>Group profile</b> (preset, persona, lorebooks, agents) is applied when you open one of the group's chats, and your own settings come back when you leave.</p>`,
    members: `<p>The characters in this group.</p>
<ul>
<li>Use the arrows to change the order (used by "List order").</li>
<li>The speech bubble <b>mutes</b> a character: they stay in the group but don't reply on their own.</li>
<li>The <b>×</b> takes a character out of the group.</li>
</ul>
<p>Two groups can have the same members, for example two campaigns with the same narrator.</p>`,
    add: '<p>Search your characters by name and click one to add it to the group.</p>',
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
<p>Your own agent lists are not changed. While this group's chat is open, the Agents drawer edits this group's list too.</p>`,
    behavior: `<ul>
<li><b>Who replies</b>: Natural order picks whoever is mentioned or fits; List order goes down the member list; Pooled order gives everyone a turn; Manual means nobody replies until you pick someone.</li>
<li><b>Character cards sent</b>: Swap sends only the card of whoever is replying; Join sends every member's card; "include muted" also sends the muted ones.</li>
<li><b>Allow self responses</b>: a character may reply right after itself.</li>
</ul>`,
};

HELP.mode = `<ul>
<li><b>Ensemble</b>: a normal group chat. Each character replies in turn, with their own card.</li>
<li><b>Narrated</b>: one <b>narrator</b> replies and voices everyone. The other members are the <b>cast</b>: they never reply on their own, and their sheets are given to the narrator instead of their whole cards.</li>
</ul>
<p>You can still make a cast member speak by hand with the member bar under the chat.</p>`;
HELP.narrator = `<p>Who tells the story.</p>
<ul>
<li><b>Use one of my characters</b>: pick a narrator card you already have.</li>
<li><b>Built-in narrator</b>: write how the narrator should tell the story. The Studio keeps a small card for it (named "Narrator (group name)") so you don't have to make one.</li>
</ul>`;
HELP.cast = `<ul>
<li><b>In scene</b>: the whole sheet goes to the AI.</li>
<li><b>Offscreen</b>: only one line goes, so the narrator knows they exist.</li>
<li><b>Off</b>: nothing is sent.</li>
</ul>
<p><b>Sheet</b>: a clean version of the card without instructions, scenario or first message. Without one, the card's description and personality are used. The card itself is never changed.</p>`;
HELP.placement = `<p>On: the cast sheets go into the prompt by themselves.</p>
<p>Off: they only go where your preset writes <code>{{cast}}</code>, so you can place them yourself. The world state works the same way with <code>{{worldState}}</code>.</p>`;
HELP.npc = `<p>Remembers named NPCs that show up in the story, so they come back the same way later.</p>
<ul>
<li>After each reply, a separate AI call reads only that reply. It notes someone only if they have a proper name and actually did or said something ("the innkeeper" doesn't count).</li>
<li><b>Ask me</b>: what it finds waits in "NPCs" above the chat; you keep or ignore each one. <b>Automatic</b>: they are added right away.</li>
<li>Each NPC becomes an entry in the campaign's NPC lorebook, keyed by name, so it only goes to the AI when the name comes up.</li>
</ul>
<p>The narrator is never told to look for NPCs. A cheap, fast connection profile is enough.</p>`;
HELP.world = `<p>Keeps track of the world, only with the parts you switch on.</p>
<ul>
<li>After every few replies, a separate AI call updates it. Time is counted by the app (minutes / hours / days).</li>
<li>It is saved in the message it came from, so swipes, deleting a message, regenerating and branches keep the right world.</li>
<li>For each part, choose when it goes into the prompt: <b>Always</b>, <b>When relevant</b> (only when the latest messages talk about it) or <b>Panel only</b> (never sent, just for you).</li>
<li>See and edit it with "World" above the chat.</li>
</ul>`;

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

function titleRow(tag, text, help) {
    const row = el('div', 'ct-gs-title-row');
    row.append(el(tag, 'ct-gs-title', text));
    if (help) row.append(helpButton(text, help));
    return row;
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
    draft: emptyDraft(),
    groupSearch: '',
    charSearch: '',
    agentSearch: '',
    creating: false,
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

function setProfile(patch) {
    const g = group();
    if (!g) {
        state.draft.profile = { ...state.draft.profile, ...patch, agents: { ...state.draft.profile.agents, ...(patch.agents ?? {}) } };
        render();
        return;
    }
    void saveProfile(g.id, patch);
}

async function setCampaign(patch) {
    const g = group();
    if (!g) {
        const current = state.draft.campaign;
        state.draft.campaign = normalizeCampaign({
            ...current,
            ...patch,
            narrator: { ...current.narrator, ...(patch.narrator ?? {}) },
            npc: { ...current.npc, ...(patch.npc ?? {}) },
            world: { ...current.world, ...(patch.world ?? {}) },
        });
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

function chooseAgent(agentId, enabled, usual) {
    const g = group();
    if (!g) {
        state.draft.profile = applyAgentChoice(state.draft.profile, agentId, enabled, usual);
        render();
        return;
    }
    setAgentChoice(g.id, agentId, enabled, usual);
}

// ───────────────────────── Rendering ─────────────────────────

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
                <div class="ct-gs-body"></div>
                <div class="ct-gs-footer"></div>
            </div>
        </div>`;
    root.querySelector('.ct-cb-titles .ct-cb-title').append(helpButton('Group Studio', HELP.page));
    root.querySelector('.ct-cb-back').addEventListener('click', close);
    document.body.append(root);
}

function renderHeader() {
    const t = target();
    const g = group();
    root.querySelector('.ct-gs-name').textContent = t.isNew ? (t.name.trim() || 'New group') : t.name;
    const count = t.members.length;
    const status = t.isNew ? 'Not created yet'
        : isActive(g.id) ? 'Group mode is on in the open chat'
            : String(selected_group) === String(g.id) ? 'Group mode is off in the open chat' : '';
    root.querySelector('.ct-cb-sub').textContent = [`${count} member${count === 1 ? '' : 's'}`, status].filter(Boolean).join(' · ');
    const avatars = root.querySelector('.ct-gs-avatars');
    avatars.replaceChildren(...t.members.slice(0, 5).map(avatar => avatarImg(avatar, '')));
    const actions = root.querySelector('.ct-gs-head-actions');
    actions.replaceChildren();
    if (!t.isNew) {
        actions.append(button('ct-cb-btn is-primary', '<i class="fa-solid fa-comments"></i><span>Open chat</span>', '', async () => {
            const id = g.id;
            close();
            if (String(selected_group) !== String(id)) await openGroupById(id);
        }));
    }
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
            const item = button(`ct-gs-group${state.mode === 'edit' && String(g.id) === String(state.groupId) ? ' is-on' : ''}`, '', '', () => open(g.id));
            const faces = el('span', 'ct-gs-group-faces');
            faces.append(...(g.members ?? []).slice(0, 3).map(avatar => avatarImg(avatar, '')));
            const text = el('span', 'ct-gs-group-text');
            text.append(el('span', 'ct-gs-group-name', g.name));
            const p = getProfile(g);
            const hasProfile = p.preset || p.persona || p.lorebooks.length || p.agents.mode !== AGENT_MODES.KEEP;
            text.append(el('span', 'ct-gs-group-meta', `${(g.members ?? []).length} members${hasProfile ? ' · profile' : ''}`));
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

function renderGroupCard(t) {
    const section = el('section', 'ct-gs-card');
    section.append(titleRow('h3', t.isNew ? 'New group' : 'Group', HELP.page));

    const name = el('input', 'text_pole');
    name.id = 'ct-gs-group-name';
    name.type = 'text';
    name.placeholder = t.isNew ? 'Name (optional), e.g. The Ashen Road' : 'Group name';
    name.value = t.name;
    name.addEventListener(t.isNew ? 'input' : 'change', () => void setName(name.value));
    section.append(field('Name', '', name));

    const modes = el('div', 'ct-gs-segment');
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', 'Group mode');
    for (const [mode, label] of [['ensemble', 'Ensemble'], ['narrated', 'Narrated']]) {
        const isOn = t.campaign.mode === mode;
        const b = button(isOn ? 'is-on' : '', label, '', () => void setMode(mode));
        b.setAttribute('aria-pressed', String(isOn));
        modes.append(b);
    }
    const modeHead = el('div', 'ct-gs-field-head');
    modeHead.append(el('span', 'ct-gs-label', 'Mode'), helpButton('Mode', HELP.mode));
    section.append(modeHead, modes, el('p', 'ct-gs-note', t.campaign.mode === 'narrated'
        ? 'One narrator replies and voices everyone. The other members are the cast.'
        : 'Each character replies in turn, like a normal group chat.'));

    if (t.campaign.mode === 'narrated') {
        renderNarrated(section, t);
        return section;
    }

    section.append(titleRow('h4', `Members (${t.members.length})`, HELP.members));
    const members = el('div', 'ct-gs-member-list');
    t.members.forEach((avatar, index) => {
        const muted = t.disabled.includes(avatar);
        const who = characterName(avatar);
        const row = el('div', `ct-gs-member${muted ? ' is-muted' : ''}`);
        const text = el('span', 'ct-gs-member-text');
        text.append(el('span', 'ct-gs-member-name', who));
        if (muted) text.append(el('span', 'ct-gs-member-meta', 'Muted'));
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

    appendCharacterPicker(section, t);
    return section;
}

function appendCharacterPicker(section, t) {
    const addHead = el('div', 'ct-gs-field-head');
    addHead.append(el('label', 'ct-gs-label', t.campaign.mode === 'narrated' ? 'Add to the cast' : 'Add characters'), helpButton('Add characters', HELP.add));
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
        for (const character of pool.slice(0, 40)) {
            const row = button('ct-gs-candidate', '', `Add ${character.name}`, () => {
                state.charSearch = '';
                void setMembers([...t.members, character.avatar], t.disabled);
            });
            row.append(avatarImg(character.avatar), el('span', 'ct-gs-member-name', character.name), el('span', 'ct-gs-add', '+ Add'));
            results.append(row);
        }
        if (pool.length > 40) results.append(el('p', 'ct-gs-note', `${pool.length - 40} more. Type a name to find them.`));
        if (!pool.length) results.append(el('p', 'ct-gs-note', term ? 'No characters match.' : 'Every character is already in this group.'));
    };
    search.addEventListener('input', () => {
        state.charSearch = search.value;
        fill();
    });
    section.append(addHead, search, results);
    fill();
}

function renderNarrated(section, t) {
    const campaign = t.campaign;
    const narrator = narratorAvatar(campaign);

    section.append(titleRow('h4', 'Narrator', HELP.narrator));
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
    style.rows = 4;
    style.placeholder = 'e.g. Third person, past tense. Voice every character and NPC. Keep the world moving.';
    style.value = campaign.narrator.style;
    style.disabled = campaign.narrator.type !== 'builtin';
    style.addEventListener('change', () => void saveBuiltinStyle(style.value));
    builtinBody.append(style);
    pickBuiltin.append(builtinRadio, builtinBody);
    section.append(pickCard, pickBuiltin);
    if (!narrator) {
        section.append(el('p', 'ct-gs-warn', campaign.narrator.type === 'builtin'
            ? (t.isNew ? 'The narrator card is made when you create the group.' : 'Write the style and click outside the box to make the narrator.')
            : 'Pick the character who narrates. Until then, the group replies like Ensemble.'));
    }

    const placement = el('label', 'ct-gs-check');
    const placementBox = el('input');
    placementBox.type = 'checkbox';
    placementBox.checked = campaign.castPlacement === 'prompt';
    placementBox.addEventListener('change', () => void setCampaign({ castPlacement: placementBox.checked ? 'prompt' : 'macro' }));
    placement.append(placementBox, el('span', '', 'Put the cast in the prompt automatically'));
    const placementRow = el('div', 'ct-gs-field-head');
    placementRow.append(placement, helpButton('Cast in the prompt', HELP.placement));
    section.append(placementRow);

    const cast = t.isNew ? t.members.filter(avatar => avatar !== narrator) : castMembers(group(), campaign);
    section.append(titleRow('h4', `Cast (${cast.length})`, HELP.cast));
    const list = el('div', 'ct-gs-member-list');
    for (const avatar of cast) {
        const entry = campaign.cast[avatar] ?? { state: CAST_STATES.SCENE, sheet: '', line: '' };
        const who = characterName(avatar);
        const row = el('div', `ct-gs-member ct-gs-cast${entry.state === CAST_STATES.OFF ? ' is-muted' : ''}`);
        const text = el('span', 'ct-gs-member-text');
        text.append(el('span', 'ct-gs-member-name', who));
        text.append(el('span', entry.sheet ? 'ct-gs-sheet-ok' : 'ct-gs-sheet-none', entry.sheet ? 'Sheet ready' : (defaultSheet(avatar) ? 'Using card fields' : 'Empty card')));
        const states = el('div', 'ct-gs-segment ct-gs-segment-small');
        states.setAttribute('role', 'group');
        states.setAttribute('aria-label', `Cast state for ${who}`);
        for (const [value, label] of [[CAST_STATES.SCENE, 'In scene'], [CAST_STATES.OFFSCREEN, 'Offscreen'], [CAST_STATES.OFF, 'Off']]) {
            const isOn = entry.state === value;
            const b = button(isOn ? 'is-on' : '', label, '', () => void setCampaign({ cast: { ...campaign.cast, [avatar]: { ...entry, state: value } } }));
            b.setAttribute('aria-pressed', String(isOn));
            states.append(b);
        }
        const sheet = button('menu_button ct-gs-btn', entry.sheet ? 'Edit sheet' : 'Make sheet', `Cast sheet for ${who}`, async () => {
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
    appendCharacterPicker(section, t);
}

function profileSelect(id, value, onChange) {
    const select = el('select', 'text_pole');
    select.id = id;
    select.append(option('', 'Current connection', !value));
    for (const profile of connectionProfiles()) select.append(option(profile.id, profile.name, profile.id === value));
    select.addEventListener('change', () => onChange(select.value));
    return select;
}

function renderCampaignCard(t) {
    const campaign = t.campaign;
    const section = el('section', 'ct-gs-card');
    section.append(titleRow('h3', 'Campaign tools', ''));
    section.append(el('p', 'ct-gs-intro', 'Optional helpers that work in Ensemble and Narrated groups. Each one uses its own AI call after a reply.'));

    // NPC Registry
    section.append(titleRow('h4', 'NPC Registry', HELP.npc));
    const npcModes = el('div', 'ct-gs-segment');
    npcModes.setAttribute('role', 'group');
    npcModes.setAttribute('aria-label', 'NPC Registry');
    for (const [mode, label] of [[NPC_MODES.OFF, 'Off'], [NPC_MODES.ASK, 'Ask me'], [NPC_MODES.AUTO, 'Automatic']]) {
        const isOn = campaign.npc.mode === mode;
        const b = button(isOn ? 'is-on' : '', label, '', () => void setCampaign({ npc: { mode } }));
        b.setAttribute('aria-pressed', String(isOn));
        npcModes.append(b);
    }
    section.append(npcModes);
    if (campaign.npc.mode !== NPC_MODES.OFF) {
        const book = el('select', 'text_pole');
        book.id = 'ct-gs-npc-book';
        const groupName = (t.name || 'Group').trim();
        book.append(option('', `Make one for me ("${groupName} - NPCs")`, !campaign.npc.lorebook));
        for (const name of [...(world_names ?? [])].sort((a, b) => a.localeCompare(b))) book.append(option(name, name, name === campaign.npc.lorebook));
        book.addEventListener('change', () => void setCampaign({ npc: { lorebook: book.value } }));
        section.append(field('NPC lorebook', '', book, 'Only used while this group\'s chat is open.'));
        section.append(field('Connection profile', '', profileSelect('ct-gs-npc-profile', campaign.npc.profileId, value => void setCampaign({ npc: { profileId: value } })), 'A cheap, fast model is enough.'));
    }

    // World state
    const worldHead = el('div', 'ct-gs-title-row');
    const worldToggle = el('label', 'ct-gs-check');
    const worldBox = el('input');
    worldBox.type = 'checkbox';
    worldBox.checked = campaign.world.enabled;
    worldBox.addEventListener('change', () => void setCampaign({ world: { enabled: worldBox.checked } }));
    worldToggle.append(worldBox, el('span', 'ct-gs-title', 'World state'));
    worldHead.append(worldToggle, helpButton('World state', HELP.world));
    section.append(worldHead);
    if (!campaign.world.enabled) return section;

    section.append(field('Connection profile', '', profileSelect('ct-gs-world-profile', campaign.world.profileId, value => void setCampaign({ world: { profileId: value } })), 'A cheap, fast model is enough.'));
    const every = el('input', 'text_pole ct-gs-number');
    every.id = 'ct-gs-world-every';
    every.type = 'number';
    every.min = '1';
    every.max = '20';
    every.value = String(campaign.world.every);
    every.addEventListener('change', () => void setCampaign({ world: { every: Number(every.value) } }));
    section.append(field('Update every … replies', '', every));

    const injectSelect = (value, onChange, label) => {
        const select = el('select', 'text_pole ct-gs-inject');
        select.setAttribute('aria-label', `When ${label} goes into the prompt`);
        for (const [v, text] of [[INJECT.ALWAYS, 'Always'], [INJECT.RELEVANT, 'When relevant'], [INJECT.PANEL, 'Panel only']]) select.append(option(v, text, v === value));
        select.addEventListener('change', () => onChange(select.value));
        return select;
    };
    const modules = el('div', 'ct-gs-modules');
    for (const module of WORLD_MODULES) {
        const saved = campaign.world.modules[module.id];
        const row = el('div', `ct-gs-module${saved.on ? ' is-on' : ''}`);
        const toggle = el('label', 'ct-gs-check');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = saved.on;
        box.addEventListener('change', () => void setCampaign({ world: { modules: { ...campaign.world.modules, [module.id]: { ...saved, on: box.checked } } } }));
        toggle.append(box, el('span', '', module.label));
        row.append(toggle);
        if (saved.on) row.append(injectSelect(saved.inject, value => void setCampaign({ world: { modules: { ...campaign.world.modules, [module.id]: { ...saved, inject: value } } } }), module.label));
        modules.append(row);
    }
    campaign.world.custom.forEach((custom, index) => {
        const row = el('div', 'ct-gs-module is-on');
        row.append(el('span', 'ct-gs-module-name', custom.name));
        row.append(injectSelect(custom.inject, value => {
            const next = campaign.world.custom.map((item, i) => (i === index ? { ...item, inject: value } : item));
            void setCampaign({ world: { custom: next } });
        }, custom.name));
        row.append(button('ct-gs-icon', '<i class="fa-solid fa-xmark"></i>', `Remove ${custom.name}`, () => void setCampaign({ world: { custom: campaign.world.custom.filter((_, i) => i !== index) } })));
        modules.append(row);
    });
    section.append(modules);
    const addRow = el('div', 'ct-gs-add-row');
    const customName = el('input', 'text_pole');
    customName.id = 'ct-gs-world-custom';
    customName.type = 'text';
    customName.placeholder = 'Your own field, e.g. Corruption level';
    const addCustom = () => {
        const name = customName.value.trim();
        if (!name || campaign.world.custom.some(item => item.name.toLowerCase() === name.toLowerCase())) return;
        void setCampaign({ world: { custom: [...campaign.world.custom, { name, inject: INJECT.ALWAYS }] } });
    };
    customName.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') addCustom();
    });
    addRow.append(customName, button('menu_button ct-gs-btn', '+ Add field', '', addCustom));
    section.append(addRow);
    return section;
}

function renderProfileCard(t, groupId) {
    const profile = t.profile;
    const section = el('section', 'ct-gs-card');
    section.append(titleRow('h3', 'Group profile', HELP.page));
    section.append(el('p', 'ct-gs-intro', 'Applied when you open this group\'s chats. Anything on "Keep current" is left alone. Leaving the group puts your preset and persona back.'));

    if (!t.isNew) {
        const ask = el('label', 'ct-gs-check');
        const askBox = el('input');
        askBox.type = 'checkbox';
        askBox.checked = shouldAsk(groupId);
        askBox.addEventListener('change', () => setShouldAsk(groupId, askBox.checked));
        ask.append(askBox, el('span', '', 'Ask before entering group mode'));
        const askRow = el('div', 'ct-gs-field-head');
        askRow.append(ask, helpButton('Ask before entering', HELP.ask));
        section.append(askRow);
    }

    const presets = getPresetManager('openai')?.getAllPresets?.() ?? [];
    const preset = el('select', 'text_pole');
    preset.id = 'ct-gs-preset';
    preset.append(option('', 'Keep current', !profile.preset));
    for (const name of presets) preset.append(option(name, name, name === profile.preset));
    if (profile.preset && !presets.includes(profile.preset)) preset.append(option(profile.preset, `${profile.preset} (missing)`, true));
    preset.addEventListener('change', () => setProfile({ preset: preset.value }));
    section.append(field('Chat Completion preset', HELP.preset, preset, 'Only the preset. Your API and model stay as they are.'));

    const personas = Object.entries(power_user.personas ?? {}).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    const persona = el('select', 'text_pole');
    persona.id = 'ct-gs-persona';
    persona.append(option('', 'Keep current', !profile.persona));
    for (const [avatar, name] of personas) persona.append(option(avatar, String(name || avatar), avatar === profile.persona));
    if (profile.persona && !Object.hasOwn(power_user.personas ?? {}, profile.persona)) persona.append(option(profile.persona, `${profile.persona} (missing)`, true));
    persona.addEventListener('change', () => setProfile({ persona: persona.value }));
    section.append(field('Persona', HELP.persona, persona));

    const lore = el('div', 'ct-gs-lore');
    const chips = el('div', 'ct-gs-chips');
    const known = new Set(Array.isArray(world_names) ? world_names : []);
    for (const name of profile.lorebooks) {
        const chip = el('span', `ct-gs-chip${known.has(name) ? '' : ' is-missing'}`);
        chip.append(el('span', '', known.has(name) ? name : `${name} (missing)`));
        chip.append(button('ct-gs-chip-x', '×', `Remove ${name}`, () => setProfile({ lorebooks: profile.lorebooks.filter(x => x !== name) })));
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
        if (add.value) setProfile({ lorebooks: [...profile.lorebooks, add.value] });
    });
    lore.append(chips, add);
    section.append(field('Lorebooks', HELP.lorebooks, lore, 'Scanned on top of your global lorebooks while this group\'s chat is open.'));
    return section;
}

function renderAgentsCard(t) {
    const profile = t.profile;
    const section = el('section', 'ct-gs-card ct-gs-agents');
    section.append(titleRow('h3', 'Agents', HELP.agents));

    const modes = el('div', 'ct-gs-segment');
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', 'How agents change in this group');
    const labels = { [AGENT_MODES.KEEP]: 'Keep current', [AGENT_MODES.ONLY]: 'Only these', [AGENT_MODES.ADD]: 'Add to my usual' };
    for (const mode of Object.values(AGENT_MODES)) {
        const isOn = mode === profile.agents.mode;
        const b = button(isOn ? 'is-on' : '', labels[mode], '', () => {
            if (isOn) return;
            // "Only these" starts from the agents that are on now, so switching never empties the list.
            const list = mode === AGENT_MODES.ONLY && !profile.agents.on.length
                ? listAgents().filter(usualEnabled).map(agent => agent.id)
                : mode === AGENT_MODES.ADD ? [] : profile.agents.on;
            setProfile({ agents: { mode, on: list, off: [] } });
        });
        b.setAttribute('aria-pressed', String(isOn));
        modes.append(b);
    }
    section.append(modes);

    const hint = {
        [AGENT_MODES.KEEP]: 'This group uses your usual agents for group chats. Pick "Only these" or "Add to my usual" to choose agents for it.',
        [AGENT_MODES.ONLY]: 'Only the ticked agents run in this group.',
        [AGENT_MODES.ADD]: 'Your usual agents run here. Tick more to add them, untick to turn one off just here.',
    }[profile.agents.mode];
    section.append(el('p', 'ct-gs-note', hint));

    if (!agentsApi()?.getAgents) {
        section.append(el('p', 'ct-gs-note', 'In-Chat Agents are not loaded.'));
        return section;
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
            const enabled = keep ? usual : profile.agents.mode === AGENT_MODES.ONLY ? on.has(agent.id) : on.has(agent.id) || (usual && !off.has(agent.id));
            if (enabled) count++;
            if (term && !`${agent.name} ${agent.description ?? ''}`.toLowerCase().includes(term)) continue;
            const row = el('label', `ct-gs-agent${enabled ? ' is-on' : ''}${keep ? ' is-locked' : ''}`);
            const box = el('input');
            box.type = 'checkbox';
            box.checked = enabled;
            box.disabled = keep;
            box.addEventListener('change', () => chooseAgent(agent.id, box.checked, usual));
            const textWrap = el('span', 'ct-gs-agent-text');
            textWrap.append(el('span', 'ct-gs-agent-name', agent.name || agent.id));
            if (agent.description) textWrap.append(el('span', 'ct-gs-agent-desc', String(agent.description)));
            row.append(box, textWrap);
            const tagText = profile.agents.mode === AGENT_MODES.ADD && (on.has(agent.id) || off.has(agent.id)) ? 'this group' : usual ? 'usual' : '';
            if (tagText) row.append(el('span', 'ct-gs-tag', tagText));
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
    return section;
}

function renderBehaviorCard(t) {
    const section = el('section', 'ct-gs-card');
    section.append(titleRow('h3', 'Behavior', HELP.behavior));
    if (t.campaign.mode === 'narrated') {
        section.append(el('p', 'ct-gs-note', 'Narrated: the narrator replies to every message, and only the narrator\'s card is sent (the cast goes in as sheets). To make a cast member speak anyway, use the member bar under the chat.'));
        return section;
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
    const self = el('label', 'ct-gs-check');
    const selfBox = el('input');
    selfBox.type = 'checkbox';
    selfBox.checked = t.behavior.allow_self_responses;
    selfBox.addEventListener('change', () => void setBehavior({ allow_self_responses: selfBox.checked }));
    self.append(selfBox, el('span', '', 'Allow self responses'));
    section.append(self);
    return section;
}

function renderFooter(t) {
    const footer = root.querySelector('.ct-gs-footer');
    footer.replaceChildren();
    footer.hidden = !t.isNew;
    if (!t.isNew) return;
    footer.append(el('span', 'ct-gs-note', t.members.length ? 'Ready. The chat opens as soon as the group is made.' : 'Add at least one character to make the group.'));
    const createButton = button('ct-cb-btn is-primary', '<i class="fa-solid fa-check"></i><span>Create group and open chat</span>', '', () => void createGroupNow());
    createButton.id = 'ct-gs-create';
    const builtinNeeded = t.campaign.mode === 'narrated' && t.campaign.narrator.type === 'builtin';
    createButton.disabled = (!t.members.length && !builtinNeeded) || state.creating;
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
    renderHeader();
    renderSide();
    const body = root.querySelector('.ct-gs-body');
    const keepScroll = body.scrollTop;
    const focusedId = document.activeElement?.id;
    body.replaceChildren();
    const left = el('div', 'ct-gs-col');
    left.append(renderGroupCard(t), renderBehaviorCard(t), renderCampaignCard(t));
    const right = el('div', 'ct-gs-col');
    right.append(renderProfileCard(t, state.groupId), renderAgentsCard(t));
    body.append(left, right);
    renderFooter(t);
    body.scrollTop = keepScroll;
    if (focusedId) document.getElementById(focusedId)?.focus();
}

// ───────────────────────── Creating ─────────────────────────

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
        const chatName = humanizedDateTime();
        const response = await fetch('/api/groups/create', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                name: t.name.trim() || `Group: ${names}`,
                members: t.members,
                avatar_url: default_avatar,
                allow_self_responses: t.behavior.allow_self_responses,
                hideMutedSprites: false,
                activation_strategy: t.behavior.activation_strategy,
                generation_mode: t.behavior.generation_mode,
                disabled_members: t.disabled,
                member_models: {},
                fav: false,
                chat_id: chatName,
                chats: [chatName],
                conversation_settings: {},
            }),
        });
        if (!response.ok) throw new Error(`The server refused (${response.status}).`);
        const data = await response.json();
        await getCharacters();
        // The create route keeps only the standard group fields, so the profile is saved right after.
        const made = findGroup(data.id);
        if (made) {
            made.homunculus_profile = t.profile;
            made.homunculus_campaign = t.campaign;
            await editGroup(made.id, true, false);
        }
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
 */
function open(groupId = openGroupId ?? selected_group) {
    const id = groupId ? String(groupId) : null;
    if (id && findGroup(id)) {
        if (state.mode !== 'edit' || state.groupId !== id) {
            state.charSearch = '';
            state.agentSearch = '';
        }
        state.mode = 'edit';
        state.groupId = id;
    } else if (state.mode !== 'new') {
        state.mode = 'new';
        state.draft = emptyDraft();
    }
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
    show();
    requestAnimationFrame(() => document.getElementById('ct-gs-group-name')?.focus());
}

function close() {
    if (!state.open) return;
    state.open = false;
    closeHelp();
    root?.classList.remove('is-open');
    document.body.classList.remove('ct-cb-open');
    setButtonState(false);
    const home = globalThis.HomunculusClassicHome;
    if (home?.getView?.() === VIEW_ID) home.setView('chat');
    if (returnFocus instanceof HTMLElement && document.contains(returnFocus)) returnFocus.focus();
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
    document.addEventListener(PROFILE_CHANGED_EVENT, () => {
        if (state.open) render();
    });
    document.addEventListener('homunculus:group-campaign-changed', () => {
        if (state.open) render();
    });
    eventSource.on(event_types.GROUP_UPDATED, () => {
        if (state.open) render();
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
        close();
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}

globalThis.HomunculusGroupStudio = { open, create, close };
