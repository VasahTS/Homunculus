// Classic UI fork: the "Agents" menu on the group bar.
//
// A button on the bar above a group chat (#ct-group-mode-bar, drawn by classic-group-profile.js)
// opens a small menu with the agents of this group: grouped by when they run, with a search box,
// an on/off switch that only changes this group's profile, what each agent did on the last reply,
// "Run now" for companions and trackers, and a shortcut to the agent editor.
// The menu closes on a click outside it, on Escape, and when the chat changes.

import { eventSource, event_types, chat } from '../script.js';
import { extension_settings } from './extensions.js';
import { groups, selected_group } from './group-chats.js';
import { helpButton, closeHelp } from './classic-help.js';
import { getProfile, saveProfile, applyAgentChoice, isActive, enterQuietly, AGENT_MODES } from './classic-group-profile.js';

const PROMPT_RUNS_KEY = 'inChatAgentPromptRuns';
const COMPANION_RESULTS_KEY = 'inChatAgentCompanionResults';

const SECTIONS = Object.freeze([
    { id: 'pre', title: 'Before the reply', help: 'These agents run before the AI writes. Most add instructions to the prompt; some rewrite your message first.' },
    { id: 'post', title: 'After the reply', help: 'These agents run after the AI has written. They can rewrite or check the reply.' },
    { id: 'tracker', title: 'Trackers and companions', help: 'These agents read the reply and keep notes (the Scene panel, trackers, side panels). They do not change the reply.' },
]);

const HELP_MENU = '<p>The agents that run in this group\'s chats.</p><p>Switching one here only changes <b>this group</b>; your other chats keep their own agents. The same list is in Group Studio → Agents.</p><p>Each line says what the agent did on the last reply. <b>Run now</b> (play button) runs a tracker or companion again on the last reply.</p>';

const view = {
    open: false,
    query: '',
    showOff: false,
    busy: new Set(),
};
let pop = null;

const agentsApi = () => globalThis.HomunculusAgents ?? null;
const findGroup = id => groups.find(group => String(group.id) === String(id));
const currentGroup = () => (selected_group ? findGroup(selected_group) : null);

function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function iconButton(className, icon, label, onClick) {
    const b = el('button', className);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i>`;
    b.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick(event);
    });
    return b;
}

// ───────────────────────── Data ─────────────────────────

function listAgents() {
    const api = agentsApi();
    if (!api?.getAgents) return [];
    return api.getAgents()
        .filter(agent => agent?.id && !api.isAgentHidden?.(agent.id))
        .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));
}

const usualEnabled = agent => Boolean(agentsApi()?.isAgentEnabledIgnoringGroupProfile?.(agent, 'group'));

/** Whether an agent runs in this group's chats (given the group's profile). */
function onInGroup(profile, agent) {
    const usual = usualEnabled(agent);
    if (profile.agents.mode === AGENT_MODES.KEEP) return usual;
    if (profile.agents.mode === AGENT_MODES.ONLY) return profile.agents.on.includes(agent.id);
    return profile.agents.on.includes(agent.id) || (usual && !profile.agents.off.includes(agent.id));
}

const isCompanion = agent => agent?.execution === 'companion' || agent?.category === 'companion';

function sectionOf(agent) {
    if (isCompanion(agent) || agent?.category === 'tracker') return 'tracker';
    return agent?.phase === 'post' ? 'post' : 'pre';
}

function whenLabel(agent) {
    if (isCompanion(agent)) return 'companion';
    if (agent?.category === 'tracker') return 'tracker';
    if (agent?.phase === 'both') return 'before and after';
    return '';
}

function profileName(agent) {
    const id = String(agent?.connectionProfile ?? '').trim();
    if (!id) return 'Same as chat';
    const list = extension_settings.connectionManager?.profiles;
    const found = Array.isArray(list) ? list.find(profile => profile?.id === id) : null;
    return found ? String(found.name || found.id) : 'Missing profile';
}

function extraOf(message, key) {
    const swipe = Array.isArray(message?.swipe_info) ? message.swipe_info[message.swipe_id ?? 0] : null;
    if (swipe?.extra && key in swipe.extra) return swipe.extra[key];
    return message?.extra?.[key];
}

function lastReplyIndex() {
    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (message && !message.is_user && !message.is_system) return i;
    }
    return -1;
}

/**
 * What an agent did on the last reply, as { text, tone }.
 * tone: 'ok' | 'run' | 'warn' | 'err' | 'muted'
 */
function statusOf(agent, enabled) {
    if (!enabled) return { text: 'Off in this group', tone: 'muted' };
    if (view.busy.has(agent.id)) return { text: 'Running…', tone: 'run' };
    const index = lastReplyIndex();
    const message = index >= 0 ? chat[index] : null;
    if (!message) return { text: 'No reply yet', tone: 'muted' };

    if (sectionOf(agent) === 'tracker') {
        const results = extraOf(message, COMPANION_RESULTS_KEY);
        const result = results && typeof results === 'object' ? results[agent.id] : null;
        if (!result) return { text: 'Did not run on the last reply', tone: 'muted' };
        const status = String(result.status ?? '');
        if (status === 'pending' || status === 'running') return { text: 'Running…', tone: 'run' };
        if (status === 'error') return { text: `Error: ${String(result.error || 'see the agent panel').slice(0, 90)}`, tone: 'err' };
        if (status === 'cancelled') return { text: 'Cancelled', tone: 'warn' };
        return { text: 'Ran on the last reply', tone: 'ok' };
    }

    const runs = extraOf(message, PROMPT_RUNS_KEY);
    const run = Array.isArray(runs) ? [...runs].reverse().find(item => item?.agentId === agent.id) : null;
    if (run) {
        const status = String(run.status ?? '');
        if (status === 'changed') return { text: 'Ran · changed the reply', tone: 'ok' };
        if (status === 'unchanged') return { text: 'Ran · no change needed', tone: 'ok' };
        if (status === 'error') return { text: `Error: ${String(run.error || '').slice(0, 90) || 'see the console'}`, tone: 'err' };
        if (status === 'cancelled') return { text: 'Cancelled', tone: 'warn' };
        if (status.startsWith('skipped')) return { text: 'Skipped on the last reply', tone: 'warn' };
        return { text: status || 'Ran', tone: 'ok' };
    }
    if (agent?.phase === 'post') return { text: 'Did not run on the last reply', tone: 'muted' };
    return { text: 'Adds its instructions to the prompt', tone: 'ok' };
}

/** Counts for the bar button: agents on in this group and trackers running now. */
export function summary() {
    const group = currentGroup();
    if (!group) return { on: 0, running: 0 };
    const profile = getProfile(group);
    let on = 0;
    let running = 0;
    for (const agent of listAgents()) {
        const enabled = onInGroup(profile, agent);
        if (!enabled) continue;
        on++;
        if (statusOf(agent, true).tone === 'run') running++;
    }
    return { on, running };
}

// ───────────────────────── Actions ─────────────────────────

async function setOn(agent, enabled) {
    const group = currentGroup();
    if (!group) return;
    let profile = getProfile(group);
    const usual = usualEnabled(agent);
    const wasEmpty = profile.agents.mode === AGENT_MODES.KEEP && !profile.preset && !profile.persona && !profile.lorebooks.length;
    if (profile.agents.mode === AGENT_MODES.KEEP) {
        if (enabled === usual) return;
        profile = { ...profile, agents: { mode: AGENT_MODES.ADD, on: [], off: [] } };
    }
    profile = applyAgentChoice(profile, agent.id, enabled, usual);
    await saveProfile(group.id, { agents: profile.agents });
    // A group that had no profile has nothing else to switch, so it starts using its agents at once.
    if (wasEmpty && !isActive(group.id)) await enterQuietly();
    globalThis.HomunculusScene?.refresh?.();
    render();
    // The chat column slides when the Scene panel appears; follow the button after the transition.
    setTimeout(place, 350);
}

async function runNow(agent) {
    const api = agentsApi();
    if (!api?.runCompanionAgentOnMessage) return;
    const index = api.getLatestValidCompanionMessageIndex?.() ?? lastReplyIndex();
    if (index < 0) {
        toastr.info('There is no reply to read yet.');
        return;
    }
    view.busy.add(agent.id);
    render();
    try {
        await api.runCompanionAgentOnMessage(agent.id, index);
    } catch (error) {
        toastr.error(String(error?.message ?? error), agent.name);
    } finally {
        view.busy.delete(agent.id);
        render();
    }
}

function editAgent(agent) {
    close();
    agentsApi()?.openAgentEditor?.(agent.id);
}

// ───────────────────────── Menu ─────────────────────────

function anchorButton() {
    return /** @type {HTMLElement|null} */ (document.querySelector('#ct-group-mode-bar [data-gm-action="agents"]'));
}

function place() {
    if (!pop) return;
    const button = anchorButton();
    if (!button) {
        close();
        return;
    }
    const rect = button.getBoundingClientRect();
    const width = Math.min(460, window.innerWidth - 24);
    const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
    pop.style.width = `${width}px`;
    pop.style.left = `${left}px`;
    pop.style.top = `${Math.round(rect.bottom + 8)}px`;
    pop.style.maxHeight = `${Math.max(240, window.innerHeight - rect.bottom - 24)}px`;
}

function syncButton() {
    const button = anchorButton();
    if (!button) return;
    button.classList.toggle('is-on', view.open);
    button.setAttribute('aria-expanded', String(view.open));
}

function matches(agent) {
    const q = view.query.trim().toLowerCase();
    if (!q) return true;
    return [agent.name, agent.description, agent.category, profileName(agent)].some(value => String(value ?? '').toLowerCase().includes(q));
}

function agentRow(agent, enabled) {
    const row = el('div', `ct-ga-row${enabled ? '' : ' is-off'}`);

    const sw = el('label', 'ct-ga-switch');
    sw.title = enabled ? `Switch ${agent.name} off in this group` : `Switch ${agent.name} on in this group`;
    const input = el('input');
    input.type = 'checkbox';
    input.checked = enabled;
    input.setAttribute('aria-label', `${agent.name} on in this group`);
    input.addEventListener('change', () => void setOn(agent, input.checked));
    sw.append(input, el('span', 'ct-ga-switch-track'));

    const main = el('div', 'ct-ga-main');
    const top = el('div', 'ct-ga-top');
    top.append(el('span', 'ct-ga-name', String(agent.name || 'Agent')));
    const when = whenLabel(agent);
    if (when) top.append(el('span', 'ct-ga-chip', when));
    top.append(el('span', 'ct-ga-chip', profileName(agent)));
    const status = statusOf(agent, enabled);
    const line = el('div', `ct-ga-status is-${status.tone}`);
    line.append(el('span', 'ct-ga-dot'), el('span', '', status.text));
    main.append(top, line);

    row.append(sw, main);
    if (sectionOf(agent) === 'tracker' && enabled) {
        const run = iconButton('ct-ga-icon', 'fa-play', `Run ${agent.name} now on the last reply`, () => void runNow(agent));
        run.disabled = view.busy.has(agent.id);
        row.append(run);
    }
    row.append(iconButton('ct-ga-icon', 'fa-pen', `Edit ${agent.name}`, () => editAgent(agent)));
    return row;
}

function render() {
    if (!pop || !view.open) return;
    const group = currentGroup();
    if (!group) {
        close();
        return;
    }
    const scroller = pop.querySelector('.ct-ga-list');
    const scrollTop = scroller?.scrollTop ?? 0;
    const hadFocus = document.activeElement?.classList?.contains('ct-ga-search');
    pop.replaceChildren();

    const profile = getProfile(group);
    const head = el('div', 'ct-ga-head');
    const title = el('div', 'ct-ga-title');
    title.append(el('strong', '', 'Agents in this group'));
    const modeText = { [AGENT_MODES.KEEP]: 'Using your usual agents', [AGENT_MODES.ONLY]: 'Only the agents switched on here', [AGENT_MODES.ADD]: 'Your usual agents + this group\'s changes' }[profile.agents.mode];
    title.append(el('span', 'ct-ga-sub', `${modeText} · changes only affect ${group.name}`));
    head.append(title, helpButton('Agents in this group', HELP_MENU), iconButton('ct-ga-icon ct-ga-close', 'fa-xmark', 'Close', () => close()));
    pop.append(head);

    if (!isActive(group.id) && profile.agents.mode !== AGENT_MODES.KEEP) {
        const note = el('div', 'ct-ga-note');
        note.append(el('span', '', 'The group\'s settings are off in this chat, so your own agents are running right now.'));
        const enter = el('button', 'menu_button ct-gm-toggle', 'Use the group\'s settings');
        enter.type = 'button';
        enter.addEventListener('click', () => void globalThis.HomunculusGroupProfile?.enterHere?.());
        note.append(enter);
        pop.append(note);
    }

    const search = el('input', 'text_pole ct-ga-search');
    search.type = 'search';
    search.placeholder = 'Search agents…';
    search.setAttribute('aria-label', 'Search agents');
    search.value = view.query;
    search.addEventListener('input', () => {
        view.query = search.value;
        render();
    });
    pop.append(search);

    const list = el('div', 'ct-ga-list');
    const agents = listAgents().filter(matches);
    const on = agents.filter(agent => onInGroup(profile, agent));
    const off = agents.filter(agent => !onInGroup(profile, agent));
    const searching = Boolean(view.query.trim());

    for (const section of SECTIONS) {
        const rows = on.filter(agent => sectionOf(agent) === section.id);
        if (!rows.length) continue;
        const h = el('div', 'ct-ga-section');
        h.append(el('span', '', section.title), helpButton(section.title, `<p>${section.help}</p>`));
        list.append(h);
        for (const agent of rows) list.append(agentRow(agent, true));
    }
    if (!on.length) list.append(el('div', 'ct-ga-empty', searching ? 'No agent that is on matches the search.' : 'No agents are on in this group yet.'));

    if (off.length) {
        const showOff = view.showOff || searching;
        const toggle = el('button', 'ct-ga-section ct-ga-fold');
        toggle.type = 'button';
        toggle.setAttribute('aria-expanded', String(showOff));
        toggle.innerHTML = `<i class="fa-solid ${showOff ? 'fa-chevron-down' : 'fa-chevron-right'}" aria-hidden="true"></i>`;
        toggle.append(el('span', '', `Off in this group (${off.length})`));
        toggle.addEventListener('click', () => {
            view.showOff = !view.showOff;
            render();
        });
        list.append(toggle);
        if (showOff) for (const agent of off) list.append(agentRow(agent, false));
    }
    pop.append(list);

    const foot = el('div', 'ct-ga-foot');
    const counts = el('span', 'ct-ga-sub', `${on.length} on · ${off.length} off`);
    const studio = el('button', 'ct-gm-link', 'Open in Group Studio');
    studio.type = 'button';
    studio.addEventListener('click', () => {
        close();
        globalThis.HomunculusGroupStudio?.open?.(group.id, 'agents');
    });
    foot.append(counts, studio);
    pop.append(foot);

    const newScroller = pop.querySelector('.ct-ga-list');
    if (newScroller) newScroller.scrollTop = scrollTop;
    if (hadFocus) {
        search.focus();
        search.setSelectionRange(search.value.length, search.value.length);
    }
    place();
}

function onPointerDown(event) {
    if (!pop || !view.open) return;
    const target = /** @type {HTMLElement} */ (event.target);
    if (pop.contains(target) || anchorButton()?.contains(target)) return;
    // Help cards opened from the menu live outside it.
    if (target?.closest?.('.ct-help-card')) return;
    close();
}

function onKeyDown(event) {
    if (event.key !== 'Escape' || !view.open) return;
    event.stopPropagation();
    close();
    anchorButton()?.focus();
}

export function open() {
    if (!currentGroup()) return;
    if (!pop) {
        pop = el('div', 'ct-ga-pop');
        pop.id = 'ct-group-agents';
        pop.setAttribute('role', 'dialog');
        pop.setAttribute('aria-label', 'Agents in this group');
        document.body.append(pop);
    }
    view.open = true;
    view.query = '';
    pop.hidden = false;
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', place);
    render();
    syncButton();
    pop.querySelector('.ct-ga-search')?.focus();
}

export function close() {
    if (!view.open) return;
    view.open = false;
    closeHelp();
    if (pop) pop.hidden = true;
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', place);
    syncButton();
}

export function toggle() {
    if (view.open) close(); else open();
}

function refreshAll() {
    globalThis.HomunculusGroupProfile?.refreshBar?.();
    render();
}

function init() {
    eventSource.on(event_types.CHAT_CHANGED, () => close());
    for (const type of [event_types.MESSAGE_RECEIVED, event_types.MESSAGE_SWIPED, event_types.MESSAGE_DELETED, event_types.GENERATION_ENDED]) {
        if (type) eventSource.on(type, () => refreshAll());
    }
    eventSource.on('in_chat_agent_companion_results_updated', () => refreshAll());
    document.addEventListener('homunculus:group-profile-changed', () => render());
}

init();

globalThis.HomunculusGroupAgents = { open, close, toggle, summary, isOpen: () => view.open, syncButton };
globalThis.HomunculusGroupProfile?.refreshBar?.();
