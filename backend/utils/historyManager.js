import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const HISTORY_FILE = join(DATA_DIR, 'history.json');
const MAX_HISTORY = 50;

export async function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
  if (!existsSync(HISTORY_FILE)) {
    await writeFile(HISTORY_FILE, JSON.stringify([], null, 2));
  }
}

export async function loadHistory() {
  try {
    const raw = await readFile(HISTORY_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export async function saveHistory(item) {
  const history = await loadHistory();

  // Remove existing entry with same ID if re-running
  const filtered = history.filter(h => h.id !== item.id);

  // Prepend new item (most recent first), limit size
  const updated = [item, ...filtered].slice(0, MAX_HISTORY);

  await writeFile(HISTORY_FILE, JSON.stringify(updated, null, 2));
}

export async function deleteHistory(id) {
  const history = await loadHistory();
  const updated = history.filter(h => h.id !== id);
  await writeFile(HISTORY_FILE, JSON.stringify(updated, null, 2));
}
