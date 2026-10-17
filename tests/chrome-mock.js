// Minimal in-memory stand-in for the chrome.* APIs used by ClearPage, so the real
// content script and libraries can run in an ordinary (headless) page.
// Initial storage can be passed in the URL: ?settings={...}&site={...}
(() => {
	const params = new URLSearchParams(location.search);
	const store = {};
	if (params.get('settings')) store['cp:settings'] = JSON.parse(params.get('settings'));
	if (params.get('site')) store['cp:site:' + location.hostname] = JSON.parse(params.get('site'));

	const changeListeners = [];
	const messageListeners = [];
	const event = (list) => ({ addListener: (fn) => list.push(fn) });

	window.__sentMessages = [];
	window.chrome = {
		storage: {
			local: {
				async get(keys) {
					const out = {};
					for (const k of [].concat(keys)) if (k in store) out[k] = structuredClone(store[k]);
					return out;
				},
				async set(items) {
					const changes = {};
					for (const [k, v] of Object.entries(items)) {
						changes[k] = { oldValue: store[k], newValue: structuredClone(v) };
						store[k] = structuredClone(v);
					}
					changeListeners.forEach((fn) => fn(changes, 'local'));
				}
			},
			onChanged: event(changeListeners)
		},
		runtime: {
			onMessage: event(messageListeners),
			async sendMessage(msg) {
				window.__sentMessages.push(msg);
			}
		}
	};

	/** Delivers a message to the content script like chrome.tabs.sendMessage would. */
	window.__cpSend = (msg) =>
		new Promise((resolve) => {
			let replied = false;
			for (const fn of messageListeners) fn(msg, {}, (r) => ((replied = true), resolve(r)));
			if (!replied) resolve(undefined);
		});
})();
