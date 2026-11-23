/**
 * Render the Everjoy laundry-tag mark to the PNG sources @capacitor/assets needs,
 * then run: npx capacitor-assets generate
 */
import sharp from 'sharp';
import fs from 'node:fs';

const BLUE = '#2F6FEB', TAG = '#FFF4D6', INK = '#1B2A4A', SUDS = '#EAF2FB';
// Tag glyph drawn in a 64-unit box (same shape as public/icon.svg).
const glyph = `
  <path d="M22 10h20l10 10v30a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4V20z" fill="${TAG}"/>
  <circle cx="32" cy="20" r="4" fill="${BLUE}"/>
  <path d="M21 34c3.7-3 7.3-3 11 0s7.3 3 11 0M21 43c3.7-3 7.3-3 11 0s7.3 3 11 0" fill="none" stroke="${INK}" stroke-width="3.2" stroke-linecap="round"/>`;
const svg = (size, body, bg) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">${bg ? `<rect width="64" height="64" fill="${bg}"/>` : ''}${body}</svg>`);
// Glyph scaled into the centre (adaptive icons keep the middle ~66%; splash keeps it small).
const centred = (scale) => `<g transform="translate(${32 - 32 * scale} ${32 - 32 * scale}) scale(${scale})">${glyph}</g>`;

fs.mkdirSync('assets', { recursive: true });
await sharp(svg(1024, centred(0.92), BLUE)).png().toFile('assets/icon-only.png');
await sharp(svg(1024, centred(0.62))).png().toFile('assets/icon-foreground.png');
await sharp(svg(1024, '', BLUE)).png().toFile('assets/icon-background.png');
await sharp(svg(2732, `<rect x="22" y="22" width="20" height="20" rx="5" fill="${BLUE}"/><g transform="translate(23.5 23.5) scale(0.265)">${glyph}</g>`, SUDS)).png().toFile('assets/splash.png');
await sharp(svg(2732, `<rect x="22" y="22" width="20" height="20" rx="5" fill="${BLUE}"/><g transform="translate(23.5 23.5) scale(0.265)">${glyph}</g>`, '#1B2A4A')).png().toFile('assets/splash-dark.png');
console.log('assets/ PNG sources written');
