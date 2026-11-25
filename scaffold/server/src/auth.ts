import { Router, type Request, type Response, type NextFunction } from 'express';
import crypto from 'node:crypto';
import { config } from './config.js';
import { getRedis } from './redis.js';

export interface UserWorkspace {
  id: string;
  role: string;
}

export interface UserSession {
  sub: string;
  email?: string;
  name?: string;
  workspaces: UserWorkspace[];
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx !== -1) {
      const key = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1).trim();
      cookies[key] = decodeURIComponent(val);
    }
  }
  return cookies;
}

export async function getSessionUserFromCookie(sid: string): Promise<UserSession | null> {
  const redis = getRedis();
  const raw = await redis.get(`session:${sid}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function getSessionUser(req: Request): Promise<UserSession | null> {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies.sb_sid;
  if (!sid) return null;
  return getSessionUserFromCookie(sid);
}

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  const user = await getSessionUser(req);
  if (!user) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  (req as any).user = user;
  next();
};

export const requireWorkspace = (req: Request, res: Response, next: NextFunction) => {
  const user = (req as any).user as UserSession;
  const ws = (req.query.workspace || req.body?.workspace) as string;
  if (!ws) {
    return res.status(400).json({ error: 'workspace parameter is required' });
  }
  const hasAccess = user.workspaces?.some((w) => w.id === ws);
  if (!hasAccess) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
};

export const authRouter = Router();

// GET /auth/login
authRouter.get('/login', async (_req: Request, res: Response) => {
  const state = crypto.randomBytes(16).toString('hex');
  const code_verifier = crypto.randomBytes(32).toString('base64url');
  const code_challenge = crypto
    .createHash('sha256')
    .update(code_verifier)
    .digest('base64url');

  const redis = getRedis();
  await redis.set(`oidc:state:${state}`, JSON.stringify({ code_verifier }), 'EX', 300);

  const authUrl = new URL(`${config.oidc.issuer}/authorize`);
  authUrl.searchParams.set('client_id', config.oidc.clientId);
  authUrl.searchParams.set('redirect_uri', config.oidc.redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid profile email');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', code_challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  res.redirect(302, authUrl.toString());
});

// GET /auth/callback
authRouter.get('/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string;
  const state = req.query.state as string;

  if (!code || !state) {
    return res.status(400).send('Missing code or state');
  }

  const redis = getRedis();
  const rawState = await redis.get(`oidc:state:${state}`);
  if (!rawState) {
    return res.status(400).send('Invalid or expired state');
  }
  await redis.del(`oidc:state:${state}`);

  const { code_verifier } = JSON.parse(rawState);

  // Exchange code + code_verifier at token endpoint
  const params = new URLSearchParams();
  params.set('grant_type', 'authorization_code');
  params.set('client_id', config.oidc.clientId);
  if (config.oidc.clientSecret) {
    params.set('client_secret', config.oidc.clientSecret);
  }
  params.set('code', code);
  params.set('redirect_uri', config.oidc.redirectUri);
  params.set('code_verifier', code_verifier);

  const tokenRes = await fetch(`${config.oidc.issuer}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    return res.status(400).send(`Token exchange failed: ${errText}`);
  }

  const tokenData = (await tokenRes.json()) as any;
  const { id_token, access_token } = tokenData;

  let sub = '';
  let name = '';
  let email = '';
  let workspaces: UserWorkspace[] = [];

  if (id_token) {
    try {
      const parts = id_token.split('.');
      if (parts.length >= 2) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        sub = payload.sub || '';
        name = payload.name || '';
        email = payload.email || '';
        workspaces = payload.workspaces || [];
      }
    } catch (e) {
      console.error('Failed to parse id_token payload:', e);
    }
  }

  // Fallback to userinfo endpoint if needed
  if (!sub || !workspaces.length) {
    try {
      const uiRes = await fetch(`${config.oidc.issuer}/userinfo`, {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      if (uiRes.ok) {
        const uiData = (await uiRes.json()) as any;
        sub = sub || uiData.sub;
        name = name || uiData.name;
        email = email || uiData.email;
        workspaces = workspaces.length ? workspaces : (uiData.workspaces || []);
      }
    } catch (e) {
      console.error('Failed to fetch userinfo:', e);
    }
  }

  const sid = 'sess_' + crypto.randomBytes(24).toString('hex');
  const sessionUser: UserSession = { sub, name, email, workspaces };
  await redis.set(`session:${sid}`, JSON.stringify(sessionUser), 'EX', 7 * 86400);

  res.setHeader('Set-Cookie', `sb_sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  res.redirect(302, config.webOrigin);
});
