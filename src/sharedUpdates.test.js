import { describe, expect, it } from 'vitest';
import {
  seedState, newChapter, newReviewUnit, normalize, reviewUnitInfo, validateImport,
} from './engine.js';
import { applyStudyUpdates } from './sharedUpdates.js';
import { mergeStates, preferredState } from './sync.js';

function scenario() {
  const state = normalize(seedState());
  const parent = { ...newChapter(state.subjects[0].id, 'Ancien chapitre', null, state.settings), id: 'parent', status: 'current' };
  const old = newReviewUnit(parent, 'Ajout du 01/09/2026 — bases', '2026-09-01', state.settings);
  state.chapters = [parent, { ...old, lastMasteryLevel: 3, reviewSuccessStreak: 1 }];
  const feed = { version: 1, gistId: 'vault', updates: [{
    id: 'recap-15-v1', date: '2026-09-15', subjectId: parent.subjectId,
    chapterId: 'new-parent', chapterName: 'Matrices', label: 'Ajout du 15/09/2026 — noyau et image',
    docs: [{ id: 'pdf', label: 'PDF', url: 'https://drive.google.com/file/d/example/view' }],
  }] };
  return { state, feed };
}

describe('ajouts publiés sur GitHub', () => {
  it('ajoute les rappels à J+1 sans modifier les portions anciennes ni inventer de résultats', () => {
    const { state, feed } = scenario();
    const next = applyStudyUpdates(state, feed, 'vault');
    expect(validateImport(next).ok).toBe(true);
    expect(next.chapters.find((c) => c.id === state.chapters[1].id)).toEqual(state.chapters[1]);
    expect(next.reviewLog).toBe(state.reviewLog);
    expect(next.courseTestLog).toBe(state.courseTestLog);
    expect(next.settings).toBe(state.settings);
    const unit = next.chapters.find((c) => c.parentChapterId === 'new-parent');
    expect(unit.recall.lastReviewed).toBeNull();
    expect(unit.lastMasteryLevel).toBeNull();
    expect(reviewUnitInfo(unit, next.settings, '2026-09-18').dueAt).toBe('2026-09-16');
    expect(next.chapters.find((c) => c.id === 'new-parent').status).toBe('current');
    expect(next.chapters.find((c) => c.id === 'parent').status).toBe('consolidating');
  });

  it('ne rejoue pas les ajouts après normalisation, fusion ou correction par l’utilisateur', () => {
    const { state, feed } = scenario();
    const next = normalize(applyStudyUpdates(state, feed, 'vault'));
    const unit = next.chapters.find((c) => c.parentChapterId === 'new-parent');
    unit.name = 'Ma précision personnelle';
    const merged = mergeStates(next, state);
    expect(merged.appliedStudyUpdates).toEqual(['recap-15-v1']);
    expect(applyStudyUpdates(merged, feed, 'vault')).toBe(merged);
    expect(merged.chapters.find((c) => c.id === unit.id).name).toBe('Ma précision personnelle');
  });

  it('respecte les suppressions et une progression plus récente', () => {
    const { state, feed } = scenario();
    state.deleted.chapters['new-parent'] = '2026-09-18';
    expect(applyStudyUpdates(state, feed, 'vault').chapters).toEqual(state.chapters);
    state.deleted.chapters = {};
    state.chapters[0].positionUpdatedAt = '2026-09-18';
    const next = applyStudyUpdates(state, feed, 'vault');
    expect(next.chapters.find((c) => c.id === 'parent').status).toBe('current');
  });

  it('un ancien appareil plus récemment modifié reçoit les ajouts sans perdre ses réglages', () => {
    const { state, feed } = scenario();
    feed.updates[0].chapterId = 'parent';
    state.syncMeta = { updatedAt: 10, deviceId: 'a', rev: 1 };
    const remote = applyStudyUpdates(state, feed, 'vault');
    const local = structuredClone(state);
    local.syncMeta = { updatedAt: 20, deviceId: 'b', rev: 2 };
    local.settings.requestRetention = 0.95;
    const merged = mergeStates(local, remote);
    const next = applyStudyUpdates(merged, feed, 'vault', preferredState(local, remote).appliedStudyUpdates || []);
    expect(next.settings.requestRetention).toBe(0.95);
    expect(next.chapters.find((c) => c.id === 'parent').position).toBe(feed.updates[0].label);
    expect(next.chapters.filter((c) => c.introducedAt === '2026-09-15')).toHaveLength(1);
  });

  it('corrige une portion existante en conservant sa restitution réelle', () => {
    const { state, feed } = scenario();
    const once = applyStudyUpdates(state, feed, 'vault');
    const unit = once.chapters.find((c) => c.parentChapterId === 'new-parent');
    unit.lastMasteryLevel = 2;
    unit.recall.lastReviewed = '2026-09-17';
    feed.updates[0].id = 'recap-15-v2';
    feed.updates[0].label += ' et base';
    const next = applyStudyUpdates(once, feed, 'vault');
    expect(next.chapters.filter((c) => c.parentChapterId === 'new-parent')).toHaveLength(1);
    expect(next.chapters.find((c) => c.id === unit.id)).toMatchObject({ lastMasteryLevel: 2, recall: { lastReviewed: '2026-09-17' } });
  });

  it('refuse un autre coffre et les liens actifs', () => {
    const { state, feed } = scenario();
    expect(() => applyStudyUpdates(state, feed, 'other')).toThrow();
    feed.updates[0].docs[0].url = 'javascript:alert(1)';
    expect(() => applyStudyUpdates(state, feed, 'vault')).toThrow();
  });
});
