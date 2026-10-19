// Classic UI fork: Card Browser.
//
// A full page for finding character cards on ChubAI, JannyAI, Wyvern, DataCat and Pygmalion and
// importing them. Searches go through this app's own server (src/endpoints/classic-card-browser.js),
// which talks to each site directly. JannyAI search is first tried from the browser itself, because
// JannyAI often blocks server requests; it only sends the search words to JannyAI.
//
// Safety: everything that comes from these sites is shown as plain text (textContent), never as
// HTML, and nothing from them is executed. Importing downloads the card as a PNG and hands it to
// SillyTavern's normal "Import Character from File".
//
// Open it from its own globe button in the top bar, the globe in the Characters panel, Home -> Tools, or with
// globalThis.SillyBunnyClassicCardBrowser.open().

import { helpButton, closeHelp } from './classic-help.js';

const API = '/api/classic-cards';
const STORE_KEY = 'ct-card-browser';

const HELP_HTML = `
<p>Find character cards on public sites and add them to your library.</p>
<ul>
<li><b>Source:</b> pick the site to search (ChubAI, JannyAI, Wyvern, DataCat or Pygmalion).</li>
<li><b>Search</b> starts by itself when you stop typing. <b>Sort</b> changes the order.</li>
<li><b>Tags:</b> tick a tag to require it, or press its red <b>&minus;</b> to hide cards that have it. Click an active tag at the top of the list to remove it.</li>
<li><b>Filters:</b> extra options for the current source (for example, only cards with a lorebook, or a token range).</li>
<li>Click a card to read its description, greetings and scenario before importing.</li>
<li><b>Import</b> adds the card to your Characters. <b>Chat now</b> opens it.</li>
</ul>
<p>Searches go from this app straight to each site. Card text is shown as plain text, so nothing from these sites can run inside SillyTavern.</p>`;

const NSFW_HELP = `<p>Shows cards marked as adult (NSFW). Each source remembers its own choice.</p>
<p>DataCat only lists adult cards. Pygmalion only lists safe cards here, because adult cards need a Pygmalion login.</p>`;

// ───────────────────────── Helpers ─────────────────────────

const ctx = () => {
    try {
        return globalThis.SillyTavern?.getContext?.();
    } catch {
        return null;
    }
};

function headers(json = false) {
    const base = ctx()?.getRequestHeaders?.() ?? {};
    if (!json) delete base['Content-Type'];
    return base;
}

async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(`${API}${path}`, {
        method,
        headers: headers(Boolean(body)),
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-cache',
    });
    if (!res.ok) throw await responseError(res, `Request failed (${res.status})`);
    return res.json();
}

/**
 * Builds an Error from a failed answer of this app's server. `kind` says why a site refused:
 * 'rate' (too many requests), 'cloudflare' ("checking your browser" page) or 'verify' (human check).
 */
async function responseError(res, fallback) {
    const data = await res.json().catch(() => null);
    const error = new Error(data?.error || fallback);
    error.kind = typeof data?.kind === 'string' ? data.kind : '';
    return error;
}

/** Card sites that need the user to download the card themselves (opened in a new tab). */
const needsManualDownload = error => error?.kind === 'verify' || error?.kind === 'cloudflare';

const encodePath = value => String(value ?? '').split('/').map(encodeURIComponent).join('/');
const plain = value => (typeof value === 'string' ? value.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'').trim() : '');
const text = value => (typeof value === 'string' && value.trim() ? value.trim() : '');
const list = value => (Array.isArray(value) ? value.filter(x => typeof x === 'string' && x.trim()) : []);
const fmt = n => {
    const v = Number(n) || 0;
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
    return String(v);
};
const slugify = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function loadStore() {
    try {
        return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {};
    } catch {
        return {};
    }
}
function saveStore(data) {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(data));
    } catch { /* private window: keep in memory only */ }
}

/** Reads the "chara" (or "ccv3") card JSON out of a PNG file. */
async function readCardFromPng(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer);
    let offset = 8;
    let found = null;
    while (offset + 8 <= bytes.length) {
        const length = view.getUint32(offset);
        const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
        if (type === 'tEXt') {
            const data = bytes.subarray(offset + 8, offset + 8 + length);
            const zero = data.indexOf(0);
            const keyword = new TextDecoder('latin1').decode(data.subarray(0, zero)).toLowerCase();
            if (keyword === 'chara' || (keyword === 'ccv3' && !found)) {
                const b64 = new TextDecoder('latin1').decode(data.subarray(zero + 1));
                const json = new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
                found = JSON.parse(json);
                if (keyword === 'chara') break;
            }
        }
        if (type === 'IEND') break;
        offset += 12 + length;
    }
    return found;
}

function detailFromCard(card) {
    const d = card?.data ?? card ?? {};
    return {
        description: text(d.description),
        personality: text(d.personality),
        scenario: text(d.scenario),
        firstMessage: text(d.first_mes),
        alternateGreetings: list(d.alternate_greetings),
        exampleDialogs: text(d.mes_example),
        creatorNotes: plain(d.creator_notes),
        systemPrompt: text(d.system_prompt),
        postHistory: text(d.post_history_instructions),
        hasLorebook: Array.isArray(d.character_book?.entries) && d.character_book.entries.length > 0,
    };
}

// ───────────────────────── Sources ─────────────────────────

const CHUB_SORTS = {
    popular_all: { label: 'Most downloaded', sort: 'download_count', days: 0 },
    popular_week: { label: 'Hot this week', sort: 'download_count', days: 7 },
    popular_month: { label: 'Hot this month', sort: 'download_count', days: 30 },
    rated_week: { label: 'Top rated (week)', sort: 'star_count', days: 7 },
    rated_all: { label: 'Top rated (all time)', sort: 'star_count', days: 0 },
    newest: { label: 'Newest', sort: 'id', days: 30 },
    updated: { label: 'Recently updated', sort: 'last_activity_at', days: 0 },
    recent_hits: { label: 'Recent hits', sort: 'default', days: 0, special: 'newcomer' },
    random: { label: 'Random', sort: 'random', days: 0 },
};

/** Common ChubAI topics, so the tag list is useful before the first search. Tags seen in results are added to it. */
const CHUB_TAGS = ['Action', 'Adventure', 'Alternate Greetings', 'Angst', 'Anime', 'Anime Game Characters', 'AnyPOV', 'Assistant', 'Books', 'Celebrity', 'Childhood Friend', 'Comedy', 'Cute', 'Cyberpunk', 'Dark Fantasy', 'Demon', 'Detective', 'Dominant', 'Drama', 'Elf', 'Enemies to Lovers', 'Fantasy', 'Female', 'Fluff', 'Furry', 'Game Characters', 'Historical', 'Horror', 'Human', 'Isekai', 'Knight', 'Kuudere', 'Lorebook', 'Magic', 'Male', 'Medieval', 'Military', 'Modern', 'Monster', 'Monster Girl', 'Movies & TV', 'Multiple Characters', 'Mystery', 'NSFW', 'OC', 'Original Character', 'Post-apocalyptic', 'Psychological', 'Robot', 'Roleplay', 'Romance', 'Royalty', 'RPG', 'Scenario', 'School', 'Sci-Fi', 'Simulator', 'Slice of Life', 'Submissive', 'Supernatural', 'Tomboy', 'Tsundere', 'Utility', 'Vampire', 'Villain', 'Western', 'Wholesome', 'Witch', 'Yandere'];

/** Filters each source understands. 'must': required card parts; 'direction': ascending/descending; 'tokens': token range. */
const MUST_HAVE = [
    ['gallery', 'fa-images', 'Image gallery', 'require_images'],
    ['lore', 'fa-book-atlas', 'Lorebook', 'require_lore'],
    ['expressions', 'fa-face-smile', 'Expressions', 'require_expressions'],
    ['greetings', 'fa-comments', 'Alt greetings', 'require_alternate_greetings'],
];

const JANNY_TAGS = { 1: 'Male', 2: 'Female', 3: 'Non-binary', 4: 'Celebrity', 5: 'OC', 6: 'Fictional', 7: 'Real', 8: 'Game', 9: 'Anime', 10: 'Historical', 11: 'Royalty', 12: 'Detective', 13: 'Hero', 14: 'Villain', 15: 'Magical', 16: 'Non-human', 17: 'Monster', 18: 'Monster Girl', 19: 'Alien', 20: 'Robot', 21: 'Politics', 22: 'Vampire', 23: 'Giant', 24: 'OpenAI', 25: 'Elf', 26: 'Multiple', 27: 'VTuber', 28: 'Dominant', 29: 'Submissive', 30: 'Scenario', 31: 'Pokemon', 32: 'Assistant', 34: 'Non-English', 36: 'Philosophy', 38: 'RPG', 39: 'Religion', 41: 'Books', 42: 'AnyPOV', 43: 'Angst', 44: 'Demi-Human', 45: 'Enemies to Lovers', 46: 'Smut', 47: 'MLM', 48: 'WLW', 49: 'Action', 50: 'Romance', 51: 'Horror', 52: 'Slice of Life', 53: 'Fantasy', 54: 'Drama', 55: 'Comedy', 56: 'Mystery', 57: 'Sci-Fi', 59: 'Yandere', 60: 'Furry', 61: 'Movies/TV' };
const JANNY_TAG_IDS = Object.fromEntries(Object.entries(JANNY_TAGS).map(([id, name]) => [name.toLowerCase(), Number(id)]));

const datacatTags = { byName: new Map(), byId: new Map(), top: [], loaded: false, loading: null };
async function loadDatacatTags() {
    if (datacatTags.loaded) return;
    datacatTags.loading ??= (async () => {
        try {
            const data = await api('/datacat/tags');
            const rows = Array.isArray(data?.tags) ? data.tags : Array.isArray(data?.facets) ? data.facets : Array.isArray(data) ? data : [];
            const sortable = [];
            for (const t of rows) {
                const id = Number(t?.id ?? t?.tag_id ?? t?.tagId);
                const name = String(t?.name || t?.slug || '');
                if (!Number.isFinite(id) || !name) continue;
                datacatTags.byName.set(name.toLowerCase(), id);
                datacatTags.byId.set(id, name);
                sortable.push({ name, count: Number(t?.count) || 0 });
            }
            datacatTags.top = sortable.sort((a, b) => b.count - a.count).slice(0, 60).map(t => t.name);
            datacatTags.loaded = true;
        } finally {
            datacatTags.loading = null;
        }
    })();
    return datacatTags.loading;
}

/** Drops cards that carry any excluded tag (for sites that cannot exclude tags themselves). */
const withoutExcluded = (cards, exclude) => {
    if (!exclude.length) return cards;
    const ex = exclude.map(t => t.toLowerCase());
    return cards.filter(card => !card.tags.some(t => ex.includes(t.toLowerCase())));
};

const SOURCES = {
    chub: {
        name: 'ChubAI',
        short: 'Chub',
        icon: 'fa-solid fa-star-of-life',
        site: 'https://chub.ai',
        sorts: Object.fromEntries(Object.entries(CHUB_SORTS).map(([k, v]) => [k, v.label])),
        defaultSort: 'popular_all',
        nsfw: 'toggle',
        pageSize: 48,
        filters: ['must', 'direction', 'tokens'],
        suggestedTags: CHUB_TAGS,
        async search(p) {
            const preset = CHUB_SORTS[p.sort] ?? CHUB_SORTS.popular_all;
            const params = new URLSearchParams({ q: p.query, page: String(p.page), nsfw: String(p.nsfw) });
            if (p.query.trim()) {
                if (preset.sort !== 'default') params.set('sort', preset.sort);
            } else {
                params.set('sort', preset.sort);
                if (preset.days) params.set('max_days_ago', String(preset.days));
                if (preset.special) params.set('special_mode', preset.special);
            }
            if (p.include.length) params.set('tags', p.include.join(','));
            if (p.exclude.length) params.set('excludeTags', p.exclude.join(','));
            for (const [key, , , param] of MUST_HAVE) if (p.filters.must[key]) params.set(param, 'true');
            if (p.filters.asc) params.set('asc', 'true');
            if (p.filters.minTokens) params.set('min_tokens', String(p.filters.minTokens));
            if (p.filters.maxTokens) params.set('max_tokens', String(p.filters.maxTokens));
            const raw = await api(`/chub/search?${params}`);
            const data = raw?.data ?? raw;
            const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
            const count = Number(data?.count);
            return {
                total: Number.isFinite(count) && count > 0 ? count : null,
                hasMore: Boolean(data?.cursor) || nodes.length >= 48,
                cards: nodes.map(n => ({
                    id: n.fullPath,
                    name: n.name || 'Unnamed',
                    creator: String(n.fullPath || '').split('/')[0],
                    tagline: plain(n.tagline),
                    tags: list(n.topics),
                    avatar: `${API}/chub/avatar/${encodePath(n.fullPath)}`,
                    avatarFull: `${API}/chub/avatar/${encodePath(n.fullPath)}?full=1`,
                    stats: [['fa-download', 'Downloads', n.starCount], ['fa-comment', 'Chats', n.nChats], ['fa-hashtag', 'Tokens', n.nTokens]],
                    nsfw: n.nsfw === true || list(n.topics).some(t => t.toLowerCase() === 'nsfw'),
                    url: `https://chub.ai/characters/${n.fullPath}`,
                    raw: n,
                })),
            };
        },
        async detail(card) {
            const raw = await api(`/chub/character/${encodePath(card.id)}`);
            const node = raw?.node ?? raw?.data?.node;
            const def = node?.definition ?? {};
            return {
                description: text(def.personality),
                personality: text(def.tavern_personality),
                scenario: text(def.scenario),
                firstMessage: text(def.first_message),
                alternateGreetings: list(def.alternate_greetings),
                exampleDialogs: text(def.example_dialogs),
                creatorNotes: plain(def.description),
                systemPrompt: text(def.system_prompt),
                postHistory: text(def.post_history_instructions),
                hasLorebook: Boolean(def.embedded_lorebook),
            };
        },
    },

    janny: {
        name: 'JannyAI',
        short: 'Janny',
        icon: 'fa-solid fa-robot',
        site: 'https://jannyai.com',
        sorts: { newest: 'Newest', oldest: 'Oldest', tokens_desc: 'Most tokens', tokens_asc: 'Fewest tokens', relevant: 'Relevance' },
        defaultSort: 'newest',
        nsfw: 'toggle',
        pageSize: 80,
        filters: ['tokens'],
        suggestedTags: Object.values(JANNY_TAGS),
        async search(p) {
            const sortMap = { newest: ['createdAtStamp:desc'], oldest: ['createdAtStamp:asc'], tokens_desc: ['totalToken:desc'], tokens_asc: ['totalToken:asc'], relevant: [] };
            const sort = sortMap[p.sort] ?? sortMap.newest;
            const filter = [`totalToken >= ${Math.max(29, p.filters.minTokens || 0)}`, `totalToken <= ${p.filters.maxTokens || 100000}`, 'isLowQuality = false'];
            if (!p.nsfw) filter.push('isNsfw = false');
            const known = p.include.map(t => JANNY_TAG_IDS[t.toLowerCase()]).filter(Boolean);
            if (known.length) filter.push(known.map(id => `tagIds = ${id}`).join(' AND '));
            const query = {
                indexUid: 'janny-characters',
                q: p.query,
                facets: ['isNsfw', 'tagIds'],
                filter,
                hitsPerPage: 80,
                page: p.page,
                ...(sort.length ? { sort } : {}),
            };
            let result = null;
            // 1) From the browser, like jannyai.com itself (JannyAI often blocks servers).
            try {
                const { token } = await api('/janny/token');
                const res = await fetch('https://search.jannyai.com/multi-search', {
                    method: 'POST',
                    headers: {
                        Accept: '*/*',
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${token}`,
                        'x-meilisearch-client': 'Meilisearch instant-meilisearch (v0.19.0) ; Meilisearch JavaScript (v0.41.0)',
                    },
                    body: JSON.stringify({ queries: [query] }),
                    credentials: 'omit',
                    referrerPolicy: 'no-referrer',
                });
                if (res.ok) result = (await res.json())?.results?.[0] ?? null;
                else if (res.status === 401 || res.status === 403) await api('/janny/token?force=1').catch(() => null);
            } catch { /* fall back to the server */ }
            // 2) From this app's server.
            if (!result) {
                const raw = await api('/janny/search', { method: 'POST', body: { query } });
                result = raw?.results?.[0] ?? null;
            }
            const hits = Array.isArray(result?.hits) ? result.hits : [];
            const custom = p.include.filter(t => !JANNY_TAG_IDS[t.toLowerCase()]).map(t => t.toLowerCase());
            let cards = hits.map(h => {
                const tags = (h.tagIds || []).map(id => JANNY_TAGS[id] || `Tag ${id}`);
                return {
                    id: h.id,
                    name: h.name || 'Unnamed',
                    creator: h.creatorUsername || '',
                    tagline: plain(h.description).slice(0, 220),
                    tags,
                    avatar: h.avatar ? `${API}/janny/avatar/${encodePath(h.avatar)}` : '',
                    stats: [['fa-hashtag', 'Tokens', h.totalToken]],
                    nsfw: Boolean(h.isNsfw),
                    url: `https://jannyai.com/characters/${h.id}_character-${slugify(h.name)}`,
                    raw: h,
                };
            });
            if (custom.length) cards = cards.filter(c => custom.every(t => c.tags.some(x => x.toLowerCase() === t)));
            cards = withoutExcluded(cards, p.exclude);
            const totalPages = Number(result?.totalPages) || 1;
            return { total: Number(result?.totalHits) || null, hasMore: p.page < totalPages, cards };
        },
        async detail(card) {
            // The full card has every field; JannyAI's page is the second choice; the search text the last.
            try {
                const blob = await cardBlob(card);
                const json = await readCardFromPng(blob);
                if (json) return detailFromCard(json);
            } catch { /* try the page */ }
            try {
                const { character: c } = await api(`/janny/character/${encodeURIComponent(card.id)}?slug=character-${slugify(card.name)}`);
                return {
                    description: text(c.personality) || text(c.description),
                    personality: text(c.tavern_personality),
                    scenario: text(c.scenario),
                    firstMessage: text(c.firstMessage) || text(c.first_message),
                    alternateGreetings: list(c.alternateGreetings ?? c.alternate_greetings),
                    exampleDialogs: text(c.exampleDialogs) || text(c.example_dialogs),
                    creatorNotes: plain(c.description_html || c.creatorNotes),
                };
            } catch {
                return { creatorNotes: plain(card.raw?.description), partial: true };
            }
        },
    },

    wyvern: {
        name: 'Wyvern',
        short: 'Wyvern',
        icon: 'fa-solid fa-dragon',
        site: 'https://app.wyvern.chat',
        sorts: { popular: 'Popular', 'nsfw-popular': 'Popular NSFW', recommended: 'Recommended', created_at: 'New', votes: 'Most likes', messages: 'Most messages' },
        defaultSort: 'popular',
        nsfw: 'toggle',
        pageSize: 48,
        async search(p) {
            const params = new URLSearchParams({ page: String(p.page), sort: p.sort });
            if (p.query) params.set('q', p.query);
            if (p.include.length) params.set('tags', p.include.join(','));
            if (!p.nsfw && p.sort !== 'nsfw-popular') params.set('rating', 'none');
            const data = await api(`/wyvern/search?${params}`);
            const results = Array.isArray(data?.results) ? data.results : [];
            const cards = results.map(c => {
                const s = c.statistics_record || c.entity_statistics || {};
                const src = c.avatar_url || c.avatar;
                return {
                    id: c.id,
                    name: c.name || 'Unnamed',
                    creator: c.creator?.displayName || c.creator?.username || '',
                    tagline: plain(c.tagline),
                    tags: list(c.tags),
                    avatar: src ? `${API}/wyvern/avatar?src=${encodeURIComponent(src)}` : '',
                    stats: [['fa-heart', 'Likes', s.likes ?? s.total_likes ?? c.likes], ['fa-comment', 'Messages', s.messages ?? s.total_messages ?? c.messages], ['fa-eye', 'Views', s.views ?? s.total_views ?? c.views]],
                    nsfw: Boolean(c.rating && c.rating !== 'none'),
                    url: `https://app.wyvern.chat/characters/${c.id}`,
                    raw: c,
                };
            });
            return { total: Number(data?.total) || null, hasMore: Boolean(data?.hasMore) || results.length >= 48, cards: withoutExcluded(cards, p.exclude) };
        },
        async detail(card) {
            const c = await api(`/wyvern/character/${encodeURIComponent(card.id)}`);
            const book = c?.character_book ?? c?.embedded_lorebook;
            return {
                description: text(c?.description),
                personality: text(c?.personality),
                scenario: text(c?.scenario),
                firstMessage: text(c?.first_mes),
                alternateGreetings: list(c?.alternate_greetings),
                exampleDialogs: text(c?.mes_example),
                creatorNotes: plain(c?.creator_notes),
                systemPrompt: text(c?.system_prompt),
                postHistory: text(c?.post_history_instructions),
                hasLorebook: Array.isArray(book?.entries) ? book.entries.length > 0 : Boolean(c?.lorebooks?.length),
            };
        },
    },

    datacat: {
        name: 'DataCat',
        short: 'DataCat',
        icon: 'fa-solid fa-cat',
        site: 'https://datacat.run',
        sorts: { relevance: 'Relevance', fresh: 'Fresh (last 24h)' },
        defaultSort: 'relevance',
        nsfw: 'always',
        pageSize: 80,
        async search(p) {
            await loadDatacatTags().catch(() => null);
            const tagIds = p.include.map(t => datacatTags.byName.get(t.toLowerCase())).filter(id => typeof id === 'number');
            const useFresh = p.sort === 'fresh' && !tagIds.length && !p.query.trim();
            let rows = [];
            let total = null;
            let hasMore = false;
            if (useFresh) {
                const data = await api('/datacat/fresh');
                const last = data?.windows?.last24h ?? data?.last24h;
                rows = Array.isArray(last) ? last : Array.isArray(last?.characters) ? last.characters : [];
                total = rows.length;
            } else {
                const params = new URLSearchParams({ offset: String((p.page - 1) * 80) });
                if (tagIds.length) params.set('tagIds', tagIds.join(','));
                if (p.query.trim()) params.set('q', p.query.trim());
                const data = await api(`/datacat/recent?${params}`);
                rows = Array.isArray(data?.characters) ? data.characters : [];
                total = Number(data?.totalCount) || null;
                hasMore = total ? p.page * 80 < total : rows.length >= 80;
            }
            const cards = rows.map(c => {
                const rawTags = Array.isArray(c.tags) ? c.tags : Array.isArray(c.tagIds) ? c.tagIds : [];
                const tags = rawTags.map(t => (typeof t === 'string' ? t : typeof t === 'number' ? datacatTags.byId.get(t) : t?.name || t?.slug || datacatTags.byId.get(t?.id))).filter(Boolean);
                const id = c.characterId || c.character_id || c.id;
                return {
                    id,
                    name: c.chatName || c.chat_name || c.name || 'Unnamed',
                    creator: c.creatorName || c.creator_name || '',
                    tagline: plain(c.description).slice(0, 220),
                    tags,
                    avatar: c.avatar ? `${API}/datacat/avatar?src=${encodeURIComponent(c.avatar)}` : '',
                    stats: [['fa-comment', 'Chats', c.chatCount ?? c.chat_count], ['fa-hashtag', 'Tokens', c.totalTokens ?? c.total_tokens]],
                    nsfw: true,
                    url: `https://datacat.run/characters/${id}`,
                    raw: c,
                };
            });
            return { total, hasMore, cards: withoutExcluded(cards, p.exclude) };
        },
        async detail(card) {
            // DataCat's download asks for a human check now, so the preview only uses the character page.
            const data = await api(`/datacat/character/${encodeURIComponent(card.id)}`);
            const c = data?.character ?? data ?? {};
            return {
                description: text(c.personality),
                scenario: text(c.scenario),
                firstMessage: text(c.first_message),
                creatorNotes: plain(c.description),
            };
        },
    },

    pygmalion: {
        name: 'Pygmalion',
        short: 'Pygmalion',
        icon: 'fa-solid fa-fire',
        site: 'https://pygmalion.chat',
        sorts: { downloads: 'Downloads', stars: 'Stars', views: 'Views', approved_at: 'Newest', token_count: 'Tokens', display_name: 'Name' },
        defaultSort: 'downloads',
        nsfw: 'never',
        pageSize: 48,
        async search(p) {
            const params = new URLSearchParams({ q: p.query, page: String(Math.max(0, p.page - 1)), orderBy: p.sort, orderDescending: 'true' });
            if (p.include.length) params.set('tagsInclude', p.include.join(','));
            if (p.exclude.length) params.set('tagsExclude', p.exclude.join(','));
            const data = await api(`/pygmalion/search?${params}`);
            const chars = Array.isArray(data?.characters) ? data.characters : [];
            const total = Number.parseInt(data?.totalItems || '0', 10) || null;
            return {
                total,
                hasMore: total ? p.page * 48 < total : chars.length >= 48,
                cards: chars.map(c => ({
                    id: c.id,
                    name: c.displayName || 'Unnamed',
                    creator: c.owner?.username || c.owner?.displayName || '',
                    tagline: plain(c.description),
                    tags: list(c.tags),
                    avatar: c.avatarUrl ? `${API}/pygmalion/avatar?src=${encodeURIComponent(c.avatarUrl)}` : '',
                    stats: [['fa-download', 'Downloads', c.downloads], ['fa-star', 'Stars', c.stars], ['fa-comment', 'Chats', c.chatCount]],
                    nsfw: Boolean(c.isSensitive),
                    url: `https://pygmalion.chat/character/${c.id}`,
                    raw: c,
                })),
            };
        },
        async detail(card) {
            const data = await api(`/pygmalion/character?id=${encodeURIComponent(card.id)}`);
            const c = data?.character ?? {};
            const p = c.personality ?? {};
            return {
                description: text(p.persona),
                firstMessage: text(p.greeting),
                alternateGreetings: list(p.alternateGreetings),
                exampleDialogs: text(p.mesExample),
                creatorNotes: plain(p.characterNotes || c.description),
                systemPrompt: text(p.systemPrompt),
                postHistory: text(p.postHistoryInstructions),
            };
        },
    },
};

// ───────────────────────── State ─────────────────────────

const store = loadStore();
const state = {
    open: false,
    source: SOURCES[store.source] ? store.source : 'chub',
    query: '',
    sort: '',
    page: 1,
    include: /** @type {string[]} */ ([]),
    exclude: /** @type {string[]} */ ([]),
    tagsOpen: store.tagsOpen ?? true,
    tagInput: '',
    filtersOpen: false,
    filters: {
        must: { gallery: false, lore: false, expressions: false, greetings: false },
        asc: false,
        minTokens: 0,
        maxTokens: 0,
    },
    loading: false,
    error: '',
    cards: /** @type {any[]} */ ([]),
    total: /** @type {number|null} */ (null),
    hasMore: false,
    selected: /** @type {any|null} */ (null),
    detail: /** @type {any|null} */ (null),
    detailLoading: false,
    detailError: '',
    importing: false,
    /** Set when the site needs the user to download the card in their own browser. */
    manual: /** @type {{ key: string, message: string }|null} */ (null),
    imported: /** @type {Map<string,string>} */ (new Map()), // card key -> avatar file name
    seenTags: /** @type {Map<string,number>} */ (new Map()),
};
state.sort = store.sorts?.[state.source] ?? SOURCES[state.source].defaultSort;

let searchSeq = 0;
let detailSeq = 0;
let searchTimer = 0;
/** card key -> Promise<Blob> of the PNG card */
const cardCache = new Map();

const keyOf = card => `${state.source}:${card.id}`;
const nsfwOn = () => {
    const mode = SOURCES[state.source].nsfw;
    if (mode === 'always') return true;
    if (mode === 'never') return false;
    return store.nsfw?.[state.source] ?? true;
};

function remember() {
    store.source = state.source;
    store.sorts = { ...(store.sorts ?? {}), [state.source]: state.sort };
    saveStore(store);
}

/** True when the blob is a PNG with a character card inside. */
async function isCardPng(blob) {
    try {
        const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
        return head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 && Boolean(await readCardFromPng(blob));
    } catch {
        return false;
    }
}

/**
 * Fallback for JannyAI from the user's own browser, the way jannyai.com does it, for when JannyAI shows its Cloudflare
 * page to this app's server but not to a normal browser. Only the character id is sent.
 * @returns {Promise<Blob|null>} null when the browser could not get the card either
 */
async function jannyBrowserCard(card) {
    try {
        const res = await fetch('https://api.jannyai.com/api/v1/download', {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ characterId: String(card.id) }),
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            cache: 'no-store',
        });
        if (!res.ok) return null;
        const payload = await res.json().catch(() => null);
        const url = payload?.status === 'ok' && typeof payload.downloadUrl === 'string' ? payload.downloadUrl : '';
        if (!url.startsWith('https://')) return null;
        try {
            const file = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
            if (file.ok) {
                const blob = await file.blob();
                if (await isCardPng(blob)) return blob;
            }
        } catch { /* the card file may not allow reading from this page; let the server fetch it */ }
        const viaServer = await fetch(`${API}/janny/card-file`, {
            method: 'POST',
            headers: headers(true),
            body: JSON.stringify({ url, name: card.name }),
            cache: 'no-cache',
        });
        return viaServer.ok ? await viaServer.blob() : null;
    } catch {
        return null;
    }
}

/** Downloads the PNG card once and reuses it for the detail view and the import. */
function cardBlob(card) {
    const key = `${state.source}:${card.id}`;
    if (!cardCache.has(key)) {
        const source = state.source;
        const params = new URLSearchParams({ source, id: String(card.id), name: card.name });
        if (source === 'datacat' && card.raw?.avatar) params.set('avatar', card.raw.avatar);
        const fromServer = () => fetch(`${API}/card?${params}`, { headers: headers(false), cache: 'no-cache' }).then(async (res) => {
            if (!res.ok) throw await responseError(res, `Could not download the card (${res.status})`);
            return res.blob();
        });
        // JannyAI: this app's server first (like Marinara Engine); the user's browser only if the server is blocked.
        const promise = source === 'janny'
            ? fromServer().catch(async (error) => {
                const blob = await jannyBrowserCard(card);
                if (blob) return blob;
                throw error;
            })
            : fromServer();
        promise.catch(() => cardCache.delete(key));
        cardCache.set(key, promise);
    }
    return cardCache.get(key);
}

// ───────────────────────── Searching ─────────────────────────

async function runSearch() {
    const seq = ++searchSeq;
    const source = SOURCES[state.source];
    state.loading = true;
    state.error = '';
    renderResults();
    try {
        const result = await source.search({
            query: state.query,
            sort: state.sort,
            page: state.page,
            nsfw: nsfwOn(),
            include: state.include,
            exclude: state.exclude,
            filters: state.filters,
        });
        if (seq !== searchSeq) return;
        state.cards = result.cards.filter(c => c.id);
        state.total = result.total;
        state.hasMore = result.hasMore;
        for (const card of state.cards) {
            for (const tag of card.tags) state.seenTags.set(tag, (state.seenTags.get(tag) ?? 0) + 1);
        }
    } catch (error) {
        if (seq !== searchSeq) return;
        console.warn('[Card Browser] Search failed', error);
        state.cards = [];
        state.total = null;
        state.hasMore = false;
        state.error = String(error?.message ?? error);
    } finally {
        if (seq === searchSeq) {
            state.loading = false;
            renderResults();
            renderTags();
            root?.querySelector('.ct-cb-results')?.scrollTo({ top: 0 });
        }
    }
}

function searchSoon(delay = 450) {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
        state.page = 1;
        void runSearch();
    }, delay);
}

async function selectCard(card) {
    state.selected = card;
    state.detail = null;
    state.detailError = '';
    state.detailLoading = true;
    renderResults();
    renderDetail();
    const seq = ++detailSeq;
    try {
        const detail = await SOURCES[state.source].detail(card);
        if (seq !== detailSeq) return;
        state.detail = detail ?? {};
    } catch (error) {
        if (seq !== detailSeq) return;
        state.detailError = String(error?.message ?? error);
    } finally {
        if (seq === detailSeq) {
            state.detailLoading = false;
            renderDetail();
        }
    }
}

/**
 * Sends a card file to the normal character import and remembers it for "Chat now".
 * @param {any} card the card picked in the browser
 * @param {Blob} file
 * @param {'png'|'json'|'charx'} type
 */
async function importCardFile(card, file, type) {
    const base = String(card.name).replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'character';
    const form = new FormData();
    form.append('avatar', new File([file], `${base}.${type}`, { type: type === 'png' ? 'image/png' : type === 'json' ? 'application/json' : 'application/octet-stream' }));
    form.append('file_type', type);
    form.append('user_name', ctx()?.name1 ?? 'User');
    const res = await fetch('/api/characters/import', { method: 'POST', body: form, headers: headers(false), cache: 'no-cache' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.error || !data?.file_name) throw new Error(data?.error || 'The card could not be imported.');
    const avatar = `${data.file_name}.png`;
    const { getCharacters } = await import('../script.js');
    await getCharacters();
    try {
        const { importTags } = await import('./tags.js');
        const character = ctx()?.characters?.find(c => c.avatar === avatar);
        if (character) await importTags(character);
    } catch (error) {
        console.warn('[Card Browser] Tags were not imported', error);
    }
    state.imported.set(keyOf(card), avatar);
    state.manual = null;
    toastr.success(`${card.name} was added to your characters.`, 'Imported');
}

async function importSelected() {
    const card = state.selected;
    if (!card || state.importing) return;
    state.importing = true;
    renderDetail();
    try {
        await importCardFile(card, await cardBlob(card), 'png');
    } catch (error) {
        console.error('[Card Browser] Import failed', error);
        if (needsManualDownload(error)) {
            // The site wants a person in a real browser: show how to download it there and import the file.
            state.manual = { key: keyOf(card), message: String(error.message) };
            toastr.warning(String(error.message), 'Download it on the site');
        } else {
            toastr.error(String(error?.message ?? error), 'Could not import');
        }
    } finally {
        state.importing = false;
        renderDetail();
    }
}

/** Lets the user pick a card file they downloaded from the site themselves, and imports it. */
function importDownloadedFile() {
    const card = state.selected;
    if (!card || state.importing) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.png,.json,.charx,image/png,application/json';
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file || state.selected !== card) return;
        const ext = file.name.split('.').pop()?.toLowerCase();
        const type = ext === 'json' ? 'json' : ext === 'charx' ? 'charx' : 'png';
        if (type === 'png' && !(await isCardPng(file))) {
            toastr.error('This PNG has no character card inside. Download the card file (PNG) from the site again.', 'Could not import');
            return;
        }
        state.importing = true;
        renderDetail();
        try {
            await importCardFile(card, file, type);
        } catch (error) {
            console.error('[Card Browser] Import failed', error);
            toastr.error(String(error?.message ?? error), 'Could not import');
        } finally {
            state.importing = false;
            renderDetail();
        }
    }, { once: true });
    input.click();
}

async function chatWithImported() {
    const avatar = state.selected && state.imported.get(keyOf(state.selected));
    if (!avatar) return;
    const index = ctx()?.characters?.findIndex(c => c.avatar === avatar) ?? -1;
    if (index < 0) return toastr.warning('The character is not in the list yet. Try again in a moment.');
    close();
    const { selectCharacterById } = await import('../script.js');
    await selectCharacterById(index);
    globalThis.SillyBunnyClassicHome?.showChat?.();
}

// ───────────────────────── Rendering ─────────────────────────

/** @type {HTMLElement|null} */ let root = null;

function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = String(content);
    return node;
}

function iconButton(icon, label, className = '') {
    const button = el('button', `ct-cb-btn ${className}`.trim());
    button.type = 'button';
    button.innerHTML = `<i class="${icon}" aria-hidden="true"></i>`;
    if (label) button.append(el('span', '', label));
    return button;
}

function initials(name) {
    return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
}

function avatarImg(src, name, className) {
    const wrap = el('div', className);
    const fallback = el('span', 'ct-cb-initials', initials(name));
    wrap.append(fallback);
    if (src) {
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.addEventListener('load', () => wrap.classList.add('has-image'));
        img.addEventListener('error', () => img.remove());
        img.src = src;
        wrap.append(img);
    }
    return wrap;
}

function build() {
    root = el('div', 'ct-cb');
    root.id = 'ct-card-browser';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Card Browser');
    root.innerHTML = `
        <header class="ct-cb-header">
            <button type="button" class="ct-cb-btn ct-cb-back" title="Back"><i class="fa-solid fa-arrow-left"></i></button>
            <div class="ct-cb-titles">
                <div class="ct-cb-kicker">Card library</div>
                <div class="ct-cb-title"><span>Browse character cards online</span></div>
                <div class="ct-cb-sub"></div>
            </div>
            <div class="ct-cb-source">
                <button type="button" class="ct-cb-btn ct-cb-source-btn" aria-haspopup="listbox"></button>
                <div class="ct-cb-source-menu" role="listbox"></div>
            </div>
        </header>
        <div class="ct-cb-toolbar">
            <label class="ct-cb-search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" placeholder="Search characters..." autocomplete="off"></label>
            <select class="ct-cb-sort text_pole" title="Sort"></select>
            <button type="button" class="ct-cb-btn ct-cb-tags-btn" aria-expanded="false"><i class="fa-solid fa-tags"></i><span>Tags</span><b class="ct-cb-badge"></b></button>
            <button type="button" class="ct-cb-btn ct-cb-filters-btn" aria-expanded="false"><i class="fa-solid fa-sliders"></i><span>Filters</span><b class="ct-cb-badge"></b></button>
            <label class="ct-cb-nsfw"><input type="checkbox"><span>Show NSFW</span></label>
            <button type="button" class="ct-cb-btn ct-cb-refresh" title="Search again"><i class="fa-solid fa-rotate"></i></button>
        </div>
        <div class="ct-cb-filters"></div>
        <div class="ct-cb-main">
            <aside class="ct-cb-tagbar" aria-label="Tags">
                <div class="ct-cb-tagbar-head">
                    <i class="fa-solid fa-tags" aria-hidden="true"></i><b>Tags</b>
                    <button type="button" class="ct-cb-btn ct-cb-mini-btn ct-cb-tags-clear" title="Clear all tags">Clear</button>
                    <button type="button" class="ct-cb-btn ct-cb-mini-btn ct-cb-tagbar-close" title="Hide the tag list" aria-label="Hide the tag list"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <label class="ct-cb-tagsearch"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input class="ct-cb-tag-input" type="search" placeholder="Search tags" autocomplete="off" aria-label="Search tags"></label>
                <div class="ct-cb-active-tags"></div>
                <div class="ct-cb-taglist" role="list"></div>
                <div class="ct-cb-tagbar-hint">Tick = require &middot; <span class="is-exclude">&minus;</span> = hide</div>
            </aside>
            <div class="ct-cb-results">
                <div class="ct-cb-grid"></div>
                <div class="ct-cb-state"></div>
                <div class="ct-cb-pager">
                    <button type="button" class="ct-cb-btn ct-cb-prev"><i class="fa-solid fa-chevron-left"></i><span>Previous</span></button>
                    <span class="ct-cb-page"></span>
                    <button type="button" class="ct-cb-btn ct-cb-next"><span>Next</span><i class="fa-solid fa-chevron-right"></i></button>
                </div>
            </div>
            <aside class="ct-cb-detail" aria-live="polite"></aside>
        </div>`;
    root.querySelector('.ct-cb-title').append(helpButton('Card Browser', HELP_HTML));
    root.querySelector('.ct-cb-nsfw').append(helpButton('Show NSFW', NSFW_HELP));

    root.querySelector('.ct-cb-back').addEventListener('click', () => close());
    const sourceBtn = root.querySelector('.ct-cb-source-btn');
    const sourceMenu = root.querySelector('.ct-cb-source-menu');
    sourceBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        sourceMenu.classList.toggle('is-open');
    });
    sourceMenu.addEventListener('click', (event) => {
        const item = /** @type {HTMLElement} */ (event.target).closest('[data-source]');
        if (!item) return;
        sourceMenu.classList.remove('is-open');
        switchSource(item.dataset.source);
    });
    document.addEventListener('pointerdown', (event) => {
        if (!sourceMenu.contains(/** @type {Node} */ (event.target)) && event.target !== sourceBtn && !sourceBtn.contains(/** @type {Node} */ (event.target))) sourceMenu.classList.remove('is-open');
    });

    const search = /** @type {HTMLInputElement} */ (root.querySelector('.ct-cb-search input'));
    search.addEventListener('input', () => {
        state.query = search.value;
        searchSoon();
    });
    search.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') searchSoon(0);
    });
    const sort = /** @type {HTMLSelectElement} */ (root.querySelector('.ct-cb-sort'));
    sort.addEventListener('change', () => {
        state.sort = sort.value;
        remember();
        searchSoon(0);
    });
    root.querySelector('.ct-cb-tags-btn').addEventListener('click', () => setTagsOpen(!state.tagsOpen));
    root.querySelector('.ct-cb-tagbar-close').addEventListener('click', () => setTagsOpen(false));
    root.querySelector('.ct-cb-filters-btn').addEventListener('click', () => {
        state.filtersOpen = !state.filtersOpen;
        renderFilters();
    });
    const filters = root.querySelector('.ct-cb-filters');
    filters.addEventListener('change', onFilterChange);
    filters.addEventListener('click', (event) => {
        const target = /** @type {HTMLElement} */ (event.target);
        if (!target.closest('.ct-cb-filters-reset')) return;
        state.filters = { must: { gallery: false, lore: false, expressions: false, greetings: false }, asc: false, minTokens: 0, maxTokens: 0 };
        renderFilters();
        searchSoon(0);
    });
    const nsfw = /** @type {HTMLInputElement} */ (root.querySelector('.ct-cb-nsfw input'));
    nsfw.addEventListener('change', () => {
        store.nsfw = { ...(store.nsfw ?? {}), [state.source]: nsfw.checked };
        saveStore(store);
        searchSoon(0);
    });
    root.querySelector('.ct-cb-refresh').addEventListener('click', () => void runSearch());
    root.querySelector('.ct-cb-prev').addEventListener('click', () => {
        if (state.page <= 1 || state.loading) return;
        state.page -= 1;
        void runSearch();
    });
    root.querySelector('.ct-cb-next').addEventListener('click', () => {
        if (!state.hasMore || state.loading) return;
        state.page += 1;
        void runSearch();
    });
    root.querySelector('.ct-cb-grid').addEventListener('click', (event) => {
        const tile = /** @type {HTMLElement} */ (event.target).closest('[data-index]');
        if (tile) void selectCard(state.cards[Number(tile.dataset.index)]);
    });
    root.querySelector('.ct-cb-grid').addEventListener('keydown', (event) => {
        const tile = /** @type {HTMLElement} */ (event.target).closest('[data-index]');
        if (tile && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            void selectCard(state.cards[Number(tile.dataset.index)]);
        }
    });
    const tagbar = root.querySelector('.ct-cb-tagbar');
    tagbar.addEventListener('click', onTagPanelClick);
    const tagInput = /** @type {HTMLInputElement} */ (tagbar.querySelector('.ct-cb-tag-input'));
    tagInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || !tagInput.value.trim()) return;
        event.preventDefault();
        setTag(tagInput.value, event.shiftKey ? 'exclude' : 'include', { clearInput: true });
    });
    tagInput.addEventListener('input', () => {
        state.tagInput = tagInput.value;
        renderTagList(true);
    });
    document.body.append(root);
}

function switchSource(id) {
    if (!SOURCES[id] || id === state.source) return;
    state.source = id;
    state.sort = store.sorts?.[id] ?? SOURCES[id].defaultSort;
    state.query = '';
    state.page = 1;
    state.include = [];
    state.exclude = [];
    state.selected = null;
    state.detail = null;
    state.seenTags = new Map();
    remember();
    renderAll();
    void runSearch();
}

function renderHeader() {
    const source = SOURCES[state.source];
    const sourceBtn = root.querySelector('.ct-cb-source-btn');
    sourceBtn.innerHTML = `<i class="${source.icon}"></i><span></span><i class="fa-solid fa-chevron-down ct-cb-caret"></i>`;
    sourceBtn.querySelector('span').textContent = source.name;
    const menu = root.querySelector('.ct-cb-source-menu');
    menu.replaceChildren(...Object.entries(SOURCES).map(([id, s]) => {
        const item = el('button', `ct-cb-source-item${id === state.source ? ' is-active' : ''}`);
        item.type = 'button';
        item.dataset.source = id;
        item.setAttribute('role', 'option');
        item.innerHTML = `<i class="${s.icon}"></i><span></span>${id === state.source ? '<i class="fa-solid fa-check"></i>' : ''}`;
        item.querySelector('span').textContent = s.name;
        return item;
    }));
    const sort = /** @type {HTMLSelectElement} */ (root.querySelector('.ct-cb-sort'));
    sort.replaceChildren(...Object.entries(source.sorts).map(([value, label]) => {
        const option = new Option(label, value);
        option.selected = value === state.sort;
        return option;
    }));
    const search = /** @type {HTMLInputElement} */ (root.querySelector('.ct-cb-search input'));
    if (search.value !== state.query) search.value = state.query;
    search.placeholder = `Search ${source.name}...`;
    const nsfw = /** @type {HTMLInputElement} */ (root.querySelector('.ct-cb-nsfw input'));
    nsfw.checked = nsfwOn();
    nsfw.disabled = source.nsfw !== 'toggle';
    root.querySelector('.ct-cb-nsfw').classList.toggle('is-locked', source.nsfw !== 'toggle');
}

function renderSubtitle() {
    const source = SOURCES[state.source];
    const sub = root.querySelector('.ct-cb-sub');
    if (state.loading) sub.textContent = `Searching ${source.name}...`;
    else if (state.error) sub.textContent = `${source.name} is not answering right now`;
    else if (state.total) sub.textContent = `${state.total.toLocaleString()} cards from ${source.name}`;
    else sub.textContent = `${state.cards.length} cards from ${source.name}`;
}

function renderResults() {
    if (!root) return;
    renderSubtitle();
    const grid = root.querySelector('.ct-cb-grid');
    const status = root.querySelector('.ct-cb-state');
    root.querySelector('.ct-cb-results').classList.toggle('is-loading', state.loading);
    if (state.error) {
        grid.replaceChildren();
        status.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i><b>Could not load cards</b><p></p><button type="button" class="ct-cb-btn ct-cb-retry"><i class="fa-solid fa-rotate"></i><span>Try again</span></button>';
        status.querySelector('p').textContent = state.error;
        status.querySelector('.ct-cb-retry').addEventListener('click', () => void runSearch());
    } else if (!state.loading && !state.cards.length) {
        grid.replaceChildren();
        status.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i><b>No cards found</b><p>Try other words, fewer tags or another source.</p>';
    } else if (state.loading && !state.cards.length) {
        grid.replaceChildren(...Array.from({ length: 12 }, () => el('div', 'ct-cb-tile is-skeleton')));
        status.replaceChildren();
    } else {
        status.replaceChildren();
        grid.replaceChildren(...state.cards.map((card, index) => {
            const tile = el('div', 'ct-cb-tile');
            tile.dataset.index = String(index);
            tile.tabIndex = 0;
            tile.setAttribute('role', 'button');
            tile.style.setProperty('--i', String(Math.min(index, 24)));
            if (state.selected && state.selected.id === card.id) tile.classList.add('is-selected');
            const art = avatarImg(card.avatar, card.name, 'ct-cb-art');
            if (card.nsfw) art.append(el('span', 'ct-cb-flag', 'NSFW'));
            if (state.imported.has(keyOf(card))) art.append(el('span', 'ct-cb-flag ct-cb-flag-ok', 'Imported'));
            const body = el('div', 'ct-cb-tile-body');
            body.append(el('div', 'ct-cb-name', card.name));
            if (card.creator) body.append(el('div', 'ct-cb-creator', `by ${card.creator}`));
            if (card.tagline) body.append(el('div', 'ct-cb-tagline', card.tagline));
            const stats = el('div', 'ct-cb-stats');
            for (const [icon, label, value] of card.stats) {
                if (!Number(value)) continue;
                const stat = el('span', 'ct-cb-stat');
                stat.title = label;
                stat.innerHTML = `<i class="fa-solid ${icon}"></i>`;
                stat.append(fmt(value));
                stats.append(stat);
            }
            body.append(stats);
            tile.append(art, body);
            return tile;
        }));
    }
    const prev = /** @type {HTMLButtonElement} */ (root.querySelector('.ct-cb-prev'));
    const next = /** @type {HTMLButtonElement} */ (root.querySelector('.ct-cb-next'));
    prev.disabled = state.page <= 1 || state.loading;
    next.disabled = !state.hasMore || state.loading;
    const pages = state.total ? Math.max(1, Math.ceil(state.total / SOURCES[state.source].pageSize)) : null;
    root.querySelector('.ct-cb-page').textContent = pages ? `Page ${state.page} of ${pages.toLocaleString()}` : `Page ${state.page}`;
    root.querySelector('.ct-cb-pager').classList.toggle('is-hidden', !state.cards.length && state.page === 1);
}

function section(title, body, { open = false, count } = {}) {
    if (!body) return null;
    const details = document.createElement('details');
    details.className = 'ct-cb-section';
    details.open = open;
    const summary = el('summary', '', title);
    if (count) summary.append(el('span', 'ct-cb-count', count));
    const content = el('div', 'ct-cb-text', body);
    details.append(summary, content);
    return details;
}

function renderDetail() {
    if (!root) return;
    const aside = root.querySelector('.ct-cb-detail');
    const card = state.selected;
    root.querySelector('.ct-cb-main').classList.toggle('has-detail', Boolean(card));
    if (!card) {
        aside.replaceChildren();
        return;
    }
    const source = SOURCES[state.source];
    const top = el('div', 'ct-cb-detail-top');
    const closeBtn = iconButton('fa-solid fa-xmark', '', 'ct-cb-detail-close');
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', () => {
        state.selected = null;
        renderDetail();
        renderResults();
    });
    top.append(closeBtn);
    const portrait = avatarImg(card.avatarFull || card.avatar, card.name, 'ct-cb-portrait');
    const head = el('div', 'ct-cb-detail-head');
    head.append(el('div', 'ct-cb-detail-name', card.name));
    if (card.creator) head.append(el('div', 'ct-cb-detail-creator', `by ${card.creator}`));
    const meta = el('div', 'ct-cb-stats');
    for (const [icon, label, value] of card.stats) {
        if (!Number(value)) continue;
        const stat = el('span', 'ct-cb-stat');
        stat.title = label;
        stat.innerHTML = `<i class="fa-solid ${icon}"></i>`;
        stat.append(`${fmt(value)} ${label.toLowerCase()}`);
        meta.append(stat);
    }
    if (card.nsfw) meta.append(el('span', 'ct-cb-flag-inline', 'NSFW'));
    if (state.detail?.hasLorebook) meta.append(el('span', 'ct-cb-flag-inline is-lore', 'Lorebook'));
    head.append(meta);
    if (card.tags.length) {
        const tags = el('div', 'ct-cb-chips');
        for (const tag of card.tags.slice(0, 24)) tags.append(el('span', 'ct-cb-chip', tag));
        head.append(tags);
    }

    const actions = el('div', 'ct-cb-actions');
    const importedAvatar = state.imported.get(keyOf(card));
    if (importedAvatar) {
        const chat = iconButton('fa-solid fa-comment', 'Chat now', 'is-primary');
        chat.addEventListener('click', () => void chatWithImported());
        const again = iconButton('fa-solid fa-check', 'Imported', 'is-done');
        again.disabled = true;
        actions.append(chat, again);
    } else {
        const importBtn = iconButton(state.importing ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-download', state.importing ? 'Importing...' : 'Import', 'is-primary');
        importBtn.disabled = state.importing;
        importBtn.addEventListener('click', () => void importSelected());
        actions.append(importBtn);
    }
    const site = document.createElement('a');
    site.className = 'ct-cb-btn';
    site.href = card.url;
    site.target = '_blank';
    site.rel = 'noopener noreferrer';
    site.innerHTML = '<i class="fa-solid fa-arrow-up-right-from-square"></i>';
    site.append(el('span', '', `View on ${source.short}`));
    actions.append(site);

    let manualNote = null;
    if (!importedAvatar && state.manual?.key === keyOf(card)) {
        manualNote = el('div', 'ct-cb-manual');
        manualNote.append(el('div', 'ct-cb-manual-text', state.manual.message));
        const steps = el('div', 'ct-cb-manual-actions');
        const open = document.createElement('a');
        open.className = 'ct-cb-btn';
        open.href = card.url;
        open.target = '_blank';
        open.rel = 'noopener noreferrer';
        open.innerHTML = '<i class="fa-solid fa-arrow-up-right-from-square"></i>';
        open.append(el('span', '', `1. Open on ${source.short}`));
        const pick = iconButton('fa-solid fa-file-import', '2. Import a downloaded file', 'is-primary');
        pick.disabled = state.importing;
        pick.addEventListener('click', () => importDownloadedFile());
        steps.append(open, pick);
        manualNote.append(steps);
    }

    const sections = el('div', 'ct-cb-sections');
    if (state.detailLoading) {
        sections.append(el('div', 'ct-cb-loading-line'), el('div', 'ct-cb-loading-line'), el('div', 'ct-cb-loading-line short'));
    } else if (state.detailError) {
        const msg = el('div', 'ct-cb-detail-error', `Could not load the full card: ${state.detailError}`);
        sections.append(msg);
        if (card.tagline) sections.append(section('Summary', card.tagline, { open: true }));
    } else {
        const d = state.detail ?? {};
        const greetings = d.alternateGreetings ?? [];
        const parts = [
            section('Description', d.description, { open: true }),
            section('First message', d.firstMessage, { open: !d.description }),
            section('Scenario', d.scenario),
            section('Personality', d.personality),
            greetings.length ? section('Alternate greetings', greetings.map((g, i) => `── Greeting ${i + 2} ──\n${g}`).join('\n\n'), { count: String(greetings.length) }) : null,
            section('Example dialogue', d.exampleDialogs),
            section('Creator notes', d.creatorNotes || (!d.description ? card.tagline : ''), { open: !d.description && !d.firstMessage }),
            section('System prompt', d.systemPrompt),
            section('Post-history instructions', d.postHistory),
        ].filter(Boolean);
        if (d.partial) sections.append(el('div', 'ct-cb-detail-note', 'Only the short summary is available here. Import the card to get every field.'));
        sections.append(...parts);
        if (!parts.length) sections.append(el('div', 'ct-cb-detail-note', 'This card has no text to preview.'));
    }
    aside.replaceChildren(...[top, portrait, head, actions, manualNote, sections].filter(Boolean));
}

/** Sets a tag to 'include', 'exclude' or '' (not used). Clicking the same state again clears it. */
function setTag(value, mode, { toggle = false, clearInput = false } = {}) {
    const tag = String(value ?? '').trim();
    if (!tag) return;
    const lower = tag.toLowerCase();
    const current = state.include.some(t => t.toLowerCase() === lower) ? 'include' : state.exclude.some(t => t.toLowerCase() === lower) ? 'exclude' : '';
    const next = toggle && current === mode ? '' : mode;
    state.include = state.include.filter(t => t.toLowerCase() !== lower);
    state.exclude = state.exclude.filter(t => t.toLowerCase() !== lower);
    if (next === 'include') state.include.push(tag);
    if (next === 'exclude') state.exclude.push(tag);
    if (clearInput) state.tagInput = '';
    renderTags();
    searchSoon(0);
}

function onTagPanelClick(event) {
    const target = /** @type {HTMLElement} */ (event.target);
    const row = target.closest('[data-tag]');
    if (row) {
        const mode = target.closest('[data-mode]')?.getAttribute('data-mode');
        if (mode) setTag(row.getAttribute('data-tag'), mode, row.classList.contains('is-typed') ? { clearInput: true } : { toggle: true });
        return;
    }
    const remove = target.closest('[data-remove]');
    if (remove) return setTag(remove.getAttribute('data-remove'), '');
    if (target.closest('.ct-cb-tags-clear')) {
        state.include = [];
        state.exclude = [];
        renderTags();
        searchSoon(0);
    }
}

function setTagsOpen(open) {
    state.tagsOpen = open;
    store.tagsOpen = open;
    saveStore(store);
    renderTags();
}

/** Every tag worth listing for the current source, A-Z, without duplicates (case-insensitive). */
function tagNames() {
    const source = SOURCES[state.source];
    const pool = [...state.include, ...state.exclude, ...(source.suggestedTags ?? []), ...[...state.seenTags.keys()]];
    if (state.source === 'datacat') pool.push(...datacatTags.top);
    const typed = state.tagInput.trim().toLowerCase();
    if (typed && state.source === 'datacat') pool.push(...datacatTags.byId.values());
    const seen = new Map();
    for (const name of pool) {
        const clean = String(name ?? '').trim();
        if (clean && !seen.has(clean.toLowerCase())) seen.set(clean.toLowerCase(), clean);
    }
    let names = [...seen.values()];
    if (typed) names = names.filter(n => n.toLowerCase().includes(typed));
    return names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })).slice(0, 400);
}

function tagMode(name) {
    const lower = name.toLowerCase();
    if (state.include.some(t => t.toLowerCase() === lower)) return 'include';
    if (state.exclude.some(t => t.toLowerCase() === lower)) return 'exclude';
    return '';
}

function renderTagList(keepScroll = true) {
    const list = root?.querySelector('.ct-cb-taglist');
    if (!list) return;
    const scroll = list.scrollTop;
    const names = tagNames();
    const rows = names.map((name) => {
        const mode = tagMode(name);
        const row = el('div', `ct-cb-tagrow${mode ? ` is-${mode}` : ''}`);
        row.dataset.tag = name;
        row.setAttribute('role', 'listitem');
        const check = el('button', 'ct-cb-tagcheck');
        check.type = 'button';
        check.dataset.mode = 'include';
        check.setAttribute('aria-pressed', String(mode === 'include'));
        check.title = mode === 'include' ? `Stop requiring "${name}"` : `Only show cards tagged "${name}"`;
        check.innerHTML = '<span class="ct-cb-box" aria-hidden="true"><i class="fa-solid fa-check"></i></span>';
        check.append(el('span', 'ct-cb-tagname', name));
        const minus = el('button', 'ct-cb-tagminus');
        minus.type = 'button';
        minus.dataset.mode = 'exclude';
        minus.setAttribute('aria-pressed', String(mode === 'exclude'));
        minus.title = mode === 'exclude' ? `Stop hiding "${name}"` : `Hide cards tagged "${name}"`;
        minus.setAttribute('aria-label', minus.title);
        minus.innerHTML = '<i class="fa-solid fa-minus" aria-hidden="true"></i>';
        row.append(check, minus);
        return row;
    });
    const typed = state.tagInput.trim();
    if (typed && !names.some(n => n.toLowerCase() === typed.toLowerCase())) {
        const row = el('div', 'ct-cb-tagrow is-typed');
        row.dataset.tag = typed;
        const add = el('button', 'ct-cb-tagcheck');
        add.type = 'button';
        add.dataset.mode = 'include';
        add.innerHTML = '<span class="ct-cb-box" aria-hidden="true"><i class="fa-solid fa-plus"></i></span>';
        add.append(el('span', 'ct-cb-tagname', `Require "${typed}"`));
        const minus = el('button', 'ct-cb-tagminus');
        minus.type = 'button';
        minus.dataset.mode = 'exclude';
        minus.title = `Hide cards tagged "${typed}"`;
        minus.setAttribute('aria-label', minus.title);
        minus.innerHTML = '<i class="fa-solid fa-minus" aria-hidden="true"></i>';
        row.append(add, minus);
        rows.unshift(row);
    }
    list.replaceChildren(...rows);
    if (!rows.length) list.append(el('div', 'ct-cb-muted ct-cb-tag-empty', 'Tags appear here after a search.'));
    list.scrollTop = keepScroll ? scroll : 0;
}

function renderTags() {
    if (!root) return;
    const count = state.include.length + state.exclude.length;
    const button = root.querySelector('.ct-cb-tags-btn');
    button.querySelector('.ct-cb-badge').textContent = count ? String(count) : '';
    button.classList.toggle('is-active', state.tagsOpen || count > 0);
    button.setAttribute('aria-expanded', String(state.tagsOpen));
    root.querySelector('.ct-cb-main').classList.toggle('has-tags', state.tagsOpen);
    /** @type {HTMLButtonElement} */ (root.querySelector('.ct-cb-tags-clear')).disabled = !count;
    const input = /** @type {HTMLInputElement} */ (root.querySelector('.ct-cb-tag-input'));
    if (input.value !== state.tagInput) input.value = state.tagInput;
    const active = root.querySelector('.ct-cb-active-tags');
    active.replaceChildren();
    for (const [tags, kind] of [[state.include, 'include'], [state.exclude, 'exclude']]) {
        for (const tag of tags) {
            const chip = el('button', `ct-cb-chip is-${kind}`);
            chip.type = 'button';
            chip.dataset.remove = tag;
            chip.title = `Remove "${tag}"`;
            chip.innerHTML = `<i class="fa-solid fa-${kind === 'include' ? 'check' : 'ban'}"></i>`;
            chip.append(el('span', '', tag), Object.assign(document.createElement('i'), { className: 'fa-solid fa-xmark' }));
            active.append(chip);
        }
    }
    if (state.tagsOpen) renderTagList(true);
}

function activeFilterCount() {
    const f = state.filters;
    const supported = SOURCES[state.source].filters ?? [];
    let count = 0;
    if (supported.includes('must')) count += Object.values(f.must).filter(Boolean).length;
    if (supported.includes('direction') && f.asc) count += 1;
    if (supported.includes('tokens')) count += Number(Boolean(f.minTokens)) + Number(Boolean(f.maxTokens));
    return count;
}

function renderFilters() {
    if (!root) return;
    const supported = SOURCES[state.source].filters ?? [];
    const button = root.querySelector('.ct-cb-filters-btn');
    const panel = root.querySelector('.ct-cb-filters');
    const count = activeFilterCount();
    button.hidden = !supported.length;
    button.querySelector('.ct-cb-badge').textContent = count ? String(count) : '';
    button.classList.toggle('is-active', state.filtersOpen || count > 0);
    button.setAttribute('aria-expanded', String(state.filtersOpen));
    const open = state.filtersOpen && supported.length > 0;
    panel.classList.toggle('is-open', open);
    if (!open) {
        panel.replaceChildren();
        return;
    }
    const f = state.filters;
    const groups = [];
    if (supported.includes('must')) {
        groups.push(`<fieldset class="ct-cb-fgroup"><legend>Character must have</legend>${MUST_HAVE.map(([key, icon, label]) => `
            <label class="ct-cb-fcheck"><input type="checkbox" data-must="${key}"${f.must[key] ? ' checked' : ''}><i class="fa-solid ${icon}" aria-hidden="true"></i><span>${label}</span></label>`).join('')}</fieldset>`);
    }
    const advanced = [];
    if (supported.includes('direction')) {
        advanced.push(`<label class="ct-cb-ffield"><span>Sort direction</span><select class="text_pole" data-filter="asc"><option value="false"${f.asc ? '' : ' selected'}>Descending</option><option value="true"${f.asc ? ' selected' : ''}>Ascending</option></select></label>`);
    }
    if (supported.includes('tokens')) {
        advanced.push(`<label class="ct-cb-ffield"><span>Min tokens</span><input class="text_pole" type="number" min="0" step="50" inputmode="numeric" placeholder="Any" data-filter="minTokens" value="${f.minTokens || ''}"></label>`);
        advanced.push(`<label class="ct-cb-ffield"><span>Max tokens</span><input class="text_pole" type="number" min="0" step="100" inputmode="numeric" placeholder="Any" data-filter="maxTokens" value="${f.maxTokens || ''}"></label>`);
    }
    if (advanced.length) groups.push(`<fieldset class="ct-cb-fgroup"><legend>Advanced options</legend><div class="ct-cb-fgrid">${advanced.join('')}</div></fieldset>`);
    panel.innerHTML = `${groups.join('')}<button type="button" class="ct-cb-btn ct-cb-filters-reset"${count ? '' : ' disabled'}><i class="fa-solid fa-rotate-left"></i><span>Reset</span></button>`;
}

function onFilterChange(event) {
    const input = /** @type {HTMLInputElement} */ (event.target);
    if (input.dataset.must) state.filters.must[input.dataset.must] = input.checked;
    else if (input.dataset.filter === 'asc') state.filters.asc = input.value === 'true';
    else if (input.dataset.filter === 'minTokens' || input.dataset.filter === 'maxTokens') {
        const value = Math.max(0, Math.min(1_000_000, Math.round(Number(input.value) || 0)));
        state.filters[input.dataset.filter] = value;
    } else return;
    renderFilters();
    searchSoon(0);
}

function renderAll() {
    renderHeader();
    renderResults();
    renderTags();
    renderFilters();
    renderDetail();
}

// ───────────────────────── Open / close ─────────────────────────

let returnFocus = null;
const VIEW_ID = 'ct-cards-button';

function setButtonState(open) {
    const button = document.getElementById(VIEW_ID);
    button?.classList.toggle('is-open', open);
    button?.querySelector('.ct-home-toggle')?.setAttribute('aria-pressed', String(open));
    const icon = button?.querySelector('.drawer-icon');
    icon?.classList.toggle('openIcon', open);
    icon?.classList.toggle('closedIcon', !open);
}

function open() {
    if (!root) build();
    if (state.open) return;
    const home = globalThis.SillyBunnyClassicHome;
    home?.closeHome?.(); // before state.open: closing Home switches the view to the chat
    state.open = true;
    returnFocus = document.activeElement;
    document.body.classList.add('ct-cb-open');
    root.classList.add('is-open');
    // It is a page of its own: the top bar / sidebar marks its button, and any other page closes it.
    home?.setView?.(VIEW_ID);
    setButtonState(true);
    renderAll();
    if (!state.cards.length && !state.loading) void runSearch();
    requestAnimationFrame(() => /** @type {HTMLElement|null} */ (root.querySelector('.ct-cb-search input'))?.focus());
}

function close() {
    if (!state.open) return;
    state.open = false;
    closeHelp();
    root?.classList.remove('is-open');
    document.body.classList.remove('ct-cb-open');
    setButtonState(false);
    const home = globalThis.SillyBunnyClassicHome;
    if (home?.getView?.() === VIEW_ID) home.setView('chat');
    if (returnFocus instanceof HTMLElement && document.contains(returnFocus)) returnFocus.focus();
}

function addEntryButton() {
    const bar = document.getElementById('rm_button_bar');
    if (!bar || document.getElementById('ct-card-browser-button')) return;
    const button = el('div', 'menu_button fa-solid fa-earth-americas');
    button.id = 'ct-card-browser-button';
    button.title = 'Browse character cards online (ChubAI, JannyAI, Wyvern, DataCat, Pygmalion)';
    button.tabIndex = 0;
    button.setAttribute('role', 'button');
    button.addEventListener('click', open);
    button.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            open();
        }
    });
    const after = document.getElementById('external_import_button');
    after ? after.after(button) : bar.prepend(button);
}

function init() {
    addEntryButton();
    document.addEventListener('ct:view-changed', (event) => {
        if (state.open && event.detail?.view !== VIEW_ID) close();
    });
    // A drawer icon in the top bar / sidebar always leaves the Card Browser (even one that only closes a panel).
    document.addEventListener('click', (event) => {
        if (state.open && /** @type {HTMLElement} */ (event.target)?.closest?.('#top-settings-holder > .drawer > .drawer-toggle')) close();
    }, true);
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || !state.open) return;
        if (document.querySelector('.ct-help-card, dialog[open]')) return;
        if (root?.querySelector('.ct-cb-source-menu.is-open')) {
            root.querySelector('.ct-cb-source-menu').classList.remove('is-open');
            return;
        }
        if (state.selected) {
            state.selected = null;
            renderDetail();
            renderResults();
            return;
        }
        close();
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}

globalThis.SillyBunnyClassicCardBrowser = { open, close };
