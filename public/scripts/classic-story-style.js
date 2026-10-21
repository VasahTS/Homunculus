// Classic UI fork: Story style variables (Group Studio → Setup → Story style).
//
// Variables in the style of Marinara's preset variables: each one has a macro name ({{pov}}, {{tense}},
// {{length}}, {{tone}}, or any the user adds) and a list of options, each with a label and the text the
// AI gets. A group picks one option per variable (or none). The picked texts are sent before each reply
// as a short "Story style" block, or only where the preset writes the macros ({{storyStyle}} for all).
//
// Definitions are shared by every group: extension_settings.homunculusStoryStyle.vars.
// Choices are saved in the group: group.homunculus_style = { values: { [varId]: optionId }, inject }.

import { eventSource, event_types, saveSettingsDebounced } from '../script.js';
import { extension_settings } from './extensions.js';
import { groups, selected_group, editGroup } from './group-chats.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { helpButton } from './classic-help.js';
import { set as setPromptBlock, setExtraMacros, presetText, wrap } from './classic-prompt-blocks.js';

const GROUP_KEY = 'homunculus_style';
export const STYLE_CHANGED_EVENT = 'homunculus:story-style-changed';

const opt = (id, label, text) => ({ id, label, text });
const DEFAULT_VARS = Object.freeze([
    {
        id: 'pov', key: 'pov', label: 'Perspective', options: [
            opt('first', '1st person', 'Write the narration in first person ("I").'),
            opt('second', '2nd person', 'Write the narration in second person ("you").'),
            opt('third', '3rd person', 'Write the narration in third person ("she", "he", "they").'),
        ],
    },
    {
        id: 'tense', key: 'tense', label: 'Tense', options: [
            opt('past', 'Past', 'Write in past tense.'),
            opt('present', 'Present', 'Write in present tense.'),
        ],
    },
    {
        id: 'length', key: 'length', label: 'Reply length', options: [
            opt('short', 'Short · ~150 words', 'Keep each reply short: about 150 words.'),
            opt('medium', 'Medium · ~300 words', 'Keep each reply around 300 words.'),
            opt('long', 'Long · ~600 words', 'Write long replies: about 600 words.'),
        ],
    },
    {
        id: 'tone', key: 'tone', label: 'Tone', options: [
            opt('dark', 'Dark and gritty', 'Tone: dark and gritty. Violence and loss have weight; nothing is softened.'),
            opt('adventure', 'Adventurous', 'Tone: adventurous, with momentum, danger and discovery.'),
            opt('light', 'Light and whimsical', 'Tone: light and whimsical, with warmth and humor.'),
            opt('literary', 'Literary', 'Tone: literary and restrained; subtext over statement.'),
            opt('horror', 'Horror', 'Tone: horror. Dread builds slowly; the unknown stays unknown as long as possible.'),
        ],
    },
]);

const HELP = {
    style: `<p>Short instructions about how the story is written. Pick one option per line, or none.</p>
<p>They are sent before each reply as a small "Story style" block. Turn that off if you place them yourself in your preset with the macros (<code>{{pov}}</code>, <code>{{tense}}</code>, <code>{{storyStyle}}</code> for all of them…).</p>
<p><b>Edit variables</b> changes the options and their text, or adds your own variables (for example "Romance: off / slow burn / allowed"). Variables are shared by all groups; each group keeps its own choices.</p>`,
    editor: '<p>Each variable has a <b>macro</b> name (used as <code>{{name}}</code> in presets) and options. The <b>label</b> is what you see; the <b>text</b> is what the AI gets.</p>',
};

export const STYLE_HELP = HELP.style;

const str = value => (typeof value === 'string' ? value : value == null ? '' : String(value));
const cleanKey = value => str(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
const uid = () => Math.random().toString(36).slice(2, 9);

// ───────────────────────── Definitions ─────────────────────────

function settings() {
    extension_settings.homunculusStoryStyle ??= {};
    const st = extension_settings.homunculusStoryStyle;
    if (!Array.isArray(st.vars)) st.vars = structuredClone(DEFAULT_VARS);
    return st;
}

function normalizeVar(raw) {
    const options = (Array.isArray(raw?.options) ? raw.options : [])
        .filter(item => item && str(item.label).trim())
        .map(item => ({ id: str(item.id) || uid(), label: str(item.label).trim(), text: str(item.text) }));
    const key = cleanKey(raw?.key || raw?.label);
    return { id: str(raw?.id) || uid(), key, label: str(raw?.label).trim() || key, options };
}

export function listVars() {
    return settings().vars.map(normalizeVar).filter(item => item.key && item.options.length);
}

// ───────────────────────── Group choices ─────────────────────────

const findGroup = id => groups.find(group => String(group.id) === String(id)) ?? null;

export function normalizeStyle(value) {
    const raw = value && typeof value === 'object' ? value : {};
    const values = {};
    for (const [key, val] of Object.entries(raw.values && typeof raw.values === 'object' ? raw.values : {})) {
        if (key && typeof val === 'string' && val) values[key] = val;
    }
    return { values, inject: raw.inject !== false };
}

export function getStyle(group) {
    return normalizeStyle(group?.[GROUP_KEY]);
}

export async function saveStyle(groupId, patch) {
    const group = findGroup(groupId);
    if (!group) return null;
    const current = getStyle(group);
    group[GROUP_KEY] = normalizeStyle({ ...current, ...patch, values: { ...current.values, ...(patch.values ?? {}) } });
    for (const [key, val] of Object.entries(patch.values ?? {})) if (!val) delete group[GROUP_KEY].values[key];
    await editGroup(group.id, true, false);
    notify();
    return group[GROUP_KEY];
}

/** The chosen option of each variable ({ variable, option } pairs, in variable order). */
export function chosen(style) {
    const picks = [];
    for (const variable of listVars()) {
        const option = variable.options.find(item => item.id === style.values[variable.id]);
        if (option) picks.push({ variable, option });
    }
    return picks;
}

/** The lines of the Story style block (empty when nothing is picked). */
export function styleText(style) {
    const lines = chosen(style).map(({ option }) => str(option.text).trim()).filter(Boolean);
    return lines.map(line => `- ${line}`).join('\n');
}

function openStyle() {
    const group = selected_group ? findGroup(selected_group) : null;
    return group ? getStyle(group) : null;
}

function macroValue(variableKey) {
    const style = openStyle();
    if (!style) return '';
    const pick = chosen(style).find(item => item.variable.key === variableKey);
    return pick ? str(pick.option.text).trim() : '';
}

// ───────────────────────── Prompt and macros ─────────────────────────

function applyPrompt() {
    const style = openStyle();
    // A preset that writes {{pov}}, {{tense}}… already has the style, so the block is not added again.
    setExtraMacros('style', listVars().map(variable => variable.key));
    setPromptBlock('style', style && style.inject ? styleText(style) : '');
}

const CONFLICT_RULES = {
    pov: {
        first: [['second person', /second[- ]person/i], ['third person', /third[- ]person/i]],
        second: [['first person', /first[- ]person/i], ['third person', /third[- ]person/i]],
        third: [['first person', /first[- ]person/i], ['second person', /second[- ]person/i]],
    },
    tense: {
        past: [['present tense', /present tense/i]],
        present: [['past tense', /past tense/i]],
    },
};

/** Warnings when the active preset seems to ask for something else than the picked style. */
export function conflicts(style) {
    const text = presetText();
    const found = [];
    for (const { variable, option } of chosen(style)) {
        for (const [word, pattern] of CONFLICT_RULES[variable.id]?.[option.id] ?? []) {
            if (pattern.test(text)) found.push(`Your preset mentions "${word}", and Story style picks "${option.label}". If both are sent, the AI may mix them: change one of them.`);
        }
    }
    return found;
}

const registered = new Set();
function registerMacro(name, handler, description) {
    if (registered.has(name)) return;
    const context = globalThis.SillyTavern?.getContext?.();
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
    registered.add(name);
}

function registerMacros() {
    registerMacro('storyStyle', () => {
        const style = openStyle();
        return style ? wrap('style', styleText(style)) : '';
    }, 'Every Story style choice of the open group (Group Studio → Setup).');
    for (const variable of listVars()) {
        registerMacro(variable.key, () => macroValue(variable.key), `Story style: the "${variable.label}" choice of the open group.`);
    }
}

function notify() {
    applyPrompt();
    document.dispatchEvent(new CustomEvent(STYLE_CHANGED_EVENT));
}

// ───────────────────────── Variables editor ─────────────────────────

function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function smallButton(html, title, onClick) {
    const b = el('button', 'menu_button ct-sty-btn');
    b.type = 'button';
    b.innerHTML = html;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', onClick);
    return b;
}

/** Opens the editor of the shared variables. Resolves true when saved. */
export async function openVarsEditor() {
    const draft = structuredClone(listVars());
    const wrap = el('div', 'ct-sty-editor');
    const head = el('div', 'ct-sty-head');
    head.append(el('h3', '', 'Story style variables'), helpButton('Story style variables', HELP.editor));
    const list = el('div', 'ct-sty-list');
    wrap.append(head, list);

    const draw = () => {
        list.replaceChildren();
        draft.forEach((variable, vIndex) => {
            const box = el('section', 'ct-sty-var');
            const top = el('div', 'ct-sty-row');
            const label = el('input', 'text_pole');
            label.value = variable.label;
            label.placeholder = 'Name (e.g. Romance)';
            label.setAttribute('aria-label', 'Variable name');
            label.addEventListener('input', () => {
                variable.label = label.value;
                if (!variable.keyTouched && !DEFAULT_VARS.some(item => item.id === variable.id)) {
                    variable.key = cleanKey(label.value);
                    key.value = variable.key;
                }
            });
            const key = el('input', 'text_pole ct-sty-key');
            key.value = variable.key;
            key.placeholder = 'macro';
            key.title = 'Macro name, used as {{name}} in presets';
            key.setAttribute('aria-label', 'Macro name');
            key.addEventListener('input', () => {
                variable.key = cleanKey(key.value);
                variable.keyTouched = true;
            });
            top.append(label, el('span', 'ct-sty-brace', '{{'), key, el('span', 'ct-sty-brace', '}}'),
                smallButton('<i class="fa-solid fa-trash-can"></i>', `Delete the variable ${variable.label}`, () => {
                    draft.splice(vIndex, 1);
                    draw();
                }));
            box.append(top);
            variable.options.forEach((option, oIndex) => {
                const row = el('div', 'ct-sty-option');
                const optLabel = el('input', 'text_pole');
                optLabel.value = option.label;
                optLabel.placeholder = 'Option label';
                optLabel.setAttribute('aria-label', 'Option label');
                optLabel.addEventListener('input', () => { option.label = optLabel.value; });
                const optText = el('textarea', 'text_pole');
                optText.rows = 2;
                optText.value = option.text;
                optText.placeholder = 'What the AI gets when this option is picked';
                optText.setAttribute('aria-label', 'Text for the AI');
                optText.addEventListener('input', () => { option.text = optText.value; });
                row.append(optLabel, optText, smallButton('<i class="fa-solid fa-xmark"></i>', `Remove ${option.label}`, () => {
                    variable.options.splice(oIndex, 1);
                    draw();
                }));
                box.append(row);
            });
            box.append(smallButton('<i class="fa-solid fa-plus"></i> Add an option', 'Add an option', () => {
                variable.options.push({ id: uid(), label: '', text: '' });
                draw();
            }));
            list.append(box);
        });
    };
    draw();
    const addVar = smallButton('<i class="fa-solid fa-plus"></i> Add a variable', 'Add a variable', () => {
        draft.push({ id: uid(), key: '', label: '', options: [{ id: uid(), label: '', text: '' }] });
        draw();
        list.lastElementChild?.querySelector('input')?.focus();
    });
    const reset = smallButton('<i class="fa-solid fa-rotate-left"></i> Restore the built-in variables', 'Put back Perspective, Tense, Reply length and Tone as they came', () => {
        for (const builtin of DEFAULT_VARS) {
            const index = draft.findIndex(item => item.id === builtin.id);
            if (index >= 0) draft[index] = structuredClone(builtin); else draft.push(structuredClone(builtin));
        }
        draw();
    });
    const foot = el('div', 'ct-sty-row');
    foot.append(addVar, reset);
    wrap.append(foot);

    const result = await new Popup(wrap, POPUP_TYPE.CONFIRM, '', { okButton: 'Save', cancelButton: 'Cancel', wide: true, large: true, leftAlign: true, allowVerticalScrolling: true }).show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return false;
    const keys = new Set();
    const clean = [];
    for (const variable of draft.map(normalizeVar)) {
        if (!variable.key || !variable.options.length) continue;
        let key = variable.key;
        while (keys.has(key)) key = `${key}_2`;
        keys.add(key);
        clean.push({ ...variable, key });
    }
    settings().vars = clean;
    saveSettingsDebounced();
    registerMacros();
    notify();
    toastr.success('Story style variables saved.');
    return true;
}

function init() {
    for (const name of ['GENERATION_STARTED', 'CHAT_CHANGED', 'GROUP_UPDATED']) {
        if (event_types[name]) eventSource.on(event_types[name], applyPrompt);
    }
    eventSource.on(event_types.APP_READY, registerMacros);
}

init();

globalThis.HomunculusStoryStyle = { listVars, getStyle, saveStyle, styleText, chosen, conflicts, openVarsEditor, normalizeStyle, STYLE_CHANGED_EVENT };
