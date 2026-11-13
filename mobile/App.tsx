import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { BackHandler, Image, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';

// Keep the native splash (logo on the paper colour) up until the font and the session are
// known, so the app never flashes a blank frame or the system font before its first screen.
SplashScreen.preventAutoHideAsync().catch(() => {});
SplashScreen.setOptions({ fade: true, duration: 350 });
import { api, clearSession, loadSession, type Chat, type Me } from './src/api';
import { ChatScreen } from './src/ChatScreen';
import { SealedScreen } from './src/Sealed';
import { Account } from './src/Account';
import { Chats } from './src/Chats';
import type { Login as LoginType } from './src/Login';

// The sign-in screen carries the phone-number library and its country data (about 150 KB), and a
// returning person never sees it. It is loaded the first time someone actually needs to sign in,
// not at every start (the web does the same with its sign-in page).
let LoginScreen: typeof LoginType | null = null;
const loadLogin = (): typeof LoginType => (LoginScreen ??= (require('./src/Login') as { Login: typeof LoginType }).Login);
import { Memory } from './src/Memory';
import { Tabs, type Tab } from './src/Tabs';
import { useIsDark, usePalette } from './src/theme';
import { FadeIn } from './src/ui';
import { loadLang, useLang } from './src/i18n';

/**
 * Thekra for the phone.
 *
 * The three tabs are the web's three places — chats, memory, you — so someone who uses
 * both finds the same things in the same order. A chat opens over the whole screen, the
 * way every messenger does it, and the tab bar comes back when it closes.
 */
export default function App() {
  return <SafeAreaProvider><Root /></SafeAreaProvider>;
}

function Root() {
  const p = usePalette();
  const dark = useIsDark();
  // A font that fails to load must never keep the app on the splash: fall back to the system font.
  // Tajawal with the web's vertical-metric correction baked in (assets/fonts, see theme.ts):
  // the stock files sit text high in every button and field.
  const [fontsLoaded, fontError] = useFonts({
    'Thekra-Regular': require('./assets/fonts/Tajawal_400Regular.ttf'),
    'Thekra-Medium': require('./assets/fonts/Tajawal_500Medium.ttf'),
    'Thekra-Bold': require('./assets/fonts/Tajawal_700Bold.ttf'),
  });
  const fonts = fontsLoaded || !!fontError;
  const [me, setMe] = useState<Me | null | undefined>(undefined);   // undefined = still checking the saved session
  const [tab, setTab] = useState<Tab>('chats');
  const [chat, setChat] = useState<Chat | null>(null);
  const [unread, setUnread] = useState(0);
  // Sealed letters open over everything, like a chat; from a circle they start on that circle.
  const [sealed, setSealed] = useState<{ circleId?: number } | null>(null);

  const enter = () => api<Me>('/me').then(setMe).catch(() => setMe(null));
  useEffect(() => { loadSession().then(has => (has ? enter() : setMe(null))); }, []);
  // The language this device chose before, before the first screen draws.
  const lang = useLang();
  const [langReady, setLangReady] = useState(false);
  useEffect(() => { loadLang().finally(() => setLangReady(true)); }, []);

  // Android's back key unwinds one layer at a time, and leaves the app from the chat list.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (sealed) { setSealed(null); return true; }
      if (chat) { setChat(null); return true; }
      if (tab !== 'chats') { setTab('chats'); return true; }
      return false;
    });
    return () => sub.remove();
  }, [chat, tab, sealed]);

  const ready = fonts && me !== undefined && langReady;
  useEffect(() => { if (ready) SplashScreen.hideAsync().catch(() => {}); }, [ready]);

  const bar = <StatusBar style={dark ? 'light' : 'dark'} />;

  // Until the font and the session are known, the logo on the paper colour — the same
  // frame as the splash, so there is no flash of system font or of the login screen.
  if (!ready) {
    // Behind the native splash; matches it exactly in case the splash lifts first.
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: p.paper }}>
        {bar}
        <Image source={dark ? require('./assets/splash-dark.png') : require('./assets/splash-light.png')} style={{ width: 300, height: 250 }} resizeMode="contain" />
      </View>
    );
  }
  if (!me) { const Login = loadLogin(); return <View key={lang} style={{ flex: 1 }}>{bar}<Login onDone={enter} /></View>; }

  // A chat covers everything, tab bar included.
  if (sealed) {
    return <View key={lang} style={{ flex: 1 }}>{bar}<SealedScreen me={me} circleId={sealed.circleId} onBack={() => setSealed(null)} /></View>;
  }
  if (chat) {
    return <View key={lang} style={{ flex: 1 }}>{bar}<ChatScreen key={chat.id} chat={chat} me={me} onBack={() => setChat(null)} onSealed={circleId => setSealed({ circleId })} onOpenChat={setChat} /></View>;
  }

  // Keyed on the language: a change redraws every screen in the new language at once.
  return (
    <View key={lang} style={{ flex: 1, backgroundColor: p.paper }}>
      {bar}
      <FadeIn key={tab} from={4} style={{ flex: 1 }}>
        {tab === 'chats' && <Chats onOpen={setChat} onUnread={setUnread} />}
        {tab === 'memory' && <Memory onOpenCircle={setChat} />}
        {tab === 'you' && (
          <Account me={me} onChanged={enter} onSealed={() => setSealed({})}
            onSignedOut={async () => { await clearSession(); setChat(null); setTab('chats'); setMe(null); }} />
        )}
      </FadeIn>
      <Tabs tab={tab} onPick={setTab} unread={unread} />
    </View>
  );
}
