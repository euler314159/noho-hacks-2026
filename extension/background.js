// ClearPage service worker: read-aloud engine (chrome.tts), keyboard shortcuts,
// context menu, and keeping the network ad-blocking rules in sync with settings.
import { SETTINGS_KEY, clampScale, getSettings, patchSettings } from './lib/settings.js';

// ------------------------------------------------------------------ setup
chrome.runtime.onInstalled.addListener(async () => {
	chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
	chrome.contextMenus.removeAll(() => {
		chrome.contextMenus.create({ id: 'cp-read-selection', title: 'Read selection aloud', contexts: ['selection'] });
		chrome.contextMenus.create({ id: 'cp-read-page', title: 'Read this page aloud', contexts: ['page'] });
	});
	syncAdBlocking(await getSettings());
	// Pages that were already open don't have the content script yet.
	for (const tab of await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] })) injectContent(tab.id);
});

chrome.storage.onChanged.addListener((changes, area) => {
	if (area === 'local' && changes[SETTINGS_KEY]) syncAdBlocking(changes[SETTINGS_KEY].newValue || {});
});

// The static "ads" ruleset blocks known ad networks. Paused sites get an
// allowAllRequests rule so nothing is blocked on them.
async function syncAdBlocking(s) {
	try {
		await chrome.declarativeNetRequest.updateEnabledRulesets(
			s.noAds ? { enableRulesetIds: ['ads'] } : { disableRulesetIds: ['ads'] }
		);
		const paused = (s.paused || []).filter(Boolean);
		await chrome.declarativeNetRequest.updateDynamicRules({
			removeRuleIds: [1],
			addRules: paused.length
				? [
						{
							id: 1,
							priority: 100,
							action: { type: 'allowAllRequests' },
							condition: { requestDomains: paused, resourceTypes: ['main_frame', 'sub_frame'] }
						}
					]
				: []
		});
	} catch (e) {
		console.warn('ClearPage: ad rules', e);
	}
}

async function injectContent(tabId) {
	try {
		await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
		await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
		return true;
	} catch {
		return false; // chrome:// pages, the Web Store, etc.
	}
}

/** Sends a message to the page, injecting the content script first if needed. */
async function toTab(tabId, msg) {
	try {
		return await chrome.tabs.sendMessage(tabId, msg);
	} catch {
		if (!(await injectContent(tabId))) return undefined;
		return chrome.tabs.sendMessage(tabId, msg).catch(() => undefined);
	}
}

const activeTab = async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];

// ------------------------------------------------------------- read aloud
// Chunks come from the content script (~1-2 sentences each). Each chunk is one
// utterance; its TTS events drive highlighting and move on to the next chunk.
const reader = { tabId: null, chunks: [], lang: '', i: 0, state: 'idle', gen: 0 };

function broadcast() {
	const { state, i, chunks, tabId } = reader;
	chrome.runtime.sendMessage({ type: 'tts:state', state, i, n: chunks.length, tabId }).catch(() => {});
}

async function startReading(tabId, mode = 'auto', selector = '') {
	stopReading();
	const res = await toTab(tabId, { type: 'cp:read-prepare', mode, selector });
	if (!res) return say("This page can't be read aloud.");
	if (!res.chunks.length) return say('There is no text to read here.');
	Object.assign(reader, { tabId, chunks: res.chunks, lang: res.lang, i: 0, state: 'playing' });
	speakCurrent();
}

async function speakCurrent() {
	const gen = ++reader.gen;
	const { ttsRate, ttsVoice } = await getSettings();
	if (gen !== reader.gen) return;
	const { tabId, i } = reader;
	const text = reader.chunks[i];
	chrome.tabs.sendMessage(tabId, { type: 'cp:highlight', i }).catch(() => {});
	const options = {
		rate: ttsRate || 1,
		enqueue: false,
		onEvent(ev) {
			if (gen !== reader.gen) return;
			if (ev.type === 'word') {
				const length = ev.length || (text.slice(ev.charIndex).match(/^\S+/)?.[0].length ?? 1);
				chrome.tabs.sendMessage(tabId, { type: 'cp:highlight', i, start: ev.charIndex, length }).catch(() => {});
			} else if (ev.type === 'end') {
				if (reader.i < reader.chunks.length - 1) {
					reader.i++;
					speakCurrent();
				} else stopReading();
			} else if (ev.type === 'error') {
				stopReading();
			}
		}
	};
	if (ttsVoice) options.voiceName = ttsVoice;
	else if (reader.lang) options.lang = reader.lang;
	chrome.tts.speak(text, options);
	broadcast();
}

function stopReading() {
	const wasActive = reader.state !== 'idle';
	reader.gen++;
	chrome.tts.stop();
	if (reader.tabId != null) chrome.tabs.sendMessage(reader.tabId, { type: 'cp:highlight-clear' }).catch(() => {});
	Object.assign(reader, { state: 'idle', chunks: [], i: 0 });
	if (wasActive) broadcast();
}

function pauseReading() {
	if (reader.state !== 'playing') return;
	chrome.tts.pause();
	reader.state = 'paused';
	broadcast();
}

function resumeReading() {
	if (reader.state !== 'paused') return;
	chrome.tts.resume();
	reader.state = 'playing';
	broadcast();
}

function skip(delta) {
	if (reader.state === 'idle') return;
	reader.i = Math.max(0, Math.min(reader.chunks.length - 1, reader.i + delta));
	reader.state = 'playing';
	speakCurrent();
}

async function toggleReading(tabId) {
	if (reader.state === 'playing') pauseReading();
	else if (reader.state === 'paused') resumeReading();
	else if (tabId != null) startReading(tabId);
}

// Short spoken message (errors, chat replies), only when not already reading.
async function say(text) {
	if (reader.state !== 'idle') return;
	const { ttsRate, ttsVoice } = await getSettings();
	chrome.tts.speak(text, { rate: ttsRate || 1, ...(ttsVoice ? { voiceName: ttsVoice } : {}) });
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
	if (tabId === reader.tabId && info.status === 'loading') stopReading();
});
chrome.tabs.onRemoved.addListener((tabId) => {
	if (tabId === reader.tabId) stopReading();
});

// ------------------------------------------------------ shortcuts + menus
chrome.commands.onCommand.addListener(async (command, tab) => {
	tab ||= await activeTab();
	if (command === 'read-aloud') toggleReading(tab?.id);
	else if (command === 'stop-reading') stopReading();
	else if (command === 'text-bigger' || command === 'text-smaller') {
		const s = await getSettings();
		const fontScale = clampScale(s.fontScale + (command === 'text-bigger' ? 0.25 : -0.25));
		await patchSettings({ fontScale });
		if (tab?.id != null) toTab(tab.id, { type: 'cp:toast', text: `Text size ${Math.round(fontScale * 100)}%` });
	}
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
	if (!tab?.id) return;
	if (info.menuItemId === 'cp-read-selection') startReading(tab.id, 'selection');
	else if (info.menuItemId === 'cp-read-page') startReading(tab.id, 'page');
});

// -------------------------------------------------------------- messages
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
	// Only extension pages (the side panel) may drive the background; never web pages.
	if (!sender.url?.startsWith(chrome.runtime.getURL(''))) return;
	switch (msg.type) {
		case 'tts:start':
			startReading(msg.tabId, msg.mode, msg.selector);
			break;
		case 'tts:toggle':
			toggleReading(msg.tabId);
			break;
		case 'tts:stop':
			stopReading();
			break;
		case 'tts:skip':
			skip(msg.delta);
			break;
		case 'tts:say':
			say(msg.text);
			break;
		case 'tts:get':
			reply({ state: reader.state, i: reader.i, n: reader.chunks.length, tabId: reader.tabId });
			break;
		case 'tab:send':
			toTab(msg.tabId, msg.msg).then(reply);
			return true; // async reply
	}
});
