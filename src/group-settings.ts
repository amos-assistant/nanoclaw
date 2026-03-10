import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath } from './group-folder.js';

interface GroupSettings {
  model?: string;
}

function settingsPath(folder: string): string {
  return path.join(resolveGroupFolderPath(folder), 'settings.json');
}

function loadSettings(folder: string): GroupSettings {
  const file = settingsPath(folder);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as GroupSettings;
  } catch {
    return {};
  }
}

function saveSettings(folder: string, settings: GroupSettings): void {
  const file = settingsPath(folder);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}

export function getGroupModel(folder: string): string | undefined {
  return loadSettings(folder).model;
}

export function setGroupModel(folder: string, model: string): void {
  const settings = loadSettings(folder);
  settings.model = model;
  saveSettings(folder, settings);
}
