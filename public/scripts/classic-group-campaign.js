// Classic UI fork: Narrated mode and cast sheets for groups (Group Studio).
//
// Everything lives in group.homunculus_campaign (see getCampaign). It works whenever one of the
// group's chats is open; it does not depend on "group mode" (that is the profile in
// classic-group-profile.js: preset, persona, agents, lorebooks).
//
// - Narrated mode: only the narrator replies on its own (group-chats.js asks getNarratorChid). The
//   other members are the cast: they never speak by themselves (they still can with the member bar).
//   Their sheets go into the prompt as one block (In scene: whole sheet, Offscreen: one line, Off:
//   nothing), or only where the preset writes {{cast}}. The group nudge of the prompt ("write only
//   as {{char}}") is swapped for the narrator's turn instruction (openai.js asks getGroupNudge).
// - Cast sheets: a character card cleaned of instructions, scenario and other meta text, made by an
//   AI with a connection profile the user picks, then reviewed. The card itself is never changed.
// - World state and the characters in the scene are In-Chat Agents (Scene: World / Scene:
//   Characters templates) shown in the Scene panel, see classic-scene.js.
//
// The cast sheet prompt is adapted from ideas in Aventuras (https://github.com/AventurasTeam/Aventuras,
// AGPL-3.0); see CREDITS.md.

import {
    eventSource,
    event_types,
    characters,
    getCharacters,
    getRequestHeaders,
    setExtensionPrompt,
    extension_prompt_types,
} from '../script.js';
import { extension_settings } from './extensions.js';
import { groups, selected_group, editGroup } from './group-chats.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from './popup.js';

const CAMPAIGN_KEY = 'homunculus_campaign';
export const CAMPAIGN_CHANGED_EVENT = 'homunculus:group-campaign-changed';
const CAST_PROMPT_KEY = 'homunculus_cast';

export const CAST_STATES = Object.freeze({ SCENE: 'scene', OFFSCREEN: 'offscreen', OFF: 'off' });

export const ROLES = Object.freeze(['player', 'coauthor', 'author']);
export const AUTONOMY = Object.freeze(['low', 'medium', 'high']);
const ROLE_PROMPT_KEY = 'homunculus_role';

/** Co-author: Daniel's own prompt, written for SillyTavern role-play (directions for {{user}}, spread over the reply). */
export const DEFAULT_COAUTHOR_PROMPT = `<author_vs_protagonist>
The author directs; {{user}} is a character you write.
- {{user}}'s messages are authorial directions, not literal dialogue or actions. Treat every message from {{user}} as an instruction describing what {{user}}'s character does, says, or intends — not as text to be repeated verbatim.
When a direction is given, you must always incorporate it into your reply by writing {{user}}'s character performing it — translated into their own voice, personality, speech patterns, and mannerisms, complete with narration (tone, expression, body language, pacing) as if you were novelizing the moment.
Example: if the author writes "How are you?" as a direction, do not output that line as-is. Instead, write {{user}}'s character asking that question in a way that reflects who they are — their manner of speaking, their current emotional state, their body language — folded into full narrative prose, not just a plain dialogue tag.
Never skip, compress, or ignore a direction. Every direction given must appear, transformed, in your response.
- {{user}} is a fictional character with their own personality, not a stand-in for the author
- The author may give instructions like "have them argue" or "she discovers the truth"—execute these as narrative
- Continue directly from the previous beat—no recaps or preamble
- Add sensory detail and subtext to bring directions to life
- You control ALL characters equally, including {{user}} write their actions, dialogue, thoughts, and decisions
- Don't dump User's ({{user}}) dialogue's / directions all at once in your turn, spread the dialogues and my actions in a natural order throughout the reply. You are free do add more dialogue lines for {{user}} that fit the scene.
Spread {{user}}'s directions across the reply instead of front-loading them.
- Break each direction into beats and interleave them with NPC reactions, narration, and the environment, so the NPC reacts to each beat as it happens, not to everything at once.
- Don't open with all of {{user}}'s dialogue or actions in one block.
- You may add small in-character lines or gestures for {{user}} that fit the scene.
- Natural pacing: Weave {{user}}'s actions and dialogue throughout the reply in chronological order. Don't dump the entire input before NPCs react; let interactions unfold beat by beat, with NPCs responding naturally to each action or line before the next. You may add fitting dialogue for {{user}} to maintain a natural flow. 
- Multi-part inputs: When a direction contains multiple actions or dialogue lines, unfold them naturally in sequence, interweaving NPC reactions and responses between beats. Preserve the intended order without dumping the entire input before others can react.
</author_vs_protagonist>


<input_expansion>
Treat every author input, even a single line of dialogue or one simple direction, as the starting point of an ongoing scene, never as a self-contained one-shot to execute and conclude. Novelize and expand upon it, bringing {{user}}'s character to life through natural dialogue, actions, reactions, and interactions with the environment and other characters.

Let the scene develop organically beyond the initial input. {{user}}'s character may be interrupted, interrupt others, answer questions, initiate conversations, react to unexpected events, or speak again when the situation calls for it. Weave their behavior into the unfolding scene rather than treating their input as the entirety of their contribution.

Preserve the author's intent while allowing natural improvisation. The input establishes what happens or what the character intends to communicate; it does not limit the scene to that single beat. Continue the interaction naturally, with realistic pacing, character-driven dialogue, and NPC responses that create opportunities for further exchanges.
</input_expansion>`;

/** Author: there is no {{user}} in the story. Adapted from the "creative-writing" prompt of Aventuras (AGPL-3.0, see CREDITS.md). */
export const DEFAULT_AUTHOR_PROMPT = `<author_mode>
The person writing to you is the AUTHOR of this story, not a character in it. The author is outside the story, like a god: there is no {{user}} character in the scene. Never write {{user}} as a person in the story, never address the author as "you" inside the narration, and never let characters notice or talk to the author.
- The author's messages are directions, not story text: "have them argue", "Mira finds the letter", "skip to the next morning". Turn every direction into full narrative prose without repeating it word for word, and never skip or water down a direction.
- When the author writes a line in quotes or as a character ("Mira: ..."), write that character saying or doing it in their own voice, folded into the scene.
- You control every character equally. Each one has their own goals, fears, knowledge and habits, and acts on them. They do not know what the author knows, and they do not wait for permission.
- Continue directly from the previous beat. No recaps, no questions to the author, no meta commentary.
- Treat every direction as the start of a scene that keeps developing, not as a one-shot to execute and wrap up.
</author_mode>`;

const AUTONOMY_TEXT = {
    low: 'Character autonomy: LOW. The characters wait for the author\'s directions and do not start big moves on their own.',
    medium: 'Character autonomy: MEDIUM. The characters follow the author\'s directions and fill the gaps with their own goals and choices.',
    high: 'Character autonomy: HIGH. The characters chase their own goals, even against what the author seems to want. The author steers by nudging, not by commanding.',
};
const IDLE_TEXT = {
    act: 'When the latest message is not a new direction (the author sent nothing), the characters act on their own: each one pursues their goals and the scene moves forward.',
    continue: 'When the latest message is not a new direction (the author sent nothing), simply continue the scene from where it stopped.',
};
const ROLE_NUDGES = {
    coauthor: '[Write the next reply as {{char}}. The user\'s messages are directions: you also write {{user}}\'s actions and words as the latest direction describes, in {{user}}\'s own voice. Do not write for the other members of the group.]',
    author: '[Write the next reply as {{char}}. The user is the author, outside the story: follow the latest direction and never write the author as a character. Do not write for the other members of the group.]',
};

export const DEFAULT_TURN_PROMPT = '[Narrated group: write the next reply as {{char}}, the narrator. Narrate the scene and voice every character and NPC of the cast as the story needs (dialogue, actions, thoughts). The cast are not separate speakers and never reply on their own. Do not start the reply with a name prefix.]';

// ───────────────────────── Data ─────────────────────────

const str = value => (typeof value === 'string' ? value : '');

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
    return {
        mode: raw.mode === 'narrated' ? 'narrated' : 'ensemble',
        narrator: {
            type: narrator.type === 'builtin' ? 'builtin' : 'card',
            avatar: str(narrator.avatar),
            style: str(narrator.style),
            builtinAvatar: str(narrator.builtinAvatar),
            turnPrompt: str(narrator.turnPrompt),
        },
        cast,
        castPlacement: raw.castPlacement === 'macro' ? 'macro' : 'prompt',
        role: ROLES.includes(raw.role) ? raw.role : 'player',
        roleText: {
            coauthor: str(raw.roleText?.coauthor),
            author: str(raw.roleText?.author),
        },
        // false: the role prompt is already in the user's preset, so only the extra lines are sent.
        roleSend: raw.roleSend !== false,
        protagonist: str(raw.protagonist),
        idle: raw.idle === 'continue' ? 'continue' : 'act',
        autonomy: AUTONOMY.includes(raw.autonomy) ? raw.autonomy : 'medium',
        previousGenerationMode: Number.isInteger(raw.previousGenerationMode) ? raw.previousGenerationMode : null,
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
        roleText: { ...current.roleText, ...(patch.roleText ?? {}) },
    });
    group[CAMPAIGN_KEY] = next;
    await editGroup(group.id, true, false);
    notify();
    return next;
}

export function hasCampaignTools(campaign) {
    return campaign.mode === 'narrated';
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

export async function askAi(profileId, system, user, maxTokens = 900) {
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

/**
 * The turn instruction that replaces the prompt's group nudge ("write only as {{char}}") while a group's
 * chat is open: the narrator's in a Narrated group; in an Ensemble group with the Co-author or Author
 * role, a version that lets {{char}} follow directions (and write {{user}} for a Co-author).
 */
export function getGroupNudge() {
    const group = openGroup();
    if (!group) return '';
    const campaign = getCampaign(group);
    if (campaign.mode === 'narrated' && narratorAvatar(campaign)) return campaign.narrator.turnPrompt.trim() || DEFAULT_TURN_PROMPT;
    return ROLE_NUDGES[campaign.role] ?? '';
}

// ───────────────────────── Roles (Player / Co-author / Author) ─────────────────────────

export function defaultRolePrompt(role) {
    return role === 'coauthor' ? DEFAULT_COAUTHOR_PROMPT : role === 'author' ? DEFAULT_AUTHOR_PROMPT : '';
}

/** The role instructions sent before each reply in a group's chat (empty for Player). */
export function roleText(group = openGroup()) {
    if (!group) return '';
    const campaign = getCampaign(group);
    if (campaign.role === 'player') return '';
    const lines = [campaign.roleSend ? (campaign.roleText[campaign.role].trim() || defaultRolePrompt(campaign.role)) : ''];
    if (campaign.role === 'author' && campaign.protagonist) {
        const name = characterName(campaign.protagonist);
        if (name) lines.push(`Main character: ${name}. A character like any other, written by you; not the author.`);
    }
    lines.push(AUTONOMY_TEXT[campaign.autonomy], IDLE_TEXT[campaign.idle]);
    return lines.filter(Boolean).join('\n');
}

/** 'player' | 'coauthor' | 'author' for the open group chat ('player' outside groups). */
export function openRole() {
    const group = openGroup();
    return group ? getCampaign(group).role : 'player';
}

// ───────────────────────── Let them act / auto-play ─────────────────────────

const autoplay = { running: false, stop: false, left: 0 };

export function autoplayState() {
    return { running: autoplay.running, left: autoplay.left };
}

/**
 * Lets the characters act without a direction, for a number of turns (the role instructions say what
 * an empty turn means). Stops on stopAutoplay(), a chat change or a failed reply.
 * @param {number} turns
 */
export async function letThemAct(turns = 1) {
    if (autoplay.running) return;
    const box = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('send_textarea'));
    if (box && box.value.trim()) {
        toastr.info('Send or clear your message first: "Let them act" runs a turn without a direction.');
        return;
    }
    const context = globalThis.SillyTavern?.getContext?.();
    if (!context?.executeSlashCommandsWithOptions) return;
    const chatId = context.getCurrentChatId?.();
    autoplay.running = true;
    autoplay.stop = false;
    autoplay.left = Math.max(1, Number(turns) || 1);
    notify();
    try {
        while (autoplay.left > 0 && !autoplay.stop) {
            const before = context.chat?.length ?? 0;
            await context.executeSlashCommandsWithOptions('/trigger await=true', { handleExecutionErrors: true });
            autoplay.left--;
            notify();
            if (context.getCurrentChatId?.() !== chatId || (context.chat?.length ?? 0) <= before) break;
            if (autoplay.left > 0 && !autoplay.stop) await new Promise(resolve => setTimeout(resolve, 600));
        }
    } finally {
        autoplay.running = false;
        autoplay.left = 0;
        notify();
    }
}

export function stopAutoplay() {
    if (!autoplay.running) return;
    autoplay.stop = true;
    globalThis.SillyTavern?.getContext?.()?.stopGeneration?.();
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

// ───────────────────────── Prompt injection ─────────────────────────

function applyPrompts() {
    const group = openGroup();
    const campaign = group ? getCampaign(group) : null;
    const cast = campaign && campaign.castPlacement === 'prompt' ? castText(group) : '';
    setExtensionPrompt(CAST_PROMPT_KEY, cast, extension_prompt_types.IN_PROMPT, 0, false);
    setExtensionPrompt(ROLE_PROMPT_KEY, roleText(group), extension_prompt_types.IN_PROMPT, 0, false);
    const role = campaign?.role ?? 'player';
    document.body.classList.toggle('ct-role-coauthor', role === 'coauthor');
    document.body.classList.toggle('ct-role-author', role === 'author');
}

function registerMacros() {
    const context = globalThis.SillyTavern?.getContext?.();
    const handlers = {
        cast: ['The cast sheets of the open Narrated group (Group Studio).', () => castText()],
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

/** Narrated groups greet only with the narrator's first message. */
export function getGreetingMembers(group, members) {
    const campaign = getCampaign(group);
    if (campaign.mode !== 'narrated') return members;
    const narrator = narratorAvatar(campaign);
    return members.filter(avatar => avatar === narrator);
}

function init() {
    for (const eventName of [event_types.GENERATION_STARTED, event_types.CHAT_CHANGED, event_types.GROUP_UPDATED].filter(Boolean)) {
        eventSource.on(eventName, applyPrompts);
    }
    eventSource.on(event_types.APP_READY, registerMacros);
    document.addEventListener(CAMPAIGN_CHANGED_EVENT, applyPrompts);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        if (autoplay.running) stopAutoplay();
    });
}

init();

globalThis.HomunculusGroupCampaign = {
    getCampaign,
    getNarratorChid,
    getGreetingMembers,
    getGroupNudge,
    castText,
    hasCampaignTools,
    roleText,
    openRole,
    letThemAct,
    stopAutoplay,
    autoplayState,
};
