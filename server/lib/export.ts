
// ---- your data, in an open format ----------------------------------------------------------------

export const EXPORT_MAX_BYTES = 150 * 1024 * 1024;
 // files beyond this are listed, not included: the export stays downloadable
export const safeName = (x: string) => x.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 60) || 'x';
