import React from 'react';
import { BookOpen, CalendarPlus, Check, Play } from 'lucide-react';

const STEPS = [
  {
    key: 'chapters',
    title: 'Ajoute tes chapitres',
    description: 'CADENCE a besoin de tes unités de travail pour bâtir un plan réaliste.',
    action: 'Ajouter mes chapitres',
    icon: BookOpen,
  },
  {
    key: 'exam',
    title: 'Relie une épreuve à ses chapitres',
    description: 'La date et le périmètre permettent d’ajuster les priorités.',
    action: 'Configurer une épreuve',
    icon: CalendarPlus,
  },
  {
    key: 'review',
    title: 'Fais un premier test',
    description: 'Un résultat sans correction sous les yeux calibre ton prochain passage.',
    action: 'Commencer mon plan',
    icon: Play,
  },
];

export default function OnboardingChecklist({
  hasChapters,
  hasCoveredExam,
  hasReview,
  onAddChapters,
  onConfigureExam,
  onStartFirstTest,
  canStartTest,
}) {
  const completion = {
    chapters: hasChapters,
    exam: hasCoveredExam,
    review: hasReview,
  };
  const completedCount = Object.values(completion).filter(Boolean).length;

  if (completedCount === STEPS.length) return null;

  const actions = {
    chapters: onAddChapters,
    exam: onConfigureExam,
    review: onStartFirstTest,
  };
  const currentKey = STEPS.find((step) => !completion[step.key])?.key;

  return (
    <section className="cad-onboarding" aria-labelledby="cad-onboarding-title">
      <div className="cad-onboarding-heading">
        <div>
          <p className="cad-eyebrow">Démarrage rapide · {completedCount}/{STEPS.length}</p>
          <h2 id="cad-onboarding-title">Ton plan devient précis en trois étapes</h2>
        </div>
        <div
          className="cad-onboarding-progress"
          role="progressbar"
          aria-label="Progression de la configuration"
          aria-valuemin="0"
          aria-valuemax={STEPS.length}
          aria-valuenow={completedCount}
        >
          <span style={{ width: `${(completedCount / STEPS.length) * 100}%` }} />
        </div>
      </div>

      <ol className="cad-onboarding-steps">
        {STEPS.map((step, index) => {
          const done = completion[step.key];
          const isCurrent = currentKey === step.key;
          const Icon = done ? Check : step.icon;
          const disabled = step.key === 'exam' ? !hasChapters : step.key === 'review' ? !canStartTest : false;

          return (
            <li key={step.key} className={done ? 'is-done' : isCurrent ? 'is-current' : ''}>
              <span className="cad-onboarding-step-icon" aria-hidden="true">
                <Icon size={16} />
              </span>
              <div className="cad-onboarding-step-copy">
                <h3>{index + 1}. {step.title}</h3>
                <p>{done ? 'Étape terminée.' : step.description}</p>
              </div>
              {!done && (
                <button
                  type="button"
                  className={isCurrent ? 'cad-feature-button cad-feature-button-primary' : 'cad-feature-button'}
                  onClick={actions[step.key]}
                  disabled={disabled}
                >
                  {step.action}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
