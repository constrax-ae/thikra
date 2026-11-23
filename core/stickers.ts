// The built-in sticker packs. A sticker travels as { pack, id } only; every app draws it from this list, so nothing is uploaded and
// nothing outside the app is fetched. `text` stickers are a greeting drawn as a badge; `emoji` stickers are one large face.

export interface Sticker { id: string; text?: string; emoji: string }
export interface StickerPack { id: string; items: Sticker[] }

export const STICKER_PACKS: StickerPack[] = [
  { id: 'greetings', items: [
    { id: 'sabah', text: 'صباح الخير', emoji: '☀️' }, { id: 'masa', text: 'مساء الخير', emoji: '🌙' },
    { id: 'mabrook', text: 'مبروك', emoji: '🎉' }, { id: 'hamdulillah', text: 'الحمد لله', emoji: '🤲' },
    { id: 'jumaa', text: 'جمعة مباركة', emoji: '🕌' }, { id: 'eid', text: 'عيد مبارك', emoji: '✨' },
    { id: 'salamat', text: 'سلامات', emoji: '💐' }, { id: 'shukran', text: 'شكراً', emoji: '🙏' },
    { id: 'wahashtoni', text: 'وحشتوني', emoji: '❤️' }, { id: 'tosbah', text: 'تصبحون على خير', emoji: '😴' },
    { id: 'yalla', text: 'يلا', emoji: '🏃' }, { id: 'inshallah', text: 'إن شاء الله', emoji: '🌿' },
  ] },
  { id: 'faces', items: [
    ['joy', '😂'], ['love', '😍'], ['hug', '🤗'], ['kiss', '😘'], ['wink', '😉'], ['cool', '😎'], ['think', '🤔'], ['shy', '😊'],
    ['cry', '😭'], ['wow', '😮'], ['sleepy', '😴'], ['party', '🥳'], ['pray', '🤲'], ['heart', '❤️'], ['rose', '🌹'], ['clap', '👏'],
  ].map(([id, emoji]) => ({ id, emoji })) },
];

export const findSticker = (pack: unknown, id: unknown): Sticker | null =>
  STICKER_PACKS.find(p => p.id === pack)?.items.find(s => s.id === id) ?? null;
