// Classic UI fork: Group Studio.
//
// A page of its own (like the Card Browser) for a group's profile: the Chat Completion preset, the
// agents, the extra lorebooks and the persona used in that group's chats. The rules for applying a
// profile live in classic-group-profile.js; this file is only the page.
//
// Members, reply order and the other group options still live in the group panel for now.
//
// Open it from the sliders button in the group panel, "Edit profile" in the group mode bar above
// the chat, the agents drawer, or with globalThis.HomunculusGroupStudio.open(groupId).

import { helpButton, closeHelp } from './classic-help.js';
import { selected_group, openGroupId, openGroupById } from './group-chats.js';
import { getPresetManager } from './preset-manager.js';
import { power_user } from './power-user.js';
import { world_names } from './world-info.js';
import { eventSource, event_types } from '../script.js';
import {
    AGENT_MODES,
    PROFILE_CHANGED_EVENT,
    findGroup,
    getProfile,
    isActive,
    saveProfile,
    setAgentChoice,
    setShouldAsk,
    shouldAsk,
} from './classic-group-profile.js';

const VIEW_ID = 'ct-group-studio';

const HELP = {
    page: `<p>The Group Studio sets up how this group's chats run.</p>
<p>The <b>Group profile</b> is applied when you open one of this group's chats. Anything left on <b>Keep current</b> is not touched.</p>
<p>When you open a chat that isn't in this group, your own preset and persona come back. Your own agent and lorebook lists are never changed.</p>`,
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
    members: '<p>Members, reply order, muting and the other group options are still in the group panel. They will move here later.</p>',
};

// ───────────────────────── Helpers ─────────────────────────

function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function option(value, label, selected) {
    const node = el('option', '', label);
    node.value = value;
    node.selected = selected;
    return node;
}

function titleRow(tag, text, help) {
    const row = el('div', 'ct-gs-title-row');
    row.append(el(tag, 'ct-gs-title', text));
    if (help) row.append(helpButton(text, help));
    return row;
}

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

const state = {
    open: false,
    groupId: null,
    agentSearch: '',
};
let root = null;
let returnFocus = null;

function group() {
    return findGroup(state.groupId);
}

// ───────────────────────── Rendering ─────────────────────────

function build() {
    root = el('div', 'ct-cb ct-gs');
    root.id = 'ct-group-studio';
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
            <button type="button" class="ct-cb-btn ct-gs-open-chat"><i class="fa-solid fa-comments"></i><span>Open chat</span></button>
        </header>
        <div class="ct-gs-body"></div>`;
    root.querySelector('.ct-cb-titles .ct-cb-title').append(helpButton('Group Studio', HELP.page));
    root.querySelector('.ct-cb-back').addEventListener('click', close);
    root.querySelector('.ct-gs-open-chat').addEventListener('click', async () => {
        const id = state.groupId;
        close();
        if (id && String(selected_group) !== String(id)) await openGroupById(id);
    });
    document.body.append(root);
}

function renderHeader() {
    const g = group();
    root.querySelector('.ct-gs-name').textContent = g?.name ?? 'Group';
    const members = Array.isArray(g?.members) ? g.members.length : 0;
    const status = !g ? '' : isActive(g.id) ? 'Group mode is on in the open chat' : String(selected_group) === String(g.id) ? 'Group mode is off in the open chat' : 'Not open right now';
    root.querySelector('.ct-cb-sub').textContent = [`${members} member${members === 1 ? '' : 's'}`, status].filter(Boolean).join(' · ');
    const avatars = root.querySelector('.ct-gs-avatars');
    avatars.replaceChildren();
    const ctx = globalThis.SillyTavern?.getContext?.();
    for (const avatar of (g?.members ?? []).slice(0, 5)) {
        const img = el('img');
        img.alt = '';
        img.loading = 'lazy';
        img.src = ctx?.getThumbnailUrl ? ctx.getThumbnailUrl('avatar', avatar) : `/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}`;
        avatars.append(img);
    }
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

function renderProfileSection(g, profile) {
    const section = el('section', 'ct-gs-card');
    section.append(titleRow('h3', 'Group profile', HELP.page));
    section.append(el('p', 'ct-gs-intro', 'Applied when you open this group\'s chats. Anything on "Keep current" is left alone. Leaving the group puts your preset and persona back.'));

    const ask = el('label', 'ct-gs-check');
    const askBox = el('input');
    askBox.type = 'checkbox';
    askBox.checked = shouldAsk(g.id);
    askBox.addEventListener('change', () => setShouldAsk(g.id, askBox.checked));
    ask.append(askBox, el('span', '', 'Ask before entering group mode'));
    const askRow = el('div', 'ct-gs-field-head');
    askRow.append(ask, helpButton('Ask before entering', HELP.ask));
    section.append(askRow);

    const manager = getPresetManager('openai');
    const presets = manager?.getAllPresets?.() ?? [];
    const preset = el('select', 'text_pole');
    preset.id = 'ct-gs-preset';
    preset.append(option('', 'Keep current', !profile.preset));
    for (const name of presets) preset.append(option(name, name, name === profile.preset));
    if (profile.preset && !presets.includes(profile.preset)) preset.append(option(profile.preset, `${profile.preset} (missing)`, true));
    preset.addEventListener('change', () => void saveProfile(g.id, { preset: preset.value }));
    section.append(field('Chat Completion preset', HELP.preset, preset, 'Only the preset. Your API and model stay as they are.'));

    const personas = Object.entries(power_user.personas ?? {}).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    const persona = el('select', 'text_pole');
    persona.id = 'ct-gs-persona';
    persona.append(option('', 'Keep current', !profile.persona));
    for (const [avatar, name] of personas) persona.append(option(avatar, String(name || avatar), avatar === profile.persona));
    if (profile.persona && !Object.hasOwn(power_user.personas ?? {}, profile.persona)) persona.append(option(profile.persona, `${profile.persona} (missing)`, true));
    persona.addEventListener('change', () => void saveProfile(g.id, { persona: persona.value }));
    section.append(field('Persona', HELP.persona, persona));

    const lore = el('div', 'ct-gs-lore');
    const chips = el('div', 'ct-gs-chips');
    const known = new Set(Array.isArray(world_names) ? world_names : []);
    for (const name of profile.lorebooks) {
        const chip = el('span', `ct-gs-chip${known.has(name) ? '' : ' is-missing'}`);
        chip.append(el('span', '', known.has(name) ? name : `${name} (missing)`));
        const remove = el('button', 'ct-gs-chip-x', '×');
        remove.type = 'button';
        remove.setAttribute('aria-label', `Remove ${name}`);
        remove.addEventListener('click', () => void saveProfile(g.id, { lorebooks: profile.lorebooks.filter(x => x !== name) }));
        chip.append(remove);
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
        if (add.value) void saveProfile(g.id, { lorebooks: [...profile.lorebooks, add.value] });
    });
    lore.append(chips, add);
    section.append(field('Lorebooks', HELP.lorebooks, lore, 'Scanned on top of your global lorebooks while this group\'s chat is open.'));

    const members = el('div', 'ct-gs-members');
    members.append(titleRow('h4', 'Members & behavior', HELP.members));
    members.append(el('p', 'ct-gs-note', 'Members, reply order and the other group options are still in the group panel for now.'));
    const panel = el('button', 'menu_button ct-gs-btn', 'Open group panel');
    panel.type = 'button';
    panel.addEventListener('click', async () => {
        const id = state.groupId;
        close();
        if (id && String(selected_group) !== String(id)) await openGroupById(id);
        else document.getElementById('rightNavDrawerIcon')?.closest('.drawer-toggle')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    members.append(panel);
    section.append(members);
    return section;
}

function renderAgentsSection(g, profile) {
    const section = el('section', 'ct-gs-card ct-gs-agents');
    section.append(titleRow('h3', 'Agents', HELP.agents));

    const modes = el('div', 'ct-gs-segment');
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', 'How agents change in this group');
    const labels = { [AGENT_MODES.KEEP]: 'Keep current', [AGENT_MODES.ONLY]: 'Only these', [AGENT_MODES.ADD]: 'Add to my usual' };
    for (const mode of Object.values(AGENT_MODES)) {
        const button = el('button', mode === profile.agents.mode ? 'is-on' : '', labels[mode]);
        button.type = 'button';
        button.setAttribute('aria-pressed', String(mode === profile.agents.mode));
        button.addEventListener('click', () => {
            if (mode === profile.agents.mode) return;
            // "Only these" starts from the agents that are on now, so switching never empties the list.
            const on = mode === AGENT_MODES.ONLY && !profile.agents.on.length
                ? listAgents().filter(usualEnabled).map(agent => agent.id)
                : mode === AGENT_MODES.ADD ? [] : profile.agents.on;
            void saveProfile(g.id, { agents: { mode, on, off: [] } });
        });
        modes.append(button);
    }
    section.append(modes);

    const hint = {
        [AGENT_MODES.KEEP]: 'This group uses your usual agents for group chats. Pick "Only these" or "Add to my usual" to choose agents for it.',
        [AGENT_MODES.ONLY]: 'Only the ticked agents run in this group.',
        [AGENT_MODES.ADD]: 'Your usual agents run here. Tick more to add them, untick to turn one off just here.',
    }[profile.agents.mode];
    section.append(el('p', 'ct-gs-note', hint));

    const api = agentsApi();
    if (!api?.getAgents) {
        section.append(el('p', 'ct-gs-note', 'In-Chat Agents are not loaded.'));
        return section;
    }

    const search = el('input', 'text_pole ct-gs-search');
    search.type = 'search';
    search.placeholder = 'Search agents…';
    search.value = state.agentSearch;
    search.setAttribute('aria-label', 'Search agents');
    section.append(search);

    const list = el('div', 'ct-gs-agent-list');
    const on = new Set(profile.agents.on);
    const off = new Set(profile.agents.off);
    const keep = profile.agents.mode === AGENT_MODES.KEEP;
    const fill = () => {
        list.replaceChildren();
        const term = state.agentSearch.trim().toLowerCase();
        const agents = listAgents().filter(agent => !term || `${agent.name} ${agent.description ?? ''}`.toLowerCase().includes(term));
        let count = 0;
        for (const agent of agents) {
            const usual = usualEnabled(agent);
            const enabled = keep ? usual : profile.agents.mode === AGENT_MODES.ONLY ? on.has(agent.id) : on.has(agent.id) || (usual && !off.has(agent.id));
            if (enabled) count++;
            const row = el('label', `ct-gs-agent${enabled ? ' is-on' : ''}${keep ? ' is-locked' : ''}`);
            const box = el('input');
            box.type = 'checkbox';
            box.checked = enabled;
            box.disabled = keep;
            box.addEventListener('change', () => {
                setAgentChoice(g.id, agent.id, box.checked, usual);
            });
            const textWrap = el('span', 'ct-gs-agent-text');
            textWrap.append(el('span', 'ct-gs-agent-name', agent.name || agent.id));
            if (agent.description) textWrap.append(el('span', 'ct-gs-agent-desc', String(agent.description)));
            const tag = el('span', 'ct-gs-tag', profile.agents.mode === AGENT_MODES.ADD && (on.has(agent.id) || off.has(agent.id)) ? 'this group' : usual ? 'usual' : '');
            row.append(box, textWrap);
            if (tag.textContent) row.append(tag);
            list.append(row);
        }
        if (!agents.length) list.append(el('p', 'ct-gs-note', term ? 'No agents match.' : 'No agents yet.'));
        counter.textContent = `${count} on in this group`;
    };
    const counter = el('div', 'ct-gs-count');
    search.addEventListener('input', () => {
        state.agentSearch = search.value;
        fill();
    });
    section.append(counter, list);
    fill();
    return section;
}

function render() {
    if (!root) return;
    closeHelp();
    renderHeader();
    const body = root.querySelector('.ct-gs-body');
    const keepScroll = body.scrollTop;
    body.replaceChildren();
    const g = group();
    if (!g) {
        body.append(el('p', 'ct-gs-note', 'This group no longer exists.'));
        return;
    }
    const profile = getProfile(g);
    body.append(renderProfileSection(g, profile), renderAgentsSection(g, profile));
    body.scrollTop = keepScroll;
}

// ───────────────────────── Open / close ─────────────────────────

function open(groupId = openGroupId ?? selected_group) {
    const id = groupId ? String(groupId) : null;
    if (!id || !findGroup(id)) {
        toastr.info('Create or open a group first.');
        return;
    }
    if (!root) build();
    state.groupId = id;
    state.agentSearch = '';
    const home = globalThis.HomunculusClassicHome;
    if (!state.open) {
        home?.closeHome?.();
        state.open = true;
        returnFocus = document.activeElement;
        document.body.classList.add('ct-cb-open');
        root.classList.add('is-open');
        home?.setView?.(VIEW_ID);
    }
    render();
}

function close() {
    if (!state.open) return;
    state.open = false;
    closeHelp();
    root?.classList.remove('is-open');
    document.body.classList.remove('ct-cb-open');
    const home = globalThis.HomunculusClassicHome;
    if (home?.getView?.() === VIEW_ID) home.setView('chat');
    if (returnFocus instanceof HTMLElement && document.contains(returnFocus)) returnFocus.focus();
}

function addPanelButton() {
    const holder = document.querySelector('#rm_group_chats_block .sb-group-editor-side-actions') ?? document.getElementById('rm_group_scenario')?.parentElement;
    if (!holder || document.getElementById('ct-group-studio-button')) return;
    const button = el('div', 'heightFitContent margin0 menu_button fa-solid fa-fw fa-sliders');
    button.id = 'ct-group-studio-button';
    button.title = 'Group Studio: preset, agents, lorebooks and persona for this group';
    button.dataset.label = 'STUDIO';
    button.tabIndex = 0;
    button.setAttribute('role', 'button');
    const go = () => open(openGroupId ?? selected_group);
    button.addEventListener('click', go);
    button.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            go();
        }
    });
    holder.append(button);
}

function init() {
    addPanelButton();
    document.addEventListener(PROFILE_CHANGED_EVENT, () => {
        if (state.open) render();
    });
    eventSource.on(event_types.GROUP_UPDATED, () => {
        if (state.open) render();
    });
    document.addEventListener('ct:view-changed', (event) => {
        if (state.open && event.detail?.view !== VIEW_ID) close();
    });
    document.addEventListener('click', (event) => {
        if (state.open && /** @type {HTMLElement} */ (event.target)?.closest?.('#top-settings-holder > .drawer > .drawer-toggle')) close();
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

globalThis.HomunculusGroupStudio = { open, close };
