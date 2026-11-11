/**
 * Strip Chromium's unused locale packs.
 *
 * electron-builder's own `electronLanguages` option does not work here: it
 * looks for .lproj folders in Contents/Resources, but modern Electron keeps
 * them inside the framework instead — so the option is accepted, prunes
 * nothing, and reports success. This does the same job in the right place.
 *
 * airoom's interface is English-only. What these translate is Chromium's own
 * furniture — right-click menus, error pages — so dropping them costs nothing
 * except those appearing in English, while saving ~40 MB uncompressed.
 *
 * Runs after packaging and BEFORE signing, so the signature covers what ships.
 */
const { readdirSync, rmSync, statSync } = require('node:fs');
const path = require('node:path');

const KEEP = new Set(['en.lproj', 'en_GB.lproj', 'en_US.lproj']);

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const frameworks = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Frameworks');

  let removed = 0;
  let bytes = 0;
  for (const fw of readdirSync(frameworks)) {
    if (!fw.endsWith('.framework')) continue;
    const res = path.join(frameworks, fw, 'Versions', 'A', 'Resources');
    let entries;
    try {
      entries = readdirSync(res);
    } catch {
      continue; // framework without a Resources dir
    }
    for (const e of entries) {
      if (!e.endsWith('.lproj') || KEEP.has(e)) continue;
      const p = path.join(res, e);
      try {
        for (const f of readdirSync(p)) bytes += statSync(path.join(p, f)).size;
      } catch {
        /* size is only for the log line */
      }
      rmSync(p, { recursive: true, force: true });
      removed++;
    }
  }
  console.log(`  • pruned locales  removed=${removed} saved=${(bytes / 1048576).toFixed(0)}MB kept=${[...KEEP].join(',')}`);
};
