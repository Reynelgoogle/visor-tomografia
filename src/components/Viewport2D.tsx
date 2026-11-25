import React, { memo, useCallback, useEffect, useRef } from 'react';
import { FlipHorizontal2, Maximize2, Minimize2, RotateCw } from 'lucide-react';
import type {
  AngleMeasurement,
  ColorMapId,
  HuProbe,
  LengthMeasurement,
  MprProjectionMode,
  Plane2D,
  RoiMeasurement,
  ToolMode,
  Viewport2DTransformState,
  VolumeData
} from '../types/dicom';
import { get2DColorLut } from '../utils/colormaps';
import { setHoverVoxelInfo } from '../utils/cursorProbeStore';
import {
  computeRoiStats,
  extractMprSliceHU,
  getPlaneCrossUV,
  getPlaneDims,
  uvToVoxel
} from '../utils/mprEngine';

interface Viewport2DProps {
  plane: Plane2D;
  volume: VolumeData;
  pos: { x: number; y: number; z: number };
  ww: number;
  wl: number;
  invert: boolean;
  colormap: ColorMapId;
  projMode: MprProjectionMode;
  slabMm: number;
  obliqueDeg: number;
  showCrosshairs: boolean;
  tool: ToolMode;
  roiShape: 'rect' | 'ellipse';
  isActive: boolean;
  isExpanded: boolean;
  transform: Viewport2DTransformState;
  lengths: LengthMeasurement[];
  angles: AngleMeasurement[];
  rois: RoiMeasurement[];
  probes: HuProbe[];
  onActivate: (plane: Plane2D) => void;
  onToggleExpand: (plane: Plane2D) => void;
  onMoveCursor: (nextPos: { x: number; y: number; z: number }) => void;
  onWindowChange: (ww: number, wl: number) => void;
  onTransformChange: (plane: Plane2D, next: Viewport2DTransformState) => void;
  onAddLength: (m: Omit<LengthMeasurement, 'id'>) => void;
  onAddAngle: (m: Omit<AngleMeasurement, 'id'>) => void;
  onAddRoi: (r: Omit<RoiMeasurement, 'id'>) => void;
  onAddProbe: (p: Omit<HuProbe, 'id'>) => void;
  registerCapture?: (plane: Plane2D, fn: (() => string | null) | null) => void;
}

const PLANE_META: Record<
  Plane2D,
  { title: string; color: string; oriT: string; oriB: string; oriL: string; oriR: string }
> = {
  axial: { title: 'Axial', color: '#EC4899', oriT: 'A', oriB: 'P', oriL: 'R', oriR: 'L' },
  coronal: { title: 'Coronal', color: '#06B6D4', oriT: 'H', oriB: 'F', oriL: 'R', oriR: 'L' },
  sagital: { title: 'Sagital', color: '#84CC16', oriT: 'H', oriB: 'F', oriL: 'A', oriR: 'P' }
};

interface FitTransform {
  scaleX: number;
  scaleY: number;
  ox: number;
  oy: number;
  cx: number;
  cy: number;
}

const Viewport2DInner: React.FC<Viewport2DProps> = ({
  plane,
  volume,
  pos,
  ww,
  wl,
  invert,
  colormap,
  projMode,
  slabMm,
  obliqueDeg,
  showCrosshairs,
  tool,
  roiShape,
  isActive,
  isExpanded,
  transform,
  lengths,
  angles,
  rois,
  probes,
  onActivate,
  onToggleExpand,
  onMoveCursor,
  onWindowChange,
  onTransformChange,
  onAddLength,
  onAddAngle,
  onAddRoi,
  onAddProbe,
  registerCapture
}) => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const imgCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);

  // Persistent preallocated offscreen buffers (zero GC churn)
  const offCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const offImageDataRef = useRef<ImageData | null>(null);
  const sliceHURef = useRef<Float32Array>(new Float32Array(0));
  const fitRef = useRef<FitTransform | null>(null);
  const sizeRef = useRef<{ w: number; h: number; dpr: number }>({ w: 300, h: 300, dpr: 1 });

  // Pending interactive tool gestures
  const pendingMeasureRef = useRef<{ u: number; v: number } | null>(null);
  const pendingAngleRef = useRef<Array<{ u: number; v: number }>>([]);
  const pendingRoiRef = useRef<{ u1: number; v1: number; u2: number; v2: number } | null>(null);
  const pointerMoveUVRef = useRef<{ u: number; v: number } | null>(null);
  const gestureRef = useRef<{
    tool: ToolMode;
    startX: number;
    startY: number;
    startWW: number;
    startWL: number;
    startPanX: number;
    startPanY: number;
    startZoom: number;
  } | null>(null);
  const moveRafRef = useRef<number>(0);

  const meta = PLANE_META[plane];
  const dims = getPlaneDims(volume, plane);
  const currentSliceIdx = pos[dims.axis];
  const hasOblique = Math.abs(obliqueDeg) > 0.2;

  // Keep latest pos in ref so oblique key only triggers when oblique is active
  const posRef = useRef(pos);
  posRef.current = pos;

  useEffect(() => {
    pendingMeasureRef.current = null;
    pendingAngleRef.current = [];
    pendingRoiRef.current = null;
  }, [tool, volume.id]);

  const computeFit = useCallback(
    (cw: number, ch: number): FitTransform => {
      const physW = dims.w * dims.su;
      const physH = dims.h * dims.sv;
      const rotated90 = transform.rot90 % 2 === 1;
      const targetW = rotated90 ? physH : physW;
      const targetH = rotated90 ? physW : physH;
      const baseFit = Math.min(cw / Math.max(1e-3, targetW), ch / Math.max(1e-3, targetH));
      const pxScaleU = baseFit * dims.su * transform.zoom;
      const pxScaleV = baseFit * dims.sv * transform.zoom;
      return {
        scaleX: pxScaleU,
        scaleY: pxScaleV,
        ox: (cw - dims.w * pxScaleU) / 2,
        oy: (ch - dims.h * pxScaleV) / 2,
        cx: cw / 2 + transform.panX,
        cy: ch / 2 + transform.panY
      };
    },
    [dims.w, dims.h, dims.su, dims.sv, transform.zoom, transform.panX, transform.panY, transform.rot90]
  );

  const imgToScreen = useCallback(
    (t: FitTransform, u: number, v: number): { x: number; y: number } => {
      const cw = sizeRef.current.w;
      const ch = sizeRef.current.h;
      let lx = t.ox + (u + 0.5) * t.scaleX - cw / 2;
      let ly = t.oy + (v + 0.5) * t.scaleY - ch / 2;
      if (transform.flipH) lx = -lx;
      if (transform.flipV) ly = -ly;
      const rad = (transform.rot90 * Math.PI) / 2;
      const cos = Math.round(Math.cos(rad));
      const sin = Math.round(Math.sin(rad));
      return {
        x: t.cx + (lx * cos - ly * sin),
        y: t.cy + (lx * sin + ly * cos)
      };
    },
    [transform.flipH, transform.flipV, transform.rot90]
  );

  const screenToImg = useCallback(
    (t: FitTransform, px: number, py: number): { u: number; v: number } => {
      const cw = sizeRef.current.w;
      const ch = sizeRef.current.h;
      const rx = px - t.cx;
      const ry = py - t.cy;
      const rad = (-transform.rot90 * Math.PI) / 2;
      const cos = Math.round(Math.cos(rad));
      const sin = Math.round(Math.sin(rad));
      let lx = rx * cos - ry * sin;
      let ly = rx * sin + ry * cos;
      if (transform.flipH) lx = -lx;
      if (transform.flipV) ly = -ly;
      return {
        u: (lx + cw / 2 - t.ox) / t.scaleX - 0.5,
        v: (ly + ch / 2 - t.oy) / t.scaleY - 0.5
      };
    },
    [transform.flipH, transform.flipV, transform.rot90]
  );

  // Stage C2: Draw Vector Overlay (crosshairs, rulers, angles, ROIs, probes)
  const drawOverlay = useCallback(() => {
    const overlay = overlayCanvasRef.current;
    const t = fitRef.current;
    if (!overlay || !t) return;
    const { w, h, dpr } = sizeRef.current;
    const ctx = overlay.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (showCrosshairs) {
      const cross = getPlaneCrossUV(volume, plane, posRef.current);
      const p = imgToScreen(t, cross.u, cross.v);
      const gap = 12;

      ctx.save();
      ctx.strokeStyle = meta.color;
      ctx.lineWidth = 1.1;
      ctx.globalAlpha = 0.85;

      const tiltRad = (obliqueDeg * Math.PI) / 180;
      const cosT = Math.cos(tiltRad);
      const sinT = Math.sin(tiltRad);
      const span = Math.max(w, h) * 1.5;

      ctx.beginPath();
      ctx.moveTo(p.x - cosT * span, p.y - sinT * span);
      ctx.lineTo(p.x - cosT * gap, p.y - sinT * gap);
      ctx.moveTo(p.x + cosT * gap, p.y + sinT * gap);
      ctx.lineTo(p.x + cosT * span, p.y + sinT * span);

      ctx.moveTo(p.x + sinT * span, p.y - cosT * span);
      ctx.lineTo(p.x + sinT * gap, p.y - cosT * gap);
      ctx.moveTo(p.x - sinT * gap, p.y + cosT * gap);
      ctx.lineTo(p.x - sinT * span, p.y + cosT * span);
      ctx.stroke();

      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    ctx.font = '600 11.5px "IBM Plex Mono", monospace';

    for (const m of lengths) {
      if (m.view !== plane || m.slice !== currentSliceIdx) continue;
      const a = imgToScreen(t, m.u1, m.v1);
      const b = imgToScreen(t, m.u2, m.v2);
      ctx.strokeStyle = '#FBBF24';
      ctx.lineWidth = 1.75;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();

      for (const pt of [a, b]) {
        ctx.fillStyle = '#FBBF24';
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 3.2, 0, Math.PI * 2);
        ctx.fill();
      }

      const label = `${m.mm.toFixed(1)} mm`;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2 - 10;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(7, 9, 13, 0.82)';
      ctx.fillRect(mx - tw / 2 - 5, my - 11, tw + 10, 17);
      ctx.fillStyle = '#FBBF24';
      ctx.textAlign = 'center';
      ctx.fillText(label, mx, my + 1.5);
    }

    if (pendingMeasureRef.current) {
      const a = imgToScreen(t, pendingMeasureRef.current.u, pendingMeasureRef.current.v);
      ctx.fillStyle = '#FBBF24';
      ctx.beginPath();
      ctx.arc(a.x, a.y, 3.6, 0, Math.PI * 2);
      ctx.fill();

      if (pointerMoveUVRef.current) {
        const b = imgToScreen(t, pointerMoveUVRef.current.u, pointerMoveUVRef.current.v);
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.75)';
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    for (const ang of angles) {
      if (ang.view !== plane || ang.slice !== currentSliceIdx) continue;
      const p1 = imgToScreen(t, ang.u1, ang.v1);
      const p2 = imgToScreen(t, ang.u2, ang.v2);
      const p3 = imgToScreen(t, ang.u3, ang.v3);
      ctx.strokeStyle = '#38BDF8';
      ctx.lineWidth = 1.75;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.lineTo(p3.x, p3.y);
      ctx.stroke();

      for (const pt of [p1, p2, p3]) {
        ctx.fillStyle = '#38BDF8';
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
      const label = `${ang.deg.toFixed(1)}°`;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(7, 9, 13, 0.82)';
      ctx.fillRect(p2.x + 8, p2.y - 12, tw + 10, 17);
      ctx.fillStyle = '#38BDF8';
      ctx.textAlign = 'left';
      ctx.fillText(label, p2.x + 13, p2.y + 0.5);
    }

    if (pendingAngleRef.current.length > 0) {
      const pts = pendingAngleRef.current.map((pt) => imgToScreen(t, pt.u, pt.v));
      ctx.strokeStyle = '#38BDF8';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      if (pointerMoveUVRef.current) {
        const cur = imgToScreen(t, pointerMoveUVRef.current.u, pointerMoveUVRef.current.v);
        ctx.lineTo(cur.x, cur.y);
      }
      ctx.stroke();
      for (const pt of pts) {
        ctx.fillStyle = '#38BDF8';
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const drawRoiBox = (
      u1: number,
      v1: number,
      u2: number,
      v2: number,
      shape: 'rect' | 'ellipse',
      statsLabel?: string
    ) => {
      const p1 = imgToScreen(t, Math.min(u1, u2), Math.min(v1, v2));
      const p2 = imgToScreen(t, Math.max(u1, u2), Math.max(v1, v2));
      const left = Math.min(p1.x, p2.x);
      const top = Math.min(p1.y, p2.y);
      const rw = Math.abs(p2.x - p1.x);
      const rh = Math.abs(p2.y - p1.y);

      ctx.strokeStyle = '#34D399';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      if (shape === 'ellipse') {
        ctx.beginPath();
        ctx.ellipse(left + rw / 2, top + rh / 2, Math.max(1, rw / 2), Math.max(1, rh / 2), 0, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.strokeRect(left, top, rw, rh);
      }
      ctx.setLineDash([]);

      if (statsLabel) {
        const tw = ctx.measureText(statsLabel).width;
        ctx.fillStyle = 'rgba(7, 9, 13, 0.85)';
        ctx.fillRect(left, Math.max(4, top - 20), tw + 10, 17);
        ctx.fillStyle = '#34D399';
        ctx.textAlign = 'left';
        ctx.fillText(statsLabel, left + 5, Math.max(16.5, top - 7.5));
      }
    };

    for (const r of rois) {
      if (r.view !== plane || r.slice !== currentSliceIdx) continue;
      drawRoiBox(
        r.u1,
        r.v1,
        r.u2,
        r.v2,
        r.shape,
        `μ ${r.mean.toFixed(0)} ± ${r.stdDev.toFixed(0)} HU · ${r.areaMm.toFixed(0)} mm²`
      );
    }

    if (pendingRoiRef.current) {
      const pr = pendingRoiRef.current;
      drawRoiBox(pr.u1, pr.v1, pr.u2, pr.v2, roiShape);
    }

    for (const pr of probes) {
      if (pr.view !== plane || pr.slice !== currentSliceIdx) continue;
      const p = imgToScreen(t, pr.u, pr.v);
      ctx.strokeStyle = '#A78BFA';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(p.x - 5, p.y);
      ctx.lineTo(p.x + 5, p.y);
      ctx.moveTo(p.x, p.y - 5);
      ctx.lineTo(p.x, p.y + 5);
      ctx.stroke();

      const label = `${Math.round(pr.hu)} HU`;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(7, 9, 13, 0.85)';
      ctx.fillRect(p.x + 7, p.y - 9, tw + 8, 16);
      ctx.fillStyle = '#C4B5FD';
      ctx.textAlign = 'left';
      ctx.fillText(label, p.x + 11, p.y + 3);
    }
  }, [
    angles,
    currentSliceIdx,
    imgToScreen,
    lengths,
    meta.color,
    obliqueDeg,
    plane,
    probes,
    roiShape,
    rois,
    showCrosshairs,
    volume
  ]);

  // Stage C1: Blit offscreen RGBA canvas onto display canvas (zero pixel math!)
  const blitImageToScreen = useCallback(() => {
    const body = bodyRef.current;
    const canvas = imgCanvasRef.current;
    const overlay = overlayCanvasRef.current;
    const off = offCanvasRef.current;
    if (!body || !canvas || !overlay || !off) return;

    const rect = body.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pw = Math.max(2, Math.round(rect.width * dpr));
    const ph = Math.max(2, Math.round(rect.height * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    if (overlay.width !== pw || overlay.height !== ph) {
      overlay.width = pw;
      overlay.height = ph;
    }
    sizeRef.current = { w: rect.width, h: rect.height, dpr };

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const t = computeFit(rect.width, rect.height);
    fitRef.current = t;

    ctx.save();
    ctx.translate(t.cx, t.cy);
    ctx.rotate((transform.rot90 * Math.PI) / 2);
    ctx.scale(transform.flipH ? -1 : 1, transform.flipV ? -1 : 1);
    ctx.translate(-rect.width / 2, -rect.height / 2);
    ctx.drawImage(off, t.ox, t.oy, dims.w * t.scaleX, dims.h * t.scaleY);
    ctx.restore();

    drawOverlay();
  }, [computeFit, dims.h, dims.w, drawOverlay, transform.flipH, transform.flipV, transform.rot90]);

  // Stage B: Map sliceHU -> RGBA offscreen canvas (runs when slice data OR WW/WL/LUT changes)
  const applyWindowToOffscreen = useCallback(() => {
    const sliceHU = sliceHURef.current;
    if (!sliceHU.length) return;

    if (!offCanvasRef.current) {
      offCanvasRef.current = document.createElement('canvas');
    }
    const off = offCanvasRef.current;
    if (off.width !== dims.w || off.height !== dims.h) {
      off.width = dims.w;
      off.height = dims.h;
      offImageDataRef.current = null;
    }
    const offCtx = off.getContext('2d', { alpha: false });
    if (!offCtx) return;

    if (!offImageDataRef.current) {
      offImageDataRef.current = offCtx.createImageData(dims.w, dims.h);
    }
    const imgData = offImageDataRef.current;
    const pixels32 = new Uint32Array(imgData.data.buffer);
    const lut = get2DColorLut(colormap, invert);
    const lut32 = new Uint32Array(lut.buffer, lut.byteOffset, 256);

    const low = wl - ww / 2;
    const invRange = 255 / Math.max(1, ww);
    const len = sliceHU.length;

    for (let i = 0; i < len; i++) {
      let idx = ((sliceHU[i] - low) * invRange) | 0;
      if (idx < 0) idx = 0;
      else if (idx > 255) idx = 255;
      pixels32[i] = lut32[idx];
    }
    offCtx.putImageData(imgData, 0, 0);
    blitImageToScreen();
  }, [blitImageToScreen, colormap, dims.h, dims.w, invert, wl, ww]);

  // Stage A: Extract slice HU (runs ONLY when this plane's slice/projection/oblique/volume changes!)
  const obliquePosKey = hasOblique ? `${pos.x},${pos.y},${pos.z}` : String(currentSliceIdx);

  useEffect(() => {
    const total = dims.w * dims.h;
    if (sliceHURef.current.length !== total) {
      sliceHURef.current = new Float32Array(total);
    }
    extractMprSliceHU(
      volume,
      plane,
      posRef.current,
      projMode,
      slabMm,
      obliqueDeg,
      sliceHURef.current
    );
    applyWindowToOffscreen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume, plane, obliquePosKey, projMode, slabMm, obliqueDeg, dims.w, dims.h]);

  // Re-run Stage B when WW/WL/invert/colormap changes without re-extracting slice
  useEffect(() => {
    applyWindowToOffscreen();
  }, [applyWindowToOffscreen]);

  // Re-run Stage C1 when pan/zoom/flip/rotate changes without touching LUT or slice
  useEffect(() => {
    blitImageToScreen();
  }, [blitImageToScreen]);

  // Re-run Stage C2 (overlay only) when orthogonal cursor pos or annotations change
  useEffect(() => {
    drawOverlay();
  }, [pos.x, pos.y, pos.z, drawOverlay]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const ro = new ResizeObserver(() => {
      blitImageToScreen();
    });
    ro.observe(body);
    return () => {
      ro.disconnect();
      if (moveRafRef.current) cancelAnimationFrame(moveRafRef.current);
    };
  }, [blitImageToScreen]);

  useEffect(() => {
    if (!registerCapture) return;
    registerCapture(plane, () => {
      const img = imgCanvasRef.current;
      const ov = overlayCanvasRef.current;
      if (!img) return null;
      const comp = document.createElement('canvas');
      comp.width = img.width;
      comp.height = img.height;
      const c = comp.getContext('2d');
      if (!c) return img.toDataURL('image/png');
      c.drawImage(img, 0, 0);
      if (ov) c.drawImage(ov, 0, 0);
      return comp.toDataURL('image/png');
    });
    return () => registerCapture(plane, null);
  }, [plane, registerCapture]);

  const handlePointerDown = (ev: React.PointerEvent<HTMLDivElement>) => {
    onActivate(plane);
    const body = bodyRef.current;
    const t = fitRef.current;
    if (!body || !t) return;
    body.setPointerCapture(ev.pointerId);
    const rect = body.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const py = ev.clientY - rect.top;
    const img = screenToImg(t, px, py);

    const activeTool: ToolMode = ev.button === 1 ? 'pan' : ev.button === 2 ? 'window' : tool;

    gestureRef.current = {
      tool: activeTool,
      startX: px,
      startY: py,
      startWW: ww,
      startWL: wl,
      startPanX: transform.panX,
      startPanY: transform.panY,
      startZoom: transform.zoom
    };

    if (activeTool === 'explore') {
      onMoveCursor(uvToVoxel(volume, plane, img.u, img.v, posRef.current));
    } else if (activeTool === 'probe') {
      const u = Math.max(0, Math.min(dims.w - 1, Math.round(img.u)));
      const v = Math.max(0, Math.min(dims.h - 1, Math.round(img.v)));
      const vox = uvToVoxel(volume, plane, u, v, posRef.current);
      const hu = sliceHURef.current[v * dims.w + u] ?? 0;
      onAddProbe({ view: plane, slice: currentSliceIdx, u, v, x: vox.x, y: vox.y, z: vox.z, hu });
    } else if (activeTool === 'measure') {
      const u = Math.max(0, Math.min(dims.w - 1, Math.round(img.u)));
      const v = Math.max(0, Math.min(dims.h - 1, Math.round(img.v)));
      if (!pendingMeasureRef.current) {
        pendingMeasureRef.current = { u, v };
      } else {
        const p = pendingMeasureRef.current;
        const mm = Math.hypot((u - p.u) * dims.su, (v - p.v) * dims.sv);
        onAddLength({
          view: plane,
          slice: currentSliceIdx,
          u1: p.u,
          v1: p.v,
          u2: u,
          v2: v,
          mm
        });
        pendingMeasureRef.current = null;
      }
      drawOverlay();
    } else if (activeTool === 'angle') {
      const u = Math.max(0, Math.min(dims.w - 1, Math.round(img.u)));
      const v = Math.max(0, Math.min(dims.h - 1, Math.round(img.v)));
      const pts = pendingAngleRef.current;
      pts.push({ u, v });
      if (pts.length === 3) {
        const [p1, p2, p3] = pts;
        const ax = (p1.u - p2.u) * dims.su;
        const ay = (p1.v - p2.v) * dims.sv;
        const bx = (p3.u - p2.u) * dims.su;
        const by = (p3.v - p2.v) * dims.sv;
        const mag = Math.hypot(ax, ay) * Math.hypot(bx, by);
        const dot = Math.max(-1, Math.min(1, mag > 1e-6 ? (ax * bx + ay * by) / mag : 1));
        const deg = (Math.acos(dot) * 180) / Math.PI;
        onAddAngle({
          view: plane,
          slice: currentSliceIdx,
          u1: p1.u,
          v1: p1.v,
          u2: p2.u,
          v2: p2.v,
          u3: p3.u,
          v3: p3.v,
          deg
        });
        pendingAngleRef.current = [];
      }
      drawOverlay();
    } else if (activeTool === 'roi') {
      pendingRoiRef.current = { u1: img.u, v1: img.v, u2: img.u, v2: img.v };
      drawOverlay();
    }
  };

  const handlePointerMove = (ev: React.PointerEvent<HTMLDivElement>) => {
    const body = bodyRef.current;
    const t = fitRef.current;
    if (!body || !t) return;
    const rect = body.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const py = ev.clientY - rect.top;
    const img = screenToImg(t, px, py);
    pointerMoveUVRef.current = img;

    // Update external HU store directly — ZERO React re-renders of parent/viewports!
    const u = Math.round(img.u);
    const v = Math.round(img.v);
    if (u >= 0 && u < dims.w && v >= 0 && v < dims.h) {
      const vox = uvToVoxel(volume, plane, u, v, posRef.current);
      const hu = sliceHURef.current[v * dims.w + u] ?? 0;
      setHoverVoxelInfo({ x: vox.x, y: vox.y, z: vox.z, hu });
    } else {
      setHoverVoxelInfo(null);
    }

    if ((tool === 'measure' && pendingMeasureRef.current) || (tool === 'angle' && pendingAngleRef.current.length > 0)) {
      drawOverlay();
    }

    const g = gestureRef.current;
    if (!g) return;

    if (g.tool === 'roi' && pendingRoiRef.current) {
      pendingRoiRef.current.u2 = img.u;
      pendingRoiRef.current.v2 = img.v;
      drawOverlay();
      return;
    }

    // Coalesce high-frequency mouse drags to animation frames
    if (moveRafRef.current) cancelAnimationFrame(moveRafRef.current);
    const dx = px - g.startX;
    const dy = py - g.startY;
    const imgCopy = { u: img.u, v: img.v };

    moveRafRef.current = requestAnimationFrame(() => {
      moveRafRef.current = 0;
      if (g.tool === 'explore') {
        onMoveCursor(uvToVoxel(volume, plane, imgCopy.u, imgCopy.v, posRef.current));
      } else if (g.tool === 'window') {
        onWindowChange(g.startWW + dx * 2.5, g.startWL - dy * 2.5);
      } else if (g.tool === 'pan') {
        onTransformChange(plane, { ...transform, panX: g.startPanX + dx, panY: g.startPanY + dy });
      } else if (g.tool === 'zoom') {
        const nextZoom = Math.max(0.35, Math.min(8, g.startZoom * (1 - dy / 220)));
        onTransformChange(plane, { ...transform, zoom: nextZoom });
      }
    });
  };

  const endGesture = () => {
    if (moveRafRef.current) {
      cancelAnimationFrame(moveRafRef.current);
      moveRafRef.current = 0;
    }
    const g = gestureRef.current;
    if (g && g.tool === 'roi' && pendingRoiRef.current) {
      const pr = pendingRoiRef.current;
      if (Math.abs(pr.u2 - pr.u1) > 1.5 && Math.abs(pr.v2 - pr.v1) > 1.5) {
        const computed = computeRoiStats(
          sliceHURef.current,
          volume,
          plane,
          currentSliceIdx,
          0,
          roiShape,
          pr.u1,
          pr.v1,
          pr.u2,
          pr.v2
        );
        const { id: _ignored, ...rest } = computed;
        void _ignored;
        onAddRoi(rest);
      }
      pendingRoiRef.current = null;
      drawOverlay();
    }
    gestureRef.current = null;
  };

  const handleWheel = (ev: React.WheelEvent<HTMLDivElement>) => {
    ev.preventDefault();
    onActivate(plane);
    if (ev.ctrlKey || ev.metaKey) {
      const factor = ev.deltaY < 0 ? 1.12 : 0.89;
      onTransformChange(plane, {
        ...transform,
        zoom: Math.max(0.35, Math.min(8, transform.zoom * factor))
      });
    } else {
      const step = (ev.deltaY > 0 ? 1 : -1) * (ev.shiftKey ? 5 : 1);
      const nextSlice = Math.max(0, Math.min(dims.maxSlice, currentSliceIdx + step));
      onMoveCursor({ ...posRef.current, [dims.axis]: nextSlice });
    }
  };

  const projTag = projMode === 'thin' ? '' : ` · ${projMode.toUpperCase()} ${slabMm.toFixed(0)}mm`;

  return (
    <section
      className={`flex flex-col bg-black rounded-lg overflow-hidden min-h-0 min-w-0 border transition-colors ${
        isActive ? 'border-opacity-100' : 'border-slate-800'
      }`}
      style={{ borderColor: isActive ? meta.color : undefined }}
      onClick={() => onActivate(plane)}
    >
      <div className="flex items-center gap-2 px-2.5 py-1.5 bg-[#0E1118] border-b border-slate-800/80 shrink-0">
        <span
          className="text-[11px] font-bold tracking-wider uppercase whitespace-nowrap"
          style={{ color: meta.color }}
        >
          {meta.title}
        </span>
        <span className="font-mono text-[11px] text-slate-400 ml-auto truncate">
          {currentSliceIdx + 1}/{dims.maxSlice + 1} · {(currentSliceIdx * dims.sliceSpacing).toFixed(1)} mm{projTag}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onTransformChange(plane, { ...transform, flipH: !transform.flipH });
          }}
          title="Voltear horizontalmente"
          className={`p-1 rounded border text-slate-400 hover:text-slate-100 transition-colors ${
            transform.flipH ? 'border-cyan-500/60 text-cyan-400 bg-cyan-500/10' : 'border-slate-800 bg-slate-900/60'
          }`}
        >
          <FlipHorizontal2 className="w-3 h-3" />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onTransformChange(plane, { ...transform, rot90: (transform.rot90 + 1) % 4 });
          }}
          title="Rotar 90°"
          className="p-1 rounded border border-slate-800 bg-slate-900/60 text-slate-400 hover:text-slate-100 transition-colors"
        >
          <RotateCw className="w-3 h-3" />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand(plane);
          }}
          title={isExpanded ? 'Volver a rejilla' : `Ampliar vista ${meta.title}`}
          className="p-1 rounded border border-slate-800 bg-slate-900/60 text-slate-400 hover:text-cyan-400 hover:border-cyan-500/50 transition-colors"
        >
          {isExpanded ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
        </button>
      </div>

      <div
        ref={bodyRef}
        className="relative flex-1 min-h-0 overflow-hidden touch-none cursor-crosshair select-none bg-black"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onPointerLeave={() => {
          pointerMoveUVRef.current = null;
          setHoverVoxelInfo(null);
        }}
        onWheel={handleWheel}
        onDoubleClick={() => onToggleExpand(plane)}
        onContextMenu={(e) => e.preventDefault()}
      >
        <canvas ref={imgCanvasRef} className="absolute inset-0 w-full h-full block" />
        <canvas ref={overlayCanvasRef} className="absolute inset-0 w-full h-full block pointer-events-none" />

        <span className="pointer-events-none absolute top-1.5 left-1/2 -translate-x-1/2 font-mono text-[11px] font-semibold text-white/75 drop-shadow">
          {meta.oriT}
        </span>
        <span className="pointer-events-none absolute bottom-1.5 left-1/2 -translate-x-1/2 font-mono text-[11px] font-semibold text-white/75 drop-shadow">
          {meta.oriB}
        </span>
        <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 font-mono text-[11px] font-semibold text-white/75 drop-shadow">
          {meta.oriL}
        </span>
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[11px] font-semibold text-white/75 drop-shadow">
          {meta.oriR}
        </span>

        <div className="pointer-events-none absolute left-2 bottom-1.5 font-mono text-[10px] leading-tight text-white/70 drop-shadow">
          <div>WW {Math.round(ww)} · WL {Math.round(wl)}</div>
          <div>{dims.w}×{dims.h} · {dims.su.toFixed(2)}mm</div>
        </div>
        <div className="pointer-events-none absolute right-2 bottom-1.5 font-mono text-[10px] leading-tight text-right text-white/70 drop-shadow">
          <div>Zoom {Math.round(transform.zoom * 100)}%</div>
          {hasOblique && <div>Oblicuo {obliqueDeg.toFixed(0)}°</div>}
        </div>
      </div>
    </section>
  );
};

export const Viewport2D = memo(Viewport2DInner);
