// Classic UI fork: the World Map.
//
// Worlds are reusable maps kept in a library (extension_settings.homunculusWorlds); a chat picks the
// world it uses and how new places get in (chat_metadata.homunculus_map):
// - auto: the Scene: Map tracker's patches go straight into the world;
// - ask: new places from the tracker wait as suggestions; moves between known places still apply;
// - locked: the world doesn't change; the tracker only says where the scene is.
// Where the scene is lives in the chat, per message: a move made here (message.extra.homunculus_place)
// or the tracker's "current", so swipes and branches keep the right place.
// The full-screen page (tree · map · details) edits the world; the generator builds places from
// lorebooks, character cards or a description, as a draft you review first.

import { chat, chat_metadata, characters, this_chid, getCurrentChatId, saveSettingsDebounced, saveChatDebounced } from '../script.js';
import { extension_settings, saveMetadataDebounced } from './extensions.js';
import { groups, selected_group } from './group-chats.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { helpButton } from './classic-help.js';
import { loadWorldInfo, world_names, selected_world_info, METADATA_KEY } from './world-info.js';
import { connectionProfiles } from './classic-group-campaign.js';
import { extractReasoningFromData, removeReasoningFromString } from './reasoning.js';
import { cleanId, normalizePlace, ancestors, childrenOf, isInside, travelFrom, mapLevel, drawMap, PLACE_STATES } from './classic-scene-story.js';

export const WORLD_CHANGED_EVENT = 'homunculus:world-changed';
const BINDING_KEY = 'homunculus_map';
const MODES = Object.freeze([
    ['auto', 'Auto', 'The Map tracker follows the story and adds places by itself.'],
    ['ask', 'Ask', 'New places from the tracker wait for your OK. Moves between known places still happen.'],
    ['locked', 'Locked', 'The map stays as it is. The story only moves between its places.'],
]);
const KINDS = Object.freeze(['world', 'continent', 'country', 'region', 'wilderness', 'city', 'town', 'village', 'district', 'building', 'floor', 'room', 'area', 'road', 'landmark', 'camp', 'ship', 'other']);
const STATUS_INFO = Object.freeze({
    visited: ['Visited', 'The story has been there'],
    known: ['Known', 'Known to exist, not visited yet'],
    rumored: ['Rumored', 'Only heard of; may be wrong'],
});
const SIZES = Object.freeze([['small', 'Small', 8], ['medium', 'Medium', 16], ['large', 'Large', 28]]);

const HELP = {
    page: `<p>The map of the world this chat uses. Pick a place on the left or on the map to see and edit it on the right.</p>
<ul>
<li><b>Map</b>: scroll or + / − to zoom, drag the background to move around, drag a place to move it.</li>
<li>A place with a second ring has places inside: <b>Open inside</b> (or double-click it in the list) shows them. The path above the map goes back out.</li>
<li><b>Show as</b> lays out the places inside the open place as a map, a list, or floors (for towers and buildings).</li>
</ul>
<p>Worlds live in the <b>Library</b> and can be used by more than one chat. Each chat keeps its own "where we are".</p>`,
    modes: `<ul>
<li><b>Auto</b>: the Scene: Map tracker adds and updates places as the story names them.</li>
<li><b>Ask</b>: new places wait on the left for your OK (Add, Edit first or Skip). Moving between places you already have still happens by itself.</li>
<li><b>Locked</b>: the map never changes by itself. The story only moves between the places on it. Good for a world you built or generated yourself.</li>
</ul>
<p>The mode is saved per chat.</p>`,
    secret: '<p>Only the AI sees this, and only while the story is in this place: hidden rooms, traps, who is really behind the counter. It never shows in the panel.</p>',
    routes: '<p>Ways from this place to others, with how long the trip takes ("15 min", "2 days by ship"). One-way routes only go from here (a slide, a portal, a river current).</p>',
    generate: `<p>Builds places with the AI, from your lorebooks, the character cards of this chat and/or your own description.</p>
<ul>
<li><b>Only what the lore says</b>: only places the sources name.</li>
<li><b>Lore + fill the gaps</b>: adds fitting places where the sources are silent.</li>
</ul>
<p>You get a draft first: tick what to keep, then add it. Nothing changes before that.</p>`,
    library: '<p>Every world you have. A world can be used by several chats (each keeps its own "where we are"). Duplicate one to start a new story in the same world without sharing changes.</p>',
};

const DEFAULT_PROMPT = `You design maps for a roleplay app. Build the places described below as a hierarchy: each place sits inside a parent place (room → building → district → city → country, or clearing → forest → region → kingdom).

Sources:
{{sources}}

Build: {{target}}
Lore rule: {{canon}}
Size: about {{size}} places in total, including the parent places the others need.
Places already on the map (do not repeat them; you may give an updated description for one by reusing its id):
{{existing}}

Answer with exactly one block in this format and nothing else:
[MAP]
{"world":"<a short name for the world, only when building a new world>","places":[{"id":"","name":"","kind":"","parent":"","status":"known","description":"","x":50,"y":50,"links":[{"to":"","travel":""}]}]}
[/MAP]

Rules:
- id: short, lowercase, words joined by dashes. parent: the id of the place it is inside ("" for the top). Keep the chain complete.
- kind: one word: world, continent, country, region, wilderness, city, town, village, district, building, floor, room, area, road, landmark, camp, ship, other.
- status: "known" for places the characters would know, "rumored" for legends and hearsay.
- description: one or two concrete sentences: what it looks like and what matters there.
- x and y: position inside the parent, 0 to 100 (x: west → east, y: north → south). Follow the directions in the sources. Keep siblings at least 15 apart.
- links: routes between places that share a parent, and longer roads between towns or regions, with the travel time on foot unless the sources say otherwise.
- Valid JSON only: double quotes, no comments, no trailing commas.`;

// ───────────────────────── Storage ─────────────────────────

const str = value => (value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value));
const keyOf = value => str(value).trim().toLowerCase();

function settings() {
    const st = extension_settings.homunculusWorlds && typeof extension_settings.homunculusWorlds === 'object'
        ? extension_settings.homunculusWorlds
        : (extension_settings.homunculusWorlds = {});
    if (!st.worlds || typeof st.worlds !== 'object') st.worlds = {};
    if (!Array.isArray(st.prompts)) st.prompts = [];
    if (!st.generator || typeof st.generator !== 'object') st.generator = {};
    return st;
}

export function listWorlds() {
    return Object.values(settings().worlds).filter(world => world && world.id).sort((a, b) => str(a.name).localeCompare(str(b.name)));
}

const worldById = id => (id ? settings().worlds[id] ?? null : null);

function newId(prefix) {
    return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function createWorld(name, places = {}) {
    const world = { id: newId('world'), name: str(name).trim() || 'New world', places, createdAt: Date.now(), updatedAt: Date.now() };
    settings().worlds[world.id] = world;
    saveSettingsDebounced();
    return world;
}

/** The places of a world as a Map (normalized). */
export function placesOf(world) {
    const map = new Map();
    for (const raw of Object.values(world?.places ?? {})) {
        const place = normalizePlace(raw);
        if (place) map.set(place.id, place);
    }
    return map;
}

function storePlaces(world, places) {
    world.places = Object.fromEntries([...places.values()].map(place => [place.id, place]));
    saveWorld(world);
}

function saveWorld(world) {
    world.updatedAt = Date.now();
    saveSettingsDebounced();
    document.dispatchEvent(new CustomEvent(WORLD_CHANGED_EVENT));
}

/** The chat's choice: { worldId, mode, applied, pending, lastAdded }. */
function binding() {
    if (!chat_metadata) return { worldId: '', mode: 'auto', applied: [], pending: [], lastAdded: [] };
    const raw = chat_metadata[BINDING_KEY] && typeof chat_metadata[BINDING_KEY] === 'object' ? chat_metadata[BINDING_KEY] : (chat_metadata[BINDING_KEY] = {});
    if (typeof raw.worldId !== 'string') raw.worldId = '';
    if (!MODES.some(([id]) => id === raw.mode)) raw.mode = 'auto';
    if (!Array.isArray(raw.applied)) raw.applied = [];
    if (!Array.isArray(raw.pending)) raw.pending = [];
    if (!Array.isArray(raw.lastAdded)) raw.lastAdded = [];
    return raw;
}

function saveBinding() {
    saveMetadataDebounced();
    document.dispatchEvent(new CustomEvent(WORLD_CHANGED_EVENT));
}

export function chatWorld() {
    return getCurrentChatId?.() ? worldById(binding().worldId) : null;
}

export const chatMode = () => binding().mode;

function useWorld(worldId) {
    const b = binding();
    b.worldId = worldId;
    b.pending = [];
    // Results already in the chat count as seen, so switching worlds doesn't pour the old patches in.
    b.applied = mapHistory().map(resultKey);
    saveBinding();
}

function defaultWorldName() {
    const group = selected_group ? groups.find(item => String(item.id) === String(selected_group)) : null;
    if (group?.name) return `${group.name} world`;
    const character = characters?.[this_chid];
    return character?.name ? `${character.name}'s world` : 'New world';
}

/** The world of this chat, made on the spot when asked (an empty one, named after the chat). */
function ensureWorld() {
    const existing = chatWorld();
    if (existing) return existing;
    const world = createWorld(defaultWorldName());
    useWorld(world.id);
    return world;
}

// ───────────────────────── The tracker's results ─────────────────────────

const mapHistory = () => globalThis.HomunculusScene?.historyOf?.('map') ?? [];

function hash(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
}
const resultKey = entry => `${entry.messageIndex}:${hash(JSON.stringify(entry.data))}`;

/**
 * Takes in the Map tracker's new results according to the chat's mode. The first result in a chat
 * without a world makes one (named after the chat), so older chats keep their map.
 * @returns {boolean} whether anything changed
 */
export function ingest() {
    if (!getCurrentChatId?.()) return false;
    const history = mapHistory();
    if (!history.length) return false;
    const b = binding();
    const fresh = history.filter(entry => !b.applied.includes(resultKey(entry)));
    if (!fresh.length) return false;
    let world = worldById(b.worldId);
    // Only the newest result counts as "new places" (a first pass over an older chat names nothing).
    const latestKey = resultKey(history[history.length - 1]);
    const reportNew = Boolean(world) && fresh.length <= 2;
    if (!world) {
        world = createWorld(defaultWorldName());
        b.worldId = world.id;
    }
    const places = placesOf(world);
    const mode = b.mode;
    let changed = false;
    const added = [];
    for (const entry of fresh) {
        const key = resultKey(entry);
        for (const raw of Array.isArray(entry.data?.places) ? entry.data.places : []) {
            const id = cleanId(raw?.id || raw?.name);
            if (!id) continue;
            const old = places.get(id) ?? null;
            if (!old) {
                if (mode === 'locked') continue;
                if (mode === 'ask') {
                    const place = normalizePlace(raw);
                    if (place && !b.pending.some(item => item.place.id === id)) b.pending.push({ key: `${key}|${id}`, place, messageIndex: entry.messageIndex });
                    continue;
                }
                if (reportNew && key === latestKey) added.push(str(raw.name || id));
            } else if (mode === 'locked') {
                if (raw.status === 'visited' && old.status !== 'visited') {
                    old.status = 'visited';
                    changed = true;
                }
                continue;
            }
            // Hand edits win: a place you moved or rewrote keeps your position and text.
            const place = normalizePlace(old && old.edited ? { ...raw, x: old.x, y: old.y, description: old.description || raw.description, status: raw.status } : raw, old);
            if (old?.edited) place.edited = true;
            if (place) {
                places.set(place.id, place);
                changed = true;
            }
        }
        if (mode === 'auto') {
            for (const id of (Array.isArray(entry.data?.remove) ? entry.data.remove : []).map(cleanId)) {
                if (places.delete(id)) changed = true;
            }
        }
        const current = cleanId(entry.data?.current);
        if (current && places.has(current) && places.get(current).status !== 'visited') {
            places.get(current).status = 'visited';
            changed = true;
        }
        b.applied.push(key);
    }
    b.applied = b.applied.slice(-500);
    b.lastAdded = added;
    if (changed) storePlaces(world, places);
    saveBinding();
    return true;
}

/** Where the story is, message by message: [{ messageIndex, placeId, name }] (only places on the map). */
export function placeTimeline(places = placesOf(chatWorld())) {
    if (!places.size) return [];
    const fromTracker = new Map(mapHistory().map(entry => [entry.messageIndex, cleanId(entry.data?.current)]));
    const out = [];
    for (let i = 0; i < chat.length; i++) {
        let id = cleanId(chat[i]?.extra?.homunculus_place);
        if (!id || !places.has(id)) id = fromTracker.get(i) ?? '';
        if (id && places.has(id)) out.push({ messageIndex: i, placeId: id, name: places.get(id).name });
    }
    return out;
}

/** Everything the Scene panel needs about the map of this chat. */
export function mapState() {
    const world = chatWorld();
    const places = placesOf(world);
    const timeline = placeTimeline(places);
    const b = getCurrentChatId?.() ? binding() : { mode: 'auto', pending: [], lastAdded: [] };
    return {
        world,
        places,
        current: timeline[timeline.length - 1]?.placeId ?? '',
        timeline,
        mode: b.mode,
        pending: b.pending,
        newNames: b.lastAdded,
    };
}

/** Moves the story to a place (saved on the last message, so a swipe of an older message keeps its own). */
export function moveTo(id) {
    const last = chat[chat.length - 1];
    if (!last) {
        toastr.info('Send or receive a message first.');
        return;
    }
    last.extra = last.extra && typeof last.extra === 'object' ? last.extra : {};
    last.extra.homunculus_place = id;
    saveChatDebounced?.();
    document.dispatchEvent(new CustomEvent(WORLD_CHANGED_EVENT));
}

export function acceptPending(id) {
    const b = binding();
    const item = b.pending.find(entry => entry.place.id === id);
    if (!item) return;
    const world = ensureWorld();
    const places = placesOf(world);
    const place = normalizePlace(item.place);
    if (place.parent && !places.has(place.parent)) {
        const parentPending = b.pending.find(entry => entry.place.id === place.parent);
        if (parentPending) acceptPending(place.parent);
        else place.parent = '';
    }
    const fresh = placesOf(world);
    fresh.set(place.id, place);
    b.pending = b.pending.filter(entry => entry.place.id !== id);
    storePlaces(world, fresh);
    saveBinding();
}

export function skipPending(id) {
    const b = binding();
    b.pending = b.pending.filter(entry => entry.place.id !== id);
    saveBinding();
}

// ───────────────────────── For the AIs ─────────────────────────

/** The places the tracker gets ({{sceneMapPlaces}}): all of them in small worlds, the neighborhood in big ones. */
export function mapMacro() {
    const { world, places, current, mode } = mapState();
    const lines = [];
    if (!world || !places.size) {
        lines.push('(empty: no places yet)');
    } else {
        let ids = [...places.keys()];
        if (ids.length > 80) {
            const keep = new Set();
            const add = id => id && places.has(id) && keep.add(id);
            const chain = current ? [current, ...ancestors(places, current)] : [];
            chain.forEach(add);
            for (const holder of chain) childrenOf(places, holder).forEach(place => add(place.id));
            childrenOf(places, '').forEach(place => add(place.id));
            for (const id of [...keep]) places.get(id).links.forEach(link => add(link.to));
            ids = [...keep];
        }
        for (const id of ids) {
            const place = places.get(id);
            const links = place.links.map(link => `${link.to}${link.travel ? ` (${link.travel})` : ''}${link.oneWay ? ' one-way' : ''}`).join(', ');
            const where = place.x !== null && place.y !== null ? `x ${Math.round(place.x)}, y ${Math.round(place.y)}` : 'not placed';
            lines.push(`- ${place.id} | ${place.name} | ${place.kind || 'place'} | inside: ${place.parent || '-'} | ${place.status} | ${where}${links ? ` | links: ${links}` : ''}`);
        }
    }
    lines.push(`Current place: ${current || '(unknown)'}`);
    if (mode === 'locked') lines.push('THE MAP IS LOCKED: never add or change places. Only set "current" to the id above that fits where the scene is (keep the old one if none fits), and answer with "places": [] and "remove": [].');
    if (mode === 'ask') lines.push('New places you add are shown to the user for approval before they join the map.');
    return lines.join('\n');
}

/** For the story AI: where the scene is, the ways out, and what only the AI knows about the place. */
export function storyPrompt() {
    const { places, current } = mapState();
    const here = places.get(current);
    if (!here) return '';
    const chain = ancestors(places, current).map(id => places.get(id).name);
    const ways = [];
    for (const link of here.links) if (places.has(link.to)) ways.push(`${places.get(link.to).name}${link.travel ? ` (${link.travel})` : ''}`);
    for (const place of places.values()) {
        const back = place.links.find(link => link.to === current && !link.oneWay);
        if (back && !here.links.some(link => link.to === place.id)) ways.push(`${place.name}${back.travel ? ` (${back.travel})` : ''}`);
    }
    const lines = [`Place: ${here.name}${chain.length ? ` (in ${chain.join(', ')})` : ''}`];
    if (here.description) lines.push(`  ${here.description}`);
    if (ways.length) lines.push(`Ways from here: ${ways.join('; ')}`);
    if (here.secret) lines.push(`About this place (only you know; reveal it through the story, never state it): ${here.secret}`);
    return lines.join('\n');
}

// ───────────────────────── Page ─────────────────────────

const page = {
    root: null,
    focus: null,
    selected: '',
    search: '',
    collapsed: new Set(),
    mapView: {},
    gen: null,
};

function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
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

const escapeHtml = text => str(text).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

export function isOpen() {
    return Boolean(page.root && !page.root.hidden);
}

/** Opens the page (optionally on a place). */
export function open(placeId = '') {
    if (!getCurrentChatId?.()) {
        toastr.info('Open a chat first: the map belongs to the chat\'s world.');
        return;
    }
    ingest();
    if (!page.root) {
        page.root = el('section', 'ct-wm');
        page.root.id = 'ct-world-map';
        page.root.setAttribute('role', 'dialog');
        page.root.setAttribute('aria-label', 'World Map');
        page.root.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !document.querySelector('dialog[open]')) {
                event.stopPropagation();
                close();
            }
        });
        document.body.append(page.root);
    }
    const { places, current } = mapState();
    const target = placeId && places.has(placeId) ? placeId : current;
    page.selected = target || '';
    page.focus = target ? (places.get(target)?.parent && places.has(places.get(target).parent) ? places.get(target).parent : '') : '';
    page.mapView = {};
    page.root.hidden = false;
    document.body.classList.add('ct-wm-open');
    render();
    page.root.querySelector('.ct-wm-back')?.focus();
}

export function close() {
    if (!page.root) return;
    page.root.hidden = true;
    page.gen = null;
    document.body.classList.remove('ct-wm-open');
    globalThis.HomunculusScene?.refresh?.();
}

function select(id, { reveal = true } = {}) {
    const { places } = mapState();
    page.selected = id;
    if (reveal && id && places.has(id)) {
        const parent = places.get(id).parent && places.has(places.get(id).parent) ? places.get(id).parent : '';
        if (!isInside(places, id, page.focus || '__none__') || id === page.focus) page.focus = parent;
        for (const holder of ancestors(places, id)) page.collapsed.delete(holder);
    }
    render();
}

function focusOn(id) {
    page.focus = id;
    page.mapView = {};
    render();
}

function render() {
    if (!page.root || page.root.hidden) return;
    const state = mapState();
    const { world } = state;
    const keepScroll = page.root.querySelector('.ct-wm-tree')?.scrollTop ?? 0;
    const keepDetails = page.root.querySelector('.ct-wm-details')?.scrollTop ?? 0;
    page.root.replaceChildren(renderHeader(state));
    if (!world) {
        page.root.append(renderNoWorld());
    } else {
        if (page.focus && !state.places.has(page.focus)) page.focus = '';
        if (page.selected && !state.places.has(page.selected)) page.selected = '';
        const body = el('div', 'ct-wm-body');
        body.append(renderTree(state), renderCenter(state), renderDetails(state));
        page.root.append(body);
    }
    if (page.gen) page.root.append(renderGenerator(state));
    const tree = page.root.querySelector('.ct-wm-tree');
    if (tree) tree.scrollTop = keepScroll;
    const details = page.root.querySelector('.ct-wm-details');
    if (details) details.scrollTop = keepDetails;
}

function renderHeader(state) {
    const head = el('header', 'ct-wm-head');
    head.append(button('ct-wm-icon ct-wm-back', '<i class="fa-solid fa-arrow-left"></i>', 'Back to the chat', close));
    const title = el('div', 'ct-wm-title');
    title.innerHTML = '<i class="fa-solid fa-map" aria-hidden="true"></i>';
    title.append(el('h2', '', 'World Map'), helpButton('World Map', HELP.page));
    head.append(title);

    const worldBox = el('div', 'ct-wm-world');
    worldBox.append(el('span', 'ct-wm-muted', 'World'));
    const select = el('select', 'text_pole ct-wm-world-select');
    select.setAttribute('aria-label', 'World used by this chat');
    const none = el('option', '', '— No world —');
    none.value = '';
    select.append(none);
    for (const world of listWorlds()) {
        const option = el('option', '', `${world.name} · ${Object.keys(world.places ?? {}).length} places`);
        option.value = world.id;
        option.selected = world.id === state.world?.id;
        select.append(option);
    }
    select.addEventListener('change', () => {
        useWorld(select.value);
        page.focus = null;
        page.selected = '';
        page.mapView = {};
        open();
    });
    worldBox.append(select, button('menu_button ct-wm-btn', '<i class="fa-solid fa-book-atlas"></i> Library', 'All your worlds', () => void openLibrary()), helpButton('Library', HELP.library));
    head.append(worldBox, el('span', 'ct-wm-grow'));

    const modeBox = el('div', 'ct-wm-mode');
    modeBox.append(el('span', 'ct-wm-muted', 'In this chat'));
    const group = el('div', 'ct-wm-segment');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'How places get on the map');
    for (const [id, label, desc] of MODES) {
        const on = state.mode === id;
        const b = button(on ? 'is-on' : '', label, desc, () => {
            binding().mode = id;
            saveBinding();
            render();
        });
        b.setAttribute('aria-pressed', String(on));
        group.append(b);
    }
    modeBox.append(group, helpButton('Modes', HELP.modes));
    head.append(modeBox);
    head.append(button('menu_button ct-wm-btn is-primary', '<i class="fa-solid fa-wand-magic-sparkles"></i> Generate…', 'Build places with the AI from lorebooks, cards or a description', () => {
        openGenerator(state);
    }));
    return head;
}

function renderNoWorld() {
    const box = el('div', 'ct-wm-empty');
    box.innerHTML = '<i class="fa-solid fa-map" aria-hidden="true"></i>';
    box.append(el('h3', '', 'This chat has no map yet'));
    box.append(el('p', '', 'Start an empty world and add places by hand, let the AI build one from your lorebooks or a description, or use a world from your library.'));
    const actions = el('div', 'ct-wm-empty-actions');
    actions.append(
        button('menu_button ct-wm-btn is-primary', '<i class="fa-solid fa-wand-magic-sparkles"></i> Generate a world…', '', () => openGenerator(mapState())),
        button('menu_button ct-wm-btn', '<i class="fa-solid fa-plus"></i> Empty world', '', () => {
            ensureWorld();
            render();
        }),
    );
    if (listWorlds().length) actions.append(button('menu_button ct-wm-btn', '<i class="fa-solid fa-book-atlas"></i> Pick from the library', '', () => void openLibrary()));
    box.append(actions);
    if (globalThis.HomunculusScene && !globalThis.HomunculusScene.enabledAgent?.('map')) {
        box.append(el('p', 'ct-wm-muted', 'Tip: switch on the "Scene: Map" tracker (Group Studio → Scene, or the Agents drawer) so the map follows the story.'));
    }
    return box;
}

// ── Left: suggestions and the tree ──

function renderTree(state) {
    const side = el('aside', 'ct-wm-side');
    side.setAttribute('aria-label', 'All places');
    const search = el('input', 'text_pole ct-wm-search');
    search.type = 'search';
    search.placeholder = 'Search places…';
    search.value = page.search;
    search.setAttribute('aria-label', 'Search places');
    search.addEventListener('input', () => {
        page.search = search.value;
        const pos = search.selectionStart;
        render();
        const again = page.root.querySelector('.ct-wm-search');
        again?.focus();
        again?.setSelectionRange?.(pos, pos);
    });
    side.append(search);

    if (state.pending.length) {
        const box = el('div', 'ct-wm-pending');
        box.append(el('div', 'ct-wm-pending-title', `Suggested by the tracker · ${state.pending.length}`));
        for (const item of state.pending.slice(0, 8)) {
            const row = el('div', 'ct-wm-pending-item');
            const name = el('div', 'ct-wm-pending-name');
            name.append(el('b', '', item.place.name));
            const parent = state.places.get(item.place.parent)?.name ?? state.pending.find(entry => entry.place.id === item.place.parent)?.place.name;
            if (parent) name.append(el('span', 'ct-wm-muted', ` in ${parent}`));
            row.append(name);
            if (item.place.description) row.append(el('div', 'ct-wm-muted ct-wm-small', item.place.description));
            const actions = el('div', 'ct-wm-row-actions');
            actions.append(
                button('ct-wm-chip is-on', 'Add', `Add ${item.place.name} to the map`, () => {
                    acceptPending(item.place.id);
                    render();
                }),
                button('ct-wm-chip', 'Edit first', 'Add it and open it to edit', () => {
                    acceptPending(item.place.id);
                    select(item.place.id);
                }),
                button('ct-wm-chip', 'Skip', 'Leave it out', () => {
                    skipPending(item.place.id);
                    render();
                }),
            );
            row.append(actions);
            box.append(row);
        }
        side.append(box);
    }

    const head = el('div', 'ct-wm-side-head');
    head.append(el('span', 'ct-wm-kicker', `All places · ${state.places.size}`), button('ct-wm-chip', '<i class="fa-solid fa-plus"></i> Add', 'Add a place where the map is open', () => addPlace(page.focus || '')));
    side.append(head);

    const tree = el('div', 'ct-wm-tree');
    tree.setAttribute('role', 'tree');
    const term = keyOf(page.search);
    if (term) {
        const hits = [...state.places.values()].filter(place => keyOf(place.name).includes(term) || keyOf(place.description).includes(term));
        for (const place of hits) tree.append(treeRow(state, place, 0, { path: true }));
        if (!hits.length) tree.append(el('p', 'ct-wm-muted ct-wm-pad', 'No place matches.'));
    } else {
        const walk = (parentId, depth) => {
            const kids = childrenOf(state.places, parentId).sort(sortPlaces);
            for (const place of kids) {
                tree.append(treeRow(state, place, depth));
                if (!page.collapsed.has(place.id)) walk(place.id, depth + 1);
            }
        };
        walk('', 0);
        if (!state.places.size) tree.append(el('p', 'ct-wm-muted ct-wm-pad', 'No places yet. Add one, generate some, or let the Map tracker find them as the story goes.'));
    }
    side.append(tree);
    return side;
}

function sortPlaces(a, b) {
    if (a.order !== null || b.order !== null) return (b.order ?? -Infinity) - (a.order ?? -Infinity);
    return a.name.localeCompare(b.name);
}

function treeRow(state, place, depth, { path = false } = {}) {
    const hasKids = childrenOf(state.places, place.id).length > 0;
    const here = place.id === state.current;
    const row = el('div', `ct-wm-tree-row${place.id === page.selected ? ' is-on' : ''}${here ? ' is-here' : ''} is-${place.status}`);
    row.style.setProperty('--ct-wm-depth', String(Math.min(depth, 10)));
    row.setAttribute('role', 'treeitem');
    if (hasKids) row.setAttribute('aria-expanded', String(!page.collapsed.has(place.id)));
    const fold = button('ct-wm-fold', hasKids ? '<i class="fa-solid fa-chevron-down"></i>' : '', hasKids ? (page.collapsed.has(place.id) ? 'Show what is inside' : 'Hide what is inside') : '', (event) => {
        event.stopPropagation();
        if (!hasKids) return;
        if (page.collapsed.has(place.id)) page.collapsed.delete(place.id);
        else page.collapsed.add(place.id);
        render();
    });
    if (!hasKids) fold.tabIndex = -1;
    if (page.collapsed.has(place.id)) fold.classList.add('is-closed');
    const main = button('ct-wm-tree-main', '', '', () => select(place.id));
    main.append(el('span', 'ct-wm-dot'), el('span', 'ct-wm-tree-name', place.name));
    if (path) {
        const chain = ancestors(state.places, place.id).map(id => state.places.get(id).name).reverse().join(' › ');
        if (chain) main.append(el('span', 'ct-wm-muted ct-wm-small', chain));
    }
    if (here) main.append(el('span', 'ct-wm-here-tag', 'here'));
    main.addEventListener('dblclick', () => {
        if (hasKids) focusOn(place.id);
    });
    main.title = hasKids ? `${place.name} (double-click to open inside)` : place.name;
    row.append(fold, main);
    return row;
}

// ── Center: map, list or floors of the open place ──

function renderCenter(state) {
    const center = el('main', 'ct-wm-center');
    const bar = el('div', 'ct-wm-bar');
    const crumbs = el('nav', 'ct-wm-crumbs');
    crumbs.setAttribute('aria-label', 'Map level');
    crumbs.append(button(`ct-wm-crumb${page.focus ? '' : ' is-on'}`, '<i class="fa-solid fa-earth-americas"></i> All', 'Show the top level', () => focusOn('')));
    const chain = page.focus ? [...ancestors(state.places, page.focus).reverse(), page.focus] : [];
    for (const id of chain) {
        crumbs.append(el('span', 'ct-wm-muted', '›'));
        const crumb = button(`ct-wm-crumb${id === page.focus ? ' is-on' : ''}`, '', `Show the map of ${state.places.get(id).name}`, () => focusOn(id));
        crumb.textContent = state.places.get(id).name;
        crumbs.append(crumb);
    }
    const home = state.current && state.places.get(state.current)?.parent && state.places.has(state.places.get(state.current).parent) ? state.places.get(state.current).parent : '';
    if (state.current && home !== page.focus) {
        crumbs.append(button('ct-wm-crumb is-here', '<i class="fa-solid fa-location-crosshairs"></i> Here', 'Show where the story is', () => {
            page.focus = home;
            page.selected = state.current;
            page.mapView = {};
            render();
        }));
    }
    bar.append(crumbs, el('span', 'ct-wm-grow'));
    const holder = page.focus ? state.places.get(page.focus) : null;
    const view = holder?.view || 'map';
    if (holder) {
        bar.append(el('span', 'ct-wm-muted', 'Show as'));
        const seg = el('div', 'ct-wm-segment');
        seg.setAttribute('role', 'group');
        seg.setAttribute('aria-label', 'Show the places inside as');
        for (const [id, label] of [['map', 'Map'], ['list', 'List'], ['floors', 'Floors']]) {
            const b = button(view === id ? 'is-on' : '', label, '', () => updatePlace(holder.id, { view: id }));
            b.setAttribute('aria-pressed', String(view === id));
            seg.append(b);
        }
        bar.append(seg);
    }
    center.append(bar);

    const kids = childrenOf(state.places, page.focus || '');
    const stage = el('div', 'ct-wm-stage');
    if (!kids.length) {
        const empty = el('div', 'ct-wm-stage-empty');
        empty.append(el('p', '', holder ? `Nothing inside ${holder.name} yet.` : 'No places yet.'));
        empty.append(button('menu_button ct-wm-btn', '<i class="fa-solid fa-plus"></i> Add a place here', '', () => addPlace(page.focus || '')));
        stage.append(empty);
    } else if (view === 'list') {
        stage.append(renderList(state, kids));
    } else if (view === 'floors') {
        stage.append(renderFloors(state, kids));
    } else {
        const trail = state.timeline.map(item => item.placeId);
        const level = mapLevel({ places: state.places, current: state.current }, page.focus || '', trail);
        const width = Math.max(320, window.innerWidth - 300 - 380);
        const height = Math.max(260, window.innerHeight - 58 - 50 - 46);
        stage.append(drawMap(level, {
            width,
            height,
            selected: page.selected,
            state: page.mapView,
            viewKey: `${state.world.id}|${page.focus}`,
            title: `Map of ${holder?.name ?? 'all places'}`,
            onPick: id => select(id, { reveal: false }),
            onMove: (id, x, y) => updatePlace(id, { x, y, edited: true }),
        }));
        const legend = el('div', 'ct-wm-legend');
        for (const [cls, label] of [['here', 'You are here'], ['visited', 'Visited'], ['known', 'Known'], ['rumored', 'Rumored'], ['inside', 'Has places inside']]) {
            const item = el('span', `ct-sc-map-key is-${cls}`);
            item.append(el('span', 'ct-sc-map-swatch'), document.createTextNode(label));
            legend.append(item);
        }
        legend.append(el('span', 'ct-wm-muted', 'Drag a place to move it · drag the background to pan · scroll to zoom'));
        stage.append(legend);
        const foot = el('div', 'ct-wm-foot');
        const unplaced = level.places.filter(place => !place.placed);
        if (unplaced.length) {
            const part = el('span', '');
            part.append(el('span', 'ct-wm-muted', 'No direction yet: '));
            unplaced.forEach((place, index) => {
                const b = button('ct-wm-link', '', `Put ${place.name} on the map`, () => updatePlace(place.id, { x: 50 + ((index * 7) % 20), y: 50 + ((index * 11) % 20), edited: true }, { select: true }));
                b.textContent = `${place.name} (place it)`;
                part.append(b);
                if (index < unplaced.length - 1) part.append(document.createTextNode(', '));
            });
            foot.append(part);
        }
        if (level.exits.length) {
            const part = el('span', '');
            part.append(el('span', 'ct-wm-muted', 'Ways out: '));
            level.exits.forEach((exit, index) => {
                const target = state.places.get(exit.to);
                const b = button('ct-wm-link', '', `Show ${target?.name ?? exit.to}`, () => select(exit.to));
                b.textContent = `${target?.name ?? exit.to}${exit.travel ? ` (${exit.travel})` : ''}`;
                part.append(b);
                if (index < level.exits.length - 1) part.append(document.createTextNode(' · '));
            });
            foot.append(part);
        }
        if (foot.childElementCount) stage.append(foot);
    }
    center.append(stage);
    return center;
}

function placeRow(state, place, extra = null) {
    const row = el('div', `ct-wm-list-row${place.id === page.selected ? ' is-on' : ''} is-${place.id === state.current ? 'here' : place.status}`);
    const main = button('ct-wm-list-main', '', '', () => select(place.id, { reveal: false }));
    main.append(el('span', 'ct-wm-dot'));
    const text = el('span', 'ct-wm-list-text');
    text.append(el('b', '', place.name), el('span', 'ct-wm-muted ct-wm-small', [place.id === state.current ? 'You are here' : STATUS_INFO[place.status][0], place.kind, travelFrom(state.places, state.current, place.id), childrenOf(state.places, place.id).length ? `${childrenOf(state.places, place.id).length} inside` : ''].filter(Boolean).join(' · ')));
    if (place.description) text.append(el('span', 'ct-wm-small', place.description));
    main.append(text);
    main.addEventListener('dblclick', () => {
        if (childrenOf(state.places, place.id).length) focusOn(place.id);
    });
    row.append(main);
    if (extra) row.append(extra);
    return row;
}

function renderList(state, kids) {
    const list = el('div', 'ct-wm-list');
    for (const place of kids.sort(sortPlaces)) list.append(placeRow(state, place));
    return list;
}

/** Floors: top floor first; the arrows change the order. */
function renderFloors(state, kids) {
    const ordered = [...kids].sort((a, b) => (b.order ?? 0) - (a.order ?? 0) || a.name.localeCompare(b.name));
    const list = el('div', 'ct-wm-list ct-wm-floors');
    const reorder = (from, to) => {
        const next = [...ordered];
        const [item] = next.splice(from, 1);
        next.splice(to, 0, item);
        const world = chatWorld();
        const places = placesOf(world);
        next.forEach((place, index) => {
            places.get(place.id).order = next.length - index;
        });
        storePlaces(world, places);
        render();
    };
    ordered.forEach((place, index) => {
        const arrows = el('span', 'ct-wm-row-actions');
        const up = button('ct-wm-icon', '<i class="fa-solid fa-arrow-up"></i>', `Move ${place.name} up`, () => reorder(index, index - 1));
        up.disabled = index === 0;
        const down = button('ct-wm-icon', '<i class="fa-solid fa-arrow-down"></i>', `Move ${place.name} down`, () => reorder(index, index + 1));
        down.disabled = index === ordered.length - 1;
        arrows.append(up, down);
        list.append(placeRow(state, place, arrows));
    });
    return list;
}

// ── Right: the place ──

function renderDetails(state) {
    const side = el('aside', 'ct-wm-details');
    side.setAttribute('aria-label', 'Place');
    const place = state.places.get(page.selected);
    if (!place) {
        side.append(el('p', 'ct-wm-muted ct-wm-pad', 'Pick a place on the map or in the list to see it here.'));
        if (state.current) side.append(button('menu_button ct-wm-btn', '<i class="fa-solid fa-location-crosshairs"></i> Where the story is', '', () => select(state.current)));
        return side;
    }
    const top = el('div', 'ct-wm-detail-top');
    const name = el('input', 'text_pole ct-wm-name');
    name.value = place.name;
    name.setAttribute('aria-label', 'Name');
    name.addEventListener('change', () => updatePlace(place.id, { name: name.value.trim() || place.name }));
    const here = place.id === state.current;
    top.append(name, el('span', `ct-sc-pill ct-sc-place-pill is-${here ? 'here' : place.status}`, here ? 'You are here' : STATUS_INFO[place.status][0]));
    side.append(top);
    const chain = ancestors(state.places, place.id).map(id => state.places.get(id).name);
    side.append(el('span', 'ct-wm-muted ct-wm-small', chain.length ? `in ${chain.join(' › ')}` : 'Top level'));

    const grid = el('div', 'ct-wm-grid');
    const field = (label, control) => {
        const wrap = el('label', 'ct-wm-field');
        wrap.append(el('span', 'ct-wm-label', label), control);
        return wrap;
    };
    const kind = el('input', 'text_pole');
    kind.value = place.kind;
    kind.setAttribute('list', 'ct-wm-kinds');
    kind.addEventListener('change', () => updatePlace(place.id, { kind: kind.value.trim().toLowerCase() }));
    const kinds = el('datalist');
    kinds.id = 'ct-wm-kinds';
    for (const item of KINDS) {
        const option = el('option');
        option.value = item;
        kinds.append(option);
    }
    const status = el('select', 'text_pole');
    for (const item of PLACE_STATES) {
        const option = el('option', '', STATUS_INFO[item][0]);
        option.value = item;
        option.selected = item === place.status;
        status.append(option);
    }
    status.addEventListener('change', () => updatePlace(place.id, { status: status.value, edited: true }));
    grid.append(field('Kind', kind), field('Status', status), kinds);
    side.append(grid);

    const parent = el('select', 'text_pole');
    const topOption = el('option', '', '(top level)');
    topOption.value = '';
    parent.append(topOption);
    for (const item of [...state.places.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        if (isInside(state.places, item.id, place.id)) continue;
        const option = el('option', '', item.name);
        option.value = item.id;
        option.selected = item.id === place.parent;
        parent.append(option);
    }
    parent.addEventListener('change', () => updatePlace(place.id, { parent: parent.value }, { select: true }));
    side.append(field('Inside', parent));

    const textArea = (value, rows, placeholder, onChange) => {
        const area = el('textarea', 'text_pole');
        area.rows = rows;
        area.value = value;
        area.placeholder = placeholder;
        area.addEventListener('change', () => onChange(area.value.trim()));
        return area;
    };
    side.append(field('Description', textArea(place.description, 3, 'What it looks like and what matters there', value => updatePlace(place.id, { description: value, edited: true }))));
    const secretWrap = field('Notes only the AI sees', textArea(place.secret, 2, 'Hidden doors, traps, who is really here…', value => updatePlace(place.id, { secret: value })));
    secretWrap.querySelector('.ct-wm-label').append(helpButton('Notes only the AI sees', HELP.secret));
    side.append(secretWrap);

    // Routes
    const routesHead = el('div', 'ct-wm-side-head');
    routesHead.append(el('span', 'ct-wm-label', 'Routes'), helpButton('Routes', HELP.routes));
    side.append(routesHead);
    const routes = el('div', 'ct-wm-routes');
    const incoming = [...state.places.values()].filter(other => other.id !== place.id && other.links.some(link => link.to === place.id && !link.oneWay) && !place.links.some(link => link.to === other.id));
    for (const link of place.links) {
        const target = state.places.get(link.to);
        if (!target) continue;
        const row = el('div', 'ct-wm-route');
        const go = button('ct-wm-link', '', `Show ${target.name}`, () => select(target.id));
        go.textContent = target.name;
        const travel = el('input', 'text_pole ct-wm-travel');
        travel.value = link.travel;
        travel.placeholder = 'time';
        travel.setAttribute('aria-label', `Travel time to ${target.name}`);
        travel.addEventListener('change', () => editLink(place.id, link.to, { travel: travel.value.trim() }));
        const way = button(`ct-wm-chip${link.oneWay ? ' is-on' : ''}`, link.oneWay ? 'one-way' : 'two-way', 'Switch between one-way and two-way', () => editLink(place.id, link.to, { oneWay: !link.oneWay }));
        row.append(go, travel, way, button('ct-wm-icon is-danger', '<i class="fa-solid fa-xmark"></i>', `Remove the route to ${target.name}`, () => editLink(place.id, link.to, null)));
        routes.append(row);
    }
    for (const other of incoming) {
        const back = other.links.find(link => link.to === place.id);
        const row = el('div', 'ct-wm-route is-incoming');
        const go = button('ct-wm-link', '', `Show ${other.name}`, () => select(other.id));
        go.textContent = other.name;
        row.append(go, el('span', 'ct-wm-muted ct-wm-small', `${back.travel || '?'} · set on ${other.name}`));
        routes.append(row);
    }
    const add = el('div', 'ct-wm-route is-new');
    const to = el('select', 'text_pole');
    to.setAttribute('aria-label', 'New route to');
    const pick = el('option', '', 'Add a route to…');
    pick.value = '';
    to.append(pick);
    for (const item of [...state.places.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        if (item.id === place.id || place.links.some(link => link.to === item.id)) continue;
        const option = el('option', '', item.name);
        option.value = item.id;
        to.append(option);
    }
    to.addEventListener('change', () => {
        if (to.value) editLink(place.id, to.value, { travel: '' });
    });
    add.append(to);
    routes.append(add);
    side.append(routes);

    const actions = el('div', 'ct-wm-actions');
    if (childrenOf(state.places, place.id).length) actions.append(button('menu_button ct-wm-btn is-primary', '<i class="fa-solid fa-magnifying-glass-plus"></i> Open inside', `Show the places inside ${place.name}`, () => focusOn(place.id)));
    actions.append(button('menu_button ct-wm-btn', '<i class="fa-solid fa-plus"></i> Add place inside', '', () => addPlace(place.id)));
    if (!here) actions.append(button('menu_button ct-wm-btn', '<i class="fa-solid fa-person-walking-arrow-right"></i> Move the story here', 'From the next reply on, the story is here', () => {
        moveTo(place.id);
        toastr.success(`The story is now in ${place.name}.`);
        render();
    }));
    side.append(actions);
    const danger = el('div', 'ct-wm-danger');
    danger.append(button('ct-wm-link is-danger', '<i class="fa-solid fa-trash-can"></i> Delete', `Delete ${place.name}`, () => void deletePlace(place.id)));
    side.append(danger);
    return side;
}

function updatePlace(id, changes, { select: reselect = false } = {}) {
    const world = chatWorld();
    if (!world) return;
    const places = placesOf(world);
    const old = places.get(id);
    if (!old) return;
    const next = normalizePlace({ ...old, ...changes, edited: true }, null);
    if (changes.edited || old.edited) next.edited = true;
    places.set(id, next);
    storePlaces(world, places);
    if (reselect) select(id);
    else render();
}

function editLink(fromId, toId, changes) {
    const world = chatWorld();
    const places = placesOf(world);
    const place = places.get(fromId);
    if (!place) return;
    const links = place.links.filter(link => link.to !== toId);
    if (changes) {
        const old = place.links.find(link => link.to === toId) ?? { to: toId, travel: '' };
        const next = { ...old, ...changes };
        if (!next.oneWay) delete next.oneWay;
        links.push(next);
    }
    place.links = links;
    storePlaces(world, places);
    render();
}

async function addPlace(parentId) {
    const name = await Popup.show.input('New place', 'What is it called?', '');
    if (!name || !String(name).trim()) return;
    const world = ensureWorld();
    const places = placesOf(world);
    let id = cleanId(name);
    for (let n = 2; places.has(id); n++) id = `${cleanId(name)}-${n}`;
    const siblings = childrenOf(places, parentId || '').filter(place => place.x !== null);
    const place = normalizePlace({ id, name: String(name).trim(), parent: parentId || '', status: 'known', x: siblings.length ? null : 50, y: siblings.length ? null : 50 });
    place.edited = true;
    places.set(id, place);
    storePlaces(world, places);
    page.focus = parentId || '';
    select(id, { reveal: false });
}

async function deletePlace(id) {
    const world = chatWorld();
    const places = placesOf(world);
    const place = places.get(id);
    if (!place) return;
    const kids = childrenOf(places, id);
    const ok = await new Popup(`<p>Delete <b>${escapeHtml(place.name)}</b>?${kids.length ? ` The ${kids.length} place${kids.length === 1 ? '' : 's'} inside move up one level.` : ''}</p>`, POPUP_TYPE.CONFIRM, '', { okButton: 'Delete', cancelButton: 'Cancel' }).show();
    if (ok !== POPUP_RESULT.AFFIRMATIVE) return;
    for (const kid of kids) kid.parent = place.parent;
    for (const other of places.values()) other.links = other.links.filter(link => link.to !== id);
    places.delete(id);
    storePlaces(world, places);
    page.selected = place.parent || '';
    if (page.focus === id) page.focus = place.parent || '';
    render();
}

// ───────────────────────── Library ─────────────────────────

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

async function openLibrary() {
    const box = el('div', 'ct-wm-library');
    const paint = () => {
        box.replaceChildren();
        const head = el('div', 'ct-wm-side-head');
        head.append(el('h3', '', 'Worlds'), helpButton('Library', HELP.library));
        box.append(head);
        const current = chatWorld()?.id;
        const list = el('div', 'ct-wm-lib-list');
        for (const world of listWorlds()) {
            const row = el('div', `ct-wm-lib-row${world.id === current ? ' is-on' : ''}`);
            const text = el('div', 'ct-wm-lib-text');
            text.append(el('b', '', world.name), el('span', 'ct-wm-muted ct-wm-small', `${Object.keys(world.places ?? {}).length} places${world.id === current ? ' · used by this chat' : ''}`));
            const actions = el('div', 'ct-wm-row-actions');
            if (world.id !== current) actions.append(button('ct-wm-chip is-on', 'Use here', 'Use this world in this chat', () => {
                useWorld(world.id);
                page.focus = null;
                paint();
                open();
            }));
            actions.append(
                button('ct-wm-icon', '<i class="fa-solid fa-pen"></i>', `Rename ${world.name}`, async () => {
                    const name = await Popup.show.input('Rename world', '', world.name);
                    if (name && String(name).trim()) {
                        world.name = String(name).trim();
                        saveWorld(world);
                        paint();
                        render();
                    }
                }),
                button('ct-wm-icon', '<i class="fa-solid fa-copy"></i>', `Duplicate ${world.name}`, () => {
                    createWorld(`${world.name} (copy)`, structuredClone(world.places ?? {}));
                    paint();
                }),
                button('ct-wm-icon', '<i class="fa-solid fa-file-export"></i>', `Export ${world.name}`, () => download(`${world.name}.world.json`, `${JSON.stringify({ format: 'homunculus-world', version: 1, world: { name: world.name, places: world.places } }, null, 2)}\n`)),
                button('ct-wm-icon is-danger', '<i class="fa-solid fa-trash-can"></i>', `Delete ${world.name}`, async () => {
                    const ok = await new Popup(`<p>Delete the world <b>${escapeHtml(world.name)}</b> and its ${Object.keys(world.places ?? {}).length} places? Chats using it lose their map.</p>`, POPUP_TYPE.CONFIRM, '', { okButton: 'Delete', cancelButton: 'Cancel' }).show();
                    if (ok !== POPUP_RESULT.AFFIRMATIVE) return;
                    delete settings().worlds[world.id];
                    saveSettingsDebounced();
                    if (world.id === current) useWorld('');
                    paint();
                    render();
                }),
            );
            row.append(text, actions);
            list.append(row);
        }
        if (!listWorlds().length) list.append(el('p', 'ct-wm-muted', 'No worlds yet.'));
        box.append(list);
        const foot = el('div', 'ct-wm-row-actions');
        const file = el('input');
        file.type = 'file';
        file.accept = '.json,application/json';
        file.hidden = true;
        file.addEventListener('change', async () => {
            const picked = file.files?.[0];
            if (!picked) return;
            try {
                const data = JSON.parse(await picked.text());
                const raw = data?.world ?? data;
                const places = Array.isArray(raw?.places) ? Object.fromEntries(raw.places.map(p => normalizePlace(p)).filter(Boolean).map(p => [p.id, p])) : raw?.places;
                if (!places || typeof places !== 'object') throw new Error('No places found in this file.');
                createWorld(raw.name || picked.name.replace(/\.json$/i, ''), places);
                toastr.success('World imported.');
                paint();
            } catch (error) {
                toastr.error(String(error?.message ?? error), 'Import failed');
            }
        });
        foot.append(
            button('menu_button ct-wm-btn', '<i class="fa-solid fa-plus"></i> New empty world', '', () => {
                createWorld('New world');
                paint();
            }),
            button('menu_button ct-wm-btn', '<i class="fa-solid fa-file-import"></i> Import', '', () => file.click()),
            file,
        );
        box.append(foot);
    };
    paint();
    await new Popup(box, POPUP_TYPE.TEXT, '', { okButton: 'Close', wide: true, leftAlign: true, allowVerticalScrolling: true }).show();
    render();
}

// ───────────────────────── Generator ─────────────────────────

function promptList() {
    return [{ id: 'default', name: 'Default map builder', text: DEFAULT_PROMPT, builtin: true }, ...settings().prompts.filter(item => item && item.id)];
}

/** Lorebooks this chat already uses: global, chat, character (and group members). */
function chatLorebooks() {
    const out = new Set(Array.isArray(selected_world_info) ? selected_world_info : []);
    if (chat_metadata?.[METADATA_KEY]) out.add(chat_metadata[METADATA_KEY]);
    const members = selected_group ? (groups.find(item => String(item.id) === String(selected_group))?.members ?? []) : [];
    const chars = selected_group ? characters.filter(character => members.includes(character.avatar)) : [characters?.[this_chid]].filter(Boolean);
    for (const character of chars) if (character?.data?.extensions?.world) out.add(character.data.extensions.world);
    return [...out].filter(name => (world_names ?? []).includes(name));
}

function chatCharacters() {
    const members = selected_group ? (groups.find(item => String(item.id) === String(selected_group))?.members ?? []) : [];
    return selected_group ? characters.filter(character => members.includes(character.avatar)) : [characters?.[this_chid]].filter(Boolean);
}

function openGenerator(state) {
    const saved = settings().generator;
    // Builds where the map is open: inside that place, else the top level (or a new world when there is none).
    const target = state.world ? (page.focus && state.places.has(page.focus) ? page.focus : 'top') : 'new';
    page.gen = {
        step: 'setup',
        books: new Set(chatLorebooks()),
        cards: chatCharacters().length > 0,
        text: '',
        target,
        canon: saved.canon || 'expand',
        size: saved.size || 'medium',
        profile: saved.profile || '',
        promptId: saved.promptId && promptList().some(item => item.id === saved.promptId) ? saved.promptId : 'default',
        draft: null,
        picked: new Set(),
        error: '',
    };
    render();
}

function renderGenerator(state) {
    const gen = page.gen;
    const overlay = el('div', 'ct-wm-overlay');
    const dialog = el('section', 'ct-wm-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', 'Generate places');
    const head = el('header', 'ct-wm-dialog-head');
    const title = el('h3', '', 'Generate places');
    title.append(helpButton('Generate', HELP.generate));
    head.append(title);
    const steps = el('div', 'ct-wm-steps');
    steps.append(el('span', gen.step === 'setup' || gen.step === 'loading' ? 'is-on' : '', '1 · What to build'), el('span', 'ct-wm-muted', '›'), el('span', gen.step === 'draft' ? 'is-on' : '', '2 · Review the draft'));
    head.append(steps, el('span', 'ct-wm-grow'), button('ct-wm-icon', '<i class="fa-solid fa-xmark"></i>', 'Close', () => {
        page.gen = null;
        render();
    }));
    dialog.append(head);
    if (gen.step === 'draft') dialog.append(...renderDraft(state));
    else dialog.append(...renderSetup(state));
    overlay.append(dialog);
    overlay.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.stopPropagation();
            page.gen = null;
            render();
        }
    });
    return overlay;
}

function renderSetup(state) {
    const gen = page.gen;
    const body = el('div', 'ct-wm-dialog-body ct-wm-two');
    const left = el('div', 'ct-wm-col');
    const right = el('div', 'ct-wm-col');

    left.append(el('span', 'ct-wm-kicker', 'Read from'));
    const books = el('div', 'ct-wm-checks');
    const names = [...(world_names ?? [])].sort((a, b) => Number(gen.books.has(b)) - Number(gen.books.has(a)) || a.localeCompare(b));
    for (const name of names) {
        const label = el('label', 'ct-wm-check');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = gen.books.has(name);
        box.addEventListener('change', () => {
            if (box.checked) gen.books.add(name);
            else gen.books.delete(name);
        });
        label.append(box, el('span', '', name), el('span', 'ct-wm-muted ct-wm-small', 'lorebook'));
        books.append(label);
    }
    if (!names.length) books.append(el('p', 'ct-wm-muted ct-wm-small', 'No lorebooks yet.'));
    const cards = chatCharacters();
    if (cards.length) {
        const label = el('label', 'ct-wm-check');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = gen.cards;
        box.addEventListener('change', () => {
            gen.cards = box.checked;
        });
        label.append(box, el('span', '', 'Character cards'), el('span', 'ct-wm-muted ct-wm-small', cards.map(c => c.name).join(', ')));
        books.prepend(label);
    }
    left.append(books);
    const text = el('textarea', 'text_pole');
    text.rows = 5;
    text.value = gen.text;
    text.placeholder = 'Your own description (optional): "A port city on three islands joined by bridges. The docks flood at high tide…"';
    text.addEventListener('input', () => {
        gen.text = text.value;
    });
    const textWrap = el('label', 'ct-wm-field');
    textWrap.append(el('span', 'ct-wm-label', 'Your description'), text);
    left.append(textWrap);

    const target = el('select', 'text_pole');
    const addOption = (value, label) => {
        const option = el('option', '', label);
        option.value = value;
        option.selected = gen.target === value;
        target.append(option);
    };
    addOption('new', 'A new world');
    if (state.world) {
        addOption('top', `${state.world.name}: at the top level`);
        for (const place of [...state.places.values()].sort((a, b) => a.name.localeCompare(b.name))) addOption(place.id, `Inside ${place.name}`);
    }
    target.addEventListener('change', () => {
        gen.target = target.value;
    });
    right.append(fieldBox('Put the new places', target));

    right.append(el('span', 'ct-wm-kicker', 'Lore'));
    const canon = el('div', 'ct-wm-cards');
    for (const [id, label, desc] of [['strict', 'Only what the lore says', 'Places the sources name, nothing invented.'], ['expand', 'Lore + fill the gaps', 'Adds fitting places where the sources are silent.']]) {
        const b = button(`ct-wm-card${gen.canon === id ? ' is-on' : ''}`, '', '', () => {
            gen.canon = id;
            render();
        });
        b.append(el('b', '', label), el('span', 'ct-wm-muted ct-wm-small', desc));
        b.setAttribute('aria-pressed', String(gen.canon === id));
        canon.append(b);
    }
    right.append(canon);
    right.append(el('span', 'ct-wm-kicker', 'Size'));
    const sizes = el('div', 'ct-wm-cards is-three');
    for (const [id, label, count] of SIZES) {
        const b = button(`ct-wm-card${gen.size === id ? ' is-on' : ''}`, '', '', () => {
            gen.size = id;
            render();
        });
        b.append(el('b', '', label), el('span', 'ct-wm-muted ct-wm-small', `~${count} places`));
        b.setAttribute('aria-pressed', String(gen.size === id));
        sizes.append(b);
    }
    right.append(sizes);

    const two = el('div', 'ct-wm-grid');
    const profile = el('select', 'text_pole');
    const same = el('option', '', 'Same as the chat');
    same.value = '';
    profile.append(same);
    for (const item of connectionProfiles()) {
        const option = el('option', '', item.name);
        option.value = item.id;
        option.selected = item.id === gen.profile;
        profile.append(option);
    }
    profile.addEventListener('change', () => {
        gen.profile = profile.value;
    });
    const prompt = el('select', 'text_pole');
    for (const item of promptList()) {
        const option = el('option', '', item.name);
        option.value = item.id;
        option.selected = item.id === gen.promptId;
        prompt.append(option);
    }
    prompt.addEventListener('change', () => {
        gen.promptId = prompt.value;
    });
    two.append(fieldBox('Model', profile), fieldBox('Prompt', prompt));
    right.append(two, button('ct-wm-chip', '<i class="fa-solid fa-pen"></i> Edit prompt…', 'See and change the instructions sent to the AI', () => void editPrompt()));

    body.append(left, right);
    const foot = el('footer', 'ct-wm-dialog-foot');
    if (gen.error) foot.append(el('span', 'ct-wm-error', gen.error));
    else foot.append(el('span', 'ct-wm-muted ct-wm-small', 'One AI call. Nothing changes until you accept the draft.'));
    foot.append(el('span', 'ct-wm-grow'), button('menu_button ct-wm-btn', 'Cancel', '', () => {
        page.gen = null;
        render();
    }));
    const go = button('menu_button ct-wm-btn is-primary', gen.step === 'loading' ? '<i class="fa-solid fa-spinner fa-spin"></i> Building…' : '<i class="fa-solid fa-wand-magic-sparkles"></i> Generate draft', '', () => void runGenerator(state));
    go.disabled = gen.step === 'loading';
    foot.append(go);
    return [body, foot];
}

function fieldBox(label, control) {
    const wrap = el('label', 'ct-wm-field');
    wrap.append(el('span', 'ct-wm-label', label), control);
    return wrap;
}

async function editPrompt() {
    const gen = page.gen;
    const current = promptList().find(item => item.id === gen.promptId) ?? promptList()[0];
    const box = el('div', 'ct-wm-prompt-edit');
    box.append(el('p', 'ct-wm-muted ct-wm-small', 'Macros filled in for you: {{sources}}, {{target}}, {{canon}}, {{size}}, {{existing}}. Saving a built-in prompt makes your own copy.'));
    const name = el('input', 'text_pole');
    name.value = current.builtin ? 'My map prompt' : current.name;
    name.setAttribute('aria-label', 'Prompt name');
    const area = el('textarea', 'text_pole');
    area.rows = 22;
    area.value = current.text;
    box.append(fieldBox('Name', name), fieldBox('Prompt', area));
    const result = await new Popup(box, POPUP_TYPE.TEXT, '', { okButton: 'Save', cancelButton: 'Cancel', wide: true, large: true, leftAlign: true, allowVerticalScrolling: true }).show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;
    const list = settings().prompts;
    if (current.builtin) {
        const copy = { id: newId('prompt'), name: name.value.trim() || 'My map prompt', text: area.value };
        list.push(copy);
        gen.promptId = copy.id;
    } else {
        current.name = name.value.trim() || current.name;
        current.text = area.value;
    }
    saveSettingsDebounced();
    render();
}

async function lorebookText(names, budget) {
    const parts = [];
    let used = 0;
    for (const name of names) {
        const data = await loadWorldInfo(name);
        const entries = Object.values(data?.entries ?? {}).filter(entry => entry && !entry.disable && str(entry.content).trim());
        const lines = [`### Lorebook: ${name}`];
        for (const entry of entries) {
            const titleText = str(entry.comment).trim() || (Array.isArray(entry.key) ? entry.key.join(', ') : str(entry.key));
            const line = `- ${titleText}: ${str(entry.content).replace(/\s+/g, ' ').trim()}`;
            if (used + line.length > budget) break;
            lines.push(line);
            used += line.length;
        }
        parts.push(lines.join('\n'));
        if (used > budget) break;
    }
    return parts.join('\n\n');
}

/**
 * Asks the AI for the map and returns its raw answer. Unlike generateRaw, this skips the chat's
 * clean-up (regex scripts, name trimming), which can blank out an answer that is only a [MAP] block,
 * and it says why an answer came back empty.
 */
async function askForMap(profileId, system, user, maxTokens) {
    const context = globalThis.SillyTavern?.getContext?.();
    const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
    let text = '';
    let thinking = '';
    let finish = '';
    const useProfile = profileId && connectionProfiles().some(profile => profile.id === profileId) && context?.ConnectionManagerRequestService;
    if (useProfile) {
        const result = await context.ConnectionManagerRequestService.sendRequest(profileId, messages, maxTokens, { stream: false, extractData: true, includePreset: true, includeInstruct: true });
        text = typeof result === 'string' ? result : str(result?.content);
        thinking = typeof result === 'string' ? '' : str(result?.reasoning);
    } else {
        if (typeof context?.generateRawData !== 'function') throw new Error('The app is not ready to ask the AI yet.');
        const data = await context.generateRawData({ prompt: messages, instructOverride: true, responseLength: maxTokens });
        text = str(context.extractMessageFromData?.(data));
        try {
            thinking = str(extractReasoningFromData(data));
        } catch {
            thinking = '';
        }
        // The app only reads thinking for the source it is set to; look in the usual places too.
        const message = data?.choices?.[0]?.message;
        thinking ||= str(message?.reasoning_content ?? message?.reasoning)
            || (Array.isArray(data?.content) ? data.content.filter(part => part?.type === 'thinking').map(part => str(part.thinking)).join('\n') : '')
            || (Array.isArray(data?.candidates?.[0]?.content?.parts) ? data.candidates[0].content.parts.filter(part => part?.thought).map(part => str(part.text)).join('\n') : '');
        finish = str(data?.choices?.[0]?.finish_reason ?? data?.stop_reason ?? data?.candidates?.[0]?.finishReason);
    }
    text = removeReasoningFromString(text);
    // Some models write the whole answer inside their thinking.
    if (!text.trim() && /\[MAP\]|"places"\s*:/i.test(thinking)) text = thinking;
    if (text.trim()) return text;
    console.warn('[World Map] The AI sent an empty answer.', { finish, thinking: thinking.slice(0, 4000) });
    if (thinking) throw new Error('The AI spent its whole answer thinking and wrote no map. Pick a model without thinking (or lower its thinking) in Model, or try a smaller size.');
    if (/length|max_tokens/i.test(finish)) throw new Error('The AI ran out of room before writing the map. Try a smaller size or fewer lorebooks.');
    if (/content_filter|safety|refus/i.test(finish)) throw new Error('The AI\'s filter blocked the answer. Try another model in Model.');
    throw new Error('The AI sent back an empty answer. Try again, or pick another model in Model.');
}

async function runGenerator(state) {
    const gen = page.gen;
    const books = [...gen.books];
    if (!books.length && !gen.cards && !gen.text.trim()) {
        gen.error = 'Pick a lorebook or the character cards, or write a description.';
        render();
        return;
    }
    gen.error = '';
    gen.step = 'loading';
    Object.assign(settings().generator, { canon: gen.canon, size: gen.size, profile: gen.profile, promptId: gen.promptId });
    saveSettingsDebounced();
    render();
    try {
        const sources = [];
        if (books.length) sources.push(await lorebookText(books, 24000));
        if (gen.cards) {
            for (const character of chatCharacters()) {
                const card = [character.description, character.scenario].map(str).filter(Boolean).join('\n').slice(0, 2000);
                if (card) sources.push(`### Character: ${character.name}\n${card}`);
            }
        }
        if (gen.text.trim()) sources.push(`### The user's description\n${gen.text.trim()}`);
        const holder = state.places.get(gen.target);
        const targetText = gen.target === 'new'
            ? 'a new world. Give it a short name in "world". Top places have parent "".'
            : holder
                ? `places inside "${holder.name}" (id "${holder.id}"). Use parent "${holder.id}" for the places directly inside it.`
                : `more places for the world "${state.world?.name}". Top places have parent "".`;
        const existing = gen.target === 'new' ? '(none: new world)' : [...state.places.values()].slice(0, 200).map(place => `- ${place.id} | ${place.name} | inside: ${place.parent || '-'}`).join('\n') || '(none)';
        const size = SIZES.find(([id]) => id === gen.size)?.[2] ?? 16;
        const template = (promptList().find(item => item.id === gen.promptId) ?? promptList()[0]).text;
        const system = template
            .replaceAll('{{sources}}', sources.join('\n\n') || '(none)')
            .replaceAll('{{target}}', targetText)
            .replaceAll('{{canon}}', gen.canon === 'strict' ? 'only places named or clearly described in the sources; invent nothing.' : 'start from the sources and add fitting places where they are silent.')
            .replaceAll('{{size}}', String(size))
            .replaceAll('{{existing}}', existing);
        const answer = await askForMap(gen.profile, system, 'Build the map now.', 8000);
        const draft = parseDraft(answer, state, gen.target);
        if (!draft.places.length) throw new Error('The AI answered without places. Try again, or change the prompt.');
        gen.draft = draft;
        gen.picked = new Set(draft.places.filter(item => item.tag !== 'same').map(item => item.place.id));
        gen.step = 'draft';
    } catch (error) {
        gen.step = 'setup';
        const cause = error?.cause?.message ?? error?.cause?.error?.message ?? '';
        gen.error = [String(error?.message ?? error), cause].filter(Boolean).join(': ');
        console.warn('[World Map] Generate failed.', error);
    }
    render();
}

function parseDraft(answer, state, target) {
    const text = str(answer);
    const match = text.match(/\[MAP\]([\s\S]*?)(?:\[\/MAP\]|$)/i);
    const inner = (match ? match[1] : text).replace(/```(?:json)?/gi, '');
    const start = inner.indexOf('{');
    const end = inner.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('The AI did not answer with a map.');
    let data;
    try {
        data = JSON.parse(inner.slice(start, end + 1));
    } catch {
        throw new Error('The AI answer was not valid JSON. Try again.');
    }
    const raws = Array.isArray(data?.places) ? data.places : [];
    const known = target === 'new' ? new Map() : state.places;
    const ids = new Set(raws.map(raw => cleanId(raw?.id || raw?.name)).filter(Boolean));
    const places = [];
    for (const raw of raws) {
        const place = normalizePlace(raw);
        if (!place) continue;
        if (place.parent && !ids.has(place.parent) && !known.has(place.parent)) place.parent = '';
        if (!place.parent && target !== 'new' && target !== 'top' && known.has(target) && place.id !== target) place.parent = target;
        const old = known.get(place.id);
        const tag = !old ? 'new' : (old.description !== place.description && place.description ? 'update' : 'same');
        places.push({ place, tag });
    }
    return { worldName: str(data?.world).trim(), places };
}

function renderDraft(state) {
    const gen = page.gen;
    const draft = gen.draft;
    const body = el('div', 'ct-wm-dialog-body ct-wm-draft');
    const list = el('div', 'ct-wm-col ct-wm-draft-list');
    const head = el('div', 'ct-wm-side-head');
    head.append(el('span', 'ct-wm-kicker', `Draft · ${gen.picked.size} of ${draft.places.length} picked`), el('span', 'ct-wm-grow'),
        button('ct-wm-chip', 'All', '', () => {
            gen.picked = new Set(draft.places.map(item => item.place.id));
            render();
        }),
        button('ct-wm-chip', 'None', '', () => {
            gen.picked = new Set();
            render();
        }));
    list.append(head);
    const all = new Map(draft.places.map(item => [item.place.id, item.place]));
    const depthOf = (place) => {
        let depth = 0;
        let parent = place.parent;
        const seen = new Set();
        while (parent && all.has(parent) && !seen.has(parent)) {
            seen.add(parent);
            depth++;
            parent = all.get(parent).parent;
        }
        return depth;
    };
    for (const item of draft.places) {
        const label = el('label', `ct-wm-draft-row${gen.picked.has(item.place.id) ? ' is-on' : ''}`);
        label.style.setProperty('--ct-wm-depth', String(Math.min(depthOf(item.place), 6)));
        const box = el('input');
        box.type = 'checkbox';
        box.checked = gen.picked.has(item.place.id);
        box.addEventListener('change', () => {
            if (box.checked) gen.picked.add(item.place.id);
            else gen.picked.delete(item.place.id);
            render();
        });
        const text = el('span', 'ct-wm-list-text');
        text.append(el('span', '', ''), el('span', 'ct-wm-muted ct-wm-small', item.place.description));
        text.firstChild.append(el('b', '', item.place.name), el('span', 'ct-wm-muted ct-wm-small', ` · ${item.place.kind || 'place'}${item.place.status === 'rumored' ? ' · rumored' : ''}`));
        label.append(box, text, el('span', `ct-wm-tag is-${item.tag}`, item.tag === 'new' ? 'New' : item.tag === 'update' ? 'Update' : 'On the map'));
        list.append(label);
    }
    const preview = el('div', 'ct-wm-col ct-wm-preview');
    const merged = new Map(gen.target === 'new' ? [] : state.places);
    for (const item of draft.places) if (gen.picked.has(item.place.id)) merged.set(item.place.id, item.place);
    const focus = gen.target !== 'new' && gen.target !== 'top' ? gen.target : '';
    const level = mapLevel({ places: merged, current: '' }, focus, []);
    preview.append(el('span', 'ct-wm-kicker', focus ? `Preview · inside ${merged.get(focus)?.name ?? ''}` : 'Preview · top level'));
    preview.append(drawMap(level, { width: 460, height: 380, selected: '', title: 'Draft preview', onPick: () => {}, state: {}, viewKey: 'draft', controls: false }));
    body.append(list, preview);
    const foot = el('footer', 'ct-wm-dialog-foot');
    foot.append(
        button('ct-wm-link is-danger', 'Discard', '', () => {
            page.gen = null;
            render();
        }),
        button('menu_button ct-wm-btn', 'Change settings', '', () => {
            gen.step = 'setup';
            render();
        }),
        button('menu_button ct-wm-btn', '<i class="fa-solid fa-rotate"></i> Regenerate', '', () => void runGenerator(state)),
        el('span', 'ct-wm-grow'),
    );
    const add = button('menu_button ct-wm-btn is-primary', `<i class="fa-solid fa-check"></i> Add ${gen.picked.size} place${gen.picked.size === 1 ? '' : 's'}`, '', () => acceptDraft(state));
    add.disabled = !gen.picked.size;
    foot.append(add);
    return [body, foot];
}

function acceptDraft(state) {
    const gen = page.gen;
    let world = state.world;
    if (gen.target === 'new' || !world) {
        world = createWorld(gen.draft.worldName || 'New world');
        useWorld(world.id);
    }
    const places = placesOf(world);
    const picked = gen.draft.places.filter(item => gen.picked.has(item.place.id)).map(item => item.place);
    const pickedIds = new Set(picked.map(place => place.id));
    const fallback = gen.target !== 'new' && gen.target !== 'top' && places.has(gen.target) ? gen.target : '';
    for (const place of picked) {
        // A place whose parent was left out goes to the nearest kept ancestor (or where you asked).
        let parent = place.parent;
        const all = new Map(gen.draft.places.map(item => [item.place.id, item.place]));
        while (parent && !pickedIds.has(parent) && !places.has(parent)) parent = all.get(parent)?.parent ?? '';
        const next = normalizePlace({ ...place, parent: parent || (place.id === fallback ? '' : fallback) }, places.get(place.id) ?? null);
        places.set(next.id, next);
    }
    storePlaces(world, places);
    toastr.success(`${picked.length} place${picked.length === 1 ? '' : 's'} added to ${world.name}.`);
    page.gen = null;
    page.focus = fallback;
    page.selected = '';
    page.mapView = {};
    render();
}

// ───────────────────────── Init ─────────────────────────

export function registerMacro() {
    const context = globalThis.SillyTavern?.getContext?.();
    const description = 'The map of the open chat\'s world, one line per place, and the map mode (for the Scene: Map tracker).';
    try {
        context?.registerMacro?.('sceneMapPlaces', () => mapMacro(), description);
    } catch {
        // legacy macro engine missing
    }
    try {
        context?.macros?.register?.('sceneMapPlaces', { handler: () => mapMacro(), description, returns: description, exampleUsage: '{{sceneMapPlaces}}' });
    } catch {
        // new macro engine missing
    }
}

document.addEventListener(WORLD_CHANGED_EVENT, () => {
    if (isOpen()) render();
});
window.addEventListener('resize', () => {
    if (isOpen() && !page.gen) render();
});

globalThis.HomunculusWorldMap = { open, close, isOpen, mapState, ingest, moveTo, acceptPending, skipPending, listWorlds, registerMacro };
