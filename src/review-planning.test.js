import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS, SPACED_REVIEW_MINUTES, addDays, applySelfAssessment,
  forecastReviewUnits, newCourseTest, newReviewUnit, reviewUnitInfo,
} from './engine.js';

const TODAY = '2026-09-13';
const S = { ...DEFAULT_SETTINGS };
const parent = { id: 'c1', subjectId: 's1', name: 'Chapitre' };
const unit = (date) => newReviewUnit(parent, `Ajout du ${date.split('-').reverse().join('/')} — notion`, date, S);
const integratedUnit = () => {
  const first = applySelfAssessment(unit('2026-08-01'), 3, '2026-08-02', S).chapter;
  return applySelfAssessment(first, 3, '2026-08-12', S).chapter;
};
const cumulativeTest = (over = {}) => ({
  ...newCourseTest('s1', 'Test cumulatif', addDays(TODAY, 3), ['c1'], [], TODAY), ...over,
});

describe('couverture des révisions espacées', () => {
  it('compte une fois toutes les portions actives : nouvelles, en retard et déjà revues', () => {
    const fresh = unit(TODAY);
    const overdue = unit(addDays(TODAY, -4));
    const reviewed = applySelfAssessment(unit(addDays(TODAY, -2)), 2, TODAY, S).chapter;
    const statesBefore = JSON.stringify([fresh, overdue, reviewed]);
    const forecast = forecastReviewUnits([fresh, overdue, reviewed], S, TODAY, 60);
    expect(forecast[TODAY]).toEqual({ count: 1, minutes: 25 });
    expect(forecast[addDays(TODAY, 1)]).toEqual({ count: 1, minutes: 25 });
    expect(forecast[reviewUnitInfo(reviewed, S, TODAY).dueAt])
      .toEqual({ count: 1, minutes: SPACED_REVIEW_MINUTES });
    expect(Object.values(forecast).reduce((sum, cell) => sum + cell.count, 0)).toBe(3);
    expect(JSON.stringify([fresh, overdue, reviewed])).toBe(statesBefore);
  });

  it('une portion intégrée couverte par un test ne fait plus planter le calendrier', () => {
    const integrated = integratedUnit();
    const tests = [cumulativeTest()];
    expect(reviewUnitInfo(integrated, S, TODAY, [], tests)).toMatchObject({ integrated: true, dueAt: null });
    expect(forecastReviewUnits([integrated, unit(TODAY)], S, TODAY, 35, [], tests))
      .toEqual({ [addDays(TODAY, 1)]: { count: 1, minutes: 25 } });
  });

  it('une intégration sans test cumulatif conserve une prochaine date individuelle', () => {
    const integrated = integratedUnit();
    const info = reviewUnitInfo(integrated, S, TODAY);
    expect(info.dueAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(info.minutes).toBe(SPACED_REVIEW_MINUTES);
    const date = info.dueAt < TODAY ? TODAY : info.dueAt;
    expect(forecastReviewUnits([integrated], S, TODAY, 365)[date]).toEqual({ count: 1, minutes: SPACED_REVIEW_MINUTES });
  });

  it.each([
    { scheduledFor: null }, { scheduledFor: 'inconnue' },
    { chapterIds: ['autre'], portionIds: [] }, { subjectId: 'autre' },
  ])('un rappel sans date ou hors périmètre ne remplace pas la révision (%#)', (over) => {
    expect(reviewUnitInfo(integratedUnit(), S, TODAY, [], [cumulativeTest(over)]).dueAt).not.toBeNull();
  });

  it('la couverture peut cibler une portion ; supprimer le rappel restaure la date individuelle', () => {
    const integrated = integratedUnit();
    const before = JSON.stringify(integrated);
    const test = cumulativeTest({ chapterIds: [], portionIds: [integrated.id] });
    expect(reviewUnitInfo(integrated, S, TODAY, [], [test]).dueAt).toBeNull();
    expect(reviewUnitInfo(integrated, S, TODAY, [], []).dueAt).not.toBeNull();
    expect(JSON.stringify(integrated)).toBe(before);
  });

  it('un rappel non fait reste dû le lendemain sans inventer de résultat', () => {
    const overdue = unit(addDays(TODAY, -7));
    expect(forecastReviewUnits([overdue], S, TODAY)[TODAY].count).toBe(1);
    const tomorrow = addDays(TODAY, 1);
    expect(forecastReviewUnits([overdue], S, tomorrow)[tomorrow].count).toBe(1);
    expect(overdue.recall.lastReviewed).toBeNull();
  });

  it('une échéance hors de la fenêtre affichée reste planifiée', () => {
    const reviewed = applySelfAssessment(unit(addDays(TODAY, -1)), 4, TODAY, S).chapter;
    const info = reviewUnitInfo(reviewed, S, TODAY);
    expect(forecastReviewUnits([reviewed], S, TODAY, 5)).toEqual({});
    expect(forecastReviewUnits([reviewed], S, TODAY, 365)[info.dueAt].count).toBe(1);
  });
});
