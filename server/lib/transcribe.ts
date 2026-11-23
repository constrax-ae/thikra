// ---- voice-to-text ------------------------------------------------------------------------------
// Asked for ONE voice note by the reader's own device, which sends the audio it already holds (so this works the same when the server can
// no longer read a chat). Nothing is stored here and the text is not written to the message. Provider: any OpenAI-compatible
// /v1/audio/transcriptions service (set TRANSCRIBE_API_KEY; TRANSCRIBE_BASE_URL and TRANSCRIBE_MODEL are optional).
// Without a key everything answers "not set up" and the rest of the app is unaffected.

export interface Transcriber { transcribe(audio: Buffer, mime: string, lang?: string): Promise<string> }

export function openaiTranscriber(key: string, base = 'https://api.openai.com/v1', model = 'gpt-4o-mini-transcribe'): Transcriber {
  return {
    async transcribe(audio, mime, lang) {
      const fd = new FormData();
      fd.append('file', new Blob([new Uint8Array(audio)], { type: mime }), `voice.${mime.split('/')[1] ?? 'webm'}`);
      fd.append('model', model);
      if (lang && /^[a-z]{2,3}$/.test(lang)) fd.append('language', lang);
      const res = await fetch(`${base}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: fd, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`provider answered ${res.status}`);
      const text = (await res.json() as { text?: unknown }).text;
      if (typeof text !== 'string') throw new Error('provider gave no text');
      return text.trim().slice(0, 8000);
    },
  };
}

let current: Transcriber | null | undefined;
export const transcriber = (): Transcriber | null => {
  if (current !== undefined) return current;
  const key = process.env.TRANSCRIBE_API_KEY?.trim();
  return (current = key ? openaiTranscriber(key, process.env.TRANSCRIBE_BASE_URL?.trim() || undefined, process.env.TRANSCRIBE_MODEL?.trim() || undefined) : null);
};
/** Tests (and a different provider later) replace it. */
export const setTranscriber = (t: Transcriber | null) => { current = t; };
