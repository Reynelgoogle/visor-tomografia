# Visor de Tomografía — Prototipo fase 1

Prototipo web estático del visor de tomografía: 4 vistas sincronizadas
(axial, coronal, sagital MPR y 3D en WebGL2), carga local real de DICOM,
ventanas HU, mediciones/ROI, cine y exportación PNG.

## Cómo usarlo

Abre `index.html` en el navegador (o sírvelo como página estática).
Carga archivos DICOM locales desde la interfaz. No sube estudios a
ningún servidor: todo se procesa en local.

## Estado

Prototipo de fase 1, del 2026-11-08/09. **No verificado funcionalmente
en navegador**: el último build está marcado como correcto, pero la
auditoría final no llegó a cargar la página, así que no se puede
presentar como terminado ni probado.

El plan completo y la arquitectura (OHIF Viewer + Cornerstone3D,
Orthanc como PACS, VTK.js para 3D, 3D Slicer como compañero de
escritorio) están en el PDF del plan de 15 páginas del proyecto.

## Alcance

Estudio, docencia, investigación y segunda opinión. No es para
diagnóstico primario certificado (CE/FDA fuera de alcance).
