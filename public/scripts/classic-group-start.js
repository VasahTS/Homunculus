// Classic UI fork: how a group's story starts (Group Studio → Setup → "How the story starts").
//
// group.homunculus_start = { scenario, openings[], speaker, vaultId, vaultName }
// Every new chat of the group starts with it: the scenario becomes the chat's scenario
// (chat_metadata.scenario) and the openings become the first message, the others its swipes, in place
// of the characters' own greetings. group-chats.js asks for both through globalThis.HomunculusGroupStart
// when it fills a fresh chat (addFreshGroupGreeting / getGroupChat).

import {
    chat,
    chat_metadata,
    characters,
    getThumbnailUrl,
    reloadCurrentChat,
    saveChatConditional,
    saveMetadata,
} from '../script.js';
import { groups, selected_group, editGroup } from './group-chats.js';
import { getMessageTimeStamp } from './RossAscends-mods.js';
import { getCampaign, narratorAvatar } from './classic-group-campaign.js';

const START_KEY = 'homunculus_start';

const str = value => (typeof value === 'string' ? value : value == null ? '' : String(value));
const findGroup = id => groups.find(group => String(group.id) === String(id));
const characterByAvatar = avatar => characters.find(character => character.avatar === avatar);

export function normalizeStart(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        scenario: str(source.scenario),
        openings: (Array.isArray(source.openings) ? source.openings : []).map(str),
        speaker: str(source.speaker),
        vaultId: str(source.vaultId),
        vaultName: str(source.vaultName),
    };
}

export function getStart(group) {
    return normalizeStart(group?.[START_KEY]);
}

/** Openings with text, in order. */
export const usableOpenings = start => start.openings.filter(text => text.trim());

export const isEmptyStart = start => !start.scenario.trim() && !usableOpenings(start).length;

export async function saveStart(groupId, patch) {
    const group = findGroup(groupId);
    if (!group) return null;
    const next = normalizeStart({ ...getStart(group), ...patch });
    group[START_KEY] = next;
    await editGroup(group.id, true, false);
    return next;
}

/** Who sends the opening: the narrator in a Narrated group, else the picked member or the first one that replies. */
export function speakerAvatar(group, start = getStart(group)) {
    const members = Array.isArray(group?.members) ? group.members : [];
    const disabled = new Set(group?.disabled_members ?? []);
    const campaign = getCampaign(group);
    if (campaign.mode === 'narrated') {
        const narrator = narratorAvatar(campaign);
        if (narrator && members.includes(narrator) && characterByAvatar(narrator)) return narrator;
    }
    if (start.speaker && members.includes(start.speaker) && characterByAvatar(start.speaker)) return start.speaker;
    return members.find(avatar => !disabled.has(avatar) && characterByAvatar(avatar)) ?? members.find(avatar => characterByAvatar(avatar)) ?? '';
}

function buildMessage(group, start, sendDate = getMessageTimeStamp()) {
    const openings = usableOpenings(start);
    const avatar = openings.length ? speakerAvatar(group, start) : '';
    const character = avatar ? characterByAvatar(avatar) : null;
    if (!character) return null;
    const message = {
        name: character.name,
        is_user: false,
        is_system: false,
        force_avatar: getThumbnailUrl('avatar', character.avatar),
        original_avatar: character.avatar,
        send_date: sendDate,
        mes: openings[0],
        extra: { homunculus_opening: true },
    };
    if (openings.length > 1) {
        message.swipe_id = 0;
        message.swipes = [...openings];
        message.swipe_info = openings.map(() => ({ send_date: sendDate, gen_started: void 0, gen_finished: void 0, extra: {} }));
    }
    return { avatarId: character.avatar, message };
}

/** The first message of a fresh chat of this group, or null to use the characters' greetings. */
export function openingMessage(group) {
    return buildMessage(group, getStart(group));
}

/** Puts the group's scenario into a fresh chat's metadata. */
export function prepareFreshChat(group, metadata) {
    const scenario = getStart(group).scenario.trim();
    if (scenario && metadata && !str(metadata.scenario).trim()) metadata.scenario = scenario;
}

/**
 * 'closed': this group's chat is not open. 'fresh': it is open and nothing happened yet besides the
 * opening. 'started': it is open and someone already wrote.
 */
export function openChatState(group) {
    if (!group || String(selected_group) !== String(group.id)) return 'closed';
    const onlyOpening = chat.length === 0 || (chat.length === 1 && !chat[0]?.is_user && !chat[0]?.is_system);
    return onlyOpening ? 'fresh' : 'started';
}

/**
 * Gives the open chat the group's start, if that chat has not started yet. Only the parts asked for
 * are synced, so editing the opening never wipes a scenario the chat got some other way.
 * Returns true when it changed the chat.
 */
export async function applyToOpenChat(group, { scenario: syncScenario = true, opening: syncOpening = true } = {}) {
    if (openChatState(group) !== 'fresh') return false;
    const start = getStart(group);
    let changed = false;
    const scenario = start.scenario.trim();
    if (syncScenario && str(chat_metadata.scenario).trim() !== scenario) {
        chat_metadata.scenario = scenario;
        await saveMetadata();
        changed = true;
    }
    if (!syncOpening) return changed;
    const built = buildMessage(group, start, chat[0]?.send_date);
    const current = chat[0];
    const currentSwipes = current ? (Array.isArray(current.swipes) && current.swipes.length ? current.swipes : [current.mes]) : [];
    const nextSwipes = built ? (built.message.swipes ?? [built.message.mes]) : [];
    const same = current && built && current.original_avatar === built.message.original_avatar && JSON.stringify(currentSwipes) === JSON.stringify(nextSwipes);
    if (built && !same) {
        if (current) chat[0] = built.message; else chat.push(built.message);
        await saveChatConditional();
        await reloadCurrentChat();
        changed = true;
    }
    return changed;
}

globalThis.HomunculusGroupStart = { getStart, openingMessage, prepareFreshChat, openChatState, applyToOpenChat };
