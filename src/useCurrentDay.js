import { useEffect, useState } from 'react';

function localDayISO(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function millisecondsUntilNextLocalDay(now = new Date()) {
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 0, 0);
  return Math.max(1, nextMidnight.getTime() - now.getTime());
}

/**
 * Renvoie la date locale courante (YYYY-MM-DD) et reste juste si l'application
 * traverse minuit ou reprend après avoir été suspendue par le navigateur.
 */
export function useCurrentDay() {
  const [day, setDay] = useState(() => localDayISO());

  useEffect(() => {
    let timerId;
    let disposed = false;

    const scheduleMidnightRefresh = () => {
      if (timerId !== undefined) clearTimeout(timerId);
      const now = new Date();
      timerId = setTimeout(refresh, millisecondsUntilNextLocalDay(now));
    };

    function refresh() {
      if (disposed) return;
      setDay(localDayISO());
      scheduleMidnightRefresh();
    }

    scheduleMidnightRefresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);

    return () => {
      disposed = true;
      if (timerId !== undefined) clearTimeout(timerId);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  return day;
}

export default useCurrentDay;
