/*
 * Pilote de synchronisation : décide QUAND lire et écrire le coffre.
 *
 * Boucle unique, valable dans tous les cas (`syncNow`) :
 *   1. lire le coffre distant ;
 *   2. le valider — un coffre illisible n'écrase JAMAIS les données locales ;
 *   3. fusionner avec l'état local (fusion pure, convergente) ;
 *   4. appliquer localement si le résultat diffère du local ;
 *   5. réécrire le coffre si le résultat diffère du distant.
 *
 * Conséquence : deux appareils qui se synchronisent finissent sur le même
 * état, quel que soit l'ordre — et une panne réseau ne fait rien perdre,
 * puisque le local reste la source de vérité tant que l'envoi n'a pas eu lieu.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { normalize, validateImport } from './engine.js';
import { mergeStates, contentSignature, newDeviceId, isPristine } from './sync.js';
import {
  loadSyncConfig, saveSyncConfig, clearSyncConfig, isConfigured, getDeviceId,
  pullVault, pushVault, createVault, SyncError,
} from './remote.js';

// Délai d'inactivité avant d'envoyer les modifications (évite un appel réseau
// à chaque frappe tout en gardant les appareils proches du temps réel).
export const PUSH_DEBOUNCE_MS = 4000;

export function useSync({ store, getState, applyMerged, fetchImpl, enabled = true }) {
  const [config, setConfig] = useState(() => loadSyncConfig(store));
  const [status, setStatus] = useState('idle'); // idle | sync | ok | error | offline
  const [error, setError] = useState(null);
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [pending, setPending] = useState(false);

  const busyRef = useRef(false);
  const rerunRef = useRef(false);
  const configRef = useRef(config);
  configRef.current = config;

  // Identifiant d'appareil : stable par navigateur, indépendant de la synchro.
  const deviceId = getDeviceId(store, newDeviceId);

  const persist = useCallback((next) => {
    setConfig(next);
    configRef.current = next;
    if (next) saveSyncConfig(store, next); else clearSyncConfig(store);
  }, [store]);

  const syncNow = useCallback(async () => {
    const cfg = configRef.current;
    if (!enabled || !isConfigured(cfg)) return { ok: false, reason: 'inactif' };
    if (busyRef.current) { rerunRef.current = true; return { ok: false, reason: 'occupé' }; }
    busyRef.current = true;
    setStatus('sync');
    setError(null);
    try {
      const { state: rawRemote } = await pullVault(cfg, fetchImpl);
      const local = getState();

      let merged = local;
      if (rawRemote) {
        // Un coffre invalide n'écrase rien : on s'arrête et on le dit.
        const check = validateImport(rawRemote);
        if (!check.ok) {
          throw new SyncError(
            `Le coffre distant est invalide (${check.errors[0]}) — rien n’a été modifié ici.`,
            { kind: 'donnees' },
          );
        }
        const remote = normalize(rawRemote);
        // Appareil neuf qui rejoint un coffre : il adopte, il ne fusionne pas.
        // Sinon ses matières d'exemple par défaut pollueraient les vraies données.
        merged = isPristine(local) ? remote : mergeStates(local, remote);
      }

      const localSig = contentSignature(local);
      const mergedSig = contentSignature(merged);
      if (mergedSig !== localSig) applyMerged(merged);

      if (!rawRemote || mergedSig !== contentSignature(normalize(rawRemote))) {
        await pushVault(cfg, merged, fetchImpl);
      }

      setStatus('ok');
      setPending(false);
      const at = Date.now();
      setLastSyncAt(at);
      persist({ ...cfg, lastSyncAt: at });
      return { ok: true };
    } catch (e) {
      setStatus(e?.kind === 'reseau' ? 'offline' : 'error');
      setError(e?.message || 'Synchronisation impossible.');
      return { ok: false, error: e };
    } finally {
      busyRef.current = false;
      if (rerunRef.current) { rerunRef.current = false; setTimeout(() => { syncNow(); }, 0); }
    }
  }, [enabled, fetchImpl, getState, applyMerged, persist]);

  // Première activation : crée le coffre privé et y dépose l'état courant.
  const connect = useCallback(async (token) => {
    try {
      setStatus('sync');
      setError(null);
      const { gistId } = await createVault(token, getState(), fetchImpl);
      const cfg = { token, gistId, deviceId, lastSyncAt: Date.now() };
      persist(cfg);
      setStatus('ok');
      setLastSyncAt(cfg.lastSyncAt);
      return { ok: true, gistId };
    } catch (e) {
      setStatus('error');
      setError(e?.message || 'Activation impossible.');
      return { ok: false, error: e };
    }
  }, [fetchImpl, getState, persist, deviceId]);

  // Deuxième appareil : rejoint un coffre existant, puis fusionne.
  const join = useCallback(async (token, gistId) => {
    const cfg = { token, gistId: String(gistId || '').trim(), deviceId };
    persist(cfg);
    const res = await syncNow();
    if (!res.ok && res.error) persist(null); // identifiants refusés : on ne garde rien
    return res;
  }, [persist, syncNow]);

  const disconnect = useCallback(() => {
    persist(null);
    setStatus('idle');
    setError(null);
    setLastSyncAt(null);
    setPending(false);
  }, [persist]);

  const markPending = useCallback(() => {
    if (isConfigured(configRef.current)) setPending(true);
  }, []);

  return {
    config, deviceId, status, error, lastSyncAt, pending,
    configured: isConfigured(config),
    connect, join, disconnect, syncNow, markPending, setPending,
  };
}

// Déclencheurs automatiques : au chargement, après une pause de saisie, au
// retour sur l'onglet et au retour du réseau.
export function useSyncTriggers({ configured, signature, syncNow, markPending }) {
  const timerRef = useRef(null);
  const firstRef = useRef(true);

  useEffect(() => {
    if (!configured) return undefined;
    if (firstRef.current) { firstRef.current = false; syncNow(); return undefined; }
    markPending();
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { syncNow(); }, PUSH_DEBOUNCE_MS);
    return () => clearTimeout(timerRef.current);
  }, [configured, signature, syncNow, markPending]);

  useEffect(() => {
    if (!configured || typeof window === 'undefined') return undefined;
    const onVisible = () => { if (document.visibilityState === 'visible') syncNow(); };
    const onOnline = () => syncNow();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('focus', onVisible);
    };
  }, [configured, syncNow]);
}
