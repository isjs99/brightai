import { useCallback, useEffect, useState } from 'react';
import type { Person, PersonInput, ReminderSettings } from '../../../sweep/types';
import { api, fmtRelative } from '../api';

const EMPTY: PersonInput = { name: '', role: 'am', email: '', slack_user_id: '', notify: true };

export default function PeoplePage() {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [settings, setSettings] = useState<ReminderSettings | null>(null);
  const [form, setForm] = useState<{ id: number | null; data: PersonInput } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ person: string; to: string | null; notify: boolean; text: string }[] | null>(null);

  const load = useCallback(() => {
    api.listPeople().then((r) => setPeople(r.people)).catch((e) => setError((e as Error).message));
    api.getReminderSettings().then((r) => setSettings(r.settings)).catch(() => undefined);
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setBusy('save');
    setError(null);
    try {
      if (form.id === null) await api.createPerson(form.data);
      else await api.updatePerson(form.id, form.data);
      setForm(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setBusy('settings');
    setError(null);
    try {
      const r = await api.saveReminderSettings({ notify_ams_enabled: settings.notify_ams_enabled, reminder_cron: settings.reminder_cron, reminder_text: settings.reminder_text });
      setSettings(r.settings);
      setNotice('Reminder settings saved.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const testDm = async (p: Person) => {
    setBusy(`dm-${p.id}`);
    setError(null);
    setNotice(null);
    try {
      await api.testDm(p.id);
      setNotice(`Test DM sent to ${p.name}.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const sendNow = async () => {
    if (!window.confirm('Send the reminder DM now to every AM whose checklist is not done (based on the latest check today)?')) return;
    setBusy('send');
    setError(null);
    try {
      const { results } = await api.sendReminders();
      const sent = results.filter((r) => r.sent).map((r) => r.person);
      const skipped = results.filter((r) => !r.sent).map((r) => `${r.person} (${r.error})`);
      setNotice(`Sent to: ${sent.length ? sent.join(', ') : 'nobody'}.${skipped.length ? ` Skipped: ${skipped.join('; ')}.` : ''}${results.length === 0 ? ' Everyone is complete or has no incomplete linked account.' : ''}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const showPreview = async () => {
    setBusy('preview');
    try { setPreview((await api.previewReminders()).messages); } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  };

  const remove = async (p: Person) => {
    if (!window.confirm(`Remove ${p.name}?`)) return;
    try { await api.deletePerson(p.id); load(); } catch (err) { setError((err as Error).message); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Team</h1>
          <p className="hint" style={{ margin: 0 }}>Account managers and assistants. Names must match the AM on each account (first name is enough). Add a Slack id or email to DM them.</p>
        </div>
        <button className="admin-only" onClick={() => setForm({ id: null, data: EMPTY })}>+ Add person</button>
      </div>
      {error && <div className="banner crit">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}

      {settings && (
        <form className="card admin-only" onSubmit={saveSettings} style={{ marginBottom: 16 }}>
          <h2 style={{ marginTop: 0 }}>Slack DM reminders</h2>
          {!settings.slack_bot_configured && (
            <div className="banner warn">
              <b>SLACK_BOT_TOKEN is not set.</b> Create a Slack app with the <code>chat:write</code>, <code>users:read</code> and <code>users:read.email</code> scopes, install it to the workspace, paste the bot token into <code>.env</code> and restart. Until then nothing is sent.
            </div>
          )}
          <div className="grid">
            <label className="field check">
              <input type="checkbox" checked={settings.notify_ams_enabled} onChange={(e) => setSettings({ ...settings, notify_ams_enabled: e.target.checked })} />
              <span>Send DM reminders<div className="help">A reminder at the time below, and a "missed" note at the final check, to each AM with an incomplete checklist.</div></span>
            </label>
            <label className="field">
              <span className="lbl">Reminder time (cron, {settings.next_reminder_at ? `next ${fmtRelative(settings.next_reminder_at)}` : 'off'})</span>
              <input type="text" className="mono" value={settings.reminder_cron} onChange={(e) => setSettings({ ...settings, reminder_cron: e.target.value })} />
              <span className="help">Default 0 14 * * 1-5 = weekdays 14:00, two hours before the 16:00 check.</span>
            </label>
            <label className="field" style={{ gridColumn: '1 / -1' }}>
              <span className="lbl">Message</span>
              <input type="text" value={settings.reminder_text} onChange={(e) => setSettings({ ...settings, reminder_text: e.target.value })} />
              <span className="help">Placeholders: {'{name}'}, {'{accounts}'}, {'{deadline}'}, {'{link}'}.</span>
            </label>
          </div>
          <div className="form-foot">
            <button className="primary" disabled={busy === 'settings'}>{busy === 'settings' ? 'Saving…' : 'Save'}</button>
            <button type="button" onClick={showPreview} disabled={busy === 'preview'}>Preview today's reminders</button>
            <button type="button" onClick={sendNow} disabled={busy === 'send' || !settings.slack_bot_configured}>{busy === 'send' ? 'Sending…' : 'Send reminders now'}</button>
          </div>
          {preview && (
            <div style={{ marginTop: 12 }}>
              {preview.length === 0 ? <p className="sub">Nobody to remind: every linked account is complete, or no check has run today.</p> : (
                <ul className="item-list">
                  {preview.map((m) => (
                    <li key={m.person}>
                      <span><b>{m.person}</b><div className="sub">{m.to ?? 'no Slack id / email'}{!m.notify ? ' · off' : ''}</div></span>
                      <span className="sub">{m.text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </form>
      )}

      {form && (
        <form className="card" onSubmit={save} style={{ marginBottom: 16 }}>
          <div className="grid">
            <label className="field"><span className="lbl">Name</span><input type="text" value={form.data.name} onChange={(e) => setForm({ ...form, data: { ...form.data, name: e.target.value } })} required /></label>
            <label className="field"><span className="lbl">Role</span><select value={form.data.role} onChange={(e) => setForm({ ...form, data: { ...form.data, role: e.target.value as 'am' | 'aa' } })}><option value="am">AM</option><option value="aa">AA</option></select></label>
            <label className="field"><span className="lbl">Email (Slack login email)</span><input type="text" value={form.data.email ?? ''} onChange={(e) => setForm({ ...form, data: { ...form.data, email: e.target.value } })} placeholder="name@brightform.agency" /></label>
            <label className="field"><span className="lbl">Slack user id (optional)</span><input type="text" value={form.data.slack_user_id ?? ''} onChange={(e) => setForm({ ...form, data: { ...form.data, slack_user_id: e.target.value } })} placeholder="U0123ABCDEF" /><span className="help">Slack profile › ⋯ › Copy member ID. If blank, the email is used to look them up.</span></label>
            <label className="field check"><input type="checkbox" checked={form.data.notify} onChange={(e) => setForm({ ...form, data: { ...form.data, notify: e.target.checked } })} /><span>Receives reminders</span></label>
          </div>
          <div className="form-foot">
            <button className="primary" disabled={busy === 'save'}>Save</button>
            <button type="button" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </form>
      )}

      {people === null ? <p>Loading…</p> : (
        <table>
          <thead><tr><th>Name</th><th>Role</th><th>Email</th><th className="hide-sm">Slack id</th><th>Reminders</th><th></th></tr></thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.id}>
                <td><b>{p.name}</b></td>
                <td>{p.role.toUpperCase()}</td>
                <td>{p.email ?? <span className="sub">–</span>}</td>
                <td className="hide-sm mono">{p.slack_user_id ?? <span className="sub">–</span>}</td>
                <td>{p.notify ? <span className="badge good">on</span> : <span className="badge muted">off</span>}</td>
                <td>
                  <div className="actions admin-only">
                    <button className="small" onClick={() => setForm({ id: p.id, data: { name: p.name, role: p.role, email: p.email ?? '', slack_user_id: p.slack_user_id ?? '', notify: p.notify } })}>Edit</button>
                    <button className="small" disabled={busy === `dm-${p.id}` || !settings?.slack_bot_configured || (!p.email && !p.slack_user_id)} onClick={() => testDm(p)}>{busy === `dm-${p.id}` ? '…' : 'Test DM'}</button>
                    <button className="small danger" onClick={() => remove(p)}>Remove</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
