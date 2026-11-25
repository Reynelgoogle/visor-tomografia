import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { setupTauriTiming } from './tauriTiming';

// En la app Tauri escribe visor-timing.log junto al .exe; en web no hace nada.
setupTauriTiming();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
