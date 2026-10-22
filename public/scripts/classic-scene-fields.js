// Classic UI fork: field presets for the Scene trackers.
//
// A preset says what a Scene tracker records and what the Scene panel shows:
// - "cast" presets (Scene: Characters): sections of fields per character (About, Stats, Appearance,
//   Powers…). Fields of the "about" section sit at the top level of a character; the fields of any
//   other section sit in an object named after the section (character.appearance.face,
//   character.stats.height). name, present, role, mood and notes always exist.
// - "world" presets (Scene: World): which built-in modules are on (time, location, weather, quests,
//   items, factions) plus extra fields.
//
// The tracker prompts get the format and the field rules from the {{sceneCastFields}} and
// {{sceneWorldFields}} macros, so changing the preset changes what the AI writes without editing
// the prompt. Built-in presets are read-only; "Duplicate" makes an editable copy. A group picks its
// presets in the Group Studio (Scene tab); outside groups the default preset is used.

import { eventSource, event_types, saveSettingsDebounced } from '../script.js';
import { extension_settings } from './extensions.js';
import { groups, selected_group, editGroup } from './group-chats.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { helpButton } from './classic-help.js';
import { calendarPrompt } from './classic-calendars.js';

export const FIELDS_CHANGED_EVENT = 'homunculus:scene-fields-changed';
const GROUP_KEY = 'homunculus_scene_fields';
export const FIELD_TYPES = Object.freeze([
    ['text', 'Text'],
    ['stat', 'Short value'],
    ['list', 'List'],
]);
export const WORLD_MODULES = Object.freeze([
    ['time', 'Time'],
    ['location', 'Location'],
    ['weather', 'Weather'],
    ['quests', 'Quests'],
    ['inventory', 'Items'],
    ['factions', 'Factions'],
]);

const HELP = {
    presets: `<p>A preset decides what the tracker writes down and what the Scene panel shows. Pick one that fits the story (for example <b>Superpowers</b> adds powers and weaknesses), or duplicate one and change it.</p>
<p>The tracker's prompt gets the fields through a macro, so you don't need to edit the prompt.</p>`,
    field: `<ul>
<li><b>Text</b>: a sentence or two (shown as a colored block).</li>
<li><b>Short value</b>: a number or a few words (shown as a small tile, like Height or Age).</li>
<li><b>List</b>: several short items (shown as chips, like Traits).</li>
</ul>
<p><b>Instruction</b> is what the AI is told about the field. Be specific: "Exact height with unit (1.83 m)" works better than "height".</p>
<p><b>Required</b> fields are always filled from the moment a character is added.</p>`,
    sections: '<p>Sections group the fields in the panel. Fields in <b>About</b> are written at the top of the card; the others get their own block.</p>',
    modules: '<p>The parts of the world the tracker keeps. Turning one off hides it in the panel and stops the tracker from writing it.</p>',
};

// ───────────────────────── Built-in presets ─────────────────────────

const f = (key, label, type, hint, required = true, icon = '') => ({ key, label, type, hint, required, ...(icon ? { icon } : {}) });

const ABOUT = {
    id: 'about',
    label: 'About',
    fields: [
        f('description', 'Description', 'text', 'One or two sentences on who they are: what they do and where they stand in the story.', true, 'fa-feather'),
        f('traits', 'Traits', 'list', '3 to 6 short personality traits or drives ("resourceful", "wary", "protective of Mira").', true, 'fa-brain'),
    ],
};
const STATS = {
    id: 'stats',
    label: 'Stats',
    fields: [
        f('age', 'Age', 'stat', 'Age in years as a number ("27"). Long-lived beings: real age and the age they look ("340, looks 30").', true, 'fa-hourglass-half'),
        f('height', 'Height', 'stat', 'Exact height with unit, metric ("1.83 m"). Giants, children and small creatures get their real number too ("4.6 m", "12 cm"). Never just "tall" or "short".', true, 'fa-ruler-vertical'),
        f('weight', 'Weight', 'stat', 'Exact weight with unit, metric ("82 kg"). Never just "heavy" or "light".', true, 'fa-weight-scale'),
    ],
};
const APPEARANCE = {
    id: 'appearance',
    label: 'Appearance',
    fields: [
        f('face', 'Face', 'text', 'Face shape, skin tone and notable features, in concrete terms ("square jaw, light olive skin, freckles across the nose").', true, 'fa-face-smile'),
        f('hair', 'Hair', 'text', 'Color, length and style ("black, shoulder-length, tied back").', true, 'fa-scissors'),
        f('eyes', 'Eyes', 'text', 'Color and shape ("pale grey, narrow").', true, 'fa-eye'),
        f('body', 'Build', 'text', 'Frame and musculature in concrete terms: shoulder width, muscle, body fat, posture ("broad shoulders, thick forearms, slight belly"). No vague words like "lean" or "fit".', true, 'fa-person'),
        f('outfit', 'Outfit', 'text', 'Every visible garment with color and material ("faded green wool cloak over a brown leather jerkin, black trousers, worn boots").', true, 'fa-shirt'),
        f('accessories', 'Accessories', 'text', 'What they carry or wear besides clothes: weapons, jewelry, bags. Empty when there is nothing.', false, 'fa-gem'),
        f('marks', 'Marks', 'text', 'Scars, wounds, tattoos, dirt or blood, and where on the body. Empty when there is nothing.', false, 'fa-bandage'),
    ],
};

const BUILTIN = {
    cast: [
        { id: 'builtin-cast-standard', name: 'Standard', builtin: true, sections: [ABOUT, STATS, APPEARANCE] },
        {
            id: 'builtin-cast-superpowers',
            name: 'Superpowers',
            builtin: true,
            sections: [ABOUT, STATS, {
                id: 'powers',
                label: 'Powers',
                fields: [
                    f('alias', 'Alias', 'stat', 'Hero or villain name, if they use one. Empty when they don\'t.', false, 'fa-mask'),
                    f('powers', 'Powers', 'list', 'Each power with its concrete limits ("flight up to 300 km/h", "lifts about 20 tonnes").', true, 'fa-bolt'),
                    f('weaknesses', 'Weaknesses', 'list', 'Concrete weaknesses or limits ("powers fade after 10 minutes", "iron burns the skin").', true, 'fa-heart-crack'),
                    f('power_level', 'Power level', 'stat', 'A rank or class if the setting uses one ("Class A", "Tier 3").', false, 'fa-signal'),
                ],
            }, APPEARANCE],
        },
        {
            id: 'builtin-cast-scifi',
            name: 'Sci-fi',
            builtin: true,
            sections: [ABOUT, STATS, {
                id: 'tech',
                label: 'Tech',
                fields: [
                    f('species', 'Species', 'stat', 'Species or origin ("human, Mars-born").', true, 'fa-dna'),
                    f('cybernetics', 'Cybernetics', 'list', 'Each implant or augmentation and where it is ("left arm, military-grade prosthetic"). Empty when none.', false, 'fa-microchip'),
                    f('gear', 'Gear', 'list', 'Weapons, tools and devices they carry, with type or model.', false, 'fa-toolbox'),
                ],
            }, APPEARANCE],
        },
        {
            id: 'builtin-cast-minimal',
            name: 'Minimal',
            builtin: true,
            sections: [
                { id: 'about', label: 'About', fields: [ABOUT.fields[0]] },
                { id: 'appearance', label: 'Appearance', fields: [APPEARANCE.fields.find(item => item.key === 'outfit')] },
            ],
        },
    ],
    world: [
        { id: 'builtin-world-standard', name: 'Standard', builtin: true, modules: Object.fromEntries(WORLD_MODULES.map(([key]) => [key, true])), fields: [] },
        {
            id: 'builtin-world-survival',
            name: 'Survival',
            builtin: true,
            modules: Object.fromEntries(WORLD_MODULES.map(([key]) => [key, true])),
            fields: [
                f('food', 'Food', 'text', 'How much food the party has, in days or portions ("2 days of dried meat").', true, 'fa-wheat-awn'),
                f('water', 'Water', 'text', 'How much water, in liters or days ("about 3 liters").', true, 'fa-droplet'),
                f('shelter', 'Shelter', 'text', 'Where they will sleep and how safe it is.', false, 'fa-campground'),
                f('threat', 'Threat level', 'text', 'The current danger and why, in concrete terms.', true, 'fa-triangle-exclamation'),
            ],
        },
        { id: 'builtin-world-minimal', name: 'Minimal', builtin: true, modules: { time: true, location: true, weather: true, quests: false, inventory: false, factions: false }, fields: [] },
    ],
};

// ───────────────────────── Storage ─────────────────────────

function settings() {
    const st = extension_settings.homunculusSceneFields && typeof extension_settings.homunculusSceneFields === 'object'
        ? extension_settings.homunculusSceneFields
        : (extension_settings.homunculusSceneFields = {});
    if (!st.custom || typeof st.custom !== 'object') st.custom = {};
    for (const kind of ['cast', 'world']) if (!Array.isArray(st.custom[kind])) st.custom[kind] = [];
    if (!st.active || typeof st.active !== 'object') st.active = {};
    return st;
}

const str = value => (value === null || value === undefined ? '' : String(value));
export const cleanKey = value => str(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

// Field types also by their on-screen names ("Short value"), as written in guides and by AIs.
const typeOf = value => {
    const text = str(value).trim().toLowerCase();
    const match = FIELD_TYPES.find(([id, label]) => id === text || label.toLowerCase() === text);
    return match ? match[0] : 'text';
};
const yes = value => (typeof value === 'string' ? ['yes', 'true', 'required', 'y', '1'].includes(value.trim().toLowerCase()) : Boolean(value));

function normalizeField(raw) {
    const key = cleanKey(raw?.key || raw?.label);
    if (!key) return null;
    return {
        key,
        label: str(raw?.label).trim() || key,
        type: typeOf(raw?.type),
        hint: str(raw?.hint ?? raw?.instruction).trim(),
        required: yes(raw?.required),
        ...(str(raw?.icon).trim() ? { icon: str(raw.icon).trim() } : {}),
    };
}

/** A preset in its full shape (also cleans presets imported or edited by hand). */
export function normalizePreset(kind, raw) {
    const base = {
        id: str(raw?.id) || `custom-${kind}-${Date.now().toString(36)}`,
        name: str(raw?.name).trim() || 'Untitled',
        builtin: Boolean(raw?.builtin),
        rules: str(raw?.rules).trim(),
    };
    if (kind === 'world') {
        const modules = {};
        for (const [key, label] of WORLD_MODULES) {
            const value = raw?.modules ? (raw.modules[key] ?? raw.modules[label] ?? raw.modules[label.toLowerCase()]) : true;
            modules[key] = typeof value === 'string' ? !['off', 'false', 'no', '0'].includes(value.trim().toLowerCase()) : value !== false;
        }
        const seen = new Set(WORLD_MODULES.map(([key]) => key));
        const fields = [];
        for (const field of (Array.isArray(raw?.fields) ? raw.fields : []).map(normalizeField)) {
            if (!field || seen.has(field.key)) continue;
            seen.add(field.key);
            fields.push(field);
        }
        return { ...base, modules, fields };
    }
    const sections = [];
    const used = new Set(['name', 'present', 'role', 'mood', 'notes']);
    const sectionIds = new Set();
    for (const rawSection of Array.isArray(raw?.sections) ? raw.sections : []) {
        const id = cleanKey(rawSection?.id || rawSection?.label);
        if (!id || sectionIds.has(id) || used.has(id)) continue;
        sectionIds.add(id);
        const fields = [];
        for (const rawField of Array.isArray(rawSection?.fields) ? rawSection.fields : []) {
            const field = normalizeField(rawField);
            const fullKey = id === 'about' ? field?.key : `${id}.${field?.key}`;
            if (!field || used.has(fullKey) || (id === 'about' && sectionIds.has(field.key))) continue;
            used.add(fullKey);
            fields.push(field);
        }
        sections.push({ id, label: str(rawSection?.label).trim() || id, fields });
    }
    return { ...base, sections };
}

export function listPresets(kind) {
    return [...BUILTIN[kind].map(preset => normalizePreset(kind, structuredClone(preset))), ...settings().custom[kind].map(preset => normalizePreset(kind, preset))];
}

export function findPreset(kind, id) {
    return listPresets(kind).find(preset => preset.id === id) ?? null;
}

const defaultId = kind => `builtin-${kind}-standard`;

function groupById(groupId) {
    return groupId ? groups.find(item => String(item.id) === String(groupId)) ?? null : null;
}

/** The preset id a group picked ('' = use the default), or the default preset when no group is given. */
export function chosenPresetId(kind, groupId = null) {
    const group = groupById(groupId);
    if (group) return str(group[GROUP_KEY]?.[kind]);
    return str(settings().active[kind]);
}

/** The preset in use: the open group's choice, else the default, else Standard. */
export function activePreset(kind, groupId = selected_group) {
    const group = groupById(groupId);
    const fromGroup = str(group?.[GROUP_KEY]?.[kind]);
    return findPreset(kind, fromGroup) ?? findPreset(kind, str(settings().active[kind])) ?? findPreset(kind, defaultId(kind));
}

function notify() {
    document.dispatchEvent(new CustomEvent(FIELDS_CHANGED_EVENT));
}

/** Picks the preset of a group ('' = default), or the default preset when groupId is null. */
export async function choosePreset(kind, presetId, groupId = null) {
    const group = groupById(groupId);
    if (group) {
        group[GROUP_KEY] = { ...(group[GROUP_KEY] ?? {}), [kind]: presetId };
        await editGroup(group.id, false, false);
    } else {
        settings().active[kind] = presetId;
        saveSettingsDebounced();
    }
    notify();
}

function saveCustom(kind, preset) {
    const list = settings().custom[kind];
    const index = list.findIndex(item => item.id === preset.id);
    const clean = normalizePreset(kind, { ...preset, builtin: false });
    if (index === -1) list.push(clean);
    else list[index] = clean;
    saveSettingsDebounced();
    notify();
    return clean;
}

function deleteCustom(kind, id) {
    const st = settings();
    st.custom[kind] = st.custom[kind].filter(item => item.id !== id);
    if (st.active[kind] === id) st.active[kind] = '';
    for (const group of groups) {
        if (group?.[GROUP_KEY]?.[kind] === id) {
            group[GROUP_KEY][kind] = '';
            void editGroup(group.id, false, false);
        }
    }
    saveSettingsDebounced();
    notify();
}

// ───────────────────────── Data access ─────────────────────────

/** Every field of a cast preset with where it lives in a character. */
export function castFields(preset = activePreset('cast')) {
    return preset.sections.flatMap(section => section.fields.map(field => ({ ...field, section: section.id, sectionLabel: section.label, path: section.id === 'about' ? field.key : `${section.id}.${field.key}` })));
}

export function getValue(character, section, key) {
    if (!character || typeof character !== 'object') return undefined;
    if (section === 'about') return character[key];
    const holder = character[section];
    return holder && typeof holder === 'object' ? holder[key] : undefined;
}

export function setValue(character, section, key, value) {
    if (section === 'about') {
        character[key] = value;
        return;
    }
    if (!character[section] || typeof character[section] !== 'object' || Array.isArray(character[section])) character[section] = {};
    character[section][key] = value;
}

/** A list value as clean strings (the AI answers a list; hand-made data may be a comma string). */
export function listValue(value) {
    return (Array.isArray(value) ? value : str(value).split(/[,;\n]/))
        .map(item => (item && typeof item === 'object' ? Object.values(item).map(str).filter(Boolean).join(' ') : str(item)).trim())
        .filter(Boolean);
}

export function isFilled(field, value) {
    return field.type === 'list' ? listValue(value).length > 0 : str(value).trim() !== '';
}

// ───────────────────────── Prompt macros ─────────────────────────

const LORE_RULE = 'Lorebook entries ([World Info]), character cards and cast sheets are canon for who a character is. When one of them gives a fixed fact (age, height, weight, face, hair, eyes, build, species, powers…), copy it exactly, even if your previous state says something else: correct your previous state to match. Things the story changes (clothes, wounds, dirt, mood) follow the story. When the lorebook has rules for new characters (species, height ranges, eye or skin colors, naming, power limits…), every character you add must follow them. Only invent what none of them and the story give, and keep it inside those rules.';
const CONCRETE_RULE = 'Be concrete and objective: numbers with units, colors, materials, shapes and where on the body. Never use vague or relative words ("tall", "short", "big", "lean", "beautiful", "average") on their own; give the number or the specific detail instead.';

/** Format and field rules for the Scene: Characters tracker ({{sceneCastFields}}). */
export function castFieldsPrompt(preset = activePreset('cast')) {
    const example = { name: '', present: true, role: '' };
    for (const section of preset.sections) {
        const blank = Object.fromEntries(section.fields.map(field => [field.key, field.type === 'list' ? [''] : '']));
        if (section.id === 'about') Object.assign(example, blank);
        else if (section.fields.length) example[section.id] = blank;
    }
    example.mood = '';
    example.position = { spot: '', posture: '', distance: '' };
    example.doing = '';
    example.notes = '';
    const lines = [
        'Answer with exactly one block in this format and nothing else:',
        '[CAST]',
        JSON.stringify({ characters: [example] }),
        '[/CAST]',
        '',
        'Fields of every character (REQUIRED fields are filled the moment a character is added and never left empty):',
    ];
    for (const field of castFields(preset)) {
        const tags = [field.required ? 'REQUIRED' : 'optional', field.type === 'list' ? 'list of short strings' : field.type === 'stat' ? 'short value' : ''].filter(Boolean).join(', ');
        lines.push(`- ${field.path} (${tags}): ${field.hint || field.label}`);
    }
    lines.push('- role: a few words (ally, rival, shopkeeper...). mood: a few words about how they feel right now. notes: one short line worth remembering.');
    lines.push(isAuthorRole()
        ? '- position (REQUIRED for characters in the scene): spot = exactly where in the scene they are ("by the altar", "at the main doors"); posture = standing, sitting, kneeling, lying, walking…; distance = "" (this story has no player character). For characters not in the scene: spot = where they went or were last seen ("left toward the market"), posture and distance "".'
        : '- position (REQUIRED for characters in the scene): spot = exactly where in the scene they are ("by the altar", "at the main doors"); posture = standing, sitting, kneeling, lying, walking…; distance = how far from {{user}}, with a unit ("2 m from {{user}}"); for {{user}} write "". For characters not in the scene: spot = where they went or were last seen ("left toward the market"), posture and distance "".');
    lines.push('- doing: what they are doing right now, a few words ("lighting the candles"). Keep position and doing consistent with the story: nobody moves, sits down or stops what they do unless the story shows it.');
    lines.push(LORE_RULE);
    lines.push(CONCRETE_RULE);
    if (preset.rules) lines.push(preset.rules);
    return lines.join('\n');
}

const TIME_RULE = [
    'date, clock, time: the story\'s calendar date and time of day, in the calendar below.',
    '  date = {"year": number, "month": month NUMBER from the list, "day": day of the month}. clock = 24-hour "HH:MM". The numbers in the format line are placeholders. time = a few words for the part of the day that matches the clock (dawn, morning, midday, afternoon, evening, night, small hours).',
    '  If the story, a character card or the lorebook gives a date, year or era, use it exactly; the story can be set in any past or future year. If nothing gives one, choose a year that fits the setting (a story set today uses the current year) and keep it from then on.',
    '  How much time passes: work out how long the events since your previous state would really take and move the clock forward by that much, never backwards:',
    '  - a few lines of talk or a quick action: 1-5 minutes',
    '  - a normal conversation (a reply full of dialogue): about 10 minutes',
    '  - a long talk, a meal, searching a room, a short fight: 15-60 minutes',
    '  - walking: a few minutes inside a building or to the next street, 15-60 minutes across a town, hours to the next village; riding or travelling between towns: hours, or days for long journeys',
    '  - resting or waiting: as long as the story says; sleeping through the night: the next morning (usually 06:00-08:00)',
    '  - time skips ("later that evening", "three days later", "after a week on the road"): jump exactly that far',
    '  - when the story or a character says the time, use it; when unsure, take the smaller jump',
    '  When the clock passes midnight, move the date forward one day (into the next month or year when the month ends, using the month lengths below).',
].join('\n');

const FACTIONS_RULE = 'factions: the whole list of named groups {{user}} has dealt with or heard of. stance = how they treat {{user}} right now, exactly one of "hostile", "wary", "neutral", "friendly", "allied". standing = one or two sentences on where they stand and why. Change stance only when the story shows it.';
// Author role: no {{user}} in the story, so a faction has no stance toward anyone; it is copied unchanged.
const AUTHOR_FACTIONS_RULE = 'factions: the whole list of named groups in the story. standing = one or two sentences on what they want and how they stand with the main characters. stance: copy it from your previous state unchanged ("" if there is none).';

/** Module → [JSON fragment of the format line, rule]. */
const MODULE_RULES = {
    time: ['"date": {"year": 0, "month": 1, "day": 1}, "clock": "08:00", "time": "morning"', TIME_RULE],
    location: ['"location": ""', 'location: short and specific. Keep the old one if nothing changed.'],
    weather: ['"weather": ""', 'weather: short and specific (temperature, sky, wind). Keep the old one if nothing changed.'],
    quests: ['"quests": [{"title": "", "status": "active", "note": ""}]', 'quests: the whole list. Add one only when a task or goal is clearly given or taken on. Set status to "completed" or "failed" when the story resolves it.'],
    inventory: ['"inventory": [""]', 'inventory: notable items {{user}} carries, with amount or state when it matters ("waterskin, half full"). Add only items clearly taken, bought or given; remove items lost, used up or given away.'],
    factions: ['"factions": [{"name": "", "stance": "neutral", "standing": ""}]', FACTIONS_RULE],
};

// Author role: no {{user}} in the story, so quests have no owner and goals live in Scene: Plot.
// The list is copied unchanged instead of dropped, so it is still there if the group goes back to Player.
const AUTHOR_QUESTS_RULE = 'quests: copy the list from your previous state exactly as it is ([] if there is none). Do not add, change or resolve quests: this story has no player character, and goals are tracked elsewhere.';
const isAuthorRole = () => globalThis.HomunculusGroupCampaign?.openRole?.() === 'author';

/** Format and field rules for the Scene: World tracker ({{sceneWorldFields}}). */
export function worldFieldsPrompt(preset = activePreset('world')) {
    const parts = [];
    const rules = [];
    for (const [key] of WORLD_MODULES) {
        if (!preset.modules[key]) continue;
        const [sample, rule] = MODULE_RULES[key];
        parts.push(sample);
        const author = isAuthorRole();
        rules.push(`- ${key === 'quests' && author ? AUTHOR_QUESTS_RULE : key === 'factions' && author ? AUTHOR_FACTIONS_RULE : rule}`);
    }
    for (const field of preset.fields) {
        parts.push(`"${field.key}": ${field.type === 'list' ? '[""]' : '""'}`);
        rules.push(`- ${field.key} (${field.required ? 'REQUIRED' : 'optional'}${field.type === 'list' ? ', list of short strings' : ''}): ${field.hint || field.label}`);
    }
    const lines = [
        'Answer with exactly one block in this format and nothing else:',
        '[WORLD]',
        `{${parts.join(', ')}}`,
        '[/WORLD]',
        '',
        'Fields (use exactly these):',
        ...rules,
        CONCRETE_RULE,
    ];
    if (preset.modules.time) lines.push('', calendarPrompt());
    if (preset.rules) lines.push(preset.rules);
    return lines.join('\n');
}

function registerMacros() {
    const context = globalThis.SillyTavern?.getContext?.();
    const handlers = {
        sceneCastFields: ['Format and fields for the Scene: Characters tracker (the field preset of the open chat).', () => castFieldsPrompt()],
        sceneWorldFields: ['Format and fields for the Scene: World tracker (the field preset of the open chat).', () => worldFieldsPrompt()],
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

// ───────────────────────── Editor ─────────────────────────

function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function iconButton(icon, title, onClick, className = 'ct-sf-icon') {
    const b = el('button', className);
    b.type = 'button';
    b.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i>`;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', onClick);
    return b;
}

function textButton(html, onClick, className = 'menu_button ct-sf-btn') {
    const b = el('button', className);
    b.type = 'button';
    b.innerHTML = html;
    b.addEventListener('click', onClick);
    return b;
}

function input(value, placeholder, onInput, className = 'text_pole') {
    const node = el('input', className);
    node.type = 'text';
    node.value = value;
    node.placeholder = placeholder;
    node.addEventListener('input', () => onInput(node.value));
    return node;
}

function move(list, index, step) {
    const target = index + step;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
}

// ───────────────────────── Import / export ─────────────────────────

export const EXPORT_FORMAT = 'homunculus-scene-fields';
const KIND_LABEL = { cast: 'Scene: Characters', world: 'Scene: World' };

/** A preset as it goes into a file: no id, no built-in flag. */
function portablePreset(kind, preset) {
    const clean = normalizePreset(kind, preset);
    delete clean.id;
    delete clean.builtin;
    return clean;
}

/** Which tracker a preset from a file belongs to, from its "kind" or its shape. */
function kindOf(raw, fallback = '') {
    const named = str(raw?.kind).toLowerCase();
    if (['cast', 'characters', 'scene: characters'].includes(named)) return 'cast';
    if (['world', 'scene: world'].includes(named)) return 'world';
    if (Array.isArray(raw?.sections)) return 'cast';
    if (raw?.modules && typeof raw.modules === 'object') return 'world';
    return fallback;
}

/**
 * Reads presets from exported JSON. Accepts one exported preset ({ format, kind, preset }),
 * a bundle ({ format, presets: [{ kind, preset }…] }), a bare preset object, or a list of them.
 * A ```json fence around it (as AIs often write) is ignored.
 * @returns {{ kind: 'cast'|'world', preset: object }[]}
 */
export function parsePresetFile(text, fallbackKind = '') {
    let data;
    try {
        data = JSON.parse(String(text ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch {
        throw new Error('This is not valid JSON.');
    }
    const entries = Array.isArray(data) ? data : Array.isArray(data?.presets) ? data.presets : [data];
    const found = [];
    for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const wrapped = entry.preset && typeof entry.preset === 'object';
        const raw = wrapped ? entry.preset : entry;
        const kind = kindOf(wrapped ? { ...raw, kind: entry.kind ?? raw.kind } : raw, fallbackKind);
        if (kind) found.push({ kind, preset: raw });
    }
    if (!found.length) throw new Error('No Scene field preset found in it.');
    return found;
}

/** Saves imported presets as new custom presets (a name that already exists gets a number). */
export function importPresets(entries) {
    const added = [];
    for (const { kind, preset } of entries) {
        const taken = new Set(listPresets(kind).map(item => item.name.toLowerCase()));
        const base = str(preset.name).trim() || 'Imported preset';
        let name = base;
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} (${n})`;
        const clean = normalizePreset(kind, { ...preset, id: '', name, builtin: false });
        if (kind === 'cast' && !clean.sections.some(section => section.fields.length)) continue;
        clean.id = `custom-${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        added.push({ kind, preset: saveCustom(kind, clean) });
    }
    return added;
}

function download(filename, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename.replace(/[\\/:*?"<>|]+/g, '-');
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportPreset(kind, preset) {
    const file = { format: EXPORT_FORMAT, version: 1, kind, preset: portablePreset(kind, preset) };
    download(`Scene ${kind === 'cast' ? 'Characters' : 'World'} - ${preset.name || 'preset'}.json`, `${JSON.stringify(file, null, 4)}\n`);
}

/** Popup to paste JSON or pick a file. Resolves with the text, or '' when cancelled. */
async function askForPresetText(kind) {
    const box = el('div', 'ct-sf-import');
    const intro = el('p', 'ct-sf-note');
    intro.innerHTML = `Paste a preset exported from Homunculus (or written by an AI in the same format), or choose a <b>.json</b> file. A file with both a ${KIND_LABEL.world} and a ${KIND_LABEL.cast} preset adds both.`;
    const area = el('textarea', 'text_pole ct-sf-import-text');
    area.rows = 12;
    area.placeholder = `{ "format": "${EXPORT_FORMAT}", "kind": "${kind}", "preset": { … } }`;
    const file = el('input');
    file.type = 'file';
    file.accept = '.json,application/json,text/plain';
    file.hidden = true;
    file.addEventListener('change', async () => {
        const picked = file.files?.[0];
        if (picked) area.value = await picked.text();
    });
    const row = el('div', 'ct-sf-pick');
    row.append(textButton('<i class="fa-solid fa-folder-open"></i> Choose file', () => file.click()));
    box.append(intro, area, row, file);
    const popup = new Popup(box, POPUP_TYPE.TEXT, '', { okButton: 'Import', cancelButton: 'Cancel', wide: true, leftAlign: true });
    const result = await popup.show();
    return result === POPUP_RESULT.AFFIRMATIVE ? area.value : '';
}

/**
 * The field preset editor (a popup). Built-in presets are shown read-only with a Duplicate button.
 * @param {'cast'|'world'} kind
 * @param {{ groupId?: string|null, presetId?: string }} options which group's choice to show and change
 */
export async function openFieldsEditor(kind, { groupId = null, presetId = '' } = {}) {
    const label = kind === 'cast' ? 'Characters' : 'World';
    let current = findPreset(kind, presetId) ?? activePreset(kind, groupId);
    let draft = structuredClone(current);
    let dirty = false;
    const wrap = el('div', 'ct-sf');

    const commit = () => {
        if (draft.builtin || !dirty) return true;
        const clean = normalizePreset(kind, draft);
        if (kind === 'cast' && !clean.sections.some(section => section.fields.length)) {
            toastr.warning('Add at least one field.');
            return false;
        }
        current = saveCustom(kind, clean);
        draft = structuredClone(current);
        dirty = false;
        return true;
    };
    const change = () => {
        dirty = true;
    };

    const paint = () => {
        wrap.replaceChildren();
        const head = el('div', 'ct-sf-head');
        const title = el('h3', 'ct-sf-title', `Scene: ${label} fields`);
        title.append(helpButton('Field presets', HELP.presets));
        head.append(title);

        const pickRow = el('div', 'ct-sf-pick');
        const select = el('select', 'text_pole');
        select.setAttribute('aria-label', 'Preset');
        for (const preset of listPresets(kind)) {
            const opt = el('option', '', preset.builtin ? `${preset.name} (built-in)` : preset.name);
            opt.value = preset.id;
            opt.selected = preset.id === draft.id;
            select.append(opt);
        }
        select.addEventListener('change', () => {
            if (!commit()) {
                select.value = draft.id;
                return;
            }
            current = findPreset(kind, select.value);
            draft = structuredClone(current);
            paint();
        });
        pickRow.append(select);
        pickRow.append(textButton('<i class="fa-solid fa-copy"></i> Duplicate', () => {
            if (!commit()) return;
            const copy = normalizePreset(kind, { ...structuredClone(draft), id: '', name: `${draft.name} (copy)`, builtin: false });
            current = saveCustom(kind, copy);
            draft = structuredClone(current);
            paint();
            wrap.querySelector('.ct-sf-name')?.focus();
        }));
        pickRow.append(textButton('<i class="fa-solid fa-plus"></i> New', () => {
            if (!commit()) return;
            const blank = kind === 'cast'
                ? { name: 'New preset', sections: [{ id: 'about', label: 'About', fields: [f('description', 'Description', 'text', ABOUT.fields[0].hint, true)] }] }
                : { name: 'New preset', modules: { time: true, location: true, weather: true, quests: false, inventory: false, factions: false }, fields: [] };
            current = saveCustom(kind, normalizePreset(kind, blank));
            draft = structuredClone(current);
            paint();
            wrap.querySelector('.ct-sf-name')?.focus();
        }));
        if (!draft.builtin) {
            pickRow.append(textButton('<i class="fa-solid fa-trash-can"></i> Delete', async () => {
                const ok = await new Popup(`<p>Delete the preset <b>${draft.name.replace(/[<>&]/g, '')}</b>? Groups using it go back to the default.</p>`, POPUP_TYPE.CONFIRM, '', { okButton: 'Delete', cancelButton: 'Cancel' }).show();
                if (ok !== POPUP_RESULT.AFFIRMATIVE) return;
                deleteCustom(kind, draft.id);
                current = activePreset(kind, groupId);
                draft = structuredClone(current);
                dirty = false;
                paint();
            }, 'menu_button ct-sf-btn is-danger'));
        }
        pickRow.append(textButton('<i class="fa-solid fa-file-export"></i> Export', () => {
            if (!commit()) return;
            exportPreset(kind, draft);
        }));
        pickRow.append(textButton('<i class="fa-solid fa-file-import"></i> Import', async () => {
            if (!commit()) return;
            const text = await askForPresetText(kind);
            if (!text.trim()) return;
            let added;
            try {
                added = importPresets(parsePresetFile(text, kind));
            } catch (error) {
                toastr.error(error.message, 'Import failed');
                return;
            }
            if (!added.length) {
                toastr.warning('The preset has no fields to import.');
                return;
            }
            for (const item of added.filter(entry => entry.kind !== kind)) {
                toastr.info(`"${item.preset.name}" was added to the ${KIND_LABEL[item.kind]} presets.`);
            }
            const here = added.find(item => item.kind === kind);
            if (here) {
                current = here.preset;
                draft = structuredClone(current);
                dirty = false;
                toastr.success(`Imported "${here.preset.name}".`);
            }
            paint();
        }));
        head.append(pickRow);
        wrap.append(head);

        if (draft.builtin) {
            const note = el('p', 'ct-sf-note');
            note.innerHTML = 'Built-in presets can\'t be changed. Click <b>Duplicate</b> to make your own copy and edit it.';
            wrap.append(note);
        } else {
            const nameRow = el('label', 'ct-sf-row');
            nameRow.append(el('span', 'ct-sf-label', 'Name'), input(draft.name, 'Preset name', (value) => {
                draft.name = value;
                change();
                const opt = select.querySelector(`option[value="${CSS.escape(draft.id)}"]`);
                if (opt) opt.textContent = value || 'Untitled';
            }, 'text_pole ct-sf-name'));
            wrap.append(nameRow);
        }

        const readOnly = draft.builtin;
        if (kind === 'world') paintWorld(wrap, draft, readOnly, change, paint);
        else paintCast(wrap, draft, readOnly, change, paint);

        const rules = el('label', 'ct-sf-row is-stacked');
        rules.append(el('span', 'ct-sf-label', 'Extra rules for the AI (optional)'));
        const area = el('textarea', 'text_pole');
        area.rows = 2;
        area.value = draft.rules ?? '';
        area.placeholder = 'For example: Use imperial units. Powers are always named in English.';
        area.disabled = readOnly;
        area.addEventListener('input', () => {
            draft.rules = area.value;
            change();
        });
        rules.append(area);
        wrap.append(rules);

        const useRow = el('div', 'ct-sf-use');
        const using = activePreset(kind, groupId).id === draft.id;
        useRow.append(el('span', 'ct-sf-note', using ? (groupId ? 'This group uses this preset.' : 'This is the default preset.') : (groupId ? 'This group uses another preset.' : 'This is not the default preset.')));
        if (!using) {
            useRow.append(textButton(`<i class="fa-solid fa-check"></i> Use for ${groupId ? 'this group' : 'chats outside groups'}`, async () => {
                if (!commit()) return;
                await choosePreset(kind, draft.id, groupId);
                paint();
            }));
        }
        wrap.append(useRow);
    };
    paint();

    const popup = new Popup(wrap, POPUP_TYPE.TEXT, '', {
        okButton: 'Save',
        cancelButton: 'Close',
        wide: true,
        large: true,
        leftAlign: true,
        allowVerticalScrolling: true,
    });
    const result = await popup.show();
    if (result === POPUP_RESULT.AFFIRMATIVE) commit();
    return current;
}

function fieldRow(field, list, index, readOnly, change, paint, { allowStat = true } = {}) {
    const row = el('div', 'ct-sf-field');
    const top = el('div', 'ct-sf-field-top');
    const labelInput = input(field.label, 'Label', (value) => {
        field.label = value;
        if (field.autoKey) field.key = cleanKey(value);
        change();
        keyNote.textContent = `key: ${cleanKey(field.key || value) || '…'}`;
    }, 'text_pole ct-sf-field-label');
    labelInput.disabled = readOnly;
    const type = el('select', 'text_pole ct-sf-type');
    for (const [id, name] of FIELD_TYPES.filter(([id]) => allowStat || id !== 'stat')) {
        const opt = el('option', '', name);
        opt.value = id;
        opt.selected = field.type === id;
        type.append(opt);
    }
    type.disabled = readOnly;
    type.setAttribute('aria-label', 'Field type');
    type.addEventListener('change', () => {
        field.type = type.value;
        change();
    });
    const required = el('label', 'ct-sf-check');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = Boolean(field.required);
    box.disabled = readOnly;
    box.addEventListener('change', () => {
        field.required = box.checked;
        change();
    });
    required.append(box, el('span', '', 'Required'));
    top.append(labelInput, type, required);
    if (!readOnly) {
        top.append(
            iconButton('fa-arrow-up', 'Move up', () => {
                move(list, index, -1);
                change();
                paint();
            }),
            iconButton('fa-arrow-down', 'Move down', () => {
                move(list, index, 1);
                change();
                paint();
            }),
            iconButton('fa-xmark', `Remove ${field.label || 'field'}`, () => {
                list.splice(index, 1);
                change();
                paint();
            }, 'ct-sf-icon is-danger'),
        );
    }
    const hint = el('textarea', 'text_pole ct-sf-hint');
    hint.rows = 1;
    hint.value = field.hint ?? '';
    hint.placeholder = 'Instruction for the AI: what to write here, as concretely as possible';
    hint.disabled = readOnly;
    const grow = () => {
        hint.style.height = 'auto';
        hint.style.height = `${hint.scrollHeight + 2}px`;
    };
    hint.addEventListener('input', () => {
        field.hint = hint.value;
        change();
        grow();
    });
    requestAnimationFrame(grow);
    const keyNote = el('span', 'ct-sf-key', `key: ${field.key || cleanKey(field.label) || '…'}`);
    row.append(top, hint, keyNote);
    return row;
}

function paintCast(wrap, draft, readOnly, change, paint) {
    const head = el('div', 'ct-sf-section-title');
    head.append(el('span', '', 'Sections and fields'), helpButton('Sections', HELP.sections), helpButton('Field types', HELP.field));
    wrap.append(head);
    const core = el('p', 'ct-sf-note', 'Always kept: name, in scene / not here, role, mood and notes.');
    wrap.append(core);
    draft.sections.forEach((section, sIndex) => {
        const box = el('section', 'ct-sf-section');
        const top = el('div', 'ct-sf-section-top');
        const name = input(section.label, 'Section name', (value) => {
            section.label = value;
            if (section.id !== 'about' && section.autoId) section.id = cleanKey(value);
            change();
        }, 'text_pole ct-sf-section-name');
        name.disabled = readOnly;
        top.append(name, el('span', 'ct-sf-key', section.id === 'about' ? 'top of the card' : `saved as ${section.id}`));
        if (!readOnly) {
            top.append(
                iconButton('fa-arrow-up', 'Move section up', () => {
                    move(draft.sections, sIndex, -1);
                    change();
                    paint();
                }),
                iconButton('fa-arrow-down', 'Move section down', () => {
                    move(draft.sections, sIndex, 1);
                    change();
                    paint();
                }),
                iconButton('fa-trash-can', `Remove the section ${section.label}`, () => {
                    draft.sections.splice(sIndex, 1);
                    change();
                    paint();
                }, 'ct-sf-icon is-danger'),
            );
        }
        box.append(top);
        section.fields.forEach((field, index) => box.append(fieldRow(field, section.fields, index, readOnly, change, paint)));
        if (!section.fields.length) box.append(el('p', 'ct-sf-note', 'No fields yet.'));
        if (!readOnly) {
            box.append(textButton('<i class="fa-solid fa-plus"></i> Add field', () => {
                section.fields.push({ key: '', label: '', type: 'text', hint: '', required: true, autoKey: true });
                change();
                paint();
                const rows = box.parentElement?.querySelectorAll('.ct-sf-field-label');
                rows?.[rows.length - 1]?.focus();
            }, 'ct-sf-add'));
        }
        wrap.append(box);
    });
    if (!readOnly) {
        wrap.append(textButton('<i class="fa-solid fa-layer-group"></i> Add section', () => {
            const id = `section_${draft.sections.length + 1}`;
            draft.sections.push({ id, label: 'New section', fields: [], autoId: true });
            change();
            paint();
        }, 'menu_button ct-sf-btn'));
    }
}

function paintWorld(wrap, draft, readOnly, change, paint) {
    const head = el('div', 'ct-sf-section-title');
    head.append(el('span', '', 'Modules'), helpButton('Modules', HELP.modules));
    wrap.append(head);
    const modules = el('div', 'ct-sf-modules');
    for (const [key, name] of WORLD_MODULES) {
        const lab = el('label', 'ct-sf-check');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = draft.modules[key] !== false;
        box.disabled = readOnly;
        box.addEventListener('change', () => {
            draft.modules[key] = box.checked;
            change();
        });
        lab.append(box, el('span', '', name));
        modules.append(lab);
    }
    wrap.append(modules);
    const fHead = el('div', 'ct-sf-section-title');
    fHead.append(el('span', '', 'Extra fields'), helpButton('Field types', HELP.field));
    wrap.append(fHead);
    const box = el('section', 'ct-sf-section');
    draft.fields.forEach((field, index) => box.append(fieldRow(field, draft.fields, index, readOnly, change, paint, { allowStat: false })));
    if (!draft.fields.length) box.append(el('p', 'ct-sf-note', 'No extra fields.'));
    if (!readOnly) {
        box.append(textButton('<i class="fa-solid fa-plus"></i> Add field', () => {
            draft.fields.push({ key: '', label: '', type: 'text', hint: '', required: true, autoKey: true });
            change();
            paint();
        }, 'ct-sf-add'));
    }
    wrap.append(box);
}

// ───────────────────────── Init ─────────────────────────

globalThis.HomunculusSceneFields = {
    listPresets,
    findPreset,
    activePreset,
    chosenPresetId,
    choosePreset,
    openFieldsEditor,
    castFields,
    castFieldsPrompt,
    worldFieldsPrompt,
    FIELDS_CHANGED_EVENT,
};

eventSource.on(event_types.APP_READY, registerMacros);
