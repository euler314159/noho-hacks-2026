// AI-written CSS is untrusted: the page outline it was based on may contain prompt
// injection. CSS can't run script, but it can leak data (url() requests keyed on
// attribute selectors) or paint fake text (content: "..."). So we:
//   1. reject anything that can load a resource or hide such a load behind escapes,
//   2. parse with the browser's own CSS parser (drops invalid rules),
//   3. strip `content` strings and mark every declaration !important.

const BLOCKED =
	/url\s*\(|@import|image-set\s*\(|\bimage\s*\(|cross-fade\s*\(|element\s*\(|\bsrc\s*\(|@font-face|@namespace|expression\s*\(|javascript:|behavior\s*:|-moz-binding|<\/?\s*(style|script)/i;

// Only escapes of ASCII punctuation (e.g. Tailwind's `md\:flex`) are allowed. Hex or
// letter escapes could spell out a blocked word such as u\72 l(.
const UNSAFE_ESCAPE = /\\(?![!-/:-@[-`{-~])/;

/** Returns a reason string if the CSS text is not allowed, or '' if it is. */
export function unsafeReason(css) {
	if (UNSAFE_ESCAPE.test(css)) return 'character escapes';
	const m = css.match(BLOCKED);
	return m ? `"${m[0].trim()}"` : '';
}

const SAFE_CONTENT = /^(none|normal|""|'')$/;

/**
 * Validates and normalises AI-written CSS.
 * @returns {{css: string, selectors: string[], dropped: number}}
 * @throws Error when the CSS is unsafe.
 */
export function hardenCss(input) {
	const reason = unsafeReason(input);
	if (reason) throw new Error(`Blocked unsafe CSS (${reason}).`);
	const sheet = new CSSStyleSheet();
	sheet.replaceSync(input);
	const selectors = [];
	let dropped = 0;
	const visit = (rules) => {
		for (const rule of rules) {
			if (rule instanceof CSSKeyframesRule) continue; // !important is invalid inside keyframes
			if (rule.style) {
				const s = rule.style;
				for (let i = s.length - 1; i >= 0; i--) {
					const prop = s[i];
					const value = s.getPropertyValue(prop);
					if (prop === 'content' && !SAFE_CONTENT.test(value.trim())) {
						s.removeProperty(prop);
						dropped++;
					} else if (value) {
						s.setProperty(prop, value, 'important');
					}
				}
				if (rule.selectorText) selectors.push(rule.selectorText);
			}
			if (rule.cssRules) visit(rule.cssRules);
		}
	};
	visit(sheet.cssRules);
	const css = [...sheet.cssRules].map((r) => r.cssText).join('\n');
	// Re-check the browser's serialisation too, in case parsing produced something new.
	if (unsafeReason(css)) throw new Error('Blocked unsafe CSS.');
	return { css, selectors, dropped };
}
