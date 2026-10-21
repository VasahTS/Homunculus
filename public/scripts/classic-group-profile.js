// Classic UI fork: Group profiles ("group chat mode").
//
// A group can carry a profile (group.homunculus_profile): a Chat Completion preset, the agents used
// in its chats, extra lorebooks and a persona. Every part is optional ("Keep current").
//
// How each part is applied:
// - Agents and lorebooks are never switched in the app's own settings. While the group's chat is
//   open, the agent store and the lorebook scanner ask this module for the group's choices
//   (getAgentOverride / getLorebooks), so leaving the group needs no clean-up for them.
// - The preset and the persona are app-wide settings. Entering the group switches them and keeps
//   what was there before (extension_settings.homunculusGroupMode.previous); leaving the group puts
//   them back. The saved state survives a reload, so a closed tab still gets its settings back.
//
// Entering asks first ("Enter group chat mode?") only when something would change, and warns about
// unsaved changes in the current preset. "Not now" keeps the user's own settings for that visit.
//
// globalThis.HomunculusGroupProfile exposes the hooks used by the agent store, the lorebook
// scanner and the Group Studio page.

import { eventSource, event_types, saveSettingsDebounced, getThumbnailUrl, name1 } from '../script.js';
import { extension_settings } from './extensions.js';
import { groups, selected_group, editGroup, createNewGroupChat } from './group-chats.js';
import { getPresetManager } from './preset-manager.js';
import { user_avatar, setUserAvatar, isPersonaLocked } from './personas.js';
import { power_user } from './power-user.js';
import { world_names } from './world-info.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { escapeHtml } from './utils.js';
import { helpButton, closeHelp } from './classic-help.js';

const SETTINGS_KEY = 'homunculusGroupMode';
const PROFILE_KEY = 'homunculus_profile';
export const PROFILE_CHANGED_EVENT = 'homunculus:group-profile-changed';
export const AGENT_MODES = Object.freeze({ KEEP: 'keep', ONLY: 'only', ADD: 'add' });

/** Groups the user said "Not now" to, for this visit only (cleared when another chat opens). */
const declined = new Set();
let queue = Promise.resolve();
let ready = false;

// ───────────────────────── Data ─────────────────────────

function settings() {
    const saved = extension_settings[SETTINGS_KEY];
    const st = saved && typeof saved === 'object' ? saved : {};
    st.active = st.active && typeof st.active === 'object' && st.active.groupId ? st.active : null;
    st.previous = st.previous && typeof st.previous === 'object' ? st.previous : null;
    st.noAsk = st.noAsk && typeof st.noAsk === 'object' ? st.noAsk : {};
    extension_settings[SETTINGS_KEY] = st;
    return st;
}

const strList = value => (Array.isArray(value) ? [...new Set(value.map(String).filter(Boolean))] : []);

/**
 * The profile of a group, always in the full shape.
 * @param {any} group
 */
export function getProfile(group) {
    return normalizeProfile(group?.[PROFILE_KEY]);
}

/**
 * A profile object in the full shape (also used for a group that is not created yet).
 * @param {any} value
 */
export function normalizeProfile(value) {
    const raw = value && typeof value === 'object' ? value : {};
    const agents = raw.agents && typeof raw.agents === 'object' ? raw.agents : {};
    const mode = Object.values(AGENT_MODES).includes(agents.mode) ? agents.mode : AGENT_MODES.KEEP;
    return {
        preset: typeof raw.preset === 'string' ? raw.preset : '',
        persona: typeof raw.persona === 'string' ? raw.persona : '',
        lorebooks: strList(raw.lorebooks),
        agents: { mode, on: strList(agents.on), off: strList(agents.off) },
    };
}

export function findGroup(groupId) {
    return groups.find(group => String(group.id) === String(groupId)) ?? null;
}

/**
 * Saves a group's profile (merged with what it has).
 * @param {string} groupId
 * @param {object} patch
 */
export async function saveProfile(groupId, patch) {
    const group = findGroup(groupId);
    if (!group) return null;
    const next = { ...getProfile(group), ...patch };
    if (patch.agents) next.agents = { ...getProfile(group).agents, ...patch.agents };
    group[PROFILE_KEY] = next;
    await editGroup(group.id, true, false);
    if (isActive(group.id)) await queueTask(() => reapply(group));
    notify();
    return next;
}

function profileIsEmpty(profile) {
    return !profile.preset && !profile.persona && !profile.lorebooks.length && profile.agents.mode === AGENT_MODES.KEEP;
}

export function shouldAsk(groupId) {
    return !settings().noAsk[groupId];
}

export function setShouldAsk(groupId, ask) {
    const st = settings();
    if (ask) delete st.noAsk[groupId]; else st.noAsk[groupId] = true;
    saveSettingsDebounced();
}

// ───────────────────────── Current state ─────────────────────────

export function isActive(groupId = selected_group) {
    const active = settings().active;
    return Boolean(groupId && active && String(active.groupId) === String(groupId) && String(selected_group) === String(groupId));
}

function activeGroup() {
    return isActive() ? findGroup(selected_group) : null;
}

export function getActiveGroupId() {
    return activeGroup()?.id ?? null;
}

/**
 * Agents chosen for the group whose chat is open, or null when the group does not change agents.
 * isEnabled(id, usual) answers for one agent, given whether it is on in the user's usual list.
 */
export function getAgentOverride() {
    const group = activeGroup();
    if (!group) return null;
    const { agents } = getProfile(group);
    if (agents.mode === AGENT_MODES.KEEP) return null;
    const on = new Set(agents.on);
    const off = new Set(agents.off);
    return {
        groupId: group.id,
        groupName: group.name,
        mode: agents.mode,
        isEnabled: (agentId, usual) => (agents.mode === AGENT_MODES.ONLY ? on.has(agentId) : (on.has(agentId) || (usual && !off.has(agentId)))),
        setEnabled: (agentId, enabled, usual) => setAgentChoice(group.id, agentId, enabled, usual),
    };
}

/**
 * Records one agent's choice for a group.
 * "Only these": the list is exactly the ticked agents. "Add to my usual": only differences from the
 * usual list are stored, so an agent the user turns on everywhere later is also on here.
 */
export function setAgentChoice(groupId, agentId, enabled, usual = false) {
    const group = findGroup(groupId);
    if (!group || !agentId) return false;
    group[PROFILE_KEY] = applyAgentChoice(getProfile(group), agentId, enabled, usual);
    void editGroup(group.id, false, false);
    notify();
    return true;
}

/**
 * The profile with one agent's choice recorded (does not save anything).
 * @param {ReturnType<typeof normalizeProfile>} profile
 */
export function applyAgentChoice(profile, agentId, enabled, usual = false) {
    const on = new Set(profile.agents.on);
    const off = new Set(profile.agents.off);
    on.delete(agentId);
    off.delete(agentId);
    if (profile.agents.mode === AGENT_MODES.ONLY) {
        if (enabled) on.add(agentId);
    } else if (enabled !== Boolean(usual)) {
        (enabled ? on : off).add(agentId);
    }
    return { ...profile, agents: { ...profile.agents, on: [...on], off: [...off] } };
}

/** Groups just made in the Group Studio enter group mode without asking the first time. */
const enterWithoutAsking = new Set();
export function skipAskOnce(groupId) {
    if (groupId) enterWithoutAsking.add(String(groupId));
}

/** Lorebooks the open group adds to the scan (only ones that exist). */
export function getLorebooks() {
    const group = activeGroup();
    if (!group) return [];
    const names = new Set(Array.isArray(world_names) ? world_names : []);
    return getProfile(group).lorebooks.filter(name => names.has(name));
}

// ───────────────────────── Preset and persona ─────────────────────────

const presetManager = () => getPresetManager('openai');
const currentPresetName = () => presetManager()?.getSelectedPresetName?.() ?? '';
const presetExists = name => Boolean(name) && presetManager()?.findPreset?.(name) !== undefined;
const personaExists = avatar => Boolean(avatar) && Object.hasOwn(power_user.personas ?? {}, avatar);
export const personaName = avatar => power_user.personas?.[avatar] || avatar;

function isPresetDirty() {
    const manager = /** @type {any} */ (presetManager());
    if (!manager) return false;
    manager._checkDirty?.({ force: true });
    return Boolean(manager._dirty);
}

async function selectPreset(name) {
    const manager = presetManager();
    const value = manager?.findPreset?.(name);
    if (value === undefined || name === currentPresetName()) return false;
    await manager.selectPreset(value);
    return true;
}

async function saveCurrentPreset() {
    const manager = presetManager();
    const name = currentPresetName();
    if (!manager || !name) return;
    await manager.savePreset(name, null);
    manager.snapshotTextFields?.();
    toastr.success(`Preset "${name}" saved.`);
}

async function selectPersona(avatar) {
    if (!personaExists(avatar) || avatar === user_avatar) return false;
    await setUserAvatar(avatar, { toastPersonaNameChange: false });
    return true;
}

// ───────────────────────── Entering and leaving ─────────────────────────

/** What entering the group would change, as short lines for the popup. */
export function describeChanges(group) {
    const profile = getProfile(group);
    const lines = [];
    if (profile.preset && presetExists(profile.preset) && profile.preset !== currentPresetName()) {
        lines.push({ what: 'Preset', detail: `${currentPresetName() || '(none)'} → ${profile.preset}` });
    }
    if (profile.agents.mode === AGENT_MODES.ONLY) {
        lines.push({ what: 'Agents', detail: profile.agents.on.length ? `Only this group's ${profile.agents.on.length} agent(s)` : 'No agents' });
    } else if (profile.agents.mode === AGENT_MODES.ADD && (profile.agents.on.length || profile.agents.off.length)) {
        const parts = [];
        if (profile.agents.on.length) parts.push(`${profile.agents.on.length} more on`);
        if (profile.agents.off.length) parts.push(`${profile.agents.off.length} off`);
        lines.push({ what: 'Agents', detail: `Your usual agents, ${parts.join(', ')}` });
    }
    const books = new Set(Array.isArray(world_names) ? world_names : []);
    const lore = profile.lorebooks.filter(name => books.has(name));
    if (lore.length) lines.push({ what: 'Lorebooks', detail: `+ ${lore.join(', + ')}` });
    if (profile.persona && personaExists(profile.persona) && profile.persona !== user_avatar) {
        lines.push({ what: 'Persona', detail: `${personaName(user_avatar) || '(none)'} → ${personaName(profile.persona)}` });
    }
    return lines;
}

async function askToEnter(group, changes, dirty) {
    const rows = changes.map(change => `<div class="ct-gm-change"><span>${escapeHtml(change.what)}</span><span>${escapeHtml(change.detail)}</span></div>`).join('');
    const warning = dirty
        ? `<div class="ct-gm-warning"><i class="fa-solid fa-triangle-exclamation"></i><span>Your current preset <b>${escapeHtml(currentPresetName())}</b> has changes you haven't saved. They'll be lost if you switch without saving.</span></div>`
        : '';
    const html = `<div class="ct-gm-ask">
        <h3>Use this group's settings?</h3>
        <p class="ct-gm-muted">${escapeHtml(group.name)} has its own settings. Using them in this chat will change:</p>
        <div class="ct-gm-changes">${rows}</div>
        ${warning}
        <p class="ct-gm-muted">Your API, model and everything set to "Keep current" stay as they are. When you leave the group, or turn its settings off, your preset and persona go back to how they were.</p>
    </div>`;
    const popup = new Popup(html, POPUP_TYPE.TEXT, '', {
        okButton: dirty ? false : 'Use the group\'s settings',
        cancelButton: 'Keep mine',
        customButtons: dirty ? [
            { text: 'Switch without saving', result: 3, appendAtEnd: true },
            { text: 'Save preset and switch', result: 2, classes: ['ct-gm-primary'], appendAtEnd: true },
        ] : null,
        customInputs: [{ id: 'ct-gm-no-ask', label: 'Don\'t ask again for this group', defaultState: false }],
        leftAlign: true,
        defaultResult: dirty ? 2 : POPUP_RESULT.AFFIRMATIVE,
    });
    const result = await popup.show();
    const noAsk = Boolean(popup.inputResults?.get('ct-gm-no-ask'));
    if (result === 2) return { enter: true, save: true, noAsk };
    if (result === 3 || result === POPUP_RESULT.AFFIRMATIVE) return { enter: true, save: false, noAsk };
    return { enter: false, save: false, noAsk: false };
}

async function enter(group) {
    const st = settings();
    const profile = getProfile(group);
    st.previous = {
        preset: profile.preset && presetExists(profile.preset) ? currentPresetName() : null,
        persona: profile.persona && personaExists(profile.persona) ? user_avatar : null,
    };
    st.active = { groupId: group.id };
    saveSettingsDebounced();
    if (profile.preset) await selectPreset(profile.preset);
    if (profile.persona) await selectPersona(profile.persona);
    notify();
}

/** The profile changed while the group is open: apply the new preset / persona right away. */
async function reapply(group) {
    const st = settings();
    const profile = getProfile(group);
    st.previous ??= { preset: null, persona: null };
    if (profile.preset && presetExists(profile.preset)) {
        st.previous.preset ??= currentPresetName();
        if (isPresetDirty()) {
            toastr.info('Save or discard the changes in your current preset, then reopen the chat to use the group\'s preset.');
        } else {
            await selectPreset(profile.preset);
        }
    }
    if (profile.persona && personaExists(profile.persona)) {
        st.previous.persona ??= user_avatar;
        await selectPersona(profile.persona);
    }
    saveSettingsDebounced();
}

async function askToSaveBeforeLeaving() {
    const name = currentPresetName();
    const popup = new Popup(`<div class="ct-gm-ask"><h3>Going back to your own settings</h3><p>The group's preset <b>${escapeHtml(name)}</b> has changes you haven't saved. Save them before your own preset comes back?</p></div>`, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Save',
        cancelButton: 'Discard',
        leftAlign: true,
    });
    return (await popup.show()) === POPUP_RESULT.AFFIRMATIVE;
}

/**
 * Leaves group mode: the user's own preset and persona come back.
 * @param {{ toast?: boolean }} [options]
 */
async function leave({ toast = true } = {}) {
    const st = settings();
    const previous = st.previous;
    const groupName = findGroup(st.active?.groupId)?.name ?? 'the group';
    const groupPreset = currentPresetName();
    const groupPersona = user_avatar;
    st.active = null;
    st.previous = null;
    saveSettingsDebounced();

    const restored = [];
    if (previous?.preset && presetExists(previous.preset) && previous.preset !== currentPresetName()) {
        if (isPresetDirty() && await askToSaveBeforeLeaving()) await saveCurrentPreset();
        if (await selectPreset(previous.preset)) restored.push(`preset ${previous.preset}`);
    }
    const lockedHere = (() => {
        try {
            return isPersonaLocked('chat') || isPersonaLocked('character');
        } catch {
            return false;
        }
    })();
    if (previous?.persona && !lockedHere && await selectPersona(previous.persona)) {
        restored.push(`persona ${personaName(previous.persona)}`);
    }
    notify();
    if (toast) {
        const what = restored.length ? `Your ${restored.join(' and ')} ${restored.length > 1 ? 'are' : 'is'} back.` : 'Your own agents and lorebooks are back.';
        toastr.info(`${escapeHtml(what)}<br><small>Click to keep the group's settings instead.</small>`, `Your own settings are back (${escapeHtml(groupName)})`, {
            escapeHtml: false,
            timeOut: 7000,
            onclick: () => {
                void queueTask(async () => {
                    if (previous?.preset) await selectPreset(groupPreset);
                    if (previous?.persona) await selectPersona(groupPersona);
                });
            },
        });
    }
}

/** Leaves group mode but stays in the chat (the bar's "Leave group mode"). */
export function leaveHere() {
    const groupId = settings().active?.groupId;
    if (groupId) declined.add(String(groupId));
    return queueTask(() => leave());
}

/** Enters group mode for the open group even after "Not now". */
export function enterHere() {
    if (selected_group) declined.delete(String(selected_group));
    return queueTask(() => sync({ force: true }));
}

/** Enters group mode in the open group chat without the "Enter group chat mode?" question (used when the user just switched an agent on for the group). */
export function enterQuietly() {
    if (!selected_group) return Promise.resolve();
    enterWithoutAsking.add(String(selected_group));
    return queueTask(() => sync());
}

async function sync({ force = false } = {}) {
    const st = settings();
    const groupId = selected_group ? String(selected_group) : null;

    if (st.active && String(st.active.groupId) !== groupId) {
        await leave();
    }
    if (!groupId) {
        declined.clear();
        return;
    }
    if (isActive(groupId)) {
        notify();
        return;
    }
    for (const id of declined) if (id !== groupId) declined.delete(id);
    const group = findGroup(groupId);
    if (!group || profileIsEmpty(getProfile(group))) {
        notify();
        return;
    }
    if (declined.has(groupId) && !force) {
        notify();
        return;
    }

    const changes = describeChanges(group);
    const profile = getProfile(group);
    const presetChanges = Boolean(profile.preset && presetExists(profile.preset) && profile.preset !== currentPresetName());
    const dirty = presetChanges && isPresetDirty();
    const justCreated = enterWithoutAsking.delete(groupId);
    if (!changes.length || ((justCreated || !shouldAsk(groupId)) && !dirty && !force)) {
        await enter(group);
        return;
    }
    const answer = await askToEnter(group, changes, dirty);
    if (answer.noAsk) setShouldAsk(groupId, false);
    if (!answer.enter) {
        declined.add(groupId);
        notify();
        return;
    }
    if (answer.save) await saveCurrentPreset();
    await enter(group);
}

function queueTask(task) {
    queue = queue.then(task).catch(error => console.error('[Homunculus] Group profile:', error));
    return queue;
}

function notify() {
    document.dispatchEvent(new CustomEvent(PROFILE_CHANGED_EVENT, { detail: { groupId: getActiveGroupId() } }));
    renderBar();
}

// ───────────────────────── Group bar ─────────────────────────
//
// Three parts, one button style:
// - who: avatars, name and a plain line about the mode and your part; clicking it opens Group Studio;
// - play: Let them act / Auto-play, only when you direct the story (Co-author, Author);
// - tools: group settings (on/off in this chat), Agents, Scene, "?" and a "⋯" menu.
// The small panels (group settings, Scene set-up, ⋯) open under their button as #ct-gm-pop.

const BAR_HELP = `<p>The bar of the open group chat.</p>
<ul>
<li><b>Left</b>: who is in the group and your part in the story. Click it to open Group Studio.</li>
<li><b>Let them act / Auto-play</b> (only when you direct the story): the characters take one turn, or several in a row, without a direction from you.</li>
<li><b>Group settings</b>: the preset, persona, lorebooks and agents this group brings. You can turn them off for this chat.</li>
<li><b>Agents</b>: the agents working in this group. <b>Scene</b>: the panel beside the chat with who is here, the time and the place.</li>
</ul>`;
const SETTINGS_HELP = `<p>A group can bring its own setup: a preset, a persona, lorebooks and agents. While its chat is open, they replace your usual ones.</p>
<p>Turn on <b>Use my own settings in this chat</b> to keep your usual setup instead. Nothing in the group is lost: it is used again next time.</p>
<p>Change the group's setup in Group Studio → Settings.</p>`;

/** The open bar panel: { kind: 'settings'|'scene'|'more', el } */
let barPop = null;

function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

const studio = () => globalThis.HomunculusGroupStudio;

function closeBarPop({ focus = false } = {}) {
    if (!barPop) return;
    const kind = barPop.kind;
    barPop.el.remove();
    barPop = null;
    const anchor = /** @type {HTMLElement|null} */ (document.querySelector(`#ct-group-mode-bar [data-gm-pop="${kind}"]`));
    anchor?.setAttribute('aria-expanded', 'false');
    if (focus) anchor?.focus();
}

function placeBarPop() {
    if (!barPop) return;
    const anchor = document.querySelector(`#ct-group-mode-bar [data-gm-pop="${barPop.kind}"]`);
    if (!anchor) {
        closeBarPop();
        return;
    }
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(Number(barPop.el.dataset.width) || 380, window.innerWidth - 24);
    barPop.el.style.width = `${width}px`;
    barPop.el.style.left = `${Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))}px`;
    barPop.el.style.top = `${Math.round(rect.bottom + 8)}px`;
}

/**
 * Opens a bar panel under its button (a second click on the same button closes it).
 * @param {'settings'|'scene'|'more'} kind
 * @param {(pop: HTMLElement) => void} fill
 * @param {number} width
 */
function toggleBarPop(kind, fill, width) {
    const same = barPop?.kind === kind;
    closeBarPop();
    if (same) return;
    globalThis.HomunculusGroupAgents?.close?.();
    closeHelp();
    const pop = el('div', `ct-gm-pop ct-gm-pop-${kind}`);
    pop.id = 'ct-gm-pop';
    pop.dataset.width = String(width);
    pop.setAttribute('role', kind === 'more' ? 'menu' : 'dialog');
    pop.setAttribute('aria-label', kind === 'more' ? 'More' : kind === 'scene' ? 'Scene panel' : 'Group settings');
    fill(pop);
    document.body.append(pop);
    barPop = { kind, el: pop };
    placeBarPop();
    document.querySelector(`#ct-group-mode-bar [data-gm-pop="${kind}"]`)?.setAttribute('aria-expanded', 'true');
    if (kind === 'more') /** @type {HTMLElement|null} */ (pop.querySelector('button'))?.focus();
}

document.addEventListener('pointerdown', (event) => {
    if (!barPop) return;
    const target = /** @type {HTMLElement} */ (event.target);
    if (barPop.el.contains(target) || target.closest?.(`#ct-group-mode-bar [data-gm-pop="${barPop.kind}"]`) || target.closest?.('.ct-help-card')) return;
    closeBarPop();
}, true);
document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !barPop || document.querySelector('.ct-help-card, dialog[open]')) return;
    event.stopPropagation();
    closeBarPop({ focus: true });
}, true);
window.addEventListener('resize', () => closeBarPop());

/** The group's setup as label/value rows ("Your usual one" where the group changes nothing). */
function settingRows(profile) {
    const books = new Set(Array.isArray(world_names) ? world_names : []);
    const lore = profile.lorebooks.filter(name => books.has(name));
    let agents = 'Your usual ones';
    if (profile.agents.mode === AGENT_MODES.ONLY) {
        agents = profile.agents.on.length ? `Only ${profile.agents.on.length} chosen for this group` : 'None';
    } else if (profile.agents.mode === AGENT_MODES.ADD) {
        const extra = [];
        if (profile.agents.on.length) extra.push(`+ ${profile.agents.on.length} for this group`);
        if (profile.agents.off.length) extra.push(`${profile.agents.off.length} off here`);
        if (extra.length) agents = `Your usual ones ${extra.join(', ')}`;
    }
    return [
        ['Preset', profile.preset && presetExists(profile.preset) ? profile.preset : '', 'Your usual one'],
        ['Persona', profile.persona && personaExists(profile.persona) ? personaName(profile.persona) : '', 'Your usual one'],
        ['Lorebooks', lore.join(', '), 'No extra ones'],
        ['Agents', agents === 'Your usual ones' ? '' : agents, 'Your usual ones'],
    ];
}

function fillSettings(pop, group) {
    pop.replaceChildren();
    const active = isActive(group.id);
    const head = el('div', 'ct-gm-pop-head');
    const titles = el('div', 'ct-gm-pop-titles');
    titles.append(
        el('div', 'ct-gm-pop-title', active ? 'Group settings are on' : 'Your own settings are in use'),
        el('div', 'ct-gm-pop-sub', active ? 'While this chat is open, the group\'s setup replaces your usual one:' : 'This group has its own setup, turned off in this chat:'),
    );
    head.append(titles, helpButton('Group settings', SETTINGS_HELP));
    const rows = el('div', `ct-gm-pop-rows${active ? '' : ' is-off'}`);
    for (const [label, value, none] of settingRows(getProfile(group))) {
        rows.append(el('span', 'ct-gm-pop-key', label), el('span', value ? '' : 'ct-gm-pop-none', value || none));
    }
    const own = el('label', 'ct-gm-pop-switch');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = !active;
    input.setAttribute('role', 'switch');
    input.addEventListener('change', async () => {
        input.disabled = true;
        await (input.checked ? leaveHere() : enterHere());
        if (barPop?.kind === 'settings') fillSettings(pop, group);
    });
    const text = el('span', 'ct-gm-pop-switch-text');
    text.append(el('span', 'ct-gm-pop-switch-label', 'Use my own settings in this chat'), el('span', 'ct-gm-pop-sub', 'Your usual preset and persona come back. The group keeps its setup for next time.'));
    own.append(input, el('span', 'ct-gm-pop-track'), text);
    const foot = el('div', 'ct-gm-pop-foot');
    const edit = el('button', 'ct-gm-pop-link', 'Change them in Group Studio');
    edit.type = 'button';
    edit.addEventListener('click', () => {
        closeBarPop();
        studio()?.open?.(group.id, 'settings');
    });
    foot.append(edit);
    pop.append(head, rows, own, foot);
}

function fillSceneSetup(pop, group) {
    pop.append(el('div', 'ct-gm-pop-title', 'No Scene panel yet'));
    pop.append(el('p', 'ct-gm-pop-sub', 'The Scene panel shows who is here, what they wear, the time and the place, beside the chat. It needs at least one Scene tracker turned on for this group.'));
    const go = el('button', 'menu_button ct-gm-btn ct-gm-pop-primary', 'Set it up in Group Studio');
    go.type = 'button';
    go.addEventListener('click', () => {
        closeBarPop();
        studio()?.open?.(group.id, 'scene');
    });
    pop.append(go);
}

function fillMore(pop, group) {
    const item = (icon, text, onClick) => {
        const b = el('button', 'ct-gm-pop-item');
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i>`;
        b.append(el('span', '', text));
        b.addEventListener('click', () => {
            closeBarPop();
            void onClick();
        });
        pop.append(b);
    };
    item('fa-users-gear', 'Open Group Studio', () => studio()?.open?.(group.id));
    item('fa-plus', 'Start a new chat', () => createNewGroupChat(group.id));
    item('fa-comments', 'Chats of this group', () => studio()?.open?.(group.id, 'chats'));
    item('fa-pen', 'Rename group…', () => {
        studio()?.open?.(group.id, 'setup');
        requestAnimationFrame(() => document.getElementById('ct-gs-group-name')?.focus());
    });
}

/** "Narrated · you play Kael" and the like. */
function barLine(campaign) {
    const mode = campaign.mode === 'narrated' ? 'Narrated' : 'Everyone replies';
    const me = String(name1 || 'you');
    if (campaign.role === 'coauthor') return `${mode} · Co-author: the AI writes ${me} from your directions`;
    if (campaign.role === 'author') return `${mode} · Director: you direct, nobody plays`;
    return `${mode} · you play ${me}`;
}

function barAvatars(group) {
    const wrap = el('span', 'ct-gm-faces');
    wrap.setAttribute('aria-hidden', 'true');
    const members = Array.isArray(group.members) ? group.members : [];
    for (const avatar of members.slice(0, 3)) {
        const img = el('img', 'ct-gm-face');
        img.alt = '';
        img.loading = 'lazy';
        img.src = getThumbnailUrl('avatar', avatar);
        wrap.append(img);
    }
    if (members.length > 3) wrap.append(el('span', 'ct-gm-face ct-gm-face-more', `+${members.length - 3}`));
    return wrap;
}

function barButton(html, action, title = '', extraClass = '') {
    const b = el('button', `menu_button ct-gm-btn${extraClass ? ` ${extraClass}` : ''}`);
    b.type = 'button';
    b.innerHTML = html;
    b.dataset.gmAction = action;
    if (title) b.title = title;
    return b;
}

function onBarClick(event) {
    const target = /** @type {HTMLElement} */ (event.target);
    const action = target?.closest?.('[data-gm-action]')?.getAttribute('data-gm-action');
    const group = selected_group ? findGroup(selected_group) : null;
    if (!action || !group) return;
    if (action === 'edit') studio()?.open?.(group.id);
    if (action === 'agents') {
        closeBarPop();
        globalThis.HomunculusGroupAgents?.toggle?.();
    }
    if (action === 'scene') {
        closeBarPop();
        globalThis.HomunculusScene?.toggle?.();
        renderBar();
    }
    if (action === 'settings') toggleBarPop('settings', pop => fillSettings(pop, group), 400);
    if (action === 'scene-setup') toggleBarPop('scene', pop => fillSceneSetup(pop, group), 340);
    if (action === 'more') toggleBarPop('more', pop => fillMore(pop, group), 240);
    if (action === 'act') void globalThis.HomunculusGroupCampaign?.letThemAct?.(1);
    if (action === 'auto') void globalThis.HomunculusGroupCampaign?.letThemAct?.(autoTurns());
    if (action === 'stop') globalThis.HomunculusGroupCampaign?.stopAutoplay?.();
}

function renderBar() {
    const chat = document.getElementById('chat');
    if (!chat) return;
    let bar = document.getElementById('ct-group-mode-bar');
    const group = selected_group ? findGroup(selected_group) : null;
    // Every open group chat gets the bar (it holds the Agents menu).
    if (!group) {
        bar?.remove();
        closeBarPop();
        globalThis.HomunculusGroupAgents?.close?.();
        return;
    }
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'ct-group-mode-bar';
        bar.setAttribute('role', 'toolbar');
        bar.setAttribute('aria-label', 'Group chat');
        chat.before(bar);
        bar.addEventListener('click', onBarClick);
        bar.addEventListener('change', (event) => {
            const select = /** @type {HTMLSelectElement} */ (event.target);
            if (!select?.matches?.('[data-gm-auto]')) return;
            settings().autoTurns = Number(select.value) || 3;
            saveSettingsDebounced();
        });
    }
    const hasProfile = !profileIsEmpty(getProfile(group));
    const active = hasProfile && isActive(group.id);
    const campaignApi = globalThis.HomunculusGroupCampaign;
    const campaign = campaignApi?.getCampaign?.(group) ?? { mode: 'ensemble', role: 'player' };
    bar.classList.toggle('is-active', active);
    bar.replaceChildren();

    // Who
    const who = el('button', 'ct-gm-who');
    who.type = 'button';
    who.dataset.gmAction = 'edit';
    who.title = 'Open Group Studio';
    who.setAttribute('aria-label', `Open Group Studio for ${group.name}`);
    const names = el('span', 'ct-gm-who-text');
    names.append(el('span', 'ct-gm-name', group.name), el('span', 'ct-gm-line', barLine(campaign)));
    who.append(barAvatars(group), names);
    who.insertAdjacentHTML('beforeend', '<i class="fa-solid fa-chevron-right ct-gm-who-arrow" aria-hidden="true"></i>');
    bar.append(who);

    // Play (only when you direct the story)
    if (campaign.role !== 'player') {
        const play = el('span', 'ct-gm-play');
        const auto = campaignApi?.autoplayState?.() ?? { running: false, left: 0 };
        if (auto.running) {
            play.append(barButton('<i class="fa-solid fa-stop" aria-hidden="true"></i> Stop', 'stop', 'Stop the characters acting on their own', 'ct-gm-stop'));
            if (auto.left > 0) play.append(el('span', 'ct-gm-play-note', `${auto.left} turn${auto.left === 1 ? '' : 's'} left`));
        } else {
            play.append(barButton('<i class="fa-solid fa-play" aria-hidden="true"></i> Let them act', 'act', 'One turn without a direction: the characters act on their own'));
            const autoWrap = el('span', 'ct-gm-auto');
            autoWrap.append(barButton('<i class="fa-solid fa-forward" aria-hidden="true"></i> Auto-play', 'auto', 'Several turns in a row without directions (Stop ends it)'));
            const select = el('select', 'text_pole ct-gm-auto-count');
            select.dataset.gmAuto = '';
            select.setAttribute('aria-label', 'Auto-play turns');
            const turns = autoTurns();
            for (const n of [3, 5, 10]) {
                const opt = el('option', '', `×${n}`);
                opt.value = String(n);
                opt.selected = n === turns;
                select.append(opt);
            }
            autoWrap.append(select);
            play.append(autoWrap);
        }
        bar.append(play);
    }

    // Tools
    const tools = el('span', 'ct-gm-tools');
    if (hasProfile) {
        const set = barButton(`<span class="ct-gm-dot" aria-hidden="true"></span>${active ? 'Group settings on' : 'Your own settings'}`, 'settings', active ? 'This group\'s settings are in use in this chat' : 'Your own settings are in use in this chat', `ct-gm-settings${active ? ' is-group' : ''}`);
        set.dataset.gmPop = 'settings';
        set.setAttribute('aria-haspopup', 'dialog');
        set.setAttribute('aria-expanded', String(barPop?.kind === 'settings'));
        tools.append(set);
    }
    const agentsMenu = globalThis.HomunculusGroupAgents;
    const counts = agentsMenu?.summary?.() ?? null;
    if (counts) {
        const agents = barButton(`<i class="fa-solid fa-robot" aria-hidden="true"></i> Agents <b>${counts.on}</b>${counts.running ? `<span class="ct-gm-running"><span class="ct-gm-running-dot"></span>${counts.running} running</span>` : ''}`, 'agents', 'Agents in this group', `ct-gm-agents${agentsMenu.isOpen() ? ' is-on' : ''}`);
        agents.setAttribute('aria-haspopup', 'dialog');
        agents.setAttribute('aria-expanded', String(agentsMenu.isOpen()));
        tools.append(agents);
    }
    const sceneApi = globalThis.HomunculusScene;
    if (sceneApi?.isAvailable?.()) {
        const open = Boolean(sceneApi.isOpen?.());
        const scene = barButton('<i class="fa-solid fa-masks-theater" aria-hidden="true"></i> Scene', 'scene', open ? 'Hide the Scene panel' : 'Show the Scene panel', `ct-gm-scene${open ? ' is-on' : ''}`);
        scene.setAttribute('aria-pressed', String(open));
        tools.append(scene);
    } else if (sceneApi) {
        const setup = barButton('<i class="fa-solid fa-masks-theater" aria-hidden="true"></i> Scene', 'scene-setup', 'No Scene panel yet: set it up', 'ct-gm-scene is-setup');
        setup.dataset.gmPop = 'scene';
        setup.setAttribute('aria-haspopup', 'dialog');
        setup.setAttribute('aria-expanded', String(barPop?.kind === 'scene'));
        tools.append(setup);
    }
    tools.append(helpButton('The group bar', BAR_HELP));
    const more = barButton('<i class="fa-solid fa-ellipsis" aria-hidden="true"></i>', 'more', 'More', 'ct-gm-more');
    more.dataset.gmPop = 'more';
    more.setAttribute('aria-label', 'More');
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', String(barPop?.kind === 'more'));
    tools.append(more);
    bar.append(tools);

    if (barPop) placeBarPop();
}

function autoTurns() {
    const value = Number(settings().autoTurns);
    return [3, 5, 10].includes(value) ? value : 3;
}

// ───────────────────────── Start ─────────────────────────

function init() {
    eventSource.on(event_types.CHAT_CHANGED, () => {
        closeBarPop();
        if (!ready) return;
        // Let SillyTavern finish its own chat switch (persona locks, preset bindings) first.
        setTimeout(() => void queueTask(() => sync()), 0);
    });
    eventSource.on(event_types.GROUP_UPDATED, () => renderBar());
    document.addEventListener('homunculus:group-campaign-changed', () => renderBar());
    // APP_READY also fires for listeners added after it happened.
    eventSource.on(event_types.APP_READY, () => {
        if (ready) return;
        ready = true;
        void queueTask(() => sync());
    });
}

init();

globalThis.HomunculusGroupProfile = {
    refreshBar: () => renderBar(),
    getProfile,
    normalizeProfile,
    skipAskOnce,
    saveProfile,
    getAgentOverride,
    setAgentChoice,
    getLorebooks,
    isActive,
    getActiveGroupId,
    describeChanges,
    leaveHere,
    enterHere,
    shouldAsk,
    setShouldAsk,
    AGENT_MODES,
    PROFILE_CHANGED_EVENT,
};
