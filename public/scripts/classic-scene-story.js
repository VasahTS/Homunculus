// Classic UI fork: story memory for the Scene panel.
//
// The Scene trackers save their state in every message (per swipe), so walking the chat gives the
// whole history of the story. This module turns that history into the panel's meta information
// (time since the start, the current scene, what the last update changed, things that don't add up,
// stale quests and threads, faction stance over time, the travel log, when someone was last seen)
// and holds the Scene: Map logic (the map is the sum of the Map tracker's patches) and its drawing.
// Everything here is plain data in, data or DOM out; classic-scene.js owns the chat and the saving.

import { parseDate, addDays } from './classic-calendars.js';

const str = value => (value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value));
export const keyOf = name => str(name).trim().toLowerCase();

// ───────────────────────── Story clock ─────────────────────────

/** Minutes after midnight from "HH:MM" (also "7:05", "19h30"), or null. */
export function parseClock(value) {
    const match = str(value).trim().match(/^(\d{1,2})\s*[:h.]\s*(\d{2})/i);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    return hours > 23 || minutes > 59 ? null : hours * 60 + minutes;
}
export const formatClock = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** The story day of older results ("day": 3, or "Day 3, morning" in the time text), or null. */
export function legacyDay(world) {
    const n = Number.parseInt(str(world?.day), 10);
    if (Number.isFinite(n) && n > 0) return n;
    const match = str(world?.time).match(/\bday\s*(\d+)/i);
    return match ? Number(match[1]) : null;
}

/** The time-of-day words, without an older "Day 3," prefix. */
export function timeWords(world) {
    return str(world?.time).replace(/^\s*day\s*\d+\s*[,·:-]?\s*/i, '').trim();
}

export function partOfDay(minutes) {
    const h = minutes / 60;
    if (h < 5) return 'small hours';
    if (h < 7) return 'dawn';
    if (h < 11) return 'morning';
    if (h < 13) return 'midday';
    if (h < 16) return 'afternoon';
    if (h < 18) return 'late afternoon';
    if (h < 20) return 'evening';
    return 'night';
}

/** Where the sun or moon is: { body, t } with t from 0 (rising) to 1 (setting), or null when unknown. */
export function skyPosition(world) {
    const minutes = parseClock(world?.clock);
    if (minutes !== null) {
        if (minutes >= 360 && minutes < 1080) return { body: 'sun', t: (minutes - 360) / 720 };
        return { body: 'moon', t: ((minutes - 1080 + 1440) % 1440) / 720 };
    }
    const text = timeWords(world).toLowerCase();
    // Order matters: "afternoon" contains "noon", "midnight" contains "night".
    const words = [
        [/midnight/, 'moon', 0.5],
        [/late night|small hours|before dawn/, 'moon', 0.8],
        [/dawn|sunrise|daybreak|first light|early morning/, 'sun', 0.07],
        [/late afternoon|sunset|dusk|twilight/, 'sun', 0.85],
        [/afternoon/, 'sun', 0.65],
        [/noon|midday/, 'sun', 0.5],
        [/morning/, 'sun', 0.25],
        [/evening/, 'moon', 0.12],
        [/night/, 'moon', 0.4],
    ];
    const hit = words.find(([pattern]) => pattern.test(text));
    return hit ? { body: hit[1], t: hit[2] } : null;
}

/** A clock for results that only have words ("late afternoon"), so durations and buttons work. */
export function guessMinutes(world) {
    const pos = skyPosition(world);
    if (!pos) return null;
    return Math.round(pos.body === 'sun' ? 360 + pos.t * 720 : (1080 + pos.t * 720) % 1440);
}

/** Days since the calendar's year 0 (only differences matter). */
function dayNumber(cal, date) {
    if (cal.leap === 'gregorian' && cal.months.length === 12) {
        const when = new Date(Date.UTC(2000, 0, 1));
        when.setUTCFullYear(date.year, date.month - 1, date.day);
        return Math.round(when.getTime() / 86400000);
    }
    const yearLength = cal.months.reduce((sum, item) => sum + item.days, 0);
    let total = date.year * yearLength + date.day - 1;
    for (let m = 1; m < date.month; m++) total += cal.months[m - 1].days;
    return total;
}

/** Story time as one number of minutes (for differences), or null when the result has no usable time. */
export function absMinutes(world, cal) {
    if (!world) return null;
    const minutes = parseClock(world.clock) ?? guessMinutes(world);
    const date = parseDate(world.date, cal);
    if (date) return dayNumber(cal, date) * 1440 + (minutes ?? 12 * 60);
    const day = legacyDay(world);
    if (day !== null) return (day - 1) * 1440 + (minutes ?? 12 * 60);
    return null;
}

/** "25 min", "2 h 35 min", "3 days 4 h". */
export function formatSpan(minutes) {
    const m = Math.max(0, Math.round(minutes));
    if (m < 60) return `${m} min`;
    if (m < 1440) {
        const h = Math.floor(m / 60);
        return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
    }
    const d = Math.floor(m / 1440);
    const h = Math.floor((m % 1440) / 60);
    return `${d} day${d === 1 ? '' : 's'}${h ? ` ${h} h` : ''}`;
}

/** "Day 2, 14:20" counted from the first tracked moment of the story. */
export function storyStamp(abs, startAbs) {
    if (abs === null || startAbs === null) return '';
    const startMidnight = startAbs - (((startAbs % 1440) + 1440) % 1440);
    const day = Math.floor((abs - startMidnight) / 1440) + 1;
    return `Day ${day}, ${formatClock(((abs % 1440) + 1440) % 1440)}`;
}

/** Moves a world clock by minutes (rolls the date over midnight). Returns { date, clock, time }. */
export function shiftClock(cal, date, minutes) {
    const days = Math.floor(minutes / 1440);
    const rest = minutes - days * 1440;
    return { date: days ? addDays(cal, date, days) : date, clock: formatClock(rest), time: partOfDay(rest) };
}

// ───────────────────────── History ─────────────────────────

/**
 * @typedef {{ messageIndex: number, data: object }} Entry  one finished tracker result
 * Histories are oldest first.
 */

/** The latest entry at or before a message. */
export function entryAt(history, messageIndex) {
    let found = null;
    for (const entry of history) {
        if (entry.messageIndex > messageIndex) break;
        found = entry;
    }
    return found;
}

/** Story start: the first world result with a usable time. */
export function storyStart(worldHistory, cal) {
    for (const entry of worldHistory) {
        const abs = absMinutes(entry.data, cal);
        if (abs !== null) return { abs, messageIndex: entry.messageIndex };
    }
    return null;
}

/**
 * Stays: runs of messages in the same place, oldest first. From the map when it has a current place,
 * else from the World tracker's location text.
 * @returns {{ name: string, placeId: string, startIndex: number, startAbs: number|null }[]}
 */
export function stays(worldHistory, mapHistory, cal, timeline = null) {
    const out = [];
    const push = (name, placeId, index) => {
        const last = out[out.length - 1];
        if (last && (placeId ? last.placeId === placeId : keyOf(last.name) === keyOf(name))) return;
        out.push({ name, placeId, startIndex: index, startAbs: absMinutes(entryAt(worldHistory, index)?.data, cal) });
    };
    if (timeline?.length) {
        for (const item of timeline) push(item.name, item.placeId, item.messageIndex);
        if (out.length) return out;
    }
    if (mapHistory.length) {
        const folded = new Map();
        for (const entry of mapHistory) {
            applyPatch(folded, entry.data);
            const current = str(entry.data?.current).trim();
            if (current) push(folded.get(current)?.name || current, current, entry.messageIndex);
        }
        if (out.length) return out;
    }
    for (const entry of worldHistory) {
        const name = str(entry.data?.location).trim();
        if (name) push(name, '', entry.messageIndex);
    }
    return out;
}

/** What changed between two results of the trackers, as short labeled items for the "Last update" strip. */
export function changesBetween({ world, prevWorld, cast, prevCast, newPlaces = [], cal, isPresent }) {
    const out = [];
    if (world && prevWorld) {
        const a = absMinutes(prevWorld, cal);
        const b = absMinutes(world, cal);
        if (a !== null && b !== null && b !== a) out.push({ tone: b > a ? 'time' : 'warn', text: b > a ? `+${formatSpan(b - a)}` : `Clock went back ${formatSpan(a - b)}` });
        const from = str(prevWorld.location).trim();
        const to = str(world.location).trim();
        if (to && from && keyOf(to) !== keyOf(from)) out.push({ tone: 'move', text: `Moved: ${from} → ${to}` });
        const items = list => (Array.isArray(list) ? list : []).map(item => str(item).trim()).filter(Boolean);
        const before = new Set(items(prevWorld.inventory).map(keyOf));
        const after = new Set(items(world.inventory).map(keyOf));
        for (const item of items(world.inventory)) if (!before.has(keyOf(item))) out.push({ tone: 'add', text: `+ ${item}` });
        for (const item of items(prevWorld.inventory)) if (!after.has(keyOf(item))) out.push({ tone: 'remove', text: `− ${item}` });
        const quests = list => new Map((Array.isArray(list) ? list : []).filter(q => q && str(q.title).trim()).map(q => [keyOf(q.title), q]));
        const oldQuests = quests(prevWorld.quests);
        for (const [key, quest] of quests(world.quests)) {
            const status = str(quest.status).toLowerCase() || 'active';
            const old = oldQuests.get(key);
            if (!old) out.push({ tone: 'add', text: `New quest: ${str(quest.title).trim()}` });
            else if ((str(old.status).toLowerCase() || 'active') !== status && status !== 'active') out.push({ tone: status === 'failed' ? 'remove' : 'add', text: `Quest ${status === 'failed' ? 'failed' : 'done'}: ${str(quest.title).trim()}` });
        }
        const factions = list => new Map((Array.isArray(list) ? list : []).filter(f => f && str(f.name).trim()).map(f => [keyOf(f.name), f]));
        const oldFactions = factions(prevWorld.factions);
        for (const [key, faction] of factions(world.factions)) {
            const old = oldFactions.get(key);
            const stance = str(faction.stance).toLowerCase();
            if (!old) out.push({ tone: 'add', text: `+ Faction: ${str(faction.name).trim()}` });
            else if (stance && str(old.stance).toLowerCase() && stance !== str(old.stance).toLowerCase()) out.push({ tone: 'stance', text: `${str(faction.name).trim()}: ${str(old.stance).toLowerCase()} → ${stance}` });
        }
    }
    if (cast && prevCast) {
        const people = data => new Map((Array.isArray(data?.characters) ? data.characters : []).filter(c => c && str(c.name).trim()).map(c => [keyOf(c.name), c]));
        const before = people(prevCast);
        for (const [key, character] of people(cast)) {
            const old = before.get(key);
            const name = str(character.name).trim();
            if (!old) out.push({ tone: 'add', text: `+ ${name}` });
            else if (isPresent(old) !== isPresent(character)) out.push({ tone: isPresent(character) ? 'add' : 'move', text: isPresent(character) ? `${name} arrived` : `${name} left` });
        }
    }
    for (const name of newPlaces) out.push({ tone: 'move', text: `New place: ${name}` });
    return out;
}

/**
 * How long an item has gone without change: the message where its current state began.
 * @param {Entry[]} history
 * @param {(data: object) => string|null} signature the item's state in one result (null = absent)
 */
export function unchangedSince(history, signature) {
    let since = null;
    let last = null;
    for (let i = history.length - 1; i >= 0; i--) {
        const sig = signature(history[i].data);
        if (sig === null) break;
        if (last !== null && sig !== last) break;
        last = sig;
        since = history[i].messageIndex;
    }
    return since;
}

/** Each faction's stance over time: [{ name, steps: [{ stance, messageIndex, abs, why }] }] (latest change first). */
export function stanceHistory(worldHistory, cal) {
    const byFaction = new Map();
    for (const entry of worldHistory) {
        for (const faction of Array.isArray(entry.data?.factions) ? entry.data.factions : []) {
            const name = str(faction?.name).trim();
            const stance = str(faction?.stance).trim().toLowerCase();
            if (!name || !stance) continue;
            const record = byFaction.get(keyOf(name)) ?? { name, steps: [] };
            const last = record.steps[record.steps.length - 1];
            if (!last || last.stance !== stance) record.steps.push({ stance, messageIndex: entry.messageIndex, abs: absMinutes(entry.data, cal), why: str(faction.standing).trim() });
            record.name = name;
            byFaction.set(keyOf(name), record);
        }
    }
    return [...byFaction.values()].sort((a, b) => b.steps[b.steps.length - 1].messageIndex - a.steps[a.steps.length - 1].messageIndex);
}

/** The last result where a character was in the scene, or null. */
export function lastSeenEntry(castHistory, name, isPresent) {
    for (let i = castHistory.length - 1; i >= 0; i--) {
        const found = (Array.isArray(castHistory[i].data?.characters) ? castHistory[i].data.characters : []).find(c => keyOf(c?.name) === keyOf(name));
        if (found && isPresent(found)) return castHistory[i];
    }
    return null;
}

const NAME_TITLES = new Set(['sister', 'brother', 'father', 'mother', 'captain', 'lady', 'lord', 'king', 'queen', 'prince', 'princess', 'master', 'mistress', 'doctor', 'sir', 'dame', 'the', 'old', 'young', 'high', 'saint']);

/** Whether a name (or a distinctive part of it) appears in a text. */
export function mentions(text, name) {
    const clean = str(name).trim();
    if (!clean || !text) return false;
    const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escape(clean)}\\b`).test(text)) return true;
    return clean.split(/\s+/).filter(part => part.length >= 4 && !NAME_TITLES.has(part.toLowerCase())).some(part => new RegExp(`\\b${escape(part)}\\b`).test(text));
}

// ───────────────────────── Map ─────────────────────────

/**
 * The map is the sum of the Map tracker's patches: { current, places: [...], remove: [...] }.
 * A place: { id, name, kind, parent, status: visited|known|rumored, description, x, y, links: [{ to, travel }] }.
 */
export const PLACE_STATES = Object.freeze(['visited', 'known', 'rumored']);
const STATUS_RANK = { rumored: 0, known: 1, visited: 2 };

export const cleanId = value => str(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

export function normalizePlace(raw, old = null) {
    const id = cleanId(raw?.id || raw?.name || old?.id);
    if (!id) return null;
    const pick = (key, fallback) => (raw && raw[key] !== undefined && raw[key] !== null && str(raw[key]).trim() !== '' ? raw[key] : fallback);
    const status = PLACE_STATES.includes(str(pick('status', old?.status)).toLowerCase()) ? str(pick('status', old?.status)).toLowerCase() : 'known';
    const number = (value) => {
        if (value === null || value === undefined || str(value).trim() === '') return null;
        const n = Number(value);
        return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
    };
    const links = new Map((old?.links ?? []).map(link => [link.to, link]));
    for (const link of Array.isArray(raw?.links) ? raw.links : []) {
        const to = cleanId(link?.to);
        if (to && to !== id) links.set(to, { to, travel: str(link?.travel).trim() || links.get(to)?.travel || '', ...(link?.oneWay || links.get(to)?.oneWay ? { oneWay: true } : {}) });
    }
    return {
        id,
        name: str(pick('name', old?.name ?? id)).trim(),
        kind: str(pick('kind', old?.kind ?? '')).trim().toLowerCase(),
        parent: raw && 'parent' in raw ? cleanId(raw.parent) : (old?.parent ?? ''),
        // A place only moves up (rumored → known → visited); a later patch never "unvisits" it.
        // Edits made by hand in the panel carry `edited: true` and may set any status.
        status: old && !raw?.edited && STATUS_RANK[old.status] > STATUS_RANK[status] ? old.status : status,
        description: str(pick('description', old?.description ?? '')).trim(),
        secret: str(raw && 'secret' in raw ? raw.secret : (old?.secret ?? '')).trim(),
        view: ['map', 'list', 'floors'].includes(str(raw?.view || old?.view)) ? str(raw?.view || old?.view) : '',
        order: Number.isFinite(Number(raw?.order ?? old?.order)) && (raw?.order ?? old?.order) !== null && (raw?.order ?? old?.order) !== '' ? Number(raw?.order ?? old?.order) : null,
        x: raw && 'x' in raw ? number(raw.x) : (old?.x ?? null),
        y: raw && 'y' in raw ? number(raw.y) : (old?.y ?? null),
        links: [...links.values()],
        ...(raw?.edited || old?.edited ? { edited: true } : {}),
    };
}

/** Applies one patch to a Map of places (in place). */
export function applyPatch(places, patch) {
    if (!patch || typeof patch !== 'object') return places;
    for (const raw of Array.isArray(patch.places) ? patch.places : []) {
        const id = cleanId(raw?.id || raw?.name);
        const place = normalizePlace(raw, places.get(id) ?? null);
        if (place) places.set(place.id, place);
    }
    for (const id of (Array.isArray(patch.remove) ? patch.remove : []).map(cleanId)) places.delete(id);
    const current = cleanId(patch.current);
    if (current && places.has(current) && places.get(current).status !== 'visited') places.get(current).status = 'visited';
    return places;
}

/** The whole map from the Map tracker's history: { places, current, newIds } (newIds: added by the latest patch). */
export function foldMap(mapHistory) {
    const places = new Map();
    let current = '';
    let before = new Set();
    mapHistory.forEach((entry, index) => {
        if (index === mapHistory.length - 1) before = new Set(places.keys());
        applyPatch(places, entry.data);
        const next = cleanId(entry.data?.current);
        if (next) current = next;
    });
    const newIds = mapHistory.length > 1 ? [...places.keys()].filter(id => !before.has(id)) : [];
    return { places, current: places.has(current) ? current : '', newIds };
}

/** Ancestors of a place, nearest first (stops on loops). */
export function ancestors(places, id) {
    const out = [];
    const seen = new Set([id]);
    let parent = places.get(id)?.parent;
    while (parent && places.has(parent) && !seen.has(parent)) {
        out.push(parent);
        seen.add(parent);
        parent = places.get(parent).parent;
    }
    return out;
}

/** A place's parent if it is on the map, else '' (top level). */
const parentOf = (places, id) => (places.get(id)?.parent && places.has(places.get(id).parent) ? places.get(id).parent : '');

export function childrenOf(places, parentId) {
    return [...places.values()].filter(place => parentOf(places, place.id) === (parentId || '') && place.id !== parentId);
}

/** The place on this level that holds `id` (itself or an ancestor), or ''. */
function shownAncestor(shown, places, id) {
    if (shown.has(id)) return id;
    return ancestors(places, id).find(item => shown.has(item)) ?? '';
}

/** Whether `id` is `holder` or inside it. */
export function isInside(places, id, holder) {
    return id === holder || ancestors(places, id).includes(holder);
}

/** The direct travel time between a place (or anything around it) and the current place, or ''. */
export function travelFrom(places, current, id) {
    if (!current || !id) return '';
    const chainA = [current, ...ancestors(places, current)];
    const chainB = [id, ...ancestors(places, id)];
    for (const a of chainA) {
        for (const b of chainB) {
            const link = places.get(a)?.links.find(item => item.to === b) ?? places.get(b)?.links.find(item => item.to === a);
            if (link?.travel) return link.travel;
        }
    }
    return '';
}

/**
 * One level of the map: the places inside `focus`, the routes between them (routes between places
 * inside them are drawn between the two holders), roads that leave this level, places without a
 * position, and the trail of where the story went.
 */
export function mapLevel(map, focus, trailIds) {
    const { places, current } = map;
    const shownList = childrenOf(places, focus);
    const shown = new Set(shownList.map(place => place.id));
    const edges = new Map();
    const exits = [];
    for (const place of places.values()) {
        for (const link of place.links) {
            if (!places.has(link.to)) continue;
            const a = shownAncestor(shown, places, place.id);
            const b = shownAncestor(shown, places, link.to);
            if (a && b && a !== b) {
                const key = [a, b].sort().join('|');
                const direct = (place.id === a && link.to === b) || (place.id === b && link.to === a);
                if (!edges.has(key) || (direct && !edges.get(key).travel)) edges.set(key, { a, b, travel: direct ? link.travel : '' });
            } else if ((a && !b && !isInside(places, link.to, focus || '__none__')) || (!a && b && !isInside(places, place.id, focus || '__none__'))) {
                const from = a || b;
                const outside = a ? link.to : place.id;
                if (focus && !exits.some(item => item.from === from && item.to === outside)) exits.push({ from, to: outside, travel: link.travel });
            }
        }
    }
    const trail = [];
    for (const id of trailIds) {
        const holder = shownAncestor(shown, places, id);
        if (holder && trail[trail.length - 1] !== holder) trail.push(holder);
    }
    const here = current ? shownAncestor(shown, places, current) : '';
    const visitedInside = (id) => [...places.values()].some(place => place.status === 'visited' && isInside(places, place.id, id));
    // A level where nothing has a position yet (a lone kingdom at the top) is laid out in a ring,
    // so it is never blank; once some places are placed, the others are listed under the map.
    const anyPlaced = shownList.some(place => place.x !== null && place.y !== null);
    const ring = (index, count) => (count === 1 ? [50, 45] : [50 + 32 * Math.cos((2 * Math.PI * index) / count - Math.PI / 2), 48 + 32 * Math.sin((2 * Math.PI * index) / count - Math.PI / 2)]);
    return {
        places: shownList.map((place, index) => ({
            ...place,
            ...(anyPlaced ? {} : { x: ring(index, shownList.length)[0], y: ring(index, shownList.length)[1] }),
            placed: !anyPlaced || (place.x !== null && place.y !== null),
            here: place.id === here,
            seen: place.status === 'visited' || visitedInside(place.id),
            hasInside: childrenOf(places, place.id).length > 0,
        })),
        edges: [...edges.values()],
        exits,
        trail,
    };
}

// ───────────────────────── Map drawing ─────────────────────────

const SVG = 'http://www.w3.org/2000/svg';
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 8;

function svg(tag, attrs = {}, parent = null) {
    const node = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (parent) parent.append(node);
    return node;
}

/**
 * Pushes apart places that sit on top of each other (only for drawing; saved positions don't change).
 * @param {Map<string, {x:number, y:number}>} pos in map pixels
 */
function spread(pos, gap = 30) {
    const items = [...pos.values()];
    for (let round = 0; round < 40; round++) {
        let moved = false;
        for (let i = 0; i < items.length; i++) {
            for (let j = i + 1; j < items.length; j++) {
                const a = items[i];
                const b = items[j];
                let dx = b.x - a.x;
                let dy = b.y - a.y;
                let dist = Math.hypot(dx, dy);
                if (dist >= gap) continue;
                if (dist < 0.01) {
                    const angle = (j * 2.399) % (2 * Math.PI);
                    dx = Math.cos(angle);
                    dy = Math.sin(angle);
                    dist = 1;
                }
                const push = (gap - dist) / 2;
                a.x -= (dx / dist) * push;
                a.y -= (dy / dist) * push;
                b.x += (dx / dist) * push;
                b.y += (dy / dist) * push;
                moved = true;
            }
        }
        if (!moved) break;
    }
}

/**
 * One map level you can move around in: wheel or +/− to zoom (toward the pointer), drag the
 * background to pan, drag a place to move it (onMove saves it), click a place to pick it.
 * Zoom changes distances, not the size of dots and labels, so crowded places pull apart.
 * @param {ReturnType<typeof mapLevel>} level
 * @param {{ selected: string, onPick: (id: string) => void, onMove: (id: string, x: number, y: number) => void, title: string, state: { key?: string, k?: number, tx?: number, ty?: number }, viewKey: string }} options
 *   state: kept by the caller between renders (zoom and pan of this level)
 */
export function drawMap(level, { selected, onPick, onMove = null, title, state = {}, viewKey = '', width = 300, height = 220, controls: showControls = true }) {
    const W = width;
    const H = height;
    const px = x => 18 + (x / 100) * (W - 36);
    const py = y => 18 + (y / 100) * (H - 40);
    const fromPx = v => Math.min(100, Math.max(0, ((v - 18) / (W - 36)) * 100));
    const fromPy = v => Math.min(100, Math.max(0, ((v - 18) / (H - 40)) * 100));
    const wrap = document.createElement('div');
    wrap.className = 'ct-sc-map-view';
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'ct-sc-map-svg', role: 'img', 'aria-label': title });
    wrap.append(root);
    const placed = level.places.filter(place => place.placed);
    const byId = new Map(placed.map(place => [place.id, place]));
    const pos = new Map(placed.map(place => [place.id, { x: px(place.x), y: py(place.y) }]));
    spread(pos, Math.max(30, Math.min(W, H) / 9));

    const fit = () => {
        const points = [...pos.values()];
        if (!points.length) {
            Object.assign(state, { k: 1, tx: 0, ty: 0 });
            return;
        }
        const xs = points.map(p => p.x);
        const ys = points.map(p => p.y);
        const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
        const k = points.length === 1 ? 1 : Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((W - Math.min(150, W * 0.3)) / Math.max(1, maxX - minX), (H - 70) / Math.max(1, maxY - minY))));
        Object.assign(state, { k, tx: W / 2 - k * ((minX + maxX) / 2), ty: H / 2 - k * ((minY + maxY) / 2) - 4 });
    };
    if (state.key !== viewKey || !Number.isFinite(state.k)) {
        state.key = viewKey;
        fit();
    }
    const sx = x => state.tx + state.k * x;
    const sy = y => state.ty + state.k * y;

    const edgeLayer = svg('g', { class: 'ct-sc-map-edges' }, root);
    const edges = [];
    for (const edge of level.edges) {
        const a = byId.get(edge.a);
        const b = byId.get(edge.b);
        if (!a || !b) continue;
        const unsure = a.status === 'rumored' || b.status === 'rumored';
        const line = svg('line', { class: `ct-sc-map-edge${unsure ? ' is-unsure' : !a.seen || !b.seen ? ' is-known' : ''}` }, edgeLayer);
        let label = null;
        if (edge.travel) {
            label = svg('text', { class: 'ct-sc-map-travel', 'text-anchor': 'middle' }, edgeLayer);
            label.textContent = edge.travel.length > 16 ? `${edge.travel.slice(0, 15)}…` : edge.travel;
        }
        edges.push({ a: edge.a, b: edge.b, line, label });
    }
    const trailIds = level.trail.filter(id => pos.has(id));
    const trail = trailIds.length > 1 ? svg('polyline', { class: 'ct-sc-map-trail' }, root) : null;

    const nodes = [];
    for (const place of byId.values()) {
        const group = svg('g', { class: `ct-sc-map-place is-${place.here ? 'here' : place.seen ? 'visited' : place.status}${place.id === selected ? ' is-selected' : ''}`, tabindex: '0', role: 'button', 'aria-label': `${place.name}. Drag to move it` }, root);
        group.dataset.id = place.id;
        const tip = svg('title', {}, group);
        tip.textContent = place.name;
        const circles = [];
        if (place.here) circles.push(svg('circle', { r: 13, class: 'ct-sc-map-here' }, group));
        if (place.id === selected) circles.push(svg('circle', { r: 10.5, class: 'ct-sc-map-ring' }, group));
        if (place.hasInside) circles.push(svg('circle', { r: 9.2, class: 'ct-sc-map-inside' }, group));
        circles.push(svg('circle', { r: 6.5, class: 'ct-sc-map-dot' }, group));
        const label = svg('text', { class: 'ct-sc-map-label' }, group);
        const name = `${place.name}${place.status === 'rumored' ? '?' : ''}`;
        label.textContent = name.length > 22 ? `${name.slice(0, 21)}…` : name;
        nodes.push({ id: place.id, group, circles, label });
        group.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onPick(place.id);
            }
        });
    }

    const layout = () => {
        for (const edge of edges) {
            const a = pos.get(edge.a);
            const b = pos.get(edge.b);
            edge.line.setAttribute('x1', sx(a.x));
            edge.line.setAttribute('y1', sy(a.y));
            edge.line.setAttribute('x2', sx(b.x));
            edge.line.setAttribute('y2', sy(b.y));
            if (edge.label) {
                edge.label.setAttribute('x', (sx(a.x) + sx(b.x)) / 2 + 3);
                edge.label.setAttribute('y', (sy(a.y) + sy(b.y)) / 2 - 4);
            }
        }
        if (trail) trail.setAttribute('points', trailIds.map(id => `${sx(pos.get(id).x)},${sy(pos.get(id).y)}`).join(' '));
        for (const node of nodes) {
            const x = sx(pos.get(node.id).x);
            const y = sy(pos.get(node.id).y);
            for (const circle of node.circles) {
                circle.setAttribute('cx', x);
                circle.setAttribute('cy', y);
            }
            node.label.setAttribute('x', x);
            node.label.setAttribute('y', y > H - 26 ? y - 12 : y + 19);
            node.label.setAttribute('text-anchor', x < 30 ? 'start' : x > W - 30 ? 'end' : 'middle');
        }
    };
    layout();

    // Pointer → map pixels.
    const toView = (event) => {
        const box = root.getBoundingClientRect();
        return { x: ((event.clientX - box.left) / box.width) * W, y: ((event.clientY - box.top) / box.height) * H };
    };
    const zoomAt = (factor, at = { x: W / 2, y: H / 2 }) => {
        const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, state.k * factor));
        state.tx = at.x - (at.x - state.tx) * (k / state.k);
        state.ty = at.y - (at.y - state.ty) * (k / state.k);
        state.k = k;
        layout();
    };
    root.addEventListener('wheel', (event) => {
        event.preventDefault();
        zoomAt(Math.exp(-event.deltaY * 0.0015), toView(event));
    }, { passive: false });

    let drag = null;
    root.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        const group = /** @type {Element} */ (event.target).closest?.('.ct-sc-map-place');
        const start = toView(event);
        const id = group?.getAttribute('data-id') ?? '';
        drag = group && onMove
            ? { kind: 'place', id, start, moved: false, origin: { ...pos.get(id) } }
            : { kind: 'pan', id, start, moved: false, origin: { tx: state.tx, ty: state.ty } };
        root.setPointerCapture(event.pointerId);
        wrap.classList.add(drag.kind === 'pan' ? 'is-panning' : 'is-moving');
    });
    root.addEventListener('pointermove', (event) => {
        if (!drag) return;
        const now = toView(event);
        const dx = now.x - drag.start.x;
        const dy = now.y - drag.start.y;
        if (!drag.moved && Math.hypot(dx, dy) < 3) return;
        drag.moved = true;
        if (drag.kind === 'pan') {
            state.tx = drag.origin.tx + dx;
            state.ty = drag.origin.ty + dy;
        } else {
            pos.set(drag.id, { x: drag.origin.x + dx / state.k, y: drag.origin.y + dy / state.k });
        }
        layout();
    });
    const end = (event) => {
        if (!drag) return;
        const done = drag;
        drag = null;
        wrap.classList.remove('is-panning', 'is-moving');
        if (root.hasPointerCapture?.(event.pointerId)) root.releasePointerCapture(event.pointerId);
        if (done.kind !== 'place') {
            if (!done.moved && done.id) onPick(done.id);
            return;
        }
        if (!done.moved) {
            onPick(done.id);
            return;
        }
        const p = pos.get(done.id);
        onMove(done.id, Math.round(fromPx(p.x) * 10) / 10, Math.round(fromPy(p.y) * 10) / 10);
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);

    if (!showControls) return wrap;
    const controls = document.createElement('div');
    controls.className = 'ct-sc-map-controls';
    for (const [icon, label, action] of [
        ['fa-plus', 'Zoom in', () => zoomAt(1.4)],
        ['fa-minus', 'Zoom out', () => zoomAt(1 / 1.4)],
        ['fa-expand', 'Fit: show every place', () => {
            fit();
            layout();
        }],
    ]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ct-sc-map-btn';
        b.title = label;
        b.setAttribute('aria-label', label);
        b.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i>`;
        b.addEventListener('click', action);
        controls.append(b);
    }
    wrap.append(controls);
    return wrap;
}
