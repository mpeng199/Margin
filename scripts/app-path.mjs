// Where Margin.app lives: /Applications when writable (Finder, Launchpad, Spotlight), else ~/Applications.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function appDestination() {
  try { fs.accessSync('/Applications', fs.constants.W_OK); return '/Applications/Margin.app'; }
  catch { return path.join(os.homedir(), 'Applications', 'Margin.app'); }
}
export const otherAppLocations = () => ['/Applications/Margin.app', path.join(os.homedir(), 'Applications', 'Margin.app')].filter((p) => p !== appDestination());
export const dataDir = () => process.env.MARGIN_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'Margin');
