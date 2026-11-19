// Settings · Knowledge · Where it's kept · Obsidian, as the Obsidian-Place mockup: two ways to reach the vault (synced
// through S3 storage, the default, or the Local REST API through their own tunnel), then Test and Save, like Your own
// storage. Keys are locked in Niko and never shown again.
import { useState } from 'react';
import { api, Segmented } from '@niko/ui';

export type ObsidianShown = { mode: 's3' | 'rest'; address: string; bucket?: string; prefix?: string; vault?: string; access: boolean };
type Way = 's3' | 'rest';
type Form = { mode: Way; endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; prefix: string; address: string; apiKey: string; vault: string; accessId: string; accessSecret: string };
const WAYS: readonly (readonly [Way, string])[] = [['s3', 'Synced through S3'], ['rest', 'Local REST API']];

export function ObsidianPanel({ saved, busy, inUse, onSaved }: { saved?: ObsidianShown; busy: boolean; inUse: boolean; onSaved: () => Promise<void> }) {
  const start = (): Form => ({ mode: saved?.mode ?? 's3', endpoint: saved?.mode === 's3' ? saved.address : '', bucket: saved?.bucket ?? '', accessKeyId: '', secretAccessKey: '', prefix: saved?.prefix ?? '', address: saved?.mode === 'rest' ? saved.address : '', apiKey: '', vault: saved?.vault ?? '', accessId: '', accessSecret: '' });
  const [form, setForm] = useState<Form | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [trying, setTrying] = useState(false);
  const f = form ?? start();
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setForm({ ...f, [k]: e.target.value });
  const same = !!saved && saved.mode === f.mode;
  const keyHint = same ? 'Saved · type to change' : '';
  const off = busy || trying;
  const ready = f.mode === 's3' ? !!f.endpoint && !!f.bucket : !!f.address;
  const send = async (save: boolean) => {
    setNote(null); setTrying(true);
    try {
      const body = f.mode === 's3'
        ? { mode: 's3', endpoint: f.endpoint, bucket: f.bucket, accessKeyId: f.accessKeyId, secretAccessKey: f.secretAccessKey, prefix: f.prefix, vault: f.vault, accessId: f.accessId, accessSecret: f.accessSecret }
        : { mode: 'rest', address: f.address, apiKey: f.apiKey, vault: f.vault, accessId: f.accessId, accessSecret: f.accessSecret };
      await api(save ? '/knowledge/places/obsidian' : '/knowledge/places/obsidian/test', { method: save ? 'PUT' : 'POST', body });
      setNote({ ok: true, text: save ? 'Saved. Niko can keep your files in your vault.' : f.mode === 's3' ? 'Niko wrote a test note in Niko Knowledge, read it back and removed it.' : 'Obsidian answered. Niko wrote a test note, read it back and removed it.' });
      if (save) { setForm(null); await onSaved(); }
    } catch (e) { setNote({ ok: false, text: (e as Error).message }); }
    finally { setTrying(false); }
  };
  const remove = async () => {
    setNote(null);
    try { await api('/knowledge/places/obsidian', { method: 'DELETE' }); setForm(null); await onSaved(); }
    catch (e) { setNote({ ok: false, text: (e as Error).message }); }
  };
  return <>
    <span className="kn-lead">Your files go in a “Niko Knowledge” folder in your vault: documents as notes, spreadsheets as notes with a table. Edit them in Obsidian; Niko picks up changes the next time it uses them. Niko also keeps the search pieces and rows.</span>
    <Segmented value={f.mode} options={WAYS} label="How Niko reaches your vault" disabled={off} onChange={(mode) => { setNote(null); setForm({ ...f, mode }); }} />
    <form className="kn-store" autoComplete="off" onSubmit={(e) => { e.preventDefault(); void send(true); }}>
      {f.mode === 's3' ? <>
        <span className="srow-hint">For a vault synced to S3 storage (Cloudflare R2, Backblaze B2, MinIO…) with the Remotely Save plugin. Niko writes into the bucket and Obsidian syncs it in, even while Obsidian is closed. Turn off the plugin’s encryption, or Niko’s notes won’t show. Obsidian Sync has no way in for other apps.</span>
        <div className="kn-grid2">
          <label className="kn-field"><span className="kn-k">Address</span><input className="in" value={f.endpoint} onChange={set('endpoint')} placeholder="https://<account>.r2.cloudflarestorage.com" inputMode="url" spellCheck={false} maxLength={300} disabled={off} /></label>
          <label className="kn-field"><span className="kn-k">Bucket</span><input className="in" value={f.bucket} onChange={set('bucket')} placeholder="obsidian" spellCheck={false} maxLength={63} disabled={off} /></label>
          <label className="kn-field"><span className="kn-k">Access key ID</span><input className="in" value={f.accessKeyId} onChange={set('accessKeyId')} placeholder={keyHint} spellCheck={false} maxLength={128} disabled={off} /></label>
          <label className="kn-field"><span className="kn-k">Secret key</span><input className="in" type="password" value={f.secretAccessKey} onChange={set('secretAccessKey')} placeholder={keyHint} maxLength={256} disabled={off} /></label>
          <label className="kn-field"><span className="kn-k">Folder in the bucket (optional)</span><input className="in" value={f.prefix} onChange={set('prefix')} placeholder="My vault" spellCheck={false} maxLength={200} disabled={off} /></label>
          <label className="kn-field"><span className="kn-k">Vault name (for “Open in Obsidian”)</span><input className="in" value={f.vault} onChange={set('vault')} placeholder="My vault" spellCheck={false} maxLength={100} disabled={off} /></label>
        </div>
      </> : <>
        <span className="srow-hint">For the Local REST API plugin, reached through your own Cloudflare Tunnel (to https://127.0.0.1:27124, with No TLS Verify). Works only while Obsidian is open on that computer. Its key opens your whole vault: Niko only ever writes inside “Niko Knowledge”. A Cloudflare Access service token is strongly advised.</span>
        <div className="kn-grid2">
          <label className="kn-field"><span className="kn-k">Address</span><input className="in" value={f.address} onChange={set('address')} placeholder="https://obsidian.example.com" inputMode="url" spellCheck={false} maxLength={300} disabled={off} /></label>
          <label className="kn-field"><span className="kn-k">API key</span><input className="in" type="password" value={f.apiKey} onChange={set('apiKey')} placeholder={keyHint} maxLength={256} disabled={off} /></label>
          <label className="kn-field"><span className="kn-k">Vault name (for “Open in Obsidian”)</span><input className="in" value={f.vault} onChange={set('vault')} placeholder="My vault" spellCheck={false} maxLength={100} disabled={off} /></label>
        </div>
      </>}
      <details className="kn-details" open={(same && saved?.access) || undefined}>
        <summary>Behind Cloudflare Access (optional)</summary>
        <div className="kn-grid2">
          <label className="kn-field"><span className="kn-k">Client ID</span><input className="in" value={f.accessId} onChange={set('accessId')} placeholder={same && saved?.access ? 'Saved · type to change' : ''} spellCheck={false} maxLength={128} disabled={off} /></label>
          <label className="kn-field"><span className="kn-k">Client secret</span><input className="in" type="password" value={f.accessSecret} onChange={set('accessSecret')} placeholder={same && saved?.access ? 'Saved · type to change' : ''} maxLength={256} disabled={off} /></label>
        </div>
      </details>
      <div className="kn-store-b">
        <span className="srow-hint">Must use https and a public address. Keys are locked in Niko and never shown again. Changing the address clears them.</span>
        <span className="kn-store-acts">
          {saved && !inUse && <button type="button" className="bt md" disabled={off} onClick={() => void remove()}>Remove</button>}
          <button type="button" className="bt md" disabled={off || !ready} onClick={() => void send(false)}>Test</button>
          <button type="submit" className="pri md" disabled={off || !ready || (!!saved && !form)}>Save</button>
        </span>
      </div>
      {note && <span role="status" className={'srow-hint ' + (note.ok ? 'ready' : 'no')}>{note.text}</span>}
    </form>
  </>;
}
