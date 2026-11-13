import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { useI18n } from './i18n';
import { Icon } from './icons';

// The page where a family decides to pay. It is a PAGE, not a dialog: choosing how much of your family's memory to
// keep deserves the whole screen and a moment's thought, and a modal that covers the photos behind it argues against
// its own case. Everything arrives in sequence so the eye is led from the promise, through what you have now, to the
// choice — and every animation here is opacity and transform only, so it costs nothing on a weak phone.

export interface PlanOption { id: string; quotaBytes: number; priceMonthly: number; priceYearly: number; currency: string }
export interface BillingSummary { plan: string; quotaBytes: number; archivedBytes: number; chatBytes: number; request?: { status: string } | null }

const fmtBytes = (n: number) => {
  const unit = (v: number, u: string) => `${v % 1 === 0 ? v : v.toFixed(1)} ${u}`;
  if (n >= 1024 ** 4) return unit(n / 1024 ** 4, 'TB');
  if (n >= 1024 ** 3) { const gb = n / 1024 ** 3; return gb >= 1024 ? unit(gb / 1024, 'TB') : unit(gb, 'GB'); }
  if (n >= 1024 ** 2) return unit(n / 1024 ** 2, 'MB');
  return `${Math.ceil(n / 1024)} KB`;
};
/** Storage only means something once it is a number of photos. About 4 MB each, the size a modern phone makes. */
const roughPhotos = (bytes: number) => {
  const n = Math.round(bytes / (4 * 1024 ** 2));
  if (n >= 1000) return `${Math.round(n / 1000)},000`;
  return String(n);
};

export function Plans({ circleId, onBack }: { circleId: number; onBack: () => void }) {
  const { t } = useI18n();
  const [plans, setPlans] = useState<PlanOption[]>([]);
  const [bill, setBill] = useState<BillingSummary | null>(null);
  const [live, setLive] = useState<'test' | 'live' | null>(null);
  const [interval, setInterval] = useState<'month' | 'year'>('month');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    api<{ plans: PlanOption[]; paymentsLive: boolean; paymentsMode: 'test' | 'live' | null }>('/plans')
      .then(r => { setPlans(r.plans); setLive(r.paymentsLive ? r.paymentsMode : null); }).catch(() => {});
    api<BillingSummary>(`/circles/${circleId}/billing`).then(setBill).catch(() => {});
  }, [circleId]);

  async function pay(plan: string) {
    setErr(''); setBusy(plan);
    try { const r = await api<{ url: string }>(`/circles/${circleId}/checkout`, { body: { plan, interval } }); window.location.href = r.url; }
    catch (e) { setErr(t.errors[e instanceof ApiError ? e.code : 'generic'] ?? t.errors.generic); setBusy(''); }
  }
  async function ask(plan: string) {
    setErr(''); setBusy(plan);
    try { await api(`/circles/${circleId}/storage-request`, { body: { plan } }); setBill(b => (b ? { ...b, request: { status: 'open' } } : b)); }
    catch (e) { setErr(t.errors[e instanceof ApiError ? e.code : 'generic'] ?? t.errors.generic); }
    finally { setBusy(''); }
  }

  if (!bill || !plans.length) {
    return <div className="py-24 flex justify-center"><span className="w-8 h-8 rounded-full border-2 border-line border-t-green animate-spin" role="status" aria-label="…" /></div>;
  }

  const used = Math.min(100, Math.round((bill.archivedBytes / Math.max(1, bill.quotaBytes)) * 100));
  const saving = (p: PlanOption) => (p.priceMonthly > 0 ? Math.round((1 - p.priceYearly / (p.priceMonthly * 12)) * 100) : 0);
  const bestSaving = Math.max(0, ...plans.map(saving));
  const money = (v: number, c: string) => `${v} ${c}`;
  // The step up from where they are is the one most families take; it carries the emphasis.
  const paid = plans.filter(p => p.id !== 'free');
  const recommended = paid.find(p => p.quotaBytes > bill.quotaBytes)?.id;
  // Each block enters a beat after the one above it, so the page reads in order instead of landing all at once.
  const step = (i: number) => ({ animationDelay: `${i * 70}ms` });

  return (
    <div className="pb-16">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-green transition-colors duration-[var(--dur-instant)] py-2">
        <Icon name="chevron" className="w-4 h-4 rotate-90 rtl:-rotate-90" />{t.back}
      </button>

      {/* the promise */}
      <header className="mt-2 text-center animate-slide-up" style={step(0)}>
        <p className="text-xs font-bold tracking-[0.12em] uppercase text-green">{t.plansEyebrow}</p>
        <h1 className="mt-2 text-3xl sm:text-4xl font-bold text-ink leading-tight text-balance">{t.plansTitle}</h1>
        <p className="mt-3 mx-auto max-w-xl text-muted leading-relaxed">{t.storPlansLead}</p>
      </header>

      {/* where they are now */}
      <section aria-label={t.storage} className="mt-7 mx-auto max-w-md rounded-2xl border border-line bg-card p-4 elevated-1 animate-slide-up" style={step(1)}>
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-muted">{t.plan}</span>
          <b className="text-ink">{t.plans[bill.plan]} · <bdi dir="ltr">{fmtBytes(bill.quotaBytes)}</bdi></b>
        </div>
        <div className="mt-2.5 h-2 rounded-full bg-line overflow-hidden" role="progressbar" aria-valuenow={bill.archivedBytes} aria-valuemax={bill.quotaBytes}>
          <div className="h-full bg-brand rounded-full transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-standard)]" style={{ width: `${used}%` }} />
        </div>
        <p className="mt-2 text-xs text-muted"><bdi dir="ltr">{t.storUsedOf.replace('{used}', fmtBytes(bill.archivedBytes)).replace('{total}', fmtBytes(bill.quotaBytes))}</bdi></p>
        {/* Without this, a family that can SEE photos in its chat reads a used figure of zero and concludes the
            number is broken. The photos are real; they simply are not archived, and only the archive is charged for. */}
        <p className="mt-1.5 text-xs text-muted">{t.chatUsed}: <bdi dir="ltr">{fmtBytes(bill.chatBytes)}</bdi></p>
        <p className="mt-1 text-xs text-muted">{t.storageNote}</p>
      </section>

      {/* the billing choice, before any price it changes */}
      {live && (
        <div className="mt-7 flex justify-center animate-slide-up" style={step(2)}>
          <div role="group" aria-label={`${t.payMonthly} / ${t.payYearly}`} className="inline-flex gap-1 p-1 rounded-full bg-green-soft">
            {(['month', 'year'] as const).map(k => (
              <button key={k} aria-pressed={interval === k} onClick={() => setInterval(k)}
                className={`rounded-full px-5 py-2 text-sm font-bold transition-colors duration-[var(--dur-instant)]
                  ${interval === k ? 'bg-brand text-white elevated-1' : 'text-green hover:bg-card/60'}`}>
                {k === 'month' ? t.payMonthly : t.payYearly}
                {k === 'year' && bestSaving > 0 && (
                  <span className={`ms-2 rounded-full px-2 py-0.5 text-[0.625rem] font-bold align-middle
                    ${interval === 'year' ? 'bg-white/20 text-white' : 'bg-gold/20 text-gold-dark'}`}>
                    {t.storSavePct.replace('{n}', String(bestSaving))}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* the choice itself */}
      <ul className="mt-8 lg:mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {plans.map((p, i) => {
          const isCurrent = p.id === bill.plan;
          const best = p.id === recommended;
          const free = p.id === 'free';
          const yearly = interval === 'year';
          const amount = yearly ? p.priceYearly : p.priceMonthly;
          const perMonth = Math.round((p.priceYearly / 12) * 100) / 100;
          const canTake = !isCurrent && !free && p.quotaBytes > bill.quotaBytes;
          return (
            <li key={p.id} style={step(3 + i)}
              className={`relative flex flex-col h-full rounded-2xl p-5 animate-slide-up transition-shadow duration-[var(--dur-base)]
                ${best ? 'border-2 border-green bg-green-soft/40 elevated-2 lg:-mt-2 lg:pb-7' : 'border border-line bg-card elevated-1'}`}>
              {best && (
                <span className="absolute -top-3 start-5 rounded-full bg-brand text-white px-3 py-1 text-[0.6875rem] font-bold">
                  {t.storRecommended}
                </span>
              )}
              <b className="text-xl text-ink">{t.plans[p.id]}</b>
              <bdi dir="ltr" className="mt-1 block text-3xl font-bold text-green">{fmtBytes(p.quotaBytes)}</bdi>
              <p className="mt-1 text-sm text-muted">
                {free ? t.plansFreeNote : t.storPhotosAbout.replace('{n}', roughPhotos(p.quotaBytes))}
              </p>

              <div className="mt-4 min-h-[3.25rem]">
                {free ? (
                  <p className="text-lg font-bold text-ink">{t.storFreeLine}</p>
                ) : (
                  <>
                    <p className="flex items-baseline gap-1.5">
                      <bdi dir="ltr" className="text-3xl font-bold text-ink">{money(amount, p.currency)}</bdi>
                      <span className="text-sm text-muted">{yearly ? t.storPerYearShort : t.storPerMonthShort}</span>
                    </p>
                    {yearly && (
                      // Only the amount is isolated: an LTR box round the whole sentence scrambles the Arabic.
                      <p className="text-xs text-muted">
                        {t.storYearlyEquiv.split('{amount}')[0]}
                        <bdi dir="ltr">{money(perMonth, p.currency)}</bdi>
                        {t.storYearlyEquiv.split('{amount}')[1]}
                      </p>
                    )}
                  </>
                )}
              </div>

              <div className="mt-auto pt-4">
                {/* Every card ends on the same line: the plan in force says so here, where the others carry a button. */}
                {isCurrent && (
                  <p className="flex items-center justify-center gap-1.5 rounded-xl border border-line bg-paper/60 py-2.5 text-sm font-bold text-green">
                    <Icon name="check" className="w-4 h-4" />{t.storCurrent}
                  </p>
                )}
                {canTake && live && (
                  <button className={`w-full ${best ? 'btn' : 'btn btn-ghost'}`} disabled={!!busy} onClick={() => pay(p.id)}>
                    {busy === p.id ? t.payOpening : <>{t.payPay} · <bdi dir="ltr">{money(amount, p.currency)}</bdi></>}
                  </button>
                )}
                {canTake && !live && (
                  bill.request?.status === 'open'
                    ? <p className="text-center text-sm text-green py-2.5">{t.storRequestSent}</p>
                    : <button className={`w-full ${best ? 'btn' : 'btn btn-ghost'}`} disabled={!!busy} onClick={() => ask(p.id)}>{t.storRequest}</button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {err && <p role="alert" className="mt-4 text-center text-sm text-danger">{err}</p>}

      {/* what every plan gives, said once rather than repeated in each card as if it were a difference */}
      <section className="mt-10 rounded-2xl border border-line bg-card p-5 animate-slide-up" style={step(7)}>
        <h2 className="text-center text-sm font-bold tracking-wide uppercase text-muted">{t.plansIncluded}</h2>
        <ul className="mt-4 grid gap-3 sm:grid-cols-3">
          {([['memory', t.plansInc1], ['envelope', t.plansInc2], ['group', t.plansInc3]] as const).map(([icon, label]) => (
            <li key={label} className="flex items-start gap-2.5 text-sm text-ink">
              <span className="w-8 h-8 shrink-0 rounded-lg bg-green-soft text-green flex items-center justify-center"><Icon name={icon} className="w-4 h-4" /></span>
              <span className="leading-snug pt-1.5">{label}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* the three worries someone has at exactly this moment */}
      <ul className="mt-5 grid gap-2 sm:grid-cols-3 animate-slide-up" style={step(8)}>
        {[t.plansSafe1, t.plansSafe2, t.plansSafe3].map(line => (
          <li key={line} className="flex items-center gap-2 text-xs text-muted">
            <Icon name="check" className="w-4 h-4 text-green shrink-0" />{line}
          </li>
        ))}
      </ul>

      {live === 'test' && <p className="mt-6 text-xs text-gold-dark bg-gold/15 rounded-xl p-3 leading-relaxed">{t.payTest}</p>}
      {!live && <p className="mt-6 text-xs text-muted leading-relaxed text-center">{t.storNoPayments}</p>}
    </div>
  );
}
