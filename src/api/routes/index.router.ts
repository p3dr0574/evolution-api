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
import { createQrToken, deleteQrToken, resolveQrToken } from '@utils/qrPublicTokens';
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

router.post('/instance/qrcode/publicLink/:instanceName', authGuard['apikey'], (req, res) => {
  const { instanceName } = req.params as { instanceName: string };
  const instance = waMonitor.waInstances[instanceName];

  if (!instance) {
    return res.status(HttpStatus.NOT_FOUND).json({ error: 'Instance not found' });
  }

  const state = instance.connectionStatus?.state;

  if (state === 'open') {
    return res.status(HttpStatus.BAD_REQUEST).json({ error: 'Instance is already connected' });
  }

  if (state === 'close') {
    instance.connectToWhatsapp().catch(() => {});
  }

  const token = createQrToken(instanceName);
  const serverUrl = (configService.get('SERVER') as any)?.URL ?? '';

  return res.status(HttpStatus.OK).json({ url: `${serverUrl}/qrcode/${token}` });
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

  if (state === 'open') {
    deleteQrToken(req.params.token);
    return res.status(HttpStatus.OK).json({ status: 'connected', instanceName: entry.instanceName });
  }

  const qr = instance.qrCode;

  return res.status(HttpStatus.OK).json({
    status: 'waiting',
    qrCode: qr?.base64 ?? null,
    expiresAt: entry.expiresAt,
  });
});

router.get('/qrcode/:token', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildQrPage());
});

function buildQrPage(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Conectar WhatsApp</title>
<style>
  :root{--bg:#f0f2f5;--card:#fff;--text:#111;--sub:#555;--accent:#25D366;--border:#e0e0e0;--shadow:0 4px 24px rgba(0,0,0,.08)}
  @media(prefers-color-scheme:dark){:root{--bg:#0d1117;--card:#161b22;--text:#e6edf3;--sub:#8b949e;--accent:#25D366;--border:#30363d;--shadow:0 4px 24px rgba(0,0,0,.4)}}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
  .card{background:var(--card);border:1px solid var(--border);border-radius:20px;box-shadow:var(--shadow);padding:2.5rem 2rem;max-width:380px;width:100%;text-align:center}
  .logo{width:48px;height:48px;margin:0 auto 1.25rem;background:var(--accent);border-radius:50%;display:flex;align-items:center;justify-content:center}
  .logo svg{width:28px;height:28px;fill:#fff}
  h1{font-size:1.25rem;font-weight:700;margin-bottom:.4rem}
  p.sub{font-size:.875rem;color:var(--sub);margin-bottom:1.75rem;line-height:1.5}
  .qr-wrap{position:relative;width:220px;height:220px;margin:0 auto 1.75rem;border-radius:12px;overflow:hidden;background:var(--border)}
  .qr-wrap img{width:100%;height:100%;display:block;transition:opacity .3s}
  .qr-wrap.loading img{opacity:.3}
  .spinner{position:absolute;inset:0;display:none;align-items:center;justify-content:center}
  .spinner svg{animation:spin 1s linear infinite;width:36px;height:36px;stroke:var(--accent);stroke-width:3;fill:none}
  @keyframes spin{to{transform:rotate(360deg)}}
  .qr-wrap.loading .spinner{display:flex}
  .status{font-size:.8rem;color:var(--sub);display:flex;align-items:center;justify-content:center;gap:.4rem;margin-bottom:1.25rem}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--accent);animation:pulse 2s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
  .timer{font-size:.75rem;color:var(--sub);margin-top:.5rem}
  /* connected state */
  .success{display:none;flex-direction:column;align-items:center;gap:1rem}
  .check{width:72px;height:72px;background:var(--accent);border-radius:50%;display:flex;align-items:center;justify-content:center;animation:pop .4s ease}
  @keyframes pop{from{transform:scale(.5);opacity:0}to{transform:scale(1);opacity:1}}
  .check svg{width:40px;height:40px;stroke:#fff;stroke-width:3;fill:none}
  .success h2{font-size:1.2rem;font-weight:700}
  .success p{font-size:.875rem;color:var(--sub)}
  /* expired */
  .expired{display:none;flex-direction:column;align-items:center;gap:.75rem}
  .expired-icon{font-size:2.5rem}
  .expired p{font-size:.875rem;color:var(--sub)}
  /* main hide/show */
  body.done .qr-section{display:none}
  body.done .success{display:flex}
  body.expired .qr-section{display:none}
  body.expired .expired{display:flex}
</style>
</head>
<body>
<div class="card">
  <div class="logo"><svg viewBox="0 0 32 32"><path d="M16 2C8.27 2 2 8.27 2 16c0 2.47.65 4.79 1.79 6.8L2 30l7.4-1.77A13.93 13.93 0 0016 30c7.73 0 14-6.27 14-14S23.73 2 16 2zm7.58 19.42c-.32.9-1.87 1.72-2.56 1.8-.65.08-1.47.11-2.37-.15-.54-.16-1.24-.38-2.12-.74-3.73-1.6-6.16-5.36-6.35-5.61-.18-.24-1.5-2-.1-3.76a2.02 2.02 0 011.48-.67c.18 0 .35 0 .5.01.16.01.38-.06.6.45l.83 2.03c.08.18.13.4.02.64-.1.24-.16.38-.32.58-.16.2-.34.44-.48.6-.16.18-.33.38-.14.74.19.36.85 1.4 1.83 2.27 1.26 1.12 2.32 1.47 2.65 1.63.33.16.52.13.71-.08.2-.21.84-.98 1.06-1.32.22-.33.44-.27.74-.16.3.11 1.9.9 2.23 1.06.33.16.55.24.63.37.08.14.08.8-.24 1.7z"/></svg></div>

  <div class="qr-section">
    <h1>Conectar WhatsApp</h1>
    <p class="sub">Abra o WhatsApp no celular, toque em <strong>Dispositivos conectados</strong> e escaneie o código.</p>
    <div class="qr-wrap loading" id="qrWrap">
      <img id="qrImg" src="" alt="QR Code"/>
      <div class="spinner"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 010 20"/></svg></div>
    </div>
    <div class="status"><span class="dot"></span> Aguardando escaneamento…</div>
    <div class="timer" id="timer"></div>
  </div>

  <div class="success">
    <div class="check"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div>
    <h2>Conectado!</h2>
    <p>WhatsApp conectado com sucesso. Esta janela pode ser fechada.</p>
  </div>

  <div class="expired">
    <div class="expired-icon">⏱</div>
    <h2>Link expirado</h2>
    <p>Gere um novo link no painel para conectar novamente.</p>
  </div>
</div>
<script>
(function(){
  const token = location.pathname.split('/').pop();
  let expiresAt = null;
  let timerInterval = null;

  function formatTime(ms){
    const m=Math.floor(ms/60000), s=Math.floor((ms%60000)/1000);
    return m>0 ? m+'m '+s+'s' : s+'s';
  }

  function updateTimer(){
    if(!expiresAt) return;
    const diff = expiresAt - Date.now();
    const el = document.getElementById('timer');
    if(diff<=0){ el.textContent=''; return; }
    el.textContent = 'Link expira em '+formatTime(diff);
  }

  async function poll(){
    try{
      const r = await fetch('/qrcode/'+token+'/data');
      const d = await r.json();

      if(d.status==='connected'){
        clearInterval(timerInterval);
        document.body.classList.add('done');
        return;
      }
      if(d.status==='expired'){
        clearInterval(timerInterval);
        document.body.classList.add('expired');
        return;
      }

      if(d.expiresAt) expiresAt = d.expiresAt;

      const wrap = document.getElementById('qrWrap');
      const img  = document.getElementById('qrImg');
      if(d.qrCode){
        img.src = d.qrCode;
        wrap.classList.remove('loading');
      } else {
        wrap.classList.add('loading');
      }
    }catch(e){
      console.warn('poll error',e);
    }
    setTimeout(poll, 15000);
  }

  poll();
  timerInterval = setInterval(updateTimer, 1000);
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
