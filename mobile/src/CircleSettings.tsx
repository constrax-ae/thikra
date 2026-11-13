import { useEffect, useState } from 'react';
import { Alert, Image, Linking, Modal, Platform, Pressable, ScrollView, Share, StyleSheet, TextInput, View, useWindowDimensions } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Contact } from 'expo-contacts';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, avatarSource, mediaSource, openBook, type Chat, type CircleDetail, type Me } from './api';
import { API_URL } from './config';
import { ConvertCard, PeoplePanel, StorageCard } from './CircleExtras';
import { lang, t } from './i18n';
import { Icon, type IconName } from './icons';
import {
  Avatar, Badge, Button, Card, FadeIn, IconButton, IconTile, ListRow, Muted, Picker, Segmented, Sheet, SheetRow,
  SettingsSkeleton, Skeleton, Toggle, Txt, ask,
} from './ui';
import { elevation, radius, space, usePalette } from './theme';

type Sub = 'members' | 'media' | 'settings';
interface Media { id: number; kind: 'image' | 'video' | 'file'; name: string | null; thumb: number | null; w: number | null; h: number | null }
type Sensitivity = CircleDetail['sensitivity'];

/**
 * A chat's info and settings, the web's Settings tab: who is in it, what was shared, and
 * how it behaves. The agent switch lives here — without it the archive could never start
 * filling from a phone, the device most of this family will only ever use.
 */
export function CircleSettings(
  { chat, detail, me, reload, openInvite, onLeft, onOpenArchive, onSealed, onOpenChat }:
  { chat: Chat; detail: CircleDetail | null; me: Me; reload: () => void; openInvite?: boolean; onLeft?: () => void; onOpenArchive: () => void; onSealed?: () => void; onOpenChat?: (c: Chat) => void },
) {
  const p = usePalette();
  const [sub, setSub] = useState<Sub>(openInvite ? 'members' : detail?.kind === 'direct' ? 'settings' : 'members');
  const [muteOpen, setMuteOpen] = useState(false);
  const [picker, setPicker] = useState<null | 'sens' | 'policy'>(null);
  const [media, setMedia] = useState<Media[] | null>(null);
  const [viewing, setViewing] = useState<Media | null>(null);
  const [member, setMember] = useState<CircleDetail['members'][number] | null>(null);   // the member a tap opened
  const [deleting, setDeleting] = useState(false);
  const [prefs, setPrefs] = useState({ muted: !!chat.muted, favourite: !!chat.favourite });

  useEffect(() => { if (sub === 'media' && media === null) api<Media[]>(`/circles/${chat.id}/media`).then(setMedia).catch(() => setMedia([])); }, [sub, media, chat.id]);

  if (!detail) {
    return <View style={{ flex: 1, backgroundColor: p.paper }}><SettingsSkeleton /></View>;
  }
  const d = detail;
  const manager = d.role === 'owner' || d.role === 'admin';

  /** Remove someone, or yourself (leaving): the server's rules decide who may. */
  async function removeMember(uid: number) {
    try { await api(`/circles/${chat.id}/members/${uid}`, { method: 'DELETE' }); if (uid === me.id) onLeft?.(); else reload(); }
    catch (e) { Alert.alert((e as { code?: string })?.code === 'owner_cannot_leave' ? t.ownerCannotLeave : t.failed); }
  }
  async function patch(body: Record<string, unknown>) {
    try { await api(`/circles/${chat.id}`, { method: 'PATCH', body }); reload(); } catch { Alert.alert(t.failed); }
  }
  async function pref(body: Record<string, unknown>) {
    setMuteOpen(false);
    setPrefs(x => ({ ...x, ...(body as object) }));   // answer the tap at once
    try { await api(`/circles/${chat.id}/prefs`, { method: 'PATCH', body }); reload(); } catch { setPrefs({ muted: !!chat.muted, favourite: !!chat.favourite }); }
  }

  const sections: Sub[] = d.kind === 'direct' ? ['settings', 'media'] : ['members', 'media', 'settings'];
  const quick: Array<[IconName, string, boolean, () => void]> = [
    [prefs.muted ? 'mute' : 'bell', prefs.muted ? t.infoMuted : t.infoMute, prefs.muted, () => (prefs.muted ? pref({ muted: false }) : setMuteOpen(true))],
    [prefs.favourite ? 'star-fill' : 'star', t.infoFavourite, prefs.favourite, () => pref({ favourite: !prefs.favourite })],
    ...(d.kind !== 'direct' ? [['plus', t.infoInvite, false, () => setSub('members')] as [IconName, string, boolean, () => void]] : []),
  ];

  return (
    <ScrollView style={{ flex: 1, backgroundColor: p.paper }} contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space.xxl * 2 }}>
      {/* Who this is. */}
      <FadeIn style={{ alignItems: 'center', gap: 6, paddingTop: space.xs }}>
        <Avatar name={d.name} kind={d.kind} size={76} />
        <Txt size="title" weight="medium" style={{ fontSize: 23, marginTop: space.sm, textAlign: 'center' }} numberOfLines={2}>{d.name}</Txt>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {d.kind !== 'direct' && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, height: 24, paddingHorizontal: 9, borderRadius: 12, backgroundColor: p.greenSoft }}>
              <Icon name={d.kind === 'circle' ? 'heart' : 'group'} size={12} color={p.green} />
              <Txt size="caption" weight="heavy" color="green">{d.kind === 'circle' ? t.infoKindCircle : t.infoKindGroup}</Txt>
            </View>
          )}
          <Muted style={{ fontSize: 13 }}>{d.members.length === 1 ? t.oneMember : t.infoMembersCount.replace('{n}', String(d.members.length))}</Muted>
        </View>
      </FadeIn>

      {/* The quick actions as one strip, like a phone's contact card. */}
      <View style={[{ flexDirection: 'row', borderRadius: radius.lg + 2, backgroundColor: p.card, borderWidth: StyleSheet.hairlineWidth, borderColor: p.line, overflow: 'hidden' }, elevation(p, 1)]}>
        {quick.map(([ic, label, on, fn], i) => (
          <Pressable key={label} onPress={fn} accessibilityRole="button" accessibilityState={{ selected: on }}
            style={({ pressed }) => [{ flex: 1, alignItems: 'center', gap: 6, paddingVertical: space.md },
              i > 0 && { borderStartWidth: StyleSheet.hairlineWidth, borderStartColor: p.line }, pressed && { backgroundColor: p.greenSoft }]}>
            <View style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? p.brand : p.greenSoft }}>
              <Icon name={ic} size={19} color={on ? p.onBrand : p.green} />
            </View>
            <Txt size="small" weight={on ? 'heavy' : 'medium'} color={on ? 'green' : 'ink'}>{label}</Txt>
          </Pressable>
        ))}
      </View>

      <Segmented value={sub} onChange={setSub} options={sections.map(k => ({ value: k, label: k === 'members' ? t.infoMembers : k === 'media' ? t.infoMedia : t.infoSettings }))} />

      {sub === 'members' && (
        <>
          {d.inviteCode ? <InviteCard chat={chat} detail={d} manager={manager} reload={reload} /> : !d.inviteEnabled && <Muted style={{ textAlign: 'center' }}>{t.noInviteCode}</Muted>}
          <Card padded={false}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.md + 2, paddingBottom: space.sm }}>
              <Txt weight="medium" style={{ flex: 1 }}>{t.infoMembers}</Txt>
              <View style={{ minWidth: 26, height: 22, paddingHorizontal: 8, borderRadius: 11, backgroundColor: p.greenSoft, alignItems: 'center', justifyContent: 'center' }}>
                <Txt size="caption" weight="heavy" color="green">{d.members.length}</Txt>
              </View>
            </View>
            {d.members.map((m, i) => (
              <Pressable key={m.id} onPress={() => setMember(m)} accessibilityRole="button" accessibilityLabel={m.name}
                style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm + 2,
                borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.line }, pressed && { backgroundColor: p.greenSoft }]}>
                <Avatar name={m.name} size={42} photo={avatarSource(m.id, m.avatarAt)} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Txt weight="medium" numberOfLines={1}>{m.name}</Txt>
                  {m.id === me.id && <Muted style={{ fontSize: 12 }}>{t.you}</Muted>}
                </View>
                {m.role !== 'member' && <Badge tone="warn">{m.role === 'owner' ? t.owner : t.admin}</Badge>}
                <Icon name="chevron" size={16} color={p.muted} rotate={-90} />
              </Pressable>
            ))}
          </Card>
          {d.kind === 'circle' && <PeoplePanel circle={d} manager={manager} />}
        </>
      )}

      {sub === 'media' && (
        media === null ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>{Array.from({ length: 9 }, (_, i) => <View key={i} style={{ width: '32.4%' }}><Skeleton height={110} radius={12} /></View>)}</View>
        ) : media.filter(m => m.kind !== 'file').length === 0 ? (
          <View style={{ alignItems: 'center', gap: space.sm, paddingVertical: space.xxl }}><IconTile name="image" size={56} /><Muted>{t.infoMediaNone}</Muted></View>
        ) : (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
            {media.filter(m => m.kind !== 'file').map((m, i) => (
              <FadeIn key={m.id} delay={Math.min(i, 12) * 25} style={{ width: '32.6%', aspectRatio: 1 }}>
                <Pressable onPress={() => m.kind === 'image' && setViewing(m)} style={{ flex: 1, borderRadius: 12, overflow: 'hidden', backgroundColor: p.line }}>
                  {/* The full photo, not the 320px thumbnail: a grid tile on a phone is ~360 real pixels wide. */}
                  <Image source={mediaSource(`/api/media/${m.kind === 'video' ? (m.thumb ?? m.id) : m.id}`)} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                  {m.kind === 'video' && <View style={{ position: 'absolute', left: 6, bottom: 6, width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' }}><Icon name="play" size={11} color="#fff" /></View>}
                </Pressable>
              </FadeIn>
            ))}
          </View>
        )
      )}

      {sub === 'settings' && (
        <>
          <Card padded={false}>
            <ListRow icon={prefs.muted ? 'mute' : 'bell'} label={t.infoNotifications} note={t.infoNotifNote} value={prefs.muted ? t.infoMuted : t.infoNotMuted} onPress={() => setMuteOpen(true)} last={d.kind !== 'circle'} />
            {d.kind === 'circle' && <ListRow icon="archive" label={t.thekraArchive} value={d.agentActive ? t.on : t.off} onPress={onOpenArchive} />}
            {d.kind === 'circle' && <ListRow icon="book" label={t.bookButton} onPress={() => { openBook(chat.id, new Date().getFullYear(), lang).catch(() => Alert.alert(t.failed)); }} right={<Icon name="arrow-out" size={18} color={p.muted} />} last={!onSealed} />}
            {d.kind === 'circle' && onSealed && <ListRow icon="envelope" label={t.thekraSealed} onPress={onSealed} last />}
          </Card>

          {manager && (
            <Card style={{ gap: space.md }}>
              {d.kind === 'circle' && <Toggle value={!!d.agentActive} onChange={v => patch({ agentActive: v })} label={t.agentMode} note={t.agentModeHelp} />}
              {d.kind === 'circle' && (
                <SettingPick label={t.sensitivity} value={({ strict: t.sensStrict, medium: t.sensMedium, lenient: t.sensLenient } as Record<Sensitivity, string>)[d.sensitivity]} onPress={() => setPicker('sens')} />
              )}
              {d.kind !== 'direct' && <SettingPick label={t.invitePolicy} value={t.invitePolicies[d.invitePolicy]} onPress={() => setPicker('policy')} />}
              {d.kind !== 'direct' && <Toggle value={d.inviteEnabled} onChange={v => patch({ inviteEnabled: v })} label={t.inviteEnabled} />}
            </Card>
          )}
          {!manager && d.kind === 'circle' && (
            <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
              <IconTile name="sparkle" tone="gold" />
              <View style={{ flex: 1 }}><Txt weight="medium">{t.agentMode}</Txt><Muted>{t.managersOnly}</Muted></View>
              <Badge tone={d.agentActive ? 'good' : 'neutral'}>{d.agentActive ? t.on : t.off}</Badge>
            </Card>
          )}

          {d.kind === 'circle' && (
            <Card style={{ gap: space.md }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}><IconTile name="shield" /><Txt weight="medium" style={{ flex: 1 }}>{t.agentInfoTitle}</Txt></View>
              <View style={{ borderRadius: radius.md, backgroundColor: p.greenSoft, padding: space.md, gap: space.sm }}>
                <Txt size="small" weight="heavy" color="green">{t.agentReadsTitle}</Txt>
                {t.agentReads.map(x => <View key={x} style={{ flexDirection: 'row', gap: space.sm }}><Icon name="check" size={16} color={p.green} /><Txt size="small" style={{ flex: 1 }}>{x}</Txt></View>)}
              </View>
              <View style={{ borderRadius: radius.md, backgroundColor: p.dangerSoft, padding: space.md, gap: space.sm }}>
                <Txt size="small" weight="heavy" color="danger">{t.agentNeverTitle}</Txt>
                {t.agentNever.map(x => <View key={x} style={{ flexDirection: 'row', gap: space.sm }}><Icon name="x" size={16} color={p.danger} /><Txt size="small" style={{ flex: 1 }}>{x}</Txt></View>)}
              </View>
            </Card>
          )}

          {d.kind === 'circle' && <StorageCard circle={d} manager={manager} />}
          {d.kind === 'group' && d.role === 'owner' && <ConvertCard circleId={chat.id} onDone={reload} />}

          {/* Leaving, for everyone but the owner (an owner hands the circle over first). */}
          {d.kind !== 'direct' && d.role !== 'owner' && (
            <Card padded={false}>
              <ListRow icon="arrow-back" label={t.leaveCircle} danger last onPress={() => ask(t.leaveCircle, t.leaveNote, t.leaveCircle, t.cancel, () => { void removeMember(me.id); })} />
            </Card>
          )}
          {/* The owner's danger zone: deleting the circle, confirmed by typing its name, as on the web. */}
          {d.kind !== 'direct' && d.role === 'owner' && (
            <Card style={{ gap: space.sm, borderColor: p.danger }}>
              <Txt weight="heavy" color="danger">{t.dangerZone}</Txt>
              <Button label={t.deleteCircle} kind="danger" icon="trash" onPress={() => setDeleting(true)} />
            </Card>
          )}
        </>
      )}

      <MemberSheet member={member} detail={d} meId={me.id} onClose={() => setMember(null)}
        onMessage={async uid => {
          try { const r = await api<{ id: number }>('/direct', { body: { userId: uid } }); const who = d.members.find(x => x.id === uid);
            onOpenChat?.({ id: r.id, kind: 'direct', name: who?.name ?? '', unread: 0, muted: false, pinned: false, lastText: '', lastKind: null, lastAt: '', lastAuthor: null, lastFromMe: false });
          } catch { Alert.alert(t.failed); }
        }}
        onRole={async (uid, role) => { try { await api(`/circles/${chat.id}/members/${uid}`, { method: 'PATCH', body: { role } }); reload(); } catch { Alert.alert(t.failed); } }}
        onTransfer={async uid => { try { await api(`/circles/${chat.id}/transfer`, { body: { userId: uid } }); reload(); } catch { Alert.alert(t.failed); } }}
        onRemove={uid => { void removeMember(uid); }} />
      <DeleteCircleSheet open={deleting} name={d.name} onClose={() => setDeleting(false)}
        onDelete={async typed => { await api(`/circles/${chat.id}`, { method: 'DELETE', body: { confirm: typed } }); setDeleting(false); onLeft?.(); }} />

      <Sheet open={muteOpen} onClose={() => setMuteOpen(false)} title={t.infoNotifications}>
        {prefs.muted
          ? <SheetRow icon="bell" label={t.unmute} onPress={() => pref({ muted: false })} />
          : <>
              <SheetRow icon="mute" label={t.mute8h} onPress={() => pref({ muted: true, muteHours: 8 })} />
              <SheetRow icon="mute" label={t.mute1w} onPress={() => pref({ muted: true, muteHours: 168 })} />
              <SheetRow icon="mute" label={t.muteAlways} onPress={() => pref({ muted: true })} />
            </>}
      </Sheet>
      <Picker open={picker === 'sens'} onClose={() => setPicker(null)} title={t.sensitivity} value={d.sensitivity}
        options={[{ value: 'strict', label: t.sensStrict }, { value: 'medium', label: t.sensMedium }, { value: 'lenient', label: t.sensLenient }]}
        onPick={v => patch({ sensitivity: v })} />
      <Picker open={picker === 'policy'} onClose={() => setPicker(null)} title={t.invitePolicy} value={d.invitePolicy}
        options={(['admins', 'members'] as const).map(v => ({ value: v, label: t.invitePolicies[v] }))} onPick={v => patch({ invitePolicy: v })} />
      <PhotoViewer item={viewing} onClose={() => setViewing(null)} />
    </ScrollView>
  );
}

/** A setting whose value is picked from a sheet: label above, the current value in a field-like button. */
function SettingPick({ label, value, onPress }: { label: string; value: string; onPress: () => void }) {
  const p = usePalette();
  return (
    <View style={{ gap: 6 }}>
      <Txt size="small" weight="medium">{label}</Txt>
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${label}: ${value}`}
        style={({ pressed }) => [{ minHeight: 50, flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md + 2, borderRadius: radius.md + 2,
          borderWidth: 1, borderColor: p.line, backgroundColor: p.card }, pressed && { borderColor: p.green }]}>
        <Txt weight="medium" style={{ flex: 1 }}>{value}</Txt>
        <Icon name="chevron" size={18} color={p.muted} />
      </Pressable>
    </View>
  );
}

const digits = (n: string) => n.replace(/[^\d+]/g, '');
const international = (n: string) => { const d = digits(n); return d.startsWith('+') ? d.slice(1) : d.startsWith('00') ? d.slice(2) : null; };   // wa.me needs the country code

/**
 * Invite people. The code and the link, copy and share, and the phone's own contact picker
 * (the app never reads the address book: what you pick only opens an SMS or WhatsApp with
 * the link in it). A manager can replace the code, which cancels the old one.
 */
function InviteCard({ chat, detail, manager, reload }: { chat: Chat; detail: CircleDetail; manager: boolean; reload: () => void }) {
  const p = usePalette();
  const [picked, setPicked] = useState<Array<{ name: string; number: string }>>([]);
  const [note, setNote] = useState('');
  const link = `${API_URL}/#/join/${detail.inviteCode}`;
  const text = t.inviteText.replace('{name}', detail.name).replace('{link}', link);
  const flash = (s: string) => { setNote(s); setTimeout(() => setNote(''), 1600); };

  async function pick() {
    try {
      const c = await Contact.presentPicker();
      if (!c) return;
      const phones = (await c.getPhones()).filter(x => x.number);
      if (!phones.length) { flash(t.noNumber); return; }
      const name = await c.getFullName();
      setPicked(prev => [...prev, { name: name || phones[0].number!, number: phones[0].number! }]);
    } catch { flash(t.failed); }
  }
  const sms = (x: { number: string }) => Linking.openURL(`sms:${digits(x.number)}${Platform.OS === 'ios' ? '&' : '?'}body=${encodeURIComponent(text)}`);
  const whatsapp = (x: { number: string }) => { const w = international(x.number); if (w) Linking.openURL(`https://wa.me/${w}?text=${encodeURIComponent(text)}`); };
  async function regenerate() {
    try { await api(`/circles/${chat.id}/invite/regenerate`, { method: 'POST', body: {} }); reload(); } catch { flash(t.failed); }
  }

  const W = '#ffffff';
  return (
    <View style={{ gap: space.sm }}>
      <View style={[{ borderRadius: radius.lg + 4, backgroundColor: p.brand, padding: space.lg, gap: space.md, overflow: 'hidden' }, elevation(p, 2)]}>
        <View pointerEvents="none" style={{ position: 'absolute', right: -60, top: -70, width: 200, height: 200, borderRadius: 100, backgroundColor: '#c79a3b', opacity: 0.1 }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: '#ffffff1f', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="group" size={22} color="#f0d9a0" />
          </View>
          <View style={{ flex: 1 }}>
            <Txt weight="medium" style={{ color: W }}>{t.inviteTitle}</Txt>
            <Txt size="small" style={{ color: '#ffffffb3' }}>{t.shareCode}</Txt>
          </View>
          {manager && (
            <Pressable onPress={regenerate} hitSlop={8} accessibilityRole="button" accessibilityLabel={t.regenerate}
              style={({ pressed }) => [{ width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#ffffff1f' }, pressed && { opacity: 0.7 }]}>
              <Icon name="refresh" size={17} color={W} />
            </Pressable>
          )}
        </View>

        {/* The code, with copy built in. */}
        <Pressable onPress={() => { void Clipboard.setStringAsync(detail.inviteCode ?? ''); flash(t.copied); }} accessibilityRole="button" accessibilityLabel={t.copy}
          style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', height: 56, paddingHorizontal: space.md, borderRadius: radius.md + 2,
            backgroundColor: '#00000033', borderWidth: 1, borderStyle: 'dashed', borderColor: '#ffffff40' }, pressed && { opacity: 0.8 }]}>
          <Txt selectable weight="heavy" style={{ flex: 1, color: W, fontSize: 22, letterSpacing: 5, textAlign: 'center' }}>{detail.inviteCode}</Txt>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Icon name={note === t.copied ? 'check' : 'copy'} size={16} color="#f0d9a0" />
            <Txt size="caption" weight="heavy" style={{ color: '#f0d9a0' }}>{note === t.copied ? t.copied : t.copy}</Txt>
          </View>
        </Pressable>

        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <Pressable onPress={pick} accessibilityRole="button" accessibilityLabel={t.inviteFromContacts}
            style={({ pressed }) => [{ flex: 1, height: 46, borderRadius: radius.md + 2, backgroundColor: W, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }, pressed && { opacity: 0.85 }]}>
            <Icon name="group" size={17} color={p.brand} />
            <Txt size="small" weight="heavy" numberOfLines={1} style={{ color: p.brand }}>{t.inviteContactsShort}</Txt>
          </Pressable>
          <Pressable onPress={() => { void Share.share({ message: text }); }} accessibilityRole="button" accessibilityLabel={t.inviteShare}
            style={({ pressed }) => [{ flex: 1, height: 46, borderRadius: radius.md + 2, backgroundColor: '#ffffff1f', borderWidth: 1, borderColor: '#ffffff33', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }, pressed && { opacity: 0.8 }]}>
            <Icon name="link" size={17} color={W} />
            <Txt size="small" weight="heavy" numberOfLines={1} style={{ color: W }}>{t.inviteShareShort}</Txt>
          </Pressable>
        </View>

        {picked.map((x, i) => (
          <View key={`${x.number}-${i}`} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.sm, borderRadius: radius.md, backgroundColor: '#ffffff14' }}>
            <Avatar name={x.name} size={34} />
            <View style={{ flex: 1 }}><Txt size="small" weight="medium" numberOfLines={1} style={{ color: W }}>{x.name}</Txt><Txt size="caption" style={{ color: '#ffffffa0' }}>{x.number}</Txt></View>
            <Pressable onPress={() => sms(x)} style={s.pill(p)}><Txt size="small" weight="medium" color="green">SMS</Txt></Pressable>
            {!!international(x.number) && <Pressable onPress={() => whatsapp(x)} style={s.pill(p)}><Txt size="small" weight="medium" color="green">WhatsApp</Txt></Pressable>}
          </View>
        ))}
        {!!note && note !== t.copied && <Txt size="small" style={{ color: '#f0d9a0' }}>{note}</Txt>}
      </View>
      <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: space.xs }}>
        <Icon name="lock" size={13} color={p.muted} />
        <Muted style={{ flex: 1, fontSize: 12, lineHeight: 17 }}>{t.invitePrivacy}</Muted>
      </View>
    </View>
  );
}

/** A photo full screen on black, tap anywhere or the close button to go back. */
export function PhotoViewer({ item, onClose }: { item: { id: number } | null; onClose: () => void }) {
  const inset = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  return (
    <Modal visible={!!item} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }}>
        {item && <Image source={mediaSource(`/api/media/${item.id}`)} style={{ width, height: height * 0.8 }} resizeMode="contain" />}
        <View style={{ position: 'absolute', top: inset.top + 8, right: 12 }}>
          <IconButton name="x" label="close" onPress={onClose} style={{ backgroundColor: 'rgba(255,255,255,0.15)' }} />
        </View>
      </Pressable>
    </Modal>
  );
}

const s = { pill: (p: ReturnType<typeof usePalette>) => ({ paddingHorizontal: 12, height: 34, borderRadius: 10, backgroundColor: p.greenSoft, justifyContent: 'center' as const }) };


/**
 * What a tap on a member offers. Only what the server allows is shown: anyone may message a
 * member privately; the owner promotes, demotes and hands the circle over; managers remove
 * members (only the owner removes an admin); the owner can never be removed.
 */
function MemberSheet({ member, detail, meId, onClose, onMessage, onRole, onTransfer, onRemove }: {
  member: CircleDetail['members'][number] | null; detail: CircleDetail; meId: number; onClose: () => void;
  onMessage: (uid: number) => void; onRole: (uid: number, role: 'admin' | 'member') => void; onTransfer: (uid: number) => void; onRemove: (uid: number) => void;
}) {
  const m = member;
  const self = !!m && m.id === meId;
  const owner = detail.role === 'owner';
  const manager = owner || detail.role === 'admin';
  const canRemove = !!m && !self && m.role !== 'owner' && (owner || (manager && m.role === 'member'));
  // Confirmations are shown while this sheet is still up (iOS drops an alert over a closing sheet).
  const confirm = (title: string, body: string, ok: string, fn: () => void) => ask(title, body, ok, t.cancel, () => { onClose(); fn(); });
  return (
    <Sheet open={!!m} onClose={onClose} title={m?.name}>
      {m && (
        <>
          {!self && detail.kind !== 'direct' && <SheetRow icon="chats" label={t.messagePrivately} onPress={() => { onClose(); onMessage(m.id); }} />}
          {owner && !self && m.role !== 'owner' && (
            <SheetRow icon="shield" label={m.role === 'admin' ? t.demote : t.promote} onPress={() => { onClose(); onRole(m.id, m.role === 'admin' ? 'member' : 'admin'); }} />
          )}
          {owner && !self && m.role !== 'owner' && (
            <SheetRow icon="key" label={t.transferOwner} onPress={() => confirm(t.transferOwner, t.confirmTransfer, t.transferOwner, () => onTransfer(m.id))} />
          )}
          {canRemove && (
            <SheetRow icon="trash" danger label={t.removeMember} onPress={() => confirm(t.removeMember, t.removeConfirm.replace('{name}', m.name), t.removeMember, () => onRemove(m.id))} />
          )}
          {self && <Muted style={{ textAlign: 'center', paddingVertical: space.md }}>{t.youInCircle}</Muted>}
        </>
      )}
    </Sheet>
  );
}

/** Deleting a circle: typed name to confirm, as on the web; it can be restored for 90 days. */
function DeleteCircleSheet({ open, name, onClose, onDelete }: { open: boolean; name: string; onClose: () => void; onDelete: (typed: string) => Promise<void> }) {
  const p = usePalette();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (!open) { setTyped(''); setError(''); } }, [open]);
  const ok = typed.trim() === name.trim();
  return (
    <Sheet open={open} onClose={busy ? () => {} : onClose} title={t.deleteCircle}>
      <Muted style={{ lineHeight: 20 }}>{t.deleteCircleWarn}</Muted>
      <Txt weight="heavy" style={{ marginTop: space.sm }}>{name}</Txt>
      <TextInput value={typed} onChangeText={setTyped} autoCapitalize="none" autoCorrect={false} accessibilityLabel={name} placeholder={name} placeholderTextColor={p.muted}
        style={{ height: 50, borderWidth: 1, borderColor: ok ? p.danger : p.line, borderRadius: radius.md + 2, paddingHorizontal: space.md, fontSize: 16, color: p.ink, backgroundColor: p.paper, marginTop: space.sm }} />
      {!!error && <Txt size="small" color="danger" style={{ marginTop: space.xs }}>{error}</Txt>}
      <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md }}>
        <Button label={t.cancel} kind="ghost" onPress={onClose} disabled={busy} style={{ flex: 1 }} />
        <Button label={t.deleteForever} kind="danger" busy={busy} disabled={!ok} style={{ flex: 1 }}
          onPress={async () => { setBusy(true); setError(''); try { await onDelete(typed.trim()); } catch { setError(t.failed); } finally { setBusy(false); } }} />
      </View>
    </Sheet>
  );
}
