// Recognises common requests locally so they cost nothing and apply instantly.
// Only short, unambiguous commands match; anything more specific
// ("hide the images in the sidebar") falls through to the AI.

const FILLER =
	/\b(please|pls|plz|can|could|would|will|you|u|i|i'd|want|wanna|like|to|the|a|an|me|my|this|that|these|page|site|website|for|of|some|just|make|set|it|be|is|are|so|really|much|lot|bit|little|now|kindly|help|thanks|thank|hey|ok|okay)\b/g;

const TEXT = '(text|font|font size|text size|fonts|words|letters|writing|type)';
const BIGGER = '(bigger|larger|large|big|increase|enlarge|grow|zoom in|up)';
const SMALLER = '(smaller|small|decrease|shrink|reduce|zoom out|down)';
const REMOVE = '(remove|hide|no|block|disable|kill|get rid|without|off|stop|clear|turn off|switch off)';
const RESTORE = '(show|restore|bring back|enable|unhide|allow|unblock|turn on|switch on|keep)';
const IMAGES = '(images?|pictures?|photos?|pics|imgs?)';
const ADS = '(ads|adverts?|advertisements?|advertising|banners?)';
const BACKGROUNDS = '(backgrounds?|bg|background colou?rs?|background images?)';

const SWITCH = '(enable|use|switch|go|turn on|switch on)( to)?';
const rx = (s) => new RegExp('^(?:' + s + ')$');

const RULES = [
	[rx(`${TEXT} ${BIGGER}|${BIGGER} ${TEXT}|${BIGGER}|${TEXT} ${BIGGER} more|${BIGGER} more`), () => ({ fontDelta: 0.25, reply: 'Text is bigger.' })],
	[rx(`${TEXT} ${SMALLER}|${SMALLER} ${TEXT}|${SMALLER}`), () => ({ fontDelta: -0.25, reply: 'Text is smaller.' })],
	[rx(`(reset|normal|default|original|regular) ${TEXT}( size)?|${TEXT} (normal|default|original|regular)( size)?`), () => ({ settings: { fontScale: 1 }, reply: 'Text is back to its normal size.' })],
	[rx(`(dark|night)( mode| theme)?|${SWITCH} (dark|night)( mode| theme)?`), () => ({ settings: { noBg: true, theme: 'dark' }, reply: 'Dark mode is on.' })],
	[rx(`(light|day)( mode| theme)|${SWITCH} (light|day)( mode| theme)?`), () => ({ settings: { noBg: true, theme: 'light' }, reply: 'Light mode is on.' })],
	[rx(`sepia( mode| theme)?|${SWITCH} sepia( mode| theme)?`), () => ({ settings: { noBg: true, theme: 'sepia' }, reply: 'Sepia mode is on.' })],
	[rx(`high contrast( mode| theme)?|more contrast|${SWITCH} high contrast( mode| theme)?|contrast`), () => ({ settings: { noBg: true, theme: 'contrast' }, reply: 'High contrast is on: yellow text on black.' })],
	[rx(`${REMOVE} ${BACKGROUNDS}|${BACKGROUNDS} ${REMOVE}|plain ${BACKGROUNDS}`), () => ({ settings: { noBg: true }, reply: 'Backgrounds removed.' })],
	[rx(`${RESTORE} ${BACKGROUNDS}|${BACKGROUNDS} (on|back)`), () => ({ settings: { noBg: false }, reply: 'Original backgrounds restored.' })],
	[rx(`${REMOVE} ${IMAGES}|${IMAGES} ${REMOVE}`), () => ({ settings: { noImages: true }, reply: 'Images hidden. Their descriptions are shown instead.' })],
	[rx(`${RESTORE} ${IMAGES}|${IMAGES} (on|back)`), () => ({ settings: { noImages: false }, reply: 'Images are showing again.' })],
	[rx(`${REMOVE} ${ADS}|${ADS} ${REMOVE}|ad ?block(er)?( on)?`), () => ({ settings: { noAds: true }, reply: 'Ads are blocked. Reload the page to block ads that already loaded.' })],
	[rx(`${RESTORE} ${ADS}|${ADS} (on|back)`), () => ({ settings: { noAds: false }, reply: 'Ads are no longer blocked.' })],
	[rx('read|read aloud|read out( loud)?|read loud|speak|read text|read article|start reading|read out|text to speech|tts'), () => ({ action: 'read', reply: 'Reading the page aloud.' })],
	[rx('stop|stop reading|stop talking|be quiet|quiet|shut up|silence|pause|pause reading|stop speaking'), () => ({ action: 'stop', reply: 'Stopped reading.' })],
	[rx('undo|undo last( change)?|revert|go back'), () => ({ action: 'undo', reply: 'Undid the last change.' })],
	[rx('(reset|undo|clear|remove|delete) (all|everything|all changes|changes|custom changes)|reset|start over'), () => ({ action: 'clear', reply: 'Removed all custom changes for this site.' })]
];

export function normalize(text) {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s']/gu, ' ')
		.replace(FILLER, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Returns a local command ({settings?, fontDelta?, action?, reply}) or null. */
export function parseIntent(text) {
	const n = normalize(text);
	if (!n || n.split(' ').length > 6) return null;
	for (const [re, make] of RULES) if (re.test(n)) return make();
	return null;
}
