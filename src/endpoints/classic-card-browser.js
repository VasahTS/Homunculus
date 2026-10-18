// Classic UI fork: Card Browser server routes (/api/classic-cards/...).
//
// Searches character-card sites (ChubAI, JannyAI, Wyvern, DataCat, Pygmalion) from this server and
// hands the results to the page in public/scripts/classic-card-browser.js. Requests go straight to
// each site: no third-party proxies, and nothing from these sites is ever executed. Every request is
// limited to the site's own hosts (https only), to a size cap and to a timeout. Images are checked
// by their bytes before being passed on, and card text is returned as data for the page to show as
// plain text.
//
// The site APIs used here follow Marinara Engine's Card Browser (github.com/Pasta-Devs/Marinara-Engine,
// AGPL-3.0), rewritten for SillyTavern's Express server.

import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import express from 'express';

import { write as writeCardMetadata } from '../character-card-parser.js';
import { Jimp, JimpMime } from '../jimp.js';

export const router = express.Router();

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const JSON_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_MAX_BYTES = 15 * 1024 * 1024;
const CARD_MAX_BYTES = 64 * 1024 * 1024;

const CHUB_API = 'https://api.chub.ai';
const CHUB_AVATARS = 'https://avatars.charhub.io';
const JANNY_SEARCH_URL = 'https://search.jannyai.com/multi-search';
const JANNY_SITE = 'https://jannyai.com';
const JANNY_API_SITE = 'https://api.jannyai.com';
const JANNY_IMAGES = 'https://image.jannyai.com/bot-avatars/';
const JANNY_DOWNLOAD_API = 'https://api.jannyai.com/api/v1/download';
const JANNY_FALLBACK_TOKEN = '88a6463b66e04fb07ba87ee3db06af337f492ce511d93df6e2d2968cb2ff2b30';
const WYVERN_API = 'https://api.wyvern.chat';
const DATACAT_API = 'https://datacat.run';
const DATACAT_IMAGES = 'https://ella.janitorai.com/bot-avatars/';
const PYGMALION_API = 'https://server.pygmalion.chat/galatea.v1.PublicCharacterService';
const PYGMALION_ASSETS = 'https://assets.pygmalion.chat';

// ───────────────────────── Safe fetching ─────────────────────────

class UpstreamError extends Error {
    /**
     * @param {number} status
     * @param {string} message
     * @param {''|'rate'|'cloudflare'|'verify'} [kind] Why a site refused: too many requests, a Cloudflare
     *   "checking your browser" page, or a human check (Turnstile) the server cannot pass.
     * @param {number} [retryIn] ms until the site may be asked again
     */
    constructor(status, message, kind = '', retryIn = 0) {
        super(message);
        this.status = status;
        this.kind = kind;
        this.retryIn = retryIn;
    }
}

// ───────────────────────── Site pauses ─────────────────────────
// When a site refuses (rate limit, Cloudflare challenge, human check), asking again right away only
// makes it worse: Cloudflare answers repeated refused requests with a longer ban (error 1015). So the
// refusal is remembered and the site is not contacted again until the pause ends.

const SITE_NAMES = { chub: 'ChubAI', janny: 'JannyAI', wyvern: 'Wyvern', datacat: 'DataCat', pygmalion: 'Pygmalion' };
const PAUSE_MS = { rate: 10 * 60_000, cloudflare: 5 * 60_000, verify: 30 * 60_000 };
/** @type {Map<string, { until: number, kind: 'rate'|'cloudflare'|'verify', status: number }>} */
const pauses = new Map();

function blockMessage(site, kind, retryIn) {
    const name = SITE_NAMES[String(site).split(':')[0]] ?? 'The site';
    const minutes = Math.max(1, Math.ceil(retryIn / 60_000));
    if (kind === 'rate') return `${name} asked this app to slow down (too many requests). Try again in about ${minutes} min.`;
    const part = String(site).split(':')[1] ?? '';
    if (part === 'search' || part === 'page') return `${name} is blocking requests from this app right now (Cloudflare). Try again in about ${minutes} min.`;
    if (kind === 'verify') return `${name} now asks for a human check before a card can be downloaded, which this app cannot do for you. Open the card on ${name}, download it there, then use "Import a downloaded file".`;
    return `${name} is showing its "checking your browser" page to this app, so the card cannot be downloaded from here right now. Open the card on ${name}, download it there, then use "Import a downloaded file".`;
}

/**
 * Reads why a site refused, from the status, headers and body.
 * @returns {''|'rate'|'cloudflare'|'verify'}
 */
function refusalKind(status, headers, bodyText) {
    if (status === 429) return 'rate';
    if (status !== 403 && status !== 503) return '';
    if (/"turnstile"\s*:/.test(bodyText)) return 'verify';
    if (headers?.get?.('cf-mitigated') || /Just a moment|cf-challenge|challenge-platform|_cf_chl_opt/.test(bodyText)) return 'cloudflare';
    return '';
}

function retryAfterMs(headers, kind) {
    const seconds = Number(headers?.get?.('retry-after'));
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(60 * 60_000, Math.max(30_000, seconds * 1000));
    return PAUSE_MS[kind] ?? 60_000;
}

/** Throws right away if this site (or this part of it) is paused. @param {string} [key] "site" or "site:part" */
function checkPaused(key) {
    if (!key) return;
    const now = Date.now();
    for (const k of new Set([key.split(':')[0], key])) {
        const pause = pauses.get(k);
        if (!pause) continue;
        if (pause.until <= now) {
            pauses.delete(k);
            continue;
        }
        const retryIn = pause.until - now;
        throw new UpstreamError(pause.status, blockMessage(k, pause.kind, retryIn), pause.kind, retryIn);
    }
}

/** Remembers a refusal. A rate limit pauses the whole site; the other refusals only the part that was refused. */
function pauseSite(key, kind, status, headers) {
    if (!key || !kind) return 0;
    const retryIn = retryAfterMs(headers, kind);
    pauses.set(kind === 'rate' ? key.split(':')[0] : key, { until: Date.now() + retryIn, kind, status });
    return retryIn;
}

/**
 * True when the host is one of the allowed hosts or a subdomain of an allowed "*.domain" entry.
 * @param {string} hostname
 * @param {string[]} allowed
 */
function hostAllowed(hostname, allowed) {
    const host = hostname.toLowerCase();
    return allowed.some(entry => entry.startsWith('*.')
        ? host === entry.slice(2) || host.endsWith(entry.slice(1))
        : host === entry);
}

/**
 * Fetches a URL on an allowed https host, with a timeout and a size cap.
 * @param {string|URL} url
 * @param {object} options
 * @param {string[]} options.hosts Allowed hosts ("*.example.com" allows subdomains); empty = any https host
 * @param {number} [options.maxBytes]
 * @param {number} [options.timeout] ms
 * @param {string} [options.method]
 * @param {Record<string,string>} [options.headers]
 * @param {string} [options.body]
 * @param {boolean} [options.browserUa] Send a Chrome User-Agent (default). JannyAI's download API must get
 *   false: Cloudflare challenges a "Chrome" that does not connect like Chrome, but lets a plain client through.
 * @returns {Promise<{ status: number, ok: boolean, buffer: Buffer, headers: Headers, url: string }>}
 */
async function safeFetch(url, { hosts, maxBytes = JSON_MAX_BYTES, timeout = 30_000, method = 'GET', headers = {}, body, browserUa = true } = { hosts: [] }) {
    const target = new URL(url);
    if (target.protocol !== 'https:') throw new UpstreamError(400, 'Only https addresses are allowed');
    if (hosts.length && !hostAllowed(target.hostname, hosts)) throw new UpstreamError(400, `Host not allowed: ${target.hostname}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(target, {
            method,
            headers: browserUa ? { 'User-Agent': BROWSER_UA, ...headers } : headers,
            body,
            signal: controller.signal,
            redirect: 'follow',
        });
        const finalUrl = new URL(response.url || target.href);
        if (finalUrl.protocol !== 'https:' || (hosts.length && !hostAllowed(finalUrl.hostname, hosts))) {
            throw new UpstreamError(502, `Redirected to a host that is not allowed: ${finalUrl.hostname}`);
        }
        const declared = Number(response.headers.get('content-length') || 0);
        if (declared > maxBytes) throw new UpstreamError(502, 'Response too large');
        const chunks = [];
        let size = 0;
        if (response.body) {
            for await (const chunk of response.body) {
                size += chunk.length;
                if (size > maxBytes) {
                    controller.abort();
                    throw new UpstreamError(502, 'Response too large');
                }
                chunks.push(Buffer.from(chunk));
            }
        }
        return { status: response.status, ok: response.ok, buffer: Buffer.concat(chunks), headers: response.headers, url: finalUrl.href };
    } catch (error) {
        if (error instanceof UpstreamError) throw error;
        if (error?.name === 'AbortError') throw new UpstreamError(504, 'The site took too long to answer');
        throw new UpstreamError(502, `Could not reach the site (${error?.cause?.code || error?.message || 'network error'})`);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Turns a refused answer into an UpstreamError, pausing the site when it blocked us.
 * @param {string} [site] pause key, "site" or "site:part"
 */
function refusal(result, site) {
    const body = result.buffer.toString('utf8');
    const kind = refusalKind(result.status, result.headers, body);
    if (kind && site) {
        const retryIn = pauseSite(site, kind, result.status, result.headers);
        return new UpstreamError(result.status, blockMessage(site, kind, retryIn), kind, retryIn);
    }
    const snippet = body.trimStart().startsWith('<') ? '(an HTML page)' : body.slice(0, 200);
    return new UpstreamError(result.status, `The site answered ${result.status}: ${snippet}`, kind);
}

/**
 * Fetches and parses JSON from an allowed host.
 * @param {string|URL} url
 * @param {Parameters<typeof safeFetch>[1] & { site?: string }} options `site` is the pause key for this request
 */
async function fetchJson(url, options) {
    checkPaused(options.site);
    const result = await safeFetch(url, { ...options, headers: { Accept: 'application/json', ...(options.headers ?? {}) } });
    if (!result.ok) throw refusal(result, options.site);
    try {
        return JSON.parse(result.buffer.toString('utf8'));
    } catch {
        throw new UpstreamError(502, 'The site sent an unreadable answer');
    }
}

/**
 * Detects an image type from its first bytes. Anything else is rejected.
 * @param {Buffer} buf
 * @returns {string|null} MIME type
 */
function imageType(buf) {
    if (buf.length < 12) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    if (buf.toString('ascii', 4, 8) === 'ftyp' && /avif|avis|mif1/.test(buf.toString('ascii', 8, 12))) return 'image/avif';
    return null;
}

/** Fetches an image from an allowed host and checks that it really is an image. */
async function fetchImage(url, hosts, headers = {}) {
    const result = await safeFetch(url, { hosts, maxBytes: IMAGE_MAX_BYTES, timeout: 20_000, headers });
    if (!result.ok) return null;
    const type = imageType(result.buffer);
    return type ? { buffer: result.buffer, type } : null;
}

/** Wraps a route so errors become a short JSON message instead of a crash. */
const handle = fn => async (request, response) => {
    try {
        const result = await fn(request, response);
        if (result !== undefined && !response.headersSent) response.json(result);
    } catch (error) {
        const status = error instanceof UpstreamError ? error.status : 500;
        const kind = error instanceof UpstreamError ? error.kind : '';
        console.warn('[Card Browser]', error?.message ?? error);
        if (!response.headersSent) {
            response.status(status >= 400 && status < 600 ? status : 502).json({
                error: String(error?.message ?? 'Unexpected error'),
                ...(kind ? { kind, retryIn: error.retryIn || 0 } : {}),
            });
        }
    }
};

/** Sends an image with a one-day browser cache. */
function sendImage(response, image) {
    if (!image) return response.status(404).json({ error: 'Image not found' });
    response.set('Content-Type', image.type).set('Cache-Control', 'private, max-age=86400').set('X-Content-Type-Options', 'nosniff').send(image.buffer);
}

const str = value => (typeof value === 'string' ? value : '');
const int = (value, fallback, min = 0, max = 1000) => {
    const n = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
/** Path segments for avatar routes: each piece is re-encoded, ".." is refused. */
function cleanPath(value) {
    const parts = String(value ?? '').split('/').filter(Boolean);
    if (!parts.length || parts.some(p => p === '..' || p === '.')) throw new UpstreamError(400, 'Invalid path');
    return parts.map(p => encodeURIComponent(decodeURIComponent(p))).join('/');
}

// ───────────────────────── Building a card PNG ─────────────────────────

/**
 * Builds a Character Card V2 object from loose fields.
 * @param {Record<string, any>} c
 */
function buildCard(c) {
    const asText = v => (typeof v === 'string' ? v : '');
    const greetings = Array.isArray(c.alternate_greetings) ? c.alternate_greetings.filter(x => typeof x === 'string' && x.trim()) : [];
    const tags = Array.isArray(c.tags) ? c.tags.map(t => (typeof t === 'string' ? t : t?.name)).filter(t => typeof t === 'string' && t.trim()).slice(0, 50) : [];
    const data = {
        name: asText(c.name) || 'Unnamed',
        description: asText(c.description),
        personality: asText(c.personality),
        scenario: asText(c.scenario),
        first_mes: asText(c.first_mes),
        mes_example: asText(c.mes_example),
        creator_notes: asText(c.creator_notes),
        system_prompt: asText(c.system_prompt),
        post_history_instructions: asText(c.post_history_instructions),
        alternate_greetings: greetings,
        tags,
        creator: asText(c.creator),
        character_version: asText(c.character_version),
        extensions: c.extensions && typeof c.extensions === 'object' && !Array.isArray(c.extensions) ? c.extensions : {},
    };
    if (c.character_book && typeof c.character_book === 'object' && Array.isArray(c.character_book.entries) && c.character_book.entries.length) {
        data.character_book = c.character_book;
    }
    return { spec: 'chara_card_v2', spec_version: '2.0', data, ...data };
}

/** Turns any avatar image into a PNG that carries the card. Falls back to a plain square. */
async function cardPng(card, avatar) {
    let png;
    try {
        if (avatar?.buffer) {
            png = avatar.type === 'image/png' ? avatar.buffer : await Jimp.read(avatar.buffer).then(image => image.getBuffer(JimpMime.png));
        }
    } catch (error) {
        console.warn('[Card Browser] Could not convert the avatar, using a plain image', error?.message);
    }
    if (!png) {
        const blank = new Jimp({ width: 400, height: 600, color: 0x2a2a2eff });
        png = await blank.getBuffer(JimpMime.png);
    }
    return writeCardMetadata(png, JSON.stringify(card));
}

function sendCard(response, buffer, name) {
    const safe = String(name || 'character').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'character';
    response.set('Content-Type', 'image/png').set('X-Card-Name', encodeURIComponent(safe)).send(buffer);
}

// ───────────────────────── ChubAI ─────────────────────────

const CHUB_HOSTS = ['api.chub.ai'];
const CHUB_AVATAR_HOSTS = ['avatars.charhub.io', '*.charhub.io', '*.chub.ai'];

router.get('/chub/search', handle(async (request) => {
    const q = request.query;
    const params = new URLSearchParams({
        search: str(q.q),
        first: '48',
        page: String(int(q.page, 1, 1, 10_000)),
        namespace: 'characters',
        nsfw: q.nsfw === 'false' ? 'false' : 'true',
        nsfl: q.nsfw === 'false' ? 'false' : 'true',
        nsfw_only: 'false',
        chub: 'true',
        count: 'true',
        include_forks: 'true',
        venus: 'false',
        min_tokens: String(int(q.min_tokens, 50, 0, 1_000_000)),
    });
    if (str(q.sort) && q.sort !== 'default') params.set('sort', str(q.sort));
    if (q.asc === 'true') params.set('asc', 'true');
    if (int(q.max_days_ago, 0, 0, 10_000) > 0) params.set('max_days_ago', String(int(q.max_days_ago, 0, 0, 10_000)));
    if (str(q.special_mode)) params.set('special_mode', str(q.special_mode));
    if (str(q.tags)) params.set('topics', str(q.tags));
    if (str(q.excludeTags)) params.set('excludetopics', str(q.excludeTags));
    return fetchJson(`${CHUB_API}/search?${params}`, { hosts: CHUB_HOSTS });
}));

router.get('/chub/character/*', handle(async (request) => {
    const fullPath = cleanPath(request.params[0]);
    return fetchJson(`${CHUB_API}/api/characters/${fullPath}?full=true&nocache=${Date.now()}`, { hosts: CHUB_HOSTS, headers: { 'Cache-Control': 'no-cache' } });
}));

router.get('/chub/avatar/*', handle(async (request, response) => {
    const fullPath = cleanPath(request.params[0]);
    const order = request.query.full === '1' ? ['chara_card_v2.png', 'avatar.webp'] : ['avatar.webp', 'chara_card_v2.png'];
    let image = await fetchImage(`${CHUB_AVATARS}/avatars/${fullPath}/${order[0]}`, CHUB_AVATAR_HOSTS).catch(() => null);
    image ??= await fetchImage(`${CHUB_AVATARS}/avatars/${fullPath}/${order[1]}`, CHUB_AVATAR_HOSTS).catch(() => null);
    sendImage(response, image);
}));

async function chubCard(id) {
    const fullPath = cleanPath(id);
    const direct = await safeFetch(`${CHUB_AVATARS}/avatars/${fullPath}/chara_card_v2.png`, { hosts: CHUB_AVATAR_HOSTS, maxBytes: CARD_MAX_BYTES, timeout: 60_000 }).catch(() => null);
    if (direct?.ok && imageType(direct.buffer) === 'image/png' && direct.buffer.includes('tEXtchara')) {
        return direct.buffer;
    }
    // No ready-made card: build one from the character definition.
    const raw = await fetchJson(`${CHUB_API}/api/characters/${fullPath}?full=true`, { hosts: CHUB_HOSTS });
    const node = raw?.node ?? raw?.data?.node;
    const def = node?.definition;
    if (!def) throw new UpstreamError(404, 'Chub did not return this character');
    const avatar = direct?.ok && imageType(direct.buffer) ? { buffer: direct.buffer, type: imageType(direct.buffer) }
        : await fetchImage(`${CHUB_AVATARS}/avatars/${fullPath}/avatar.webp`, CHUB_AVATAR_HOSTS).catch(() => null);
    return cardPng(buildCard({
        name: def.name || node.name,
        description: def.personality,
        personality: def.tavern_personality,
        scenario: def.scenario,
        first_mes: def.first_message,
        mes_example: def.example_dialogs,
        creator_notes: def.description,
        system_prompt: def.system_prompt,
        post_history_instructions: def.post_history_instructions,
        alternate_greetings: def.alternate_greetings,
        character_book: def.embedded_lorebook,
        tags: node.topics,
        creator: String(node.fullPath || '').split('/')[0],
        extensions: def.extensions,
    }), avatar);
}

// ───────────────────────── JannyAI ─────────────────────────

const JANNY_HOSTS = ['jannyai.com', 'api.jannyai.com', 'search.jannyai.com'];
let jannyToken = { value: '', fallback: false, at: 0 };
let jannyTokenInFlight = null;

async function jannyPage(path) {
    try {
        checkPaused('janny:page');
    } catch {
        return null;
    }
    for (const base of [JANNY_SITE, JANNY_API_SITE]) {
        try {
            const res = await safeFetch(`${base}${path}`, { hosts: JANNY_HOSTS, maxBytes: JSON_MAX_BYTES, timeout: 15_000, headers: { Accept: 'text/html,application/xhtml+xml,*/*' } });
            const html = res.buffer.toString('utf8');
            if (res.ok) return html;
            // Blocked: stop asking JannyAI's pages for a while instead of retrying on every click.
            const kind = refusalKind(res.status, res.headers, html);
            if (kind) {
                pauseSite('janny:page', kind, res.status, res.headers);
                return null;
            }
        } catch { /* try the next address */ }
    }
    return null;
}

/** The public search key JannyAI's own site uses; read from its page bundle, cached for 5 minutes. */
async function getJannyToken(force = false) {
    const ttl = jannyToken.fallback ? 60_000 : 5 * 60_000;
    if (!force && jannyToken.value && Date.now() - jannyToken.at < ttl) return jannyToken.value;
    jannyTokenInFlight ??= (async () => {
        let value = '';
        try {
            const html = await jannyPage('/characters/search');
            let configPath = html?.match(/client-config\.[a-zA-Z0-9_-]+\.js/)?.[0] ?? null;
            if (!configPath && html) {
                const searchPage = html.match(/SearchPage\.[a-zA-Z0-9_-]+\.js/)?.[0];
                const js = searchPage ? await jannyPage(`/_astro/${searchPage}`) : null;
                configPath = js?.match(/client-config\.[a-zA-Z0-9_-]+\.js/)?.[0] ?? null;
            }
            if (configPath) {
                const js = await jannyPage(`/_astro/${configPath}`);
                value = js?.match(/"([a-f0-9]{64})"/)?.[1] ?? '';
            }
        } catch { /* use the known key */ }
        jannyToken = { value: value || JANNY_FALLBACK_TOKEN, fallback: !value, at: Date.now() };
        return jannyToken.value;
    })().finally(() => { jannyTokenInFlight = null; });
    return jannyTokenInFlight;
}

function jannySearchHeaders(token) {
    return {
        Accept: '*/*',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Origin: JANNY_SITE,
        Referer: `${JANNY_SITE}/`,
        'x-meilisearch-client': 'Meilisearch instant-meilisearch (v0.19.0) ; Meilisearch JavaScript (v0.41.0)',
    };
}

router.get('/janny/token', handle(async (request) => ({ token: await getJannyToken(request.query.force === '1') })));

/** Server-side search, used only when the browser could not search JannyAI directly. */
router.post('/janny/search', handle(async (request) => {
    const query = request.body?.query;
    if (!query || typeof query !== 'object') throw new UpstreamError(400, 'Missing query');
    const body = JSON.stringify({ queries: [{ ...query, indexUid: 'janny-characters' }] });
    checkPaused('janny:search');
    let token = await getJannyToken();
    let res = await safeFetch(JANNY_SEARCH_URL, { hosts: JANNY_HOSTS, method: 'POST', headers: jannySearchHeaders(token), body });
    // A 401/403 without a Cloudflare page means the search key changed: read it again once.
    if ((res.status === 401 || res.status === 403) && !refusalKind(res.status, res.headers, res.buffer.toString('utf8'))) {
        token = await getJannyToken(true);
        res = await safeFetch(JANNY_SEARCH_URL, { hosts: JANNY_HOSTS, method: 'POST', headers: jannySearchHeaders(token), body });
    }
    if (!res.ok) throw refusal(res, 'janny:search');
    try {
        return JSON.parse(res.buffer.toString('utf8'));
    } catch {
        throw new UpstreamError(502, 'JannyAI sent an unreadable answer');
    }
}));

router.get('/janny/avatar/*', handle(async (request, response) => {
    sendImage(response, await fetchImage(`${JANNY_IMAGES}${cleanPath(request.params[0])}`, ['image.jannyai.com']));
}));

function decodeAstro(value) {
    if (!Array.isArray(value)) return value;
    const [type, data] = value;
    if (type === 0 && data && typeof data === 'object' && !Array.isArray(data)) {
        return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, decodeAstro(v)]));
    }
    if (type === 1 && Array.isArray(data)) return data.map(decodeAstro);
    return data;
}

/** Reads the character data that JannyAI's character page embeds for its own scripts. */
function parseJannyPage(html) {
    if (!html || /Just a moment|cf-challenge|challenge-platform/.test(html)) return null;
    const match = html.match(/<astro-island[^>]*component-export="CharacterButtons"[^>]*\sprops="([^"]+)"/)
        ?? html.match(/<astro-island[^>]*\sprops="([^"]*character[^"]*)"/);
    if (!match) return null;
    try {
        const decoded = match[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, '\'').replace(/&amp;/g, '&');
        return decodeAstro(JSON.parse(decoded).character) ?? null;
    } catch {
        return null;
    }
}

router.get('/janny/character/:id', handle(async (request) => {
    const id = String(request.params.id || '').replace(/[^\w-]/g, '');
    const slug = String(request.query.slug || 'character').replace(/[^\w-]/g, '') || 'character';
    if (!id) throw new UpstreamError(400, 'Missing character id');
    const html = await jannyPage(`/characters/${id}_${slug}`);
    const character = parseJannyPage(html);
    if (!character) throw new UpstreamError(404, 'JannyAI did not share this character page (it may be behind Cloudflare).');
    return { character };
}));

async function jannyCard(id) {
    const characterId = String(id || '').trim();
    if (!characterId || characterId.length > 256) throw new UpstreamError(400, 'Invalid JannyAI character id');
    const payload = await fetchJson(JANNY_DOWNLOAD_API, {
        hosts: ['api.jannyai.com'],
        site: 'janny:download',
        browserUa: false,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ characterId }),
    });
    if (payload?.status !== 'ok' || typeof payload.downloadUrl !== 'string') {
        throw new UpstreamError(502, typeof payload?.error === 'string' ? payload.error : 'JannyAI did not provide the card');
    }
    return jannyCardFile(payload.downloadUrl);
}

/** True for addresses that point at this computer or a private network, which a card link must never use. */
function isLocalHost(hostname) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')
        || /^[\d.]+$/.test(host) || host.includes(':');
}

/**
 * Downloads the card file JannyAI's download API pointed to. The file lives on JannyAI's storage, so any
 * public https host is accepted, but the answer must be a PNG that carries a character card.
 */
async function jannyCardFile(downloadUrl) {
    let target;
    try {
        target = new URL(String(downloadUrl));
    } catch {
        throw new UpstreamError(400, 'JannyAI sent an invalid card link');
    }
    if (target.protocol !== 'https:' || isLocalHost(target.hostname)) throw new UpstreamError(400, 'JannyAI sent a card link that is not allowed');
    const res = await safeFetch(target, { hosts: [], maxBytes: CARD_MAX_BYTES, timeout: 60_000, browserUa: false, headers: { Accept: 'image/png,application/octet-stream;q=0.9' } });
    if (isLocalHost(new URL(res.url).hostname)) throw new UpstreamError(400, 'JannyAI sent a card link that is not allowed');
    if (!res.ok) throw refusal(res, 'janny:download');
    if (imageType(res.buffer) !== 'image/png' || !/tEXt(chara|ccv3)/.test(res.buffer.toString('latin1'))) {
        throw new UpstreamError(502, 'JannyAI sent an invalid card file');
    }
    return res.buffer;
}

/**
 * Used when the browser itself got the card link from JannyAI (JannyAI often blocks this server but
 * not the user's own browser) and the card file could not be read from the browser.
 */
router.post('/janny/card-file', handle(async (request, response) => {
    const url = str(request.body?.url);
    if (!url) throw new UpstreamError(400, 'Missing card link');
    sendCard(response, await jannyCardFile(url), str(request.body?.name));
}));

// ───────────────────────── Wyvern ─────────────────────────

const WYVERN_HOSTS = ['api.wyvern.chat'];

router.get('/wyvern/search', handle(async (request) => {
    const q = request.query;
    const params = new URLSearchParams({ limit: '48', page: String(int(q.page, 1, 1, 10_000)) });
    if (str(q.tags)) params.set('tags', str(q.tags));
    if (str(q.q)) {
        params.set('q', str(q.q));
    } else {
        params.set('sort', str(q.sort) || 'popular');
        params.set('order', 'DESC');
    }
    if (str(q.rating)) params.set('rating', str(q.rating));
    return fetchJson(`${WYVERN_API}/exploreSearch/characters?${params}`, { hosts: WYVERN_HOSTS });
}));

router.get('/wyvern/character/:id', handle(async (request) => {
    const id = encodeURIComponent(String(request.params.id || ''));
    if (!id) throw new UpstreamError(400, 'Missing character id');
    return fetchJson(`${WYVERN_API}/characters/${id}`, { hosts: WYVERN_HOSTS });
}));

function wyvernAvatarUrl(src) {
    const value = String(src || '');
    if (!value) return '';
    if (value.startsWith('http')) return value;
    return `https://imagedelivery.net/${value.replace(/^\/+/, '')}${value.includes('/public') ? '' : '/public'}`;
}

router.get('/wyvern/avatar', handle(async (request, response) => {
    const url = wyvernAvatarUrl(request.query.src);
    if (!url) throw new UpstreamError(400, 'Missing image');
    sendImage(response, await fetchImage(url, ['imagedelivery.net', '*.imagedelivery.net', '*.wyvern.chat']));
}));

async function wyvernCard(id) {
    const c = await fetchJson(`${WYVERN_API}/characters/${encodeURIComponent(String(id))}`, { hosts: WYVERN_HOSTS });
    if (!c || typeof c !== 'object') throw new UpstreamError(404, 'Wyvern did not return this character');
    const avatarUrl = wyvernAvatarUrl(c.avatar_url || c.avatar);
    const avatar = avatarUrl ? await fetchImage(avatarUrl, ['imagedelivery.net', '*.imagedelivery.net', '*.wyvern.chat']).catch(() => null) : null;
    return cardPng(buildCard({
        name: c.name,
        description: c.description,
        personality: c.personality,
        scenario: c.scenario,
        first_mes: c.first_mes,
        mes_example: c.mes_example,
        creator_notes: c.creator_notes,
        system_prompt: c.system_prompt ?? c.systemPrompt,
        post_history_instructions: c.post_history_instructions ?? c.postHistoryInstructions,
        alternate_greetings: c.alternate_greetings,
        character_book: c.character_book ?? c.embedded_lorebook,
        tags: c.tags,
        creator: c.creator?.displayName || c.creator?.username,
        character_version: c.character_version,
    }), avatar);
}

// ───────────────────────── DataCat ─────────────────────────

const DATACAT_HOSTS = ['datacat.run'];
let datacatSession = '';
let datacatSessionInFlight = null;

async function getDatacatSession(force = false) {
    if (datacatSession && !force) return datacatSession;
    datacatSessionInFlight ??= (async () => {
        const data = await fetchJson(`${DATACAT_API}/api/liberator/identify`, {
            hosts: DATACAT_HOSTS,
            site: 'datacat',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: DATACAT_API, Referer: `${DATACAT_API}/` },
            body: JSON.stringify({ deviceToken: randomUUID() }),
        });
        if (!data?.success || !data?.sessionToken) throw new UpstreamError(502, 'DataCat did not open a session');
        datacatSession = data.sessionToken;
        return datacatSession;
    })().finally(() => { datacatSessionInFlight = null; });
    return datacatSessionInFlight;
}

/** @param {string} path @param {string} [site] pause key; downloads use "datacat:download" */
async function datacatGet(path, site = 'datacat') {
    const headers = token => ({ Origin: DATACAT_API, Referer: `${DATACAT_API}/`, 'X-Session-Token': token });
    checkPaused(site);
    try {
        return await fetchJson(`${DATACAT_API}${path}`, { hosts: DATACAT_HOSTS, site, headers: headers(await getDatacatSession()) });
    } catch (error) {
        if (error?.status !== 401) throw error;
        return fetchJson(`${DATACAT_API}${path}`, { hosts: DATACAT_HOSTS, site, headers: headers(await getDatacatSession(true)) });
    }
}

const idList = value => String(value ?? '').split(',').map(s => s.trim()).filter(s => /^\d+$/.test(s)).join(',');

router.get('/datacat/recent', handle(async (request) => {
    const q = request.query;
    const params = new URLSearchParams({
        limit: '80',
        offset: String(int(q.offset, 0, 0, 1_000_000)),
        summary: '1',
        minTotalTokens: String(int(q.min_tokens, 889, 0, 1_000_000)),
    });
    if (idList(q.tagIds)) params.set('tagIds', idList(q.tagIds));
    if (str(q.q).trim()) params.set('search', str(q.q).trim());
    return datacatGet(`/api/characters/recent-public?${params}`);
}));

router.get('/datacat/fresh', handle(async () => datacatGet(`/api/characters/fresh?${new URLSearchParams({ summary: '1', sortBy: 'score', limit24: '80', limitWeek: '0' })}`)));

router.get('/datacat/tags', handle(async () => datacatGet(`/api/tags/faceted?${new URLSearchParams({ mode: 'recent', minTotalTokens: '889' })}`)));

router.get('/datacat/character/:id', handle(async (request) => datacatGet(`/api/characters/${encodeURIComponent(String(request.params.id || ''))}`)));

router.get('/datacat/download/:id', handle(async (request) => datacatGet(`/api/characters/${encodeURIComponent(String(request.params.id || ''))}/download?t=${Date.now()}`, 'datacat:download')));

const DATACAT_IMAGE_HOSTS = ['ella.janitorai.com', 'media.datacat.run'];
function datacatAvatarUrl(src) {
    const value = String(src || '');
    if (!value) return '';
    return value.startsWith('http') ? value : `${DATACAT_IMAGES}${value.replace(/^\/+/, '')}`;
}

router.get('/datacat/avatar', handle(async (request, response) => {
    const url = datacatAvatarUrl(request.query.src);
    if (!url) throw new UpstreamError(400, 'Missing image');
    sendImage(response, await fetchImage(url, DATACAT_IMAGE_HOSTS, { Referer: `${DATACAT_API}/` }));
}));

/**
 * DataCat card. The ready-made card (/download) now often asks for a human check; then the card is
 * built from the public character page data instead, the same way Marinara Engine imports DataCat.
 */
async function datacatCard(id, avatarSrc, name) {
    const safeId = encodeURIComponent(String(id));
    let card = null;
    let avatarFrom = '';
    try {
        const dl = await datacatGet(`/api/characters/${safeId}/download?t=${Date.now()}`, 'datacat:download');
        const d = dl?.data ?? dl;
        if (d && typeof d === 'object' && (d.description || d.first_mes || d.personality)) {
            card = buildCard({ ...d, character_book: d.character_book });
            avatarFrom = d.avatar;
        }
    } catch (error) {
        if (error?.kind === 'rate') throw error;
    }
    if (!card) {
        const raw = await datacatGet(`/api/characters/${safeId}`);
        const c = raw?.character ?? raw;
        if (!c || typeof c !== 'object') throw new UpstreamError(404, 'DataCat did not return this character');
        const pick = (...values) => values.find(v => typeof v === 'string' && v.trim()) ?? '';
        const greetings = [c.alternate_greetings, c.alternateGreetings, c.first_messages, c.firstMessages].find(Array.isArray) ?? [];
        const first = pick(c.first_mes, c.first_message, c.firstMessage, greetings[0]);
        card = buildCard({
            name: pick(c.name, c.chat_name, c.chatName, name),
            description: pick(c.personality, c.description_text),
            scenario: pick(c.scenario),
            first_mes: first,
            mes_example: pick(c.mes_example, c.example_dialogs, c.exampleDialogs),
            creator_notes: pick(c.description).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').trim(),
            system_prompt: pick(c.system_prompt, c.systemPrompt),
            post_history_instructions: pick(c.post_history_instructions, c.postHistoryInstructions),
            alternate_greetings: greetings.filter(g => typeof g === 'string' && g !== first),
            tags: Array.isArray(c.tags) ? c.tags : [],
            creator: pick(c.creator_name, c.creatorName),
            extensions: { datacat: { id: String(id) } },
        });
        avatarFrom = c.avatar;
    }
    const url = datacatAvatarUrl(avatarSrc || avatarFrom);
    const avatar = url ? await fetchImage(url, DATACAT_IMAGE_HOSTS, { Referer: `${DATACAT_API}/` }).catch(() => null) : null;
    return cardPng(card, avatar);
}

// ───────────────────────── Pygmalion (public, SFW only) ─────────────────────────

const PYG_HOSTS = ['server.pygmalion.chat'];

router.get('/pygmalion/search', handle(async (request) => {
    const q = request.query;
    const message = {
        query: str(q.q),
        orderBy: str(q.orderBy) || 'downloads',
        orderDescending: q.orderDescending !== 'false',
        pageSize: 48,
        page: int(q.page, 0, 0, 10_000),
    };
    if (str(q.tagsInclude)) message.tagsNamesInclude = str(q.tagsInclude).split(',').map(t => t.trim()).filter(Boolean);
    if (str(q.tagsExclude)) message.tagsNamesExclude = str(q.tagsExclude).split(',').map(t => t.trim()).filter(Boolean);
    const params = new URLSearchParams({ connect: 'v1', encoding: 'json', message: JSON.stringify(message) });
    return fetchJson(`${PYGMALION_API}/CharacterSearch?${params}`, { hosts: PYG_HOSTS });
}));

async function pygmalionCharacter(id) {
    const params = new URLSearchParams({ connect: 'v1', encoding: 'json', message: JSON.stringify({ characterMetaId: String(id) }) });
    return fetchJson(`${PYGMALION_API}/Character?${params}`, { hosts: PYG_HOSTS });
}

router.get('/pygmalion/character', handle(async (request) => pygmalionCharacter(str(request.query.id))));

const PYG_IMAGE_HOSTS = ['pygmalion.chat', '*.pygmalion.chat'];
function pygAvatarUrl(src) {
    const value = String(src || '');
    if (!value) return '';
    return value.startsWith('http') ? value : `${PYGMALION_ASSETS}/${value.replace(/^\/+/, '')}`;
}

router.get('/pygmalion/avatar', handle(async (request, response) => {
    const url = pygAvatarUrl(request.query.src);
    if (!url) throw new UpstreamError(400, 'Missing image');
    sendImage(response, await fetchImage(url, PYG_IMAGE_HOSTS));
}));

async function pygmalionCard(id) {
    const data = await pygmalionCharacter(id);
    const c = data?.character;
    if (!c) throw new UpstreamError(404, 'Pygmalion did not return this character');
    const p = c.personality || {};
    const url = pygAvatarUrl(c.avatarUrl);
    const avatar = url ? await fetchImage(url, PYG_IMAGE_HOSTS).catch(() => null) : null;
    return cardPng(buildCard({
        name: c.displayName || p.name,
        description: p.persona,
        first_mes: p.greeting,
        mes_example: p.mesExample,
        creator_notes: p.characterNotes || c.description,
        system_prompt: p.systemPrompt,
        post_history_instructions: p.postHistoryInstructions,
        alternate_greetings: p.alternateGreetings,
        tags: c.tags,
        creator: c.owner?.username || c.owner?.displayName,
    }), avatar);
}

// ───────────────────────── Card download (for import) ─────────────────────────

/** Returns a PNG character card for the chosen character; the page imports it like a dropped file. */
router.get('/card', handle(async (request, response) => {
    const source = str(request.query.source);
    const id = str(request.query.id);
    if (!id) throw new UpstreamError(400, 'Missing character id');
    let buffer;
    switch (source) {
        case 'chub': buffer = await chubCard(id); break;
        case 'janny': buffer = await jannyCard(id); break;
        case 'wyvern': buffer = await wyvernCard(id); break;
        case 'datacat': buffer = await datacatCard(id, str(request.query.avatar), str(request.query.name)); break;
        case 'pygmalion': buffer = await pygmalionCard(id); break;
        default: throw new UpstreamError(400, 'Unknown source');
    }
    sendCard(response, buffer, str(request.query.name));
}));
