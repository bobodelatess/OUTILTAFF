import React from 'react';
import { createRoot } from 'react-dom/client';
import Cadence from './Cadence.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Cadence />
  </React.StrictMode>
);

// PWA : hors-ligne + installable. Enregistré en production seulement
// (en dev, un SW interfère avec le rechargement à chaud de Vite).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const swUrl = new URL('sw.js', window.location.href).pathname;
    navigator.serviceWorker.register(swUrl).catch(() => { /* hors-ligne indisponible */ });
  });
}
