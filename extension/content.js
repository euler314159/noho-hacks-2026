// ClearPage content script. Runs at document_start in every http(s) page.
// Startup work is tiny (one storage read + a few attributes on <html>); the heavier
// pieces (text measuring, outline, read-aloud chunking, picker) only run when used.
(() => {
	if (window.__clearpage) return;
	window.__clearpage = true;

	// Keep in sync with DEFAULT_SETTINGS in lib/settings.js.
	const DEFAULTS = { fontScale: 1, noBg: false, theme: 'light', noImages: false, noAds: false, paused: [] };
	const SETTINGS_KEY = 'cp:settings';
	const host = location.hostname;
	const SITE_KEY = 'cp:site:' + host;
	const root = document.documentElement;

	let settings = { ...DEFAULTS };
	let site = { rules: [] };
	let enabled = true;

	// Two <style> elements we own: one for the scale variable, one for chat-made CSS.
	// Inserted by the content script, so they are not subject to the page's CSP.
	const varsStyle = document.createElement('style');
	const customStyle = document.createElement('style');
	varsStyle.id = 'clearpage-vars';
	customStyle.id = 'clearpage-custom';

	chrome.storage.local.get([SETTINGS_KEY, SITE_KEY]).then((r) => {
		settings = { ...DEFAULTS, ...r[SETTINGS_KEY] };
		site = { rules: [], ...r[SITE_KEY] };
		apply();
	});

	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== 'local') return;
		if (changes[SETTINGS_KEY]) settings = { ...DEFAULTS, ...changes[SETTINGS_KEY].newValue };
		if (changes[SITE_KEY]) site = { rules: [], ...changes[SITE_KEY].newValue };
		if (changes[SETTINGS_KEY] || changes[SITE_KEY]) apply();
	});

	function toggleAttr(name, on, value = '') {
		if (on) root.setAttribute(name, value);
		else root.removeAttribute(name);
	}

	function apply() {
		enabled = !settings.paused.includes(host);
		const fontOn = enabled && settings.fontScale !== 1;
		toggleAttr('data-cp-nobg', enabled && settings.noBg);
		toggleAttr('data-cp-theme', enabled && settings.noBg, settings.theme);
		toggleAttr('data-cp-noimg', enabled && settings.noImages);
		toggleAttr('data-cp-noads', enabled && settings.noAds);
		toggleAttr('data-cp-fs', fontOn);
		varsStyle.textContent = `:root{--cp-scale:${Number(settings.fontScale) || 1}}`;
		customStyle.textContent = enabled ? site.rules.map((r) => r.css).join('\n') : '';
		if (!varsStyle.isConnected) root.append(varsStyle);
		if (!customStyle.isConnected) root.append(customStyle);
		whenReady(() => {
			if (fontOn) measureText([document.body]);
			if (enabled && settings.noImages) labelImages(document.body);
			updateObserver();
		});
	}

	function whenReady(fn) {
		if (document.body && document.readyState !== 'loading') fn();
		else document.addEventListener('DOMContentLoaded', fn, { once: true });
	}

	// ---------------------------------------------------------------- text size
	const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'svg', 'SVG']);
	const isOurs = (el) => el.tagName.startsWith('CP-');

	// Finds elements that directly contain visible text (plus form controls), skipping
	// ones already measured. Only these need a font size; containers inherit nothing we set.
	function textElements(scopes) {
		const out = new Set();
		for (const scope of scopes) {
			if (!scope || !scope.isConnected) continue;
			const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
			for (let n = walker.nextNode(); n; n = walker.nextNode()) {
				const p = n.parentElement;
				if (!p || out.has(p) || p.hasAttribute('data-cp-f') || SKIP_TAGS.has(p.tagName) || isOurs(p)) continue;
				if (/\S/.test(n.data)) out.add(p);
			}
			if (scope.querySelectorAll) {
				for (const el of scope.querySelectorAll('input, textarea, select, button')) {
					if (!el.hasAttribute('data-cp-f')) out.add(el);
				}
			}
			if (out.size > 40000) break;
		}
		return out;
	}

	// Records each element's *original* size. Our override is switched off for the
	// duration of the reads so new elements are never measured at an already-scaled size.
	// All reads happen before all writes, so this costs one style recalculation.
	function measureText(scopes) {
		const els = [...textElements(scopes)];
		if (!els.length) return;
		const wasOn = root.hasAttribute('data-cp-fs');
		if (wasOn) root.removeAttribute('data-cp-fs');
		const sizes = els.map((el) => {
			const cs = getComputedStyle(el);
			return [parseFloat(cs.fontSize), cs.lineHeight];
		});
		if (wasOn) root.setAttribute('data-cp-fs', '');
		els.forEach((el, i) => {
			const [fs, lh] = sizes[i];
			if (fs > 0) el.setAttribute('data-cp-f', Math.round(fs * 10) / 10);
			if (lh.endsWith('px')) el.setAttribute('data-cp-lh', Math.round(parseFloat(lh) * 10) / 10);
		});
	}

	// ------------------------------------------------------------ image labels
	const labelled = new WeakSet();
	function labelImages(scope) {
		if (!scope?.querySelectorAll) return;
		const imgs = scope.tagName === 'IMG' ? [scope] : scope.querySelectorAll('img[alt]');
		for (const img of imgs) {
			const alt = (img.getAttribute('alt') || '').trim();
			if (alt.length < 2 || labelled.has(img)) continue;
			labelled.add(img);
			const label = document.createElement('cp-alt');
			label.textContent = 'Image: ' + alt.slice(0, 200);
			const anchor = img.parentElement?.tagName === 'PICTURE' ? img.parentElement : img;
			anchor.before(label);
		}
	}

	// ------------------------------------------------- dynamic content (feeds, SPAs)
	let observer = null;
	const pending = new Set();
	let flushTimer = 0;

	function updateObserver() {
		const needed = enabled && (settings.fontScale !== 1 || settings.noImages);
		if (needed && !observer) {
			observer = new MutationObserver(onMutations);
			observer.observe(document.body || root, { childList: true, subtree: true });
		} else if (!needed && observer) {
			observer.disconnect();
			observer = null;
			pending.clear();
		}
	}

	function onMutations(list) {
		for (const m of list) {
			for (const n of m.addedNodes) {
				if (n.nodeType === 1 && !isOurs(n)) pending.add(n);
				else if (n.nodeType === 3 && n.parentElement) pending.add(n.parentElement);
			}
		}
		// Batched: at most one measuring pass every 250 ms, however busy the page is.
		if (pending.size && !flushTimer) flushTimer = setTimeout(flush, 250);
	}

	function flush() {
		flushTimer = 0;
		const scopes = [...pending];
		pending.clear();
		if (!enabled) return;
		if (settings.fontScale !== 1) measureText(scopes);
		if (settings.noImages) scopes.forEach(labelImages);
	}

	// ------------------------------------------------------------ selectors
	const looksGenerated = (s) =>
		/^(css|sc|jsx|emotion|styled|svelte)-/i.test(s) ||
		/^_/.test(s) ||
		(/\d/.test(s) && /[a-z]/i.test(s) && s.length > 6 && /\d[a-z]|[a-z]\d/i.test(s) && !/-\d+$/.test(s));

	// Short, human-readable selector for one element (not necessarily unique).
	function shortSelector(el) {
		const tag = el.tagName.toLowerCase();
		if (el.id && /^[a-z][\w-]{0,40}$/i.test(el.id) && !looksGenerated(el.id)) return '#' + CSS.escape(el.id);
		const classes = [...el.classList].filter((c) => /^[a-z][\w-]{1,32}$/i.test(c) && !looksGenerated(c)).slice(0, 2);
		if (classes.length) return tag + classes.map((c) => '.' + CSS.escape(c)).join('');
		const role = el.getAttribute('role');
		if (role) return `${tag}[role="${role}"]`;
		const label = el.getAttribute('aria-label');
		if (label && label.length < 40) return `${tag}[aria-label="${label.replace(/"/g, '\\"')}"]`;
		return tag;
	}

	function count(sel) {
		try {
			return document.querySelectorAll(sel).length;
		} catch {
			return -1;
		}
	}

	// Unique selector path, e.g. `#main > div.post:nth-of-type(2) > h2`.
	function uniqueSelector(el) {
		const parts = [];
		for (let cur = el; cur && cur !== root && parts.length < 6; cur = cur.parentElement) {
			let part = shortSelector(cur);
			if (!part.startsWith('#')) {
				const same = cur.parentElement ? [...cur.parentElement.children].filter((c) => c.tagName === cur.tagName) : [];
				if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
			}
			parts.unshift(part);
			const sel = parts.join(' > ');
			if (count(sel) === 1) return sel;
		}
		return parts.join(' > ');
	}

	const clip = (s, n) => {
		s = s.replace(/\s+/g, ' ').trim();
		return s.length > n ? s.slice(0, n - 1) + '…' : s;
	};

	// ---------------------------------------------------------------- outline
	// A compact, token-cheap map of the page for the AI: landmarks, headings, overlays
	// and big blocks with selectors, flags and a short text snippet. Repeated siblings
	// (cards, list items) are collapsed into "+N more".
	const LANDMARKS = new Set([
		'HEADER', 'NAV', 'MAIN', 'ASIDE', 'FOOTER', 'SECTION', 'ARTICLE', 'FORM', 'DIALOG',
		'H1', 'H2', 'H3', 'H4', 'TABLE', 'UL', 'OL', 'IFRAME', 'VIDEO', 'IMG', 'FIGURE'
	]);
	const OUTLINE_SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'BR', 'svg', 'SVG', 'PATH']);

	function buildOutline(maxLines = 130) {
		const lines = [];
		let visited = 0;
		const vw = innerWidth;

		function describe(el, cs, depth) {
			const sel = shortSelector(el);
			let line = '  '.repeat(depth) + sel;
			const n = count(sel);
			if (n > 1) line += ` ×${n}`;
			const role = el.getAttribute('role');
			if (role && !sel.includes('role=')) line += ` [${role}]`;
			if (cs.position === 'fixed' || cs.position === 'sticky') line += ` {${cs.position}}`;
			if (depth <= 2 || cs.position === 'fixed') {
				const r = el.getBoundingClientRect();
				line += ` @${Math.round(r.left)},${Math.round(r.top + scrollY)} ${Math.round(r.width)}x${Math.round(r.height)}`;
			}
			if (el.tagName === 'IMG') line += ` alt="${clip(el.alt || '', 40)}"`;
			else {
				const text = clip(el.textContent.slice(0, 400), /^H\d$/.test(el.tagName) ? 80 : 50);
				if (text) line += ` "${text}"`;
			}
			return line;
		}

		function walk(parent, depth) {
			let lastSig = '';
			let repeats = 0;
			const flushRepeats = () => {
				if (repeats) lines.push('  '.repeat(depth) + `(+${repeats} more like this)`);
				repeats = 0;
			};
			for (const el of parent.children) {
				if (lines.length >= maxLines || ++visited > 6000) break;
				if (OUTLINE_SKIP.has(el.tagName) || isOurs(el) || !el.checkVisibility()) continue;
				const cs = getComputedStyle(el);
				const tag = el.tagName;
				let significant = LANDMARKS.has(tag) || el.hasAttribute('role') || cs.position === 'fixed' || cs.position === 'sticky';
				if (!significant && el.id && !looksGenerated(el.id)) significant = true;
				if (!significant && depth <= 3 && el.childElementCount > 1) {
					const r = el.getBoundingClientRect();
					significant = r.width > vw * 0.25 && r.height > 120;
				}
				if (!significant) {
					walk(el, depth); // flatten anonymous wrappers
					continue;
				}
				const sig = tag + '.' + el.className;
				if (sig === lastSig) {
					repeats++;
					continue;
				}
				flushRepeats();
				lastSig = sig;
				lines.push(describe(el, cs, depth));
				if (!/^(H\d|IMG|IFRAME|VIDEO)$/.test(tag)) walk(el, depth + 1);
			}
			flushRepeats();
		}

		if (document.body) walk(document.body, 0);
		if (lines.length >= maxLines) lines.push('(outline truncated)');
		return lines.join('\n');
	}

	function describePicked(el) {
		const clone = el.cloneNode(true);
		for (const c of clone.querySelectorAll('script, style, svg')) c.remove();
		return {
			selector: uniqueSelector(el),
			short: shortSelector(el),
			html: clip(clone.outerHTML, 500)
		};
	}

	// --------------------------------------------------------------- picker
	let picked = null;
	let picker = null;

	function startPicker() {
		if (picker) return;
		const box = document.createElement('cp-pick-box');
		root.append(box);
		let current = null;
		const block = (e) => {
			e.preventDefault();
			e.stopPropagation();
		};
		const move = (e) => {
			const t = e.target;
			if (!(t instanceof Element) || t === box || t === root || t === document.body) return;
			current = t;
			const r = t.getBoundingClientRect();
			box.style.cssText = `top:${r.top}px;left:${r.left}px;width:${r.width}px;height:${r.height}px`;
			box.dataset.label = shortSelector(t);
		};
		const click = (e) => {
			block(e);
			finish(current);
		};
		const key = (e) => {
			if (e.key === 'Escape') {
				block(e);
				finish(null);
			}
		};
		const opts = { capture: true };
		const finish = (el) => {
			removeEventListener('mousemove', move, opts);
			removeEventListener('click', click, opts);
			removeEventListener('keydown', key, opts);
			for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) removeEventListener(t, block, opts);
			box.remove();
			picker = null;
			picked = el;
			chrome.runtime.sendMessage({ type: 'cp:picked', host, picked: el ? describePicked(el) : null }).catch(() => {});
		};
		addEventListener('mousemove', move, opts);
		addEventListener('click', click, opts);
		addEventListener('keydown', key, opts);
		for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) addEventListener(t, block, opts);
		picker = { finish };
		toast('Click the part of the page you want to change. Esc to cancel.');
	}

	// ------------------------------------------------------------ read aloud
	// Text is split into blocks in document order; each block keeps a per-character
	// map back to its DOM text nodes so the spoken word can be highlighted exactly.
	const BLOCK_SEL =
		'p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th,dt,dd,figcaption,caption,summary,label,' +
		'div,section,article,main,header,footer,aside,nav,form,table,ul,ol,dl,figure,details,body';
	const READ_SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'svg', 'SVG', 'BUTTON', 'SELECT', 'TEXTAREA']);
	const CHUNK_MAX = 240;
	let reader = null;

	function findMainContent() {
		const candidates = [...document.querySelectorAll('article, main, [role="main"], [itemprop="articleBody"]')].filter((el) =>
			el.checkVisibility()
		);
		const score = (el) => {
			let n = 0;
			for (const p of el.querySelectorAll('p, pre, blockquote')) n += p.textContent.length;
			return n;
		};
		const scored = candidates.map((el) => [el, score(el)]).filter(([, s]) => s > 200);
		if (scored.length) {
			const best = Math.max(...scored.map(([, s]) => s));
			// Prefer the innermost candidate that still holds most of the text.
			const good = scored.filter(([, s]) => s >= best * 0.6);
			good.sort(([a], [b]) => (a.contains(b) ? 1 : b.contains(a) ? -1 : 0));
			return good[0][0];
		}
		// No semantic markup: use the element holding the most paragraph text.
		const totals = new Map();
		for (const p of document.querySelectorAll('p')) {
			const parent = p.parentElement;
			totals.set(parent, (totals.get(parent) || 0) + p.textContent.length);
		}
		let top = null;
		let topScore = 400;
		for (const [el, s] of totals) if (s > topScore) [top, topScore] = [el, s];
		return top || document.body;
	}

	function collectSegments(scope) {
		const segments = [];
		const skipChrome = scope === document.body;
		const visible = new Map();
		const isVisible = (el) => {
			let v = visible.get(el);
			if (v === undefined) visible.set(el, (v = el.checkVisibility()));
			return v;
		};
		let seg = null;
		const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
			acceptNode(n) {
				if (n.nodeType === 3) return NodeFilter.FILTER_ACCEPT;
				if (READ_SKIP.has(n.tagName) || isOurs(n) || n.hidden || n.getAttribute('aria-hidden') === 'true') return NodeFilter.FILTER_REJECT;
				if (skipChrome && /^(NAV|FOOTER|ASIDE)$/.test(n.tagName)) return NodeFilter.FILTER_REJECT;
				return n.tagName === 'IMG' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
			}
		});
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			if (n.nodeType === 1) {
				const alt = (n.getAttribute('alt') || '').trim();
				if (alt.length > 1 && isVisible(n.parentElement || n)) {
					segments.push({ text: 'Image: ' + alt, img: n });
					seg = null;
				}
				continue;
			}
			const parent = n.parentElement;
			if (!parent || !/\S/.test(n.data) || !isVisible(parent)) continue;
			const block = parent.closest(BLOCK_SEL);
			if (!seg || seg.block !== block) {
				seg = { block, text: '', nodes: [], offs: [], space: true };
				segments.push(seg);
			}
			const d = n.data;
			for (let i = 0; i < d.length; i++) {
				let c = d[i];
				if (c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === ' ') {
					if (seg.space) continue;
					c = ' ';
					seg.space = true;
				} else seg.space = false;
				seg.text += c;
				seg.nodes.push(n);
				seg.offs.push(i);
			}
			if (segments.length > 4000) break;
		}
		return segments.filter((s) => s.text.trim());
	}

	const sentenceSplitter = new Intl.Segmenter(undefined, { granularity: 'sentence' });

	// Splits each block into chunks of at most ~CHUNK_MAX characters on sentence
	// boundaries. Short utterances keep the service worker alive between TTS events
	// and avoid voices that stop after ~15 seconds.
	function chunkSegments(segments) {
		const chunks = [];
		const push = (seg, start, end) => {
			while (start < end && seg.text[start] === ' ') start++;
			while (end > start && seg.text[end - 1] === ' ') end--;
			if (end > start) chunks.push({ seg, start, end, text: seg.text.slice(start, end) });
		};
		for (const seg of segments) {
			if (seg.img) {
				chunks.push({ seg, start: 0, end: seg.text.length, text: seg.text });
				continue;
			}
			if (seg.text.length <= CHUNK_MAX) {
				push(seg, 0, seg.text.length);
				continue;
			}
			let start = 0;
			let end = 0;
			for (const { index, segment } of sentenceSplitter.segment(seg.text)) {
				const sEnd = index + segment.length;
				if (sEnd - start > CHUNK_MAX && end > start) {
					push(seg, start, end);
					start = end;
				}
				// A single very long sentence: break it at spaces.
				while (sEnd - start > CHUNK_MAX * 1.6) {
					const cut = seg.text.lastIndexOf(' ', start + CHUNK_MAX);
					const at = cut > start ? cut : start + CHUNK_MAX;
					push(seg, start, at);
					start = at;
				}
				end = sEnd;
			}
			push(seg, start, seg.text.length);
		}
		return chunks.slice(0, 3000);
	}

	function prepareReading(mode, selector) {
		const sel = getSelection();
		const selected = sel && !sel.isCollapsed ? sel.toString().trim() : '';
		let chunks;
		if (selected && mode !== 'page' && !selector) {
			const range = sel.getRangeAt(0).cloneRange();
			const seg = { text: selected.replace(/\s+/g, ' '), range };
			chunks = [];
			for (let i = 0; i < seg.text.length; i += CHUNK_MAX) {
				const cut = i + CHUNK_MAX >= seg.text.length ? seg.text.length : seg.text.lastIndexOf(' ', i + CHUNK_MAX);
				const end = cut > i ? cut : i + CHUNK_MAX;
				chunks.push({ seg, start: i, end, text: seg.text.slice(i, end).trim() });
				i = end - CHUNK_MAX;
			}
		} else {
			let scope = null;
			if (selector) {
				try {
					scope = document.querySelector(selector);
				} catch {}
			}
			chunks = chunkSegments(collectSegments(scope || findMainContent()));
		}
		reader = { chunks };
		return { chunks: chunks.map((c) => c.text), lang: root.lang || '' };
	}

	function rangeFor(chunk, offset, length) {
		const { seg } = chunk;
		const range = document.createRange();
		if (seg.img) range.selectNode(seg.img);
		else if (seg.range) return seg.range;
		else {
			const a = Math.min(chunk.start + offset, chunk.end - 1);
			const b = Math.min(a + Math.max(length, 1), chunk.end) - 1;
			range.setStart(seg.nodes[a], seg.offs[a]);
			range.setEnd(seg.nodes[b], seg.offs[b] + 1);
		}
		return range;
	}

	function highlight(i, wordStart, wordLength) {
		const chunk = reader?.chunks[i];
		if (!chunk || !CSS.highlights) return;
		if (wordStart != null && chunk.seg.range) return; // selections are highlighted as a whole
		try {
			if (wordStart == null) {
				const range = rangeFor(chunk, 0, chunk.end - chunk.start);
				CSS.highlights.set('cp-chunk', new Highlight(range));
				CSS.highlights.delete('cp-word');
				const r = range.getBoundingClientRect();
				if (r.top < 60 || r.bottom > innerHeight - 60) {
					const el = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
					el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
				}
			} else {
				CSS.highlights.set('cp-word', new Highlight(rangeFor(chunk, wordStart, wordLength)));
			}
		} catch {
			// The page changed under us; highlighting is best-effort.
		}
	}

	function clearHighlights() {
		CSS.highlights?.delete('cp-chunk');
		CSS.highlights?.delete('cp-word');
	}

	// ------------------------------------------------------------------ toast
	let toastTimer = 0;
	function toast(text) {
		let el = root.querySelector(':scope > cp-toast');
		if (!el) {
			el = document.createElement('cp-toast');
			el.setAttribute('role', 'status');
			root.append(el);
		}
		el.textContent = text;
		el.setAttribute('data-show', '');
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => el.removeAttribute('data-show'), 2200);
	}

	// ---------------------------------------------------------------- messages
	chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
		switch (msg.type) {
			case 'cp:ping':
				reply({ ok: true, host, title: document.title });
				break;
			case 'cp:outline':
				reply({
					url: location.href,
					title: document.title,
					viewport: `${innerWidth}x${innerHeight}`,
					outline: buildOutline(),
					picked: msg.usePicked && picked?.isConnected ? describePicked(picked) : null
				});
				break;
			case 'cp:count':
				reply(
					msg.selectors.map((s) =>
						count(s.replace(/::?[\w-]+(\([^)]*\))?/g, (m) => (/^:(not|is|where|has|nth-[\w-]+|first|last|only)/.test(m) ? m : '')) || '*')
					)
				);
				break;
			case 'cp:pick-start':
				startPicker();
				reply(true);
				break;
			case 'cp:pick-cancel':
				picker?.finish(null);
				picked = null;
				reply(true);
				break;
			case 'cp:read-prepare':
				reply(prepareReading(msg.mode, msg.selector));
				break;
			case 'cp:highlight':
				highlight(msg.i, msg.start, msg.length);
				break;
			case 'cp:highlight-clear':
				clearHighlights();
				break;
			case 'cp:toast':
				toast(msg.text);
				break;
		}
	});
})();
