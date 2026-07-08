import { authGuard } from '@api/guards/auth.guard';
import { instanceExistsGuard, instanceLoggedGuard } from '@api/guards/instance.guard';
import Telemetry from '@api/guards/telemetry.guard';
import { ChannelRouter } from '@api/integrations/channel/channel.router';
import { ChatbotRouter } from '@api/integrations/chatbot/chatbot.router';
import { EventRouter } from '@api/integrations/event/event.router';
import { StorageRouter } from '@api/integrations/storage/storage.router';
import { dataPruneService, waMonitor } from '@api/server.module';
import { Auth, configService, Database, Facebook, ServerShutdown } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { fetchLatestWaWebVersion } from '@utils/fetchLatestWaWebVersion';
import { createQrToken, deleteQrToken, getActiveToken, resolveQrToken, revokeByInstance } from '@utils/qrPublicTokens';
import { NextFunction, Request, Response, Router } from 'express';
import fs from 'fs';
import mimeTypes from 'mime-types';
import path from 'path';

import { BusinessRouter } from './business.router';
import { CallRouter } from './call.router';
import { ChatRouter } from './chat.router';
import { GroupRouter } from './group.router';
import { InstanceRouter } from './instance.router';
import { LabelRouter } from './label.router';
import { ProxyRouter } from './proxy.router';
import { MessageRouter } from './sendMessage.router';
import { SettingsRouter } from './settings.router';
import { TemplateRouter } from './template.router';
import { ViewsRouter } from './view.router';

enum HttpStatus {
  OK = 200,
  CREATED = 201,
  ACCEPTED = 202,
  NOT_FOUND = 404,
  FORBIDDEN = 403,
  BAD_REQUEST = 400,
  UNAUTHORIZED = 401,
  INTERNAL_SERVER_ERROR = 500,
}

const router: Router = Router();
const serverConfig = configService.get('SERVER');
const databaseConfig = configService.get<Database>('DATABASE');
const guards = [instanceExistsGuard, instanceLoggedGuard, authGuard['apikey']];

const telemetry = new Telemetry();

const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
const postmanCollectionPath = path.join(process.cwd(), 'postman', 'Evolution API v2.postman_collection.json');

// Middleware for metrics IP whitelist
const metricsIPWhitelist = (req: Request, res: Response, next: NextFunction) => {
  const metricsConfig = configService.get('METRICS');
  const allowedIPs = metricsConfig.ALLOWED_IPS?.split(',').map((ip) => ip.trim()) || ['127.0.0.1'];
  const clientIPs = [
    req.ip,
    req.connection.remoteAddress,
    req.socket.remoteAddress,
    req.headers['x-forwarded-for'],
  ].filter((ip) => ip !== undefined);

  if (allowedIPs.filter((ip) => clientIPs.includes(ip)).length === 0) {
    return res.status(403).send('Forbidden: IP not allowed');
  }

  next();
};

// Middleware for metrics Basic Authentication
const metricsBasicAuth = (req: Request, res: Response, next: NextFunction) => {
  const metricsConfig = configService.get('METRICS');
  const metricsUser = metricsConfig.USER;
  const metricsPass = metricsConfig.PASSWORD;

  if (!metricsUser || !metricsPass) {
    return res.status(500).send('Metrics authentication not configured');
  }

  const auth = req.get('Authorization');
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Evolution API Metrics"');
    return res.status(401).send('Authentication required');
  }

  const credentials = Buffer.from(auth.slice(6), 'base64').toString();
  const [user, pass] = credentials.split(':');

  if (user !== metricsUser || pass !== metricsPass) {
    return res.status(401).send('Invalid credentials');
  }

  next();
};

// Expose Prometheus metrics when enabled by env flag
const metricsConfig = configService.get('METRICS');
if (metricsConfig.ENABLED) {
  const metricsMiddleware = [];

  // Add IP whitelist if configured
  if (metricsConfig.ALLOWED_IPS) {
    metricsMiddleware.push(metricsIPWhitelist);
  }

  // Add Basic Auth if required
  if (metricsConfig.AUTH_REQUIRED) {
    metricsMiddleware.push(metricsBasicAuth);
  }

  router.get('/metrics', ...metricsMiddleware, async (req, res) => {
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');

    const escapeLabel = (value: unknown) =>
      String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/\n/g, '\\n')
        .replace(/"/g, '\\"');

    const lines: string[] = [];

    const clientName = databaseConfig.CONNECTION.CLIENT_NAME || 'unknown';
    const serverUrl = serverConfig.URL || '';

    // environment info
    lines.push('# HELP evolution_environment_info Environment information');
    lines.push('# TYPE evolution_environment_info gauge');
    lines.push(
      `evolution_environment_info{version="${escapeLabel(packageJson.version)}",clientName="${escapeLabel(
        clientName,
      )}",serverUrl="${escapeLabel(serverUrl)}"} 1`,
    );

    const instances = (waMonitor && waMonitor.waInstances) || {};
    const instanceEntries = Object.entries(instances);

    // total instances
    lines.push('# HELP evolution_instances_total Total number of instances');
    lines.push('# TYPE evolution_instances_total gauge');
    lines.push(`evolution_instances_total ${instanceEntries.length}`);

    // per-instance status
    lines.push('# HELP evolution_instance_up 1 if instance state is open, else 0');
    lines.push('# TYPE evolution_instance_up gauge');
    lines.push('# HELP evolution_instance_state Instance state as a labelled metric');
    lines.push('# TYPE evolution_instance_state gauge');

    for (const [name, instance] of instanceEntries) {
      const state = instance?.connectionStatus?.state || 'unknown';
      const integration = instance?.integration || '';
      const up = state === 'open' ? 1 : 0;

      lines.push(
        `evolution_instance_up{instance="${escapeLabel(name)}",integration="${escapeLabel(integration)}"} ${up}`,
      );
      lines.push(
        `evolution_instance_state{instance="${escapeLabel(name)}",integration="${escapeLabel(
          integration,
        )}",state="${escapeLabel(state)}"} 1`,
      );
    }

    res.send(lines.join('\n') + '\n');
  });
}

const logger = new Logger('SERVER');

const globalApiKeyGuard = (req: Request, res: Response, next: NextFunction) => {
  const key = req.get('apikey');
  const globalApiKey = configService.get<Auth>('AUTHENTICATION').API_KEY.KEY;

  if (!key || key !== globalApiKey) {
    return res.status(HttpStatus.UNAUTHORIZED).json({
      status: HttpStatus.UNAUTHORIZED,
      error: 'Unauthorized',
      response: {
        message: ['Invalid global api key'],
      },
    });
  }

  return next();
};

if (!serverConfig.DISABLE_MANAGER) router.use('/manager', new ViewsRouter().router);

router.get('/postman', (req, res) => {
  if (!fs.existsSync(postmanCollectionPath)) {
    return res.status(HttpStatus.NOT_FOUND).json({
      status: HttpStatus.NOT_FOUND,
      error: 'Not Found',
      response: {
        message: ['Postman collection not found'],
      },
    });
  }

  return res.download(postmanCollectionPath, `Evolution API v${packageJson.version}.postman_collection.json`);
});

// ─── Public QR Code page ───────────────────────────────────────────────────

/**
 * Create a public QR link for an instance.
 * Body: { ttl?: number }  — seconds until expiry. 0 = no expiry. Default 900 (15 min).
 * Creates at most one active link per instance — previous link is revoked automatically.
 */
router.post('/instance/qrcode/publicLink/:instanceName', authGuard['apikey'], (req, res) => {
  const { instanceName } = req.params as { instanceName: string };
  const instance = waMonitor.waInstances[instanceName];

  if (!instance) {
    return res.status(HttpStatus.NOT_FOUND).json({ error: 'Instance not found' });
  }

  const state = instance.connectionStatus?.state;

  // Only trigger a new connection when the instance is fully closed.
  // If it's 'open' or 'connecting' we just issue the link without touching the session.
  if (state === 'close') {
    instance.connectToWhatsapp().catch(() => {});
  }

  const rawTtl = req.body?.ttl;
  const ttlSeconds = typeof rawTtl === 'number' && rawTtl >= 0 ? rawTtl : 900;

  const token = createQrToken(instanceName, ttlSeconds);
  const serverUrl = (configService.get('SERVER') as any)?.URL ?? '';
  const entry = resolveQrToken(token);

  return res.status(HttpStatus.OK).json({
    token,
    url: `${serverUrl}/qrcode/${token}`,
    expiresAt: entry?.expiresAt ?? null,
  });
});

/** Revoke an active public QR link by token. */
router.delete('/instance/qrcode/publicLink/:token', authGuard['apikey'], (req, res) => {
  const { token } = req.params;
  const entry = resolveQrToken(token);

  if (!entry) {
    return res.status(HttpStatus.NOT_FOUND).json({ error: 'Token not found or already expired' });
  }

  deleteQrToken(token);
  return res.status(HttpStatus.OK).json({ message: 'Link revoked' });
});

/** Revoke all active public QR links for an instance. */
router.delete('/instance/qrcode/publicLink/instance/:instanceName', authGuard['apikey'], (req, res) => {
  const { instanceName } = req.params as { instanceName: string };
  const revoked = revokeByInstance(instanceName);
  return res.status(HttpStatus.OK).json({ revoked });
});

/** Get the currently active public QR link for an instance (if any). */
router.get('/instance/qrcode/publicLink/:instanceName', authGuard['apikey'], (req, res) => {
  const { instanceName } = req.params as { instanceName: string };
  const token = getActiveToken(instanceName);

  if (!token) {
    return res.status(HttpStatus.NOT_FOUND).json({ error: 'No active public link for this instance' });
  }

  const entry = resolveQrToken(token);
  const serverUrl = (configService.get('SERVER') as any)?.URL ?? '';

  return res.status(HttpStatus.OK).json({
    token,
    url: `${serverUrl}/qrcode/${token}`,
    expiresAt: entry?.expiresAt ?? null,
  });
});

router.get('/qrcode/:token/data', (req, res) => {
  const entry = resolveQrToken(req.params.token);

  if (!entry) {
    return res.status(HttpStatus.OK).json({ status: 'expired' });
  }

  const instance = waMonitor.waInstances[entry.instanceName];

  if (!instance) {
    return res.status(HttpStatus.OK).json({ status: 'expired' });
  }

  const state = instance.connectionStatus?.state;
  const profileName = (instance as any).profileName ?? null;
  const phoneNumber = instance.wuid ? instance.wuid.split('@')[0] : null;

  if (state === 'open') {
    // Don't delete the token here — the page needs to know when it eventually disconnects.
    // The page itself decides whether 'connected' means "just scanned" or "still active".
    return res.status(HttpStatus.OK).json({ status: 'connected', instanceName: entry.instanceName, profileName, phoneNumber });
  }

  const qr = instance.qrCode;

  return res.status(HttpStatus.OK).json({
    status: 'waiting',
    qrCode: qr?.base64 ?? null,
    pairingCode: qr?.pairingCode ?? null,
    expiresAt: entry.expiresAt,
    profileName,
    phoneNumber,
  });
});

router.get('/qrcode/:token', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const serverUrl = (configService.get('SERVER') as any)?.URL ?? '';
  res.send(buildQrPage(serverUrl));
});

function buildQrPage(serverUrl = ''): string {
  const QR_LIFETIME = 20; // seconds
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Conectar WhatsApp</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{
  background:#f4f4f5;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  min-height:100dvh;display:flex;flex-direction:column;
  align-items:center;justify-content:center;padding:1.5rem;
}
.card{
  background:#fff;border-radius:20px;
  box-shadow:0 1px 2px rgba(0,0,0,.04),0 4px 16px rgba(0,0,0,.07);
  width:100%;max-width:380px;
  padding:2.25rem 2rem 2rem;
  display:flex;flex-direction:column;align-items:center;
}
.logo{display:flex;align-items:center;gap:.55rem;margin-bottom:1.75rem}
.logo-mark{
  width:32px;height:32px;background:#25d366;border-radius:8px;
  display:flex;align-items:center;justify-content:center;flex-shrink:0;
}
.logo-mark svg{width:19px;height:19px;fill:#fff}
.logo-name{font-size:.9rem;font-weight:600;color:#18181b;letter-spacing:-.01em}
.logo-name em{color:#25d366;font-style:normal}
.s-qr{width:100%;display:flex;flex-direction:column;align-items:center;gap:0}
.qr-title{font-size:1.1rem;font-weight:700;color:#18181b;margin-bottom:.3rem;text-align:center}
.qr-sub{font-size:.82rem;color:#71717a;text-align:center;line-height:1.55;margin-bottom:1.25rem;max-width:280px}
.qr-sub strong{color:#3f3f46;font-weight:600}
.qr-box{
  position:relative;width:220px;height:220px;
  border-radius:14px;overflow:hidden;background:#fff;
  border:1.5px solid #e4e4e7;
  margin-bottom:1rem;
}
.qr-box img{
  width:100%;height:100%;object-fit:contain;display:block;
  transition:opacity .25s;
}
.qr-box.loading img{opacity:0}
.spin-layer{
  position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  opacity:0;transition:opacity .2s;pointer-events:none;
}
.qr-box.loading .spin-layer{opacity:1}
.spin{
  width:28px;height:28px;border-radius:50%;
  border:2.5px solid #e4e4e7;border-top-color:#25d366;
  animation:spin .8s linear infinite;
}
@keyframes spin{to{transform:rotate(360deg)}}
.prog-track{
  width:220px;height:3px;background:#f4f4f5;border-radius:99px;
  overflow:hidden;margin-bottom:1.1rem;
}
.prog-bar{
  height:100%;width:100%;border-radius:99px;
  background:#25d366;
  transform-origin:left;
  transition:background .4s;
}
.pairing{
  display:none;flex-direction:column;align-items:center;gap:.3rem;
  width:100%;margin-bottom:1rem;
}
.pairing-label{font-size:.7rem;color:#a1a1aa;letter-spacing:.06em;text-transform:uppercase}
.pairing-code{
  font-family:'SF Mono','Cascadia Code',Consolas,monospace;
  font-size:1.75rem;font-weight:700;color:#18181b;letter-spacing:.1em;line-height:1;
}
.pairing-code .sep{color:#d4d4d8;letter-spacing:0}
.pairing.on{display:flex}
.link-expiry{font-size:.72rem;color:#a1a1aa;text-align:center}
/* account chip */
.account-chip{
  display:none;align-items:center;gap:.55rem;
  background:#f4f4f5;border-radius:99px;padding:.35rem .75rem .35rem .45rem;
  margin-bottom:.25rem;
}
.account-chip.visible{display:flex}
.account-avatar{
  width:26px;height:26px;border-radius:50%;background:#25d366;
  display:flex;align-items:center;justify-content:center;
  font-size:.7rem;font-weight:700;color:#fff;flex-shrink:0;text-transform:uppercase;
}
.account-details{display:flex;flex-direction:column;gap:.05rem;line-height:1.2}
.account-name{font-size:.8rem;font-weight:600;color:#18181b}
.account-phone{font-size:.72rem;color:#71717a}
.s-done,.s-standby{
  display:none;flex-direction:column;align-items:center;gap:.85rem;
  text-align:center;padding:.5rem 0;
}
.icon-ok{
  width:64px;height:64px;border-radius:50%;
  background:#f0fdf4;
  display:flex;align-items:center;justify-content:center;
  margin-bottom:.25rem;
}
.icon-ok svg{width:30px;height:30px;stroke:#22c55e;stroke-width:2.5;fill:none;
  stroke-linecap:round;stroke-linejoin:round}
.s-done h2,.s-standby h2{font-size:1.1rem;font-weight:700;color:#18181b}
.s-done p,.s-standby p{font-size:.84rem;color:#71717a;line-height:1.6;max-width:270px}
.standby-badge{
  display:flex;align-items:center;gap:.4rem;
  font-size:.75rem;color:#22c55e;font-weight:500;
}
.standby-badge::before{
  content:'';width:7px;height:7px;border-radius:50%;background:#22c55e;
  animation:pdot 2.5s ease-in-out infinite;flex-shrink:0;
}
@keyframes pdot{0%,100%{opacity:1}50%{opacity:.3}}
.s-expired{
  display:none;flex-direction:column;align-items:center;gap:.85rem;
  text-align:center;padding:.5rem 0;
}
.icon-exp{
  width:64px;height:64px;border-radius:50%;
  background:#fef2f2;
  display:flex;align-items:center;justify-content:center;
  margin-bottom:.25rem;
}
.icon-exp svg{width:28px;height:28px;stroke:#f87171;stroke-width:2;fill:none;stroke-linecap:round}
.s-expired h2{font-size:1.1rem;font-weight:700;color:#18181b}
.s-expired p{font-size:.84rem;color:#71717a;line-height:1.6;max-width:270px}
body.done .s-qr,body.done .pairing{display:none}
body.done .s-done{display:flex}
body.standby .s-qr,body.standby .pairing{display:none}
body.standby .s-standby{display:flex}
body.expired .s-qr,body.expired .pairing{display:none}
body.expired .s-expired{display:flex}
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <div class="logo-mark">
      <svg viewBox="0 0 32 32"><path d="M16 2C8.27 2 2 8.27 2 16c0 2.47.65 4.79 1.79 6.8L2 30l7.4-1.77A13.93 13.93 0 0016 30c7.73 0 14-6.27 14-14S23.73 2 16 2zm7.58 19.42c-.32.9-1.87 1.72-2.56 1.8-.65.08-1.47.11-2.37-.15-.54-.16-1.24-.38-2.12-.74-3.73-1.6-6.16-5.36-6.35-5.61-.18-.24-1.5-2-.1-3.76a2.02 2.02 0 011.48-.67c.18 0 .35 0 .5.01.16.01.38-.06.6.45l.83 2.03c.08.18.13.4.02.64-.1.24-.16.38-.32.58-.16.2-.34.44-.48.6-.16.18-.33.38-.14.74.19.36.85 1.4 1.83 2.27 1.26 1.12 2.32 1.47 2.65 1.63.33.16.52.13.71-.08.2-.21.84-.98 1.06-1.32.22-.33.44-.27.74-.16.3.11 1.9.9 2.23 1.06.33.16.55.24.63.37.08.14.08.8-.24 1.7z"/></svg>
    </div>
    <span class="logo-name">Evolution<em>API</em></span>
  </div>
  <div class="s-qr">
    <h2 class="qr-title" id="qrTitle">Conectar WhatsApp</h2>
    <div class="account-chip" id="accountChip">
      <div class="account-avatar" id="accountAvatar"></div>
      <div class="account-details">
        <span class="account-name" id="accountName"></span>
        <span class="account-phone" id="accountPhone"></span>
      </div>
    </div>
    <p class="qr-sub">Abra o WhatsApp, toque em <strong>Dispositivos conectados</strong> e escaneie o código.</p>
    <div class="qr-box loading" id="qrWrap">
      <img id="qrImg" src="" alt="QR Code"/>
      <div class="spin-layer"><div class="spin"></div></div>
    </div>
    <div class="prog-track"><div class="prog-bar" id="progBar"></div></div>
    <div class="pairing" id="pairingSection">
      <span class="pairing-label">Código de emparelhamento</span>
      <div class="pairing-code"><span id="p1"></span><span class="sep"> – </span><span id="p2"></span></div>
    </div>
    <div class="link-expiry" id="expiry"></div>
  </div>
  <div class="s-done">
    <div class="icon-ok">
      <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
    </div>
    <h2>WhatsApp conectado!</h2>
    <div class="account-chip" id="doneChip">
      <div class="account-avatar" id="doneAvatar"></div>
      <div class="account-details">
        <span class="account-name" id="doneName"></span>
        <span class="account-phone" id="donePhone"></span>
      </div>
    </div>
    <p>Conexão estabelecida com sucesso.<br>Esta aba pode ser fechada.</p>
  </div>
  <div class="s-standby">
    <div class="icon-ok">
      <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
    </div>
    <h2>WhatsApp já está conectado</h2>
    <div class="account-chip" id="standbyChip">
      <div class="account-avatar" id="standbyAvatar"></div>
      <div class="account-details">
        <span class="account-name" id="standbyName"></span>
        <span class="account-phone" id="standbyPhone"></span>
      </div>
    </div>
    <p>Esta instância está ativa no momento. Caso a conexão caia, o QR Code aparecerá aqui automaticamente para você reconectar.</p>
    <div class="standby-badge">Monitorando conexão</div>
    <div class="link-expiry" id="standby-expiry"></div>
  </div>
  <div class="s-expired">
    <div class="icon-exp">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    </div>
    <h2>Link expirado</h2>
    <p>O tempo de validade deste link chegou ao fim. Acesse o painel e gere um novo link para reconectar.</p>
  </div>
</div>
<script>
(function(){
  const token = location.pathname.split('/').pop();
  const BASE_URL = ${JSON.stringify(serverUrl)};
  const QR_LIFETIME_MS = ${QR_LIFETIME} * 1000;

  let expiresAt = null;
  let tickInterval = null;
  let seenWaiting = false;
  let qrChangedAt = 0;
  let lastQrSrc = '';

  function base(){
    return BASE_URL || (location.origin + (location.pathname.split('/qrcode/')[0] || ''));
  }

  function fmtTime(ms){
    const m=Math.floor(ms/60000), s=Math.floor((ms%60000)/1000);
    return m>0 ? m+'m '+('0'+s).slice(-2)+'s' : s+'s';
  }

  function setExpiryText(text){
    ['expiry','standby-expiry'].forEach(id=>{
      const el=document.getElementById(id);
      if(el) el.textContent=text;
    });
  }

  function updateProgress(){
    if(!qrChangedAt) return;
    const bar=document.getElementById('progBar');
    if(!bar) return;
    const elapsed=Date.now()-qrChangedAt;
    const ratio=Math.max(0, 1-elapsed/QR_LIFETIME_MS);
    bar.style.transform='scaleX('+ratio.toFixed(3)+')';
    if(ratio < 0.2) bar.style.background='#f87171';
    else if(ratio < 0.45) bar.style.background='#fbbf24';
    else bar.style.background='#25d366';
  }

  function tick(){
    if(expiresAt){
      const diff=expiresAt-Date.now();
      setExpiryText(diff>0 ? 'Link expira em '+fmtTime(diff) : '');
    }
    updateProgress();
  }

  function setPairingCode(code){
    const sec=document.getElementById('pairingSection');
    if(!code||!sec){if(sec)sec.classList.remove('on');return;}
    document.getElementById('p1').textContent=code.slice(0,4);
    document.getElementById('p2').textContent=code.slice(4,8);
    sec.classList.add('on');
  }

  function fmtPhone(raw){
    if(!raw) return '';
    // strip @lid / @s.whatsapp.net suffixes if any
    const digits = raw.replace(/@.*/, '');
    return '+' + digits;
  }

  function fillChip(prefix, name, phone){
    const chip=document.getElementById(prefix+'Chip');
    const av=document.getElementById(prefix+'Avatar');
    const nm=document.getElementById(prefix+'Name');
    const ph=document.getElementById(prefix+'Phone');
    if(!chip) return;
    if(!name && !phone){ chip.classList.remove('visible'); return; }
    if(av) av.textContent = (name||phone||'?')[0];
    if(nm) nm.textContent = name||'';
    if(ph) ph.textContent = fmtPhone(phone);
    chip.classList.add('visible');
  }

  function setAccountInfo(name, phone){
    // QR state chip (prefix 'account')
    const chip=document.getElementById('accountChip');
    const av=document.getElementById('accountAvatar');
    const nm=document.getElementById('accountName');
    const ph=document.getElementById('accountPhone');
    const title=document.getElementById('qrTitle');
    if(name||phone){
      if(av) av.textContent=(name||phone||'?')[0];
      if(nm) nm.textContent=name||'';
      if(ph) ph.textContent=fmtPhone(phone);
      if(chip) chip.classList.add('visible');
      if(title) title.textContent=name ? 'Reconectar: '+name : 'Reconectar WhatsApp';
    }
    // standby/done chips
    fillChip('standby', name, phone);
    fillChip('done', name, phone);
  }

  async function poll(){
    try{
      const r=await fetch(base()+'/qrcode/'+token+'/data');
      const d=await r.json();

      if(d.status==='expired'){
        clearInterval(tickInterval);
        document.body.className='expired';
        return;
      }

      if(d.expiresAt) expiresAt=d.expiresAt;

      if(d.profileName||d.phoneNumber) setAccountInfo(d.profileName||null, d.phoneNumber||null);

      if(d.status==='connected'){
        if(seenWaiting){
          clearInterval(tickInterval);
          document.body.className='done';
          return;
        }
        document.body.className='standby';
        setTimeout(poll,7000);
        return;
      }

      seenWaiting=true;
      document.body.className='';
      const wrap=document.getElementById('qrWrap');
      const img=document.getElementById('qrImg');

      if(d.qrCode){
        if(d.qrCode!==lastQrSrc){
          lastQrSrc=d.qrCode;
          qrChangedAt=Date.now();
          img.style.opacity='.25';
          img.src=d.qrCode;
          img.onload=()=>{ img.style.opacity=''; };
          const bar=document.getElementById('progBar');
          if(bar){ bar.style.transition='none'; bar.style.transform='scaleX(1)'; void bar.offsetWidth; bar.style.transition=''; }
        }
        wrap.classList.remove('loading');
      } else {
        wrap.classList.add('loading');
      }
      setPairingCode(d.pairingCode||null);

    }catch(e){ console.warn('poll error',e); }
    setTimeout(poll,7000);
  }

  poll();
  tickInterval=setInterval(tick,250);
})();
</script>
</body>
</html>`;
}

// ─── End public QR Code page ────────────────────────────────────────────────

router.get('/assets/*', (req, res) => {
  const fileName = req.params[0];

  // Security: Reject paths containing traversal patterns
  if (!fileName || fileName.includes('..') || fileName.includes('\\') || path.isAbsolute(fileName)) {
    return res.status(403).send('Forbidden');
  }

  const basePath = path.join(process.cwd(), 'manager', 'dist');
  const assetsPath = path.join(basePath, 'assets');
  const filePath = path.join(assetsPath, fileName);

  // Security: Ensure the resolved path is within the assets directory
  const resolvedPath = path.resolve(filePath);
  const resolvedAssetsPath = path.resolve(assetsPath);

  if (!resolvedPath.startsWith(resolvedAssetsPath + path.sep) && resolvedPath !== resolvedAssetsPath) {
    return res.status(403).send('Forbidden');
  }

  if (fs.existsSync(resolvedPath)) {
    res.set('Content-Type', mimeTypes.lookup(resolvedPath) || 'text/css');
    res.send(fs.readFileSync(resolvedPath));
  } else {
    res.status(404).send('File not found');
  }
});

router
  .use((req, res, next) => telemetry.collectTelemetry(req, res, next))

  .get('/', async (req, res) => {
    res.status(HttpStatus.OK).json({
      status: HttpStatus.OK,
      message: 'Welcome to the Evolution API, it is working!',
      version: packageJson.version,
      clientName: databaseConfig.CONNECTION.CLIENT_NAME,
      manager: !serverConfig.DISABLE_MANAGER ? `${req.protocol}://${req.get('host')}/manager` : undefined,
      documentation: `https://doc.evolution-api.com`,
      whatsappWebVersion: (await fetchLatestWaWebVersion({})).version.join('.'),
    });
  })
  .post('/verify-creds', authGuard['apikey'], async (req, res) => {
    const facebookConfig = configService.get<Facebook>('FACEBOOK');
    return res.status(HttpStatus.OK).json({
      status: HttpStatus.OK,
      message: 'Credentials are valid',
      facebookAppId: facebookConfig.APP_ID,
      facebookConfigId: facebookConfig.CONFIG_ID,
      facebookUserToken: facebookConfig.USER_TOKEN,
    });
  })
  .post('/server/shutdown', globalApiKeyGuard, async (req, res) => {
    const shutdownConfig = configService.get<ServerShutdown>('SERVER_SHUTDOWN');

    if (!shutdownConfig.ENABLED) {
      return res.status(HttpStatus.FORBIDDEN).json({
        status: HttpStatus.FORBIDDEN,
        error: 'Forbidden',
        response: {
          message: ['Server shutdown endpoint is disabled'],
        },
      });
    }

    const exitCode = shutdownConfig.EXIT_CODE;
    const delayMs = shutdownConfig.DELAY_MS;

    res.on('finish', () => {
      const timer = setTimeout(() => {
        logger.warn(`Server shutdown requested by endpoint. Exiting with code ${exitCode}.`);
        process.exit(exitCode);
      }, delayMs);

      timer.unref();
    });

    return res.status(HttpStatus.ACCEPTED).json({
      status: HttpStatus.ACCEPTED,
      message: 'Server shutdown scheduled',
      response: {
        exitCode,
        delayMs,
      },
    });
  })
  .post('/server/prune', globalApiKeyGuard, async (req, res) => {
    const response = await dataPruneService.run();
    return res.status(HttpStatus.OK).json({
      status: HttpStatus.OK,
      message: 'Data prune completed',
      response,
    });
  })
  .use('/instance', new InstanceRouter(configService, ...guards).router)
  .use('/message', new MessageRouter(...guards).router)
  .use('/call', new CallRouter(...guards).router)
  .use('/chat', new ChatRouter(...guards).router)
  .use('/business', new BusinessRouter(...guards).router)
  .use('/group', new GroupRouter(...guards).router)
  .use('/template', new TemplateRouter(configService, ...guards).router)
  .use('/settings', new SettingsRouter(...guards).router)
  .use('/proxy', new ProxyRouter(...guards).router)
  .use('/label', new LabelRouter(...guards).router)
  .use('', new ChannelRouter(configService, ...guards).router)
  .use('', new EventRouter(configService, ...guards).router)
  .use('', new ChatbotRouter(...guards).router)
  .use('', new StorageRouter(...guards).router);

export { HttpStatus, router };
