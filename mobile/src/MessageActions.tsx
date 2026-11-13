import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { QUICK_REACTIONS } from '../../core/reactions.ts';
import { api, type Chat, type Msg } from './api';
import { Icon } from './icons';
import { t } from './i18n';
import { Avatar, Button, Sheet, SheetRow } from './ui';
import { font, radius, space, usePalette } from './theme';

/**
 * What a long press on a message offers.
 *
 * The web shows these on hover, which a phone does not have, so the whole set lives behind
 * a long press — the gesture every messenger has trained people to try. The quick
 * reactions sit along the top of the sheet where a thumb lands first.
 */
export function MessageActions(
  { msg, mine, meId, kind, pinned, onClose, onReply, onEdit, onChanged, onForward, onPinsChanged }:
  { msg: Msg | null; mine: boolean; meId: number; kind: 'circle' | 'group' | 'direct'; pinned: boolean;
    onClose: () => void; onReply: (m: Msg) => void; onEdit: (m: Msg) => void; onChanged: () => void;
    onForward: (m: Msg) => void; onPinsChanged: () => void },
) {
  const p = usePalette();
  const [busy, setBusy] = useState(false);
  // The same sheet, second page: how long to pin for (the web's three choices).
  const [pinPick, setPinPick] = useState(false);
  // What to do once this sheet has fully gone: iOS will not show another sheet or an alert
  // while this one is still closing, so the forward picker and notices wait for onClosed.
  const later = useRef<(() => void) | null>(null);
  const closed = () => { const f = later.current; later.current = null; f?.(); };
  useEffect(() => { if (!msg) setPinPick(false); }, [msg]);

  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); onChanged(); later.current = after ?? null; } catch (e) { console.warn('[actions]', (e as Error)?.message); later.current = () => Alert.alert(t.failed); } finally { setBusy(false); onClose(); }
  };
  const m = msg;
  const mineReaction = m?.reactions?.find(r => r.u === meId)?.e;
  // A message can be edited by its author for fifteen minutes, which is the server's rule.
  const minutes = m ? (Date.now() - new Date(String(m.createdAt).replace(' ', 'T') + 'Z').getTime()) / 60000 : 0;
  const canEdit = !!m && mine && m.kind === 'text' && minutes < 15;
  // The server forwards text only; the agent can only read words (a voice note's transcript).
  const canForward = !!m && m.kind === 'text' && !!m.body;
  const canArchive = !!m && kind === 'circle' && m.archiveStatus !== 'archived' && !!(m.kind === 'voice' ? m.transcript : m.body);

  return (
    <Sheet open={!!m} onClose={onClose} onClosed={closed} title={pinPick ? t.pinMessage : undefined}>
      {m && pinPick && (
        <>
          {([[24, t.pin24], [168, t.pin7], [720, t.pin30]] as Array<[number, string]>).map(([h, label]) => (
            <SheetRow key={h} icon="clock" label={label} onPress={() => run(() => api(`/messages/${m.id}/pin`, { body: { hours: h } }), onPinsChanged)} />
          ))}
        </>
      )}
      {m && !pinPick && (
        <>
          {/* The six people actually use. Tapping the one you already chose takes it off. */}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: space.sm, paddingHorizontal: space.xs, marginBottom: space.sm }}>
            {QUICK_REACTIONS.map(e => (
              <Pressable key={e} accessibilityRole="button" accessibilityLabel={e} onPress={() => run(() => api(`/messages/${m.id}/react`, { body: { emoji: e } }))}
                style={({ pressed }) => [{ width: 50, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', backgroundColor: p.paper },
                  (pressed || mineReaction === e) && { backgroundColor: p.greenSoft, transform: [{ scale: 1.08 }] }]}>
                <Text style={{ fontSize: 26 }}>{e}</Text>
              </Pressable>
            ))}
          </View>
          <SheetRow icon="reply" label={t.reply} onPress={() => { onReply(m); onClose(); }} />
          {canForward && <SheetRow icon="forward" label={t.forward} onPress={() => { later.current = () => onForward(m); onClose(); }} />}
          {!!m.body && <SheetRow icon="copy" label={t.copy} onPress={() => { void Clipboard.setStringAsync(m.body); onClose(); }} />}
          <SheetRow icon={m.starred ? 'star-fill' : 'star'} label={m.starred ? t.unstar : t.star} onPress={() => run(() => api(`/messages/${m.id}/star`, { body: { on: !m.starred } }))} />
          {pinned
            ? <SheetRow icon="pin" label={t.unpinMessage} onPress={() => run(() => api(`/messages/${m.id}/pin`, { method: 'DELETE' }), onPinsChanged)} />
            : <SheetRow icon="pin" label={t.pinMessage} onPress={() => setPinPick(true)} />}
          {canArchive && <SheetRow icon="sparkle" label={t.archiveThis} onPress={() => run(() => api(`/messages/${m.id}/archive`, { body: {} }), () => Alert.alert(t.archiveQueued))} />}
          {canEdit && <SheetRow icon="pen" label={t.edit} onPress={() => { onEdit(m); onClose(); }} />}
          <SheetRow icon="hide" label={t.deleteForMe} onPress={() => run(() => api(`/messages/${m.id}/hide`, { body: {} }))} />
          {mine && <SheetRow icon="trash" label={t.deleteMsg} danger onPress={() => run(() => api(`/messages/${m.id}`, { method: 'DELETE' }))} />}
          {!mine && <SheetRow icon="alert" label={t.report} danger onPress={() => run(() => api(`/messages/${m.id}/report`, { body: { reason: 'other' } }))} />}
        </>
      )}
    </Sheet>
  );
}

/**
 * Forward a message to up to five chats (the server's limit), the web's picker on a phone:
 * every chat you are in, tick the ones it should go to, then send.
 */
export function ForwardSheet({ msg, onClose }: { msg: Msg | null; onClose: () => void }) {
  const p = usePalette();
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [pick, setPick] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!msg) { setPick([]); return; }
    api<Chat[]>('/circles').then(l => setChats(l.filter(c => !c.archived))).catch(() => setChats([]));
  }, [msg]);
  const toggle = (id: number) => setPick(cur => cur.includes(id) ? cur.filter(x => x !== id) : cur.length >= 5 ? cur : [...cur, id]);
  async function send() {
    if (!msg || !pick.length || busy) return;
    setBusy(true);
    try { await api(`/messages/${msg.id}/forward`, { body: { circles: pick } }); onClose(); Alert.alert(t.forwardSent); }
    catch (e) { console.warn('[forward]', (e as Error)?.message); Alert.alert(t.failed); }
    finally { setBusy(false); }
  }
  return (
    <Sheet open={!!msg} onClose={onClose} title={t.forwardTo}>
      {!!msg && (
        <View style={{ padding: space.sm, borderRadius: radius.md, backgroundColor: p.paper, marginBottom: space.sm }}>
          <Text numberOfLines={2} style={{ fontFamily: font.regular, fontSize: 14, color: p.muted }}>{msg.body}</Text>
        </View>
      )}
      {(chats ?? []).map(c => {
        const on = pick.includes(c.id);
        return (
          <Pressable key={c.id} onPress={() => toggle(c.id)} accessibilityRole="checkbox" accessibilityState={{ checked: on }}
            style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm, paddingHorizontal: space.xs, borderRadius: radius.md },
              pressed && { backgroundColor: p.greenSoft }]}>
            <Avatar name={c.name} kind={c.kind} size={40} />
            <Text numberOfLines={1} style={{ flex: 1, fontFamily: font.medium, fontSize: 16, color: p.ink }}>{c.name}</Text>
            <View style={{ width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: on ? p.green : p.line, backgroundColor: on ? p.green : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
              {on && <Icon name="check" size={14} color={p.onBrand} />}
            </View>
          </Pressable>
        );
      })}
      <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md }}>
        <Button label={t.cancel} kind="ghost" onPress={onClose} style={{ flex: 1 }} />
        <Button label={pick.length ? `${t.forward} (${pick.length})` : t.forward} onPress={send} busy={busy} disabled={!pick.length} style={{ flex: 1 }} />
      </View>
    </Sheet>
  );
}
