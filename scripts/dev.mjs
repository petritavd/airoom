// Runs the server and web dev processes together with prefixed, colored output.
// No extra dependency — just Node's child_process.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(root, '..');

const procs = [
  { name: 'server', color: '\x1b[36m', cwd: path.join(repo, 'server') },
  { name: 'web', color: '\x1b[35m', cwd: path.join(repo, 'web') },
];

const children = procs.map(({ name, color, cwd }) => {
  const child = spawn('npm', ['run', 'dev'], { cwd, shell: true });
  const tag = `${color}[${name}]\x1b[0m `;
  const pipe = (stream) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) process.stdout.write(tag + l + '\n');
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', (code) => {
    process.stdout.write(tag + `exited (${code})\n`);
  });
  return child;
});

const shutdown = () => {
  for (const c of children) c.kill('SIGINT');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
