import { one, run } from '../db.ts';
import { pushToUser } from '../push.ts';
import type { AnyLang } from './lang.ts';

export const REPORT_REASONS = new Set(['spam', 'abuse', 'harassment', 'illegal', 'other']);

/**
 * What a reporter is told once the team has decided. Arabic and English are written here; every other language gets
 * the English one, never Arabic (the rule in texts.ts). The wording never says what was done to the other person —
 * that is between them and the team — and it invites a reply, which is where an appeal or more detail goes.
 */
const OUTCOME: Partial<Record<AnyLang, { subject: string; acted: string; dismissed: string }>> = {
  ar: {
    subject: 'بلاغك',
    acted: 'شكراً لبلاغك. راجعناه واتخذنا إجراءً بشأنه. لا نستطيع إخبارك بتفاصيل ما جرى مع الطرف الآخر. إن استمر ما أبلغت عنه، أو كان لديك ما تضيفه، فاكتب هنا.',
    dismissed: 'شكراً لبلاغك. راجعناه ولم نجد فيه مخالفة لقواعد تمتم، فلم نتخذ إجراءً. إن كان لديك ما يوضح الأمر أكثر فاكتب هنا وسنعيد النظر.',
  },
  en: {
    subject: 'Your report',
    acted: 'Thank you for the report. We reviewed it and took action. We cannot tell you what happened to the other person. If it continues, or you have more to add, write here.',
    dismissed: 'Thank you for the report. We reviewed it and did not find a breach of the Tamtim rules, so we took no action. If there is more that would explain it, write here and we will look again.',
  },
};
const outcomeWords = (lang: unknown) => OUTCOME[String(lang) as AnyLang] ?? OUTCOME.en!;

/**
 * Tell the person who reported that their report was decided. Until now a report vanished into the moderation inbox
 * and nothing came back, which is its own small injustice. It arrives in the same place as any message from the team
 * (You → Help), so they can answer it; the notification itself says only that there is one.
 */
export function tellReporter(reportId: number, action: string) {
  const r = one('SELECT r.reporter_id AS id, r.told_at AS told, u.lang FROM reports r JOIN users u ON u.id = r.reporter_id WHERE r.id = ?', reportId);
  if (!r || r.told) return;   // nobody to tell (the account is gone), or they have been told already
  const w = outcomeWords(r.lang);
  const caseId = Number(run('INSERT INTO support_cases (user_id, subject, status) VALUES (?, ?, ?)', r.id, w.subject, 'answered').lastInsertRowid);
  run('INSERT INTO support_messages (case_id, from_staff, body) VALUES (?, 1, ?)', caseId, action === 'dismiss' ? w.dismissed : w.acted);
  run("UPDATE reports SET told_at = datetime('now') WHERE id = ?", reportId);
  pushToUser(r.id, { title: 'Tamtim', body: w.subject, circle: 0, tag: `support-${caseId}`, url: '/#/you' }).catch(e => console.error('[push]', e));
}
