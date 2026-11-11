// Tiny static server for airoom.dev on Railway (no dependencies).
// - Serves the landing page files.
// - GET /download → the macOS installer: streams downloads/airoom-arm64.dmg
//   when such a file exists beside this script (a local preview), otherwise
//   302s to DOWNLOAD_URL, which defaults to the asset on the latest GitHub
//   release.
// - GET /download?os=windows → the same for the Windows installer.
// - GET /buy → 302 to the front page. airoom used to be sold there, and
//   builds up to 0.1.16 still carry the link.
// - POST /waitlist → forwarded to WAITLIST_URL when one is set (the hosted
//   team office's waitlist); 503 otherwise, which the page turns into an
//   email address.
// - GET /release.json → the current version and, sometimes, a short note. Every
//   running copy of the app fetches it to learn that a new build is out
//   (see ../server/src/release.ts and README "Telling running apps").
import http from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8123);

/**
 * Where the installers live: GitHub Releases, under stable asset names, so
 * "latest" always resolves and a release needs no deploy here. A file in
 * downloads/ wins when present, which is how a local preview serves a build
 * of its own.
 */
const RELEASES = 'https://github.com/petritavd/airoom/releases/latest/download';
const INSTALLERS = {
  mac: {
    file: path.join(ROOT, 'downloads', 'airoom-arm64.dmg'),
    name: 'airoom-arm64.dmg',
    type: 'application/x-apple-diskimage',
    url: process.env.DOWNLOAD_URL || `${RELEASES}/airoom-arm64.dmg`,
  },
  windows: {
    file: path.join(ROOT, 'downloads', 'airoom-x64.exe'),
    name: 'airoom-x64.exe',
    type: 'application/octet-stream',
    url: process.env.DOWNLOAD_URL_WINDOWS || `${RELEASES}/airoom-x64.exe`,
  },
};

/** Where a waitlist signup goes. Unset, the page offers an email address instead of a form. */
const WAITLIST_URL = process.env.WAITLIST_URL || '';

/**
 * Google Analytics, injected at serve time. The measurement id is public (it
 * ships in the page source), so committing it is fine — but it only applies
 * by default when actually running on Railway, so localhost and previews
 * never muddy the numbers. GA_MEASUREMENT_ID overrides it; set it empty to
 * turn analytics off without a commit.
 */
const GA_DEFAULT = 'G-F2Y136741P';
const GA_RAW = process.env.GA_MEASUREMENT_ID ?? (process.env.RAILWAY_ENVIRONMENT ? GA_DEFAULT : '');
const GA_ID = /^[A-Za-z0-9-]{4,32}$/.test(GA_RAW) ? GA_RAW : '';
const GA_SNIPPET = GA_ID
  ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>` +
    `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}` +
    `gtag('js',new Date());gtag('config','${GA_ID}');</script>`
  : '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.dmg': 'application/x-apple-diskimage',
  '.json': 'application/json',
};

/**
 * Stream one installer, honouring byte ranges. Ranges matter here: an 80MB
 * file over hotel wifi WILL get interrupted, and without them the browser
 * cannot resume — it saves a truncated file, macOS reports "the disk image
 * couldn't be opened" and Windows calls the installer corrupt, both of which
 * read as a broken product rather than a broken connection.
 */
function stream(req, res, file, size, filename, type) {
  const common = {
    'Content-Type': type,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-cache',
    'Accept-Ranges': 'bytes',
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && (range[1] || range[2])) {
    const start = range[1] ? parseInt(range[1], 10) : size - parseInt(range[2], 10);
    const end = range[1] && range[2] ? Math.min(parseInt(range[2], 10), size - 1) : size - 1;
    if (!(start >= 0 && start <= end && end < size)) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...common, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}` });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...common, 'Content-Length': size });
  createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0];

  // The waitlist form, forwarded with the real client IP so a rate limiter on
  // the far side sees people, not this proxy.
  if (url === '/waitlist' && req.method === 'POST') {
    if (!WAITLIST_URL) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end('{"error":"no waitlist configured"}');
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 4096) req.destroy();
    });
    req.on('end', async () => {
      try {
        const clientIp = (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || '';
        const r = await fetch(WAITLIST_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': clientIp },
          body,
        });
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(await r.text());
      } catch {
        // The far side being down must not look like a broken page: the form
        // shows its email fallback on any answer that is not a 2xx.
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end('{"error":"not recorded"}');
      }
    });
    return;
  }

  // Railway pings this to decide whether a new deploy is healthy enough to
  // take traffic. Answering it means a broken build never replaces a good one.
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, waitlist: !!WAITLIST_URL }));
    return;
  }

  if (url === '/download') {
    const os = new URL(req.url ?? '/', 'http://x').searchParams.get('os') === 'windows' ? 'windows' : 'mac';
    const inst = INSTALLERS[os];
    try {
      const st = await fs.stat(inst.file);
      stream(req, res, inst.file, st.size, inst.name, inst.type);
    } catch {
      res.writeHead(302, { Location: inst.url, 'Cache-Control': 'no-cache' });
      res.end();
    }
    return;
  }

  if (url === '/buy') {
    res.writeHead(302, { Location: '/#get' });
    res.end();
    return;
  }

  // static files with a traversal guard. Extensionless paths map to their
  // .html file, so the legal pages live at /privacy and /terms.
  let rel = url === '/' ? 'index.html' : url.slice(1);
  if (!path.extname(rel)) rel += '.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    let body = await fs.readFile(file);
    if (file.endsWith('.html')) {
      let html = body.toString('utf8').replaceAll('<!-- analytics -->', GA_SNIPPET);
      // The page shows a waitlist form only when there is somewhere to send it.
      html = html.replace('<body>', `<body data-waitlist="${WAITLIST_URL ? 'form' : 'email'}">`);
      body = Buffer.from(html);
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      // HTML and the release manifest must never be served stale: the manifest
      // is how every running copy of the app learns that a new build is out.
      'Cache-Control': file.endsWith('.html') || ext === '.json' ? 'no-cache' : 'public, max-age=3600',
      ...(ext === '.json' ? { 'Access-Control-Allow-Origin': '*' } : {}),
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(PORT, () => console.log(`airoom.dev landing on :${PORT}`));
