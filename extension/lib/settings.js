// Storage layout (all in chrome.storage.local):
//   cp:settings      page-view + read-aloud preferences, read by every content script
//   cp:ai            AI provider, model, API key and spend counters (extension pages only)
//   cp:site:<host>   custom CSS rules created through the chat for one site

export const SETTINGS_KEY = 'cp:settings';
export const AI_KEY = 'cp:ai';
export const siteKey = (host) => 'cp:site:' + host;

// Keep in sync with DEFAULTS in content.js (content scripts can't import modules).
export const DEFAULT_SETTINGS = {
	fontScale: 1,
	noBg: false,
	theme: 'light',
	noImages: false,
	noAds: false,
	paused: [],
	ttsRate: 1,
	ttsVoice: ''
};

export const DEFAULT_AI = {
	provider: 'auto',
	model: 'claude-haiku-5-5',
	apiKey: '',
	speakReplies: false,
	spent: 0,
	requests: 0
};

export const THEMES = ['light', 'dark', 'sepia', 'contrast'];
export const MIN_SCALE = 1;
export const MAX_SCALE = 3;

export const clampScale = (v) =>
	Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(v) || 1)) * 100) / 100;

async function read(key, defaults) {
	const r = await chrome.storage.local.get(key);
	return { ...defaults, ...r[key] };
}

// Writes are chained so two quick patches (e.g. a slider drag) never overwrite each other.
let chain = Promise.resolve();
function patch(key, defaults, changes) {
	chain = chain.then(async () => {
		const next = { ...(await read(key, defaults)), ...changes };
		await chrome.storage.local.set({ [key]: next });
		return next;
	});
	return chain;
}

export const getSettings = () => read(SETTINGS_KEY, DEFAULT_SETTINGS);
export const patchSettings = (changes) => patch(SETTINGS_KEY, DEFAULT_SETTINGS, changes);
export const getAi = () => read(AI_KEY, DEFAULT_AI);
export const patchAi = (changes) => patch(AI_KEY, DEFAULT_AI, changes);

export async function getSite(host) {
	const r = await chrome.storage.local.get(siteKey(host));
	return { rules: [], ...r[siteKey(host)] };
}
export const setSite = (host, site) => chrome.storage.local.set({ [siteKey(host)]: site });
