// Settings → Voice → Listening → "Respond only to my voice". On/off is the account's choice; the voiceprint is made and
// kept on each device on its own (setup: agree, five phrases, check, done). Strictness and learning are per device,
// with the voiceprint. Shown only when the account is allowed it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Switch } from '@niko/ui';
import { captureUtterance, wavSamples, type Capture } from '../listen';
import { phraseCheck, trimSilence, type Levels, type Strictness } from '../voiceFeatures';
import { onVoiceChange, scoreAgainst, voiceDelete, voiceEmbed, voiceErrorText, voiceHere, voiceLoad, voiceSave, voiceSetLearn, voiceSetStrict, voiceSupported, type VoiceHere } from '../voiceMatch';
import { VOICE_MODEL_CREDIT } from '../voicePins';

const STRICT_LINE: Record<Strictness, string> = {
  relaxed: 'Answers you with a cold or in a noisy room; another voice may slip through now and then.',
  balanced: 'Best for most rooms.',
  strict: 'Ignores almost anyone else; you may need to repeat yourself more often.',
};
const STRICT_NAME: Record<Strictness, string> = { relaxed: 'Relaxed', balanced: 'Balanced', strict: 'Strict' };
const dayText = (ms?: number) => (ms ? new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '');

/** Keeps "this device has a voiceprint" up to date for the screens that show it. */
export function useVoiceHere(account: string | undefined): VoiceHere | null {
  const [v, setV] = useState<VoiceHere | null>(null);
  useEffect(() => {
    if (!account) { setV(null); return; }
    let live = true;
    const read = () => { void voiceHere(account).then((x) => { if (live) setV(x); }); };
    read();
    const off = onVoiceChange(read);
    return () => { live = false; off(); };
  }, [account]);
  return v;
}

export function VoiceMatchSetting({ account, on, setOn }: { account: string; on: boolean; setOn: (v: boolean) => void }) {
  const here = useVoiceHere(account);
  const [setup, setSetup] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const del = useRef<HTMLDialogElement>(null);
  const supported = voiceSupported();
  useEffect(() => { if (confirmDel) del.current?.showModal(); else del.current?.close(); }, [confirmDel]);
  // Opened from the home screen's "Set up · 1 min".
  useEffect(() => { if (new URLSearchParams(location.search).get('voice') === 'setup' && supported) setSetup(true); }, [supported]);
  if (!here) return null;
  const setUp = here.setUp;
  const main = (v: boolean) => { if (!v) setOn(false); else if (setUp) setOn(true); else setSetup(true); };
  return (
    <div className="vm">
      <div className="eng-line vm-main">
        <span className="vm-txt"><span className="vm-title">Respond only to my voice{on && setUp && <span className="vm-ready">Set up on this device</span>}</span>
          <span className="hint">Niko answers only you. Other people, the TV and meeting chatter are ignored. Typing and tapping work as usual.</span></span>
        <Switch on={on} onChange={main} label="Respond only to my voice" disabled={!supported && !on} />
      </div>
      {!supported && <p className="hint">This browser can’t check voices, so Niko answers anyone here.</p>}
      {supported && on && !setUp && (
        <div className="vm-need">
          <VmIcon />
          <span className="vm-txt"><b>Not set up on this device yet</b><span className="hint">Each device learns your voice once. Until then, Niko answers anyone here.</span></span>
          <button className="pri" onClick={() => setSetup(true)}>Set up · 1 min</button>
        </div>
      )}
      {on && setUp && (
        <div className="vm-opts">
          <div className="vm-strict">
            <span className="vm-strict-h"><span>How strict</span><span className="hint">{STRICT_LINE[here.strict]}</span></span>
            <div className="vm-segs" role="group" aria-label="How strict">
              {(['relaxed', 'balanced', 'strict'] as Strictness[]).map((s) => <button key={s} className="seg" aria-pressed={here.strict === s} onClick={() => void voiceSetStrict(account, s)}>{STRICT_NAME[s]}</button>)}
            </div>
          </div>
          <div className="eng-line vm-row"><span className="vm-txt"><span>Keep learning my voice</span><span className="hint">Adds strong matches and “That was me” to your voiceprint, on this device.</span></span>
            <Switch on={here.learn} onChange={(v) => void voiceSetLearn(account, v)} label="Keep learning my voice" /></div>
          <div className="eng-line vm-row"><span className="vm-txt"><span>Your voiceprint</span><span className="hint">{here.phrases} phrases · made on {dayText(here.made)} · kept on this device only</span></span>
            <span className="vm-acts"><button className="bt" onClick={() => setSetup(true)}>Record again</button><button className="bt danger" onClick={() => setConfirmDel(true)}>Delete</button></span></div>
          <p className="hint vm-credit">{VOICE_MODEL_CREDIT}</p>
        </div>
      )}
      {!on && setUp && <p className="hint">Off. Your voiceprint stays on this device until you delete it, so turning this back on needs no setup.</p>}
      {setup && <SetupSheet account={account} onClose={() => setSetup(false)} onDone={() => { setSetup(false); if (!on) setOn(true); }} />}
      <dialog ref={del} className="sheet" role="alertdialog" aria-label="Delete your voiceprint" onClose={() => setConfirmDel(false)}>
        <form method="dialog" onSubmit={(e) => e.preventDefault()}>
          <h2 className="sheet-h">Delete your voiceprint from this device?</h2>
          <p className="sub">Niko will answer anyone here until you set it up again. Your other devices keep their own.</p>
          <div className="sheet-actions">
            <button type="button" className="sec" onClick={() => setConfirmDel(false)}>Cancel</button>
            <button type="button" className="pri danger" onClick={() => { setConfirmDel(false); void voiceDelete(account); }}>Delete</button>
          </div>
        </form>
      </dialog>
    </div>
  );
}

const VmIcon = () => <svg className="vm-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h2M8 8v8M12 5v14M16 9v6M20 11v2" /></svg>;

const PHRASES = ['“Niko, what’s on my calendar today?”', '“Remind me to call Mum at seven.”', '“How long will it take to get to the office?”', '“Read my latest messages from Jun.”', '“Play something relaxing in the living room.”'];
const BARS = 24;
type Test = { score: number; levels: Levels } | null;

function SetupSheet({ account, onClose, onDone }: { account: string; onClose: () => void; onDone: () => void }) {
  const dlg = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState(1);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [embs, setEmbs] = useState<number[][]>([]);
  const [levels, setLevels] = useState<number[]>(() => new Array(BARS).fill(0));
  const [msg, setMsg] = useState<{ text: string; warn: boolean }>({ text: 'Listening…', warn: false });
  const [test, setTest] = useState<Test>(null);
  const cap = useRef<Capture | null>(null);
  const live = useRef(true);
  useEffect(() => { dlg.current?.showModal(); return () => { live.current = false; cap.current?.cancel(); }; }, []);
  const close = () => { live.current = false; cap.current?.cancel(); dlg.current?.close(); onClose(); };

  const record = useCallback(async (): Promise<Float32Array | null> => {
    setLevels(new Array(BARS).fill(0));
    const c = captureUtterance({ waitMs: 10_000, maxMs: 9000, onLevel: (v) => setLevels((l) => [...l.slice(1), v]) });
    cap.current = c;
    const wav = await c.done;
    cap.current = null;
    return wav && live.current ? trimSilence(await wavSamples(wav)) : null;
  }, []);

  // Step 2: five phrases, each checked for length and background noise before it counts.
  useEffect(() => {
    if (step !== 2) return;
    let stop = false;
    void (async () => {
      const got: number[][] = [];
      setEmbs([]);
      while (!stop && live.current && got.length < PHRASES.length) {
        const x = await record();
        if (stop || !live.current) return;
        if (!x) { setMsg({ text: 'I didn’t hear anything. Say the phrase when you’re ready.', warn: true }); continue; }
        const q = phraseCheck(x);
        if (q.seconds < 1) { setMsg({ text: 'That was too short. Say the whole phrase.', warn: true }); continue; }
        if (q.noise > 0.35) { setMsg({ text: 'Too much background noise. Try again somewhere quieter.', warn: true }); continue; }
        try { got.push(await voiceEmbed(x)); } catch (e) { setMsg({ text: voiceErrorText(e), warn: true }); continue; }
        setEmbs([...got]);
        setMsg({ text: got.length < PHRASES.length ? 'Got it. Next phrase.' : 'Got all five.', warn: false });
      }
      if (!stop && live.current) { setTest(null); setStep(3); }
    })();
    return () => { stop = true; cap.current?.cancel(); };
  }, [step, record]);

  // Step 3: listens again and again, showing how each phrase scores against the new voiceprint.
  useEffect(() => {
    if (step !== 3 || embs.length < PHRASES.length) return;
    let stop = false;
    void (async () => {
      while (!stop && live.current) {
        const x = await record();
        if (stop || !live.current) return;
        if (!x || phraseCheck(x).seconds < 0.5) continue;
        try { setTest(scoreAgainst(embs, await voiceEmbed(x))); } catch { /* too short: keep listening */ }
      }
    })();
    return () => { stop = true; cap.current?.cancel(); };
  }, [step, embs, record]);

  const start = async () => {
    setErr(''); setBusy('Getting the voice check ready…');
    try { await voiceLoad((p) => setBusy(`Getting the voice check ready… ${Math.round(p * 100)}%`)); }
    catch (e) { setBusy(''); setErr(voiceErrorText(e)); return; }
    setBusy(''); setMsg({ text: 'Listening…', warn: false }); setStep(2);
  };
  const looksRight = async () => {
    cap.current?.cancel();
    try { await voiceSave(account, embs); setStep(4); } catch { setErr('Your voiceprint couldn’t be saved on this device.'); }
  };
  const done = embs.length;
  const balanced = test?.levels.balanced ?? 0.62;
  const you = test ? test.score >= test.levels.balanced : false;
  const strong = test ? test.score >= test.levels.strict : false;
  return (
    <dialog ref={dlg} className="sheet wide vm-sheet" aria-label="Set up your voice" onCancel={(e) => { e.preventDefault(); close(); }}>
      <div className="vm-sheet-in">
        <div className="vm-sheet-top"><span className="k">Set up your voice · {step} of 4</span>
          <span className="vm-dots" aria-hidden="true">{[1, 2, 3, 4].map((n) => <i key={n} className={n <= step ? 'on' : ''} />)}</span></div>

        {step === 1 && <>
          <h2 className="sheet-h">Let Niko learn your voice</h2>
          <ul className="vm-list">
            <li>You’ll say 5 short phrases. It takes about a minute.</li>
            <li>Niko makes a voiceprint: a set of numbers kept on this device only. The recordings aren’t kept.</li>
            <li>It ignores other voices, but it isn’t a lock. Sending, paying and deleting still ask you.</li>
            <li>Niko downloads about 13 MB once and asks to use the microphone.</li>
          </ul>
          <button type="button" className="vm-agree" aria-pressed={agree} onClick={() => setAgree(!agree)}>
            <span className="vm-box" aria-hidden="true">{agree ? '✓' : ''}</span>
            <span>I agree to Niko making a voiceprint of my voice on this device. I can delete it at any time.</span>
          </button>
          {err && <p className="warn" role="alert">{err}</p>}
          {busy && <p className="hint" role="status">{busy}</p>}
          <div className="vm-end"><button type="button" className="sec" onClick={close}>Not now</button><button type="button" className="pri" disabled={!agree || !!busy} onClick={() => void start()}>Start</button></div>
        </>}

        {step === 2 && <>
          <span className="hint">Phrase {Math.min(done + 1, 5)} of 5. Say it in your normal voice, at your normal distance.</span>
          <div className="vm-say">
            <span className="vm-phrase">{PHRASES[Math.min(done, 4)]}</span>
            <span className="vm-bars" aria-hidden="true">{levels.map((v, i) => <i key={i} style={{ height: `${Math.max(4, Math.round(v * 40))}px` }} className={msg.warn ? 'warn' : ''} />)}</span>
            <span role="status" className={'vm-msg' + (msg.warn ? ' warn' : '')}>{msg.text}</span>
          </div>
          <div className="vm-pdots" aria-hidden="true">{PHRASES.map((_, i) => <i key={i} className={i < done ? 'ok' : i === done ? 'now' : ''} />)}</div>
          <div className="vm-end"><button type="button" className="sec" onClick={close}>Cancel</button></div>
        </>}

        {step === 3 && <>
          <h2 className="sheet-h">Check it</h2>
          <span className="sub">Say anything. If someone is nearby, ask them to speak too.</span>
          <div className={'vm-test' + (test ? (you ? ' you' : ' other') : '')}>
            <span className="vm-test-h"><b role="status">{!test ? 'Waiting for you to speak…' : you ? (strong ? 'That’s you · strong match' : 'That’s you') : 'Not you · Niko would stay quiet'}</b>
              {test && <span className="hint">Score {test.score.toFixed(2)}</span>}</span>
            <span className="vm-meter"><i className="fill" style={{ width: `${Math.max(0, Math.min(100, (test?.score ?? 0) * 100))}%` }} /><i className="line" style={{ left: `${balanced * 100}%` }} /></span>
            <span className="hint">The white line is Balanced. Above it, Niko answers.</span>
          </div>
          {err && <p className="warn" role="alert">{err}</p>}
          <div className="vm-end"><button type="button" className="sec" onClick={() => { cap.current?.cancel(); setMsg({ text: 'Listening…', warn: false }); setStep(2); }}>Record again</button><button type="button" className="pri" onClick={() => void looksRight()}>Looks right</button></div>
        </>}

        {step === 4 && <>
          <h2 className="sheet-h">Niko now answers only you</h2>
          <span className="sub">On this device, set to Balanced. If Niko misses you, tap “That was me” and it learns. Change how strict it is in Settings · Voice.</span>
          <div className="vm-end"><button type="button" className="pri" onClick={() => { dlg.current?.close(); onDone(); }}>Done</button></div>
        </>}
      </div>
    </dialog>
  );
}
