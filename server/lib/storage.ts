
export const cleanDate = (v: unknown): string | null | undefined => {
  if (v === null || v === '') return null;
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined;
};
export const PERSON_COLS = 'id, name, user_id AS userId, relation, birth_date AS birthDate, death_date AS deathDate';
