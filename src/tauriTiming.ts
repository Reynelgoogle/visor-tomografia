// Medición de tiempos de arranque en la app Tauri.
// Solo activo dentro de Tauri: en web (navegador) no hace nada.
// Al terminar de cargar la ventana, pide al backend Rust que escriba
// visor-timing.log junto al .exe con app-ready-ms y window-load-ms.
import { invoke, isTauri } from '@tauri-apps/api/core';

export function setupTauriTiming(): void {
  if (!isTauri()) return;

  const onLoad = () => {
    const windowLoadMs = Math.round(performance.now());
    // El nombre del argumento debe coincidir con el del comando Rust
    // (save_timing_log en src-tauri/src/main.rs).
    invoke('save_timing_log', { window_load_ms: windowLoadMs }).catch(() => {
      // El log es opcional: si falla, la app sigue funcionando igual.
    });
  };

  if (document.readyState === 'complete') onLoad();
  else window.addEventListener('load', onLoad, { once: true });
}
