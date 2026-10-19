// Classic UI fork: the Home page (house icon), the Chat button and the page switching of the
// Lantern layout (one page at a time: body[data-ct-view] + .ct-view-active on the shown panel).
//
// Home gathers everything in one place: recent chats, characters, lorebooks, personas, groups and
// shortcuts to every settings drawer. Each item opens the place where it is edited:
//   character -> selects it and opens the character editor (right panel)
//   lorebook  -> opens the World Info editor on that lorebook
//   persona   -> opens Persona Management with that persona highlighted
//   group     -> opens the group and its editor
//   tool      -> opens the matching top-bar drawer
// Nothing here changes data; it only calls the same functions SillyTavern's own buttons use.

/** Rail entries: drawer id, label, order in the Lantern sidebar. Items with order >= 10 sit at the bottom. */
const RAIL_ITEMS = Object.freeze([
    ['ct-home-button', 'Home', 0],
    ['ct-chat-button', 'Chat', 1],
    ['rightNavHolder', 'Characters', 2],
    ['WI-SP-button', 'Lorebooks', 3],
    ['persona-management-button', 'Persona', 4],
    ['agents-settings-button', 'Agents', 5],
    ['ct-memory-button', 'Memory', 6],
    ['extensions-settings-button', 'Extensions', 7],
    ['ct-cards-button', 'Card Browser', 8],
    ['ai-config-button', 'Presets', 10],
    ['sys-settings-button', 'API', 11],
    ['advanced-formatting-button', 'Formatting', 12],
    ['backgrounds-button', 'Backgrounds', 13],
    ['ct-personalize-button', 'Customize', 14],
    ['user-settings-button', 'Settings', 15],
]);

const TOOLS = Object.freeze([
    { drawer: 'ai-config-button', icon: 'fa-sliders', name: 'Presets', desc: 'Model settings, samplers and the prompt.' },
    { drawer: 'sys-settings-button', icon: 'fa-plug', name: 'API', desc: 'Connect to a model provider.' },
    { drawer: 'advanced-formatting-button', icon: 'fa-font', name: 'Formatting', desc: 'Instruct, context and system templates.' },
    { drawer: 'agents-settings-button', icon: 'fa-robot', name: 'Agents', desc: 'In-chat agents that help each reply.' },
    { drawer: 'ct-memory-button', icon: 'fa-brain', name: 'Memory', desc: 'Chapter summaries and recall of old messages.' },
    { open: 'HomunculusClassicCardBrowser', icon: 'fa-earth-americas', name: 'Card Browser', desc: 'Find and import cards from ChubAI, JannyAI and more.' },
    { drawer: 'extensions-settings-button', icon: 'fa-cubes', name: 'Extensions', desc: 'Install and configure extensions.' },
    { drawer: 'backgrounds-button', icon: 'fa-panorama', name: 'Backgrounds', desc: 'Pick the chat background.' },
    { drawer: 'ct-personalize-button', icon: 'fa-palette', name: 'Customize', desc: 'Visual profiles, layout and effects.' },
    { drawer: 'user-settings-button', icon: 'fa-user-gear', name: 'Settings', desc: 'Everything else about the app.' },
]);

const PREVIEW_COUNT = 12;

/* Specimen home (profile field "home": "specimen", e.g. Blood & Ink): body.ct-homestyle-specimen. */
const SPECIMEN_CHARS = 6;
const SPECIMEN_RECENT = 5;
const SPECIMEN_LORE = 5;
const EYE_GEAR = 'M41.35,30.29 L44.41,30.53 L44.41,33.47 L41.35,33.71 L40.56,36.11 L42.91,38.11 L41.18,40.49 L38.56,38.87 L36.51,40.36 L37.23,43.35 L34.44,44.26 L33.26,41.42 L30.74,41.42 L29.56,44.26 L26.77,43.35 L27.49,40.36 L25.44,38.87 L22.82,40.49 L21.09,38.11 L23.44,36.11 L22.65,33.71 L19.59,33.47 L19.59,30.53 L22.65,30.29 L23.44,27.89 L21.09,25.89 L22.82,23.51 L25.44,25.13 L27.49,23.64 L26.77,20.65 L29.56,19.74 L30.74,22.58 L33.26,22.58 L34.44,19.74 L37.23,20.65 L36.51,23.64 L38.56,25.13 L41.18,23.51 L42.91,25.89 L40.56,27.89 Z';
const EYE_LID = 'M7,32 Q32,9 57,32 Q32,55 7,32 Z';
const COUNT_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five'];

const state = {
    open: false,
    query: '',
    showAllChars: false,
    showAllLore: false,
    showAllPeople: false,
    showAllGroups: false,
    recent: [],
    recentMax: 6,
    showAllRecent: false,
    worlds: [],
    activeWorlds: [],
    personas: {},
    personaDescriptions: {},
    version: '',
    toMoment: null,
};

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch]));
}

function ctx() {
    try {
        return globalThis.SillyTavern?.getContext?.() ?? null;
    } catch {
        return null;
    }
}

function hueFor(text) {
    let hash = 0;
    for (const ch of String(text)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return `hsl(${hash % 360} 62% 72%)`;
}

function plainSnippet(text, max = 110) {
    const div = document.createElement('div');
    div.innerHTML = String(text ?? '').replace(/<[^>]*>/g, ' ');
    const clean = (div.textContent ?? '').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function greeting() {
    const hour = new Date().getHours();
    if (hour < 5) return 'Good night';
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
}

/* ------------------------------------------------------------------------------------------- */
/* Drawers                                                                                       */
/* ------------------------------------------------------------------------------------------- */

function drawerToggle(drawerId) {
    const drawer = document.getElementById(drawerId);
    return drawer?.querySelector(':scope > .drawer-toggle') ?? null;
}

function openDrawer(drawerId) {
    const drawer = document.getElementById(drawerId);
    const content = drawer?.querySelector(':scope > .drawer-content');
    if (content && !content.classList.contains('openDrawer')) {
        drawerToggle(drawerId)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
}

/* ------------------------------------------------------------------------------------------- */
/* Sidebar labels + Home button                                                                  */
/* ------------------------------------------------------------------------------------------- */

function makeRailButton(id, icon, label, onActivate, before = null) {
    const holder = document.getElementById('top-settings-holder');
    if (!holder || document.getElementById(id)) return;
    const wrap = document.createElement('div');
    wrap.id = id;
    wrap.className = 'drawer';
    wrap.innerHTML = `<div class="ct-home-toggle" role="button" tabindex="0" title="${label}" aria-label="${label}"><div class="drawer-icon fa-solid ${icon} fa-fw closedIcon"></div></div>`;
    const anchor = before ? document.getElementById(before) : null;
    if (anchor?.parentElement === holder) anchor.before(wrap); else holder.prepend(wrap);
    const toggle = wrap.querySelector('.ct-home-toggle');
    toggle.addEventListener('click', () => onActivate());
    toggle.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onActivate();
        }
    });
}

function ensureHomeButton() {
    makeRailButton('ct-chat-button', 'fa-comments', 'Chat', () => showChat());
    makeRailButton('ct-home-button', 'fa-house', 'Home', () => toggleHome());
    // Card Browser gets its own button, next to the Characters icon in the top bar.
    makeRailButton('ct-cards-button', 'fa-earth-americas', 'Card Browser', () => {
        const browser = globalThis.HomunculusClassicCardBrowser;
        if (!browser) return;
        if (currentView === 'ct-cards-button') browser.close(); else browser.open();
    }, 'rightNavHolder');
    const holder = document.getElementById('top-settings-holder');
    if (holder && !document.getElementById('ct-rail-indicator')) {
        const indicator = document.createElement('div');
        indicator.id = 'ct-rail-indicator';
        indicator.setAttribute('aria-hidden', 'true');
        holder.prepend(indicator);
    }
}

/* ------------------------------------------------------------------------------------------- */
/* Pages (Lantern layout): exactly one of chat / home / a drawer panel is shown                  */
/* ------------------------------------------------------------------------------------------- */

let currentView = 'chat';
let viewsReady = false;
const wasOpen = new WeakMap();

function isOpenContent(content) {
    return content.classList.contains('openDrawer');
}

function drawerContents() {
    return [...document.querySelectorAll('#top-settings-holder > .drawer > .drawer-content')];
}

function placeIndicator() {
    const indicator = document.getElementById('ct-rail-indicator');
    if (!indicator) return;
    const railId = currentView === 'chat' ? 'ct-chat-button' : currentView === 'home' ? 'ct-home-button' : currentView;
    const toggle = document.querySelector(`#${CSS.escape(railId)} > .drawer-toggle, #${CSS.escape(railId)} > .ct-home-toggle`);
    if (!toggle || !toggle.offsetParent) {
        indicator.style.setProperty('--ct-o', '0');
        return;
    }
    const first = indicator.style.getPropertyValue('--ct-o') !== '1';
    if (first) indicator.style.transition = 'none';
    indicator.style.setProperty('--ct-y', `${toggle.offsetTop}px`);
    indicator.style.setProperty('--ct-o', '1');
    if (first) requestAnimationFrame(() => { indicator.style.transition = ''; });
}

/* Presets locked beside the chat (Lantern layout). Locking the Presets page keeps it as a column
   on the left of the chat, like SillyTavern's pinned panel. */
const DOCK_DRAWER = 'ai-config-button';

function isLanternActive() {
    return document.body.classList.contains('ct-layout-lanterna') && window.matchMedia('(min-width: 1000px)').matches;
}

function dockPanel() {
    return document.getElementById('left-nav-panel');
}

function isDocked() {
    const panel = dockPanel();
    return !!panel && panel.classList.contains('pinnedOpen') && isOpenContent(panel);
}

function syncDock() {
    document.body.classList.toggle('ct-dock-left', isLanternActive() && isDocked());
}

function bindDock() {
    const panel = dockPanel();
    if (panel) {
        new MutationObserver(syncDock).observe(panel, { attributes: true, attributeFilter: ['class'] });
    }
    // The lock: locking from the Presets page moves it beside the chat; unlocking there closes it.
    document.addEventListener('click', (event) => {
        const target = /** @type {HTMLElement} */ (event.target);
        if (target?.id !== 'lm_button_panel_pin') return;
        setTimeout(() => {
            syncDock();
            if (!isLanternActive()) return;
            const pinned = /** @type {HTMLInputElement} */ (target).checked;
            if (pinned && currentView === DOCK_DRAWER) {
                setView('chat');
            } else if (!pinned && currentView === 'chat' && panel && isOpenContent(panel)) {
                closeDrawerContent(panel);
            }
        }, 0);
    });
    // While it is locked, its sidebar item just brings the chat (and the column) back.
    document.addEventListener('click', (event) => {
        const toggle = /** @type {HTMLElement} */ (event.target)?.closest?.(`#${DOCK_DRAWER} > .drawer-toggle`);
        if (!toggle || !isLanternActive() || !isDocked() || currentView === 'chat') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        showChat();
    }, true);
}

export function setView(view) {
    currentView = view || 'chat';
    document.body.dataset.ctView = currentView;
    syncDock();
    for (const content of drawerContents()) {
        const active = content.closest('.drawer')?.id === currentView && isOpenContent(content);
        if (active && !content.classList.contains('ct-view-active')) {
            content.classList.add('ct-view-active');
            content.scrollTop = 0;
        } else if (!active) {
            content.classList.remove('ct-view-active');
        }
    }
    for (const drawer of document.querySelectorAll('#top-settings-holder > .drawer')) {
        const railId = currentView === 'chat' ? 'ct-chat-button' : currentView === 'home' ? 'ct-home-button' : currentView;
        drawer.classList.toggle('ct-rail-active', drawer.id === railId);
    }
    placeIndicator();
    document.dispatchEvent(new CustomEvent('ct:view-changed', { detail: { view: currentView } }));
}

export function getView() {
    return currentView;
}

function closeDrawerContent(content) {
    if (content && isOpenContent(content)) {
        content.closest('.drawer')?.querySelector(':scope > .drawer-toggle')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
}

export function showChat() {
    closeHome();
    if (currentView !== 'chat' && currentView !== 'home') {
        closeDrawerContent(document.querySelector(`#${CSS.escape(currentView)} > .drawer-content`));
    }
    setView('chat');
}

function watchDrawers() {
    for (const content of drawerContents()) {
        wasOpen.set(content, isOpenContent(content));
        new MutationObserver(() => {
            const open = isOpenContent(content);
            const id = content.closest('.drawer')?.id;
            if (open && !wasOpen.get(content)) {
                if (viewsReady) {
                    if (id === DOCK_DRAWER && content.classList.contains('pinnedOpen') && isLanternActive()) {
                        // Locked Presets opens as the column beside the chat, not as its own page.
                        closeHome();
                        setView('chat');
                    } else {
                        closeHome(true);
                        setView(id);
                    }
                }
            } else if (!open && wasOpen.get(content)) {
                if (currentView === id) setView('chat');
                else content.classList.remove('ct-view-active');
            }
            wasOpen.set(content, open);
        }).observe(content, { attributes: true, attributeFilter: ['class'] });
    }
}

function decorateRail() {
    for (const [id, label, order] of RAIL_ITEMS) {
        const drawer = document.getElementById(id);
        if (!drawer) continue;
        drawer.style.setProperty('--ct-rail-order', String(order));
        const toggle = drawer.querySelector(':scope > .drawer-toggle, :scope > .ct-home-toggle');
        if (toggle && !toggle.querySelector('.ct-rail-label')) {
            const span = document.createElement('span');
            span.className = 'ct-rail-label';
            span.textContent = label;
            toggle.append(span);
        }
    }
}

/* ------------------------------------------------------------------------------------------- */
/* Data                                                                                          */
/* ------------------------------------------------------------------------------------------- */

async function loadData() {
    const context = ctx();
    const tasks = [];
    tasks.push(fetch('/api/chats/recent', {
        method: 'POST',
        headers: context?.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
        body: JSON.stringify({ max: state.recentMax, metadata: isSpecimen() }),
        cache: 'no-cache',
    }).then(response => (response.ok ? response.json() : [])).catch(() => []));
    tasks.push(import('./world-info.js').then(module => ({
        names: Array.isArray(module.world_names) ? [...module.world_names] : [],
        active: Array.isArray(module.selected_world_info) ? [...module.selected_world_info] : [],
    })).catch(() => ({ names: [], active: [] })));
    tasks.push(import('./power-user.js').then(module => ({
        names: { ...(module.power_user?.personas ?? {}) },
        descriptions: { ...(module.power_user?.persona_descriptions ?? {}) },
    })).catch(() => ({ names: {}, descriptions: {} })));
    if (!state.toMoment) {
        tasks.push(import('./utils.js').then(module => { state.toMoment = module.timestampToMoment ?? null; }).catch(() => null));
        tasks.push(import('../script.js').then(module => { state.version = String(module.displayVersion ?? ''); }).catch(() => null));
    }
    const [recent, worlds, personas] = await Promise.all(tasks);
    state.recent = Array.isArray(recent) ? recent : [];
    state.worlds = worlds.names;
    state.activeWorlds = worlds.active;
    state.personas = personas.names;
    state.personaDescriptions = personas.descriptions;
}

/* ------------------------------------------------------------------------------------------- */
/* Render                                                                                        */
/* ------------------------------------------------------------------------------------------- */

function matches(text) {
    return !state.query || String(text ?? '').toLowerCase().includes(state.query);
}

function tagNames(context, avatar) {
    const ids = context?.tagMap?.[avatar] ?? [];
    return ids.map(id => context?.tags?.find(tag => tag.id === id)?.name).filter(Boolean);
}

function render() {
    const root = document.getElementById('ct-home');
    const context = ctx();
    if (!root || !context) return;
    root.classList.toggle('ct-home-specimen', isSpecimen());
    if (isSpecimen()) {
        renderSpecimen(root, context);
        return;
    }

    const characters = Array.isArray(context.characters) ? context.characters : [];
    const groups = Array.isArray(context.groups) ? context.groups : [];
    const thumb = (type, file) => context.getThumbnailUrl?.(type, file) ?? '';
    const personaEntries = Object.entries(state.personas);

    const sortedChars = characters
        .map((character, index) => ({ character, index }))
        .filter(({ character }) => character?.avatar && matches(`${character.name} ${tagNames(context, character.avatar).join(' ')}`))
        .sort((a, b) => Number(Boolean(b.character.fav)) - Number(Boolean(a.character.fav))
            || (Number(b.character.date_last_chat) || 0) - (Number(a.character.date_last_chat) || 0)
            || String(a.character.name).localeCompare(String(b.character.name)));
    const visibleChars = state.showAllChars || state.query ? sortedChars : sortedChars.slice(0, PREVIEW_COUNT);

    const lorebooks = state.worlds.filter(name => matches(name));
    const visibleLore = state.showAllLore || state.query ? lorebooks : lorebooks.slice(0, PREVIEW_COUNT);
    const linkedBy = (name) => characters.filter(character => character?.data?.extensions?.world === name).map(character => character.name);

    const recent = state.recent
        .map(chat => ({ chat, character: characters.find(item => item.avatar === chat.avatar), group: groups.find(item => item.id === chat.group) }))
        .filter(item => item.character || item.group)
        .slice(0, 4);

    // Current persona first, then A-Z; only a preview row unless "Show all" or a search is active.
    const people = personaEntries
        .filter(([, name]) => matches(name))
        .sort(([fileA, nameA], [fileB, nameB]) => Number(fileB === context.userAvatar) - Number(fileA === context.userAvatar)
            || String(nameA).localeCompare(String(nameB)));
    const visiblePeople = state.showAllPeople || state.query ? people : people.slice(0, PREVIEW_COUNT);
    const groupList = groups
        .filter(group => matches(group.name))
        .sort((a, b) => Number(Boolean(b.fav)) - Number(Boolean(a.fav))
            || (Number(b.date_last_chat) || 0) - (Number(a.date_last_chat) || 0)
            || String(a.name).localeCompare(String(b.name)));
    const visibleGroups = state.showAllGroups || state.query ? groupList : groupList.slice(0, PREVIEW_COUNT);

    const firstRecent = recent[0];
    const continueLabel = firstRecent ? (firstRecent.character?.name ?? firstRecent.group?.name ?? '') : '';
    const userName = context.name1 || 'there';

    root.innerHTML = `
        <div class="ct-home-inner">
            <header class="ct-home-top">
                <div>
                    <p class="ct-home-hello">${escapeHtml(greeting())}, ${escapeHtml(userName)}</p>
                    <h1 class="ct-home-title">Welcome home</h1>
                    <div class="ct-home-stats">
                        <span class="ct-home-stat"><b>${characters.length}</b> characters</span>
                        <span class="ct-home-stat"><b>${state.worlds.length}</b> lorebooks</span>
                        <span class="ct-home-stat"><b>${personaEntries.length}</b> personas</span>
                        ${groups.length ? `<span class="ct-home-stat"><b>${groups.length}</b> groups</span>` : ''}
                    </div>
                </div>
                <div class="ct-home-actions">
                    <label class="ct-home-search">
                        <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                        <input type="search" name="ct-home-search" autocomplete="off" placeholder="Search characters, lorebooks…" aria-label="Search characters, lorebooks and personas" value="${escapeHtml(state.query)}">
                    </label>
                    ${firstRecent ? `<button type="button" class="ct-home-btn" data-action="recent" data-index="0"><i class="fa-solid fa-comment" aria-hidden="true"></i>Continue with ${escapeHtml(continueLabel)}</button>` : ''}
                    <button type="button" class="ct-home-btn is-ghost" data-action="new-character"><i class="fa-solid fa-plus" aria-hidden="true"></i>New character</button>
                </div>
            </header>

            ${recent.length && !state.query ? `
            <section class="ct-home-section" aria-labelledby="ct_home_recent">
                <div class="ct-home-head"><h2 class="ct-home-h2" id="ct_home_recent">Continue</h2></div>
                <div class="ct-home-recent">
                    ${recent.map(({ chat, character, group }, i) => `
                        <button type="button" class="ct-home-card" style="--i:${i}" data-action="recent" data-index="${i}">
                            <img src="${escapeHtml(character ? thumb('avatar', character.avatar) : (group?.avatar_url || 'img/five.png'))}" alt="" loading="lazy" width="44" height="44">
                            <span class="ct-home-recent-text">
                                <b><span>${escapeHtml(character?.name ?? group?.name)}</span><small>${escapeHtml(chat.date_short ?? '')}</small></b>
                                <em>${escapeHtml(plainSnippet(chat.mes))}</em>
                            </span>
                        </button>`).join('')}
                </div>
            </section>` : ''}

            <section class="ct-home-section" aria-labelledby="ct_home_chars">
                <div class="ct-home-head">
                    <h2 class="ct-home-h2" id="ct_home_chars">Characters<small>${sortedChars.length}</small></h2>
                    ${!state.query && sortedChars.length > PREVIEW_COUNT ? `<button type="button" class="ct-home-link" data-action="toggle-chars">${state.showAllChars ? 'Show fewer' : `Show all ${sortedChars.length}`}</button>` : ''}
                </div>
                ${visibleChars.length ? `<div class="ct-home-chars">
                    ${visibleChars.map(({ character, index }, i) => {
                        const tags = tagNames(context, character.avatar);
                        const sub = tags.slice(0, 2).join(' · ') || character.data?.creator || '';
                        return `
                        <button type="button" class="ct-home-card ct-home-char" style="--i:${i}" data-action="character" data-index="${index}" aria-label="Edit ${escapeHtml(character.name)}">
                            <span class="ct-home-char-img"><img src="${escapeHtml(thumb('avatar', character.avatar))}" alt="" loading="lazy"></span>
                            ${character.fav ? '<span class="ct-home-fav" title="Favorite"><i class="fa-solid fa-star" aria-hidden="true"></i></span>' : ''}
                            <span class="ct-home-char-cap"><b>${escapeHtml(character.name)}</b>${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</span>
                        </button>`;
                    }).join('')}
                </div>` : `<p class="ct-home-empty">${state.query ? 'No character matches this search.' : 'No characters yet. Create or import one to get started.'}</p>`}
            </section>

            <section class="ct-home-section" aria-labelledby="ct_home_lore">
                <div class="ct-home-head">
                    <h2 class="ct-home-h2" id="ct_home_lore">Lorebooks<small>${lorebooks.length}</small></h2>
                    ${!state.query && lorebooks.length > PREVIEW_COUNT ? `<button type="button" class="ct-home-link" data-action="toggle-lore">${state.showAllLore ? 'Show fewer' : `Show all ${lorebooks.length}`}</button>` : ''}
                </div>
                ${visibleLore.length ? `<div class="ct-home-lore">
                    ${visibleLore.map((name, i) => {
                        const linked = linkedBy(name);
                        const isActive = state.activeWorlds.includes(name);
                        const sub = [isActive ? 'Active in every chat' : '', linked.length ? `Linked to ${linked.slice(0, 2).join(', ')}${linked.length > 2 ? ` +${linked.length - 2}` : ''}` : ''].filter(Boolean).join(' · ') || 'Lorebook';
                        return `
                        <button type="button" class="ct-home-card ct-home-lorebook" style="--i:${i};--h:${hueFor(name)}" data-action="lorebook" data-name="${escapeHtml(name)}" aria-label="Edit lorebook ${escapeHtml(name)}">
                            <span class="ct-home-lore-ico"><i class="fa-solid fa-book-atlas" aria-hidden="true"></i></span>
                            <span class="ct-home-lore-text"><b>${escapeHtml(name)}</b><small>${escapeHtml(sub)}</small></span>
                        </button>`;
                    }).join('')}
                </div>` : `<p class="ct-home-empty">${state.query ? 'No lorebook matches this search.' : 'No lorebooks yet. Create one in the Lorebooks panel.'}</p>`}
            </section>

            ${people.length ? `
            <section class="ct-home-section" aria-labelledby="ct_home_people">
                <div class="ct-home-head">
                    <h2 class="ct-home-h2" id="ct_home_people">Personas<small>${people.length}</small></h2>
                    ${!state.query && people.length > PREVIEW_COUNT ? `<button type="button" class="ct-home-link" data-action="toggle-people">${state.showAllPeople ? 'Show fewer' : `Show all ${people.length}`}</button>` : ''}
                </div>
                <div class="ct-home-people">
                    ${visiblePeople.map(([file, name], i) => `
                        <button type="button" class="ct-home-card ct-home-person${context.userAvatar === file ? ' is-current' : ''}" style="--i:${i}" data-action="persona" data-file="${escapeHtml(file)}" aria-label="Edit persona ${escapeHtml(name)}">
                            <img src="${escapeHtml(thumb('persona', file))}" alt="" loading="lazy" width="36" height="36"><span>${escapeHtml(name)}</span>
                        </button>`).join('')}
                </div>
            </section>` : ''}

            ${groupList.length ? `
            <section class="ct-home-section" aria-labelledby="ct_home_groups">
                <div class="ct-home-head">
                    <h2 class="ct-home-h2" id="ct_home_groups">Groups<small>${groupList.length}</small></h2>
                    ${!state.query && groupList.length > PREVIEW_COUNT ? `<button type="button" class="ct-home-link" data-action="toggle-groups">${state.showAllGroups ? 'Show fewer' : `Show all ${groupList.length}`}</button>` : ''}
                </div>
                <div class="ct-home-people">
                    ${visibleGroups.map((group, i) => `
                        <button type="button" class="ct-home-card ct-home-person" style="--i:${i}" data-action="group" data-id="${escapeHtml(group.id)}" aria-label="Open group ${escapeHtml(group.name)}">
                            <img src="${escapeHtml(group.avatar_url || (group.members?.[0] ? thumb('avatar', group.members[0]) : 'img/five.png'))}" alt="" loading="lazy" width="36" height="36"><span>${escapeHtml(group.name)}</span>
                        </button>`).join('')}
                </div>
            </section>` : ''}

            ${!state.query ? `
            <section class="ct-home-section" aria-labelledby="ct_home_tools">
                <div class="ct-home-head"><h2 class="ct-home-h2" id="ct_home_tools">Tools</h2></div>
                <div class="ct-home-tools">
                    ${TOOLS.filter(tool => (tool.open ? globalThis[tool.open] : document.getElementById(tool.drawer))).map((tool, i) => `
                        <button type="button" class="ct-home-card ct-home-tool" style="--i:${i}" data-action="tool" ${tool.open ? `data-open="${tool.open}"` : `data-drawer="${tool.drawer}"`}>
                            <i class="fa-solid ${tool.icon}" aria-hidden="true"></i><b>${escapeHtml(tool.name)}</b><small>${escapeHtml(tool.desc)}</small>
                        </button>`).join('')}
                </div>
            </section>` : ''}
        </div>`;

    root._ctRecent = recent;
}

/* ------------------------------------------------------------------------------------------- */
/* Specimen home                                                                                 */
/* ------------------------------------------------------------------------------------------- */

function isSpecimen() {
    return document.body.classList.contains('ct-homestyle-specimen');
}

function eyeSvg(className, variant = 'badge') {
    if (variant === 'hero') {
        return `<svg class="${className}" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><path d="${EYE_LID}" fill="none" stroke="var(--ct-brick, #4A1F1F)" stroke-width="0.6"/><path class="ct-eye-gear" d="${EYE_GEAR}" fill="none" stroke="var(--ct-blood, #B81D23)" stroke-width="0.35"/><circle cx="32" cy="32" r="6.2" fill="var(--ct-blood, #B81D23)"/><circle class="ct-eye-pupil" cx="32" cy="32" r="2.6" fill="var(--ct-ink, #000)"/></svg>`;
    }
    return `<svg class="${className}" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><rect x="2" y="2" width="60" height="60" rx="14" fill="var(--ct-blood, #B81D23)"/><path d="${EYE_LID}" fill="var(--ct-blood, #B81D23)" stroke="var(--ct-ink, #000)" stroke-width="3" stroke-linejoin="round"/><path class="ct-eye-gear" d="${EYE_GEAR}" fill="var(--ct-ink, #000)"/><circle cx="32" cy="32" r="6.2" fill="var(--ct-blood, #B81D23)"/><circle class="ct-eye-pupil" cx="32" cy="32" r="2.6" fill="var(--ct-ink, #000)"/></svg>`;
}

/** Sidebar logo (Lantern layout + specimen home). Hidden by CSS everywhere else. */
function ensureRailLogo() {
    const holder = document.getElementById('top-settings-holder');
    if (!holder || document.getElementById('ct-rail-logo')) return;
    const logo = document.createElement('button');
    logo.type = 'button';
    logo.id = 'ct-rail-logo';
    logo.className = 'ct-rail-logo';
    logo.title = 'Homunculus';
    logo.setAttribute('aria-label', 'Homunculus: open Home');
    logo.innerHTML = eyeSvg('ct-rail-logo-svg');
    logo.addEventListener('click', () => { void openHome(); });
    holder.prepend(logo);
}

function toRoman(value) {
    let n = Math.max(0, Math.floor(value));
    let out = '';
    for (const [arabic, roman] of [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]) {
        while (n >= arabic) { out += roman; n -= arabic; }
    }
    return out;
}

/** "2 H", "3 D", "NOW"… from a chat's last message date. */
function shortAgo(timestamp) {
    let time = NaN;
    try {
        const moment = state.toMoment?.(timestamp);
        time = moment?.isValid?.() ? moment.valueOf() : Date.parse(timestamp);
    } catch {
        time = Date.parse(timestamp);
    }
    if (!Number.isFinite(time)) return '';
    const minutes = Math.max(0, Math.round((Date.now() - time) / 60000));
    if (minutes < 1) return 'NOW';
    if (minutes < 60) return `${minutes} MIN`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} H`;
    const days = Math.round(hours / 24);
    if (days < 7) return `${days} D`;
    const weeks = Math.round(days / 7);
    if (weeks < 9) return `${weeks} W`;
    return new Date(time).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).toUpperCase();
}

function specimenNumber(index) {
    return `Nº ${String(index + 1).padStart(2, '0')}`;
}

function specimenCard(context, { character, index }) {
    const sub = tagNames(context, character.avatar)[0] || character.data?.creator || '';
    const img = context.getThumbnailUrl?.('avatar', character.avatar) ?? '';
    return `
        <button type="button" class="ct-sp-card" data-action="character" data-index="${index}" aria-label="Edit ${escapeHtml(character.name)}">
            <span class="ct-sp-card-img"><img src="${escapeHtml(img)}" alt="" loading="lazy"><span class="ct-sp-card-n">${specimenNumber(index)}</span></span>
            <span class="ct-sp-card-cap"><b>${escapeHtml(character.name)}</b>${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</span>
        </button>`;
}

function renderSpecimen(root, context) {
    const characters = Array.isArray(context.characters) ? context.characters : [];
    const groups = Array.isArray(context.groups) ? context.groups : [];
    const thumb = (type, file) => context.getThumbnailUrl?.(type, file) ?? '';

    const allRecent = state.recent
        .map(chat => ({ chat, character: characters.find(item => item.avatar === chat.avatar), group: groups.find(item => item.id === chat.group) }))
        .filter(item => item.character || item.group);
    const recent = state.showAllRecent ? allRecent : allRecent.slice(0, SPECIMEN_RECENT);
    const breathing = Math.min(allRecent.length, SPECIMEN_RECENT);

    const lede = breathing === 0
        ? 'Nothing is breathing yet. Pick a character and cut something new open.'
        : breathing === 1
            ? 'One story is still breathing. Pick it up where you left it, or cut something new open.'
            : `${COUNT_WORDS[breathing]} stories are still breathing. Pick one up where you left it, or cut something new open.`;
    const version = (state.version.match(/v\d+(?:\.\d+)*/i)?.[0] ?? '').toUpperCase().replace(/^V/, 'v');
    const kicker = ['PRIVATE BUILD', version, `${characters.length} SPECIMEN${characters.length === 1 ? '' : 'S'} ON FILE`].filter(Boolean).join(' · ');

    const first = allRecent[0];
    let continueBlock = '';
    if (first) {
        const name = first.character?.name ?? first.group?.name ?? '';
        const img = first.character ? thumb('avatar', first.character.avatar) : (first.group?.avatar_url || 'img/five.png');
        const chapters = Array.isArray(first.chat.chat_metadata?.classic_memory?.chapters) ? first.chat.chat_metadata.classic_memory.chapters.length : 0;
        const ago = shortAgo(first.chat.last_mes);
        const where = chapters ? `CHAPTER ${toRoman(chapters)}` : `${Number(first.chat.chat_items) || 0} MESSAGES`;
        const when = ago ? (ago === 'NOW' ? 'LAST REPLY JUST NOW' : `LAST REPLY ${ago} AGO`) : '';
        continueBlock = `
            <button type="button" class="ct-sp-continue" data-action="recent" data-index="0">
                <span class="ct-sp-continue-img"><img src="${escapeHtml(img)}" alt="" width="48" height="48"></span>
                <span class="ct-sp-continue-text"><b>Continue · ${escapeHtml(name)}</b><small>${escapeHtml([where, when].filter(Boolean).join(' · '))}</small></span>
                <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>
            </button>`;
    }

    const lorebooks = [...state.worlds].sort((a, b) => Number(state.activeWorlds.includes(b)) - Number(state.activeWorlds.includes(a)) || String(a).localeCompare(String(b)));
    const linkedBy = (name) => characters.filter(character => character?.data?.extensions?.world === name).map(character => character.name);
    const loreLabel = (name) => {
        if (state.activeWorlds.includes(name)) return 'ACTIVE';
        const linked = linkedBy(name);
        if (linked.length) return `LINKED · ${String(linked[0]).toUpperCase()}${linked.length > 1 ? ` +${linked.length - 1}` : ''}`;
        return 'LOREBOOK';
    };

    const personaFile = context.userAvatar;
    const personaName = state.personas[personaFile] || context.name1 || '';
    const personaDesc = plainSnippet(state.personaDescriptions[personaFile]?.description ?? '', 70);

    const sortedChars = characters
        .map((character, index) => ({ character, index }))
        .filter(({ character }) => character?.avatar)
        .sort((a, b) => Number(Boolean(b.character.fav)) - Number(Boolean(a.character.fav))
            || (Number(b.character.date_last_chat) || 0) - (Number(a.character.date_last_chat) || 0)
            || String(a.character.name).localeCompare(String(b.character.name)))
        .slice(0, SPECIMEN_CHARS);

    root.innerHTML = `
        <div class="ct-sp">
            <section class="ct-sp-hero">
                ${eyeSvg('ct-hero-eye', 'hero')}
                <div class="ct-sp-hero-in">
                    <span class="ct-sp-kicker">${escapeHtml(kicker)}</span>
                    <h1 class="ct-sp-title">Homun<wbr>culus</h1>
                    <p class="ct-sp-lede">${escapeHtml(lede)}</p>
                    <div class="ct-sp-ctas">
                        ${continueBlock}
                        <button type="button" class="ct-sp-ghost" data-action="archive">New chat</button>
                        ${globalThis.HomunculusClassicCardBrowser ? '<button type="button" class="ct-sp-ghost" data-action="tool" data-open="HomunculusClassicCardBrowser"><i class="fa-solid fa-earth-americas" aria-hidden="true"></i>Browse cards</button>' : ''}
                    </div>
                </div>
            </section>

            <div class="ct-sp-cols">
                <section class="ct-sp-col-main" aria-labelledby="ct_sp_recent">
                    <div class="ct-sp-head">
                        <h2 class="ct-sp-h2" id="ct_sp_recent">Recent</h2>
                        ${allRecent.length > SPECIMEN_RECENT || state.recentMax < 20 ? `<button type="button" class="ct-sp-link" data-action="more-recent">${state.showAllRecent ? 'Fewer chats' : 'All chats'}</button>` : ''}
                    </div>
                    ${recent.length ? recent.map(({ chat, character, group }, i) => `
                        <button type="button" class="ct-sp-row" data-action="recent" data-index="${i}">
                            <span class="ct-sp-row-n">${String(i + 1).padStart(2, '0')}</span>
                            <span class="ct-sp-row-name">${escapeHtml(character?.name ?? group?.name)}</span>
                            <span class="ct-sp-row-line">${escapeHtml(plainSnippet(chat.mes, 140))}</span>
                            <span class="ct-sp-row-when">${escapeHtml(shortAgo(chat.last_mes))}</span>
                        </button>`).join('') : '<p class="ct-sp-empty">No chats yet. Open a character to begin.</p>'}
                </section>

                <div class="ct-sp-col-side">
                    <section aria-labelledby="ct_sp_lore">
                        <div class="ct-sp-head">
                            <h2 class="ct-sp-h2" id="ct_sp_lore">Lorebooks</h2>
                            ${document.getElementById('WI-SP-button') ? '<button type="button" class="ct-sp-link" data-action="tool" data-drawer="WI-SP-button">All</button>' : ''}
                        </div>
                        ${lorebooks.length ? lorebooks.slice(0, SPECIMEN_LORE).map(name => `
                            <button type="button" class="ct-sp-row ct-sp-lore" data-action="lorebook" data-name="${escapeHtml(name)}">
                                <span class="ct-sp-lore-name">${escapeHtml(name)}</span>
                                <span class="ct-sp-row-when">${escapeHtml(loreLabel(name))}</span>
                            </button>`).join('') : '<p class="ct-sp-empty">No lorebooks yet.</p>'}
                    </section>
                    ${personaName ? `
                    <section class="ct-sp-persona" aria-labelledby="ct_sp_persona">
                        <h2 class="ct-sp-persona-h" id="ct_sp_persona">YOU ARE PLAYING AS</h2>
                        <div class="ct-sp-persona-who">
                            <img src="${escapeHtml(thumb('persona', personaFile))}" alt="" width="52" height="52">
                            <span><b>${escapeHtml(personaName)}</b>${personaDesc ? `<small>${escapeHtml(personaDesc)}</small>` : ''}</span>
                        </div>
                        <button type="button" class="ct-sp-ghost ct-sp-ghost-bone" data-action="persona" data-file="${escapeHtml(personaFile)}">Switch persona</button>
                    </section>` : ''}
                </div>
            </div>

            <section class="ct-sp-chars" aria-labelledby="ct_sp_chars">
                <div class="ct-sp-head">
                    <h2 class="ct-sp-h2" id="ct_sp_chars">Characters</h2>
                    <button type="button" class="ct-sp-link" data-action="archive">Open the archive</button>
                </div>
                ${sortedChars.length ? `<div class="ct-sp-grid">${sortedChars.map(item => specimenCard(context, item)).join('')}</div>` : '<p class="ct-sp-empty">No characters yet. Create or import one to get started.</p>'}
            </section>
        </div>`;

    root._ctRecent = recent;
}

/* ------------------------------------------------------------------------------------------- */
/* Actions                                                                                       */
/* ------------------------------------------------------------------------------------------- */

async function openCharacter(index) {
    const { selectCharacterById } = await import('../script.js');
    closeHome();
    await selectCharacterById(index);
    openDrawer('rightNavHolder');
}

async function openRecent(item) {
    if (!item) return;
    const context = ctx();
    const chatName = String(item.chat.chat_name ?? item.chat.file_name ?? '').replace(/\.jsonl$/i, '');
    closeHome();
    try {
        if (item.character) {
            const { selectCharacterById, openCharacterChat, getCurrentChatId } = await import('../script.js');
            const index = context.characters.findIndex(character => character.avatar === item.character.avatar);
            if (index < 0 || !(await selectCharacterById(index))) return;
            if (getCurrentChatId() !== chatName) await openCharacterChat(chatName);
        } else if (item.group) {
            const { openGroupById, openGroupChat } = await import('./group-chats.js');
            const { getCurrentChatId } = await import('../script.js');
            if (!(await openGroupById(item.group.id))) return;
            if (getCurrentChatId() !== chatName) await openGroupChat(item.group.id, chatName);
        }
    } catch (error) {
        console.error('[Classic Home] Could not open the chat:', error);
        globalThis.toastr?.error?.('Could not open that chat. See the console for details.');
    }
}

async function openLorebook(name) {
    const { openWorldInfoEditor } = await import('./world-info.js');
    closeHome();
    openWorldInfoEditor(name);
}

function openPersona(file) {
    closeHome();
    openDrawer('persona-management-button');
    // Highlight it without switching the active persona.
    setTimeout(() => {
        const card = [...document.querySelectorAll('#user_avatar_block [data-avatar-id]')].find(el => el.getAttribute('data-avatar-id') === file);
        if (!card) return;
        card.scrollIntoView({ block: 'center', behavior: 'smooth' });
        card.classList.add('ct-flash');
        setTimeout(() => card.classList.remove('ct-flash'), 1800);
    }, 350);
}

async function openGroup(id) {
    const { openGroupById } = await import('./group-chats.js');
    closeHome();
    await openGroupById(id);
    openDrawer('rightNavHolder');
}

function openArchive() {
    closeHome();
    openDrawer('rightNavHolder');
}

function newCharacter() {
    closeHome();
    openDrawer('rightNavHolder');
    setTimeout(() => document.getElementById('rm_button_create')?.click(), 250);
}

function bindHome(root) {
    root.addEventListener('click', (event) => {
        const target = /** @type {HTMLElement} */ (event.target).closest('[data-action]');
        if (!target) return;
        const action = target.dataset.action;
        if (action === 'character') void openCharacter(Number(target.dataset.index));
        else if (action === 'recent') void openRecent(root._ctRecent?.[Number(target.dataset.index)]);
        else if (action === 'lorebook') void openLorebook(target.dataset.name);
        else if (action === 'persona') openPersona(target.dataset.file);
        else if (action === 'group') void openGroup(target.dataset.id);
        else if (action === 'tool') { closeHome(); if (target.dataset.open) globalThis[target.dataset.open]?.open?.(); else openDrawer(target.dataset.drawer); }
        else if (action === 'new-character') newCharacter();
        else if (action === 'archive') openArchive();
        else if (action === 'more-recent') void toggleMoreRecent();
        else if (action === 'toggle-chars') { state.showAllChars = !state.showAllChars; render(); }
        else if (action === 'toggle-lore') { state.showAllLore = !state.showAllLore; render(); }
        else if (action === 'toggle-people') { state.showAllPeople = !state.showAllPeople; render(); }
        else if (action === 'toggle-groups') { state.showAllGroups = !state.showAllGroups; render(); }
    });
    root.addEventListener('input', (event) => {
        const input = /** @type {HTMLInputElement} */ (event.target);
        if (input.name !== 'ct-home-search') return;
        state.query = input.value.trim().toLowerCase();
        const caret = input.selectionStart;
        render();
        const again = /** @type {HTMLInputElement} */ (root.querySelector('input[name="ct-home-search"]'));
        again?.focus();
        if (again && caret !== null) again.setSelectionRange(caret, caret);
    });
}

async function toggleMoreRecent() {
    state.showAllRecent = !state.showAllRecent;
    if (state.showAllRecent && state.recentMax < 20) {
        state.recentMax = 20;
        await loadData();
    }
    render();
}

function ensureHomeRoot() {
    let root = document.getElementById('ct-home');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'ct-home';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Home');
    document.body.append(root);
    bindHome(root);
    return root;
}

function setOpenState(open, { keepView = false } = {}) {
    state.open = open;
    if (open) setView('home');
    else if (!keepView && currentView === 'home') setView('chat');
    const button = document.getElementById('ct-home-button');
    button?.classList.toggle('is-open', open);
    button?.querySelector('.ct-home-toggle')?.setAttribute('aria-pressed', String(open));
    const icon = button?.querySelector('.drawer-icon');
    icon?.classList.toggle('openIcon', open);
    icon?.classList.toggle('closedIcon', !open);
    document.body.classList.toggle('ct-home-open', open);
    document.getElementById('ct-home')?.classList.toggle('is-open', open);
}

export async function openHome() {
    globalThis.HomunculusClassicCardBrowser?.close?.();
    const root = ensureHomeRoot();
    // Close any open (unpinned) drawer so Home is not hidden behind it.
    for (const content of document.querySelectorAll('#top-settings-holder .drawer-content.openDrawer:not(.pinnedOpen)')) {
        content.closest('.drawer')?.querySelector(':scope > .drawer-toggle')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    setOpenState(true);
    root.scrollTop = 0;
    render();
    await loadData();
    if (state.open) render();
}

export function closeHome(keepView = false) {
    if (state.open) setOpenState(false, { keepView });
}

export function toggleHome() {
    if (state.open) closeHome(); else void openHome();
}

function init() {
    ensureHomeButton();
    ensureRailLogo();
    decorateRail();
    watchDrawers();
    bindDock();
    setView('chat');
    window.addEventListener('resize', () => { placeIndicator(); syncDock(); });
    const markReady = () => {
        if (viewsReady) return;
        viewsReady = true;
        // Panels SillyTavern reopens at start-up (pinned ones) stay hidden; the app starts on the chat,
        // unless Home or the Card Browser was already opened while the app was still loading.
        setView(currentView === 'home' || currentView === 'ct-cards-button' ? currentView : 'chat');
    };
    const waitForApp = window.setInterval(() => {
        const context = ctx();
        if (context?.eventSource && context?.event_types) {
            window.clearInterval(waitForApp);
            context.eventSource.on(context.event_types.APP_READY, () => setTimeout(markReady, 300));
        }
    }, 100);
    setTimeout(markReady, 15000);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && state.open && !document.querySelector('.popup[open], dialog[open]')) closeHome();
    });
    // Classic layout: a locked (pinned) panel stays open behind Home / the Card Browser. Clicking its icon
    // there should bring it back, but SillyTavern's click would close it, so leave the page instead.
    document.addEventListener('click', (event) => {
        const toggle = /** @type {HTMLElement} */ (event.target)?.closest?.('#top-settings-holder > .drawer > .drawer-toggle');
        if (!toggle || isLanternActive()) return;
        const content = toggle.parentElement?.querySelector(':scope > .drawer-content');
        const browserOpen = document.body.classList.contains('ct-cb-open');
        if (!content?.classList.contains('pinnedOpen') || !isOpenContent(content) || !(state.open || browserOpen)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (browserOpen) globalThis.HomunculusClassicCardBrowser?.close?.();
        closeHome();
    }, true);
    // Opening any drawer from the top bar / sidebar while Home is up closes Home.
    document.getElementById('top-settings-holder')?.addEventListener('click', (event) => {
        if (/** @type {HTMLElement} */ (event.target).closest('.drawer-toggle')) closeHome();
    });
    document.addEventListener('ct:appearance-changed', () => {
        if (state.open) {
            render();
            if (isSpecimen()) void loadData().then(() => { if (state.open) render(); });
        }
        requestAnimationFrame(() => setView(currentView));
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}

globalThis.HomunculusClassicHome = { openHome, closeHome, toggleHome, showChat, setView, getView };
