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

import { eventSource, event_types, saveSettingsDebounced } from '../script.js';
import { extension_settings } from './extensions.js';
import { groups, selected_group, editGroup } from './group-chats.js';
import { getPresetManager } from './preset-manager.js';
import { user_avatar, setUserAvatar, isPersonaLocked } from './personas.js';
import { power_user } from './power-user.js';
import { world_names } from './world-info.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { escapeHtml } from './utils.js';

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
        <h3>Enter group chat mode?</h3>
        <p class="ct-gm-muted">${escapeHtml(group.name)} has its own profile. Opening this chat will change:</p>
        <div class="ct-gm-changes">${rows}</div>
        ${warning}
        <p class="ct-gm-muted">Your API, model and everything set to "Keep current" stay as they are. When you leave the group, your preset and persona go back to how they were.</p>
    </div>`;
    const popup = new Popup(html, POPUP_TYPE.TEXT, '', {
        okButton: dirty ? false : 'Enter group mode',
        cancelButton: 'Not now',
        customButtons: dirty ? [
            { text: 'Enter without saving', result: 3, appendAtEnd: true },
            { text: 'Save preset and enter', result: 2, classes: ['ct-gm-primary'], appendAtEnd: true },
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
    const popup = new Popup(`<div class="ct-gm-ask"><h3>Leaving group chat mode</h3><p>The group's preset <b>${escapeHtml(name)}</b> has changes you haven't saved. Save them before your own preset comes back?</p></div>`, POPUP_TYPE.CONFIRM, '', {
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
        toastr.info(`${escapeHtml(what)}<br><small>Click to keep the group's settings instead.</small>`, `Left group mode (${escapeHtml(groupName)})`, {
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

// ───────────────────────── Group mode bar ─────────────────────────

function summary(group) {
    const profile = getProfile(group);
    const parts = [];
    if (profile.preset) parts.push(profile.preset);
    if (profile.agents.mode === AGENT_MODES.ONLY) parts.push(`${profile.agents.on.length} agent${profile.agents.on.length === 1 ? '' : 's'}`);
    else if (profile.agents.mode === AGENT_MODES.ADD) parts.push('usual agents +');
    if (profile.lorebooks.length) parts.push(`${profile.lorebooks.length} lorebook${profile.lorebooks.length === 1 ? '' : 's'}`);
    if (profile.persona) parts.push(personaName(profile.persona));
    return parts.join(' · ');
}

function renderBar() {
    const chat = document.getElementById('chat');
    if (!chat) return;
    let bar = document.getElementById('ct-group-mode-bar');
    const group = selected_group ? findGroup(selected_group) : null;
    const hasProfile = Boolean(group && !profileIsEmpty(getProfile(group)));
    const campaignApi = globalThis.HomunculusGroupCampaign;
    const campaign = group && campaignApi ? campaignApi.getCampaign(group) : null;
    const hasCampaign = Boolean(campaign && campaignApi.hasCampaignTools(campaign));
    if (!hasProfile && !hasCampaign) {
        bar?.remove();
        return;
    }
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'ct-group-mode-bar';
        chat.before(bar);
        bar.addEventListener('click', (event) => {
            const action = /** @type {HTMLElement} */ (event.target)?.closest?.('[data-gm-action]')?.getAttribute('data-gm-action');
            if (action === 'edit') globalThis.HomunculusGroupStudio?.open?.(selected_group);
            if (action === 'leave') void leaveHere();
            if (action === 'enter') void enterHere();
            if (action === 'world') void globalThis.HomunculusGroupCampaign?.openWorldPanel?.();
            if (action === 'npcs') void globalThis.HomunculusGroupCampaign?.reviewPendingNpcs?.();
            if (action === 'find-npcs') void globalThis.HomunculusGroupCampaign?.scanLastReply?.();
        });
    }
    const active = hasProfile && isActive(group.id);
    bar.classList.toggle('is-active', active);
    const pending = hasCampaign ? campaignApi.getPendingNpcs().length : 0;
    const campaignButtons = !hasCampaign ? '' : [
        campaign.mode === 'narrated' ? '<span class="ct-gm-chip" title="Only the narrator replies on its own">NARRATED</span>' : '',
        campaign.world.enabled ? '<button type="button" class="menu_button ct-gm-toggle" data-gm-action="world"><i class="fa-solid fa-earth-europe"></i> World</button>' : '',
        campaign.npc.mode !== 'off' ? `<button type="button" class="menu_button ct-gm-toggle${pending ? ' is-attention' : ''}" data-gm-action="${pending ? 'npcs' : 'find-npcs'}" title="${pending ? 'Keep or ignore the NPCs found' : 'Look for new named NPCs in the last reply'}"><i class="fa-solid fa-user-plus"></i> ${pending ? `NPCs (${pending})` : 'Find NPCs'}</button>` : '',
    ].join('');
    bar.innerHTML = `
        <span class="ct-gm-badge">${hasProfile ? (active ? 'GROUP MODE' : 'GROUP MODE OFF') : 'CAMPAIGN'}</span>
        <span class="ct-gm-name"></span>
        <span class="ct-gm-summary"></span>
        ${campaignButtons}
        <button type="button" class="ct-gm-link" data-gm-action="edit">Group Studio</button>
        ${hasProfile ? `<button type="button" class="menu_button ct-gm-toggle" data-gm-action="${active ? 'leave' : 'enter'}">${active ? 'Leave group mode' : 'Enter group mode'}</button>` : ''}`;
    bar.querySelector('.ct-gm-name').textContent = group.name;
    bar.querySelector('.ct-gm-summary').textContent = !hasProfile ? '' : active ? summary(group) : 'Your own settings are in use in this chat.';
}

// ───────────────────────── Start ─────────────────────────

function init() {
    eventSource.on(event_types.CHAT_CHANGED, () => {
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
