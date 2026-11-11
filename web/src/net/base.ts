/**
 * Where the airoom server lives. When the UI is served BY the server (desktop
 * app, packaged builds — possibly on a fallback port if 8787 was taken), it's
 * simply our own origin. The Vite dev server (:5173) is the one case where the
 * UI and server ports differ.
 */
// 5173 is `npm run dev`; 5180 is the fleetview-fixture entry in launch.json
// (a second Vite so the render fixture can run beside another project's dev
// server). Both serve the UI only — the server stays on its own port.
const DEV_UI_PORTS = ['5173', '5180'];
const DEFAULT_SERVER_PORT = '8787';

const port = location.port && !DEV_UI_PORTS.includes(location.port) ? location.port : DEFAULT_SERVER_PORT;

export const API_BASE = `http://${location.hostname}:${port}`;
export const WS_URL = `ws://${location.hostname}:${port}`;
