# Visor de Tomografía

Visor de tomografía DICOM con MPR multiplanar (axial, coronal, sagital),
proyecciones MIP/MinIP/Avg, mediciones clínicas y reconstrucción
volumétrica 3D por GPU (WebGL2). Carga local real de DICOM, ventanas HU,
mediciones/ROI, cine y exportación PNG. Incluye volúmenes sintéticos
(fantasmas anatómicos: cráneo, tórax, abdomen) para probar sin estudios
reales. Todo se procesa en local: no sube estudios a ningún servidor.

Stack: React 19 + TypeScript + Vite + Tailwind CSS. `dicom-parser` para
leer DICOM, `server.js` (Express) solo para servir el build web.

## Web (desarrollo)

```sh
bun install
bun run dev      # http://localhost:3000
bun run build    # genera dist/
node server.js   # sirve dist/ en el puerto 3000
```

## Windows portable (sin instalador)

La versión de Windows se construye solo como **portable**: un único
`.exe` que se ejecuta con doble clic, sin instalar nada y sin permisos
de administrador. No hay versión con instalador (MSI/NSIS).

Se genera en GitHub Actions (`.github/workflows/windows-portable.yml`),
en `windows-latest`, con cada push a `main` que toque la app y también
bajo demanda (Run workflow):

1. Abre **Actions → Windows portable** en el repo.
2. Entra en la ejecución más reciente y descarga el artefacto
   **visor-tomografia-windows-portable**.
3. Descomprime y ejecuta `Visor de Tomografía-Windows-Portable-1.0.0.exe`.

Al arrancar, el visor escribe `visor-timing.log` junto al `.exe` con
`app-ready-ms` (tiempo hasta que la ventana está lista) y
`window-load-ms` (tiempo hasta que la app termina de cargar).

## Probar tiempos de carga y respuesta (casos reales)

1. **Arranque:** anota `app-ready-ms` y `window-load-ms` del log y el
   tiempo hasta que se ve el fantasma de cráneo.
2. **Fantasmas:** cambia entre cráneo, tórax y abdomen y anota el tiempo
   hasta que cambia la vista 3D.
3. **DICOM real:** carga una carpeta/serie DICOM real y anota el tiempo
   de carga, el cambio de corte (cine) y la rotación 3D.
4. **Sin internet:** el visor funciona offline, salvo las fuentes de
   Google Fonts, que caen a la fuente del sistema.

## Alcance

Estudio, docencia, investigación y segunda opinión. No es para
diagnóstico primario certificado (CE/FDA fuera de alcance).
