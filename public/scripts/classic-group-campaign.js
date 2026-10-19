// Classic UI fork: campaign tools for groups (Narrated mode, cast sheets, NPC Registry, World state).
//
// Everything lives in group.homunculus_campaign (see getCampaign). It works whenever one of the
// group's chats is open; it does not depend on "group mode" (that is the profile in
// classic-group-profile.js: preset, persona, agents, lorebooks).
//
// - Narrated mode: only the narrator replies on its own (group-chats.js asks getNarratorChid). The
//   other members are the cast: they never speak by themselves (they still can with the member bar).
//   Their sheets go into the prompt as one block (In scene: whole sheet, Offscreen: one line, Off:
//   nothing), or only where the preset writes {{cast}}.
// - Cast sheets: a character card cleaned of instructions, scenario and other meta text, made by an
//   AI with a connection profile the user picks, then reviewed. The card itself is never changed.
// - NPC Registry: after a reply, a separate AI call reads only that reply and notes named NPCs who
//   actually did or said something. "Ask me" collects them for the user to keep or ignore,
//   "Automatic" writes them right away. They become keyword entries in the campaign's NPC lorebook,
//   so a sheet only comes back when the name is mentioned. The narrator gets no NPC instruction.
// - World state: modules the user switches on (time, location, weather, party, quests, inventory,
//   factions, custom). After every N replies a separate AI call updates them. The state is saved in
//   the message it came from (and its swipe), so swipes, deleting, regenerating and branches keep
//   the right state. Each module goes into the prompt always, only when it is relevant, or never
//   (panel only). Time is counted by the app from "minutes / hours / days" answers.
//
// The prompts for the NPC Registry, the world state and the cast sheets are adapted from ideas in
// Aventuras (https://github.com/AventurasTeam/Aventuras, AGPL-3.0); see CREDITS.md.

import {
    eventSource,
    event_types,
    chat,
    chat_metadata,
    characters,
    name1,
    getCharacters,
    getRequestHeaders,
    saveChatDebounced,
    setExtensionPrompt,
    extension_prompt_types,
} from '../script.js';
import { extension_settings, saveMetadataDebounced } from './extensions.js';
import { groups, selected_group, editGroup } from './group-chats.js';
import { world_names, loadWorldInfo, createWorldInfoEntry, saveWorldInfo, updateWorldInfoList } from './world-info.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from './popup.js';

const CAMPAIGN_KEY = 'homunculus_campaign';
const WORLD_KEY = 'homunculus_world';
const PENDING_KEY = 'homunculus_npc_pending';
export const CAMPAIGN_CHANGED_EVENT = 'homunculus:group-campaign-changed';
const CAST_PROMPT_KEY = 'homunculus_cast';
const WORLD_PROMPT_KEY = 'homunculus_world';

export const CAST_STATES = Object.freeze({ SCENE: 'scene', OFFSCREEN: 'offscreen', OFF: 'off' });
export const NPC_MODES = Object.freeze({ OFF: 'off', ASK: 'ask', AUTO: 'auto' });
export const INJECT = Object.freeze({ ALWAYS: 'always', RELEVANT: 'relevant', PANEL: 'panel' });

/** World state modules. `words`: what makes a module "relevant" in the latest messages. */
export const WORLD_MODULES = Object.freeze([
    { id: 'time', label: 'Time & day', on: true, inject: INJECT.ALWAYS, words: [] },
    { id: 'location', label: 'Location', on: true, inject: INJECT.ALWAYS, words: [] },
    { id: 'weather', label: 'Weather', on: false, inject: INJECT.ALWAYS, words: ['weather', 'rain', 'snow', 'storm', 'wind', 'sun', 'fog', 'cold', 'hot', 'sky'] },
    { id: 'party', label: 'Party status', on: false, inject: INJECT.RELEVANT, words: ['hurt', 'wound', 'injur', 'bleed', 'tired', 'exhaust', 'health', 'heal', 'poison', 'sick', 'pain', 'hp'] },
    { id: 'quests', label: 'Quests', on: false, inject: INJECT.ALWAYS, words: ['quest', 'mission', 'task', 'job', 'contract', 'bounty', 'goal'] },
    { id: 'inventory', label: 'Inventory', on: false, inject: INJECT.RELEVANT, words: ['item', 'bag', 'pack', 'inventory', 'gold', 'coin', 'buy', 'sell', 'equip', 'weapon', 'sword', 'potion', 'carry', 'pocket', 'loot', 'trade'] },
    { id: 'factions', label: 'Factions', on: false, inject: INJECT.RELEVANT, words: ['faction', 'guild', 'order', 'king', 'queen', 'lord', 'clan', 'house', 'army', 'church', 'empire', 'reputation'] },
]);

// ───────────────────────── Data ─────────────────────────

const str = value => (typeof value === 'string' ? value : '');
const clampInt = (value, min, max, fallback) => {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/**
 * A campaign object in the full shape (also used for a group that is not created yet).
 * @param {any} value
 */
export function normalizeCampaign(value) {
    const raw = value && typeof value === 'object' ? value : {};
    const narrator = raw.narrator && typeof raw.narrator === 'object' ? raw.narrator : {};
    const cast = {};
    for (const [avatar, entry] of Object.entries(raw.cast && typeof raw.cast === 'object' ? raw.cast : {})) {
        if (!avatar || !entry || typeof entry !== 'object') continue;
        cast[avatar] = {
            state: Object.values(CAST_STATES).includes(entry.state) ? entry.state : CAST_STATES.SCENE,
            sheet: str(entry.sheet),
            line: str(entry.line),
        };
    }
    const npc = raw.npc && typeof raw.npc === 'object' ? raw.npc : {};
    const world = raw.world && typeof raw.world === 'object' ? raw.world : {};
    const savedModules = world.modules && typeof world.modules === 'object' ? world.modules : {};
    const modules = {};
    for (const module of WORLD_MODULES) {
        const saved = savedModules[module.id] && typeof savedModules[module.id] === 'object' ? savedModules[module.id] : {};
        modules[module.id] = {
            on: typeof saved.on === 'boolean' ? saved.on : module.on,
            inject: Object.values(INJECT).includes(saved.inject) ? saved.inject : module.inject,
        };
    }
    const custom = (Array.isArray(world.custom) ? world.custom : [])
        .filter(field => field && typeof field === 'object' && str(field.name).trim())
        .map(field => ({ name: str(field.name).trim().slice(0, 60), inject: Object.values(INJECT).includes(field.inject) ? field.inject : INJECT.ALWAYS }));
    return {
        mode: raw.mode === 'narrated' ? 'narrated' : 'ensemble',
        narrator: {
            type: narrator.type === 'builtin' ? 'builtin' : 'card',
            avatar: str(narrator.avatar),
            style: str(narrator.style),
            builtinAvatar: str(narrator.builtinAvatar),
        },
        cast,
        castPlacement: raw.castPlacement === 'macro' ? 'macro' : 'prompt',
        previousGenerationMode: Number.isInteger(raw.previousGenerationMode) ? raw.previousGenerationMode : null,
        npc: {
            mode: Object.values(NPC_MODES).includes(npc.mode) ? npc.mode : NPC_MODES.OFF,
            lorebook: str(npc.lorebook),
            profileId: str(npc.profileId),
        },
        world: {
            enabled: Boolean(world.enabled),
            profileId: str(world.profileId),
            every: clampInt(world.every, 1, 20, 1),
            modules,
            custom,
        },
    };
}

export function getCampaign(group) {
    return normalizeCampaign(group?.[CAMPAIGN_KEY]);
}

const findGroup = groupId => groups.find(group => String(group.id) === String(groupId)) ?? null;
const openGroup = () => (selected_group ? findGroup(selected_group) : null);
const characterByAvatar = avatar => characters.find(character => character.avatar === avatar) ?? null;
export const characterName = avatar => characterByAvatar(avatar)?.name ?? String(avatar ?? '').replace(/\.[^.]+$/, '');

/**
 * Saves a group's campaign (merged with what it has).
 * @param {string} groupId
 * @param {object} patch
 */
export async function saveCampaign(groupId, patch) {
    const group = findGroup(groupId);
    if (!group) return null;
    const current = getCampaign(group);
    const next = normalizeCampaign({
        ...current,
        ...patch,
        narrator: { ...current.narrator, ...(patch.narrator ?? {}) },
        npc: { ...current.npc, ...(patch.npc ?? {}) },
        world: { ...current.world, ...(patch.world ?? {}) },
    });
    group[CAMPAIGN_KEY] = next;
    await editGroup(group.id, true, false);
    notify();
    return next;
}

export function hasCampaignTools(campaign) {
    return campaign.mode === 'narrated' || campaign.npc.mode !== NPC_MODES.OFF || campaign.world.enabled;
}

export function narratorAvatar(campaign) {
    return campaign.narrator.type === 'builtin' ? campaign.narrator.builtinAvatar : campaign.narrator.avatar;
}

function notify() {
    document.dispatchEvent(new CustomEvent(CAMPAIGN_CHANGED_EVENT));
    globalThis.HomunculusGroupProfile?.refreshBar?.();
}

// ───────────────────────── AI requests ─────────────────────────

export function connectionProfiles() {
    const list = extension_settings.connectionManager?.profiles;
    return Array.isArray(list) ? list.filter(profile => profile?.id).map(profile => ({ id: profile.id, name: String(profile.name || profile.id) })) : [];
}

async function askAi(profileId, system, user, maxTokens = 900) {
    const context = globalThis.SillyTavern?.getContext?.();
    const exists = profileId && connectionProfiles().some(profile => profile.id === profileId);
    if (exists && context?.ConnectionManagerRequestService) {
        const result = await context.ConnectionManagerRequestService.sendRequest(profileId, [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ], maxTokens);
        return typeof result === 'string' ? result : String(result?.content ?? '');
    }
    if (context?.generateRaw) {
        return String(await context.generateRaw({ prompt: user, systemPrompt: system, responseLength: maxTokens }) ?? '');
    }
    throw new Error('The app is not ready to ask the AI yet.');
}

/** The first JSON object in an AI answer (code fences and chatter around it are ignored). */
function parseJson(answer) {
    const text = String(answer ?? '').replace(/```(?:json)?/gi, '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
        return JSON.parse(text.slice(start, end + 1));
    } catch {
        return null;
    }
}

// ───────────────────────── Narrator ─────────────────────────

/**
 * Who replies in a Narrated group: the narrator's character id, or -1 to leave it to the normal rules.
 * Asked by group-chats.js; forced speakers (the member bar, /trigger) are never changed.
 */
export function getNarratorChid(group, { type = '', forced = false } = {}) {
    if (!group || forced || ['swipe', 'continue', 'impersonate'].includes(type)) return -1;
    const campaign = getCampaign(group);
    if (campaign.mode !== 'narrated') return -1;
    const avatar = narratorAvatar(campaign);
    if (!avatar || !group.members?.includes(avatar)) return -1;
    return characters.findIndex(character => character.avatar === avatar);
}

function builtinDescription(style) {
    const text = String(style ?? '').trim();
    return text || 'The narrator of this story. Tells the story and voices every character and NPC in the cast.';
}

/** Makes the card behind a built-in narrator. Returns its avatar file name. */
export async function createBuiltinNarrator(groupName, style) {
    const form = new FormData();
    form.append('ch_name', `Narrator (${String(groupName || 'group').slice(0, 40)})`);
    form.append('description', builtinDescription(style));
    form.append('personality', '');
    form.append('scenario', '');
    form.append('first_mes', '');
    form.append('mes_example', '');
    form.append('creator_notes', 'Made by the Homunculus Group Studio for a Narrated group. Edit the style in the Group Studio.');
    form.append('tags', 'Narrator');
    const headers = getRequestHeaders();
    delete headers['Content-Type'];
    const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
    if (!response.ok) throw new Error(`Could not make the narrator card (${response.status}).`);
    const avatar = (await response.text()).trim();
    await getCharacters();
    return avatar;
}

export async function updateBuiltinNarrator(avatar, style) {
    if (!avatar) return;
    const description = builtinDescription(style);
    const response = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar, description, data: { description } }),
    });
    if (!response.ok) throw new Error(`Could not update the narrator card (${response.status}).`);
    const character = characterByAvatar(avatar);
    if (character) {
        character.description = description;
        if (character.data) character.data.description = description;
    }
}

// ───────────────────────── Cast ─────────────────────────

export function castMembers(group, campaign = getCampaign(group)) {
    const narrator = narratorAvatar(campaign);
    return (Array.isArray(group?.members) ? group.members : []).filter(avatar => avatar !== narrator);
}

function replaceNames(text, name) {
    return String(text ?? '').replace(/\{\{char\}\}/gi, name).replace(/<BOT>/gi, name);
}

/** The card text used when no sheet was made yet. */
export function defaultSheet(avatar) {
    const character = characterByAvatar(avatar);
    if (!character) return '';
    const name = character.name;
    const parts = [str(character.description).trim(), str(character.personality).trim() ? `Personality: ${str(character.personality).trim()}` : ''].filter(Boolean);
    return replaceNames(parts.join('\n\n'), name);
}

export function oneLine(text, name) {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) return name ? `${name}.` : '';
    const sentence = clean.match(/^.{0,200}?[.!?](?=\s|$)/)?.[0] ?? clean.slice(0, 160);
    return sentence.trim();
}

function castEntry(campaign, avatar) {
    return campaign.cast[avatar] ?? { state: CAST_STATES.SCENE, sheet: '', line: '' };
}

/** The cast block for the prompt (empty outside Narrated groups). */
export function castText(group = openGroup()) {
    if (!group) return '';
    const campaign = getCampaign(group);
    if (campaign.mode !== 'narrated') return '';
    const scene = [];
    const offscreen = [];
    for (const avatar of castMembers(group, campaign)) {
        const entry = castEntry(campaign, avatar);
        const name = characterName(avatar);
        const sheet = (entry.sheet || defaultSheet(avatar)).trim();
        if (entry.state === CAST_STATES.SCENE) scene.push(`### ${name}\n${sheet || `${name}.`}`);
        else if (entry.state === CAST_STATES.OFFSCREEN) offscreen.push(`- ${name}: ${entry.line || oneLine(sheet, name)}`);
    }
    const blocks = [];
    if (scene.length) blocks.push(`[Cast in this scene. The narrator voices them; they are not the narrator.]\n${scene.join('\n\n')}`);
    if (offscreen.length) blocks.push(`[Known characters who are not in this scene]\n${offscreen.join('\n')}`);
    return blocks.join('\n\n');
}

// The card goes to the AI with {{char}} already replaced and {{user}} swapped for this marker, because
// the request fills in macros; the marker is turned back into {{user}} in the answer.
const USER_MARK = '[PLAYER]';
const toMark = text => String(text ?? '').replace(/\{\{user\}\}/gi, USER_MARK).replace(/<USER>/gi, USER_MARK);
const fromMark = text => String(text ?? '').split(USER_MARK).join('{{user}}');

const SHEET_PARTS = ['Appearance', 'Personality', 'Background', 'Speech', 'Relationships', 'Example dialogue'];

function sheetPrompt(name, keep, condense) {
    return `You turn a roleplay character card into a clean reference sheet that a narrator will read to portray this character. The sheet describes the character; it is not an instruction to anyone.

Remove completely:
- Instructions to the AI or the reader: "You are ${name}", "play as", "never speak for ${USER_MARK}", "stay in character", "always respond", rules about length, format, style, asterisks, markdown or third person.
- OOC notes, author's notes, HTML comments, jailbreaks, NSFW switches, system-prompt text, section headers made for the AI.
- The scenario setup and the first message (the narrator's story replaces them). Creator notes and ratings.
- The format of example dialogue (keep only facts about the character found inside it${keep.includes('Example dialogue') ? ', plus one or two short sample lines of how they talk' : ''}).

Rewrite:
- ${USER_MARK} stands for the player's character: keep it exactly as written.
- Turn PList / W++ / bracket lists into plain sentences, keeping every fact.

Keep only these parts: ${keep.join(', ') || 'Appearance, Personality'}. Never invent facts that are not in the card.
${condense ? 'Make it compact: short sentences, about 120 to 220 words.' : 'Keep the original wording as much as possible; do not summarize or shorten what you keep.'}

Answer with the sheet only, as plain text, starting with "${name} —". On the very last line write "ONE LINE:" followed by one sentence that sums the character up.`;
}

function cardDump(character) {
    const fields = [
        ['Description', character.description],
        ['Personality', character.personality],
        ['Scenario', character.scenario],
        ['First message', character.first_mes],
        ['Example dialogue', character.mes_example],
        ['Creator notes', character.data?.creator_notes ?? character.creatorcomment],
    ];
    return fields.filter(([, value]) => str(value).trim()).map(([label, value]) => `## ${label}\n${toMark(replaceNames(str(value).trim(), character.name))}`).join('\n\n');
}

/**
 * Opens the cast sheet editor. Resolves with { sheet, line } when saved, or null.
 * @param {string} avatar
 * @param {{ sheet?: string, line?: string }} current
 * @param {{ profileId?: string }} [options]
 */
export async function editCastSheet(avatar, current = {}, options = {}) {
    const character = characterByAvatar(avatar);
    if (!character) {
        toastr.warning('That character is not in your library any more.');
        return null;
    }
    const name = character.name;
    const lastProfile = extension_settings.homunculusCastSheets?.profileId ?? options.profileId ?? '';
    const profiles = connectionProfiles();
    const wrap = document.createElement('div');
    wrap.className = 'ct-cs';
    wrap.innerHTML = `
        <div class="ct-cs-head"><h3></h3><span class="ct-gs-note">The original card is never changed.</span></div>
        <div class="ct-cs-controls">
            <label class="ct-cs-control">Connection profile
                <select class="text_pole ct-cs-profile"></select>
            </label>
            <fieldset class="ct-cs-keep"><legend>What to keep</legend></fieldset>
            <label class="ct-cs-control">How
                <select class="text_pole ct-cs-how">
                    <option value="condense">Condense (short sheet)</option>
                    <option value="clean">Clean only (keep the wording)</option>
                </select>
            </label>
            <button type="button" class="menu_button ct-cs-generate"><i class="fa-solid fa-wand-magic-sparkles"></i> Make with AI</button>
        </div>
        <div class="ct-cs-panes">
            <div class="ct-cs-pane"><div class="ct-gs-label">From the card</div><pre class="ct-cs-source"></pre></div>
            <div class="ct-cs-pane"><label class="ct-gs-label" for="ct-cs-sheet">Sheet (edit freely)</label><textarea id="ct-cs-sheet" class="text_pole ct-cs-sheet" rows="14"></textarea>
                <label class="ct-gs-label" for="ct-cs-line">One line (used while Offscreen)</label><input id="ct-cs-line" class="text_pole ct-cs-line" type="text"></div>
        </div>`;
    wrap.querySelector('h3').textContent = `Cast sheet: ${name}`;
    const profileSelect = /** @type {HTMLSelectElement} */ (wrap.querySelector('.ct-cs-profile'));
    profileSelect.append(new Option('Current connection', ''));
    for (const profile of profiles) profileSelect.append(new Option(profile.name, profile.id, false, profile.id === lastProfile));
    const keepBox = wrap.querySelector('.ct-cs-keep');
    for (const part of SHEET_PARTS) {
        const label = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = part;
        box.checked = part !== 'Example dialogue';
        label.append(box, document.createTextNode(` ${part}`));
        keepBox.append(label);
    }
    wrap.querySelector('.ct-cs-source').textContent = fromMark(cardDump(character)) || '(This card is empty.)';
    const sheet = /** @type {HTMLTextAreaElement} */ (wrap.querySelector('.ct-cs-sheet'));
    const line = /** @type {HTMLInputElement} */ (wrap.querySelector('.ct-cs-line'));
    sheet.value = current.sheet || defaultSheet(avatar);
    line.value = current.line || oneLine(sheet.value, name);
    const generate = /** @type {HTMLButtonElement} */ (wrap.querySelector('.ct-cs-generate'));
    generate.addEventListener('click', async () => {
        const keep = [...keepBox.querySelectorAll('input:checked')].map(box => /** @type {HTMLInputElement} */ (box).value);
        const condense = /** @type {HTMLSelectElement} */ (wrap.querySelector('.ct-cs-how')).value === 'condense';
        extension_settings.homunculusCastSheets = { profileId: profileSelect.value };
        generate.disabled = true;
        generate.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Working…';
        try {
            const answer = fromMark(await askAi(profileSelect.value, sheetPrompt(name, keep, condense), cardDump(character), 1400));
            const match = answer.match(/\n?\s*ONE LINE:\s*(.+)\s*$/i);
            const body = (match ? answer.slice(0, match.index) : answer).trim();
            if (!body) throw new Error('The AI returned an empty answer.');
            sheet.value = body;
            line.value = (match?.[1] ?? oneLine(body, name)).trim();
        } catch (error) {
            toastr.error(String(error?.message ?? error), 'Could not make the sheet');
        } finally {
            generate.disabled = false;
            generate.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Make with AI';
        }
    });
    const popup = new Popup(wrap, POPUP_TYPE.TEXT, '', {
        okButton: 'Save sheet',
        cancelButton: 'Cancel',
        customButtons: [{ text: 'Use card fields', result: 3, appendAtEnd: false }],
        wide: true,
        large: true,
        leftAlign: true,
        allowVerticalScrolling: true,
    });
    const result = await popup.show();
    if (result === 3) return { sheet: '', line: '' };
    if (result !== POPUP_RESULT.AFFIRMATIVE) return null;
    return { sheet: sheet.value.trim(), line: line.value.trim() };
}

// ───────────────────────── NPC Registry ─────────────────────────

const NPC_SYSTEM = `You keep a registry of named non-player characters (NPCs) for an interactive story. You read ONE narrative passage and report NEW NPCs. You never write story text.

Report a character ONLY if ALL of these are true:
- They have a proper name in the passage (not "the merchant", "a guard", "the innkeeper").
- They actually did something, said something or were dealt with in this passage (a name dropped in passing does not count).
- They are likely to matter again (they gave a task, joined, threatened, helped, made a deal, revealed something).
- They are not in the list of known characters you are given.

Examples: "Elena, the blacksmith's daughter, asks them to find her brother" = YES. "The innkeeper pours a drink" = NO. "They passed the statue of King Aldric" = NO.
When in doubt, leave it out: a wrong entry pollutes the story's memory. Use the exact name from the text and only facts written in the passage. Never invent details.

Answer with JSON only: {"npcs":[{"name":"","role":"","look":"","attitude":"","where":""}]}. Use "" for anything the passage does not say. Answer {"npcs":[]} when there is nobody new.`;

function pendingList() {
    const list = chat_metadata[PENDING_KEY];
    return Array.isArray(list) ? list : [];
}

export function getPendingNpcs() {
    return pendingList();
}

async function npcLorebookName(group, campaign) {
    if (campaign.npc.lorebook && world_names?.includes(campaign.npc.lorebook)) return campaign.npc.lorebook;
    const name = `${group.name} - NPCs`.replace(/[\\/:*?"<>|]/g, '').slice(0, 80);
    if (!world_names?.includes(name)) {
        const response = await fetch('/api/worldinfo/edit', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name, data: { entries: {} } }),
        });
        if (!response.ok) throw new Error(`Could not make the NPC lorebook (${response.status}).`);
        await updateWorldInfoList();
    }
    await saveCampaign(group.id, { npc: { lorebook: name } });
    return name;
}

async function knownNpcNames(campaign) {
    const names = new Set();
    if (campaign.npc.lorebook && world_names?.includes(campaign.npc.lorebook)) {
        const data = await loadWorldInfo(campaign.npc.lorebook);
        for (const entry of Object.values(data?.entries ?? {})) {
            if (entry?.comment) names.add(String(entry.comment).toLowerCase());
            for (const key of entry?.key ?? []) names.add(String(key).toLowerCase());
        }
    }
    return names;
}

function npcContent(npc) {
    const lines = [`${npc.name}${npc.role ? ` — ${npc.role}` : ''}.`];
    if (npc.look) lines.push(`Look: ${npc.look}`);
    if (npc.attitude) lines.push(`Attitude: ${npc.attitude}`);
    if (npc.where) lines.push(`Last seen: ${npc.where}`);
    return lines.join('\n');
}

/** Writes NPCs into the campaign's NPC lorebook as entries keyed by name. */
export async function registerNpcs(group, npcs) {
    if (!npcs.length) return 0;
    const campaign = getCampaign(group);
    const bookName = await npcLorebookName(group, campaign);
    const data = await loadWorldInfo(bookName);
    if (!data) throw new Error('Could not open the NPC lorebook.');
    data.entries ??= {};
    const existing = new Set(Object.values(data.entries).map(entry => String(entry?.comment ?? '').toLowerCase()));
    let added = 0;
    for (const npc of npcs) {
        if (!npc?.name || existing.has(npc.name.toLowerCase())) continue;
        const entry = createWorldInfoEntry(bookName, data);
        if (!entry) continue;
        entry.comment = npc.name;
        entry.key = [npc.name, ...(npc.name.includes(' ') ? [npc.name.split(' ')[0]] : [])];
        entry.content = npcContent(npc);
        entry.constant = false;
        entry.selective = false;
        entry.addMemo = true;
        existing.add(npc.name.toLowerCase());
        added++;
    }
    if (added) await saveWorldInfo(bookName, data, true);
    return added;
}

function cleanNpc(raw) {
    const text = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const name = text(raw?.name);
    if (!name || name.length > 60) return null;
    return { name, role: text(raw?.role), look: text(raw?.look), attitude: text(raw?.attitude), where: text(raw?.where) };
}

/**
 * Reads one reply and finds new NPCs. Returns the list found.
 * @param {number} messageIndex
 * @param {{ manual?: boolean }} [options]
 */
export async function scanForNpcs(messageIndex, { manual = false } = {}) {
    const group = openGroup();
    const message = chat[messageIndex];
    if (!group || !message || message.is_user || message.is_system || !message.mes) return [];
    const campaign = getCampaign(group);
    if (campaign.npc.mode === NPC_MODES.OFF && !manual) return [];
    const known = await knownNpcNames(campaign);
    for (const avatar of group.members ?? []) known.add(characterName(avatar).toLowerCase());
    known.add(String(name1 ?? '').toLowerCase());
    for (const npc of pendingList()) known.add(String(npc.name).toLowerCase());
    const knownList = [...known].filter(Boolean);
    const user = `Known characters (do not report these): ${knownList.join(', ') || '(none)'}\n\nPassage:\n"""\n${message.mes}\n"""`;
    const answer = await askAi(campaign.npc.profileId, NPC_SYSTEM, user, 700);
    const parsed = parseJson(answer);
    const found = (Array.isArray(parsed?.npcs) ? parsed.npcs : []).map(cleanNpc).filter(Boolean)
        .filter(npc => !known.has(npc.name.toLowerCase()));
    if (!found.length) {
        if (manual) toastr.info('No new named NPCs in the last reply.');
        return [];
    }
    if (campaign.npc.mode === NPC_MODES.AUTO) {
        const added = await registerNpcs(group, found);
        if (added) toastr.info(found.map(npc => npc.name).join(', '), `NPC Registry: ${added} added`);
    } else {
        chat_metadata[PENDING_KEY] = [...pendingList(), ...found];
        saveMetadataDebounced();
        toastr.info(`${found.map(npc => npc.name).join(', ')}<br><small>Open "NPCs" above the chat to keep or ignore them.</small>`, 'NPC Registry found someone', { escapeHtml: false });
    }
    notify();
    return found;
}

/** The "Keep or ignore" list for NPCs found in "Ask me" mode. */
export async function reviewPendingNpcs() {
    const group = openGroup();
    const pending = pendingList();
    if (!group || !pending.length) {
        toastr.info('No NPCs waiting.');
        return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'ct-npc-review';
    wrap.innerHTML = '<h3>New NPCs</h3><p class="ct-gs-note">Ticked ones are added to the campaign\'s NPC lorebook. Their entry only comes back when their name is mentioned.</p>';
    const rows = pending.map((npc) => {
        const row = document.createElement('label');
        row.className = 'ct-npc-row';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = true;
        const text = document.createElement('span');
        text.innerHTML = '<b></b><small></small>';
        text.querySelector('b').textContent = npc.name;
        text.querySelector('small').textContent = npcContent(npc).split('\n').slice(0, 3).join(' · ').replace(`${npc.name}`, '').replace(/^ — /, '');
        row.append(box, text);
        wrap.append(row);
        return { npc, box };
    });
    const popup = new Popup(wrap, POPUP_TYPE.TEXT, '', { okButton: 'Keep ticked', cancelButton: 'Later', customButtons: [{ text: 'Ignore all', result: 3 }], leftAlign: true });
    const result = await popup.show();
    if (result === 3) {
        chat_metadata[PENDING_KEY] = [];
    } else if (result === POPUP_RESULT.AFFIRMATIVE) {
        const keep = rows.filter(row => row.box.checked).map(row => row.npc);
        try {
            const added = await registerNpcs(group, keep);
            toastr.success(`${added} NPC${added === 1 ? '' : 's'} added to the lorebook.`);
        } catch (error) {
            toastr.error(String(error?.message ?? error), 'NPC Registry');
            return;
        }
        chat_metadata[PENDING_KEY] = [];
    } else {
        return;
    }
    saveMetadataDebounced();
    notify();
}

// ───────────────────────── World state ─────────────────────────

const MINUTES = { none: 0, minutes: 15, hours: 120, days: 1440 };

export function emptyWorld() {
    return { clock: { day: 1, minutes: 8 * 60 }, location: '', weather: '', party: [], quests: [], inventory: [], factions: [], custom: {} };
}

function normalizeWorld(value) {
    const raw = value && typeof value === 'object' ? value : {};
    const base = emptyWorld();
    const list = (items, map) => (Array.isArray(items) ? items.map(map).filter(Boolean) : []);
    return {
        clock: {
            day: clampInt(raw.clock?.day, 1, 100000, base.clock.day),
            minutes: clampInt(raw.clock?.minutes, 0, 1439, base.clock.minutes),
        },
        location: str(raw.location).slice(0, 300),
        weather: str(raw.weather).slice(0, 200),
        party: list(raw.party, item => (str(item?.name).trim() ? { name: str(item.name).trim(), status: str(item.status).trim() } : null)),
        quests: list(raw.quests, item => (str(item?.title).trim() ? { title: str(item.title).trim(), status: ['active', 'completed', 'failed'].includes(item.status) ? item.status : 'active', note: str(item.note).trim() } : null)),
        inventory: list(raw.inventory, item => (typeof item === 'string' && item.trim() ? item.trim() : null)),
        factions: list(raw.factions, item => (str(item?.name).trim() ? { name: str(item.name).trim(), standing: str(item.standing).trim() } : null)),
        custom: raw.custom && typeof raw.custom === 'object' ? Object.fromEntries(Object.entries(raw.custom).map(([k, v]) => [k, String(v ?? '')])) : {},
    };
}

function messageWorld(message) {
    if (!message) return undefined;
    if (typeof message.swipe_id === 'number' && Array.isArray(message.swipe_info)) {
        const swipeExtra = message.swipe_info[message.swipe_id]?.extra;
        if (swipeExtra && Object.hasOwn(swipeExtra, WORLD_KEY)) return swipeExtra[WORLD_KEY];
    }
    return message.extra?.[WORLD_KEY];
}

function setMessageWorld(message, world) {
    message.extra ??= {};
    message.extra[WORLD_KEY] = world;
    if (typeof message.swipe_id === 'number' && Array.isArray(message.swipe_info) && message.swipe_info[message.swipe_id]) {
        message.swipe_info[message.swipe_id].extra ??= {};
        message.swipe_info[message.swipe_id].extra[WORLD_KEY] = world;
    }
}

/** The world as of the latest message that has one, and that message's index (-1: none yet). */
export function currentWorld(upTo = chat.length - 1) {
    for (let i = Math.min(upTo, chat.length - 1); i >= 0; i--) {
        const saved = messageWorld(chat[i]);
        if (saved) return { world: normalizeWorld(saved), index: i };
    }
    return { world: emptyWorld(), index: -1 };
}

export function clockText(clock) {
    const h = Math.floor(clock.minutes / 60);
    const m = clock.minutes % 60;
    const part = h < 5 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';
    return `Day ${clock.day}, ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} (${part})`;
}

function addTime(clock, step) {
    const total = clock.minutes + (MINUTES[step] ?? 0);
    return { day: clock.day + Math.floor(total / 1440), minutes: total % 1440 };
}

function enabledModules(campaign) {
    return WORLD_MODULES.filter(module => campaign.world.modules[module.id]?.on);
}

function worldSchema(campaign) {
    const parts = [];
    const on = new Set(enabledModules(campaign).map(module => module.id));
    if (on.has('time')) parts.push('"timePassed": one of "none" (a few lines of talk or a quick action), "minutes" (a long talk, a search, a short fight), "hours" (travel, a meal, waiting), "days" (sleeping, long journeys, explicit time skips). When unsure between two, pick the shorter.');
    if (on.has('location')) parts.push('"location": where the scene is now, as a short name (keep the old one if nobody moved).');
    if (on.has('weather')) parts.push('"weather": a few words, only if the passage shows it; otherwise keep the old value.');
    if (on.has('party')) parts.push('"party": [{"name","status"}] for the protagonist\'s companions; status is a few words (wounded, tired, fine).');
    if (on.has('quests')) parts.push('"quests": [{"title","status","note"}], the WHOLE list. status is "active", "completed" or "failed". Add a quest only when a task or goal is clearly given or taken on. Mark old ones completed or failed when the passage resolves them.');
    if (on.has('inventory')) parts.push('"inventory": ["item"], the WHOLE list of notable items the protagonist carries. Add only items explicitly taken, bought or given; remove items lost, used up or given away.');
    if (on.has('factions')) parts.push('"factions": [{"name","standing"}] for named groups the protagonist has dealt with; standing is a few words.');
    for (const field of campaign.world.custom) parts.push(`"custom"."${field.name}": a short value for "${field.name}" (keep the old one unless the passage changes it).`);
    return parts;
}

const WORLD_SYSTEM = `You keep the world state of an interactive story up to date. You read the previous state and the latest exchange, and answer with the new state. You never write story text.
Rules: only record what ACTUALLY happened in the passage, never what might happen. Keep old values that the passage does not change. Use the names used in the text. When in doubt, change nothing. Answer with one JSON object only, with exactly the fields asked for.`;

/**
 * Updates the world after a reply and saves it in that message.
 * @param {number} messageIndex
 */
export async function updateWorld(messageIndex = chat.length - 1) {
    const group = openGroup();
    const message = chat[messageIndex];
    if (!group || !message || message.is_user || message.is_system) return null;
    const campaign = getCampaign(group);
    if (!campaign.world.enabled || (!enabledModules(campaign).length && !campaign.world.custom.length)) return null;
    const { world: before } = currentWorld(messageIndex - 1);
    const previousUser = [...chat.slice(0, messageIndex)].reverse().find(item => item.is_user)?.mes ?? '';
    const fields = worldSchema(campaign);
    const state = { ...before, clock: undefined, time: clockText(before.clock) };
    const user = `Fields to answer:\n- ${fields.join('\n- ')}\n\nPrevious state:\n${JSON.stringify(state, null, 1)}\n\nLatest player input:\n"""\n${previousUser}\n"""\n\nLatest narration:\n"""\n${message.mes}\n"""`;
    const answer = await askAi(campaign.world.profileId, WORLD_SYSTEM, user, 900);
    const parsed = parseJson(answer);
    if (!parsed) throw new Error('The AI did not answer with a world state.');
    const on = new Set(enabledModules(campaign).map(module => module.id));
    const next = normalizeWorld(before);
    if (on.has('time')) next.clock = addTime(before.clock, String(parsed.timePassed ?? 'none').toLowerCase());
    if (on.has('location') && typeof parsed.location === 'string' && parsed.location.trim()) next.location = parsed.location.trim();
    if (on.has('weather') && typeof parsed.weather === 'string' && parsed.weather.trim()) next.weather = parsed.weather.trim();
    const merged = normalizeWorld({ ...next, ...(on.has('party') && Array.isArray(parsed.party) ? { party: parsed.party } : {}), ...(on.has('quests') && Array.isArray(parsed.quests) ? { quests: parsed.quests } : {}), ...(on.has('inventory') && Array.isArray(parsed.inventory) ? { inventory: parsed.inventory } : {}), ...(on.has('factions') && Array.isArray(parsed.factions) ? { factions: parsed.factions } : {}) });
    merged.clock = next.clock;
    if (parsed.custom && typeof parsed.custom === 'object') {
        for (const field of campaign.world.custom) {
            if (typeof parsed.custom[field.name] === 'string') merged.custom[field.name] = parsed.custom[field.name];
        }
    }
    setMessageWorld(message, merged);
    saveChatDebounced();
    notify();
    return merged;
}

/** Saves a world edited by hand into the latest message. */
export function saveWorldByHand(world) {
    const index = chat.length - 1;
    if (index < 0) {
        toastr.info('Send or receive a message first; the world state is saved in a message.');
        return false;
    }
    setMessageWorld(chat[index], normalizeWorld(world));
    saveChatDebounced();
    notify();
    return true;
}

function moduleLines(world, id) {
    switch (id) {
        case 'time': return [`Time: ${clockText(world.clock)}`];
        case 'location': return world.location ? [`Location: ${world.location}`] : [];
        case 'weather': return world.weather ? [`Weather: ${world.weather}`] : [];
        case 'party': return world.party.length ? [`Party: ${world.party.map(member => `${member.name}${member.status ? ` (${member.status})` : ''}`).join('; ')}`] : [];
        case 'quests': {
            const active = world.quests.filter(quest => quest.status === 'active');
            return active.length ? [`Active quests: ${active.map(quest => `${quest.title}${quest.note ? ` (${quest.note})` : ''}`).join('; ')}`] : [];
        }
        case 'inventory': return world.inventory.length ? [`Inventory: ${world.inventory.join(', ')}`] : [];
        case 'factions': return world.factions.length ? [`Factions: ${world.factions.map(faction => `${faction.name}${faction.standing ? ` (${faction.standing})` : ''}`).join('; ')}`] : [];
        default: return [];
    }
}

/** The world state block for the prompt: only the modules that should go in right now. */
export function worldText(group = openGroup()) {
    if (!group) return '';
    const campaign = getCampaign(group);
    if (!campaign.world.enabled) return '';
    const { world, index } = currentWorld();
    if (index === -1) return '';
    const recent = chat.slice(-3).map(item => String(item?.mes ?? '')).join('\n').toLowerCase();
    const isRelevant = (words) => words.some(word => recent.includes(word));
    const lines = [];
    for (const module of enabledModules(campaign)) {
        const inject = campaign.world.modules[module.id].inject;
        if (inject === INJECT.PANEL) continue;
        let words = module.words;
        if (module.id === 'factions') words = [...words, ...world.factions.map(faction => faction.name.toLowerCase())];
        if (module.id === 'inventory') words = [...words, ...world.inventory.map(item => item.toLowerCase().split(' ').pop())];
        if (module.id === 'quests') words = [...words, ...world.quests.map(quest => quest.title.toLowerCase())];
        if (inject === INJECT.RELEVANT && !isRelevant(words)) continue;
        lines.push(...moduleLines(world, module.id));
    }
    for (const field of campaign.world.custom) {
        const value = world.custom[field.name];
        if (!value || field.inject === INJECT.PANEL) continue;
        if (field.inject === INJECT.RELEVANT && !recent.includes(field.name.toLowerCase())) continue;
        lines.push(`${field.name}: ${value}`);
    }
    return lines.length ? `[World state]\n${lines.join('\n')}` : '';
}

/** The world state editor (the "World" button above the chat). */
export async function openWorldPanel() {
    const group = openGroup();
    if (!group) return;
    const campaign = getCampaign(group);
    const { world } = currentWorld();
    const on = new Set(enabledModules(campaign).map(module => module.id));
    const wrap = document.createElement('div');
    wrap.className = 'ct-world';
    const add = (label, value, rows, hint = '') => {
        const field = document.createElement('label');
        field.className = 'ct-world-field';
        field.append(document.createTextNode(label));
        const input = document.createElement(rows > 1 ? 'textarea' : 'input');
        input.className = 'text_pole';
        if (rows > 1) /** @type {HTMLTextAreaElement} */ (input).rows = rows;
        input.value = value;
        if (hint) input.placeholder = hint;
        field.append(input);
        wrap.append(field);
        return input;
    };
    const head = document.createElement('div');
    head.className = 'ct-world-head';
    head.innerHTML = '<h3>World state</h3><span class="ct-gs-note">Saved in the latest message, so swipes and branches keep their own world.</span>';
    wrap.append(head);
    const inputs = {};
    if (on.has('time')) {
        const row = document.createElement('div');
        row.className = 'ct-world-row';
        wrap.append(row);
        const day = add('Day', String(world.clock.day), 1);
        const time = add('Time (HH:MM)', `${String(Math.floor(world.clock.minutes / 60)).padStart(2, '0')}:${String(world.clock.minutes % 60).padStart(2, '0')}`, 1);
        row.append(day.parentElement, time.parentElement);
        inputs.day = day;
        inputs.time = time;
    }
    if (on.has('location')) inputs.location = add('Location', world.location, 1);
    if (on.has('weather')) inputs.weather = add('Weather', world.weather, 1);
    if (on.has('party')) inputs.party = add('Party (one per line, "Name: status")', world.party.map(item => `${item.name}: ${item.status}`).join('\n'), 3);
    if (on.has('quests')) inputs.quests = add('Quests (one per line, "[active] Title: note", or [completed] / [failed])', world.quests.map(item => `[${item.status}] ${item.title}${item.note ? `: ${item.note}` : ''}`).join('\n'), 4);
    if (on.has('inventory')) inputs.inventory = add('Inventory (one item per line)', world.inventory.join('\n'), 4);
    if (on.has('factions')) inputs.factions = add('Factions (one per line, "Name: standing")', world.factions.map(item => `${item.name}: ${item.standing}`).join('\n'), 3);
    const customInputs = campaign.world.custom.map(field => [field.name, add(field.name, world.custom[field.name] ?? '', 1)]);
    const popup = new Popup(wrap, POPUP_TYPE.TEXT, '', {
        okButton: 'Save',
        cancelButton: 'Close',
        customButtons: [{ text: 'Update from the last reply', result: 3 }],
        wide: true,
        leftAlign: true,
        allowVerticalScrolling: true,
    });
    const result = await popup.show();
    if (result === 3) {
        const index = [...chat.keys()].reverse().find(i => !chat[i].is_user && !chat[i].is_system) ?? -1;
        if (index === -1) return;
        try {
            await updateWorld(index);
            toastr.success('World state updated.');
        } catch (error) {
            toastr.error(String(error?.message ?? error), 'World state');
        }
        return;
    }
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;
    const lines = value => String(value ?? '').split('\n').map(x => x.trim()).filter(Boolean);
    const pair = (text) => {
        const at = text.indexOf(':');
        return at === -1 ? [text, ''] : [text.slice(0, at).trim(), text.slice(at + 1).trim()];
    };
    const next = normalizeWorld(world);
    if (inputs.day) next.clock.day = clampInt(inputs.day.value, 1, 100000, next.clock.day);
    if (inputs.time) {
        const [h, m] = String(inputs.time.value).split(':').map(Number);
        if (Number.isFinite(h)) next.clock.minutes = clampInt(h * 60 + (Number.isFinite(m) ? m : 0), 0, 1439, next.clock.minutes);
    }
    if (inputs.location) next.location = inputs.location.value.trim();
    if (inputs.weather) next.weather = inputs.weather.value.trim();
    if (inputs.party) next.party = lines(inputs.party.value).map(pair).map(([name, status]) => ({ name, status }));
    if (inputs.quests) {
        next.quests = lines(inputs.quests.value).map((text) => {
            const status = text.match(/^\[(active|completed|failed)\]\s*/i);
            const rest = status ? text.slice(status[0].length) : text;
            const [title, note] = pair(rest);
            return { title, note, status: status ? status[1].toLowerCase() : 'active' };
        });
    }
    if (inputs.inventory) next.inventory = lines(inputs.inventory.value);
    if (inputs.factions) next.factions = lines(inputs.factions.value).map(pair).map(([name, standing]) => ({ name, standing }));
    for (const [name, input] of customInputs) next.custom[name] = input.value.trim();
    if (saveWorldByHand(next)) toastr.success('World state saved.');
}

// ───────────────────────── Prompt injection ─────────────────────────

function applyPrompts() {
    const group = openGroup();
    const campaign = group ? getCampaign(group) : null;
    const cast = campaign && campaign.castPlacement === 'prompt' ? castText(group) : '';
    setExtensionPrompt(CAST_PROMPT_KEY, cast, extension_prompt_types.IN_PROMPT, 0, false);
    setExtensionPrompt(WORLD_PROMPT_KEY, campaign ? worldText(group) : '', extension_prompt_types.IN_PROMPT, 0, false);
}

function registerMacros() {
    const context = globalThis.SillyTavern?.getContext?.();
    const handlers = {
        cast: ['The cast sheets of the open Narrated group (Group Studio).', () => castText()],
        worldState: ['The world state of the open group chat (Group Studio).', () => worldText()],
    };
    for (const [name, [description, handler]] of Object.entries(handlers)) {
        try {
            context?.registerMacro?.(name, handler, description);
        } catch {
            // legacy macro engine missing
        }
        try {
            context?.macros?.register?.(name, { handler, description, returns: description, exampleUsage: `{{${name}}}` });
        } catch {
            // new macro engine missing
        }
    }
}

// ───────────────────────── After each reply ─────────────────────────

let busy = false;

async function afterReply(messageIndex, type) {
    if (['quiet', 'impersonate', 'first_message'].includes(String(type))) return;
    const group = openGroup();
    if (!group || busy) return;
    const campaign = getCampaign(group);
    const message = chat[messageIndex];
    if (!message || message.is_user || message.is_system) return;
    // Wait for post-generation agents to finish rewriting the reply.
    await new Promise(resolve => setTimeout(resolve, 1500));
    if (chat[messageIndex] !== message) return;
    busy = true;
    try {
        if (campaign.world.enabled) {
            const { index } = currentWorld(messageIndex - 1);
            const repliesSince = chat.slice(index + 1, messageIndex + 1).filter(item => !item.is_user && !item.is_system).length;
            if (index === -1 || repliesSince >= campaign.world.every) {
                await updateWorld(messageIndex).catch(error => console.warn('[Homunculus] World state:', error));
            }
        }
        if (campaign.npc.mode !== NPC_MODES.OFF) {
            await scanForNpcs(messageIndex).catch(error => console.warn('[Homunculus] NPC Registry:', error));
        }
    } finally {
        busy = false;
    }
}

/** The "Find NPCs" button: reads the last reply now, in any mode. */
export async function scanLastReply() {
    const index = [...chat.keys()].reverse().find(i => !chat[i].is_user && !chat[i].is_system) ?? -1;
    if (index === -1) {
        toastr.info('There is no reply to read yet.');
        return;
    }
    try {
        await scanForNpcs(index, { manual: true });
    } catch (error) {
        toastr.error(String(error?.message ?? error), 'NPC Registry');
    }
}

/** Narrated groups greet only with the narrator's first message. */
export function getGreetingMembers(group, members) {
    const campaign = getCampaign(group);
    if (campaign.mode !== 'narrated') return members;
    const narrator = narratorAvatar(campaign);
    return members.filter(avatar => avatar === narrator);
}

/** Lorebooks this file adds to the scan while the group's chat is open (the NPC lorebook). */
export function getLorebooks() {
    const group = openGroup();
    if (!group) return [];
    const campaign = getCampaign(group);
    return campaign.npc.mode !== NPC_MODES.OFF && campaign.npc.lorebook && world_names?.includes(campaign.npc.lorebook) ? [campaign.npc.lorebook] : [];
}

function init() {
    for (const eventName of [event_types.GENERATION_STARTED, event_types.CHAT_CHANGED, event_types.GROUP_UPDATED].filter(Boolean)) {
        eventSource.on(eventName, applyPrompts);
    }
    eventSource.on(event_types.MESSAGE_RECEIVED, (messageIndex, type) => void afterReply(Number(messageIndex), type));
    eventSource.on(event_types.APP_READY, registerMacros);
    document.addEventListener(CAMPAIGN_CHANGED_EVENT, applyPrompts);
}

init();

globalThis.HomunculusGroupCampaign = {
    getCampaign,
    getNarratorChid,
    getGreetingMembers,
    castText,
    worldText,
    currentWorld,
    getLorebooks,
    getPendingNpcs,
    reviewPendingNpcs,
    scanLastReply,
    openWorldPanel,
    hasCampaignTools,
};
