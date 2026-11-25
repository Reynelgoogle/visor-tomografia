import React, { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  Activity,
  Box,
  Compass,
  Contrast,
  Crosshair,
  Download,
  Eye,
  EyeOff,
  FileSpreadsheet,
  FolderOpen,
  Layers,
  Move,
  Pause,
  Play,
  RotateCcw,
  Ruler,
  Scan,
  Search,
  SquareDashed,
  Sun,
  Trash2,
  Triangle,
  Upload
} from 'lucide-react';
import { ingestDicomFiles, type DicomLoadProgress } from './dicom/dicomLoader';
import { generatePhantomVolume, type PhantomId } from './dicom/phantoms';
import { DicomTagsModal } from './components/DicomTagsModal';
import { ExportReportModal } from './components/ExportReportModal';
import { Viewport2D } from './components/Viewport2D';
import { Viewport3D } from './components/Viewport3D';
import type {
  AngleMeasurement,
  Camera3DState,
  ClipBox,
  ColorMapId,
  HuProbe,
  LayoutMode,
  LengthMeasurement,
  LoadedSeries,
  MprProjectionMode,
  Plane2D,
  RenderMode3D,
  RoiMeasurement,
  Settings3D,
  ToolMode,
  TransferPreset3DId,
  ViewName,
  Viewport2DTransformState,
  VolumeData
} from './types/dicom';
import {
  COLORMAP_OPTIONS,
  TRANSFER_PRESETS_3D,
  WINDOW_PRESETS,
  tissueNameFromHU
} from './utils/colormaps';
import { getPlaneDims, sampleVoxel } from './utils/mprEngine';
import { getHoverVoxelInfo, subscribeHoverVoxel } from './utils/cursorProbeStore';

const DEFAULT_CLIP_BOX: ClipBox = {
  xMin: 0,
  xMax: 1,
  yMin: 0,
  yMax: 1,
  zMin: 0,
  zMax: 1
};

const DEFAULT_CAMERA: Camera3DState = {
  yaw: 0.48,
  pitch: -0.2,
  dist: 2.15
};

const DEFAULT_TRANSFORM: Viewport2DTransformState = {
  zoom: 1,
  panX: 0,
  panY: 0,
  flipH: false,
  flipV: false,
  rot90: 0
};

const CursorTelemetry = memo(
  ({ volume, pos }: { volume: VolumeData; pos: { x: number; y: number; z: number } }) => {
    const hoverVoxel = useSyncExternalStore(subscribeHoverVoxel, getHoverVoxelInfo);
    const readoutVoxel = hoverVoxel ?? {
      x: pos.x,
      y: pos.y,
      z: pos.z,
      hu: sampleVoxel(volume, pos.x, pos.y, pos.z)
    };

    return (
      <section className="space-y-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Densidad bajo el cursor
        </h2>
        <div className="p-3 rounded-md bg-[#07090D] border border-slate-800/90 space-y-1">
          <div className="flex items-baseline gap-1.5">
            <span className="font-mono text-2xl font-bold text-slate-100">
              {Math.round(readoutVoxel.hu)}
            </span>
            <span className="font-mono text-xs text-slate-400">HU</span>
            <span className="ml-auto text-xs text-cyan-400 font-medium truncate">
              {tissueNameFromHU(readoutVoxel.hu)}
            </span>
          </div>
          <div className="font-mono text-[11px] text-slate-400">
            x {(readoutVoxel.x * volume.spx).toFixed(1)} · y {(readoutVoxel.y * volume.spy).toFixed(1)} · z{' '}
            {(readoutVoxel.z * volume.spz).toFixed(1)} mm
          </div>
        </div>
      </section>
    );
  }
);

export function App() {
  const [phantomId, setPhantomId] = useState<PhantomId>('craneo');
  const [volume, setVolume] = useState<VolumeData>(() => generatePhantomVolume('craneo'));
  const [loadedSeries, setLoadedSeries] = useState<LoadedSeries[]>([]);
  const [activeSeriesUid, setActiveSeriesUid] = useState<string | null>(null);

  const [pos, setPos] = useState<{ x: number; y: number; z: number }>(() => ({
    x: 72,
    y: 72,
    z: 52
  }));
  const [ww, setWW] = useState<number>(80);
  const [wl, setWL] = useState<number>(40);
  const [invert, setInvert] = useState<boolean>(false);
  const [colormap, setColormap] = useState<ColorMapId>('gray');

  const [projMode, setProjMode] = useState<MprProjectionMode>('thin');
  const [slabMm, setSlabMm] = useState<number>(12);
  const [obliqueDeg, setObliqueDeg] = useState<number>(0);
  const [showCrosshairs, setShowCrosshairs] = useState<boolean>(true);

  const [tool, setTool] = useState<ToolMode>('explore');
  const [roiShape, setRoiShape] = useState<'rect' | 'ellipse'>('ellipse');
  const [activeView, setActiveView] = useState<ViewName>('axial');
  const [layout, setLayout] = useState<LayoutMode>('quad');

  const [cinePlaying, setCinePlaying] = useState<boolean>(false);
  const [cineFps, setCineFps] = useState<number>(12);

  const [transforms, setTransforms] = useState<Record<Plane2D, Viewport2DTransformState>>({
    axial: { ...DEFAULT_TRANSFORM },
    coronal: { ...DEFAULT_TRANSFORM },
    sagital: { ...DEFAULT_TRANSFORM }
  });

  const [camera3D, setCamera3D] = useState<Camera3DState>(DEFAULT_CAMERA);
  const [clipBox, setClipBox] = useState<ClipBox>(DEFAULT_CLIP_BOX);
  const [settings3D, setSettings3D] = useState<Settings3D>({
    renderMode: 'vr',
    preset: 'bone',
    thresholdHU: 180,
    opacity: 0.9,
    shading: 0.85,
    brightness: 1.08,
    edgeBoost: 0.72,
    contrastScale: 1.0,
    showCrosshairs: true,
    showClipBox: false,
    autoSpin: false,
    highQuality: true,
    bgMode: 'black'
  });

  const [lengths, setLengths] = useState<LengthMeasurement[]>([]);
  const [angles, setAngles] = useState<AngleMeasurement[]>([]);
  const [rois, setRois] = useState<RoiMeasurement[]>([]);
  const [probes, setProbes] = useState<HuProbe[]>([]);
  const seqRef = useRef<number>(1);

  const [loadProgress, setLoadProgress] = useState<DicomLoadProgress | null>(null);
  const [loadMessage, setLoadMessage] = useState<string>(
    'Arrastra archivos DICOM, carpetas o paquetes .zip sobre las vistas. Procesamiento 100% local en navegador.'
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState<boolean>(false);

  const [tagsModalOpen, setTagsModalOpen] = useState<boolean>(false);
  const [exportModalOpen, setExportModalOpen] = useState<boolean>(false);
  const [clipExpanded, setClipExpanded] = useState<boolean>(true);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const capture2DRefs = useRef<Partial<Record<Plane2D, (() => string | null) | null>>>({});
  const capture3DRef = useRef<(() => string | null) | null>(null);

  const registerCapture2D = useCallback((plane: Plane2D, fn: (() => string | null) | null) => {
    capture2DRefs.current[plane] = fn;
  }, []);
  const registerCapture3D = useCallback((fn: (() => string | null) | null) => {
    capture3DRef.current = fn;
  }, []);

  // Stable callbacks so React.memo on Viewport2D & Viewport3D skips cross-viewport re-renders
  const handleActivate2D = useCallback((plane: Plane2D) => setActiveView(plane), []);
  const handleToggleExpand2D = useCallback(
    (plane: Plane2D) => setLayout((cur) => (cur === plane ? 'quad' : plane)),
    []
  );
  const handleWindowChange = useCallback((nextWW: number, nextWL: number) => {
    setWW(Math.max(1, Math.min(3000, nextWW)));
    setWL(Math.max(-1024, Math.min(1400, nextWL)));
  }, []);
  const handleTransformChange = useCallback((plane: Plane2D, next: Viewport2DTransformState) => {
    setTransforms((t) => ({ ...t, [plane]: next }));
  }, []);
  const handleAddLength = useCallback((m: Omit<LengthMeasurement, 'id'>) => {
    const id = seqRef.current++;
    setLengths((prev) => [...prev, { ...m, id }]);
  }, []);
  const handleAddAngle = useCallback((a: Omit<AngleMeasurement, 'id'>) => {
    const id = seqRef.current++;
    setAngles((prev) => [...prev, { ...a, id }]);
  }, []);
  const handleAddRoi = useCallback((r: Omit<RoiMeasurement, 'id'>) => {
    const id = seqRef.current++;
    setRois((prev) => [...prev, { ...r, id }]);
  }, []);
  const handleAddProbe = useCallback((p: Omit<HuProbe, 'id'>) => {
    const id = seqRef.current++;
    setProbes((prev) => [...prev, { ...p, id }]);
  }, []);
  const handleActivate3D = useCallback(() => setActiveView('volume'), []);
  const handleToggleExpand3D = useCallback(
    () => setLayout((cur) => (cur === 'volume' ? 'quad' : 'volume')),
    []
  );
  const handleResetCamera3D = useCallback(() => setCamera3D(DEFAULT_CAMERA), []);

  const applyVolume = useCallback((nextVol: VolumeData) => {
    setVolume(nextVol);
    setPos({
      x: Math.floor(nextVol.nx / 2),
      y: Math.floor(nextVol.ny / 2),
      z: Math.floor(nextVol.nz / 2)
    });
    setWW(nextVol.meta.defaultWW ?? 350);
    setWL(nextVol.meta.defaultWL ?? 50);
    setTransforms({
      axial: { ...DEFAULT_TRANSFORM },
      coronal: { ...DEFAULT_TRANSFORM },
      sagital: { ...DEFAULT_TRANSFORM }
    });
    setClipBox(DEFAULT_CLIP_BOX);
    setLengths([]);
    setAngles([]);
    setRois([]);
    setProbes([]);
    setObliqueDeg(0);

    // Pick smart 3D preset based on phantom or study description.
    // The canonical "3D CT" look is a shaded bone surface, so bone is the
    // default; lung/angio/viscera remain one click away in the 3D panel.
    const desc = `${nextVol.meta.study} ${nextVol.meta.series}`.toLowerCase();
    if (nextVol.meta.phantomId === 'abdomen' || desc.includes('abdo') || desc.includes('renal') || desc.includes('pelv')) {
      setSettings3D((prev) => ({ ...prev, preset: 'viscera', thresholdHU: 35, contrastScale: 1 }));
    } else if (nextVol.meta.isSynthetic) {
      // Demo phantoms default to the canonical bone surface view.
      setSettings3D((prev) => ({ ...prev, preset: 'bone', thresholdHU: 180, contrastScale: 1 }));
    } else if (desc.includes('angio') || desc.includes('cta')) {
      setSettings3D((prev) => ({ ...prev, preset: 'angio', thresholdHU: 115, contrastScale: 1 }));
    } else {
      setSettings3D((prev) => ({ ...prev, preset: 'bone', thresholdHU: 180, contrastScale: 1 }));
    }
  }, []);

  const handleSelectPhantom = (id: PhantomId) => {
    setPhantomId(id);
    setLoadedSeries([]);
    setActiveSeriesUid(null);
    setLoadError(null);
    setLoadMessage('Volumen sintético anatómico activo para demostración y pruebas.');
    applyVolume(generatePhantomVolume(id));
  };

  const handleFilesSelected = async (files: FileList | File[]) => {
    if (!files || files.length === 0) return;
    setLoadError(null);
    setCinePlaying(false);
    try {
      const result = await ingestDicomFiles(files, (p) => setLoadProgress(p));
      setLoadProgress(null);

      if (result.series.length === 0) {
        setLoadError(
          result.warnings[0] ||
            'No se encontraron cortes DICOM compatibles en los archivos seleccionados.'
        );
        return;
      }

      setLoadedSeries(result.series);
      const primary = result.series[0];
      setActiveSeriesUid(primary.seriesUid);
      applyVolume(primary.volume);

      const warnText =
        result.warnings.length > 0
          ? ` (${result.warnings.length} aviso(s): ${result.warnings[0]})`
          : '';
      setLoadMessage(
        `${result.series.length} serie(s) cargadas · Activa: ${primary.sliceCount} cortes (${primary.cols}×${primary.rows})${warnText}`
      );
    } catch (err) {
      setLoadProgress(null);
      setLoadError(err instanceof Error ? err.message : 'Error al procesar los archivos DICOM.');
    }
  };

  const handleSelectSeries = (s: LoadedSeries) => {
    setActiveSeriesUid(s.seriesUid);
    applyVolume(s.volume);
    setLoadMessage(`Serie activa: ${s.seriesDesc} · ${s.sliceCount} cortes (${s.cols}×${s.rows})`);
  };

  // Cine loop timer
  useEffect(() => {
    if (!cinePlaying) return;
    if (activeView === 'volume') {
      setSettings3D((prev) => ({ ...prev, autoSpin: true }));
      return () => setSettings3D((prev) => ({ ...prev, autoSpin: false }));
    }
    const plane = activeView as Plane2D;
    const dims = getPlaneDims(volume, plane);
    const intervalMs = Math.max(25, Math.round(1000 / cineFps));
    const timer = window.setInterval(() => {
      setPos((prev) => ({
        ...prev,
        [dims.axis]: (prev[dims.axis] + 1) % (dims.maxSlice + 1)
      }));
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [cinePlaying, cineFps, activeView, volume]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (ev.key === 'Escape') {
        if (tagsModalOpen) setTagsModalOpen(false);
        else if (exportModalOpen) setExportModalOpen(false);
        else setLayout('quad');
        return;
      }
      if (ev.key === ' ') {
        ev.preventDefault();
        setCinePlaying((p) => !p);
        return;
      }
      if (activeView !== 'volume') {
        const dims = getPlaneDims(volume, activeView);
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') {
          ev.preventDefault();
          setPos((prev) => ({
            ...prev,
            [dims.axis]: Math.min(dims.maxSlice, prev[dims.axis] + 1)
          }));
        } else if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') {
          ev.preventDefault();
          setPos((prev) => ({
            ...prev,
            [dims.axis]: Math.max(0, prev[dims.axis] - 1)
          }));
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeView, volume, tagsModalOpen, exportModalOpen]);

  const handleResetAll = () => {
    setCinePlaying(false);
    setPos({
      x: Math.floor(volume.nx / 2),
      y: Math.floor(volume.ny / 2),
      z: Math.floor(volume.nz / 2)
    });
    setWW(volume.meta.defaultWW ?? 350);
    setWL(volume.meta.defaultWL ?? 50);
    setInvert(false);
    setColormap('gray');
    setProjMode('thin');
    setObliqueDeg(0);
    setTransforms({
      axial: { ...DEFAULT_TRANSFORM },
      coronal: { ...DEFAULT_TRANSFORM },
      sagital: { ...DEFAULT_TRANSFORM }
    });
    setClipBox(DEFAULT_CLIP_BOX);
    setCamera3D(DEFAULT_CAMERA);
  };

  const handleDownloadActivePng = () => {
    const dataUrl =
      activeView === 'volume'
        ? capture3DRef.current?.()
        : capture2DRefs.current[activeView]?.();
    if (!dataUrl) return;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `tomografia-${activeView}-${Date.now()}.png`;
    a.click();
  };

  const totalAnnotations = lengths.length + angles.length + rois.length + probes.length;

  const isSingleView =
    layout === 'axial' || layout === 'coronal' || layout === 'sagital' || layout === 'volume';

  const gridClassName = useMemo(() => {
    if (layout === 'quad') return 'grid grid-cols-1 md:grid-cols-2 md:grid-rows-2 gap-1.5';
    if (layout === 'threePlusOne') {
      return 'grid grid-cols-1 lg:grid-cols-[360px_1fr] lg:grid-rows-3 gap-1.5';
    }
    if (layout === 'mprStrip') return 'grid grid-cols-1 md:grid-cols-3 md:grid-rows-1 gap-1.5';
    return 'grid grid-cols-1 grid-rows-1 gap-1.5';
  }, [layout]);

  const shouldRenderView = (v: ViewName) => {
    if (layout === 'quad' || layout === 'threePlusOne') return true;
    if (layout === 'mprStrip') return v !== 'volume';
    return layout === v;
  };

  const toolButtons: Array<{ id: ToolMode; label: string; icon: React.ReactNode; hint: string }> = [
    { id: 'explore', label: 'Explorar', icon: <Crosshair className="w-4 h-4" />, hint: 'Mover cursor MPR sincronizado' },
    { id: 'window', label: 'Ventana', icon: <Contrast className="w-4 h-4" />, hint: 'Arrastra ↔ WW / ↕ WL' },
    { id: 'measure', label: 'Regla', icon: <Ruler className="w-4 h-4" />, hint: 'Distancia en mm (2 clics)' },
    { id: 'angle', label: 'Ángulo', icon: <Triangle className="w-4 h-4" />, hint: 'Ángulo de 3 puntos (°)' },
    { id: 'roi', label: 'ROI', icon: <SquareDashed className="w-4 h-4" />, hint: 'Media ± DE HU y área mm²' },
    { id: 'probe', label: 'Sonda HU', icon: <Activity className="w-4 h-4" />, hint: 'Fijar marcador HU puntual' },
    { id: 'pan', label: 'Desplazar', icon: <Move className="w-4 h-4" />, hint: 'Mover imagen' },
    { id: 'zoom', label: 'Zoom', icon: <Search className="w-4 h-4" />, hint: 'Arrastra ↕ o Ctrl+rueda' }
  ];

  const handle3DPreset = (presetId: TransferPreset3DId) => {
    const meta = TRANSFER_PRESETS_3D.find((p) => p.id === presetId);
    setSettings3D((prev) => ({
      ...prev,
      renderMode: prev.renderMode === 'mip' || prev.renderMode === 'minip' || prev.renderMode === 'drr' ? 'vr' : prev.renderMode,
      preset: presetId,
      thresholdHU: meta ? meta.defaultThreshold : prev.thresholdHU
    }));
  };

  return (
    <div
      className="flex flex-col h-dvh min-h-0 bg-[#07090D] text-slate-100 select-none"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDraggingFiles(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setIsDraggingFiles(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDraggingFiles(false);
        if (e.dataTransfer?.files?.length) {
          handleFilesSelected(e.dataTransfer.files);
        }
      }}
    >
      {/* ======= Top Workstation Toolbar ======= */}
      <header className="flex items-center gap-2 px-3 py-1.5 bg-[#0E1118] border-b border-slate-800/90 overflow-x-auto shrink-0">
        <div className="flex items-center gap-2 pr-2 border-r border-slate-800 shrink-0">
          <Scan className="w-4 h-4 text-cyan-400" />
          <span className="text-sm font-semibold tracking-tight text-slate-100 whitespace-nowrap">
            Visor MPR · 3D
          </span>
        </div>

        <nav className="flex items-center gap-1 shrink-0" aria-label="Herramientas de medición y navegación">
          {toolButtons.map((tb) => {
            const active = tool === tb.id;
            return (
              <button
                key={tb.id}
                type="button"
                title={tb.hint}
                onClick={() => setTool(tb.id)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  active
                    ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/60'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/70 border border-transparent'
                }`}
              >
                {tb.icon}
                <span className="hidden xl:inline">{tb.label}</span>
              </button>
            );
          })}
          {tool === 'roi' && (
            <button
              type="button"
              onClick={() => setRoiShape((s) => (s === 'ellipse' ? 'rect' : 'ellipse'))}
              title="Alternar ROI Elíptica / Rectangular"
              className="px-2 py-1.5 rounded-md text-[11px] font-mono bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 whitespace-nowrap shrink-0"
            >
              {roiShape === 'ellipse' ? 'Elipse' : 'Rect'}
            </button>
          )}
        </nav>

        <div className="h-5 w-px bg-slate-800 mx-0.5 shrink-0" />

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setCinePlaying((p) => !p)}
            title="Reproducir / Pausar Cine (Espacio)"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors whitespace-nowrap shrink-0 ${
              cinePlaying
                ? 'bg-amber-500/15 border-amber-500/60 text-amber-300'
                : 'border-transparent text-slate-400 hover:text-slate-100 hover:bg-slate-800/70'
            }`}
          >
            {cinePlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            <span className="hidden 2xl:inline">Cine</span>
          </button>

          <button
            type="button"
            onClick={() => setShowCrosshairs((v) => !v)}
            title="Mostrar / ocultar líneas de referencia MPR"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors whitespace-nowrap shrink-0 ${
              showCrosshairs
                ? 'bg-slate-800 border-slate-700 text-slate-200'
                : 'border-transparent text-slate-500 hover:text-slate-200'
            }`}
          >
            {showCrosshairs ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            <span className="hidden 2xl:inline">Líneas</span>
          </button>

          <button
            type="button"
            onClick={() => setInvert((v) => !v)}
            title="Invertir escala de grises"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors whitespace-nowrap shrink-0 ${
              invert
                ? 'bg-cyan-500/15 border-cyan-500/60 text-cyan-300'
                : 'border-transparent text-slate-400 hover:text-slate-100 hover:bg-slate-800/70'
            }`}
          >
            <Sun className="w-3.5 h-3.5" />
            <span className="hidden 2xl:inline">Invertir</span>
          </button>

          <button
            type="button"
            onClick={() => setTagsModalOpen(true)}
            title="Ver etiquetas DICOM"
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-slate-400 hover:text-slate-100 hover:bg-slate-800/70 transition-colors whitespace-nowrap shrink-0"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            <span className="hidden 2xl:inline">DICOM</span>
          </button>

          <button
            type="button"
            onClick={() => setExportModalOpen(true)}
            title="Exportar informe e imagen PNG"
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-slate-400 hover:text-slate-100 hover:bg-slate-800/70 transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden 2xl:inline">Exportar</span>
          </button>

          <button
            type="button"
            onClick={handleResetAll}
            title="Restablecer vistas y parámetros"
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-slate-400 hover:text-slate-100 hover:bg-slate-800/70 transition-colors whitespace-nowrap shrink-0"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1" />

        {/* Layout Selector */}
        <div className="flex items-center gap-1 p-0.5 bg-[#07090D] border border-slate-800 rounded-md shrink-0">
          {(
            [
              { id: 'quad', label: '2×2' },
              { id: 'threePlusOne', label: '3+1 3D' },
              { id: 'mprStrip', label: '1×3 MPR' },
              { id: 'volume', label: '3D' }
            ] as Array<{ id: LayoutMode; label: string }>
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                setLayout(item.id);
                if (item.id === 'volume') setActiveView('volume');
              }}
              className={`px-2.5 py-1 rounded text-[11px] font-semibold transition-colors whitespace-nowrap shrink-0 ${
                layout === item.id
                  ? 'bg-cyan-500/20 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {/* Primary CTA */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
        >
          <Upload className="w-3.5 h-3.5" />
          <span>Cargar DICOM</span>
        </button>
      </header>

      {/* ======= Main Workstation Split Console ======= */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0">
        {/* Left Panel: Study, Series, Window & MPR */}
        <aside className="w-full lg:w-[280px] shrink-0 bg-[#0E1118] border-b lg:border-b-0 lg:border-r border-slate-800/90 overflow-y-auto thin-scroll p-3.5 space-y-5 order-2 lg:order-1">
          {/* Study Metadata & Ingestion */}
          <section className="space-y-2.5">
            <div className="flex items-center justify-between">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Estudio activo
              </h2>
              <span className="font-mono text-[11px] text-cyan-400">
                {volume.meta.modality} · {volume.meta.isSynthetic ? 'Fantoma' : 'Local'}
              </span>
            </div>

            <div className="space-y-1 text-xs border-t border-b border-slate-800/80 py-2">
              <div className="flex justify-between gap-2">
                <span className="text-slate-500">Paciente</span>
                <span className="font-medium text-slate-200 text-right truncate">{volume.meta.patient}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-500">Estudio</span>
                <span className="text-slate-300 text-right truncate">{volume.meta.study}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-500">Matriz</span>
                <span className="font-mono text-slate-300">
                  {volume.nx}×{volume.ny}×{volume.nz}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-500">Vóxel</span>
                <span className="font-mono text-slate-300">
                  {volume.spx.toFixed(2)}×{volume.spy.toFixed(2)}×{volume.spz.toFixed(2)} mm
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-500">Adquisición</span>
                <span className="font-mono text-slate-400">
                  {volume.meta.kvp} · {volume.meta.tubeCurrent}
                </span>
              </div>
            </div>

            {/* File / Folder / ZIP Upload Controls */}
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-md border border-slate-700/80 bg-[#141923] hover:border-cyan-500/60 text-xs font-medium text-slate-200 transition-colors whitespace-nowrap"
              >
                <Upload className="w-3.5 h-3.5 text-cyan-400" />
                Archivos / ZIP
              </button>
              <button
                type="button"
                onClick={() => folderInputRef.current?.click()}
                className="inline-flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-md border border-slate-700/80 bg-[#141923] hover:border-cyan-500/60 text-xs font-medium text-slate-200 transition-colors whitespace-nowrap"
              >
                <FolderOpen className="w-3.5 h-3.5 text-cyan-400" />
                Carpeta
              </button>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) handleFilesSelected(e.target.files);
                e.target.value = '';
              }}
            />
            <input
              ref={folderInputRef}
              type="file"
              multiple
              {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
              className="hidden"
              onChange={(e) => {
                if (e.target.files) handleFilesSelected(e.target.files);
                e.target.value = '';
              }}
            />

            {loadProgress && (
              <div className="p-2.5 rounded-md bg-[#141923] border border-cyan-500/40 space-y-1.5">
                <div className="text-[11px] text-cyan-300 font-medium">{loadProgress.message}</div>
                <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-cyan-400 transition-all"
                    style={{
                      width: `${Math.min(
                        100,
                        Math.round((loadProgress.current / Math.max(1, loadProgress.total)) * 100)
                      )}%`
                    }}
                  />
                </div>
              </div>
            )}

            {loadError && (
              <div className="p-2.5 rounded-md bg-rose-950/50 border border-rose-500/40 text-[11px] text-rose-200 leading-relaxed">
                {loadError}
              </div>
            )}

            <p className="text-[11px] text-slate-400 leading-relaxed">{loadMessage}</p>

            {/* Sample Anatomical Phantoms */}
            <div>
              <div className="text-[11px] text-slate-400 mb-1.5">Volúmenes anatómicos de prueba</div>
              <div className="grid grid-cols-3 gap-1">
                {(
                  [
                    { id: 'craneo', label: 'Cráneo' },
                    { id: 'torax', label: 'Tórax' },
                    { id: 'abdomen', label: 'Abdomen' }
                  ] as Array<{ id: PhantomId; label: string }>
                ).map((ph) => (
                  <button
                    key={ph.id}
                    type="button"
                    onClick={() => handleSelectPhantom(ph.id)}
                    className={`px-2 py-1.5 rounded text-[11px] font-medium border transition-colors ${
                      volume.meta.isSynthetic && phantomId === ph.id
                        ? 'bg-cyan-500/15 border-cyan-500/60 text-cyan-300'
                        : 'bg-[#141923] border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {ph.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Loaded Multi-Series List */}
            {loadedSeries.length > 0 && (
              <div className="space-y-1 pt-1">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Series del estudio ({loadedSeries.length})
                </div>
                <div className="space-y-1 max-h-36 overflow-y-auto thin-scroll">
                  {loadedSeries.map((s) => (
                    <button
                      key={s.seriesUid}
                      type="button"
                      onClick={() => handleSelectSeries(s)}
                      className={`w-full text-left px-2.5 py-1.5 rounded border text-xs transition-colors ${
                        activeSeriesUid === s.seriesUid
                          ? 'bg-cyan-500/15 border-cyan-500/60 text-cyan-200'
                          : 'bg-[#141923] border-slate-800 text-slate-300 hover:border-slate-700'
                      }`}
                    >
                      <div className="font-medium truncate">
                        #{s.seriesNumber} · {s.seriesDesc}
                      </div>
                      <div className="font-mono text-[10px] text-slate-400">
                        {s.modality} · {s.sliceCount} cortes · {s.cols}×{s.rows}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* Window / Level & 2D LUT */}
          <section className="space-y-2.5 pt-2 border-t border-slate-800/80">
            <div className="flex items-center justify-between">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Ventana HU (WW / WL)
              </h2>
              <button
                type="button"
                onClick={() => {
                  const range = Math.max(10, volume.huMax - volume.huMin);
                  setWW(Math.min(3000, Math.round(range)));
                  setWL(Math.round((volume.huMax + volume.huMin) / 2));
                }}
                className="text-[11px] text-cyan-400 hover:text-cyan-300 font-medium"
              >
                Auto
              </button>
            </div>

            <div className="grid grid-cols-3 gap-1">
              {WINDOW_PRESETS.map((p) => {
                const active = Math.round(ww) === p.ww && Math.round(wl) === p.wl;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setWW(p.ww);
                      setWL(p.wl);
                    }}
                    className={`px-1.5 py-1.5 rounded text-[11px] font-medium border truncate transition-colors ${
                      active
                        ? 'bg-cyan-500/15 border-cyan-500/60 text-cyan-300'
                        : 'bg-[#141923] border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                    title={`${p.label}: WW ${p.ww} / WL ${p.wl}`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>

            <div className="space-y-2">
              <div>
                <div className="flex justify-between text-xs mb-0.5">
                  <label htmlFor="rngWW" className="text-slate-300">Ancho (WW)</label>
                  <span className="font-mono text-cyan-400">{Math.round(ww)} HU</span>
                </div>
                <input
                  id="rngWW"
                  type="range"
                  min={1}
                  max={3000}
                  value={ww}
                  onChange={(e) => setWW(Number(e.target.value))}
                  className="w-full clinical-range"
                />
              </div>
              <div>
                <div className="flex justify-between text-xs mb-0.5">
                  <label htmlFor="rngWL" className="text-slate-300">Nivel (WL)</label>
                  <span className="font-mono text-cyan-400">{Math.round(wl)} HU</span>
                </div>
                <input
                  id="rngWL"
                  type="range"
                  min={-1024}
                  max={1400}
                  value={wl}
                  onChange={(e) => setWL(Number(e.target.value))}
                  className="w-full clinical-range"
                />
              </div>
            </div>

            <div>
              <div className="text-[11px] text-slate-400 mb-1">Mapa de color 2D (LUT)</div>
              <div className="grid grid-cols-5 gap-1">
                {COLORMAP_OPTIONS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setColormap(c.id)}
                    className={`px-1 py-1 rounded text-[10px] font-medium border truncate transition-colors ${
                      colormap === c.id
                        ? 'bg-cyan-500/15 border-cyan-500/60 text-cyan-300'
                        : 'bg-[#141923] border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          </section>

          {/* MPR Projection & Oblique & Slices */}
          <section className="space-y-2.5 pt-2 border-t border-slate-800/80">
            <div className="flex items-center justify-between">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-cyan-400" />
                MPR y Proyección Slab
              </h2>
            </div>

            <div className="grid grid-cols-4 gap-1 p-0.5 bg-[#07090D] border border-slate-800 rounded-md">
              {(
                [
                  { id: 'thin', label: 'Fino' },
                  { id: 'mip', label: 'MIP' },
                  { id: 'minip', label: 'MinIP' },
                  { id: 'avg', label: 'Avg' }
                ] as Array<{ id: MprProjectionMode; label: string }>
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setProjMode(m.id)}
                  className={`py-1 rounded text-[11px] font-medium transition-colors ${
                    projMode === m.id
                      ? 'bg-cyan-500/20 text-cyan-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {projMode !== 'thin' && (
              <div>
                <div className="flex justify-between text-xs mb-0.5">
                  <span className="text-slate-300">Espesor Slab</span>
                  <span className="font-mono text-cyan-400">{slabMm.toFixed(0)} mm</span>
                </div>
                <input
                  type="range"
                  min={2}
                  max={40}
                  step={1}
                  value={slabMm}
                  onChange={(e) => setSlabMm(Number(e.target.value))}
                  className="w-full clinical-range"
                />
              </div>
            )}

            <div>
              <div className="flex justify-between text-xs mb-0.5">
                <span className="text-slate-300">Inclinación Oblicua</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-cyan-400">{obliqueDeg.toFixed(0)}°</span>
                  {obliqueDeg !== 0 && (
                    <button
                      type="button"
                      onClick={() => setObliqueDeg(0)}
                      className="text-[10px] text-slate-400 hover:text-cyan-300 underline"
                    >
                      0°
                    </button>
                  )}
                </div>
              </div>
              <input
                type="range"
                min={-45}
                max={45}
                step={1}
                value={obliqueDeg}
                onChange={(e) => setObliqueDeg(Number(e.target.value))}
                className="w-full clinical-range"
              />
            </div>

            <div className="space-y-1.5 pt-1">
              <div>
                <div className="flex justify-between text-[11px]">
                  <span className="text-pink-400 font-medium">Axial · Z</span>
                  <span className="font-mono text-slate-300">
                    {pos.z + 1}/{volume.nz} · {(pos.z * volume.spz).toFixed(0)} mm
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={volume.nz - 1}
                  value={pos.z}
                  onChange={(e) => setPos((p) => ({ ...p, z: Number(e.target.value) }))}
                  className="w-full clinical-range"
                />
              </div>
              <div>
                <div className="flex justify-between text-[11px]">
                  <span className="text-cyan-400 font-medium">Coronal · Y</span>
                  <span className="font-mono text-slate-300">
                    {pos.y + 1}/{volume.ny} · {(pos.y * volume.spy).toFixed(0)} mm
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={volume.ny - 1}
                  value={pos.y}
                  onChange={(e) => setPos((p) => ({ ...p, y: Number(e.target.value) }))}
                  className="w-full clinical-range"
                />
              </div>
              <div>
                <div className="flex justify-between text-[11px]">
                  <span className="text-lime-400 font-medium">Sagital · X</span>
                  <span className="font-mono text-slate-300">
                    {pos.x + 1}/{volume.nx} · {(pos.x * volume.spx).toFixed(0)} mm
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={volume.nx - 1}
                  value={pos.x}
                  onChange={(e) => setPos((p) => ({ ...p, x: Number(e.target.value) }))}
                  className="w-full clinical-range"
                />
              </div>
              <div>
                <div className="flex justify-between text-[11px]">
                  <span className="text-slate-400">Velocidad Cine</span>
                  <span className="font-mono text-slate-300">{cineFps} fps</span>
                </div>
                <input
                  type="range"
                  min={4}
                  max={30}
                  value={cineFps}
                  onChange={(e) => setCineFps(Number(e.target.value))}
                  className="w-full clinical-range"
                />
              </div>
            </div>
          </section>
        </aside>

        {/* Central 2D/3D Viewport Stage */}
        <main className="flex-1 min-w-0 min-h-[460px] lg:min-h-0 p-1.5 bg-[#07090D] relative order-1 lg:order-2 flex flex-col">
          <div className={`flex-1 min-h-0 ${gridClassName}`}>
            {shouldRenderView('axial') && (
              <div className={layout === 'threePlusOne' ? 'lg:col-start-1 lg:row-start-1 min-h-0 flex' : 'min-h-0 flex'}>
                <div className="flex-1 min-h-0 flex [&>*]:flex-1">
                  <Viewport2D
                    plane="axial"
                    volume={volume}
                    pos={pos}
                    ww={ww}
                    wl={wl}
                    invert={invert}
                    colormap={colormap}
                    projMode={projMode}
                    slabMm={slabMm}
                    obliqueDeg={obliqueDeg}
                    showCrosshairs={showCrosshairs}
                    tool={tool}
                    roiShape={roiShape}
                    isActive={activeView === 'axial'}
                    isExpanded={isSingleView && layout === 'axial'}
                    transform={transforms.axial}
                    lengths={lengths}
                    angles={angles}
                    rois={rois}
                    probes={probes}
                    onActivate={handleActivate2D}
                    onToggleExpand={handleToggleExpand2D}
                    onMoveCursor={setPos}
                    onWindowChange={handleWindowChange}
                    onTransformChange={handleTransformChange}
                    onAddLength={handleAddLength}
                    onAddAngle={handleAddAngle}
                    onAddRoi={handleAddRoi}
                    onAddProbe={handleAddProbe}
                    registerCapture={registerCapture2D}
                  />
                </div>
              </div>
            )}

            {shouldRenderView('coronal') && (
              <div className={layout === 'threePlusOne' ? 'lg:col-start-1 lg:row-start-2 min-h-0 flex' : 'min-h-0 flex'}>
                <div className="flex-1 min-h-0 flex [&>*]:flex-1">
                  <Viewport2D
                    plane="coronal"
                    volume={volume}
                    pos={pos}
                    ww={ww}
                    wl={wl}
                    invert={invert}
                    colormap={colormap}
                    projMode={projMode}
                    slabMm={slabMm}
                    obliqueDeg={obliqueDeg}
                    showCrosshairs={showCrosshairs}
                    tool={tool}
                    roiShape={roiShape}
                    isActive={activeView === 'coronal'}
                    isExpanded={isSingleView && layout === 'coronal'}
                    transform={transforms.coronal}
                    lengths={lengths}
                    angles={angles}
                    rois={rois}
                    probes={probes}
                    onActivate={handleActivate2D}
                    onToggleExpand={handleToggleExpand2D}
                    onMoveCursor={setPos}
                    onWindowChange={handleWindowChange}
                    onTransformChange={handleTransformChange}
                    onAddLength={handleAddLength}
                    onAddAngle={handleAddAngle}
                    onAddRoi={handleAddRoi}
                    onAddProbe={handleAddProbe}
                    registerCapture={registerCapture2D}
                  />
                </div>
              </div>
            )}

            {shouldRenderView('sagital') && (
              <div className={layout === 'threePlusOne' ? 'lg:col-start-1 lg:row-start-3 min-h-0 flex' : 'min-h-0 flex'}>
                <div className="flex-1 min-h-0 flex [&>*]:flex-1">
                  <Viewport2D
                    plane="sagital"
                    volume={volume}
                    pos={pos}
                    ww={ww}
                    wl={wl}
                    invert={invert}
                    colormap={colormap}
                    projMode={projMode}
                    slabMm={slabMm}
                    obliqueDeg={obliqueDeg}
                    showCrosshairs={showCrosshairs}
                    tool={tool}
                    roiShape={roiShape}
                    isActive={activeView === 'sagital'}
                    isExpanded={isSingleView && layout === 'sagital'}
                    transform={transforms.sagital}
                    lengths={lengths}
                    angles={angles}
                    rois={rois}
                    probes={probes}
                    onActivate={handleActivate2D}
                    onToggleExpand={handleToggleExpand2D}
                    onMoveCursor={setPos}
                    onWindowChange={handleWindowChange}
                    onTransformChange={handleTransformChange}
                    onAddLength={handleAddLength}
                    onAddAngle={handleAddAngle}
                    onAddRoi={handleAddRoi}
                    onAddProbe={handleAddProbe}
                    registerCapture={registerCapture2D}
                  />
                </div>
              </div>
            )}

            {shouldRenderView('volume') && (
              <div
                className={
                  layout === 'threePlusOne'
                    ? 'lg:col-start-2 lg:row-start-1 lg:row-span-3 min-h-0 flex'
                    : 'min-h-0 flex'
                }
              >
                <div className="flex-1 min-h-0 flex [&>*]:flex-1">
                  <Viewport3D
                    volume={volume}
                    pos={pos}
                    ww={ww}
                    wl={wl}
                    clipBox={clipBox}
                    camera={camera3D}
                    settings={settings3D}
                    isActive={activeView === 'volume'}
                    isExpanded={isSingleView && layout === 'volume'}
                    onActivate={handleActivate3D}
                    onToggleExpand={handleToggleExpand3D}
                    onCameraChange={setCamera3D}
                    onResetCamera={handleResetCamera3D}
                    registerCapture={registerCapture3D}
                  />
                </div>
              </div>
            )}
          </div>

          {isDraggingFiles && (
            <div className="absolute inset-2 z-30 rounded-lg border-2 border-dashed border-cyan-400 bg-slate-950/85 grid place-items-center pointer-events-none">
              <div className="text-center space-y-1.5">
                <Upload className="w-8 h-8 text-cyan-400 mx-auto" />
                <p className="text-sm font-semibold text-slate-100">
                  Suelta archivos DICOM, carpeta o archivo .zip aquí
                </p>
                <p className="text-xs text-slate-400">
                  El estudio se reconstruirá localmente en tu navegador
                </p>
              </div>
            </div>
          )}
        </main>

        {/* Right Panel: Live HU Probe, 3D Reconstruction Studio & Measurements */}
        <aside className="w-full lg:w-[296px] shrink-0 bg-[#0E1118] border-t lg:border-t-0 lg:border-l border-slate-800/90 overflow-y-auto thin-scroll p-3.5 space-y-5 order-3">
          {/* Live Voxel HU Readout (subscribed independently so hover never re-renders viewports) */}
          <CursorTelemetry volume={volume} pos={pos} />

          {/* 3D Reconstruction Studio */}
          <section className="space-y-3 pt-2 border-t border-slate-800/80">
            <div className="flex items-center justify-between">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-amber-400 flex items-center gap-1.5">
                <Box className="w-3.5 h-3.5" />
                Estudio 3D (WebGL2)
              </h2>
              <button
                type="button"
                onClick={() => setSettings3D((s) => ({ ...s, autoSpin: !s.autoSpin }))}
                className={`text-[11px] font-medium px-2 py-0.5 rounded border transition-colors ${
                  settings3D.autoSpin
                    ? 'bg-amber-500/20 border-amber-500/60 text-amber-300'
                    : 'border-slate-700 text-slate-400 hover:text-slate-200'
                }`}
              >
                {settings3D.autoSpin ? 'Detener giro' : 'Girar 360°'}
              </button>
            </div>

            {/* 3D Rendering Mode */}
            <div>
              <div className="text-[11px] text-slate-400 mb-1">Modo de reconstrucción</div>
              <div className="grid grid-cols-3 gap-1">
                {(
                  [
                    { id: 'vr', label: 'Volumen VR' },
                    { id: 'mip', label: 'MIP 3D' },
                    { id: 'minip', label: 'MinIP 3D' },
                    { id: 'drr', label: 'Rayos X' },
                    { id: 'surface', label: 'Superficie' }
                  ] as Array<{ id: RenderMode3D; label: string }>
                ).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setSettings3D((s) => ({ ...s, renderMode: m.id }))}
                    className={`px-1.5 py-1.5 rounded text-[11px] font-medium border transition-colors ${
                      settings3D.renderMode === m.id
                        ? 'bg-amber-500/15 border-amber-500/60 text-amber-300'
                        : 'bg-[#141923] border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 3D Transfer Function LUT Presets */}
            <div>
              <div className="text-[11px] text-slate-400 mb-1">Función de transferencia (Tejidos)</div>
              <div className="grid grid-cols-3 gap-1">
                {TRANSFER_PRESETS_3D.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => handle3DPreset(p.id)}
                    className={`px-1.5 py-1.5 rounded text-[11px] font-medium border truncate transition-colors ${
                      settings3D.preset === p.id
                        ? 'bg-amber-500/15 border-amber-500/60 text-amber-300'
                        : 'bg-[#141923] border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 3D Sliders */}
            <div className="space-y-2">
              <div>
                <div className="flex justify-between text-xs mb-0.5">
                  <span className="text-slate-300">Umbral / Centro 3D</span>
                  <span className="font-mono text-amber-400">{settings3D.thresholdHU} HU</span>
                </div>
                <input
                  type="range"
                  min={-1000}
                  max={1000}
                  value={settings3D.thresholdHU}
                  onChange={(e) =>
                    setSettings3D((s) => ({ ...s, thresholdHU: Number(e.target.value) }))
                  }
                  className="w-full clinical-range"
                />
              </div>
              <div>
                <div className="flex justify-between text-xs mb-0.5">
                  <span className="text-slate-300">Contraste 3D (Ventana)</span>
                  <span className="font-mono text-amber-400">{settings3D.contrastScale.toFixed(2)}×</span>
                </div>
                <input
                  type="range"
                  min={40}
                  max={240}
                  value={Math.round(settings3D.contrastScale * 100)}
                  onChange={(e) =>
                    setSettings3D((s) => ({ ...s, contrastScale: Number(e.target.value) / 100 }))
                  }
                  className="w-full clinical-range"
                />
              </div>
              <div>
                <div className="flex justify-between text-xs mb-0.5">
                  <span className="text-slate-300">Realce de bordes / órganos</span>
                  <span className="font-mono text-amber-400">{Math.round(settings3D.edgeBoost * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(settings3D.edgeBoost * 100)}
                  onChange={(e) =>
                    setSettings3D((s) => ({ ...s, edgeBoost: Number(e.target.value) / 100 }))
                  }
                  className="w-full clinical-range"
                />
              </div>
              <div>
                <div className="flex justify-between text-xs mb-0.5">
                  <span className="text-slate-300">Opacidad volumétrica</span>
                  <span className="font-mono text-amber-400">{Math.round(settings3D.opacity * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={15}
                  max={160}
                  value={Math.round(settings3D.opacity * 100)}
                  onChange={(e) =>
                    setSettings3D((s) => ({ ...s, opacity: Number(e.target.value) / 100 }))
                  }
                  className="w-full clinical-range"
                />
              </div>
              <div>
                <div className="flex justify-between text-xs mb-0.5">
                  <span className="text-slate-300">Sombreado Phong 3D</span>
                  <span className="font-mono text-amber-400">{Math.round(settings3D.shading * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(settings3D.shading * 100)}
                  onChange={(e) =>
                    setSettings3D((s) => ({ ...s, shading: Number(e.target.value) / 100 }))
                  }
                  className="w-full clinical-range"
                />
              </div>
              <div>
                <div className="flex justify-between text-xs mb-0.5">
                  <span className="text-slate-300">Iluminación / Ganancia</span>
                  <span className="font-mono text-amber-400">{Math.round(settings3D.brightness * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={50}
                  max={200}
                  value={Math.round(settings3D.brightness * 100)}
                  onChange={(e) =>
                    setSettings3D((s) => ({ ...s, brightness: Number(e.target.value) / 100 }))
                  }
                  className="w-full clinical-range"
                />
              </div>
            </div>

            {/* 3D Options Row */}
            <div className="grid grid-cols-2 gap-1.5 text-[11px]">
              <button
                type="button"
                onClick={() => setSettings3D((s) => ({ ...s, showCrosshairs: !s.showCrosshairs }))}
                className={`px-2 py-1.5 rounded border font-medium transition-colors ${
                  settings3D.showCrosshairs
                    ? 'bg-slate-800 border-slate-600 text-slate-100'
                    : 'bg-[#141923] border-slate-800 text-slate-400'
                }`}
              >
                Planos MPR 3D
              </button>
              <button
                type="button"
                onClick={() => setSettings3D((s) => ({ ...s, highQuality: !s.highQuality }))}
                className={`px-2 py-1.5 rounded border font-medium transition-colors ${
                  settings3D.highQuality
                    ? 'bg-slate-800 border-slate-600 text-slate-100'
                    : 'bg-[#141923] border-slate-800 text-slate-400'
                }`}
              >
                Raycasting HD
              </button>
            </div>

            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className="text-slate-400">Fondo 3D</span>
              <div className="flex gap-1">
                {(
                  [
                    { id: 'black', label: 'Negro' },
                    { id: 'navy', label: 'Azul' },
                    { id: 'white', label: 'Blanco' }
                  ] as Array<{ id: 'black' | 'navy' | 'white'; label: string }>
                ).map((bg) => (
                  <button
                    key={bg.id}
                    type="button"
                    onClick={() => setSettings3D((s) => ({ ...s, bgMode: bg.id }))}
                    className={`px-2 py-0.5 rounded border ${
                      settings3D.bgMode === bg.id
                        ? 'border-amber-500/60 text-amber-300 bg-amber-500/10'
                        : 'border-slate-800 text-slate-400'
                    }`}
                  >
                    {bg.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 3D Clipping Box (Sculp / Cut Planes) */}
            <div className="border-t border-slate-800/80 pt-2">
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setClipExpanded((v) => !v)}
                  className="text-[11px] font-semibold text-slate-300 hover:text-amber-300 flex items-center gap-1.5"
                >
                  <Compass className="w-3.5 h-3.5 text-amber-400" />
                  Recorte 3D (Clip Box) {clipExpanded ? '▾' : '▸'}
                </button>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSettings3D((s) => ({ ...s, showClipBox: !s.showClipBox }))}
                    className={`text-[10px] px-1.5 py-0.5 rounded border ${
                      settings3D.showClipBox
                        ? 'border-amber-500/60 text-amber-300'
                        : 'border-slate-800 text-slate-500'
                    }`}
                  >
                    Guía
                  </button>
                  <button
                    type="button"
                    onClick={() => setClipBox(DEFAULT_CLIP_BOX)}
                    className="text-[10px] text-slate-400 hover:text-slate-200 underline"
                  >
                    Reset
                  </button>
                </div>
              </div>

              {clipExpanded && (
                <div className="mt-2 space-y-2.5 text-[11px]">
                  <div className="grid grid-cols-2 gap-1">
                    <button
                      type="button"
                      onClick={() => setClipBox({ xMin: 0, xMax: 1, yMin: 0.28, yMax: 0.92, zMin: 0, zMax: 1 })}
                      title="Recorta la pared abdominal anterior para ver estómago, asas y vísceras"
                      className="px-1.5 py-1 rounded border border-slate-800 bg-[#141923] hover:border-amber-500/50 text-slate-300 text-[10px]"
                    >
                      Sin pared ant.
                    </button>
                    <button
                      type="button"
                      onClick={() => setClipBox({ xMin: 0.08, xMax: 0.92, yMin: 0.48, yMax: 0.88, zMin: 0, zMax: 1 })}
                      title="Expone riñones, aorta y vena cava retroperitoneales"
                      className="px-1.5 py-1 rounded border border-slate-800 bg-[#141923] hover:border-amber-500/50 text-slate-300 text-[10px]"
                    >
                      Retroperitoneo
                    </button>
                    <button
                      type="button"
                      onClick={() => setClipBox({ xMin: 0.45, xMax: 1, yMin: 0, yMax: 1, zMin: 0, zMax: 1 })}
                      className="px-1.5 py-1 rounded border border-slate-800 bg-[#141923] hover:border-amber-500/50 text-slate-300 text-[10px]"
                    >
                      Corte sagital
                    </button>
                    <button
                      type="button"
                      onClick={() => setClipBox(DEFAULT_CLIP_BOX)}
                      className="px-1.5 py-1 rounded border border-slate-800 bg-[#141923] hover:border-amber-500/50 text-slate-300 text-[10px]"
                    >
                      Volumen completo
                    </button>
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between text-slate-400">
                      <span>Eje X (R → L)</span>
                      <span className="font-mono">
                        {Math.round(clipBox.xMin * 100)}% – {Math.round(clipBox.xMax * 100)}%
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="range"
                        min={0}
                        max={95}
                        value={Math.round(clipBox.xMin * 100)}
                        onChange={(e) => {
                          const v = Number(e.target.value) / 100;
                          setClipBox((c) => ({ ...c, xMin: Math.min(v, c.xMax - 0.05) }));
                        }}
                        className="clinical-range"
                      />
                      <input
                        type="range"
                        min={5}
                        max={100}
                        value={Math.round(clipBox.xMax * 100)}
                        onChange={(e) => {
                          const v = Number(e.target.value) / 100;
                          setClipBox((c) => ({ ...c, xMax: Math.max(v, c.xMin + 0.05) }));
                        }}
                        className="clinical-range"
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between text-slate-400">
                      <span>Eje Y (A → P)</span>
                      <span className="font-mono">
                        {Math.round(clipBox.yMin * 100)}% – {Math.round(clipBox.yMax * 100)}%
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="range"
                        min={0}
                        max={95}
                        value={Math.round(clipBox.yMin * 100)}
                        onChange={(e) => {
                          const v = Number(e.target.value) / 100;
                          setClipBox((c) => ({ ...c, yMin: Math.min(v, c.yMax - 0.05) }));
                        }}
                        className="clinical-range"
                      />
                      <input
                        type="range"
                        min={5}
                        max={100}
                        value={Math.round(clipBox.yMax * 100)}
                        onChange={(e) => {
                          const v = Number(e.target.value) / 100;
                          setClipBox((c) => ({ ...c, yMax: Math.max(v, c.yMin + 0.05) }));
                        }}
                        className="clinical-range"
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between text-slate-400">
                      <span>Eje Z (F → H)</span>
                      <span className="font-mono">
                        {Math.round(clipBox.zMin * 100)}% – {Math.round(clipBox.zMax * 100)}%
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="range"
                        min={0}
                        max={95}
                        value={Math.round(clipBox.zMin * 100)}
                        onChange={(e) => {
                          const v = Number(e.target.value) / 100;
                          setClipBox((c) => ({ ...c, zMin: Math.min(v, c.zMax - 0.05) }));
                        }}
                        className="clinical-range"
                      />
                      <input
                        type="range"
                        min={5}
                        max={100}
                        value={Math.round(clipBox.zMax * 100)}
                        onChange={(e) => {
                          const v = Number(e.target.value) / 100;
                          setClipBox((c) => ({ ...c, zMax: Math.max(v, c.zMin + 0.05) }));
                        }}
                        className="clinical-range"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Clinical Measurements & ROIs */}
          <section className="space-y-2 pt-2 border-t border-slate-800/80">
            <div className="flex items-center justify-between">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Mediciones y ROI ({totalAnnotations})
              </h2>
              {totalAnnotations > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setLengths([]);
                    setAngles([]);
                    setRois([]);
                    setProbes([]);
                  }}
                  className="text-[11px] text-rose-400 hover:text-rose-300 inline-flex items-center gap-1"
                >
                  <Trash2 className="w-3 h-3" />
                  Limpiar
                </button>
              )}
            </div>

            {totalAnnotations === 0 ? (
              <p className="text-xs text-slate-500 leading-relaxed">
                Selecciona Regla, Ángulo, ROI o Sonda HU en la barra superior para medir sobre cualquier vista 2D.
              </p>
            ) : (
              <div className="space-y-1.5 max-h-56 overflow-y-auto thin-scroll">
                {lengths.map((m) => (
                  <div
                    key={`l-${m.id}`}
                    className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded bg-[#141923] border border-slate-800 text-xs"
                  >
                    <span className="text-slate-300 truncate">
                      L{m.id} · {m.view} #{m.slice + 1}
                    </span>
                    <span className="font-mono text-amber-300 font-semibold">{m.mm.toFixed(1)} mm</span>
                    <button
                      type="button"
                      onClick={() => setLengths((prev) => prev.filter((x) => x.id !== m.id))}
                      className="text-slate-500 hover:text-rose-400"
                    >
                      ×
                    </button>
                  </div>
                ))}

                {angles.map((a) => (
                  <div
                    key={`a-${a.id}`}
                    className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded bg-[#141923] border border-slate-800 text-xs"
                  >
                    <span className="text-slate-300 truncate">
                      A{a.id} · {a.view} #{a.slice + 1}
                    </span>
                    <span className="font-mono text-sky-300 font-semibold">{a.deg.toFixed(1)}°</span>
                    <button
                      type="button"
                      onClick={() => setAngles((prev) => prev.filter((x) => x.id !== a.id))}
                      className="text-slate-500 hover:text-rose-400"
                    >
                      ×
                    </button>
                  </div>
                ))}

                {rois.map((r) => (
                  <div
                    key={`r-${r.id}`}
                    className="px-2.5 py-1.5 rounded bg-[#141923] border border-slate-800 text-xs space-y-0.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-emerald-300 font-medium">
                        ROI{r.id} · {r.view} #{r.slice + 1}
                      </span>
                      <button
                        type="button"
                        onClick={() => setRois((prev) => prev.filter((x) => x.id !== r.id))}
                        className="text-slate-500 hover:text-rose-400"
                      >
                        ×
                      </button>
                    </div>
                    <div className="font-mono text-[11px] text-slate-300">
                      μ {r.mean.toFixed(1)} ± {r.stdDev.toFixed(1)} HU · {r.areaMm.toFixed(0)} mm²
                    </div>
                    <div className="font-mono text-[10px] text-slate-500">
                      Mín {r.min.toFixed(0)} / Máx {r.max.toFixed(0)} HU · {r.count} px
                    </div>
                  </div>
                ))}

                {probes.map((p) => (
                  <div
                    key={`p-${p.id}`}
                    className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded bg-[#141923] border border-slate-800 text-xs"
                  >
                    <span className="text-slate-300 truncate">
                      Sonda{p.id} · {p.view} #{p.slice + 1}
                    </span>
                    <span className="font-mono text-violet-300 font-semibold">{Math.round(p.hu)} HU</span>
                    <button
                      type="button"
                      onClick={() => setProbes((prev) => prev.filter((x) => x.id !== p.id))}
                      className="text-slate-500 hover:text-rose-400"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <p className="text-[11px] text-slate-500 leading-relaxed border-t border-slate-800/80 pt-2">
            Atajos: Rueda cambia corte · Ctrl+rueda zoom · Clic derecho ajusta ventana · Espacio cine · Doble clic amplía · Esc restaura rejilla. Uso académico/investigación.
          </p>
        </aside>
      </div>

      {/* Modals */}
      <DicomTagsModal
        open={tagsModalOpen}
        meta={volume.meta}
        tags={volume.tags}
        onClose={() => setTagsModalOpen(false)}
      />

      <ExportReportModal
        open={exportModalOpen}
        volume={volume}
        ww={ww}
        wl={wl}
        lengths={lengths}
        angles={angles}
        rois={rois}
        probes={probes}
        onClose={() => setExportModalOpen(false)}
        onDownloadPng={handleDownloadActivePng}
      />
    </div>
  );
}

export default App;
