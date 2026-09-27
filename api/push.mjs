/**
 * IronFit Gym — push notification sender   (api/push.mjs → https://<your-site>/api/push)
 * ------------------------------------------------------------------
 * Runs as a Vercel Function when this file is at api/push.mjs in your Vercel project.
 * (The same file also works as a Cloudflare Worker.)
 *
 * The gym website calls this after a session is booked or cancelled:
 *     POST { "type": "booked" | "cancelled", "appointmentId": "<id>" }
 *
 * The worker reads that appointment from your Firebase Realtime Database,
 * then asks OneSignal to push to the trainer / member involved:
 *   • booked    → instant push to the trainer (and to the member if staff booked it)
 *               → scheduled reminder for both, REMINDER_MINUTES before the session
 *   • cancelled → cancels those reminders and tells the other person
 *   • test      → "Send me a test notification" button (max once per minute per account)
 *   • status    → delivery results of a test message (used by push-test.html)
 *   • devices   → which devices are registered for an account (used by push-test.html)
 *
 * Why a worker? Sending needs your OneSignal App API key, which must never be
 * put in index.html (anyone could read it and push to all your users).
 * The worker only ever sends messages built from real appointments, and each
 * message has an idempotency key, so repeating a request cannot spam anyone.
 *
 * Settings — Vercel → your project → Settings → Environment Variables (then redeploy):
 *   ONESIGNAL_APP_ID   OneSignal → Settings → Keys & IDs → App ID
 *   ONESIGNAL_API_KEY  OneSignal → Settings → Keys & IDs → App API key   (keep secret)
 *   FIREBASE_DB_URL    https://irongym-759f1-default-rtdb.asia-southeast1.firebasedatabase.app
 *   ALLOWED_ORIGINS    optional — other sites allowed to call this (your own site is always allowed)
 *   SITE_URL           optional — page opened when a notification is tapped
 *   GYM_UTC_OFFSET     optional — default +08:00 (Philippines)
 *   REMINDER_MINUTES   optional — default 60
 *   FIREBASE_AUTH      optional — only if your database rules block public reads
 */

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FRESH_MS = 15 * 60 * 1000; // only act on bookings/cancellations from the last 15 minutes

export default {
  async fetch(request, cfEnv) {
    // Vercel passes settings in process.env; Cloudflare passes them as the 2nd argument
    const env = { ...(globalThis.process?.env || {}), ...(cfEnv && typeof cfEnv === 'object' ? cfEnv : {}) };
    const origin = request.headers.get('Origin') || '';
    const self = new URL(request.url).origin;
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
    // The page on the same site is always allowed; other sites only if listed.
    // Compare host names only: behind Vercel's proxy the request URL can say http:// or use
    // a different internal address even though the browser is on https://your-site.
    // Requests without an Origin header (not from a browser page) are refused.
    const hostOf = u => { try { return new URL(u).host.toLowerCase(); } catch { return ''; } };
    const siteHosts = new Set([hostOf(request.url), request.headers.get('x-forwarded-host'), request.headers.get('host')]
      .filter(Boolean).map(h => h.split(',')[0].trim().toLowerCase()));
    const originHost = hostOf(origin);
    const originOk = (!!originHost && siteHosts.has(originHost)) || allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': originOk && origin ? origin : (allowed[0] || self),
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };
    const reply = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method === 'GET') {
      // Open https://<your-site>/api/push in a browser to check your settings
      return reply({
        ok: true, service: 'ironfit-push',
        settings: {
          ONESIGNAL_APP_ID: !!env.ONESIGNAL_APP_ID, ONESIGNAL_API_KEY: !!env.ONESIGNAL_API_KEY,
          FIREBASE_DB_URL: !!env.FIREBASE_DB_URL, ALLOWED_ORIGINS: allowed
        }
      });
    }
    if (request.method !== 'POST') return reply({ error: 'Use POST' }, 405);
    if (!originOk) return reply({ error: 'Origin not allowed: ' + origin }, 403);
    if (!env.ONESIGNAL_APP_ID || !env.ONESIGNAL_API_KEY || !env.FIREBASE_DB_URL) {
      return reply({ error: 'Worker settings missing (ONESIGNAL_APP_ID, ONESIGNAL_API_KEY, FIREBASE_DB_URL)' }, 500);
    }

    let body;
    try { body = await request.json(); } catch { return reply({ error: 'Invalid JSON' }, 400); }
    const { type, appointmentId, userId, subscriptionId, notificationId } = body || {};

    // Diagnostics for push-test.html — read-only, no secrets or push tokens are returned
    if (type === 'status') {
      if (!UUID_RE.test(notificationId || '')) return reply({ error: 'Bad notification id' }, 400);
      try {
        const r = await fetch(`https://api.onesignal.com/notifications/${notificationId}?app_id=${encodeURIComponent(env.ONESIGNAL_APP_ID)}`,
          { headers: { 'Authorization': 'Key ' + env.ONESIGNAL_API_KEY } });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return reply({ error: `OneSignal ${r.status}: ${JSON.stringify(d.errors || d)}` }, 502);
        const pick = ['successful', 'failed', 'errored', 'converted', 'received', 'remaining', 'completed_at', 'platform_delivery_stats'];
        return reply({ ok: true, ...Object.fromEntries(pick.map(k => [k, d[k] ?? null])) });
      } catch (e) { return reply({ error: String((e && e.message) || e) }, 502); }
    }
    if (type === 'devices') {
      if (!ID_RE.test(userId || '')) return reply({ error: 'Bad request' }, 400);
      try {
        const r = await fetch(`https://api.onesignal.com/apps/${encodeURIComponent(env.ONESIGNAL_APP_ID)}/users/by/external_id/${encodeURIComponent('ifg_' + userId)}`,
          { headers: { 'Authorization': 'Key ' + env.ONESIGNAL_API_KEY } });
        if (r.status === 404) return reply({ ok: true, externalId: 'ifg_' + userId, devices: [] });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return reply({ error: `OneSignal ${r.status}: ${JSON.stringify(d.errors || d)}` }, 502);
        const devices = (d.subscriptions || []).filter(s => /push/i.test(s.type || '')).map(s => ({
          idStart: String(s.id || '').slice(0, 8),   // enough to recognise "this device", not enough to target it
          type: s.type, enabled: !!s.enabled, notification_types: s.notification_types ?? null,
          device_model: s.device_model || '', device_os: s.device_os || '', sdk: s.sdk || ''
        }));
        return reply({ ok: true, externalId: 'ifg_' + userId, devices });
      } catch (e) { return reply({ error: String((e && e.message) || e) }, 502); }
    }

    // "Send me a test notification" button: pushes to one existing account, at most once per minute
    if (type === 'test') {
      // Two forms: {subscriptionId} = just the device that pressed the button (test/index.html),
      //            {userId[, subscriptionId]} = an IronFit account's devices (🔔 window in the app)
      if (subscriptionId && !UUID_RE.test(subscriptionId)) return reply({ error: 'Bad subscription id' }, 400);
      if (userId && !ID_RE.test(userId)) return reply({ error: 'Bad request' }, 400);
      if (!userId && !subscriptionId) return reply({ error: 'Bad request' }, 400);
      try {
        if (userId) {
          const r = await fetch(dbUrl(env, `users/${userId}/role`));
          if (r.status === 401 || r.status === 403) return reply({ error: 'Firebase refused the read — set FIREBASE_AUTH or allow reading users' }, 502);
          if (!(await r.json().catch(() => null))) return reply({ error: 'Unknown account' }, 404);
        }
        const res = await push(env, {
          to: userId, subscriptionId, key: `test:${subscriptionId || userId}:${Math.floor(Date.now() / 60000)}`, // max 1 per minute
          title: '🔔 IronFit test notification', text: 'Push notifications work on this device!'
        });
        const detail = Array.isArray(res.errors) ? res.errors.join('; ') : res.errors ? JSON.stringify(res.errors) : '';
        return reply({ ok: true, id: res.id, detail });
      } catch (e) {
        return reply({ error: String((e && e.message) || e) }, 502);
      }
    }

    if (!['booked', 'cancelled'].includes(type) || !ID_RE.test(appointmentId || '')) {
      return reply({ error: 'Bad request' }, 400);
    }

    try {
      const appt = await readAppointment(env, appointmentId);
      if (!appt) return reply({ error: 'Appointment not found' }, 404);

      if (type === 'booked') {
        if (appt.status !== 'booked') return reply({ error: 'Appointment is not booked' }, 409);
        if (!isFresh(appt.createdAt)) return reply({ error: 'Booking is too old to notify' }, 409);
        const sent = [];
        if (appt.trainerUserId) {
          sent.push(await push(env, {
            to: appt.trainerUserId, key: `${appointmentId}:booked:trainer`,
            title: '📅 New session booked',
            text: `${appt.memberName} — ${when(appt)}${appt.note ? ` • "${appt.note}"` : ''}`
          }));
        }
        if (appt.createdBy?.role !== 'member' && appt.memberUserId) {
          sent.push(await push(env, {
            to: appt.memberUserId, key: `${appointmentId}:booked:member`,
            title: '📅 Session booked for you', text: `${appt.trainerName} — ${when(appt)}`
          }));
        }
        // Reminders, delivered later by OneSignal even if nobody has the app open
        const reminderIds = [];
        const at = startTime(env, appt) - reminderMinutes(env) * 60000;
        if (at > Date.now() + 60000) {
          const sendAfter = new Date(at).toISOString();
          const who = [['trainer', appt.trainerUserId, appt.memberName], ['member', appt.memberUserId, appt.trainerName]];
          for (const [role, userId, other] of who) {
            if (!userId) continue;
            const r = await push(env, {
              to: userId, key: `${appointmentId}:reminder:${role}`, sendAfter,
              title: '⏰ Session reminder', text: `Starts at ${fmtHM(appt.start)} with ${other} (${fmtDate(appt.date)})`
            });
            if (r.id) reminderIds.push(r.id);
          }
        }
        if (reminderIds.length) await saveReminderIds(env, appointmentId, reminderIds);
        return reply({ ok: true, sent: sent.map(s => s.id).filter(Boolean), reminderIds });
      }

      // type === 'cancelled'
      if (appt.status !== 'cancelled') return reply({ error: 'Appointment is not cancelled' }, 409);
      if (!isFresh(appt.cancelledAt)) return reply({ error: 'Cancellation is too old to notify' }, 409);
      let cancelled = 0;
      for (const id of appt.pushReminderIds || []) if (await cancelPush(env, id)) cancelled++;
      const by = appt.cancelledBy?.role;
      const byText = by === 'member' ? 'the member' : by === 'trainer' ? 'your trainer' : 'the gym';
      const why = appt.cancelReason ? ` • Reason: ${appt.cancelReason}` : '';
      const sent = [];
      if (by !== 'trainer' && appt.trainerUserId) {
        sent.push(await push(env, {
          to: appt.trainerUserId, key: `${appointmentId}:cancelled:trainer`,
          title: '❌ Session cancelled', text: `${appt.memberName} — ${when(appt)} (cancelled by ${byText})${why}`
        }));
      }
      if (by !== 'member' && appt.memberUserId) {
        sent.push(await push(env, {
          to: appt.memberUserId, key: `${appointmentId}:cancelled:member`,
          title: '❌ Session cancelled', text: `${appt.trainerName} — ${when(appt)} (cancelled by ${byText})${why}`
        }));
      }
      return reply({ ok: true, sent: sent.map(s => s.id).filter(Boolean), cancelledReminders: cancelled });
    } catch (e) {
      return reply({ error: String((e && e.message) || e) }, 502);
    }
  }
};

/* ---------- Firebase (REST) ---------- */
function dbUrl(env, path) {
  const auth = env.FIREBASE_AUTH ? `?auth=${encodeURIComponent(env.FIREBASE_AUTH)}` : '';
  return `${env.FIREBASE_DB_URL.replace(/\/$/, '')}/${path}.json${auth}`;
}
async function readAppointment(env, id) {
  const r = await fetch(dbUrl(env, `appointments/${id}`));
  if (r.status === 401 || r.status === 403) throw new Error('Firebase refused the read — set FIREBASE_AUTH or allow reading appointments');
  if (!r.ok) throw new Error('Firebase read failed: ' + r.status);
  return r.json();
}
async function saveReminderIds(env, id, ids) {
  // Best effort: the website also saves these. Needed so a later cancel can stop the reminders.
  try { await fetch(dbUrl(env, `appointments/${id}/pushReminderIds`), { method: 'PUT', body: JSON.stringify(ids) }); } catch {}
}

/* ---------- OneSignal ---------- */
async function push(env, { to, subscriptionId, key, title, text, sendAfter }) {
  const payload = {
    app_id: env.ONESIGNAL_APP_ID,
    headings: { en: title },
    contents: { en: text },
    idempotency_key: await uuidFrom(key)             // same request twice = one notification
  };
  if (subscriptionId) {
    payload.include_subscription_ids = [subscriptionId]; // one specific device
  } else {
    payload.target_channel = 'push';
    payload.include_aliases = { external_id: ['ifg_' + to] }; // the website logs devices in as "ifg_<userKey>"
  }
  if (env.SITE_URL) payload.url = env.SITE_URL;
  if (sendAfter) payload.send_after = sendAfter;
  const r = await fetch('https://api.onesignal.com/notifications?c=push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': 'Key ' + env.ONESIGNAL_API_KEY },
    body: JSON.stringify(payload)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OneSignal ${r.status}: ${JSON.stringify(data.errors || data)}`);
  // id is "" when the person has no subscribed device yet — not an error
  return { id: data.id || '', errors: data.errors || null };
}
async function cancelPush(env, notificationId) {
  if (!/^[0-9a-f-]{36}$/i.test(notificationId || '')) return false;
  const r = await fetch(`https://api.onesignal.com/notifications/${notificationId}?app_id=${encodeURIComponent(env.ONESIGNAL_APP_ID)}`, {
    method: 'DELETE', headers: { 'Authorization': 'Key ' + env.ONESIGNAL_API_KEY }
  });
  return r.ok; // 400 = already sent, 404 = unknown — nothing to do either way
}

/* ---------- Helpers ---------- */
const isFresh = iso => { const t = Date.parse(iso || ''); return !!t && Math.abs(Date.now() - t) < FRESH_MS; };
const reminderMinutes = env => Math.max(0, parseInt(env.REMINDER_MINUTES || '60', 10) || 60);
const startTime = (env, a) => Date.parse(`${a.date}T${a.start}:00${env.GYM_UTC_OFFSET || '+08:00'}`);
function fmtHM(hm) {
  const [H, M] = String(hm).split(':').map(Number);
  const h = H % 12 || 12;
  return `${h}:${String(M || 0).padStart(2, '0')} ${H >= 12 ? 'PM' : 'AM'}`;
}
const fmtDate = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const when = a => `${fmtDate(a.date)}, ${fmtHM(a.start)} – ${fmtHM(a.end)}`;
/* Deterministic UUID (version-5 style) from a string, for OneSignal's idempotency_key */
async function uuidFrom(name) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode('ironfit:' + name)));
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = [...h.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
