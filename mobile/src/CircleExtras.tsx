import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { api, ApiError, type CircleDetail } from './api';
import { t } from './i18n';
import { Icon } from './icons';
import { Badge, Button, Card, Muted, Sheet, Txt } from './ui';
import { font, radius, space, usePalette } from './theme';
import { PlansScreen } from './Plans';

// A family circle's extras, the phone's version of web/src/CircleView.tsx: the "On this day" banner,
// the family record (the people in the family), storage, and turning a group into a circle.

const fmtBytes = (n: number) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const errText = (e: unknown) => t.errors[e instanceof ApiError ? e.code : 'generic'] ?? t.failed;

// ---- On this day --------------------------------------------------------------------------

type TodayItem = { type: 'memory'; id: number; title: string; years: number } | { type: 'birthday'; id: number; name: string; age: number };

/**
 * At the top of a family chat, only on a day that has something: a birthday, or an event the archive
 * kept from earlier years. Dismissed for the day (remembered on this phone); nothing at all otherwise.
 */
export function TodayBanner({ circleId, onOpenArchive }: { circleId: number; onOpenArchive?: () => void }) {
  const p = usePalette();
  const [data, setData] = useState<{ day: string; items: TodayItem[] } | null>(null);
  const [hidden, setHidden] = useState(true);
  const key = `thekra.today.${circleId}`;
  useEffect(() => {
    let alive = true;
    api<{ day: string; items: TodayItem[] }>(`/circles/${circleId}/today`).then(async d => {
      const seen = await SecureStore.getItemAsync(key).catch(() => null);
      if (alive) { setData(d); setHidden(seen === d.day); }
    }).catch(() => {});
    return () => { alive = false; };
  }, [circleId]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!data || hidden || data.items.length === 0) return null;
  const it = data.items[0], more = data.items.length - 1;
  const text = it.type === 'birthday'
    ? t.todayBirthday.replace('{name}', it.name).replace('{age}', String(it.age))
    : t.todayMemory.replace('{n}', String(it.years)).replace('{title}', it.title);
  const dismiss = () => { setHidden(true); void SecureStore.setItemAsync(key, data.day).catch(() => {}); };
  return (
    <View accessibilityRole="summary" style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginHorizontal: space.md, marginTop: space.sm,
      paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.md + 2, borderWidth: 1, borderColor: '#c79a3b66', backgroundColor: '#c79a3b1f' }}>
      <Icon name={it.type === 'birthday' ? 'cake' : 'memory'} size={18} color={p.goldDark} />
      <Pressable style={{ flex: 1 }} disabled={it.type !== 'memory' || !onOpenArchive} onPress={onOpenArchive}>
        <Text numberOfLines={2} style={{ fontSize: 13, lineHeight: 18, fontFamily: font.medium, color: p.ink }}>{text}{more > 0 ? ` (+${more})` : ''}</Text>
      </Pressable>
      <Pressable onPress={dismiss} hitSlop={10} accessibilityRole="button" accessibilityLabel={t.close}><Icon name="x" size={16} color={p.muted} /></Pressable>
    </View>
  );
}

// ---- The family record ---------------------------------------------------------------------

interface Person { id: number; name: string; userId: number | null; relation: string | null; birthDate: string | null; deathDate: string | null }
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The people in the family, including those not on the app and those who have passed: the story book,
 * birthdays and "On this day" read from here. Everyone sees it; managers add and edit.
 */
export function PeoplePanel({ circle, manager }: { circle: CircleDetail; manager: boolean }) {
  const p = usePalette();
  const [people, setPeople] = useState<Person[]>([]);
  const [editing, setEditing] = useState<Person | 'new' | null>(null);
  const [f, setF] = useState({ name: '', relation: '', birthDate: '', deathDate: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api<Person[]>(`/circles/${circle.id}/persons`).then(setPeople).catch(() => {});
  useEffect(() => { void load(); }, [circle.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const open = (x: Person | 'new') => {
    setEditing(x); setError('');
    setF(x === 'new' ? { name: '', relation: '', birthDate: '', deathDate: '' } : { name: x.name, relation: x.relation ?? '', birthDate: x.birthDate ?? '', deathDate: x.deathDate ?? '' });
  };
  const datesOk = (!f.birthDate || DATE.test(f.birthDate)) && (!f.deathDate || DATE.test(f.deathDate));
  async function save() {
    if (!f.name.trim() || !datesOk) return;
    setBusy(true); setError('');
    const body = { name: f.name.trim(), relation: f.relation.trim(), birthDate: f.birthDate || null, deathDate: f.deathDate || null };
    try {
      if (editing === 'new') await api(`/circles/${circle.id}/persons`, { body });
      else if (editing) await api(`/persons/${editing.id}`, { method: 'PATCH', body });
      setEditing(null); await load();
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }
  const years = (x: Person) => [x.birthDate?.slice(0, 4), x.deathDate?.slice(0, 4)].filter(Boolean).join(' – ');
  const input = { height: 48, borderWidth: 1, borderColor: p.line, borderRadius: radius.md + 2, paddingHorizontal: space.md, fontSize: 16, fontFamily: font.regular, color: p.ink, backgroundColor: p.paper };

  return (
    <Card padded={false}>
      <View style={{ padding: space.lg, paddingBottom: space.sm, gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Txt weight="medium" style={{ flex: 1 }}>{t.peopleTitle}</Txt>
          {people.length > 0 && <Badge tone="neutral">{people.length}</Badge>}
        </View>
        <Muted style={{ fontSize: 12, lineHeight: 18 }}>{t.peopleNote}</Muted>
      </View>
      {people.map(x => (
        <Pressable key={x.id} disabled={!manager} onPress={() => open(x)} accessibilityRole={manager ? 'button' : undefined} accessibilityLabel={x.name}
          style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm + 2,
            borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.line }, pressed && { backgroundColor: p.greenSoft }]}>
          <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: x.deathDate ? p.line : p.greenSoft, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={x.deathDate ? 'memory' : 'you'} size={17} color={x.deathDate ? p.muted : p.green} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Txt weight="medium" numberOfLines={1}>{x.name}{x.deathDate ? <Text style={{ fontSize: 12, color: p.muted }}>{`  · ${t.personDeceased}`}</Text> : null}</Txt>
            {!!(x.relation || years(x) || x.userId) && <Muted numberOfLines={1} style={{ fontSize: 12 }}>{[x.relation, years(x), x.userId ? t.linkedAccount : ''].filter(Boolean).join(' · ')}</Muted>}
          </View>
          {manager && <Icon name="pen" size={15} color={p.muted} />}
        </Pressable>
      ))}
      {manager && (
        <View style={{ padding: space.md, borderTopWidth: people.length ? StyleSheet.hairlineWidth : 0, borderTopColor: p.line }}>
          <Button label={t.addPerson} icon="plus" kind="ghost" onPress={() => open('new')} />
        </View>
      )}

      <Sheet open={editing !== null} onClose={busy ? () => {} : () => setEditing(null)} title={editing === 'new' ? t.addPerson : t.editPerson}>
        <View style={{ gap: space.sm, paddingBottom: space.sm }}>
          <TextInput style={input} value={f.name} onChangeText={v => setF({ ...f, name: v })} placeholder={t.personName} placeholderTextColor={p.muted} maxLength={60} />
          <TextInput style={input} value={f.relation} onChangeText={v => setF({ ...f, relation: v })} placeholder={t.personRelation} placeholderTextColor={p.muted} maxLength={40} />
          <Muted style={{ fontSize: 12 }}>{t.personBirth}</Muted>
          <TextInput style={[input, { writingDirection: 'ltr', textAlign: 'left' }]} value={f.birthDate} onChangeText={v => setF({ ...f, birthDate: v.trim() })} placeholder="YYYY-MM-DD"
            placeholderTextColor={p.muted} keyboardType="numbers-and-punctuation" maxLength={10} />
          <Muted style={{ fontSize: 12 }}>{t.personDeath}</Muted>
          <TextInput style={[input, { writingDirection: 'ltr', textAlign: 'left' }]} value={f.deathDate} onChangeText={v => setF({ ...f, deathDate: v.trim() })} placeholder="YYYY-MM-DD"
            placeholderTextColor={p.muted} keyboardType="numbers-and-punctuation" maxLength={10} />
          {!!error && <Txt size="small" color="danger">{error}</Txt>}
          <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.sm }}>
            <Button label={t.cancel} kind="ghost" onPress={() => setEditing(null)} disabled={busy} style={{ flex: 1 }} />
            <Button label={t.savePerson} onPress={() => { void save(); }} busy={busy} disabled={!f.name.trim() || !datesOk} style={{ flex: 1 }} />
          </View>
        </View>
      </Sheet>
    </Card>
  );
}

// ---- Storage --------------------------------------------------------------------------------

interface Billing {
  plan: string; status: string; sponsor: string | null; periodEnd: string | null;
  request: { plan: string; status: 'open' | 'granted' | 'declined' } | null;
  archivedBytes: number; quotaBytes: number; chatBytes: number;
}
interface Plan { id: string; quotaBytes: number; priceMonthly: number; priceYearly: number; currency: string }

/**
 * How full the family's vault is, and asking for more. Paying stays on the web for now: the phone
 * offers the request path (the team grants space), which is what the web offers too while payments are off.
 */
export function StorageCard({ circle, manager }: { circle: CircleDetail; manager: boolean }) {
  const p = usePalette();
  const [bill, setBill] = useState<Billing | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState('');
  const load = () => api<Billing>(`/circles/${circle.id}/billing`).then(setBill).catch(() => {});
  useEffect(() => { void load(); }, [circle.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) api<{ plans: Plan[] }>('/plans').then(r => setPlans(r.plans)).catch(() => {}); }, [open]);
  if (!bill) return null;
  const pct = Math.min(100, (bill.archivedBytes / Math.max(1, bill.quotaBytes)) * 100);
  const full = bill.archivedBytes >= bill.quotaBytes, almost = !full && pct >= 80;
  async function request(plan: string) {
    setErr('');
    try { await api(`/circles/${circle.id}/storage-request`, { body: { plan } }); await load(); setOpen(false); }
    catch (e) { setErr(errText(e)); }
  }
  const price = (x: Plan) => (x.priceMonthly === 0 ? t.storFreeLine : `${x.priceMonthly} ${x.currency} ${t.storPerMonth} · ${x.priceYearly} ${x.currency} ${t.storPerYear}`);

  return (
    <Card style={{ gap: space.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: p.greenSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name="storage" size={20} color={p.green} /></View>
        <Txt weight="medium" style={{ flex: 1 }}>{t.storage}</Txt>
        <Badge tone="neutral">{t.plans[bill.plan] ?? bill.plan}</Badge>
      </View>
      <View style={{ height: 8, borderRadius: 4, backgroundColor: p.line, overflow: 'hidden' }} accessibilityRole="progressbar">
        <View style={{ width: `${pct}%`, height: '100%', backgroundColor: full ? p.danger : almost ? p.gold : p.brand }} />
      </View>
      <Txt size="small" style={{ writingDirection: 'ltr' }}>{t.storUsedOf.replace('{used}', fmtBytes(bill.archivedBytes)).replace('{total}', fmtBytes(bill.quotaBytes))}</Txt>
      {(full || almost) && (
        <Txt size="small" style={{ padding: space.sm, borderRadius: radius.sm, color: full ? p.danger : p.goldDark, backgroundColor: full ? p.dangerSoft : '#c79a3b26' }}>{full ? t.storFullMsg : t.storAlmost}</Txt>
      )}
      <Muted style={{ fontSize: 12 }}>{t.chatUsed}: {fmtBytes(bill.chatBytes)} · {t.sponsor}: {bill.sponsor ?? t.noSponsor}</Muted>
      <Muted style={{ fontSize: 12, lineHeight: 18 }}>{t.storageNote}</Muted>
      {bill.status === 'readonly' && <Txt size="small" style={{ color: p.goldDark }}>{t.readonlyNote}</Txt>}
      {bill.request?.status === 'open' && <Txt size="small" color="green">{t.storRequestSent}</Txt>}
      {bill.request?.status === 'granted' && <Txt size="small" color="green">{t.storGranted}</Txt>}
      {bill.request?.status === 'declined' && <Muted style={{ fontSize: 12 }}>{t.storDeclined}</Muted>}
      {!!err && !open && <Txt size="small" color="danger">{err}</Txt>}
      <Button label={t.storGetMore} icon="plus" onPress={() => setOpen(true)} />

      {/* The plans, as a page of their own like the web's (web/src/Plans.tsx). */}
      <PlansScreen circleId={circle.id} open={open} manager={manager} onClose={() => { setOpen(false); void load(); }} />
    </Card>
  );
}

// ---- A group becoming a family circle -------------------------------------------------------

/** A plain group's owner can turn it into a family circle (the archive and the Memory keeper come with it). */
export function ConvertCard({ circleId, onDone }: { circleId: number; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Card style={{ gap: space.sm }}>
      <Button label={t.convertToCircle} icon="heart" busy={busy} onPress={async () => {
        setBusy(true);
        try { await api(`/circles/${circleId}/convert`, { method: 'POST', body: {} }); onDone(); }
        catch (e) { Alert.alert(errText(e)); } finally { setBusy(false); }
      }} />
      <Muted style={{ fontSize: 12, lineHeight: 18 }}>{t.convertNote}</Muted>
    </Card>
  );
}
