// Packages shell/ into Margin.app (Electron) and installs it to ~/Applications.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packager } from '@electron/packager';
import { appDestination, otherAppLocations } from './app-path.mjs';

const root = path.resolve(import.meta.dirname, '..');
const electronVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/electron/package.json'), 'utf8')).version;
const [appPath] = await packager({
  dir: path.join(root, 'shell'),
  name: 'Margin',
  executableName: 'Margin',
  appBundleId: 'dev.minimike.margin',
  appCategoryType: 'public.app-category.productivity',
  icon: path.join(root, 'shell/assets/Margin.icns'),
  electronVersion,
  out: path.join(root, 'out'),
  overwrite: true,
  platform: 'darwin',
  arch: process.arch,
  prune: true,
  quiet: true,
  extendInfo: { LSUIElement: false, NSHumanReadableCopyright: 'Local-first. Your data stays on this Mac.' },
});
const dest = appDestination();
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.rmSync(dest, { recursive: true, force: true });
for (const old of otherAppLocations()) fs.rmSync(old, { recursive: true, force: true }); // one copy only
fs.cpSync(path.join(appPath, 'Margin.app'), dest, { recursive: true, verbatimSymlinks: true });
console.log(`Installed ${dest}`);
