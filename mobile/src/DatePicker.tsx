import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { locale, t } from './i18n';
import { Icon } from './icons';
import { radius, space, usePalette } from './theme';
import { Button, Sheet, Txt } from './ui';

/**
 * A date and time, picked in a sheet: a month calendar and hour / minute steppers. Written
 * in plain React Native so it takes the app's colours and font and needs no native module
 * (the web uses the browser's datetime field). Days before `min` cannot be chosen.
 */
export function DateTimeSheet(
  { open, value, min, title, onClose, onPick }:
  { open: boolean; value: Date | null; min: Date; title: string; onClose: () => void; onPick: (d: Date) => void },
) {
  const p = usePalette();
  const start = value ?? new Date(min.getTime() + 60 * 60_000);
  const [month, setMonth] = useState(new Date(start.getFullYear(), start.getMonth(), 1));
  const [day, setDay] = useState(new Date(start.getFullYear(), start.getMonth(), start.getDate()));
  const [hour, setHour] = useState(start.getHours());
  const [minute, setMinute] = useState(Math.ceil(start.getMinutes() / 5) * 5 % 60);
  useEffect(() => {
    if (!open) return;
    const s = value ?? new Date(min.getTime() + 60 * 60_000);
    setMonth(new Date(s.getFullYear(), s.getMonth(), 1)); setDay(new Date(s.getFullYear(), s.getMonth(), s.getDate()));
    setHour(s.getHours()); setMinute(Math.ceil(s.getMinutes() / 5) * 5 % 60);
  }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps

  const minDay = new Date(min.getFullYear(), min.getMonth(), min.getDate());
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const lead = (first.getDay() + 6) % 7;   // weeks start on Monday
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => new Date(month.getFullYear(), month.getMonth(), i + 1))];
  const weekdays = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(locale(), { weekday: 'narrow' }));
  const chosen = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
  const valid = chosen.getTime() >= min.getTime();
  const canPrev = new Date(month.getFullYear(), month.getMonth(), 0) >= minDay;

  const Step = ({ value: v, onChange, max, step }: { value: number; onChange: (n: number) => void; max: number; step: number }) => (
    <View style={{ alignItems: 'center', gap: 4 }}>
      <Pressable onPress={() => onChange((v + step) % max)} hitSlop={6} accessibilityRole="button" style={{ padding: 6 }}><Icon name="chevron" size={20} color={p.green} rotate={180} /></Pressable>
      <View style={{ minWidth: 64, height: 52, borderRadius: radius.md, backgroundColor: p.paper, borderWidth: 1, borderColor: p.line, alignItems: 'center', justifyContent: 'center' }}>
        <Txt size="title" weight="heavy" style={{ fontVariant: ['tabular-nums'] }}>{String(v).padStart(2, '0')}</Txt>
      </View>
      <Pressable onPress={() => onChange((v - step + max) % max)} hitSlop={6} accessibilityRole="button" style={{ padding: 6 }}><Icon name="chevron" size={20} color={p.green} /></Pressable>
    </View>
  );

  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <View style={{ gap: space.md, paddingBottom: space.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', direction: 'ltr' }}>
          <Pressable disabled={!canPrev} onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} hitSlop={8} style={{ padding: 8, opacity: canPrev ? 1 : 0.3 }}>
            <Icon name="chevron" size={20} color={p.green} rotate={90} />
          </Pressable>
          <Txt weight="medium" style={{ flex: 1, textAlign: 'center' }}>{month.toLocaleDateString(locale(), { month: 'long', year: 'numeric' })}</Txt>
          <Pressable onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} hitSlop={8} style={{ padding: 8 }}>
            <Icon name="chevron" size={20} color={p.green} rotate={-90} />
          </Pressable>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {weekdays.map((w, i) => <Txt key={`w${i}`} size="caption" color="muted" style={{ width: `${100 / 7}%`, textAlign: 'center' }}>{w}</Txt>)}
          {cells.map((d, i) => {
            if (!d) return <View key={`e${i}`} style={{ width: `${100 / 7}%`, height: 44 }} />;
            const off = d < minDay;
            const on = d.getTime() === day.getTime();
            return (
              <Pressable key={d.toISOString()} disabled={off} onPress={() => setDay(d)} accessibilityRole="button" accessibilityState={{ selected: on, disabled: off }}
                style={{ width: `${100 / 7}%`, height: 44, alignItems: 'center', justifyContent: 'center' }}>
                <View style={{ width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? p.brand : 'transparent' }}>
                  <Txt weight={on ? 'heavy' : 'regular'} color={on ? 'onBrand' : off ? 'line' : 'ink'}>{d.getDate()}</Txt>
                </View>
              </Pressable>
            );
          })}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.md, direction: 'ltr' }}>
          <Step value={hour} onChange={setHour} max={24} step={1} />
          <Txt size="title" weight="heavy">:</Txt>
          <Step value={minute} onChange={setMinute} max={60} step={5} />
        </View>
        <Txt size="small" color={valid ? 'muted' : 'danger'} style={{ textAlign: 'center' }}>
          {chosen.toLocaleString(locale(), { dateStyle: 'full', timeStyle: 'short' })}
        </Txt>
        <Button label={t.ok} onPress={() => { onPick(chosen); onClose(); }} disabled={!valid} />
      </View>
    </Sheet>
  );
}
