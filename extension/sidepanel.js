import {
	SETTINGS_KEY,
	AI_KEY,
	siteKey,
	clampScale,
	getSettings,
	patchSettings,
	getAi,
	patchAi,
	getSite,
	setSite
} from './lib/settings.js';
import { parseIntent } from './lib/intents.js';
import { hardenCss } from './lib/css-safety.js';
import { MODELS, AiError, askClaude, askBuiltin, builtinAvailability, buildUserMessage } from './lib/ai.js';

const $ = (id) => document.getElementById(id);

let settings = await getSettings();
let ai = await getAi();
let tab = { id: null, host: '', ok: false };
let site = { rules: [] };
let picked = null;
let busy = false;
const histories = new Map(); // host -> [{user, assistant}] (text only, for follow-ups)
const windowId = (await chrome.windows.getCurrent()).id;

// ------------------------------------------------------------- active tab
async function loadTab() {
	const [t] = await chrome.tabs.query({ active: true, windowId });
	let host = '';
	let ok = false;
	try {
		const url = new URL(t?.url || '');
		ok = url.protocol === 'http:' || url.protocol === 'https:';
		host = url.hostname;
	} catch {}
	const changedHost = host !== tab.host;
	tab = { id: t?.id ?? null, host, ok };
	if (changedHost) setPicked(null);
	site = ok ? await getSite(host) : { rules: [] };
	$('site').textContent = ok ? host : 'No website open';
	$('unsupported').hidden = ok;
	$('controls').hidden = !ok;
	$('pause-wrap').hidden = !ok;
	renderSettings();
	renderRules();
}

chrome.tabs.onActivated.addListener((info) => info.windowId === windowId && loadTab());
chrome.tabs.onUpdated.addListener((id, info) => id === tab.id && (info.url || info.status === 'complete') && loadTab());

/** Message the page's content script (the background injects it if missing). */
async function sendTab(msg) {
	if (tab.id == null) return undefined;
	try {
		return await chrome.tabs.sendMessage(tab.id, msg);
	} catch {
		return chrome.runtime.sendMessage({ type: 'tab:send', tabId: tab.id, msg });
	}
}

// --------------------------------------------------------------- settings
chrome.storage.onChanged.addListener(async (changes, area) => {
	if (area !== 'local') return;
	if (changes[SETTINGS_KEY]) {
		settings = await getSettings();
		renderSettings();
	}
	if (changes[AI_KEY]) {
		ai = await getAi();
		renderSpend();
	}
	if (tab.ok && changes[siteKey(tab.host)]) {
		site = await getSite(tab.host);
		renderRules();
	}
});

function renderSettings() {
	const pct = Math.round(settings.fontScale * 100);
	if (document.activeElement !== $('fs')) $('fs').value = pct;
	$('fs').setAttribute('aria-valuetext', pct + '%');
	$('fs-value').textContent = pct + '%';
	for (const btn of document.querySelectorAll('.toggle')) {
		btn.setAttribute('aria-pressed', String(!!settings[btn.dataset.setting]));
	}
	for (const r of document.querySelectorAll('input[name="theme"]')) r.checked = r.value === settings.theme;
	$('pause').checked = settings.paused.includes(tab.host);
	$('rate').value = settings.ttsRate;
	$('rate-value').textContent = Number(settings.ttsRate).toFixed(1) + '×';
	$('voice').value = settings.ttsVoice;
}

let fontTimer = 0;
$('fs').addEventListener('input', (e) => {
	const pct = Number(e.target.value);
	$('fs-value').textContent = pct + '%';
	clearTimeout(fontTimer);
	fontTimer = setTimeout(() => patchSettings({ fontScale: clampScale(pct / 100) }), 60);
});
const stepFont = (d) => patchSettings({ fontScale: clampScale(settings.fontScale + d) });
$('fs-up').addEventListener('click', () => stepFont(0.25));
$('fs-down').addEventListener('click', () => stepFont(-0.25));

for (const btn of document.querySelectorAll('.toggle')) {
	btn.addEventListener('click', () => patchSettings({ [btn.dataset.setting]: !settings[btn.dataset.setting] }));
}
for (const r of document.querySelectorAll('input[name="theme"]')) {
	r.addEventListener('change', () => patchSettings({ theme: r.value, noBg: true }));
}
$('pause').addEventListener('change', (e) => {
	const paused = settings.paused.filter((h) => h !== tab.host);
	if (e.target.checked) paused.push(tab.host);
	patchSettings({ paused });
});

// ------------------------------------------------------------- read aloud
const tts = { state: 'idle', i: 0, n: 0 };

function renderTts() {
	const active = tts.state !== 'idle';
	$('tts-play').textContent = tts.state === 'playing' ? '⏸ Pause' : tts.state === 'paused' ? '▶ Resume' : '▶ Read page';
	for (const id of ['tts-prev', 'tts-next', 'tts-stop']) $(id).disabled = !active;
	$('tts-status').textContent = active
		? `${tts.state === 'paused' ? 'Paused at' : 'Reading'} part ${tts.i + 1} of ${tts.n}.`
		: 'Select text first to read only that part.';
}

$('tts-play').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'tts:toggle', tabId: tab.id }));
$('tts-stop').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'tts:stop' }));
$('tts-prev').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'tts:skip', delta: -1 }));
$('tts-next').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'tts:skip', delta: 1 }));

$('rate').addEventListener('input', (e) => {
	$('rate-value').textContent = Number(e.target.value).toFixed(1) + '×';
});
$('rate').addEventListener('change', (e) => patchSettings({ ttsRate: Number(e.target.value) }));
$('voice').addEventListener('change', (e) => patchSettings({ ttsVoice: e.target.value }));

chrome.tts.getVoices((voices) => {
	const lang = navigator.language.slice(0, 2);
	voices
		.filter((v) => v.voiceName)
		.sort((a, b) => (b.lang || '').startsWith(lang) - (a.lang || '').startsWith(lang) || a.voiceName.localeCompare(b.voiceName))
		.forEach((v) => $('voice').append(new Option(`${v.voiceName}${v.lang ? ` (${v.lang})` : ''}`, v.voiceName)));
	$('voice').value = settings.ttsVoice;
});

// ------------------------------------------------------------------ chat
const log = $('log');

function addMsg(kind, text) {
	const p = document.createElement('p');
	p.className = 'msg ' + kind;
	p.textContent = text;
	log.append(p);
	log.scrollTop = log.scrollHeight;
	return p;
}

function addMeta(p, text, undoRuleId) {
	const meta = document.createElement('span');
	meta.className = 'meta';
	meta.textContent = text;
	if (undoRuleId) {
		const undo = document.createElement('button');
		undo.type = 'button';
		undo.textContent = 'Undo';
		undo.addEventListener('click', async () => {
			await removeRule(undoRuleId);
			undo.disabled = true;
			undo.textContent = 'Undone';
		});
		meta.append(undo);
	}
	p.append(meta);
}

function speakReply(text) {
	if (ai.speakReplies) chrome.runtime.sendMessage({ type: 'tts:say', text });
}

const formatCost = (usd) => (usd === 0 ? 'free' : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(3)}`);

async function runLocal(cmd) {
	if (cmd.settings) await patchSettings(cmd.settings);
	if (cmd.fontDelta) await stepFont(cmd.fontDelta);
	if (cmd.action === 'read') chrome.runtime.sendMessage({ type: 'tts:start', tabId: tab.id, mode: 'auto' });
	if (cmd.action === 'stop') chrome.runtime.sendMessage({ type: 'tts:stop' });
	if (cmd.action === 'undo') {
		const last = site.rules.at(-1);
		if (!last) return 'There are no custom changes to undo on this site.';
		await removeRule(last.id);
	}
	if (cmd.action === 'clear') await setSite(tab.host, { ...site, rules: [] });
	return cmd.reply;
}

async function resolveProvider() {
	if (ai.provider === 'claude') return ai.apiKey ? 'claude' : null;
	if (ai.provider === 'builtin') return 'builtin';
	if (ai.apiKey) return 'claude';
	// Automatic mode never triggers the multi-GB model download; choosing it explicitly does.
	return (await builtinAvailability()) === 'available' ? 'builtin' : null;
}

async function ask(provider, history, userMessage, pending) {
	if (provider === 'claude') return askClaude({ apiKey: ai.apiKey, model: ai.model, history, userMessage });
	return askBuiltin({
		history,
		userMessage,
		onDownload: (f) => (pending.textContent = `Downloading Chrome's AI model… ${Math.round(f * 100)}%`)
	});
}

function tryHarden(css) {
	if (!css.trim()) return { hardened: null, error: '' };
	try {
		return { hardened: hardenCss(css), error: '' };
	} catch (e) {
		return { hardened: null, error: e.message };
	}
}

const SETTING_MAP = { removeBackgrounds: 'noBg', removeImages: 'noImages', removeAds: 'noAds', theme: 'theme', fontScale: 'fontScale' };

async function chat(text) {
	addMsg('user', text);

	const local = parseIntent(text);
	if (local) {
		const reply = await runLocal(local);
		addMeta(addMsg('bot', reply), 'Done instantly · free');
		speakReply(reply);
		return;
	}

	const provider = await resolveProvider();
	if (!provider) {
		addMsg(
			'bot error',
			"Custom changes need an AI. Add a Claude API key in Settings below, or choose Chrome's built-in AI if your device supports it."
		);
		$('settings').open = true;
		$('api-key').focus();
		return;
	}

	busy = true;
	$('send').disabled = true;
	log.setAttribute('aria-busy', 'true');
	const pending = addMsg('bot pending', 'Working on it…');
	try {
		const page = await sendTab({ type: 'cp:outline', usePicked: !!picked });
		if (!page) throw new AiError("I can't read this page. Try reloading it.");
		const currentCss = site.rules.map((r) => r.css).join('\n');
		const history = (histories.get(tab.host) || []).slice(-3);

		let { result, usage, cost } = await ask(provider, history, buildUserMessage({ page, currentCss, request: text }), pending);
		let tokens = usage ? usage.input_tokens + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + usage.output_tokens : 0;
		let { hardened, error } = tryHarden(result.css);

		// If none of the new selectors match anything, give the model one retry with that feedback.
		if (hardened?.selectors.length) {
			const counts = await sendTab({ type: 'cp:count', selectors: hardened.selectors });
			if (Array.isArray(counts) && counts.every((c) => c === 0)) {
				pending.textContent = 'Looking more closely…';
				const feedback = `Your selectors matched nothing on this page: ${hardened.selectors.slice(0, 8).join(' | ')}. Use selectors that exist in the outline, or say you couldn't find it.`;
				const second = await ask(provider, history, buildUserMessage({ page, currentCss, request: text, feedback }), pending);
				({ result } = second);
				cost += second.cost;
				if (second.usage) tokens += second.usage.input_tokens + (second.usage.cache_read_input_tokens || 0) + second.usage.output_tokens;
				({ hardened, error } = tryHarden(result.css));
			}
		}

		// Apply: custom CSS (saved per site), built-in switches, read-aloud target.
		let ruleId = null;
		if (hardened?.css) {
			const rule = { id: crypto.randomUUID(), prompt: text, css: hardened.css, ts: Date.now() };
			ruleId = rule.id;
			site = { ...site, rules: result.replaceExisting ? [rule] : [...site.rules, rule] };
			await setSite(tab.host, site);
		} else if (result.replaceExisting && !result.css.trim()) {
			site = { ...site, rules: [] };
			await setSite(tab.host, site);
		}
		const patch = {};
		for (const [from, to] of Object.entries(SETTING_MAP)) {
			const v = result.settings[from];
			if (v !== null && v !== undefined) patch[to] = to === 'fontScale' ? clampScale(v) : v;
		}
		if (patch.theme && patch.noBg === undefined) patch.noBg = true;
		if (Object.keys(patch).length) await patchSettings(patch);
		if (result.read) chrome.runtime.sendMessage({ type: 'tts:start', tabId: tab.id, mode: 'page', selector: result.read });

		histories.set(tab.host, [
			...history,
			{ user: `REQUEST: ${text}`, assistant: JSON.stringify({ reply: result.reply, css: hardened?.css || '' }) }
		]);
		if (provider === 'claude') await patchAi({ spent: ai.spent + cost, requests: ai.requests + 1 });

		let reply = result.reply;
		if (error) reply += ` (I skipped part of the change: ${error})`;
		pending.className = 'msg bot';
		pending.textContent = reply;
		const label = provider === 'claude' ? MODELS[ai.model]?.label.split(' (')[0] : 'Chrome built-in AI';
		addMeta(pending, `${label}${tokens ? ` · ${tokens.toLocaleString()} tokens` : ''} · ${formatCost(cost)}`, ruleId);
		speakReply(reply);
	} catch (e) {
		pending.className = 'msg bot error';
		pending.textContent = e instanceof AiError ? e.message : `Something went wrong: ${e.message}`;
	} finally {
		busy = false;
		$('send').disabled = false;
		log.removeAttribute('aria-busy');
		log.scrollTop = log.scrollHeight;
	}
}

$('chat-form').addEventListener('submit', (e) => {
	e.preventDefault();
	const text = $('chat-input').value.trim();
	if (!text || busy) return;
	$('chat-input').value = '';
	chat(text);
});
$('chat-input').addEventListener('keydown', (e) => {
	if (e.key === 'Enter' && !e.shiftKey) {
		e.preventDefault();
		$('chat-form').requestSubmit();
	}
});
for (const chip of document.querySelectorAll('.chip')) {
	chip.addEventListener('click', () => !busy && chat(chip.textContent));
}

// ----------------------------------------------------------------- picker
function setPicked(p) {
	picked = p;
	$('picked').hidden = !p;
	$('picked-name').textContent = p ? p.short : '';
	$('pick').setAttribute('aria-pressed', 'false');
}

$('pick').addEventListener('click', async () => {
	const picking = $('pick').getAttribute('aria-pressed') === 'true';
	$('pick').setAttribute('aria-pressed', String(!picking));
	await sendTab({ type: picking ? 'cp:pick-cancel' : 'cp:pick-start' });
});
$('picked-clear').addEventListener('click', () => {
	sendTab({ type: 'cp:pick-cancel' });
	setPicked(null);
});

chrome.runtime.onMessage.addListener((msg, sender) => {
	if (msg.type === 'cp:picked' && sender.tab?.id === tab.id) {
		setPicked(msg.picked);
		if (msg.picked) $('chat-input').focus();
	} else if (msg.type === 'tts:state') {
		Object.assign(tts, msg);
		renderTts();
	}
});

// ------------------------------------------------------------ saved rules
async function removeRule(id) {
	site = { ...site, rules: site.rules.filter((r) => r.id !== id) };
	await setSite(tab.host, site);
}

function renderRules() {
	const ul = $('rules');
	ul.replaceChildren(
		...site.rules.map((rule) => {
			const li = document.createElement('li');
			const label = document.createElement('span');
			label.textContent = rule.prompt;
			label.title = rule.css;
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.textContent = 'Remove';
			btn.setAttribute('aria-label', `Remove change: ${rule.prompt}`);
			btn.addEventListener('click', () => removeRule(rule.id));
			li.append(label, btn);
			return li;
		})
	);
	$('rules-empty').hidden = site.rules.length > 0;
	$('rules-clear').hidden = site.rules.length === 0;
}
$('rules-clear').addEventListener('click', () => setSite(tab.host, { ...site, rules: [] }));

// ------------------------------------------------------------ AI settings
for (const [id, m] of Object.entries(MODELS)) $('model').append(new Option(m.label, id));
$('provider').value = ai.provider;
$('model').value = ai.model;
$('api-key').value = ai.apiKey;
$('speak-replies').checked = ai.speakReplies;

$('provider').addEventListener('change', (e) => {
	patchAi({ provider: e.target.value });
	renderBuiltinStatus();
});
$('model').addEventListener('change', (e) => patchAi({ model: e.target.value }));
$('api-key').addEventListener('change', (e) => patchAi({ apiKey: e.target.value.trim() }));
$('speak-replies').addEventListener('change', (e) => patchAi({ speakReplies: e.target.checked }));

function renderSpend() {
	$('spend').textContent = ai.requests
		? `Claude usage from this browser: ${formatCost(ai.spent)} over ${ai.requests} request${ai.requests === 1 ? '' : 's'}.`
		: 'Built-in commands (text size, dark mode, read aloud…) never use the AI and are always free.';
}

async function renderBuiltinStatus() {
	const status = await builtinAvailability();
	$('builtin-status').textContent = {
		available: "Chrome's built-in AI is ready on this device.",
		downloadable: "Chrome's built-in AI can be used; the model downloads on first use.",
		downloading: "Chrome's built-in AI model is downloading.",
		unavailable: "Chrome's built-in AI isn't available on this device."
	}[status];
}

// ---------------------------------------------------------------- startup
await loadTab();
renderSpend();
renderBuiltinStatus();
chrome.runtime.sendMessage({ type: 'tts:get' }).then((s) => {
	if (s) Object.assign(tts, s);
	renderTts();
});
