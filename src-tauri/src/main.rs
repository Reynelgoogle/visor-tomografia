//! Visor de Tomografía — binario Tauri (Windows portable).
//! Sin instalador: el .exe de src-tauri/target/release se ejecuta directo.
//! Escribe visor-timing.log junto al .exe con los tiempos de arranque
//! (app-ready-ms y window-load-ms) para probar tiempos de carga.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::OnceLock;
use std::time::Instant;

static STARTED: OnceLock<Instant> = OnceLock::new();

/// Lo llama el frontend al terminar de cargar la ventana.
/// `window_load_ms`: ms desde el inicio de la navegación hasta el evento load.
/// `app_ready_ms`: ms desde que arrancó el proceso hasta recibir esta llamada.
#[tauri::command]
fn save_timing_log(window_load_ms: u64) -> Result<String, String> {
    let app_ready_ms = STARTED
        .get()
        .map(|t| t.elapsed().as_millis() as u64)
        .unwrap_or(0);
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe
        .parent()
        .ok_or("no se pudo resolver el directorio del exe")?;
    let path = dir.join("visor-timing.log");
    let content = format!("app-ready-ms={app_ready_ms}\nwindow-load-ms={window_load_ms}\n");
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

fn main() {
    let _ = STARTED.set(Instant::now());
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![save_timing_log])
        .run(tauri::generate_context!())
        .expect("error al arrancar el Visor de Tomografía");
}
