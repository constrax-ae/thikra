/** Numbers of seven or more digits never leave the server, not even to the model. */
export const scrub = (s: unknown) => String(s ?? '').replace(/\+?\d[\d\s-]{5,}\d/g, '[number]').slice(0, 300);
