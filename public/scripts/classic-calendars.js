// Classic UI fork: calendars for the Scene panel's story clock.
//
// The Scene: World tracker writes the in-story date as numbers ({ year, month, day }) plus a 24-hour
// clock; the calendar says how many months there are, what they are called, how long they are, the
// weekday names and how years are written. Gregorian is the default; other calendars are presets like
// the field presets (built-ins are read-only, "Duplicate" makes an editable copy). A group picks its
// calendar in the Scene panel (World tab); outside groups the default calendar is used.

import { saveSettingsDebounced } from '../script.js';
import { extension_settings } from './extensions.js';
import { groups, selected_group, editGroup } from './group-chats.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { helpButton } from './classic-help.js';

export const CALENDARS_CHANGED_EVENT = 'homunculus:calendars-changed';
const GROUP_KEY = 'homunculus_scene_fields';
export const DEFAULT_CALENDAR = 'builtin-gregorian';

const HELP = {
    editor: `<p>A calendar tells the World tracker how dates work in this story: the months and how many days each has, the names of the weekdays, and how years are written.</p>
<p><b>Gregorian</b> is the real-world calendar. For a fantasy or sci-fi world, duplicate a calendar and rename the months, change their length, the weekdays and the era.</p>
<p>The tracker writes the date as numbers (year, month number, day), so changing a month's name later does not break old dates.</p>`,
    era: '<p>Written after the year, for example <b>AE</b> gives "1247 AE". Leave it empty to show only the number. Negative years are allowed (before year 1).</p>',
    leap: '<p>Adds one day to month 2 in leap years (every 4 years, except years divisible by 100 but not by 400), like the real-world February.</p>',
    notes: '<p>Anything else the AI should know about time in this world: holidays, how seasons line up with months, a second moon… Optional.</p>',
};

const BUILTIN = [
    {
        id: DEFAULT_CALENDAR,
        name: 'Gregorian',
        builtin: true,
        leap: 'gregorian',
        era: '',
        months: [
            ['January', 31], ['February', 28], ['March', 31], ['April', 30], ['May', 31], ['June', 30],
            ['July', 31], ['August', 31], ['September', 30], ['October', 31], ['November', 30], ['December', 31],
        ].map(([name, days]) => ({ name, days })),
        weekdays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
        notes: '',
    },
    {
        id: 'builtin-twelve-moons',
        name: 'Twelve Moons (fantasy, 12 × 30 days)',
        builtin: true,
        leap: 'none',
        era: 'AE',
        months: [
            'Deepwinter', 'Thawmoon', 'Seedtide', 'Rainmoon', 'Greening', 'Highsun',
            'Goldmoon', 'Harvestide', 'Leaffall', 'Mistmoon', 'Frostfall', 'Longnight',
        ].map(name => ({ name, days: 30 })),
        weekdays: ['Sunsday', 'Moonsday', 'Fireday', 'Waterday', 'Woodday', 'Goldday', 'Restday'],
        notes: '',
    },
];

// ───────────────────────── Storage ─────────────────────────

function settings() {
    const st = extension_settings.homunculusCalendars && typeof extension_settings.homunculusCalendars === 'object'
        ? extension_settings.homunculusCalendars
        : (extension_settings.homunculusCalendars = {});
    if (!Array.isArray(st.custom)) st.custom = [];
    if (typeof st.active !== 'string') st.active = '';
    return st;
}

const str = value => (value === null || value === undefined ? '' : String(value));
const toInt = (value, fallback = null) => {
    const n = Number.parseInt(str(value).trim(), 10);
    return Number.isFinite(n) ? n : fallback;
};
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/** A calendar in its full shape (also cleans calendars edited by hand). */
export function normalizeCalendar(raw) {
    let months = (Array.isArray(raw?.months) ? raw.months : [])
        .map(month => ({ name: str(month?.name).trim().slice(0, 40), days: clamp(toInt(month?.days, 30), 1, 400) }))
        .filter(month => month.name);
    if (!months.length) months = [{ name: 'Month', days: 30 }];
    const weekdays = (Array.isArray(raw?.weekdays) ? raw.weekdays : str(raw?.weekdays).split(','))
        .map(day => str(day).trim().slice(0, 30))
        .filter(Boolean);
    return {
        id: str(raw?.id) || `custom-calendar-${Date.now().toString(36)}`,
        name: str(raw?.name).trim() || 'Untitled calendar',
        builtin: Boolean(raw?.builtin),
        leap: raw?.leap === 'gregorian' ? 'gregorian' : 'none',
        era: str(raw?.era).trim().slice(0, 24),
        months,
        weekdays,
        notes: str(raw?.notes).trim(),
    };
}

export function listCalendars() {
    return [...BUILTIN.map(cal => normalizeCalendar(structuredClone(cal))), ...settings().custom.map(normalizeCalendar)];
}

export function findCalendar(id) {
    return listCalendars().find(cal => cal.id === id) ?? null;
}

function groupById(groupId) {
    return groupId ? groups.find(item => String(item.id) === String(groupId)) ?? null : null;
}

/** The calendar in use: the open group's choice, else the default, else Gregorian. */
export function activeCalendar(groupId = selected_group) {
    const group = groupById(groupId);
    return findCalendar(str(group?.[GROUP_KEY]?.calendar)) ?? findCalendar(settings().active) ?? findCalendar(DEFAULT_CALENDAR);
}

function notify() {
    document.dispatchEvent(new CustomEvent(CALENDARS_CHANGED_EVENT));
}

/** Picks the calendar of a group, or the default calendar when groupId is null. */
export async function chooseCalendar(id, groupId = selected_group) {
    const group = groupById(groupId);
    if (group) {
        group[GROUP_KEY] = { ...(group[GROUP_KEY] ?? {}), calendar: id };
        await editGroup(group.id, false, false);
    } else {
        settings().active = id;
        saveSettingsDebounced();
    }
    notify();
}

function saveCustom(cal) {
    const list = settings().custom;
    const clean = normalizeCalendar({ ...cal, builtin: false });
    const index = list.findIndex(item => item.id === clean.id);
    if (index === -1) list.push(clean);
    else list[index] = clean;
    saveSettingsDebounced();
    notify();
    return clean;
}

function deleteCustom(id) {
    const st = settings();
    st.custom = st.custom.filter(item => item.id !== id);
    if (st.active === id) st.active = '';
    for (const group of groups) {
        if (group?.[GROUP_KEY]?.calendar === id) {
            group[GROUP_KEY].calendar = '';
            void editGroup(group.id, false, false);
        }
    }
    saveSettingsDebounced();
    notify();
}

// ───────────────────────── Dates ─────────────────────────

export function isLeapYear(cal, year) {
    return cal.leap === 'gregorian' && ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0);
}

export function daysInMonth(cal, year, month) {
    const entry = cal.months[month - 1];
    if (!entry) return 30;
    return entry.days + (month === 2 && isLeapYear(cal, year) ? 1 : 0);
}

/**
 * A date from tracker data: { year, month, day } (month as a number or a month name) or "YYYY-MM-DD".
 * @returns {{ year: number, month: number, day: number } | null}
 */
export function parseDate(raw, cal = activeCalendar()) {
    let year;
    let month;
    let day;
    if (raw && typeof raw === 'object') {
        year = toInt(raw.year);
        day = toInt(raw.day);
        month = toInt(raw.month);
        if (month === null && str(raw.month).trim()) {
            const name = str(raw.month).trim().toLowerCase();
            const index = cal.months.findIndex(item => item.name.toLowerCase() === name || item.name.toLowerCase().startsWith(name));
            month = index === -1 ? null : index + 1;
        }
    } else {
        const match = str(raw).trim().match(/^(-?\d{1,6})-(\d{1,2})-(\d{1,2})$/);
        if (match) [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    }
    if (year === null || year === undefined || month === null || month === undefined || day === null || day === undefined) return null;
    month = clamp(month, 1, cal.months.length);
    day = clamp(day, 1, daysInMonth(cal, year, month));
    return { year, month, day };
}

/** Moves a date by whole days (negative goes back). */
export function addDays(cal, date, count) {
    let { year, month, day } = date;
    let left = Math.trunc(count);
    while (left > 0) {
        const room = daysInMonth(cal, year, month) - day;
        if (left <= room) {
            day += left;
            break;
        }
        left -= room + 1;
        day = 1;
        month += 1;
        if (month > cal.months.length) {
            month = 1;
            year += 1;
        }
    }
    while (left < 0) {
        if (-left < day) {
            day += left;
            break;
        }
        left += day;
        month -= 1;
        if (month < 1) {
            month = cal.months.length;
            year -= 1;
        }
        day = daysInMonth(cal, year, month);
    }
    return { year, month, day };
}

/** The weekday name, or '' when the calendar has no weekdays. */
export function weekdayName(cal, date) {
    if (!cal.weekdays.length) return '';
    let index;
    if (cal.leap === 'gregorian' && cal.months.length === 12 && cal.weekdays.length === 7) {
        const when = new Date(Date.UTC(2000, 0, 1));
        when.setUTCFullYear(date.year, date.month - 1, date.day);
        index = when.getUTCDay();
    } else {
        const yearLength = cal.months.reduce((sum, item) => sum + item.days, 0);
        let total = date.year * yearLength + date.day - 1;
        for (let m = 1; m < date.month; m++) total += cal.months[m - 1].days;
        index = ((total % cal.weekdays.length) + cal.weekdays.length) % cal.weekdays.length;
    }
    return cal.weekdays[index] ?? '';
}

export function formatYear(cal, year) {
    if (cal.era) return `${year} ${cal.era}`;
    if (cal.leap === 'gregorian' && year <= 0) return `${1 - year} BC`;
    return String(year);
}

/** "Thursday, 22 October 2026" (short: "Thu, 22 Oct 2026"). */
export function formatDate(cal, date, { short = false, weekday = true } = {}) {
    const month = cal.months[date.month - 1]?.name ?? String(date.month);
    const day = weekday ? weekdayName(cal, date) : '';
    const cut = text => (short && text.length > 4 ? text.slice(0, 3) : text);
    return `${day ? `${cut(day)}, ` : ''}${date.day} ${cut(month)} ${formatYear(cal, date.year)}`;
}

/** Calendar description for the World tracker's prompt. */
export function calendarPrompt(cal = activeCalendar()) {
    const months = cal.months.map((item, index) => `${index + 1} ${item.name} (${item.days}${index === 1 && cal.leap === 'gregorian' ? `, ${item.days + 1} in leap years` : ''})`).join(', ');
    const lines = [
        `Calendar: ${cal.name}${cal.id === DEFAULT_CALENDAR ? ' (the real-world calendar)' : ''}.`,
        `Months (number, name, days): ${months}.`,
    ];
    if (cal.weekdays.length) lines.push(`Weekdays: ${cal.weekdays.join(', ')}.`);
    lines.push(cal.era ? `Years are counted in the era "${cal.era}".` : 'Years are plain numbers (0 or negative = before year 1).');
    if (cal.notes) lines.push(cal.notes);
    return lines.join('\n');
}

// ───────────────────────── Editor ─────────────────────────

function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function textButton(html, onClick, className = 'menu_button ct-sf-btn') {
    const b = el('button', className);
    b.type = 'button';
    b.innerHTML = html;
    b.addEventListener('click', onClick);
    return b;
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

function labeled(label, control, help = '') {
    const row = el('label', 'ct-sf-row');
    const name = el('span', 'ct-sf-label', label);
    row.append(name, control);
    if (help) row.append(helpButton(label, help));
    return row;
}

/**
 * The calendar editor (a popup). Built-in calendars are read-only with a Duplicate button.
 * @param {{ groupId?: string|null }} options which group's choice to show and change
 */
export async function openCalendarEditor({ groupId = selected_group } = {}) {
    let draft = structuredClone(activeCalendar(groupId));
    let dirty = false;
    const wrap = el('div', 'ct-sf ct-cal');
    const change = () => {
        dirty = true;
    };
    const commit = () => {
        if (draft.builtin || !dirty) return;
        draft = structuredClone(saveCustom(draft));
        dirty = false;
    };

    const paint = () => {
        wrap.replaceChildren();
        const head = el('div', 'ct-sf-head');
        const title = el('h3', 'ct-sf-title', 'Calendars');
        title.append(helpButton('Calendars', HELP.editor));
        head.append(title);
        const pick = el('div', 'ct-sf-pick');
        const select = el('select', 'text_pole');
        select.setAttribute('aria-label', 'Calendar');
        for (const cal of listCalendars()) {
            const opt = el('option', '', cal.builtin ? `${cal.name} (built-in)` : cal.name);
            opt.value = cal.id;
            opt.selected = cal.id === draft.id;
            select.append(opt);
        }
        select.addEventListener('change', () => {
            commit();
            draft = structuredClone(findCalendar(select.value) ?? activeCalendar(groupId));
            paint();
        });
        pick.append(select, textButton('<i class="fa-solid fa-copy"></i> Duplicate', () => {
            commit();
            draft = structuredClone(saveCustom({ ...structuredClone(draft), id: '', name: `${draft.name} (copy)` }));
            paint();
            wrap.querySelector('.ct-sf-name')?.focus();
        }));
        if (!draft.builtin) {
            pick.append(textButton('<i class="fa-solid fa-trash-can"></i> Delete', async () => {
                const ok = await new Popup(`<p>Delete the calendar <b>${draft.name.replace(/[<>&]/g, '')}</b>? Groups using it go back to the default.</p>`, POPUP_TYPE.CONFIRM, '', { okButton: 'Delete', cancelButton: 'Cancel' }).show();
                if (ok !== POPUP_RESULT.AFFIRMATIVE) return;
                deleteCustom(draft.id);
                draft = structuredClone(activeCalendar(groupId));
                dirty = false;
                paint();
            }, 'menu_button ct-sf-btn is-danger'));
        }
        head.append(pick);
        wrap.append(head);

        const readOnly = draft.builtin;
        if (readOnly) {
            const note = el('p', 'ct-sf-note');
            note.innerHTML = 'Built-in calendars can\'t be changed. Click <b>Duplicate</b> to make your own copy and edit it.';
            wrap.append(note);
        }
        const input = (value, placeholder, onInput, className = 'text_pole') => {
            const node = el('input', className);
            node.type = 'text';
            node.value = value;
            node.placeholder = placeholder;
            node.disabled = readOnly;
            node.addEventListener('input', () => {
                onInput(node.value);
                change();
            });
            return node;
        };
        if (!readOnly) {
            wrap.append(labeled('Name', input(draft.name, 'Calendar name', (value) => {
                draft.name = value;
                const opt = select.querySelector(`option[value="${CSS.escape(draft.id)}"]`);
                if (opt) opt.textContent = value || 'Untitled calendar';
            }, 'text_pole ct-sf-name')));
        }
        wrap.append(labeled('Era', input(draft.era, 'For example AE (optional)', (value) => {
            draft.era = value;
        }), HELP.era));
        const leapBox = el('input');
        leapBox.type = 'checkbox';
        leapBox.checked = draft.leap === 'gregorian';
        leapBox.disabled = readOnly;
        leapBox.addEventListener('change', () => {
            draft.leap = leapBox.checked ? 'gregorian' : 'none';
            change();
        });
        const leap = el('label', 'ct-sf-check');
        leap.append(leapBox, el('span', '', 'Leap years (month 2 gets one more day)'));
        const leapRow = el('div', 'ct-sf-row');
        leapRow.append(leap, helpButton('Leap years', HELP.leap));
        wrap.append(leapRow);

        const mHead = el('div', 'ct-sf-section-title');
        mHead.append(el('span', '', `Months (${draft.months.length}, ${draft.months.reduce((sum, item) => sum + (Number(item.days) || 0), 0)} days a year)`));
        wrap.append(mHead);
        const box = el('section', 'ct-sf-section ct-cal-months');
        draft.months.forEach((month, index) => {
            const row = el('div', 'ct-cal-month');
            row.append(el('span', 'ct-cal-num', String(index + 1)));
            const name = input(month.name, 'Month name', (value) => {
                month.name = value;
            });
            name.setAttribute('aria-label', `Name of month ${index + 1}`);
            const days = el('input', 'text_pole ct-cal-days');
            days.type = 'number';
            days.min = '1';
            days.max = '400';
            days.value = String(month.days);
            days.disabled = readOnly;
            days.setAttribute('aria-label', `Days in ${month.name || `month ${index + 1}`}`);
            days.addEventListener('change', () => {
                month.days = clamp(toInt(days.value, 30), 1, 400);
                change();
                paint();
            });
            row.append(name, days, el('span', 'ct-sf-key', 'days'));
            if (!readOnly) {
                row.append(
                    iconButton('fa-arrow-up', 'Move up', () => {
                        if (index > 0) [draft.months[index - 1], draft.months[index]] = [draft.months[index], draft.months[index - 1]];
                        change();
                        paint();
                    }),
                    iconButton('fa-xmark', `Remove ${month.name || 'month'}`, () => {
                        if (draft.months.length === 1) return;
                        draft.months.splice(index, 1);
                        change();
                        paint();
                    }, 'ct-sf-icon is-danger'),
                );
            }
            box.append(row);
        });
        if (!readOnly) {
            box.append(textButton('<i class="fa-solid fa-plus"></i> Add month', () => {
                draft.months.push({ name: `Month ${draft.months.length + 1}`, days: 30 });
                change();
                paint();
            }, 'ct-sf-add'));
        }
        wrap.append(box);

        const weekdays = el('textarea', 'text_pole');
        weekdays.rows = 1;
        weekdays.value = draft.weekdays.join(', ');
        weekdays.placeholder = 'Names separated by commas (optional)';
        weekdays.disabled = readOnly;
        weekdays.addEventListener('input', () => {
            draft.weekdays = weekdays.value.split(',').map(item => item.trim()).filter(Boolean);
            change();
        });
        const wRow = el('label', 'ct-sf-row is-stacked');
        wRow.append(el('span', 'ct-sf-label', 'Weekdays'), weekdays);
        wrap.append(wRow);

        const notes = el('textarea', 'text_pole');
        notes.rows = 2;
        notes.value = draft.notes;
        notes.placeholder = 'For example: The year starts at the spring equinox. Midwinter Night is a holiday.';
        notes.disabled = readOnly;
        notes.addEventListener('input', () => {
            draft.notes = notes.value;
            change();
        });
        const nRow = el('label', 'ct-sf-row is-stacked');
        const nLabel = el('span', 'ct-sf-label', 'Notes for the AI (optional)');
        nRow.append(nLabel, notes);
        wrap.append(nRow);

        const useRow = el('div', 'ct-sf-use');
        const using = activeCalendar(groupId).id === draft.id;
        useRow.append(el('span', 'ct-sf-note', using ? (groupId ? 'This group uses this calendar.' : 'This is the default calendar.') : (groupId ? 'This group uses another calendar.' : 'This is not the default calendar.')));
        if (!using) {
            useRow.append(textButton(`<i class="fa-solid fa-check"></i> Use for ${groupId ? 'this group' : 'chats outside groups'}`, async () => {
                commit();
                await chooseCalendar(draft.id, groupId);
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
        leftAlign: true,
        allowVerticalScrolling: true,
    });
    const result = await popup.show();
    if (result === POPUP_RESULT.AFFIRMATIVE) commit();
}

globalThis.HomunculusCalendars = {
    listCalendars,
    findCalendar,
    activeCalendar,
    chooseCalendar,
    openCalendarEditor,
    formatDate,
    calendarPrompt,
};
