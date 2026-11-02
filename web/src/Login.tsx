import { useEffect, useMemo, useRef, useState } from 'react';
import { parsePhoneNumberFromString } from 'libphonenumber-js/min';
import { api, ApiError } from './api';
import { LangPicker, MachineNote } from './LangPicker';
import { useI18n, intlLocale } from './i18n';
import { Dialog } from './Dialog';
import { callingCode, flagEmoji, formatTyped, guessCountry, listCountries, type CountryCode } from '../../core/phone';

const CODE_LENGTH = 6;
const RESEND_SECONDS = 60;

function initialCountry(lang: string): CountryCode {
  try {
    const saved = localStorage.getItem('country');
    if (saved && listCountries('en').some(c => c.code === saved)) return saved as CountryCode;
  } catch { /* private mode */ }
  return guessCountry({
    languages: navigator.languages ?? [navigator.language],
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    fallback: lang === 'ar' ? 'SA' : 'US',
  });
}

export function Login({ onDone }: { onDone: () => void }) {
  const { t, lang, setLang } = useI18n();
  const [step, setStep] = useState<'phone' | 'code' | 'name' | 'pin'>('phone');
  const [ticket, setTicket] = useState('');
  const [pin, setPin] = useState('');
  const [resetAt, setResetAt] = useState<number | null>(null);
  const [country, setCountry] = useState<CountryCode>(() => initialCountry(lang));
  const [text, setText] = useState('');
  const [picker, setPicker] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [newUser, setNewUser] = useState(false);
  const [devCode, setDevCode] = useState<string>();
  const [left, setLeft] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // A number typed with a leading "+" is read as international and picks its own country, like WhatsApp.
  const international = text.trim().startsWith('+');
  const parsed = useMemo(() => parsePhoneNumberFromString(text, international ? undefined : country), [text, country, international]);
  const e164 = parsed?.isPossible() ? parsed.number : null;

  useEffect(() => {
    if (international && parsed?.country && parsed.country !== country) setCountry(parsed.country);
  }, [international, parsed?.country, country]);

  useEffect(() => {
    if (left <= 0) return;
    const h = setTimeout(() => setLeft(l => l - 1), 1000);
    return () => clearTimeout(h);
  }, [left]);

  const fail = (e: unknown) => setError(t.errors[e instanceof ApiError ? e.code : 'generic'] ?? t.errors.generic);

  function onPhoneChange(value: string) {
    setError('');
    setText(formatTyped(value, country));
  }

  function chooseCountry(c: CountryCode) {
    setCountry(c); setPicker(false); setError('');
    try { localStorage.setItem('country', c); } catch { /* private mode */ }
    // Keep the digits already typed, formatted for the new country.
    if (!international) setText(formatTyped(text, c));
  }

  async function requestCode() {
    if (!e164) return;
    setBusy(true); setError(''); setConfirming(false);
    try {
      const r = await api<{ newUser: boolean; devCode?: string }>('/auth/request', { body: { phone: e164 } });
      setNewUser(r.newUser); setDevCode(r.devCode); setCode(''); setLeft(RESEND_SECONDS); setStep('code');
    } catch (err) { fail(err); } finally { setBusy(false); }
  }

  async function verify(withCode: string, withName = name) {
    setBusy(true); setError('');
    try {
      const r = await api<{ needPin?: boolean; ticket?: string }>('/auth/verify', { body: { phone: e164, code: withCode, name: withName, lang } });
      if (r.needPin && r.ticket) { setTicket(r.ticket); setPin(''); setStep('pin'); return; }   // two-step verification
      onDone();
    } catch (err) {
      fail(err); setCode(''); setStep('code');
    } finally { setBusy(false); }
  }

  async function submitPin(value: string) {
    setBusy(true); setError('');
    try { await api('/auth/pin', { body: { ticket, pin: value } }); onDone(); }
    catch (err) {
      setPin('');
      if (err instanceof ApiError && err.code === 'wrong_pin') setError(t.errors.wrong_pin);
      else fail(err);
    } finally { setBusy(false); }
  }
  async function forgotPin() {
    setError('');
    try { const r = await api<{ resetAt: number }>('/auth/pin-forgot', { body: { ticket } }); setResetAt(r.resetAt); } catch (err) { fail(err); }
  }

  function onCodeChange(value: string) {
    const digits = value.replace(/\D/g, '').slice(0, CODE_LENGTH);
    setCode(digits); setError('');
    if (digits.length === CODE_LENGTH) {
      if (newUser) setStep('name'); else verify(digits);
    }
  }

  const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;

  return (
    <main className="min-h-full flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <img src="/icons/logo-160.png" alt="Thekra ذكرى" width={80} height={80} className="mx-auto mb-3 w-20 h-20 rounded-2xl" />
          <h1 className="text-4xl font-bold text-green">{t.appName}</h1>
          <p className="mt-2 text-muted">{t.tagline}</p>
        </div>

        <div className="card p-5 space-y-4">
          {step === 'phone' && (
            <form onSubmit={e => { e.preventDefault(); if (e164) setConfirming(true); }} className="space-y-4">
              <div>
                <h2 className="text-lg font-bold">{t.loginTitle}</h2>
                <p className="text-sm text-muted mt-1">{t.loginSubtitle}</p>
              </div>
              <div className="flex gap-2" dir="ltr">
                <button type="button" onClick={() => setPicker(true)} aria-label={t.country}
                  className="field !w-auto flex items-center gap-2 whitespace-nowrap cursor-pointer">
                  <span className="text-xl leading-none">{flagEmoji(country)}</span>
                  <span className="font-medium">+{callingCode(country)}</span>
                  <span aria-hidden className="text-muted text-xs">▾</span>
                </button>
                <input className="field text-lg tracking-wide" type="tel" inputMode="tel" autoComplete="tel-national" autoFocus
                  aria-label={t.phone} placeholder={t.phoneHint} value={text} onChange={e => onPhoneChange(e.target.value)} />
              </div>
              {text.replace(/\D/g, '').length >= 7 && !e164 && <p role="alert" className="text-sm text-danger">{t.invalidNumber}</p>}
              <button className="btn w-full" disabled={!e164 || busy}>{t.next}</button>
            </form>
          )}

          {step === 'code' && (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-bold">{t.codeTitle}</h2>
                <p className="text-sm text-muted mt-1">
                  {t.codeBody} <bdi dir="ltr" className="font-medium text-ink">{parsed?.formatInternational()}</bdi>{' '}
                  <button className="text-green underline" onClick={() => { setStep('phone'); setError(''); }}>{t.wrongNumber}</button>
                </p>
              </div>
              <CodeBoxes value={code} onChange={onCodeChange} disabled={busy} label={t.code} />
              {devCode && (
                <p className="text-xs text-gold-dark bg-gold/10 rounded-lg p-2 flex items-center gap-2">
                  <span className="flex-1">{t.devCode}: <b dir="ltr">{devCode}</b></span>
                  <button className="underline" onClick={() => onCodeChange(devCode)}>{t.fillDev}</button>
                </p>
              )}
              <div className="text-center text-sm">
                {left > 0
                  ? <span className="text-muted">{t.resendIn} <bdi dir="ltr">{mmss}</bdi></span>
                  : <button className="text-green underline" disabled={busy} onClick={requestCode}>{t.resend}</button>}
              </div>
            </div>
          )}

          {step === 'pin' && (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-bold">{t.pinTitle}</h2>
                <p className="text-sm text-muted mt-1">{t.pinBody}</p>
              </div>
              <input className="field text-center text-2xl tracking-[0.5em]" dir="ltr" type="password" inputMode="numeric" autoFocus maxLength={6} aria-label={t.pinTitle} value={pin}
                onChange={e => { const v = e.target.value.replace(/\D/g, '').slice(0, 6); setPin(v); setError(''); if (v.length === 6) submitPin(v); }} />
              {resetAt
                ? <p className="text-sm text-muted">{t.pinResetScheduled} {new Date(resetAt).toLocaleDateString(intlLocale(lang), { dateStyle: 'long' })}</p>
                : <button type="button" className="text-sm text-green underline" onClick={forgotPin}>{t.pinForgot}</button>}
            </div>
          )}

          {step === 'name' && (
            <form onSubmit={e => { e.preventDefault(); if (name.trim()) verify(code); }} className="space-y-4">
              <div>
                <h2 className="text-lg font-bold">{t.nameTitle}</h2>
                <p className="text-sm text-muted mt-1">{t.nameBody}</p>
              </div>
              <input className="field text-lg" autoFocus maxLength={60} aria-label={t.yourName} value={name} onChange={e => setName(e.target.value)} />
              <button className="btn w-full" disabled={!name.trim() || busy}>{t.start}</button>
            </form>
          )}

          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        </div>

        <div className="flex justify-center mt-4"><LangPicker /></div>
        <MachineNote className="mt-3" />
      </div>

      {picker && <CountryPicker current={country} onPick={chooseCountry} onClose={() => setPicker(false)} />}
      {confirming && parsed && (
        <Dialog onClose={() => setConfirming(false)} label={t.confirmTitle}>
          <h2 className="text-lg font-bold">{t.confirmTitle}</h2>
          <p className="text-sm text-muted mt-2">{t.confirmBody}</p>
          <p className="text-xl font-bold my-4 text-center" dir="ltr">{parsed.formatInternational()}</p>
          <div className="flex gap-2">
            <button className="btn btn-ghost flex-1" onClick={() => setConfirming(false)}>{t.edit}</button>
            <button className="btn flex-1" autoFocus onClick={requestCode} disabled={busy}>{t.ok}</button>
          </div>
        </Dialog>
      )}
    </main>
  );
}

/** Six boxes drawn over one real input, so paste, SMS autofill and the numeric keypad all just work. */
function CodeBoxes({ value, onChange, disabled, label }: { value: string; onChange: (v: string) => void; disabled: boolean; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="relative" dir="ltr" onClick={() => ref.current?.focus()}>
      <div className="flex justify-between gap-2" aria-hidden>
        {Array.from({ length: CODE_LENGTH }, (_, i) => (
          <div key={i} className={`flex-1 h-14 rounded-xl border-2 flex items-center justify-center text-2xl font-bold bg-card
            ${i === Math.min(value.length, CODE_LENGTH - 1) && !disabled ? 'border-green' : 'border-line'}`}>
            {value[i] ?? ''}
          </div>
        ))}
      </div>
      <input ref={ref} className="absolute inset-0 w-full h-full opacity-0 cursor-text" inputMode="numeric" autoComplete="one-time-code"
        maxLength={CODE_LENGTH} aria-label={label} value={value} disabled={disabled} onChange={e => onChange(e.target.value)} />
    </div>
  );
}

function CountryPicker({ current, onPick, onClose }: { current: CountryCode; onPick: (c: CountryCode) => void; onClose: () => void }) {
  const { t, lang } = useI18n();
  const [q, setQ] = useState('');
  const all = useMemo(() => listCountries(lang), [lang]);
  // Search also works with the English name, whatever the interface language is.
  const english = useMemo(() => new Map(listCountries('en').map(c => [c.code, c.name.toLowerCase()])), []);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/^\+/, '');
    const list = needle
      ? all.filter(c => c.name.toLowerCase().includes(needle) || english.get(c.code)!.includes(needle) || c.code.toLowerCase() === needle || c.dial.startsWith(needle))
      : all;
    return [...list.filter(c => c.code === current), ...list.filter(c => c.code !== current)];
  }, [all, english, q, current]);

  return (
    <Dialog onClose={onClose} label={t.country}>
      <h2 className="text-lg font-bold mb-3">{t.country}</h2>
      <input className="field mb-3" autoFocus type="search" placeholder={t.searchCountry} value={q} onChange={e => setQ(e.target.value)} />
      <ul className="h-80 overflow-y-auto -mx-2" role="listbox" aria-label={t.country}>
        {shown.length === 0 && <li className="p-3 text-center text-muted">{t.noResults}</li>}
        {shown.map(c => (
          <li key={c.code} role="option" aria-selected={c.code === current}>
            <button className={`w-full flex items-center gap-3 px-2 py-2.5 rounded-lg text-start hover:bg-paper ${c.code === current ? 'bg-green-soft' : ''}`}
              onClick={() => onPick(c.code)}>
              <span className="text-xl leading-none">{c.flag}</span>
              <span className="flex-1 min-w-0 truncate">{c.name}</span>
              <span className="text-muted" dir="ltr">+{c.dial}</span>
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
