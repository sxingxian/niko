// Shared Niko state: who is signed in, and the voice loop (wake word, commands, speech).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { useLocation, useNavigate } from 'react-router-dom';
import { speakable, stripTags, aiAllowed, mapsOn, hearOption, voiceOption, hearOrder, isWeatherQuestion, voiceOrder, minutesText, MAP_MODES, type MapAskMode, type Brief, type EnginePrefs, type MapMode, type MapResult, type Me, type VoiceSource, type WeatherCard } from '@niko/shared';
import { enterFullscreen, exitFullscreen, fullscreenSupported } from './fullscreen';
import { countryCommand, fullscreenCommand, isEcho, matchWake, resumeIntent, sentenceStart, screenFor, screenName, scrollRequest, takeImageTag, takeItemTag, takeMapTag, takeMoveTags, takeScreenTag } from './speech';
import { scrollScreen } from './scroll';
import { captureSupported, captureUtterance, transcribe, type Capture } from './listen';
import { kokoroLoaded, kokoroReady, kokoroSpeak, kokoroTooSlow, kokoroWarm, type Speech } from './kokoro';
import { api, ApiError, setAppearance, type CoreMode } from '@niko/ui';

export type { Brief } from '@niko/shared';

/** A picture Niko made (or is making) in this visit. Pictures live only in the page's memory and go when it closes. */
export interface PictureItem {
  id: number; prompt: string; shape: 'square' | 'wide' | 'tall'; status: 'painting' | 'done' | 'failed'; started: number;
  url?: string; type?: string; label?: string; ms?: number; error?: string;
  /** The person's own words for it: a plainer prompt for a service whose filter turns down the detailed one. */
  asked?: string;
}
const MAX_PICTURES = 8;

/** The map on Home. The location used for it stays in this page's memory for a few minutes and is never stored. */
export interface MapView {
  id: number; to: string; from?: string; mode: MapAskMode;
  /** explain: Niko says why it asks for the location, before the browser asks. */
  status: 'explain' | 'loading' | 'done' | 'failed';
  result?: MapResult; error?: string;
  /** Times found so far for each way of travelling, for the tabs. */
  times: Partial<Record<MapMode, number>>;
  /** Whether the location was used: yes, no (refused or unavailable). */
  located: boolean;
}
/** Which country's map services: from the location ('auto'), the Worldwide list ('ww'), or one the person said. */
export type MapCountry = 'auto' | 'ww' | string;
const MODE_KEY = 'niko.mapMode';
const lastMode = (): MapMode => { try { const m = localStorage.getItem(MODE_KEY) as MapMode | null; return m && MAP_MODES.includes(m) ? m : 'drive'; } catch { return 'drive'; } };
const keepMode = (m: MapMode) => { try { localStorage.setItem(MODE_KEY, m); } catch { /* private mode */ } };
/** This device's location for a route's start (to about 10 m), if the browser has it or the user allows it now. */
function whereExactly(): Promise<{ lat: number; lng: number } | undefined> {
  if (!('geolocation' in navigator)) return Promise.resolve(undefined);
  return new Promise((done) => {
    const r4 = (v: number) => Math.round(v * 10000) / 10000;
    const stop = window.setTimeout(() => done(undefined), 12000);
    navigator.geolocation.getCurrentPosition(
      (p) => { window.clearTimeout(stop); done({ lat: r4(p.coords.latitude), lng: r4(p.coords.longitude) }); },
      () => { window.clearTimeout(stop); done(undefined); },
      { enableHighAccuracy: false, maximumAge: 60_000, timeout: 11000 },
    );
  });
}
async function locationPermission(): Promise<PermissionState | 'unknown'> {
  try { return (await navigator.permissions.query({ name: 'geolocation' as PermissionName })).state; } catch { return 'unknown'; }
}
const MODE_WORDS: Record<MapMode | 'fly', string> = { drive: 'by car', transit: 'by public transport', walk: 'on foot', cycle: 'by bike', fly: 'of flying, roughly' };

interface NikoState {
  me: Me | null | undefined; // undefined while loading
  refreshMe: () => Promise<void>;
  mode: CoreMode;
  label: string;
  line: string;
  reply: string | null;
  /** The weather card for the answer it came with (shown instead of that answer's text). */
  weather: { for: string; card: WeatherCard } | null;
  brief: Brief | null;
  micOn: boolean;
  voiceSupported: boolean;
  toggleMic: () => void;
  stop: () => void;
  ask: (text: string) => Promise<void>;
  /** After a stop: true when there is an answer to carry on, or a question to ask again. */
  resumable: { canContinue: boolean } | null;
  /** Carries on the stopped answer from the sentence where it stopped. */
  resume: () => void;
  /** Asks the last question again for a fresh answer. */
  retry: () => void;
  dismissReply: () => void;
  /** A page (the workspace) can claim "send it" / "cancel". Returns true when it handled the phrase. */
  setCommandHandler: (fn: ((phrase: string, quiet?: boolean) => boolean) | null) => void;
  /** New items on Home claim "open it", "reply" and "dismiss" while one is showing; asked before the page's own. */
  setGlanceHandler: (fn: ((phrase: string) => boolean) | null) => void;
  /** Opens one item on Inbox, Calendar or Notes (as the AI's [[item:…]] does). */
  openItem: (view: 'inbox' | 'calendar' | 'notes', title: string) => void;
  say: (text: string) => void;
  setStatus: (label: string, line: string, mode?: CoreMode) => void;
  /** Back to the resting label and line ("Standing by"). */
  rest: () => void;
  /** After an action by voice: keep listening a few seconds for the next request (or rest if the mic is off). */
  carryOn: () => void;
  /** Why ElevenLabs could not speak, when Niko fell back to the device voice. */
  voiceProblem: string | null;
  /** An item the AI was asked to open (on Inbox, Calendar or Notes); the workspace opens it and clears it. */
  pendingOpen: { view: 'inbox' | 'calendar' | 'notes'; title: string; at: number } | null;
  clearPendingOpen: () => void;
  /** Pictures made in this visit (oldest first), and the one on screen. */
  pictures: PictureItem[];
  picture: PictureItem | null;
  paintPicture: (prompt: string, shape: PictureItem['shape'], more?: boolean, asked?: string) => void;
  showPicture: (id: number) => void;
  closePicture: () => void;
  /** The map on Home, and what can be changed on it. */
  map: MapView | null;
  mapCountry: MapCountry;
  showMap: (to: string, from?: string, how?: MapAskMode | 'any') => void;
  setMapMode: (m: MapMode | 'fly') => void;
  setMapCountry: (c: MapCountry) => void;
  /** The answer to Niko's question about the location: allow (the browser then asks) or use Worldwide. */
  answerLocation: (allow: boolean) => void;
  closeMap: () => void;
  /** Asked for full screen by voice, which browsers allow only after a tap: Niko shows a button to tap. */
  fullscreenAsk: boolean;
  answerFullscreen: (go: boolean) => void;
  /** Screen lock: locked now (the server agrees), and the code entry when it is showing (with why it is asked). */
  locked: boolean;
  lockAsk: { reason: string } | null;
  /** Shows the code entry; `then` runs once unlocked (the question asked while locked, or opening an item). */
  requestUnlock: (reason?: string, then?: () => void) => void;
  cancelUnlock: () => void;
  unlock: (code: string) => Promise<UnlockResult>;
  unlockWithPasskey: () => Promise<UnlockResult>;
  lockNow: () => void;
}
export type UnlockResult = { ok: true } | { ok: false; error: string; left?: number; signedOut?: boolean };
const ASK_CODE = 'Enter your code. Niko will answer once you’re in.';
/** "Niko, lock", "lock the screen", "lock up". */
const LOCK_COMMAND = /^(please )?lock( (it|now|up|niko|the screen|the app|yourself|this))*( now)?( please)?$/;

const Ctx = createContext<NikoState>(null as never);
export const useNiko = () => useContext(Ctx);


/** Voices to skip on this device until a time, as the server last said (it also keeps them on the account). */
const restingVoices = new Map<string, number>();
const isResting = (v: string, e: EnginePrefs | undefined) => Math.max(restingVoices.get(v) ?? 0, e?.voiceRest?.[v]?.until ?? 0) > Date.now();
/** One voice made on Niko's server (Cloudflare, the user's own server, a voice key), played as audio. */
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
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        // The server says how long to skip this voice for (usage limit, refused key, no answer).
        if (j?.rest?.until) restingVoices.set(source, j.rest.until);
        // Not available on this account (the admin turned it off): skipped until the page is next loaded.
        if (r.status === 403) restingVoices.set(source, Number.MAX_SAFE_INTEGER);
        throw new Error(j.error ?? 'That voice could not speak.');
      }
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
/** This device's location, rounded to about 1 km, if the browser has it or the user allows it now. Never stored. */
function whereAmI(): Promise<{ lat: number; lon: number } | undefined> {
  if (!('geolocation' in navigator)) return Promise.resolve(undefined);
  return new Promise((done) => {
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const stop = window.setTimeout(() => done(undefined), 8000);
    navigator.geolocation.getCurrentPosition(
      (p) => { window.clearTimeout(stop); done({ lat: r2(p.coords.latitude), lon: r2(p.coords.longitude) }); },
      () => { window.clearTimeout(stop); done(undefined); },
      { enableHighAccuracy: false, maximumAge: 15 * 60_000, timeout: 7000 },
    );
  });
}

function speakWith(source: VoiceSource, raw: string, engine: EnginePrefs | undefined): Speech {
  // The voice gets the text without symbols ("**", "#", "—"); the screen shows the answer itself.
  const text = speakable(raw) || raw;
  return source === 'kokoro' ? kokoroSpeak(text, engine?.kokoroVoice ?? 'af_heart') : serverSpeech(source, text);
}

export function NikoProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [mode, setMode] = useState<CoreMode>('idle');
  const [label, setLabel] = useState('Standing by');
  const [line, setLine] = useState('');
  const [reply, setReply] = useState<string | null>(null);
  const [weather, setWeather] = useState<{ for: string; card: WeatherCard } | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [micOn, setMicOn] = useState(false);
  const navigate = useNavigate();
  const handler = useRef<((p: string, quiet?: boolean) => boolean) | null>(null);
  const glanceHandler = useRef<((p: string) => boolean) | null>(null);
  const rec = useRef<any>(null);
  const active = useRef(false); // true after the mic button: the next phrase is a command even without "Niko"
  const meRef = useRef<Me | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const wantRec = useRef(false); // keep the recogniser running (wake word on, or the mic was tapped)
  const speaking = useRef(false); // while Niko talks, what the mic hears is Niko itself, so it is ignored
  const followUp = useRef<number | undefined>(undefined);
  const startRecRef = useRef<() => void>(() => undefined);
  // Speech in through a service (Voice → Listening): one request is recorded and sent, instead of the device's own recognition.
  const capture = useRef<Capture | null>(null);
  const askRef = useRef<(t: string) => void>(() => undefined);
  /** Speech-in services this account may use: keys go by their service on the server, so here only the section and the
   * built-in services are checked; a key the admin turned off is refused there, and the device then listens. */
  const hearsFor = (m: Me | null | undefined) => { const off = m?.aiOff ?? []; return off.includes('sec:hears') ? [] : hearOrder(m?.engine as EnginePrefs | undefined).filter((e) => e.startsWith('skey:') || aiAllowed(off, hearOption(e))); };
  const apiHearing = () => hearsFor(meRef.current).length > 0 && captureSupported();
  // Niko's last line and when it finished, so its own voice heard late through the mic is never taken as a question.
  const lastSaid = useRef<{ text: string; until: number }>({ text: '', until: 0 });
  const ECHO_MS = 6000;
  /** The mic is switched off while Niko talks: whatever it was holding (Niko's own voice) is thrown away. */
  const muteMic = () => { try { rec.current?.abort(); } catch { /* not running */ } rec.current = null; };
  const unmuteMic = () => { if (wantRec.current && !rec.current) startRecRef.current(); };
  // The last question and Niko's answer, and where a stopped answer picks up again ("continue").
  const last = useRef<{ question: string; answer: string | null; from: number } | null>(null);
  const [resumable, setResumable] = useState<{ canContinue: boolean } | null>(null);
  const resumableRef = useRef(resumable);
  resumableRef.current = resumable;
  // What is being said now: when it started, with which voice, and the last word position the voice reported.
  const progress = useRef<{ text: string; base: number; startAt: number; source: string; heard: number } | null>(null);
  // How fast each voice speaks (characters per second), learnt from lines it finished, for working out where it stopped.
  const rates = useRef<Record<string, number>>({});
  // Each question to the AI gets a number; an answer arriving after Stop (or after a newer question) is kept, not spoken.
  const askId = useRef(0);
  const inFlight = useRef(0); // the number of the question still waiting for its answer, or 0
  const [voiceProblem, setVoiceProblem] = useState<string | null>(null);
  const [pendingOpen, setPendingOpen] = useState<NikoState['pendingOpen']>(null);
  const [pictures, setPictures] = useState<PictureItem[]>([]);
  const [map, setMap] = useState<MapView | null>(null);
  const [fullscreenAsk, setFullscreenAsk] = useState(false);
  const fsTimer = useRef<number | undefined>(undefined);
  const mapRef = useRef<MapView | null>(null);
  const [mapCountry, setMapCountryState] = useState<MapCountry>('auto');
  const mapCountryRef = useRef<MapCountry>('auto');
  /** The location for maps, for a few minutes; refused: the person said no in this visit, so Niko doesn't ask again. */
  const mapHere = useRef<{ lat: number; lng: number; at: number } | null>(null);
  const mapRefused = useRef(false);
  const mapCtl = useRef<AbortController | null>(null);
  const mapSeq = useRef(0);
  const locationWait = useRef<((allow: boolean) => void) | null>(null);
  const [pictureId, setPictureId] = useState<number | null>(null);
  const picturesRef = useRef<PictureItem[]>([]);
  const picSeq = useRef(0);
  const picCtl = useRef<AbortController | null>(null);
  /** Changes the list of pictures, letting go of the memory of any that drop off the end. */
  const updatePictures = (fn: (p: PictureItem[]) => PictureItem[]) => {
    const next = fn(picturesRef.current);
    while (next.length > MAX_PICTURES) { const old = next.shift()!; if (old.url) URL.revokeObjectURL(old.url); }
    picturesRef.current = next; setPictures(next);
  };
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
  useEffect(() => { if (me && speaksHere && voiceOrder(me.engine).includes('kokoro') && aiAllowed(me.aiOff ?? [], 'v:kokoro')) kokoroWarm(); }, [me, speaksHere]);

  const lockedRef = useRef(false);
  const idle = useCallback(() => {
    setMode('idle');
    const wake = (meRef.current?.engine as EnginePrefs | undefined)?.wake;
    if (lockedRef.current) { setLabel('Locked'); setLine(SR && wake ? 'Say “Niko” or tap to unlock.' : 'Tap to unlock.'); return; }
    setLabel('Standing by');
    setLine(SR && wake ? 'Say “Niko” to start, or tap the mic.' : 'Tap the mic or type to ask.');
  }, [SR]);
  useEffect(() => { if (me) idle(); }, [me, idle]);

  /** Records one request and has a speech-to-text service turn it into words. If none of them can, the device's own
   * recognition takes over for the next try. The device recogniser lets go of the mic meanwhile, and comes back after. */
  /** keep: the line on screen stays (after a stop it says what to say next, and the mic listens for it). */
  const listenByApi = useCallback((waitMs: number, keep = false) => {
    capture.current?.cancel();
    muteMic();
    active.current = false;
    setMode('listening');
    if (!keep) { setLabel('Listening'); setLine('Go ahead.'); }
    const cap = captureUtterance({ waitMs, onSpeech: () => { setLabel('Listening'); setLine('Listening…'); } });
    capture.current = cap;
    void (async () => {
      const wav = await cap.done;
      if (capture.current !== cap) return;
      capture.current = null;
      if (!wav) { unmuteMic(); endListeningRef.current(); return; }
      setMode('thinking'); setLabel('Hearing'); setLine('Turning that into words…');
      try {
        const r = await transcribe(wav);
        unmuteMic();
        if (!r.text.trim()) { setMode('idle'); setLabel('Didn’t catch that'); setLine('Say it again, or tap the mic.'); return; }
        askRef.current(r.text.trim());
      } catch (e) {
        if (SR) {
          // None of the services could hear it: the device's own recognition listens for the next try.
          setVoiceProblem(`Speech in: ${(e as Error).message}`);
          active.current = true; wantRec.current = true; unmuteMic();
          setMode('listening'); setLabel('Listening'); setLine('That didn’t come through. Say it again.');
          listenWindow();
        } else { unmuteMic(); setMode('idle'); setLabel('Problem'); setLine((e as Error).message); }
      }
    })();
  }, [SR, idle]); // eslint-disable-line react-hooks/exhaustive-deps

  // Each line Niko says gets a number; anything still arriving for an older line is dropped.
  const speechId = useRef(0);
  const current = useRef<{ stop: () => void } | null>(null);
  /** Where a stopped answer picks up: the start of the sentence that was being said. */
  const markStopped = () => {
    const pr = progress.current, l = last.current;
    progress.current = null;
    if (!pr || pr.base < 0 || !l?.answer) return;
    const secs = pr.startAt ? (performance.now() - pr.startAt) / 1000 : 0;
    const heard = pr.heard >= 0 ? pr.heard : secs * (rates.current[pr.source] ?? 14);
    l.from = Math.max(pr.base, sentenceStart(l.answer, pr.base + heard));
    setResumable(l.from < l.answer.length ? { canContinue: true } : { canContinue: false });
  };
  const stopSpeech = () => {
    const was = speaking.current;
    if (was) markStopped();
    speechId.current++; speaking.current = false;
    window.speechSynthesis?.cancel(); audio.current?.pause(); audio.current = null;
    current.current?.stop(); current.current = null;
    if (was) { lastSaid.current.until = Date.now() + ECHO_MS; window.setTimeout(unmuteMic, 300); }
  };
  const endFollowUp = () => { window.clearTimeout(followUp.current); followUp.current = undefined; };
  /** Niko has stopped listening: the status says so, so a silence never leaves "Listening" on screen. With the wake word
   * off, the mic is let go too (tap it again to talk); with it on, Niko goes back to waiting for its name. */
  const endListening = useCallback(() => {
    active.current = false; endFollowUp();
    const wake = !!(meRef.current?.engine as EnginePrefs | undefined)?.wake && !!SR;
    if (!wake) { wantRec.current = false; try { rec.current?.stop(); } catch { /* already stopped */ } setMicOn(false); }
    setMode('idle');
    // A stopped answer can still be carried on: the line keeps saying how (the buttons stay too).
    if (resumableRef.current) {
      setLabel('Stopped');
      setLine(resumableRef.current.canContinue ? (wake ? 'Say “Niko, continue” to carry on, or “Niko, try again”.' : 'Tap Continue to carry on, or Ask again.') : (wake ? 'Say “Niko, try again” to ask once more.' : 'Tap Ask again to ask once more.'));
      return;
    }
    setLabel('Stopped listening');
    setLine(wake ? 'Say “Niko” when you need me, or tap the mic.' : 'Tap the mic when you need me.');
  }, [SR]); // eslint-disable-line react-hooks/exhaustive-deps
  const endListeningRef = useRef(endListening);
  endListeningRef.current = endListening;
  /** How long Niko waits for someone to start talking, after a tap, its name, or an answer. */
  const listenWindow = () => { endFollowUp(); followUp.current = window.setTimeout(() => { followUp.current = undefined; endListeningRef.current(); }, FOLLOW_UP_MS); };

  /** After Niko answers, keep listening for a few seconds so the conversation can carry on without saying "Niko" again. */
  const FOLLOW_UP_MS = 9000;
  /** keep: listen without changing the line on screen. After a stop, an error or the end of an answer the line says
   * what to say next ("Say “continue”…"); replacing it with "Go on" a moment later lost that, and looked like a glitch. */
  const listenForFollowUp = useCallback((keep = false) => {
    speaking.current = false;
    if (!wantRec.current || lockedRef.current) return idle();
    if (apiHearing()) { endFollowUp(); return listenByApi(FOLLOW_UP_MS, keep); }
    if (!SR) return idle();
    active.current = true;
    setMode('listening');
    if (!keep) { setLabel('Listening'); setLine('Go on, or say “that’s all”.'); }
    endFollowUp();
    listenWindow();
  }, [SR, idle]);

  /** Speaks with the first voice in the user's order that works, ending with the device voice. */
  /** afterLabel: once said, the line stays on screen under this label while Niko listens for the reply to it. */
  const say = useCallback((text: string, answerFrom = -1, afterLabel?: string) => {
    const engine = meRef.current?.engine as EnginePrefs | undefined;
    stopSpeech(); endFollowUp(); capture.current?.cancel(); capture.current = null;
    const id = speechId.current;
    const live = () => id === speechId.current;
    // answerFrom ≥ 0: this is (the rest of) the last answer, starting at that character, so a stop can be picked up.
    progress.current = { text, base: answerFrom, startAt: 0, source: '', heard: -1 };
    const began = (source: string) => { if (live() && progress.current) { progress.current.startAt = performance.now(); progress.current.source = source; } };
    // When Niko has finished: a short pause (the speaker's last sound fades), then the mic comes back for the follow-up.
    const done = () => {
      if (!live()) return;
      const pr = progress.current;
      if (pr?.startAt) { const secs = (performance.now() - pr.startAt) / 1000; if (secs > 1.5) rates.current[pr.source] = Math.min(40, Math.max(6, pr.text.length / secs)); }
      if (pr && pr.base >= 0 && last.current?.answer) { last.current.from = last.current.answer.length; setResumable(null); }
      progress.current = null;
      lastSaid.current = { text, until: Date.now() + ECHO_MS };
      window.setTimeout(() => { if (!live()) return; speaking.current = false; unmuteMic(); if (afterLabel) setLabel(afterLabel); listenForFollowUp(!!afterLabel); }, 450);
    };
    speaking.current = true;
    lastSaid.current = { text, until: Number.POSITIVE_INFINITY };
    muteMic();
    setMode('speaking'); setLabel('Speaking'); setLine(text.length > 160 ? text.slice(0, 157) + '…' : text);
    const device = () => {
      if (!window.speechSynthesis) return done();
      const u = new SpeechSynthesisUtterance(speakable(text) || text);
      u.onstart = () => began('device');
      u.onboundary = (e) => { if (live() && progress.current) progress.current.heard = e.charIndex; }; // exact word position
      u.onend = done;
      u.onerror = (e) => {
        if (e.error === 'interrupted' || e.error === 'canceled') return; // Niko stopped it itself
        // The device voice gave up part-way: keep the place, so "continue" carries on from there.
        if (!live()) return;
        markStopped(); speaking.current = false; unmuteMic();
        setMode('idle'); setLabel('Stopped'); setLine('The voice stopped. Say “continue” to carry on, or “try again”.');
        if (wantRec.current) window.setTimeout(() => { if (live()) listenForFollowUp(true); }, 400);
      };
      window.speechSynthesis.speak(u);
    };
    void (async () => {
      let first: string | null = null; // why the first choice could not speak, shown on the home screen
      const off = meRef.current?.aiOff ?? [];
      for (const source of voiceOrder(engine)) {
        if (!live()) return;
        // Voices the admin has turned off for this account are skipped (keys are checked by the server).
        if (off.includes('sec:voices') || (!source.startsWith('vkey:') && !aiAllowed(off, voiceOption(source)))) continue;
        // Never starts a large download by itself, and does not wait while its engine is still starting up.
        // …and is skipped on a device too slow to keep up with its own speech.
        if (source === 'kokoro' && (!kokoroReady() || !kokoroLoaded() || kokoroTooSlow())) { if (kokoroReady()) kokoroWarm(); continue; }
        // A voice that reached its limit or failed is skipped until its rest is over, so speech starts at once.
        if (source !== 'kokoro' && isResting(source, engine)) continue;
        const s = speakWith(source, text, engine);
        current.current = s;
        try {
          await s.started;
          if (!live()) return s.stop();
          began(source);
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

  const here = useRef(path);
  here.current = path;
  /** Opens a screen asked for by voice or typing, says so on the status line, and keeps listening for the next request. */
  const goTo = useCallback((screen: string) => {
    if (screen === 'back') { window.history.back(); setMode('speaking'); setLabel('Heard'); setLine('Going back.'); }
    else {
      const name = screenName(screen);
      setMode('speaking'); setLabel('Heard');
      if (here.current === screen) setLine(`You’re on ${name}.`); else { setLine(`Opening ${name}.`); navigate(screen); }
    }
    window.setTimeout(() => (wantRec.current ? listenForFollowUp() : idle()), 1200);
  }, [navigate, idle, listenForFollowUp, SR]);

  const ask = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    // Lower case without punctuation: speech-to-text services write "Send it." or "Okay, next page."
    const lower = text.toLowerCase().replace(/[.,!?;:"“”…]+/g, ' ').replace(/\s+/g, ' ').trim();
    endFollowUp();
    // Locked: nothing reaches the brain. The question waits and is asked once the code is in. A code is typed, never
    // said, so digits heard by the mic are dropped rather than kept as a question.
    if (lockedRef.current) {
      active.current = false;
      if (/^(that'?s all|never ?mind|cancel|stop|bye)\b/.test(lower)) { cancelUnlockFn(); return; }
      // "Open it" / "reply" to a new item on the locked screen: it asks for the code with its own reason.
      if (glanceHandler.current?.(lower)) return;
      const keep = !/^[\d\s-]+$/.test(lower) && !LOCK_COMMAND.test(lower) && !/^(un ?lock)( niko| it| now)?$/.test(lower) && !resumeIntent(text);
      requestUnlockFn(undefined, keep ? () => askRef.current(text) : undefined);
      return;
    }
    if (LOCK_COMMAND.test(lower)) {
      if (meRef.current?.lock?.on) { stopSpeech(); lockNowFn(); }
      else { setMode('speaking'); setLabel('Heard'); setLine('The screen lock is off. Turn it on in Settings → Account.'); window.setTimeout(() => (wantRec.current ? listenForFollowUp() : idle()), 2200); }
      return;
    }
    // Ending the conversation.
    if (/^(that'?s all|that is all|thanks?( you)?|thank you niko|stop|never ?mind|cancel that|bye)\b[.!]?$/.test(lower)) { active.current = false; stopSpeech(); idle(); return; }
    // After a stop: "continue" carries on the answer, "try again" asks the question again, "repeat" says it again.
    const intent = resumeIntent(text);
    if (intent && last.current) {
      const l = last.current;
      if (intent === 'retry' || !l.answer) { setResumable(null); return askAI(l.question); }
      setReply(l.answer); setResumable(null);
      if (intent === 'replay') { l.from = 0; return say(l.answer, 0); }
      if (l.from >= l.answer.length) { setMode('speaking'); setLabel('Heard'); setLine('That was the end of my answer. Say “repeat” to hear it again.'); window.setTimeout(() => (wantRec.current ? listenForFollowUp(true) : idle()), 1600); return; }
      return say(l.answer.slice(l.from), l.from);
    }
    setReply(null);
    // 1. Phrases a page has claimed (send it / cancel).
    if (glanceHandler.current?.(lower) || handler.current?.(lower)) return;
    // 2. Scrolling: "scroll down", "page up", "back to the top", "keep scrolling".
    const way = scrollRequest(text);
    if (way) {
      const moved = scrollScreen(way);
      setMode('speaking'); setLabel('Heard');
      setLine(moved ? { down: 'Scrolling down.', up: 'Scrolling up.', top: 'Back to the top.', bottom: 'Down to the bottom.' }[way]
        : way === 'down' || way === 'bottom' ? 'That’s the bottom of the page.' : 'That’s the top of the page.');
      window.setTimeout(() => (wantRec.current ? listenForFollowUp() : idle()), 900);
      return;
    }
    // 3. Full screen: "go full screen", "exit full screen".
    const fs = fullscreenCommand(text);
    if (fs) {
      const done = (l: string) => { setMode('speaking'); setLabel('Heard'); setLine(l); window.setTimeout(() => (wantRec.current ? listenForFollowUp() : idle()), 1600); };
      if (fs === 'exit') { setFullscreenAsk(false); void exitFullscreen(); done('Leaving full screen.'); return; }
      if (!fullscreenSupported()) { done('This browser can’t go full screen. Add Niko to your Home Screen to open it without the browser’s bars.'); return; }
      if (await enterFullscreen()) { done('Full screen.'); return; }
      // Browsers only allow full screen right after a tap, so Niko puts a button up to tap, for a few seconds.
      setFullscreenAsk(true);
      window.clearTimeout(fsTimer.current);
      fsTimer.current = window.setTimeout(() => setFullscreenAsk(false), 15_000);
      done('Tap “Go full screen”. Browsers need a tap for this.');
      return;
    }
    // 3b. Which country's maps: "I'm in Korea", "use worldwide". Lasts for this visit.
    const cc = mapsOn(meRef.current?.aiOff ?? []) ? countryCommand(text) : null;
    if (cc) {
      setMapCountryFn(cc);
      const listed = cc !== 'ww' && !!meRef.current?.engine.mapCountries?.[cc]?.length;
      const name = cc === 'ww' ? '' : (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc) ?? cc; } catch { return cc; } })();
      setMode('speaking'); setLabel('Heard');
      setLine(cc === 'ww' ? 'Using the Worldwide map services.' : listed ? `Using the map services for ${name}.` : `${name} has no list of its own, so I’ll use the Worldwide map services.`);
      window.setTimeout(() => (wantRec.current ? listenForFollowUp() : idle()), 1400);
      return;
    }
    // 4. Changing screen by voice: "switch to calendar", "can you open my notes", "back to home", "go back".
    const screen = screenFor(text);
    if (screen) { goTo(screen); return; }
    // 5. Everything else goes to the brain.
    return askAI(text);
  }, [navigate, idle, say, goTo, listenForFollowUp, SR]); // eslint-disable-line react-hooks/exhaustive-deps

  const askAI = async (text: string) => {
    const mine = ++askId.current;
    inFlight.current = mine;
    last.current = { question: text, answer: null, from: 0 };
    setResumable(null); setReply(null);
    setMode('thinking'); setLabel('Thinking'); setLine(`“${text}”`);
    try {
      // A weather question carries where this device is, rounded to about 1 km, when a weather service is connected.
      const where = meRef.current?.weather && isWeatherQuestion(text) ? await whereAmI() : undefined;
      const r = await api<{ reply: string; brief: Brief; weather?: WeatherCard }>('/chat', { body: { message: text, tz: new Date().getTimezoneOffset(), ...(where ? { where } : {}) } }).finally(() => { if (inFlight.current === mine) inFlight.current = 0; });
      // The AI can also ask for a screen ([[open:calendar]]), for phrasings the list above doesn't know.
      // …or an item to open ([[item:notes:Testing 123]]): Niko goes to that screen and the workspace opens it.
      const { text: noScreen, path: asked } = takeScreenTag(r.reply);
      const { text: noItem, item } = takeItemTag(noScreen);
      // …or to scroll ([[scroll:down]]) or turn the list's page ([[page:next]]), which this screen then does.
      const { text: noMove, scroll, page } = takeMoveTags(noItem);
      // …or a picture ([[image:<prompt>]]), which is painted on Home while Niko says what it is making.
      const { text: noImage, image } = takeImageTag(noMove);
      // …or a map ([[map:transit|Changi Airport]]), which shows on Home.
      const { text: tagless, map: wantMap } = takeMapTag(noImage);
      // Any tag the app didn't act on (a misspelt or unknown one) is never shown or spoken.
      const answer = stripTags(tagless);
      if (last.current?.question === text) last.current.answer = answer;
      // Stopped while Niko was thinking (or a newer question came): keep the answer for "continue", don't speak it.
      if (mine !== askId.current) { if (last.current?.question === text) setResumable({ canContinue: true }); return; }
      setBrief(r.brief);
      if (wantMap && mapsOn(meRef.current?.aiOff ?? [])) {
        if (wantMap.to.toLowerCase() === 'same' && mapRef.current) { say(answer || 'Changing the route.', 0); if (wantMap.how !== 'any' && wantMap.how !== 'place') setMapModeFn(wantMap.how); return; }
        say(answer || 'Here’s the map.', 0);
        if (here.current !== '/') navigate('/');
        showMapFn(wantMap.to, wantMap.from, wantMap.how);
        return;
      }
      if (image) {
        mapCtl.current?.abort(); mapRef.current = null; setMap(null);
        say(answer || 'Painting that now.', 0);
        if (here.current !== '/') navigate('/');
        paintPicture(image.prompt, image.shape, false, text);
        return;
      }
      setPictureId(null); setWeather(r.weather ? { for: answer, card: r.weather } : null); setReply(answer); say(answer, 0);
      if (item) { setPendingOpen({ ...item, at: Date.now() }); if (here.current !== '/' + item.view) navigate('/' + item.view); }
      else if (asked) navigate(asked);
      else if (page && handler.current?.(page, true)) { /* the list on screen turned its page, quietly: Niko is speaking */ }
      else if (scroll || page) scrollScreen(scroll ?? (page === 'previous page' || page === 'first page' ? 'up' : 'down'));
    } catch (e: any) {
      if (mine !== askId.current) return;
      if (e?.data?.brief) setBrief(e.data.brief);
      setReply(e.message); setResumable({ canContinue: false });
      // Said aloud, and then Niko keeps listening for a few seconds (as after any answer), so "try again" works
      // without saying "Niko" first. Before, it only showed the problem and stopped listening.
      if (wantRec.current) say('I couldn’t get an answer just now. Say “try again” to ask once more.', -1, 'Problem');
      else { setMode('idle'); setLabel('Problem'); setLine(`${e.message} Say “try again” to ask once more.`); }
    }
  };
  askRef.current = (t: string) => { void ask(t); };

  /** Finds the place and the route (the server goes down the Engine screen's map lists), and shows them on Home. */
  const loadMap = (v: MapView) => {
    mapCtl.current?.abort();
    const ctl = new AbortController();
    mapCtl.current = ctl;
    const asked = askId.current;
    const set = (fn: (m: MapView) => MapView) => { if (mapRef.current?.id !== v.id) return; const next = fn(mapRef.current); mapRef.current = next; setMap(next); };
    const tell = (text: string) => {
      const until = Date.now() + 10_000;
      const go = () => {
        if (askId.current !== asked || mapRef.current?.id !== v.id) return;
        // Never cuts Niko off: if it is still talking after a while, the card says it instead.
        if (speaking.current) { if (Date.now() < until) window.setTimeout(go, 300); return; }
        say(text);
      };
      go();
    };
    void (async () => {
      try {
        // The location: asked for once per visit (after Niko says why); never kept beyond a few minutes in memory.
        let here: { lat: number; lng: number } | undefined;
        const fresh = mapHere.current && Date.now() - mapHere.current.at < 5 * 60_000 ? mapHere.current : null;
        if (fresh) here = { lat: fresh.lat, lng: fresh.lng };
        else if (!mapRefused.current) {
          const state = await locationPermission();
          if (state === 'denied') mapRefused.current = true;
          else {
            if (state !== 'granted') {
              set((m) => ({ ...m, status: 'explain' }));
              tell('To use the right maps for the country you’re in, I’ll ask your browser for your location. It’s used for this request only.');
              const allow = await new Promise<boolean>((done) => {
                locationWait.current = done;
                // If they say nothing, the browser asks once Niko has explained.
                const t0 = Date.now();
                const tick = () => {
                  if (locationWait.current !== done) return;
                  const t = Date.now() - t0;
                  if (t < 3500 || (speaking.current && t < 12_000)) { window.setTimeout(tick, 300); return; }
                  locationWait.current = null; done(true);
                };
                window.setTimeout(tick, 300);
              });
              if (ctl.signal.aborted) return;
              if (!allow) mapRefused.current = true;
              set((m) => ({ ...m, status: 'loading' }));
            }
            if (!mapRefused.current) {
              here = await whereExactly();
              if (here) mapHere.current = { ...here, at: Date.now() };
              else if ((await locationPermission()) === 'denied') mapRefused.current = true;
            }
          }
        }
        if (ctl.signal.aborted) return;
        const r = await fetch('/api/maps/route', { method: 'POST', credentials: 'same-origin', signal: ctl.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: v.to, from: v.from, mode: v.mode, here, country: mapCountryRef.current }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? 'The map couldn’t be shown just now.');
        const res = j as MapResult;
        set((m) => ({ ...m, status: 'done', result: res, error: undefined, located: !!here, times: res.route && res.route.mode !== 'fly' ? { ...m.times, [res.route.mode]: res.route.seconds } : m.times }));
        if (res.route) tell(`About ${minutesText(res.route.seconds).replace(' h', ' hours').replace(' min', ' minutes')} ${MODE_WORDS[res.route.mode]}.`);
        else if (res.noRoute && v.mode === 'fly') tell(res.noRoute);
        else if (res.noRoute && v.mode !== 'place') tell(here || v.from ? 'I found it, but no route this way. You can open it in a maps app.' : 'Here it is. Allow your location to see the way there.');
      } catch (e: any) {
        if (ctl.signal.aborted) return;
        set((m) => ({ ...m, status: 'failed', error: String(e?.message ?? 'The map couldn’t be shown just now.') }));
        tell('I couldn’t find that on the map.');
      } finally {
        if (mapCtl.current === ctl) mapCtl.current = null;
      }
    })();
  };
  const showMapFn = (to: string, from?: string, how: MapAskMode | 'any' = 'any') => {
    picCtl.current?.abort(); setPictureId(null); setReply(null);
    const v: MapView = { id: ++mapSeq.current, to, from, mode: how === 'any' ? lastMode() : how, status: 'loading', times: {}, located: false };
    mapRef.current = v; setMap(v);
    loadMap(v);
  };
  const setMapModeFn = (mode: MapMode | 'fly') => {
    if (mode !== 'fly') keepMode(mode);
    const cur = mapRef.current;
    if (!cur) return;
    const v: MapView = { ...cur, id: ++mapSeq.current, mode, status: 'loading' };
    mapRef.current = v; setMap(v);
    loadMap(v);
  };
  const setMapCountryFn = (c: MapCountry) => {
    mapCountryRef.current = c; setMapCountryState(c);
    const cur = mapRef.current;
    if (!cur) return;
    const v: MapView = { ...cur, id: ++mapSeq.current, status: 'loading', times: {} };
    mapRef.current = v; setMap(v);
    loadMap(v);
  };
  const closeMapFn = () => { mapCtl.current?.abort(); mapCtl.current = null; locationWait.current?.(false); locationWait.current = null; mapRef.current = null; setMap(null); };

  /** Paints a picture with the first image service that will (the server goes down the Engine screen's order). */
  const paintPicture = (prompt: string, shape: PictureItem['shape'], more = false, words?: string) => {
    picCtl.current?.abort();
    const ctl = new AbortController();
    picCtl.current = ctl;
    const id = ++picSeq.current;
    updatePictures((p) => [...p, { id, prompt, shape, status: 'painting', started: Date.now(), asked: words }]);
    setPictureId(id); setReply(null);
    mapCtl.current?.abort(); mapRef.current = null; setMap(null);
    const asked = askId.current;
    if (more) { setMode('thinking'); setLabel('Painting'); setLine('Another one like this…'); }
    const timer = window.setTimeout(() => ctl.abort(), 150_000);
    /** Says something once Niko has finished its current line, unless the conversation has moved on. */
    const tell = (text: string) => {
      const until = Date.now() + 10_000;
      const go = () => {
        if (askId.current !== asked || picCtl.current !== ctl) return;
        if (speaking.current && Date.now() < until) { window.setTimeout(go, 300); return; }
        say(text);
      };
      go();
    };
    void (async () => {
      try {
        const r = await fetch('/api/image', { method: 'POST', credentials: 'same-origin', signal: ctl.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, shape, asked: words }) });
        if (!r.ok) { const j = await r.json().catch(() => ({})); if (r.status === 423 && j.locked) window.dispatchEvent(new Event('niko:locked')); throw Object.assign(new Error(j.error ?? 'The picture could not be made just now.'), { declined: !!j.declined }); }
        const blob = await r.blob();
        if (!/^image\/(jpeg|png|webp)$/.test(blob.type)) throw new Error('The picture could not be read.');
        if (!picturesRef.current.some((x) => x.id === id)) return;
        const url = URL.createObjectURL(blob);
        const label = (() => { try { return decodeURIComponent(r.headers.get('x-niko-label') ?? ''); } catch { return ''; } })();
        updatePictures((p) => p.map((x) => (x.id === id ? { ...x, status: 'done', url, type: blob.type, label, ms: Number(r.headers.get('x-niko-ms')) || Date.now() - x.started } : x)));
        tell(more ? 'Here’s another.' : 'Here it is. Want any changes?');
      } catch (e: any) {
        const stopped = ctl.signal.aborted && picCtl.current !== ctl;
        const msg = stopped ? 'Stopped.' : ctl.signal.aborted ? 'The picture took too long to make.' : String(e?.message ?? 'The picture could not be made just now.');
        updatePictures((p) => p.map((x) => (x.id === id ? { ...x, status: 'failed', error: msg } : x)));
        if (!stopped) tell(e?.declined ? 'None of the image services would make that picture.' : 'I couldn’t make that picture just now.');
      } finally {
        window.clearTimeout(timer);
        if (picCtl.current === ctl) picCtl.current = null;
      }
    })();
  };

  // Speech recognition: runs while the app is open and the mic is allowed.
  // Interim results let the core react the moment "Niko" is heard; the command itself is taken from the final text.
  const startRec = useCallback(() => {
    if (!SR || rec.current || speaking.current || capture.current) return;
    const r = new SR();
    r.continuous = true; r.interimResults = true; r.maxAlternatives = 3; r.lang = navigator.language || 'en-US';
    r.onresult = (ev: any) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (speaking.current || rec.current !== r) continue; // Niko's own voice, or a recogniser already switched off
        // Recognisers often spell the name differently in their first guess, so check every alternative.
        const alts: string[] = Array.from({ length: res.length }, (_, k) => String(res[k]?.transcript ?? '').trim());
        // Niko's own last line, heard late through the speaker: never a question.
        // (Except the words Niko asks for, such as “try again”, which are in its own line by design.)
        if (res.isFinal && Date.now() < lastSaid.current.until && alts[0] && isEcho(alts[0], lastSaid.current.text) && !alts.some((a) => matchWake(a)?.command) && !resumeIntent(alts[0])) continue;
        const hit = alts.map(matchWake).find(Boolean);
        if (!res.isFinal) {
          if (lockedRef.current) continue;
          if (hit && !active.current) { setMode('listening'); setLabel('Listening'); setLine('Go ahead.'); }
          else if (active.current && alts[0]) listenWindow(); // they are talking: wait from their last word
          continue;
        }
        if (hit) {
          if (hit.command) { active.current = false; void ask(hit.command); }
          else if (lockedRef.current) requestUnlockFn();
          else if (apiHearing()) listenByApi(8000); // the request itself goes to the speech-in service
          else { active.current = true; setMode('listening'); setLabel('Listening'); setLine('Go ahead.'); listenWindow(); }
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
    // Wake word listening starts only if the user enabled it, only after sign-in, and only while the account has access
    // (when paid time has ended, the plan screen is shown instead and Niko doesn't listen).
    const wake = (me?.engine as EnginePrefs | undefined)?.wake;
    if (me && wake && SR && me.access?.has !== false) { wantRec.current = true; startRec(); }
    return () => { wantRec.current = false; try { rec.current?.stop(); } catch { /* noop */ } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id, (me?.engine as any)?.wake, me?.access?.has]);

  const toggleMic = useCallback(() => {
    if (lockedRef.current) { requestUnlockFn(); return; }
    stopSpeech();
    if (apiHearing()) { endFollowUp(); wantRec.current = true; listenByApi(8000); return; }
    if (!SR) { setLabel('No microphone'); setLine('This browser cannot listen. Type instead.'); return; }
    endFollowUp();
    wantRec.current = true; startRec();
    active.current = true; setMode('listening'); setLabel('Listening'); setLine('Go ahead.');
    listenWindow();
  }, [SR, startRec]);

  const stop = useCallback(() => {
    const thinking = inFlight.current !== 0 && inFlight.current === askId.current;
    inFlight.current = 0;
    askId.current++; // an answer still on its way is kept for "continue", not spoken
    stopSpeech(); endFollowUp(); capture.current?.cancel(); capture.current = null; active.current = false; unmuteMic();
    if (picCtl.current) { const c = picCtl.current; picCtl.current = null; c.abort(); }
    if (locationWait.current) { const w = locationWait.current; locationWait.current = null; w(false); }
    const l = last.current;
    if (l && (thinking || (l.answer && l.from < l.answer.length))) {
      if (thinking) setResumable({ canContinue: true });
      setMode('idle'); setLabel('Stopped'); setLine('Say “continue” to carry on, or “try again” to ask again.');
      // Listening for a few seconds, so "continue" works without saying "Niko" first.
      if (wantRec.current) window.setTimeout(() => listenForFollowUp(true), 400);
    } else idle();
  }, [idle, listenForFollowUp]);

  // ---------------------------------------------------------------- screen lock
  const [locked, setLocked] = useState(false);
  const [lockAsk, setLockAsk] = useState<{ reason: string } | null>(null);
  const afterUnlock = useRef<(() => void) | null>(null);
  const lastUse = useRef(Date.now());
  const modeRef = useRef(mode);
  modeRef.current = mode;
  /** Locks this screen: everything on it goes (answers, pictures, the map, anything said), and Home shows the lock. */
  const enterLock = () => {
    if (lockedRef.current) return;
    lockedRef.current = true; setLocked(true);
    askId.current++; inFlight.current = 0;
    stopSpeech(); endFollowUp(); capture.current?.cancel(); capture.current = null; active.current = false;
    if (picCtl.current) { const c = picCtl.current; picCtl.current = null; c.abort(); }
    mapCtl.current?.abort(); mapRef.current = null; setMap(null);
    if (locationWait.current) { const w = locationWait.current; locationWait.current = null; w(false); }
    setPictureId(null); setReply(null); setWeather(null); setResumable(null); setPendingOpen(null); setBrief(null); last.current = null;
    setFullscreenAsk(false); setLockAsk(null); afterUnlock.current = null;
    if (here.current !== '/') navigate('/');
    idle();
    unmuteMic();
  };
  const enterLockRef = useRef(enterLock);
  enterLockRef.current = enterLock;
  function requestUnlockFn(reason?: string, then?: () => void) {
    if (!lockedRef.current) { then?.(); return; }
    if (then) afterUnlock.current = then;
    setMode('idle'); setLabel('Locked'); setLockAsk({ reason: reason ?? ASK_CODE });
  }
  function cancelUnlockFn() { afterUnlock.current = null; setLockAsk(null); idle(); }
  function lockNowFn() { void api<{ locked: boolean }>('/lock/now', { body: {} }).then((r) => { if (r.locked) enterLockRef.current(); }).catch(() => undefined); }
  /** Unlocked (here, or in another tab of this sign-in): back to normal, and whatever was waiting goes ahead. */
  const leaveLock = async (runPending: boolean) => {
    lockedRef.current = false; setLocked(false); setLockAsk(null);
    lastUse.current = Date.now();
    const then = runPending ? afterUnlock.current : null;
    afterUnlock.current = null;
    await refreshMe();
    idle();
    if (then) window.setTimeout(then, 450);
  };
  const failed = (e: unknown): UnlockResult => {
    const err = e as ApiError;
    if (err?.data?.signedOut) {
      // Five wrong codes: the server has ended this sign-in. The message shows for a moment, then the sign-in page.
      window.setTimeout(() => { lockedRef.current = false; setLocked(false); setLockAsk(null); afterUnlock.current = null; void refreshMe(); }, 2200);
      return { ok: false, error: err.message, signedOut: true };
    }
    return { ok: false, error: err?.message ?? 'That didn’t work. Try again.', left: typeof err?.data?.left === 'number' ? err.data.left : undefined };
  };
  const unlockFn = async (code: string): Promise<UnlockResult> => {
    try { await api('/lock/unlock', { body: { code } }); } catch (e) { return failed(e); }
    void leaveLock(true);
    return { ok: true };
  };
  const unlockWithPasskeyFn = async (): Promise<UnlockResult> => {
    try {
      const { options, challengeId } = await api<{ options: any; challengeId: string }>('/lock/passkey/options', { body: {} });
      const response = await startAuthentication({ optionsJSON: options });
      await api('/lock/passkey/verify', { body: { challengeId, response } });
    } catch (e) {
      if ((e as Error)?.name === 'NotAllowedError' || (e as Error)?.name === 'AbortError') return { ok: false, error: 'The passkey was cancelled.' };
      return failed(e);
    }
    void leaveLock(true);
    return { ok: true };
  };
  // The server can say the screen is locked at any time (another tab, the time ran out, a reload): Home shows the lock.
  useEffect(() => {
    const on = () => enterLockRef.current();
    window.addEventListener('niko:locked', on);
    return () => window.removeEventListener('niko:locked', on);
  }, []);
  useEffect(() => { if (me?.locked && !lockedRef.current) enterLockRef.current(); }, [me]);
  // Use: touches, keys, the pointer moving, and anything Niko is doing for the person (listening, thinking, speaking).
  useEffect(() => { if (mode !== 'idle') lastUse.current = Date.now(); }, [mode]);
  useEffect(() => {
    const lk = me?.lock;
    if (!me || !lk?.on) return;
    const mark = () => { if (!lockedRef.current) lastUse.current = Date.now(); };
    const evs = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'pointermove'] as const;
    for (const e of evs) window.addEventListener(e, mark, { passive: true });
    lastUse.current = Date.now();
    let lastSeen = 0, busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      const now = Date.now();
      if (modeRef.current !== 'idle' && !lockedRef.current) lastUse.current = now;
      try {
        if (lockedRef.current) {
          // Unlocked in another tab or window of this sign-in.
          const r = await api<{ locked: boolean }>('/lock');
          if (!r.locked && lockedRef.current) await leaveLock(false);
        } else if (now - lastUse.current < 15_000) {
          if (document.visibilityState === 'visible' && now - lastSeen > 15_000) { lastSeen = now; await api('/lock/seen', { body: {} }); }
        } else if (now - lastUse.current >= lk.mins * 60_000) {
          const r = await api<{ locked: boolean }>('/lock/now', { body: { idle: true } });
          if (r.locked) enterLockRef.current();
        }
      } catch { /* offline: the server still keeps the lock */ } finally { busy = false; }
    };
    const t = window.setInterval(() => void tick(), 10_000);
    const shown = () => { if (document.visibilityState === 'visible') void tick(); };
    document.addEventListener('visibilitychange', shown);
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', shown); for (const e of evs) window.removeEventListener(e, mark); };
  }, [me?.id, me?.lock?.on, me?.lock?.mins]); // eslint-disable-line react-hooks/exhaustive-deps

  const value = useMemo<NikoState>(() => ({
    me, refreshMe, mode, label, line, reply, weather, brief, micOn, voiceSupported: !!SR || (hearsFor(me).length > 0 && captureSupported()), toggleMic, stop, ask,
    dismissReply: () => setReply(null),
    setCommandHandler: (fn) => { handler.current = fn; },
    setGlanceHandler: (fn) => { glanceHandler.current = fn; },
    openItem: (view, title) => { setReply(null); setPictureId(null); setPendingOpen({ view, title, at: Date.now() }); navigate('/' + view); },
    say,
    setStatus: (l, t, m) => { setLabel(l); setLine(t); if (m) setMode(m); },
    rest: idle,
    carryOn: () => (wantRec.current ? listenForFollowUp() : idle()),
    voiceProblem,
    pendingOpen,
    clearPendingOpen: () => setPendingOpen(null),
    pictures,
    picture: pictures.find((x) => x.id === pictureId) ?? null,
    paintPicture,
    showPicture: (id: number) => { setReply(null); mapCtl.current?.abort(); mapRef.current = null; setMap(null); setPictureId(id); },
    closePicture: () => setPictureId(null),
    map, mapCountry,
    showMap: showMapFn,
    setMapMode: setMapModeFn,
    setMapCountry: setMapCountryFn,
    answerLocation: (allow: boolean) => { const w = locationWait.current; locationWait.current = null; w?.(allow); },
    closeMap: closeMapFn,
    fullscreenAsk,
    answerFullscreen: (go: boolean) => { setFullscreenAsk(false); window.clearTimeout(fsTimer.current); if (go) void enterFullscreen(); },
    resumable,
    resume: () => { void ask('continue'); },
    retry: () => { void ask('try again'); },
    locked, lockAsk,
    requestUnlock: requestUnlockFn,
    cancelUnlock: cancelUnlockFn,
    unlock: unlockFn,
    unlockWithPasskey: unlockWithPasskeyFn,
    lockNow: lockNowFn,
  }), [me, refreshMe, mode, label, line, reply, weather, brief, micOn, SR, toggleMic, stop, ask, say, voiceProblem, idle, pendingOpen, listenForFollowUp, resumable, pictures, pictureId, map, mapCountry, fullscreenAsk, locked, lockAsk]); // eslint-disable-line react-hooks/exhaustive-deps

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
