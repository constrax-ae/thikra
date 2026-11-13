import { useCallback, useEffect, useState } from 'react';
import { AppState, Pressable, Text, View } from 'react-native';
import { api } from './api';
import { lang, t } from './i18n';
import { Icon, type IconName } from './icons';
import { MachineNote } from './Language';
import { Button } from './ui';
import { font, radius, space, usePalette } from './theme';

interface Card { id: string; level: 'info' | 'warning' | 'consent' | 'maintenance'; titleAr: string; titleEn: string; bodyAr: string; bodyEn: string }

/**
 * Notices from the team above the main screens (the web's Notices): news, a warning, scheduled
 * maintenance, or new terms that need an explicit "I agree". Looked for again every five minutes and
 * whenever the app comes back to the front. A consent notice cannot be closed, only agreed to; a
 * maintenance notice stays until the team ends it.
 */
export function Notices() {
  const p = usePalette();
  const [cards, setCards] = useState<Card[]>([]);
  const load = useCallback(() => { api<Card[]>('/announcements').then(setCards).catch(() => {}); }, []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 5 * 60_000);
    const sub = AppState.addEventListener('change', s => { if (s === 'active') load(); });
    return () => { clearInterval(timer); sub.remove(); };
  }, [load]);
  if (!cards.length) return null;
  const en = lang !== 'ar';   // the team writes each notice in Arabic and English; anyone not reading Arabic gets the English
  async function close(c: Card, accepted: boolean) {
    setCards(cs => cs.filter(x => x.id !== c.id));   // answer the tap at once; a failure brings it back on the next look
    try { await api(`/announcements/${c.id}/dismiss`, { body: { accepted } }); } catch { /* it comes back next time */ }
    load();
  }
  const look: Record<Card['level'], { icon: IconName; border: string; bg: string; tint: string }> = {
    info: { icon: 'bell', border: p.line, bg: p.card, tint: p.green },
    warning: { icon: 'alert', border: '#c79a3b80', bg: '#c79a3b1f', tint: p.goldDark },
    maintenance: { icon: 'tools', border: '#c79a3b80', bg: '#c79a3b1f', tint: p.goldDark },
    consent: { icon: 'shield', border: p.green, bg: p.card, tint: p.green },
  };
  return (
    <View accessibilityRole="summary" accessibilityLabel={t.noticeRegion} style={{ gap: space.sm }}>
      {cards.map(c => {
        const title = en ? c.titleEn : c.titleAr, body = en ? c.bodyEn : c.bodyAr;
        const l = look[c.level] ?? look.info;
        return (
          <View key={c.id} style={{ flexDirection: 'row', gap: space.md, padding: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: l.border, backgroundColor: l.bg }}>
            <Icon name={l.icon} size={20} color={l.tint} />
            <View style={{ flex: 1, gap: 6 }}>
              {!!title && <Text style={{ fontSize: 15, fontFamily: font.bold, color: p.ink }}>{title}</Text>}
              {!!body && <Text style={{ fontSize: 14, lineHeight: 20, fontFamily: font.regular, color: p.muted }}>{body}</Text>}
              {c.level === 'consent' && <MachineNote />}
              {c.level === 'consent'
                ? <Button label={t.noticeAgree} icon="check" onPress={() => { void close(c, true); }} style={{ marginTop: 4 }} />
                : c.level !== 'maintenance' && (
                  <Pressable onPress={() => { void close(c, false); }} accessibilityRole="button" hitSlop={8} style={{ alignSelf: 'flex-start' }}>
                    <Text style={{ fontSize: 13, fontFamily: font.bold, color: p.green }}>{t.noticeClose}</Text>
                  </Pressable>
                )}
            </View>
          </View>
        );
      })}
    </View>
  );
}
