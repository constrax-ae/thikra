import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, BackHandler, View } from 'react-native';
import { api, clearSession, loadSession, type Chat, type Me } from './src/api';
import { ChatScreen } from './src/ChatScreen';
import { Account } from './src/Account';
import { Chats } from './src/Chats';
import { Invite } from './src/Invite';
import { Login } from './src/Login';
import { theme } from './src/theme';

/** Thekra for the phone: sign in, the chat list (family circles on top) and a chat. An early build: text only for now (photos, voice, albums, the archive and push come next). */
export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);   // undefined = still checking the saved session
  const [chat, setChat] = useState<Chat | null>(null);
  const [inviting, setInviting] = useState(false);
  const [account, setAccount] = useState(false);

  const enter = () => api<Me>('/me').then(setMe).catch(() => setMe(null));
  useEffect(() => { loadSession().then(has => (has ? enter() : setMe(null))); }, []);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { if (account) { setAccount(false); return true; } if (inviting) { setInviting(false); return true; } if (chat) { setChat(null); return true; } return false; });
    return () => sub.remove();
  }, [chat, inviting, account]);

  if (me === undefined) return <View style={{ flex: 1, justifyContent: 'center', backgroundColor: theme.bg }}><ActivityIndicator color={theme.green} /></View>;
  return (
    <>
      <StatusBar style="dark" />
      {!me ? <Login onDone={enter} />
        : account ? <Account onBack={() => setAccount(false)} onSignedOut={async () => { await clearSession(); setAccount(false); setChat(null); setMe(null); }} />
        : chat && inviting ? <Invite chat={chat} onBack={() => setInviting(false)} />
        : chat ? <ChatScreen chat={chat} me={me} onBack={() => setChat(null)} onInvite={() => setInviting(true)} />
        : <Chats onOpen={setChat} onAccount={() => setAccount(true)} />}
    </>
  );
}
