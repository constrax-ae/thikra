import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, ApiError } from './api';
import { t } from './i18n';
import { Icon, type IconName } from './icons';
import { Button, FadeIn, IconButton, Muted, Txt } from './ui';
import { elevation, font, radius, space, usePalette } from './theme';

// The plans page, the phone's version of web/src/Plans.tsx: the promise, where the family is now, the
// choice, what every plan includes, and the three worries someone has at this moment. Each block fades in
// a beat after the one above so the page reads in order. Paying stays on the web for now; here a manager
// REQUESTS the plan and the team grants it, the path the web offers too while payments are off.

interface PlanOption { id: string; quotaBytes: number; priceMonthly: number; priceYearly: number; currency: string }
interface Billing { plan: string; quotaBytes: number; archivedBytes: number; request?: { status: string } | null }

const fmtBytes = (n: number) => {
  const unit = (v: number, u: string) => `${v % 1 === 0 ? v : v.toFixed(1)} ${u}`;
  if (n >= 1024 ** 4) return unit(n / 1024 ** 4, 'TB');
  if (n >= 1024 ** 3) { const gb = n / 1024 ** 3; return gb >= 1024 ? unit(gb / 1024, 'TB') : unit(gb, 'GB'); }
  if (n >= 1024 ** 2) return unit(n / 1024 ** 2, 'MB');
  return `${Math.ceil(n / 1024)} KB`;
};
/** Storage only means something as a number of photos: about 4 MB each, what a modern phone makes. */
const roughPhotos = (bytes: number) => { const n = Math.round(bytes / (4 * 1024 ** 2)); return n >= 1000 ? `${Math.round(n / 1000)},000` : String(n); };

export function PlansScreen({ circleId, open, manager, onClose }: { circleId: number; open: boolean; manager: boolean; onClose: () => void }) {
  const p = usePalette();
  const inset = useSafeAreaInsets();
  const [plans, setPlans] = useState<PlanOption[]>([]);
  const [bill, setBill] = useState<Billing | null>(null);
  const [interval, setInterval] = useState<'month' | 'year'>('year');
  const [chosen, setChosen] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErr('');
    api<{ plans: PlanOption[] }>('/plans').then(r => setPlans(r.plans)).catch(() => {});
    api<Billing>(`/circles/${circleId}/billing`).then(setBill).catch(() => {});
  }, [open, circleId]);

  // The step up from where the family is: the one most take, chosen for them to start with.
  const recommended = bill ? plans.filter(x => x.id !== 'free').find(x => x.quotaBytes > bill.quotaBytes)?.id : undefined;
  useEffect(() => { if (recommended && !chosen) setChosen(recommended); }, [recommended]);   // eslint-disable-line react-hooks/exhaustive-deps

  async function ask() {
    if (!chosen) return;
    setErr(''); setBusy(true);
    try { await api(`/circles/${circleId}/storage-request`, { body: { plan: chosen } }); setBill(b => (b ? { ...b, request: { status: 'open' } } : b)); }
    catch (e) { setErr(t.errors[e instanceof ApiError ? e.code : 'generic'] ?? t.failed); }
    finally { setBusy(false); }
  }

  const ready = !!bill && plans.length > 0;
  const used = bill ? Math.min(100, (bill.archivedBytes / Math.max(1, bill.quotaBytes)) * 100) : 0;
  const saving = (x: PlanOption) => (x.priceMonthly > 0 ? Math.round((1 - x.priceYearly / (x.priceMonthly * 12)) * 100) : 0);
  const bestSaving = Math.max(0, ...plans.map(saving));
  const money = (v: number, c: string) => `${v} ${c}`;
  const pick = plans.find(x => x.id === chosen);
  const requested = bill?.request?.status === 'open';
  const top = plans.filter(x => x.id !== 'free').sort((a, b) => b.quotaBytes - a.quotaBytes)[0]?.id;

  return (
    <Modal visible={open} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: p.paper, paddingTop: inset.top }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.sm, minHeight: 52 }}>
          <IconButton name="arrow-back" label={t.back} onPress={onClose} />
        </View>
        {!ready ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={p.green} /></View>
        ) : (
          <>
            <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.xl, gap: space.lg }}>
              {/* The promise, short: the page is about choosing, not reading. */}
              <FadeIn style={{ gap: 6 }}>
                <Text style={{ fontSize: 12, letterSpacing: 1.4, textTransform: 'uppercase', fontFamily: font.bold, color: p.goldDark }}>{t.plansEyebrow}</Text>
                <Text style={{ fontSize: 28, lineHeight: 35, fontFamily: font.bold, color: p.ink }}>{t.plansTitle}</Text>
                <Muted style={{ lineHeight: 21 }}>{t.storPlansLead}</Muted>
              </FadeIn>

              {/* Where the family is now, said once (not repeated as a card below). */}
              <FadeIn delay={60}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: radius.lg, backgroundColor: p.brand }}>
                  <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: '#ffffff1f', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name="storage" size={20} color="#f0d9a0" />
                  </View>
                  <View style={{ flex: 1, gap: 6 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 14, fontFamily: font.bold, color: '#fff' }}>{t.plans[bill!.plan] ?? bill!.plan} · {fmtBytes(bill!.quotaBytes)}</Text>
                      <Text style={{ fontSize: 12, fontFamily: font.medium, color: '#ffffffb3' }}>{t.storCurrent}</Text>
                    </View>
                    <View style={{ height: 6, borderRadius: 3, backgroundColor: '#ffffff26', overflow: 'hidden' }} accessibilityRole="progressbar">
                      <View style={{ width: `${Math.max(used, 1.5)}%`, height: '100%', borderRadius: 3, backgroundColor: '#f0d9a0' }} />
                    </View>
                    <Text style={{ fontSize: 12, fontFamily: font.regular, color: '#ffffffb3', writingDirection: 'ltr' }}>{t.storUsedOf.replace('{used}', fmtBytes(bill!.archivedBytes)).replace('{total}', fmtBytes(bill!.quotaBytes))}</Text>
                  </View>
                </View>
              </FadeIn>

              {/* Monthly or yearly: a full-width segmented control before the prices it changes. */}
              <FadeIn delay={120}>
                <View style={{ flexDirection: 'row', padding: 4, borderRadius: 14, backgroundColor: p.card, borderWidth: StyleSheet.hairlineWidth, borderColor: p.line }}>
                  {(['month', 'year'] as const).map(k => {
                    const on = interval === k;
                    return (
                      <Pressable key={k} onPress={() => setInterval(k)} accessibilityRole="button" accessibilityState={{ selected: on }}
                        style={[{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 44, borderRadius: 10, backgroundColor: on ? p.brand : 'transparent' }]}>
                        <Text style={{ fontSize: 14, fontFamily: font.bold, color: on ? p.onBrand : p.muted }}>{k === 'month' ? t.payMonthly : t.payYearly}</Text>
                        {k === 'year' && bestSaving > 0 && (
                          <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8, backgroundColor: on ? '#f0d9a0' : '#c79a3b2e' }}>
                            <Text style={{ fontSize: 10, fontFamily: font.bold, color: on ? p.brand : p.goldDark }}>-{bestSaving}%</Text>
                          </View>
                        )}
                      </Pressable>
                    );
                  })}
                </View>
              </FadeIn>

              {/* The choice: compact rows you select, all visible at once; one button below acts on the choice. */}
              <View style={{ gap: 10 }}>
                {plans.map((x, i) => {
                  const isCurrent = x.id === bill!.plan;
                  const can = !isCurrent && x.id !== 'free' && x.quotaBytes > bill!.quotaBytes;
                  const on = chosen === x.id && can;
                  const best = x.id === recommended;
                  const premium = x.id === top && !best;
                  const yearly = interval === 'year';
                  const amount = yearly ? x.priceYearly : x.priceMonthly;
                  return (
                    <FadeIn key={x.id} delay={180 + i * 60}>
                      <Pressable disabled={!can} onPress={() => setChosen(x.id)} accessibilityRole="radio" accessibilityState={{ checked: on, disabled: !can }}
                        style={[{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, minHeight: 84, borderRadius: 18,
                          borderWidth: on ? 2 : StyleSheet.hairlineWidth, borderColor: on ? p.green : p.line, backgroundColor: on ? p.greenSoft : p.card,
                          opacity: !can && !isCurrent ? 0.55 : 1 }, on && elevation(p, 2)]}>
                        {/* the plan's mark: grey for free, green for the family plan, gold for the largest */}
                        <View style={{ width: 46, height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
                          backgroundColor: premium ? '#c79a3b26' : x.id === 'free' ? p.paper : p.greenSoft }}>
                          <Icon name={premium ? 'star' : x.id === 'free' ? 'heart' : 'storage'} size={22} color={premium ? p.goldDark : x.id === 'free' ? p.muted : p.green} />
                        </View>
                        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <Text style={{ fontSize: 17, fontFamily: font.bold, color: p.ink }}>{t.plans[x.id] ?? x.id}</Text>
                            <Text style={{ fontSize: 17, fontFamily: font.bold, color: p.green, writingDirection: 'ltr' }}>{fmtBytes(x.quotaBytes)}</Text>
                          </View>
                          <Muted numberOfLines={1} style={{ fontSize: 12 }}>{x.id === 'free' ? t.plansFreeNote : t.storPhotosAbout.replace('{n}', roughPhotos(x.quotaBytes))}</Muted>
                          {best && (
                            <View style={{ alignSelf: 'flex-start', marginTop: 4, paddingHorizontal: 8, height: 20, borderRadius: 10, justifyContent: 'center', backgroundColor: p.brand }}>
                              <Text style={{ fontSize: 10, fontFamily: font.bold, color: p.onBrand }}>{t.storRecommended}</Text>
                            </View>
                          )}
                        </View>
                        {/* the price, or what this plan is to you */}
                        <View style={{ alignItems: 'flex-end' }}>
                          {isCurrent ? (
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, height: 28, borderRadius: 14, backgroundColor: p.paper }}>
                              <Icon name="check" size={13} color={p.green} />
                              <Text style={{ fontSize: 12, fontFamily: font.bold, color: p.green }}>{t.storCurrent}</Text>
                            </View>
                          ) : x.priceMonthly === 0 ? (
                            <Text style={{ fontSize: 15, fontFamily: font.bold, color: p.ink }}>{t.plans.free ?? 'Free'}</Text>
                          ) : (
                            <>
                              <Text style={{ fontSize: 18, fontFamily: font.bold, color: p.ink, writingDirection: 'ltr' }}>{money(amount, x.currency)}</Text>
                              <Muted style={{ fontSize: 11 }}>{yearly ? t.storPerYearShort : t.storPerMonthShort}</Muted>
                            </>
                          )}
                        </View>
                        {can && (
                          <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: on ? p.green : p.line, alignItems: 'center', justifyContent: 'center' }}>
                            {on && <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: p.green }} />}
                          </View>
                        )}
                      </Pressable>
                    </FadeIn>
                  );
                })}
              </View>

              {/* What every plan gives, said once. */}
              <FadeIn delay={380}>
                <View style={{ gap: 12, padding: space.md, borderRadius: 18, backgroundColor: p.card, borderWidth: StyleSheet.hairlineWidth, borderColor: p.line }}>
                  <Text style={{ fontSize: 12, letterSpacing: 1.2, textTransform: 'uppercase', fontFamily: font.bold, color: p.muted }}>{t.plansIncluded}</Text>
                  {([['memory', t.plansInc1], ['envelope', t.plansInc2], ['group', t.plansInc3]] as Array<[IconName, string]>).map(([icon, label]) => (
                    <View key={label} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                      <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: p.greenSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name={icon} size={16} color={p.green} /></View>
                      <Txt size="small" style={{ flex: 1, lineHeight: 20 }}>{label}</Txt>
                    </View>
                  ))}
                  <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.line, marginVertical: 2 }} />
                  {[t.plansSafe1, t.plansSafe2, t.plansSafe3].map(line => (
                    <View key={line} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Icon name="check" size={14} color={p.green} />
                      <Muted style={{ flex: 1, fontSize: 12 }}>{line}</Muted>
                    </View>
                  ))}
                </View>
              </FadeIn>
            </ScrollView>

            {/* One action, always at the thumb: request the plan chosen above. */}
            <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: Math.max(inset.bottom, space.md), gap: 8,
              backgroundColor: p.card, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.line }}>
              {requested ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 52, borderRadius: 16, backgroundColor: p.greenSoft }}>
                  <Icon name="check" size={18} color={p.green} />
                  <Txt weight="medium" color="green">{t.storRequestSent}</Txt>
                </View>
              ) : manager ? (
                <Button label={pick ? `${t.storRequest} · ${t.plans[pick.id] ?? pick.id}` : t.storRequest} icon="send" busy={busy} disabled={!pick || busy} onPress={() => { void ask(); }} style={{ height: 52 }} />
              ) : (
                <Muted style={{ textAlign: 'center', paddingVertical: 8 }}>{t.storManagersOnly}</Muted>
              )}
              {!!err && <Txt size="small" color="danger" style={{ textAlign: 'center' }}>{err}</Txt>}
              <Muted style={{ fontSize: 11, lineHeight: 16, textAlign: 'center' }}>{t.storNoPayments}</Muted>
            </View>
          </>
        )}
      </View>
    </Modal>
  );
}
