/**
 * Google OAuth for an installed app: system browser + loopback redirect on 127.0.0.1:<random> + PKCE (S256).
 * Desktop apps get no incremental auth, so opting into primary-calendar writes re-runs consent with the
 * extra scope. See docs/research/google-calendar.md.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FetchLike } from '../todoist/client';

export const SCOPES = {
  calendarList: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  eventsRead: 'https://www.googleapis.com/auth/calendar.events.readonly',
  appCreated: 'https://www.googleapis.com/auth/calendar.app.created',
  eventsOwned: 'https://www.googleapis.com/auth/calendar.events.owned',
};
export const BASE_SCOPES = [SCOPES.calendarList, SCOPES.eventsRead, SCOPES.appCreated];

export interface Tokens { accessToken: string; expiresAt: number; refreshToken?: string; scope: string[] }
export class ReconnectRequired extends Error {}

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export interface PendingAuth { url: string; result: Promise<Tokens>; cancel: () => void }

/** Starts the loopback listener and returns the consent URL to open in the system browser. */
export async function startAuth(opts: { clientId: string; clientSecret: string; scopes: string[]; fetchImpl?: FetchLike; authBase?: string; tokenUrl?: string; timeoutMs?: number }): Promise<PendingAuth> {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}`;
  const url = `${opts.authBase ?? 'https://accounts.google.com/o/oauth2/v2/auth'}?` + new URLSearchParams({
    client_id: opts.clientId, redirect_uri: redirectUri, response_type: 'code', scope: opts.scopes.join(' '),
    code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent',
  });
  let timer: NodeJS.Timeout;
  const result = new Promise<Tokens>((resolve, reject) => {
    timer = setTimeout(() => { server.close(); reject(new Error('Google sign-in timed out. Try Connect again.')); }, opts.timeoutMs ?? 5 * 60_000);
    server.on('request', async (req, res) => {
      const u = new URL(req.url ?? '/', redirectUri);
      if (u.pathname !== '/') { res.writeHead(404).end(); return; }
      const done = (ok: boolean, msg: string) => {
        res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>Margin</title><body style="font:15px -apple-system,sans-serif;display:grid;place-items:center;height:90vh;color:#333"><div style="text-align:center"><h2 style="font-weight:600">${ok ? 'Google Calendar connected' : 'Not connected'}</h2><p>${msg}</p></div></body>`);
        clearTimeout(timer);
        server.close();
      };
      if (u.searchParams.get('state') !== state) { done(false, 'The sign-in response didn’t match. Close this tab and try again.'); reject(new Error('OAuth state mismatch')); return; }
      const err = u.searchParams.get('error');
      if (err) { done(false, 'You can close this tab.'); reject(new Error(err === 'access_denied' ? 'Google access was declined.' : `Google returned ${err}`)); return; }
      try {
        const tokens = await exchange({ ...opts, code: u.searchParams.get('code')!, verifier, redirectUri });
        done(true, 'You can close this tab and return to Margin.');
        resolve(tokens);
      } catch (e) { done(false, (e as Error).message); reject(e); }
    });
  });
  return { url, result, cancel: () => { clearTimeout(timer); server.close(); } };
}

async function exchange(o: { clientId: string; clientSecret: string; code: string; verifier: string; redirectUri: string; fetchImpl?: FetchLike; tokenUrl?: string }): Promise<Tokens> {
  const res = await (o.fetchImpl ?? fetch)(o.tokenUrl ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: o.code, client_id: o.clientId, client_secret: o.clientSecret, redirect_uri: o.redirectUri, grant_type: 'authorization_code', code_verifier: o.verifier }).toString(),
  });
  const j: any = await res.json();
  if (!res.ok) throw new Error(`Google token exchange failed: ${j.error_description ?? j.error}`);
  return { accessToken: j.access_token, expiresAt: Date.now() + (j.expires_in - 60) * 1000, refreshToken: j.refresh_token, scope: String(j.scope ?? '').split(' ').filter(Boolean) };
}

export async function refresh(o: { clientId: string; clientSecret: string; refreshToken: string; fetchImpl?: FetchLike; tokenUrl?: string }): Promise<Tokens> {
  const res = await (o.fetchImpl ?? fetch)(o.tokenUrl ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: o.clientId, client_secret: o.clientSecret, refresh_token: o.refreshToken, grant_type: 'refresh_token' }).toString(),
  });
  const j: any = await res.json();
  if (j.error === 'invalid_grant') throw new ReconnectRequired('Google sign-in expired. Reconnect to keep calendars in sync.');
  if (!res.ok) throw new Error(`Google refresh failed: ${j.error_description ?? j.error}`);
  return { accessToken: j.access_token, expiresAt: Date.now() + (j.expires_in - 60) * 1000, scope: String(j.scope ?? '').split(' ').filter(Boolean) };
}

export async function revoke(token: string, fetchImpl: FetchLike = fetch) {
  await fetchImpl(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } }).catch(() => {});
}
