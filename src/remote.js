/*
 * Transport de synchronisation — coffre distant.
 *
 * CADENCE n'a toujours aucun serveur. Le coffre est un **gist privé dans le
 * compte GitHub de l'utilisateur** : c'est lui qui héberge ses données, il
 * peut les lire, les révoquer et les supprimer sans passer par nous.
 *
 * Sécurité, règles tenues ici :
 *   - le jeton d'accès vit sous SA PROPRE clé de stockage (`cadence.sync`),
 *     jamais dans l'état CADENCE : un export JSON ne peut pas le divulguer ;
 *   - un jeton n'a besoin que de la portée « gists » — ni le code, ni les
 *     dépôts, ni rien d'autre ;
 *   - aucune donnée n'est envoyée tant que l'utilisateur n'a pas activé la
 *     synchronisation lui-même.
 *
 * Toutes les fonctions réseau prennent `fetchImpl` en paramètre : le module
 * est testable sans réseau.
 */

export const SYNC_KEY = 'cadence.sync';
export const DEVICE_KEY = 'cadence.device';
export const VAULT_FILE = 'cadence-sync.json';
const API = 'https://api.github.com';

// Identifiant de CET appareil : créé une fois par navigateur, indépendant de
// la synchronisation (il sert aussi à départager deux modifications faites à
// la même milliseconde). Il ne quitte jamais l'appareil autrement que dans
// `syncMeta.deviceId`, qui ne dit rien de l'utilisateur.
export function getDeviceId(store, make) {
  try {
    const existing = store?.getItem(DEVICE_KEY);
    if (existing) return existing;
  } catch (e) { /* stockage indisponible : identifiant volatil */ }
  const id = make();
  try { store?.setItem(DEVICE_KEY, id); } catch (e) { /* ignore */ }
  return id;
}

/* ------------------------------------------------------------------ *
 *  Configuration locale (jamais exportée avec les données)
 * ------------------------------------------------------------------ */

export function loadSyncConfig(store) {
  try {
    const raw = store?.getItem(SYNC_KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw);
    return cfg && typeof cfg === 'object' ? cfg : null;
  } catch (e) { return null; }
}

export function saveSyncConfig(store, cfg) {
  try { store?.setItem(SYNC_KEY, JSON.stringify(cfg)); return true; }
  catch (e) { return false; }
}

export function clearSyncConfig(store) {
  try { store?.removeItem(SYNC_KEY); return true; }
  catch (e) { return false; }
}

export function isConfigured(cfg) {
  return !!(cfg && cfg.token && cfg.gistId);
}

/* ------------------------------------------------------------------ *
 *  Erreurs lisibles
 * ------------------------------------------------------------------ */

export class SyncError extends Error {
  constructor(message, { status = 0, kind = 'reseau' } = {}) {
    super(message);
    this.name = 'SyncError';
    this.status = status;
    this.kind = kind; // 'auth' | 'introuvable' | 'quota' | 'reseau' | 'donnees'
  }
}

export function describeStatus(status) {
  if (status === 401) return new SyncError('Jeton refusé : il est invalide, révoqué ou expiré. Recrée-en un avec la portée « gists ».', { status, kind: 'auth' });
  if (status === 403) return new SyncError('Accès refusé par GitHub (portée « gists » manquante, ou limite d’appels atteinte). Réessaie dans quelques minutes.', { status, kind: 'quota' });
  if (status === 404) return new SyncError('Coffre introuvable : il a été supprimé, ou ce jeton n’appartient pas au compte qui l’héberge.', { status, kind: 'introuvable' });
  if (status === 422) return new SyncError('GitHub a refusé le contenu envoyé.', { status, kind: 'donnees' });
  return new SyncError(`Échec de la synchronisation (code ${status}).`, { status, kind: 'reseau' });
}

async function call(url, { token, method = 'GET', body }, fetchImpl) {
  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) throw new SyncError('Réseau indisponible dans cet environnement.');
  let res;
  try {
    res = await doFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    throw new SyncError('Pas de connexion : la synchronisation reprendra automatiquement.', { kind: 'reseau' });
  }
  if (!res.ok) throw describeStatus(res.status);
  try { return await res.json(); }
  catch (e) { throw new SyncError('Réponse illisible de GitHub.', { kind: 'donnees' }); }
}

/* ------------------------------------------------------------------ *
 *  Opérations sur le coffre
 * ------------------------------------------------------------------ */

// Crée le coffre (gist PRIVÉ) et renvoie son identifiant.
export async function createVault(token, state, fetchImpl) {
  const data = await call(`${API}/gists`, {
    token, method: 'POST',
    body: {
      description: 'CADENCE — coffre de synchronisation (privé)',
      public: false,
      files: { [VAULT_FILE]: { content: JSON.stringify(state, null, 1) } },
    },
  }, fetchImpl);
  if (!data?.id) throw new SyncError('GitHub n’a pas renvoyé d’identifiant de coffre.', { kind: 'donnees' });
  return { gistId: data.id, version: data.history?.[0]?.version ?? null };
}

// Lit le coffre. Renvoie { state, version } ; state vaut null si le coffre
// existe mais ne contient pas encore de données CADENCE lisibles.
export async function pullVault({ token, gistId }, fetchImpl) {
  const data = await call(`${API}/gists/${gistId}`, { token }, fetchImpl);
  const file = data?.files?.[VAULT_FILE];
  const version = data?.history?.[0]?.version ?? null;
  if (!file) return { state: null, version };
  let content = file.content;
  // Au-delà de 1 Mo l'API tronque : on relit le fichier brut.
  if (file.truncated && file.raw_url) {
    const doFetch = fetchImpl || fetch;
    try { content = await (await doFetch(file.raw_url)).text(); }
    catch (e) { throw new SyncError('Coffre trop volumineux et illisible.', { kind: 'donnees' }); }
  }
  if (!content) return { state: null, version };
  try { return { state: JSON.parse(content), version }; }
  catch (e) {
    throw new SyncError('Le coffre distant ne contient pas du JSON valide — synchronisation interrompue pour ne rien écraser.', { kind: 'donnees' });
  }
}

// Écrit l'état dans le coffre.
export async function pushVault({ token, gistId }, state, fetchImpl) {
  const data = await call(`${API}/gists/${gistId}`, {
    token, method: 'PATCH',
    body: { files: { [VAULT_FILE]: { content: JSON.stringify(state, null, 1) } } },
  }, fetchImpl);
  return { version: data?.history?.[0]?.version ?? null };
}

// Vérifie qu'un jeton fonctionne et renvoie le compte associé.
export async function checkToken(token, fetchImpl) {
  const data = await call(`${API}/user`, { token }, fetchImpl);
  return { login: data?.login ?? null };
}
