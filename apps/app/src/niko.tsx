// Shared Niko state: who is signed in, and the voice loop (wake word, commands, speech).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { EnginePrefs, Me } from '@niko/shared';
import { api, setAppearance, type CoreMode } from '@niko/ui';

export interface Brief {
  mail: { id: string; from: string; subject: string; source: string; provider: string }[];
  events: { time: string; title: string; source: string }[];
  notes: { title: string; source: string }[];
  chats: { provider: string; chatId: string; title: string; last: string; source: string }[];
  problems: string[];
}

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
  /** Why ElevenLabs could not speak, when Niko fell back to the device voice. */
  voiceProblem: string | null;
}

const Ctx = createContext<NikoState>(null as never);
export const useNiko = () => useContext(Ctx);

const NAV: [RegExp, string][] = [
  [/\b(inbox|mail|messages?)\b/, '/inbox'], [/\bcalendar\b/, '/calendar'], [/\bnotes?\b/, '/notes'], [/\bconnections?\b/, '/connections'],
  [/\bengine\b/, '/engine'], [/\b(voice|speech)\b/, '/voice'], [/\bsettings\b/, '/appearance'], [/\b(appearance|colou?rs?)\b/, '/appearance'], [/\baccount\b/, '/account'], [/\bhome\b/, '/'],
];

/** "Niko" as speech recognisers write it: Niko, Nico, Nikko, Nicko, Neko, Neeko, Nicco, optionally after "hey"/"ok".
 * Returns what was said after the name (empty if the name was said alone), or null if the name wasn't heard. */
const WAKE = /(?:^|[^a-z])(?:(?:hey|hi|ok|okay)[\s,]+)?n(?:i|ee|e|y)(?:k|c|ck|kk|cc|q)h?o[h]?(?![a-z])[\s,.!?:;-]*(.*)$/i;
export function matchWake(text: string): { command: string } | null {
  const m = WAKE.exec(text);
  return m ? { command: (m[1] ?? '').trim() } : null;
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
  const [voiceProblem, setVoiceProblem] = useState<string | null>(null);
  const SR: any = typeof window !== 'undefined' ? (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition : null;

  const refreshMe = useCallback(async () => {
    try { const m = await api<Me>('/me'); setMe(m); meRef.current = m; setAppearance(m.appearance); }
    catch { setMe(null); meRef.current = null; setAppearance(null); }
  }, []);
  useEffect(() => { void refreshMe(); }, [refreshMe]);

  const idle = useCallback(() => {
    setMode('idle'); setLabel('Standing by');
    const wake = (meRef.current?.engine as EnginePrefs | undefined)?.wake;
    setLine(SR && wake ? 'Say “Niko” to start, or tap the mic.' : 'Tap the mic or type to ask.');
  }, [SR]);
  useEffect(() => { if (me) idle(); }, [me, idle]);

  const stopSpeech = () => { speaking.current = false; window.speechSynthesis?.cancel(); audio.current?.pause(); audio.current = null; };
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

  const say = useCallback((text: string) => {
    const engine = meRef.current?.engine as EnginePrefs | undefined;
    const done = () => listenForFollowUp();
    const device = () => {
      if (!window.speechSynthesis) return done();
      const u = new SpeechSynthesisUtterance(text);
      u.onend = done; u.onerror = done;
      window.speechSynthesis.speak(u);
    };
    stopSpeech(); endFollowUp();
    speaking.current = true;
    setMode('speaking'); setLabel('Speaking'); setLine(text.length > 160 ? text.slice(0, 157) + '…' : text);
    if (engine?.voice === 'elevenlabs') {
      fetch('/api/voice/tts', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
        .then(async (r) => {
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'ElevenLabs could not speak.');
          setVoiceProblem(null);
          const url = URL.createObjectURL(await r.blob());
          const a = new Audio(url);
          audio.current = a; a.onended = () => { URL.revokeObjectURL(url); done(); }; a.onerror = done;
          await a.play();
        })
        .catch((e: Error) => { setVoiceProblem(e.message); device(); }); // free device voice is the fallback
    } else device();
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
    if (!SR || rec.current) return;
    const r = new SR();
    r.continuous = true; r.interimResults = true; r.maxAlternatives = 3; r.lang = navigator.language || 'en-US';
    r.onresult = (ev: any) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
      if (speaking.current) continue; // Niko's own voice
        // Recognisers often spell the name differently in their first guess, so check every alternative.
        const alts: string[] = Array.from({ length: res.length }, (_, k) => String(res[k]?.transcript ?? '').trim());
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
    r.onend = () => { rec.current = null; if (wantRec.current) setTimeout(startRec, 300); else setMicOn(false); };
    r.onerror = (ev: any) => {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        // Some browsers (Safari, iOS) only allow listening after a tap. One tap on the mic keeps it on from then on.
        wantRec.current = false; setMicOn(false);
        setLabel('Mic is off'); setLine('Tap the mic once so Niko can listen for its name.');
      }
    };
    try { r.start(); rec.current = r; setMicOn(true); } catch { /* already started */ }
  }, [SR, ask]);

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
    voiceProblem,
  }), [me, refreshMe, mode, label, line, reply, brief, micOn, SR, toggleMic, stop, ask, say, voiceProblem]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
