import {
  BACKUP_KEY,
  KNOWN_VERSIONS,
  LEGACY_KEY,
  STORAGE_KEY,
  normalize,
  pruneBackups,
  seedState,
  todayISO,
  validateImport,
} from './engine.js';

export const QUARANTINE_KEY = 'cadence.recovery.corrupt';

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function assertKnownState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Le contenu enregistré n’est pas un état CADENCE.');
  }
  if (value.version != null && !KNOWN_VERSIONS.includes(value.version)) {
    throw new Error(`Version de données inconnue (${value.version}).`);
  }
}

/**
 * Parse, migrate and validate one serialized CADENCE state.
 * Unknown schema versions are deliberately rejected instead of being treated
 * as v1: an older tab must never downgrade and overwrite newer data.
 */
export function deserializeCadenceState(raw, today = todayISO()) {
  const parsed = JSON.parse(raw);
  assertKnownState(parsed);
  const state = normalize(parsed, today);
  const checked = validateImport(state);
  if (!checked.ok) {
    throw new Error(`État invalide : ${checked.errors.slice(0, 3).join(' ')}`);
  }
  return state;
}

function readNewestValidBackup(store, today) {
  const raw = store.getItem(BACKUP_KEY);
  if (!raw) return null;
  const backups = JSON.parse(raw);
  if (!backups || typeof backups !== 'object' || Array.isArray(backups)) return null;
  for (const date of Object.keys(backups).sort().reverse()) {
    try {
      const candidate = typeof backups[date] === 'string'
        ? backups[date]
        : JSON.stringify(backups[date]);
      return { date, state: deserializeCadenceState(candidate, today) };
    } catch (error) { /* essayer l'instantané précédent */ }
  }
  return null;
}

function quarantine(store, key, raw, error) {
  const record = {
    capturedAt: new Date().toISOString(),
    key,
    error: messageOf(error),
    raw,
  };
  try { store.setItem(QUARANTINE_KEY, JSON.stringify(record)); } catch (writeError) { /* conservé en mémoire ci-dessous */ }
  return record;
}

/**
 * Load without ever overwriting unreadable data. If the primary state cannot
 * be read, the newest valid daily snapshot is used. With no valid snapshot,
 * persistence stays blocked until the user explicitly chooses to reset.
 */
export function loadCadenceState(store, today = todayISO()) {
  const volatile = store.persistent === false;
  let raw = null;
  let key = STORAGE_KEY;
  try {
    raw = store.getItem(STORAGE_KEY);
    if (!raw) {
      key = LEGACY_KEY;
      raw = store.getItem(LEGACY_KEY);
    }
    if (!raw) {
      return {
        state: seedState(),
        writeBlocked: false,
        notice: volatile ? {
          kind: 'error',
          code: 'volatile',
          text: 'Le stockage durable est indisponible. Les changements seront perdus à la fermeture de cette page.',
        } : null,
      };
    }
    return {
      state: deserializeCadenceState(raw, today),
      writeBlocked: false,
      notice: volatile ? {
        kind: 'error',
        code: 'volatile',
        text: 'Le stockage durable est indisponible. Les changements seront perdus à la fermeture de cette page.',
      } : null,
    };
  } catch (error) {
    const recovery = raw == null ? null : quarantine(store, key, raw, error);
    try {
      const backup = readNewestValidBackup(store, today);
      if (backup) {
        return {
          state: backup.state,
          writeBlocked: false,
          recovery,
          notice: {
            kind: 'warning',
            code: 'recovered',
            text: `Les données principales étaient illisibles. La sauvegarde du ${backup.date} a été restaurée sans supprimer l’original.`,
          },
        };
      }
    } catch (backupError) { /* le message principal reste le plus utile */ }
    return {
      state: seedState(),
      writeBlocked: true,
      recovery,
      notice: {
        kind: 'error',
        code: 'corrupt',
        text: `Les données locales sont illisibles (${messageOf(error)}). Elles n’ont pas été écrasées.`,
      },
    };
  }
}

/** Write one state and verify that the exact payload can be read back. */
export function saveCadenceState(store, state) {
  try {
    const raw = JSON.stringify(state);
    store.setItem(STORAGE_KEY, raw);
    if (store.getItem(STORAGE_KEY) !== raw) {
      throw new Error('la vérification après écriture a échoué');
    }
    return { ok: true, raw };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

/** Keep one pre-change snapshot per day, capped to the latest seven days. */
export function saveDailyBackup(store, state, today = todayISO()) {
  try {
    const raw = store.getItem(BACKUP_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const backups = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    if (backups[today]) return { ok: true, created: false };
    const next = pruneBackups({ ...backups, [today]: state }, today, 7);
    store.setItem(BACKUP_KEY, JSON.stringify(next));
    return { ok: true, created: true };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

