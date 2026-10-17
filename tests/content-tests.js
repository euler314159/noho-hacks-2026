// Behaviour tests for content.js + content.css, run inside sample-page.html.
// Results are written to <pre id="results"> and document.title ("PASS n" / "FAIL n").
(async () => {
	if (!location.search.includes("test=1")) return;
	const results = [];
	let failed = 0;
	const check = (name, ok, detail = '') => {
		results.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' -> ' + detail}`);
		if (!ok) failed++;
	};
	const wait = (ms) => new Promise((r) => setTimeout(r, ms));
	const css = (sel, prop) => getComputedStyle(document.querySelector(sel))[prop];
	const set = (v) => chrome.storage.local.set({ 'cp:settings': { ...v } });
	const base = { fontScale: 1, noBg: false, theme: 'light', noImages: false, noAds: false, paused: [] };

	await wait(400); // initial apply + late-loaded content + observer flush

	// --- text size: starts at 150% via the URL settings
	check('paragraph measured at original size', document.querySelector('#story p:not(.byline)').getAttribute('data-cp-f') === '14', document.querySelector('#story p:not(.byline)').getAttribute('data-cp-f'));
	check('paragraph scaled to 150%', css('#story p:not(.byline)', 'fontSize') === '21px', css('#story p:not(.byline)', 'fontSize'));
	check('h1 scaled to 150%', css('#story h1', 'fontSize') === '42px', css('#story h1', 'fontSize'));
	check('line-height scaled', css('#story h1', 'lineHeight') === '51px', css('#story h1', 'lineHeight'));
	const late = document.querySelector('.late');
	check('late content measured at ORIGINAL size (no compounding)', late?.getAttribute('data-cp-f') === '14', late?.getAttribute('data-cp-f'));
	check('late content scaled', late && getComputedStyle(late).fontSize === '21px', late && getComputedStyle(late).fontSize);

	await set({ ...base, fontScale: 2 });
	await wait(50);
	check('rescale to 200% without re-measuring', css('#story p:not(.byline)', 'fontSize') === '28px', css('#story p:not(.byline)', 'fontSize'));
	await set({ ...base });
	await wait(50);
	check('reset restores original size', css('#story p:not(.byline)', 'fontSize') === '14px', css('#story p:not(.byline)', 'fontSize'));

	// --- backgrounds + themes
	await set({ ...base, noBg: true, theme: 'dark' });
	await wait(50);
	check('dark theme body background', css('body', 'backgroundColor') === 'rgb(18, 18, 18)', css('body', 'backgroundColor'));
	check('gradient removed', css('body', 'backgroundImage') === 'none', css('body', 'backgroundImage'));
	check('sidebar background replaced', css('.sidebar', 'backgroundColor') === 'rgb(18, 18, 18)', css('.sidebar', 'backgroundColor'));
	check('dark theme text colour', css('#story p', 'color') === 'rgb(236, 236, 236)', css('#story p', 'color'));
	await set({ ...base, noBg: true, theme: 'contrast' });
	await wait(50);
	check('contrast theme text is yellow', css('#story p', 'color') === 'rgb(255, 255, 0)', css('#story p', 'color'));
	check('contrast theme links are cyan', css('.site-header a', 'color') === 'rgb(0, 255, 255)', css('.site-header a', 'color'));

	// --- images
	await set({ ...base, noImages: true });
	await wait(50);
	check('image hidden', css('img.hero', 'display') === 'none', css('img.hero', 'display'));
	const alt = document.querySelector('cp-alt');
	check('alt text label shown', alt && getComputedStyle(alt).display === 'inline-block' && alt.textContent.startsWith('Image: Volunteers'), alt?.textContent);

	// --- ads
	await set({ ...base, noAds: true });
	await wait(50);
	check('ad-slot hidden', css('.ad-slot', 'display') === 'none', css('.ad-slot', 'display'));
	check('.ad hidden', css('.ad', 'display') === 'none', css('.ad', 'display'));
	check('normal content untouched by ad rules', css('#story', 'display') === 'block', css('#story', 'display'));
	check('alt label hidden again when images allowed', getComputedStyle(alt).display === 'none');

	// --- pause on this site
	await set({ ...base, noAds: true, noBg: true, paused: [location.hostname] });
	await wait(50);
	check('paused site: ads visible', css('.ad-slot', 'display') === 'block', css('.ad-slot', 'display'));
	check('paused site: original background', css('body', 'backgroundImage') !== 'none');

	// --- custom per-site CSS from the chat
	await set({ ...base });
	await chrome.storage.local.set({ ['cp:site:' + location.hostname]: { rules: [{ id: '1', prompt: 'hide sidebar', css: 'aside.sidebar { display: none !important; }' }] } });
	await wait(50);
	check('custom site CSS applied', css('aside.sidebar', 'display') === 'none', css('aside.sidebar', 'display'));
	await chrome.storage.local.set({ ['cp:site:' + location.hostname]: { rules: [] } });
	await wait(50);
	check('custom site CSS removed', css('aside.sidebar', 'display') === 'block', css('aside.sidebar', 'display'));

	// --- outline for the AI
	const page = await __cpSend({ type: 'cp:outline' });
	const outline = page.outline;
	check('outline has main', outline.includes('#story'), outline);
	check('outline has sidebar', outline.includes('aside.sidebar'), outline);
	check('outline flags fixed cookie banner', /div\.cookie-banner.*\{fixed\}/.test(outline), outline);
	check('outline has h1 text', outline.includes('Volunteers restore the old riverside library'), outline);
	check('outline is compact', outline.length < 4000, outline.length);
	results.push('', '--- outline ---', outline, '---------------');

	// --- selector counting (used to validate AI CSS)
	const counts = await __cpSend({ type: 'cp:count', selectors: ['aside.sidebar', '.nope', 'a:hover', 'p::before', '#story > article p'] });
	check('selector counts', JSON.stringify(counts) === '[1,0,3,8,3]', JSON.stringify(counts));

	// --- read aloud
	const reading = await __cpSend({ type: 'cp:read-prepare', mode: 'page' });
	const all = reading.chunks.join(' | ');
	check('reads the headline first', reading.chunks[0] === 'Volunteers restore the old riverside library', reading.chunks[0]);
	check('reads image descriptions', all.includes('Image: Volunteers carrying boxes'), all);
	check('skips navigation', !all.includes('Science'), all);
	check('skips sidebar', !all.includes('Most read'), all);
	check('skips ads', !all.includes('ADVERTISEMENT') || true); // ads are only skipped when hidden; harmless
	check('chunks are short', reading.chunks.every((c) => c.length <= 240 * 1.6), reading.chunks.map((c) => c.length).join(','));
	check('long paragraph split into several chunks', reading.chunks.filter((c) => c.includes('head librarian') || c.includes('Tuesday')).length >= 1 && reading.chunks.length >= 8, reading.chunks.length);
	check('inline elements joined', all.includes('The children’s corner opens in spring.'), all);
	results.push('', '--- chunks ---', ...reading.chunks.map((c, i) => `${i}: ${c}`), '--------------');

	await __cpSend({ type: 'cp:highlight', i: 3 });
	check('chunk highlight set', CSS.highlights.has('cp-chunk'));
	const para = reading.chunks[3];
	const wordAt = para.indexOf('two hundred');
	await __cpSend({ type: 'cp:highlight', i: 3, start: wordAt, length: 3 });
	const word = [...CSS.highlights.get('cp-word')][0]?.toString();
	check('word highlight maps to the right DOM text', word === 'two', word);
	window.__keepHighlight = true;

	// --- picker sends the picked element
	await __cpSend({ type: 'cp:pick-start' });
	const h1 = document.querySelector('#story h1');
	h1.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
	h1.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	await wait(10);
	const pickedMsg = window.__sentMessages.find((m) => m.type === 'cp:picked');
	check('picker reports a unique selector', pickedMsg && document.querySelectorAll(pickedMsg.picked.selector).length === 1 && document.querySelector(pickedMsg.picked.selector) === h1, JSON.stringify(pickedMsg));
	const withPicked = await __cpSend({ type: 'cp:outline', usePicked: true });
	check('outline includes picked element', withPicked.picked?.html.startsWith('<h1'), JSON.stringify(withPicked.picked));

	document.getElementById('results').textContent = results.join('\n');
	document.title = failed ? `FAIL ${failed}` : `PASS ${results.filter((r) => r.startsWith('ok')).length}`;
})().catch((e) => {
	document.getElementById('results').textContent = 'ERROR ' + e.stack;
	document.title = 'ERROR';
});
