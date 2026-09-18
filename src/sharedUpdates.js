import {
  additionDateFromPosition, isValidISODate, newChapter, newReviewUnit,
  normDocs, reviewUnitId, validateImport, isSafeDocUrl,
} from './engine.js';

// Identifiant de lecture fourni par le propriétaire. Aucun jeton dans le dépôt.
export const SHARED_VAULT = {
  gistId: 'e562b165d8395c534266b0df56baf785',
  owner: 'bobodelatess',
  updatesUrl: './study-updates.json',
};

export function validateStudyUpdates(feed, gistId) {
  if (!feed || feed.version !== 1 || feed.gistId !== gistId
    || !Array.isArray(feed.updates) || feed.updates.length > 10000) {
    throw new Error('Le fichier des récapitulatifs ne correspond pas à ce coffre.');
  }
  const ids = new Set();
  for (const u of feed.updates) {
    if (!u || !['id', 'subjectId', 'chapterId', 'chapterName', 'label'].every(
      (key) => typeof u[key] === 'string' && u[key].trim() && u[key].length <= 500,
    ) || ids.has(u.id) || !isValidISODate(u.date)
      || additionDateFromPosition(u.label) !== u.date
      || !Array.isArray(u.docs) || normDocs(u.docs).length !== u.docs.length
      || u.docs.some((d) => !d || typeof d.id !== 'string' || !d.id
        || typeof d.label !== 'string' || typeof d.url !== 'string' || !isSafeDocUrl(d.url))) {
      throw new Error('Un récapitulatif est invalide ; aucun ajout n’a été appliqué.');
    }
    ids.add(u.id);
  }
  return feed;
}

// Une liste d'ajouts, jamais un remplacement de l'état personnel. Les reçus
// se synchronisent ; une relecture ne rejoue pas un ajout ni une évaluation.
export function applyStudyUpdates(state, feed, gistId, knownAppliedIds = state.appliedStudyUpdates || []) {
  validateStudyUpdates(feed, gistId);
  const known = new Set(knownAppliedIds);
  const applied = new Set(state.appliedStudyUpdates || []);
  let chapters = state.chapters.slice();
  let changed = false;
  for (const u of feed.updates.slice().sort((a, b) => a.date.localeCompare(b.date))) {
    if (known.has(u.id)) continue;
    const subject = state.subjects.find((s) => s.id === u.subjectId);
    if (!subject) continue; // ne crée pas une matière dans un autre suivi
    const unitId = reviewUnitId(u.chapterId, u.date);
    applied.add(u.id);
    changed = true;
    if (state.deleted?.subjects?.[u.subjectId] || state.deleted?.chapters?.[u.chapterId]
      || state.deleted?.chapters?.[unitId]) continue;
    let parent = chapters.find((c) => c.id === u.chapterId);
    if (parent && (parent.reviewUnit || parent.subjectId !== u.subjectId)) {
      throw new Error('Le chapitre du récapitulatif ne correspond pas à la matière.');
    }
    if (!parent) {
      parent = { ...newChapter(u.subjectId, u.chapterName, null, state.settings), id: u.chapterId };
      chapters.push(parent);
    }
    const docs = normDocs(parent.docs);
    for (const d of normDocs(u.docs)) {
      if (!docs.some((existing) => existing.id === d.id || existing.url === d.url)) {
        docs.push({ ...d, addedAt: u.date, lastUsedAt: null });
      }
    }
    const newer = !parent.positionUpdatedAt || u.date >= parent.positionUpdatedAt;
    const current = chapters.find((c) => c.subjectId === u.subjectId && c.status === 'current');
    const advance = newer && (!current || !current.positionUpdatedAt || u.date > current.positionUpdatedAt);
    parent = {
      ...parent, docs,
      ...(newer ? { position: u.label, positionUpdatedAt: u.date } : {}),
      ...(advance ? { status: 'current' } : {}),
    };
    chapters = chapters.map((c) => c.id === parent.id ? parent
      : advance && c.subjectId === u.subjectId && c.status === 'current'
        ? { ...c, status: 'consolidating' } : c);
    const existing = chapters.find((c) => c.id === unitId);
    if (existing) {
      // Correction du libellé seulement : rappel, journal et notes conservés.
      chapters = chapters.map((c) => c.id === unitId ? { ...c, name: u.label } : c);
    } else {
      chapters.push(newReviewUnit(parent, u.label, u.date, state.settings));
    }
  }
  if (!changed) return state;
  const next = { ...state, chapters, appliedStudyUpdates: [...applied].sort() };
  const check = validateImport(next);
  if (!check.ok) throw new Error(`Récapitulatif refusé : ${check.errors[0]}`);
  return next;
}

export async function pullStudyUpdates(sharedVault, fetchImpl = fetch) {
  const res = await fetchImpl(sharedVault.updatesUrl, { cache: 'no-store' });
  if (!res.ok) throw new Error('Les récapitulatifs GitHub sont momentanément indisponibles.');
  return validateStudyUpdates(await res.json(), sharedVault.gistId);
}
