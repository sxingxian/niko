// Shared Niko state: who is signed in, and the voice loop (wake word, commands, speech).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { voiceOrder, type Brief, type EnginePrefs, type Me, type VoiceSource } from '@niko/shared';
import { isEcho, matchWake } from './speech';
import { kokoroLoaded, kokoroReady, kokoroSpeak, kokoroTooSlow, kokoroWarm, type Speech } from './kokoro';
import { api, setAppearance, type CoreMode } from '@niko/ui';

export type { Brief } from '@niko/shared';

interface NikoState {
  me: Me | null | undefined; // undefined while loading
  refreshMe: () => Promise<void>;
  mode: CoreMode;
  label: string;
  line: string;
  reply: string | null;
  brief: Brief | null;
  micOn: boolean;
  voiceSupported: boolean;
  toggleMic: () => void;
  stop: () => void;
  ask: (text: string) => Promise<void>;
  dismissReply: () => void;
  /** A page (the workspace) can claim "send it" / "cancel". Returns true when it handled the phrase. */
  setCommandHandler: (fn: ((phrase: string) => boolean) | null) => void;
  say: (text: string) => void;
  setStatus: (label: string, line: string, mode?: CoreMode) => void;
  /** Back to the resting label and line ("Standing by"). */
  rest: () => void;
  /** Why ElevenLabs could not speak, when Niko fell back to the device voice. */
  voiceProblem: string | null;
}

const Ctx = createContext<NikoState>(null as never);
export const useNiko = () => useContext(Ctx);

const NAV: [RegExp, string][] = [
  [/\b(inbox|mail|messages?)\b/, '/inbox'], [/\bcalendar\b/, '/calendar'], [/\bnotes?\b/, '/notes'], [/\bconnections?\b/, '/connections'],
  [/\bengine\b/, '/engine'], [/\b(voice|speech)\b/, '/voice'], [/\bsettings\b/, '/appearance'], [/\b(appearance|colou?rs?)\b/, '/appearance'], [/\baccount\b/, '/account'], [/\bhome\b/, '/'],
];

/** One voice made on Niko's server (Cloudflare, the user's own server, ElevenLabs), played as audio. */
function serverSpeech(source: VoiceSource, text: string): Speech {
  const ctl = new AbortController();
  let el: HTMLAudioElement | null = null, url = '';
  let resolveDone!: () => void;
  const done = new Promise<void>((a) => { resolveDone = a; });
  const cleanup = () => { if (url) URL.revokeObjectURL(url); url = ''; resolveDone(); };
  const started = (async () => {
    const timer = window.setTimeout(() => ctl.abort(), 15_000);
    try {
      const r = await fetch('/api/voice/tts', { method: 'POST', credentials: 'same-origin', signal: ctl.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, source }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'That voice could not speak.');
      url = URL.createObjectURL(await r.blob());
      el = new Audio(url);
      el.onended = cleanup; el.onerror = cleanup;
      await el.play();
    } catch (e) {
      cleanup();
      throw new Error(ctl.signal.aborted ? 'That voice took too long to answer.' : (e as Error).message);
    } finally { window.clearTimeout(timer); }
  })();
  return { started, done, stop: () => { ctl.abort(); el?.pause(); cleanup(); } };
}
function speakWith(source: VoiceSource, text: string, engine: EnginePrefs | undefined): Speech {
  return source === 'kokoro' ? kokoroSpeak(text, engine?.kokoroVoice ?? 'af_heart') : serverSpeech(source, text);
}

export function NikoProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [mode, setMode] = useState<CoreMode>('idle');
  const [label, setLabel] = useState('Standing by');
  const [line, setLine] = useState('');
  const [reply, setReply] = useState<string | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [micOn, setMicOn] = useState(false);
  const navigate = useNavigate();
  const handler = useRef<((p: string) => boolean) | null>(null);
  const rec = useRef<any>(null);
  const active = useRef(false); // true after the mic button: the next phrase is a command even without "Niko"
  const meRef = useRef<Me | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const wantRec = useRef(false); // keep the recogniser running (wake word on, or the mic was tapped)
  const speaking = useRef(false); // while Niko talks, what the mic hears is Niko itself, so it is ignored
  const followUp = useRef<number | undefined>(undefined);
  const startRecRef = useRef<() => void>(() => undefined);
  // Niko's last line and when it finished, so its own voice heard late through the mic is never taken as a question.
  const lastSaid = useRef<{ text: string; until: number }>({ text: '', until: 0 });
  const ECHO_MS = 6000;
  /** The mic is switched off while Niko talks: whatever it was holding (Niko's own voice) is thrown away. */
  const muteMic = () => { try { rec.current?.abort(); } catch { /* not running */ } rec.current = null; };
  const unmuteMic = () => { if (wantRec.current && !rec.current) startRecRef.current(); };
  const [voiceProblem, setVoiceProblem] = useState<string | null>(null);
  const SR: any = typeof window !== 'undefined' ? (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition : null;

  const refreshMe = useCallback(async () => {
    try { const m = await api<Me>('/me'); setMe(m); meRef.current = m; setAppearance(m.appearance); }
    catch { setMe(null); meRef.current = null; setAppearance(null); }
  }, []);
  useEffect(() => { void refreshMe(); }, [refreshMe]);
  // The on-device voice's engine starts in the background, so it is ready by the time Niko speaks.
  // Only on the screens where Niko speaks (Home and the workspace), not on Settings or sign-in pages.
  const path = useLocation().pathname;
  const speaksHere = /^\/(inbox|calendar|notes)?$/.test(path.replace(/^\/app(?=\/|$)/, '') || '/');
  useEffect(() => { if (me && speaksHere && voiceOrder(me.engine).includes('kokoro')) kokoroWarm(); }, [me, speaksHere]);

  const idle = useCallback(() => {
    setMode('idle'); setLabel('Standing by');
    const wake = (meRef.current?.engine as EnginePrefs | undefined)?.wake;
    setLine(SR && wake ? 'Say “Niko” to start, or tap the mic.' : 'Tap the mic or type to ask.');
  }, [SR]);
  useEffect(() => { if (me) idle(); }, [me, idle]);

  // Each line Niko says gets a number; anything still arriving for an older line is dropped.
  const speechId = useRef(0);
  const current = useRef<{ stop: () => void } | null>(null);
  const stopSpeech = () => {
    const was = speaking.current;
    speechId.current++; speaking.current = false;
    window.speechSynthesis?.cancel(); audio.current?.pause(); audio.current = null;
    current.current?.stop(); current.current = null;
    if (was) { lastSaid.current.until = Date.now() + ECHO_MS; window.setTimeout(unmuteMic, 300); }
  };
  const endFollowUp = () => { window.clearTimeout(followUp.current); followUp.current = undefined; };

  /** After Niko answers, keep listening for a few seconds so the conversation can carry on without saying "Niko" again. */
  const FOLLOW_UP_MS = 9000;
  const listenForFollowUp = useCallback(() => {
    speaking.current = false;
    if (!SR || !wantRec.current) return idle();
    active.current = true;
    setMode('listening'); setLabel('Listening'); setLine('Go on, or say “that’s all”.');
    endFollowUp();
    followUp.current = window.setTimeout(() => { active.current = false; followUp.current = undefined; idle(); }, FOLLOW_UP_MS);
  }, [SR, idle]);

  /** Speaks with the first voice in the user's order that works, ending with the device voice. */
  const say = useCallback((text: string) => {
    const engine = meRef.current?.engine as EnginePrefs | undefined;
    stopSpeech(); endFollowUp();
    const id = speechId.current;
    const live = () => id === speechId.current;
    // When Niko has finished: a short pause (the speaker's last sound fades), then the mic comes back for the follow-up.
    const done = () => {
      if (!live()) return;
      lastSaid.current = { text, until: Date.now() + ECHO_MS };
      window.setTimeout(() => { if (!live()) return; speaking.current = false; unmuteMic(); listenForFollowUp(); }, 450);
    };
    speaking.current = true;
    lastSaid.current = { text, until: Number.POSITIVE_INFINITY };
    muteMic();
    setMode('speaking'); setLabel('Speaking'); setLine(text.length > 160 ? text.slice(0, 157) + '…' : text);
    const device = () => {
      if (!window.speechSynthesis) return done();
      const u = new SpeechSynthesisUtterance(text);
      u.onend = done; u.onerror = done;
      window.speechSynthesis.speak(u);
    };
    void (async () => {
      let first: string | null = null; // why the first choice could not speak, shown on the home screen
      for (const source of voiceOrder(engine)) {
        if (!live()) return;
        // Never starts a large download by itself, and does not wait while its engine is still starting up.
        // …and is skipped on a device too slow to keep up with its own speech.
        if (source === 'kokoro' && (!kokoroReady() || !kokoroLoaded() || kokoroTooSlow())) { if (kokoroReady()) kokoroWarm(); continue; }
        const s = speakWith(source, text, engine);
        current.current = s;
        try {
          await s.started;
          if (!live()) return s.stop();
          setVoiceProblem(first);
          await s.done;
          return done();
        } catch (e) {
          if (!live()) return;
          first ??= (e as Error).message;
        }
      }
      if (!live()) return;
      setVoiceProblem(first);
      device();
    })();
  }, [listenForFollowUp]);

  const ask = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    const lower = text.toLowerCase();
    endFollowUp();
    // Ending the conversation.
    if (/^(that'?s all|that is all|thanks?( you)?|thank you niko|stop|never ?mind|cancel that|bye)\b[.!]?$/.test(lower)) { active.current = false; stopSpeech(); idle(); return; }
    setReply(null);
    // 1. Phrases a page has claimed (send it / cancel).
    if (handler.current?.(lower)) return;
    // 2. Navigation by voice: "open my inbox", "go home".
    if (/^(open|show|go( to)?|take me to)\b/.test(lower)) {
      const hit = NAV.find(([re]) => re.test(lower));
      if (hit) { setMode('speaking'); setLabel('Heard'); setLine(`“Niko, ${text}”`); navigate(hit[1]); setTimeout(idle, 1400); return; }
    }
    // 3. Everything else goes to the brain.
    setMode('listening'); setLabel('Thinking'); setLine(`“${text}”`);
    try {
      const r = await api<{ reply: string; brief: Brief }>('/chat', { body: { message: text, tz: new Date().getTimezoneOffset() } });
      setBrief(r.brief); setReply(r.reply); say(r.reply);
    } catch (e: any) {
      if (e?.data?.brief) setBrief(e.data.brief);
      setReply(e.message); setMode('idle'); setLabel('Problem'); setLine(e.message);
    }
  }, [navigate, idle, say]);

  // Speech recognition: runs while the app is open and the mic is allowed.
  // Interim results let the core react the moment "Niko" is heard; the command itself is taken from the final text.
  const startRec = useCallback(() => {
    if (!SR || rec.current || speaking.current) return;
    const r = new SR();
    r.continuous = true; r.interimResults = true; r.maxAlternatives = 3; r.lang = navigator.language || 'en-US';
    r.onresult = (ev: any) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (speaking.current || rec.current !== r) continue; // Niko's own voice, or a recogniser already switched off
        // Recognisers often spell the name differently in their first guess, so check every alternative.
        const alts: string[] = Array.from({ length: res.length }, (_, k) => String(res[k]?.transcript ?? '').trim());
        // Niko's own last line, heard late through the speaker: never a question.
        if (res.isFinal && Date.now() < lastSaid.current.until && alts[0] && isEcho(alts[0], lastSaid.current.text) && !alts.some((a) => matchWake(a)?.command)) continue;
        const hit = alts.map(matchWake).find(Boolean);
        if (!res.isFinal) {
          if (hit && !active.current) { setMode('listening'); setLabel('Listening'); setLine('Go ahead.'); }
          continue;
        }
        if (hit) {
          if (hit.command) { active.current = false; void ask(hit.command); }
          else { active.current = true; setMode('listening'); setLabel('Listening'); setLine('Go ahead.'); }
        } else if (active.current && alts[0]) { active.current = false; endFollowUp(); void ask(alts[0]); }
      }
    };
    r.onend = () => {
      if (rec.current === r) rec.current = null;
      // Restarts on its own (browsers stop listening after a while), except while Niko talks: say() brings it back.
      if (wantRec.current && !speaking.current) setTimeout(startRec, 300); else if (!wantRec.current) setMicOn(false);
    };
    r.onerror = (ev: any) => {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        // Some browsers (Safari, iOS) only allow listening after a tap. One tap on the mic keeps it on from then on.
        wantRec.current = false; setMicOn(false);
        setLabel('Mic is off'); setLine('Tap the mic once so Niko can listen for its name.');
      }
    };
    try { r.start(); rec.current = r; setMicOn(true); } catch { /* already started */ }
  }, [SR, ask]);
  startRecRef.current = startRec;

  useEffect(() => {
    // Wake word listening starts only if the user enabled it, and only after sign-in.
    const wake = (me?.engine as EnginePrefs | undefined)?.wake;
    if (me && wake && SR) { wantRec.current = true; startRec(); }
    return () => { wantRec.current = false; try { rec.current?.stop(); } catch { /* noop */ } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id, (me?.engine as any)?.wake]);

  const toggleMic = useCallback(() => {
    stopSpeech();
    if (!SR) { setLabel('No microphone'); setLine('This browser cannot listen. Type instead.'); return; }
    endFollowUp();
    wantRec.current = true; startRec();
    active.current = true; setMode('listening'); setLabel('Listening'); setLine('Go ahead.');
  }, [SR, startRec]);

  const stop = useCallback(() => { stopSpeech(); endFollowUp(); active.current = false; idle(); }, [idle]);

  const value = useMemo<NikoState>(() => ({
    me, refreshMe, mode, label, line, reply, brief, micOn, voiceSupported: !!SR, toggleMic, stop, ask,
    dismissReply: () => setReply(null),
    setCommandHandler: (fn) => { handler.current = fn; },
    say,
    setStatus: (l, t, m) => { setLabel(l); setLine(t); if (m) setMode(m); },
    rest: idle,
    voiceProblem,
  }), [me, refreshMe, mode, label, line, reply, brief, micOn, SR, toggleMic, stop, ask, say, voiceProblem, idle]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
