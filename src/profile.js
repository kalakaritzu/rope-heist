// Who you are in a room: name, colour and emotes. Purely cosmetic, so none of it touches the simulation.

export const PALETTE = [0xff7a59, 0x59c3ff, 0x7be07b, 0xf2d34f, 0xc084fc, 0xf472b6, 0x2dd4bf, 0xe5e7eb];
export const EMOTES = ['👍', '😂', '😱', '🆘', '🤔', '🎉']; // keys 1-4 send the first four; the bots also use the last two
export const MAX_NAME = 12;

export const colorHex = (index) => PALETTE[index] ?? PALETTE[0];
export const colorCss = (index) => '#' + colorHex(index).toString(16).padStart(6, '0');

/** Names come from other players over the network, so strip anything odd and keep them short. */
export function cleanName(name, fallback) {
  const cleaned = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const s = Array.from(cleaned).slice(0, MAX_NAME).join('').trim(); // by character, so an emoji is never cut in half
  return s || fallback;
}

export const cleanColor = (c) => (Number.isInteger(c) ? ((c % PALETTE.length) + PALETTE.length) % PALETTE.length : 0);

/** The host decides the final list: names cleaned, and if two people picked one colour the later joiner gets the next free one. */
export function resolveProfiles(list) {
  const used = new Set();
  return list.map((p, i) => {
    let color = cleanColor(p?.color);
    for (let k = 0; k < PALETTE.length && used.has(color); k++) color = (color + 1) % PALETTE.length;
    used.add(color);
    return { name: cleanName(p?.name, `Player ${i + 1}`), color };
  });
}

// ---------- remembered between visits (private windows can block storage, so never rely on it) ----------
const KEY = 'rope-heist-profile';
export function loadSavedProfile() {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { name: cleanName(p.name, ''), color: cleanColor(p.color) };
  } catch {
    return { name: '', color: 0 };
  }
}
export function saveProfile(p) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage unavailable: fine */ }
}
