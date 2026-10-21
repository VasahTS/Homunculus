// Classic UI fork: where Homunculus prompt blocks go.
//
// Every text the fork adds to the prompt (role instructions, story style, the author's plan, the
// current scene, the cast sheets) goes through set(id, text). This module decides where it lands,
// using the user's choice per block (Group Studio → Prompts):
// - 'main': appended to the end of the preset's Main Prompt (SillyTavern's "in prompt" extension slot);
// - 'chat': inserted in the chat at a depth (0 = after the last message, 1 = before it…), with a role;
// - 'macro': never added by itself; it only appears where the preset writes its macro.
// Each block is wrapped in a tag (<story_style>…</story_style>) so the AI sees where it starts and ends.
// A block is not added by itself when the active preset already uses its macro, so it never appears twice.

import { eventSource, event_types, setExtensionPrompt, extension_prompt_types, extension_prompt_roles, saveSettingsDebounced } from '../script.js';
import { extension_settings } from './extensions.js';
import { oai_settings, promptManager } from './openai.js';
import { power_user } from './power-user.js';

export const PROMPTS_CHANGED_EVENT = 'homunculus:prompt-blocks-changed';

/** The blocks, in the order shown in the Group Studio. key = the extension prompt key. */
export const BLOCKS = Object.freeze([
    {
        id: 'role', key: 'homunculus_role', tag: 'story_role', macro: 'homunculusRole', label: 'Role instructions',
        about: 'The Co-author or Author instructions, the main character, character autonomy and what an empty turn means (Setup → Your role).',
        placement: { mode: 'macro', depth: 4, role: 'system' },
        section: { after: 'main' },
    },
    {
        id: 'style', key: 'homunculus_style', tag: 'story_style', macro: 'storyStyle', label: 'Story style',
        about: 'Perspective, tense, reply length, tone and your own variables (Setup → Story style).',
        placement: { mode: 'macro', depth: 1, role: 'system' },
        section: { after: 'chatHistory' },
    },
    {
        id: 'beats', key: 'homunculus_beats', tag: 'author_plan', macro: 'authorPlan', label: 'The author\'s plan',
        about: 'Your planned beats marked "Steer toward" or "Not yet" (Scene panel → Plot).',
        placement: { mode: 'macro', depth: 1, role: 'system' },
        section: { after: 'chatHistory' },
    },
    {
        id: 'scene', key: 'homunculus_scene', tag: 'current_scene', macro: 'currentScene', label: 'Current scene',
        about: 'Who is in the scene and how they look, the world state and the plot notes (the Scene trackers).',
        placement: { mode: 'macro', depth: 4, role: 'system' },
        section: { after: 'scenario' },
    },
    {
        id: 'cast', key: 'homunculus_cast', tag: 'cast_sheets', macro: 'cast', label: 'Cast sheets',
        about: 'The sheets of the cast in a Narrated group (Cast tab).',
        placement: { mode: 'macro', depth: 4, role: 'system' },
        section: { after: 'scenario' },
    },
]);

/** Prompt Manager identifier of the preset section that holds a block's macro (also used by default/…/Default.json). */
export const sectionId = id => `homunculus-${id}`;
// Other macros that also put a block's text in the prompt ({{pov}}, {{tense}}… for the Story style).
const extraMacros = new Map();

const ROLES = { system: extension_prompt_roles.SYSTEM, user: extension_prompt_roles.USER, assistant: extension_prompt_roles.ASSISTANT };
const texts = new Map();

const str = value => (typeof value === 'string' ? value : value == null ? '' : String(value));
const byId = id => BLOCKS.find(block => block.id === id) ?? null;

// ───────────────────────── Settings ─────────────────────────

const SETTINGS_VERSION = 2;

function settings() {
    extension_settings.homunculusPrompts ??= {};
    const saved = extension_settings.homunculusPrompts;
    // v2: the default became "only where the preset has the macro"; places picked under v1 are dropped once.
    if ((saved.version ?? 1) < SETTINGS_VERSION) {
        for (const block of BLOCKS) delete saved[block.id];
        saved.version = SETTINGS_VERSION;
    }
    return saved;
}

/** The placement of a block: { enabled, mode: 'main'|'chat'|'macro', depth, role }. */
export function getPlacement(id) {
    const block = byId(id);
    const saved = settings()[id] ?? {};
    const mode = ['main', 'chat', 'macro'].includes(saved.mode) ? saved.mode : block.placement.mode;
    const depth = Number.isInteger(saved.depth) && saved.depth >= 0 && saved.depth <= 50 ? saved.depth : block.placement.depth;
    const role = Object.hasOwn(ROLES, saved.role) ? saved.role : block.placement.role;
    return { enabled: saved.enabled !== false, mode, depth, role };
}

export function setPlacement(id, patch) {
    if (!byId(id)) return;
    settings()[id] = { ...getPlacement(id), ...patch };
    saveSettingsDebounced();
    apply(id);
    notify();
}

export function resetPlacement(id) {
    delete settings()[id];
    saveSettingsDebounced();
    apply(id);
    notify();
}

// ───────────────────────── The active preset ─────────────────────────

/** All text of the active preset that reaches the prompt (enabled Chat Completion prompts, system prompt, story string). */
export function presetText() {
    const parts = [];
    const enabled = new Set();
    for (const entry of Array.isArray(oai_settings?.prompt_order) ? oai_settings.prompt_order : []) {
        for (const item of Array.isArray(entry?.order) ? entry.order : []) if (item?.enabled) enabled.add(item.identifier);
    }
    for (const prompt of Array.isArray(oai_settings?.prompts) ? oai_settings.prompts : []) {
        if (prompt?.content && (!enabled.size || enabled.has(prompt.identifier))) parts.push(str(prompt.content));
    }
    if (power_user?.sysprompt?.enabled !== false) parts.push(str(power_user?.sysprompt?.content));
    parts.push(str(power_user?.context?.story_string));
    return parts.join('\n');
}

export function presetContains(needle) {
    return presetText().toLowerCase().includes(String(needle).toLowerCase());
}

export function presetUsesMacro(macro) {
    return new RegExp(`\\{\\{\\s*${macro}\\s*\\}\\}`, 'i').test(presetText());
}

/** The macros of a block the preset already uses (its own and the extra ones). */
export function presetMacrosOf(id) {
    const block = byId(id);
    if (!block) return [];
    return [block.macro, ...(extraMacros.get(id) ?? [])].filter(macro => presetUsesMacro(macro));
}

/** Other macros that also send a block's text (the preset using one of them counts as the preset having the block). */
export function setExtraMacros(id, macros) {
    extraMacros.set(id, Array.isArray(macros) ? macros.filter(Boolean) : []);
}

// ───────────────────────── Preset sections ─────────────────────────

/** Blocks with no section in the active preset. */
export function missingSections() {
    const prompts = Array.isArray(oai_settings?.prompts) ? oai_settings.prompts : [];
    return BLOCKS.filter(block => !prompts.some(prompt => prompt?.identifier === sectionId(block.id)));
}

/**
 * Adds a section for each missing block to the active Chat Completion preset (Prompt Manager), holding
 * only its macro, next to the preset section it belongs after. Returns how many were added.
 */
export async function addSectionsToPreset() {
    if (!promptManager?.serviceSettings) throw new Error('The Prompt Manager is not ready (Chat Completion only).');
    const missing = missingSections();
    if (!missing.length) return 0;
    const order = promptManager.getPromptOrderForCharacter(promptManager.activeCharacter ?? { id: 100001 });
    for (const block of missing) {
        promptManager.addPrompt({
            name: `Homunculus: ${block.label}`,
            role: 'system',
            content: `{{${block.macro}}}`,
            system_prompt: false,
            marker: false,
            enabled: true,
        }, sectionId(block.id));
        if (order.some(entry => entry.identifier === sectionId(block.id))) continue;
        // After the anchor and the Homunculus sections already placed after it.
        let index = order.findIndex(entry => entry.identifier === block.section.after);
        if (index === -1) {
            order.push({ identifier: sectionId(block.id), enabled: true });
            continue;
        }
        while (order[index + 1]?.identifier?.startsWith('homunculus-')) index++;
        order.splice(index + 1, 0, { identifier: sectionId(block.id), enabled: true });
    }
    await promptManager.saveServiceSettings();
    promptManager.render?.();
    applyAll();
    notify();
    return missing.length;
}

// ───────────────────────── Sending ─────────────────────────

export function wrap(id, text) {
    const block = byId(id);
    const body = str(text).trim();
    return body ? `<${block.tag}>\n${body}\n</${block.tag}>` : '';
}

/**
 * Why a block is or isn't sent right now: 'off' | 'preset-macro' (the preset has its macro: sent there) |
 * 'no-place' (macro only, and the preset has no macro: never sent) | 'empty' | 'sent' (added by itself).
 * @param {string} id
 */
export function status(id) {
    const block = byId(id);
    const placement = getPlacement(id);
    if (!placement.enabled) return 'off';
    if (presetMacrosOf(block.id).length) return 'preset-macro';
    if (placement.mode === 'macro') return 'no-place';
    if (!str(texts.get(id)).trim()) return 'empty';
    return 'sent';
}

function apply(id) {
    const block = byId(id);
    const placement = getPlacement(id);
    const sendable = status(id) === 'sent';
    const value = sendable ? wrap(id, texts.get(id)) : '';
    const position = placement.mode === 'chat' ? extension_prompt_types.IN_CHAT : extension_prompt_types.IN_PROMPT;
    setExtensionPrompt(block.key, value, position, placement.mode === 'chat' ? placement.depth : 0, false, ROLES[placement.role] ?? extension_prompt_roles.SYSTEM, null, `Homunculus: ${block.label}`);
}

/**
 * Sets the text of a block (empty = nothing to send). Called by the modules that make the text.
 * @param {string} id
 * @param {string} text
 */
export function set(id, text) {
    if (!byId(id)) return;
    texts.set(id, str(text));
    apply(id);
}

/** The text of a block as it would be sent (wrapped), even when it is not sent right now. */
export function preview(id) {
    return wrap(id, texts.get(id));
}

function applyAll() {
    for (const block of BLOCKS) if (texts.has(block.id)) apply(block.id);
}

function notify() {
    document.dispatchEvent(new CustomEvent(PROMPTS_CHANGED_EVENT));
}

// ───────────────────────── Macros ─────────────────────────

function registerMacros() {
    const context = globalThis.SillyTavern?.getContext?.();
    for (const block of BLOCKS) {
        // {{cast}} and {{storyStyle}} are registered by their own modules.
        if (['cast', 'storyStyle'].includes(block.macro)) continue;
        const handler = () => (getPlacement(block.id).enabled ? wrap(block.id, texts.get(block.id)) : '');
        const description = `Homunculus: ${block.label}.`;
        try {
            context?.registerMacro?.(block.macro, handler, description);
        } catch {
            // legacy macro engine missing
        }
        try {
            context?.macros?.register?.(block.macro, { handler, description, returns: description, exampleUsage: `{{${block.macro}}}` });
        } catch {
            // new macro engine missing
        }
    }
}

function init() {
    eventSource.on(event_types.APP_READY, registerMacros);
    // The preset can change between replies (a macro added, another preset picked).
    for (const name of ['GENERATION_STARTED', 'OAI_PRESET_CHANGED_AFTER', 'CHAT_COMPLETION_SETTINGS_READY', 'SETTINGS_UPDATED']) {
        if (event_types[name]) eventSource.on(event_types[name], applyAll);
    }
}

init();

globalThis.HomunculusPrompts = { BLOCKS, set, getPlacement, setPlacement, resetPlacement, status, preview, presetUsesMacro, presetMacrosOf, presetContains, missingSections, addSectionsToPreset, PROMPTS_CHANGED_EVENT };
