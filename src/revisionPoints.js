// Listes de révision : du contenu, jamais une note ni une nouvelle échéance.
// Une ligne = un point. Les suppressions restent horodatées pour qu'un
// appareil en retard ne les réintroduise pas pendant la synchronisation.
export const REVISION_SECTIONS = [
  { key: 'course', label: 'Cours', hint: 'Notions, formules et conditions d’application.' },
  { key: 'methods', label: 'Méthodes d’exercices', hint: 'Quand utiliser la méthode → étapes essentielles.' },
  { key: 'proofs', label: 'Démonstrations', hint: 'Résultat à démontrer → idée et étapes clés.' },
];
export const REVISION_POINT_MAX = 1000;
export const REVISION_ACTIVE_MAX = 90;
const categories = new Set(REVISION_SECTIONS.map((section) => section.key));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;

export function validateRevisionPoints(points) {
  if (!Array.isArray(points)) return ['les points de révision doivent être une liste.'];
  const errors = [];
  const ids = new Set();
  for (const point of points) {
    if (!point || typeof point !== 'object' || Array.isArray(point)) {
      errors.push('point de révision invalide.'); continue;
    }
    if (typeof point.id !== 'string' || !point.id || point.id.length > 200 || ids.has(point.id)) {
      errors.push('identifiant de point manquant ou dupliqué.');
    }
    ids.add(point.id);
    if (!categories.has(point.category)) errors.push('catégorie de révision inconnue.');
    if (typeof point.text !== 'string' || !point.text.trim() || point.text.length > REVISION_POINT_MAX) {
      errors.push(`un point doit contenir de 1 à ${REVISION_POINT_MAX} caractères.`);
    }
    if (!validTime(point.updatedAt)) errors.push('date de modification du point invalide.');
    if (!Number.isSafeInteger(point.order) || point.order < 0) errors.push('ordre de point invalide.');
    if (typeof point.deleted !== 'boolean') errors.push('indicateur de suppression invalide.');
  }
  // La limite de saisie ne s'applique pas à l'union de deux appareils :
  // deux ajouts hors ligne valides doivent rester synchronisables sans perte.
  return errors;
}

function canonical(point) {
  return {
    id: point.id, category: point.category, text: point.text.trim(),
    order: point.order, updatedAt: point.updatedAt, deleted: point.deleted,
  };
}

export function normRevisionPoints(points) {
  if (!Array.isArray(points)) return [];
  return points.filter((point) => validateRevisionPoints([point]).length === 0)
    .map(canonical).sort((a, b) => compare(a.id, b.id));
}

export function mergeRevisionPoints(a, b) {
  const byId = new Map();
  for (const point of [...normRevisionPoints(a), ...normRevisionPoints(b)]) {
    const previous = byId.get(point.id);
    // À heure égale, une suppression gagne ; dernier départage canonique.
    if (!previous || point.updatedAt > previous.updatedAt
      || (point.updatedAt === previous.updatedAt && (
        Number(point.deleted) > Number(previous.deleted)
        || (point.deleted === previous.deleted
          && compare(JSON.stringify(point), JSON.stringify(previous)) > 0)
      ))) byId.set(point.id, point);
  }
  return [...byId.values()].sort((a, b) => compare(a.id, b.id));
}

export function visibleRevisionPoints(points, category) {
  const seen = new Set();
  return normRevisionPoints(points)
    .filter((point) => !point.deleted && (!category || point.category === category))
    .sort((a, b) => a.order - b.order || compare(a.id, b.id))
    .filter((point) => {
      const key = `${point.category}\n${point.text}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
}

export function revisionDraft(points) {
  return Object.fromEntries(REVISION_SECTIONS.map(({ key }) => [
    key, visibleRevisionPoints(points, key).map((point) => point.text).join('\n'),
  ]));
}

export function parseRevisionDraft(draft) {
  const parsed = Object.fromEntries(REVISION_SECTIONS.map(({ key }) => [key,
    [...new Set(String(draft?.[key] || '').split('\n')
      .map((line) => line.trim().replace(/^(?:[-*•]\s+|\d+[.)]\s+)/u, '').trim())
      .filter(Boolean))],
  ]));
  const lines = Object.values(parsed).flat();
  if (lines.length > REVISION_ACTIVE_MAX) throw new Error(`Maximum ${REVISION_ACTIVE_MAX} points par portion.`);
  if (lines.some((line) => line.length > REVISION_POINT_MAX)) {
    throw new Error(`Chaque point doit rester sous ${REVISION_POINT_MAX} caractères. Scinde les points trop longs.`);
  }
  return parsed;
}

// Ne modifie que les points présents à l'ouverture de l'éditeur. Un ajout
// synchronisé pendant la saisie n'est donc jamais supprimé par un vieux brouillon.
export function updateRevisionPoints(current, baseline, draft, now, makeId) {
  const parsed = parseRevisionDraft(draft);
  const previous = revisionDraft(baseline);
  const records = new Map(normRevisionPoints(current).map((point) => [point.id, point]));
  for (const { key } of REVISION_SECTIONS) {
    if (parsed[key].join('\n') === previous[key]) continue;
    const base = normRevisionPoints(baseline).filter((point) => !point.deleted && point.category === key);
    for (const point of base) {
      if (!parsed[key].includes(point.text)) {
        const existing = records.get(point.id) || point;
        if (existing.updatedAt <= point.updatedAt) records.set(point.id, {
          ...existing, deleted: true, updatedAt: Math.max(now, existing.updatedAt + 1),
        });
      }
    }
    parsed[key].forEach((text, order) => {
      const existing = [...records.values()].find((point) => !point.deleted
        && point.category === key && point.text === text);
      if (existing) {
        if (existing.order !== order) records.set(existing.id, {
          ...existing, order, updatedAt: Math.max(now, existing.updatedAt + 1),
        });
      } else {
        const id = makeId();
        records.set(id, { id, category: key, text, order, updatedAt: now, deleted: false });
      }
    });
  }
  const result = normRevisionPoints([...records.values()]);
  const errors = validateRevisionPoints(result);
  if (errors.length) throw new Error(errors[0]);
  return result;
}
