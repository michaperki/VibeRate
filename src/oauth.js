import { upsertUser, getUser } from './accounts.js';
import { signValue, verifyValue, readCookie, setCookie, clearCookie } from './auth.js';

// Social sign-in for the web dashboard. Standard OAuth2 web flow, hand-rolled on
// fetch (no deps). The CLI never touches this — it keeps using its machine token;
// accounts bind to those tokens via the /link claim flow.

const PROVIDERS = {
  github: {
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
    idEnv: 'GITHUB_CLIENT_ID',
    secretEnv: 'GITHUB_CLIENT_SECRET',
    async profile(token) {
      const h = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'viberate' };
      const u = await (await fetch('https://api.github.com/user', { headers: h })).json();
      let email = u.email;
      if (!email) {
        try {
          const emails = await (await fetch('https://api.github.com/user/emails', { headers: h })).json();
          if (Array.isArray(emails)) email = (emails.find((e) => e.primary) || emails[0] || {}).email || null;
        } catch {
          /* email scope/permission may be absent; fall back to login */
        }
      }
      return { providerId: String(u.id), email: email || null, name: u.name || u.login || null };
    },
  },
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    idEnv: 'GOOGLE_CLIENT_ID',
    secretEnv: 'GOOGLE_CLIENT_SECRET',
    async profile(token) {
      const u = await (await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { authorization: `Bearer ${token}` } })).json();
      return { providerId: String(u.id), email: u.email || null, name: u.name || null };
    },
  },
};

export function authConfigured(provider) {
  const p = PROVIDERS[provider];
  return !!(p && process.env[p.idEnv] && process.env[p.secretEnv]);
}

export function configuredProviders() {
  return Object.keys(PROVIDERS).filter(authConfigured);
}

// The signed-in user for a request (from the session cookie), or null.
export function currentUser(req) {
  const sess = verifyValue(readCookie(req, 'vbrt_sid'));
  return sess && sess.uid ? getUser(sess.uid) : null;
}

const SESSION_AGE = 30 * 24 * 3600 * 1000;
const STATE_AGE = 10 * 60 * 1000;
const callbackUrl = (req, provider) => `${req.protocol}://${req.get('host')}/auth/${provider}/callback`;

async function exchangeCode(p, code, redirectUri) {
  const res = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      client_id: process.env[p.idEnv],
      client_secret: process.env[p.secretEnv],
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(data.error_description || data.error || 'token exchange failed');
  return data.access_token;
}

export function mountAuth(app) {
  app.get('/api/auth/providers', (_req, res) => res.json({ providers: configuredProviders() }));

  app.get('/api/me', (req, res) => {
    const u = currentUser(req);
    if (!u) return res.status(401).json({ error: 'not signed in' });
    res.json({ id: u.id, email: u.email, name: u.name, provider: u.provider, projectCount: (u.ownerHashes || []).length });
  });

  app.post('/auth/logout', (_req, res) => {
    clearCookie(res, 'vbrt_sid');
    res.json({ ok: true });
  });

  app.get('/auth/:provider/start', (req, res) => {
    const provider = req.params.provider;
    if (!authConfigured(provider)) return res.status(404).send('unknown provider');
    const p = PROVIDERS[provider];
    const state = signValue({ r: Math.random().toString(36).slice(2) }, STATE_AGE);
    setCookie(res, 'vbrt_oauth_state', state, { maxAgeMs: STATE_AGE });
    const u = new URL(p.authUrl);
    u.searchParams.set('client_id', process.env[p.idEnv]);
    u.searchParams.set('redirect_uri', callbackUrl(req, provider));
    u.searchParams.set('scope', p.scope);
    u.searchParams.set('state', state);
    u.searchParams.set('response_type', 'code');
    if (provider === 'google') u.searchParams.set('prompt', 'select_account');
    res.redirect(u.toString());
  });

  app.get('/auth/:provider/callback', async (req, res) => {
    const provider = req.params.provider;
    if (!authConfigured(provider)) return res.status(404).send('unknown provider');
    const p = PROVIDERS[provider];
    const { code, state } = req.query;
    const cookieState = readCookie(req, 'vbrt_oauth_state');
    if (!code || !state || state !== cookieState || !verifyValue(state)) {
      return res.status(400).send('Sign-in failed: bad OAuth state. Try again from /app.');
    }
    try {
      const token = await exchangeCode(p, code, callbackUrl(req, provider));
      const prof = await p.profile(token);
      if (!prof.providerId) throw new Error('no profile id');
      const user = upsertUser({ provider, providerId: prof.providerId, email: prof.email, name: prof.name });
      clearCookie(res, 'vbrt_oauth_state');
      setCookie(res, 'vbrt_sid', signValue({ uid: user.id }, SESSION_AGE), { maxAgeMs: SESSION_AGE });
      res.redirect('/app');
    } catch (e) {
      res.status(500).send('Sign-in failed: ' + (e.message || e));
    }
  });
}
