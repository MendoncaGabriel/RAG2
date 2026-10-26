import "dotenv/config";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";

const COOKIE = "rag_token";
const masterUser = (process.env.MASTER_USER || "").trim();
const masterPassword = process.env.MASTER_PASSWORD || "";
const expiresIn = (process.env.JWT_EXPIRES_IN || "8h") as jwt.SignOptions["expiresIn"];
if (!masterUser || !masterPassword) {
  console.error("Defina MASTER_USER e MASTER_PASSWORD no .env para habilitar o login.");
  process.exit(1);
}
let secret = process.env.JWT_SECRET || "";
if (secret.length < 32) {
  secret = crypto.randomBytes(48).toString("hex");
  console.warn("JWT_SECRET ausente ou curto (mín. 32 caracteres): usando segredo temporário; as sessões caem a cada reinício.");
}
// A senha do .env é convertida em hash bcrypt na inicialização; nunca é comparada em texto puro.
const passwordHash = bcrypt.hashSync(masterPassword, 12);
const userBuf = Buffer.from(masterUser);

const parseCookies = (header = "") => Object.fromEntries(header.split(";").map(p => p.trim()).filter(Boolean).map(p => { const i = p.indexOf("="); return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))]; }));
export function currentUser(req: Request): string | null {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  try { const p = jwt.verify(token, secret, { algorithms: ["HS256"] }) as jwt.JwtPayload; return typeof p.sub === "string" ? p.sub : null; } catch { return null; }
}
export const requireAuth = (req: Request, res: Response, next: NextFunction) => currentUser(req) ? next() : res.status(401).json({ error: "Sessão expirada. Faça login novamente." });

// Limite simples de tentativas de login por IP.
const attempts = new Map<string, { count: number; until: number }>();
const MAX_ATTEMPTS = 5, WINDOW_MS = 15 * 60 * 1000;
const sameUser = (a: string) => { const b = Buffer.from(a); return b.length === userBuf.length && crypto.timingSafeEqual(b, userBuf); };

export async function login(req: Request, res: Response) {
  const ip = req.ip || "?", rec = attempts.get(ip);
  if (rec && rec.until > Date.now() && rec.count >= MAX_ATTEMPTS) return res.status(429).json({ error: "Muitas tentativas. Aguarde alguns minutos." });
  const user = String(req.body?.username || ""), pass = String(req.body?.password || "");
  // bcrypt.compare sempre roda, para não revelar por tempo se o usuário existe.
  const passOk = await bcrypt.compare(pass, passwordHash);
  if (!(sameUser(user) && passOk)) {
    const fresh = rec && rec.until > Date.now() ? rec : { count: 0, until: Date.now() + WINDOW_MS };
    attempts.set(ip, { count: fresh.count + 1, until: fresh.until });
    return res.status(401).json({ error: "Usuário ou senha inválidos." });
  }
  attempts.delete(ip);
  const token = jwt.sign({}, secret, { algorithm: "HS256", subject: masterUser, expiresIn });
  const maxAge = (jwt.decode(token) as jwt.JwtPayload).exp! * 1000 - Date.now();
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: "strict", secure: process.env.COOKIE_SECURE === "true", maxAge, path: "/" });
  res.json({ ok: true });
}
// Limite de requisições por IP para as rotas públicas; quem está logado não é limitado.
export function rateLimit(name: string, max: number, windowMs: number) {
  const hits = new Map<string, { count: number; until: number }>();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.until <= now) hits.delete(k); }, windowMs).unref();
  return (req: Request, res: Response, next: NextFunction) => {
    if (currentUser(req)) return next();
    const key = req.ip || "?", now = Date.now(), rec = hits.get(key);
    const cur = rec && rec.until > now ? rec : { count: 0, until: now + windowMs };
    cur.count++; hits.set(key, cur);
    if (cur.count > max) { res.set("retry-after", String(Math.ceil((cur.until - now) / 1000))); return res.status(429).json({ error: "Muitas requisições. Aguarde um instante e tente de novo." }); }
    next();
  };
}
export const logout = (_req: Request, res: Response) => { res.clearCookie(COOKIE, { path: "/" }); res.json({ ok: true }); };
