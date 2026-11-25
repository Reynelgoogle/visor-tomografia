import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, RotateCcw } from 'lucide-react';
import type {
  Camera3DState,
  ClipBox,
  Settings3D,
  VolumeData
} from '../types/dicom';
import {
  buildTransferTextureData,
  TRANSFER_LUT_SIZE,
  VOLUME_HU_MIN,
  VOLUME_HU_RANGE
} from '../utils/colormaps';

interface Viewport3DProps {
  volume: VolumeData;
  pos: { x: number; y: number; z: number };
  ww: number;
  wl: number;
  clipBox: ClipBox;
  camera: Camera3DState;
  settings: Settings3D;
  isActive: boolean;
  isExpanded: boolean;
  onActivate: () => void;
  onToggleExpand: () => void;
  onCameraChange: (next: Camera3DState) => void;
  onResetCamera: () => void;
  registerCapture?: (fn: (() => string | null) | null) => void;
}

const VERTEX_SHADER = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uMVP;
out vec3 vPos;
void main() {
  vPos = aPos;
  gl_Position = uMVP * vec4(aPos, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler3D;

uniform sampler3D uVol;
uniform sampler2D uLUT;
uniform vec3 uCamPos;
uniform vec3 uBoxMin;
uniform vec3 uBoxMax;
uniform vec3 uClipMin;
uniform vec3 uClipMax;
uniform vec3 uInvVolDims;
uniform vec3 uInvVoxelSpacing;
uniform vec3 uCursor;
uniform vec3 uBgColor;

uniform float uThreshold;
uniform float uOpacity;
uniform float uShading;
uniform float uBrightness;
uniform float uEdgeBoost;
uniform float uLow;
uniform float uHigh;
uniform float uSteps;
uniform int uMode;
uniform int uShowCrosshairs;
uniform int uShowClipBox;

in vec3 vPos;
out vec4 fragColor;

// 4-tap tetrahedral finite difference (33% fewer 3D texture reads than 6-tap)
vec4 estimateGradient(vec3 p) {
  vec3 e = uInvVolDims;
  const vec3 k0 = vec3( 1.0, -1.0, -1.0);
  const vec3 k1 = vec3(-1.0, -1.0,  1.0);
  const vec3 k2 = vec3(-1.0,  1.0, -1.0);
  const vec3 k3 = vec3( 1.0,  1.0,  1.0);
  float f0 = texture(uVol, p + k0 * e).r;
  float f1 = texture(uVol, p + k1 * e).r;
  float f2 = texture(uVol, p + k2 * e).r;
  float f3 = texture(uVol, p + k3 * e).r;
  vec3 raw = (k0 * f0 + k1 * f1 + k2 * f2 + k3 * f3) * 0.5;
  float rawMag = length(raw);
  vec3 g = raw * uInvVoxelSpacing;
  vec3 worldG = vec3(g.x, g.z, -g.y);
  float len = length(worldG);
  vec3 n = len > 0.0001 ? worldG / len : vec3(0.0, 0.0, 1.0);
  return vec4(n, rawMag);
}

vec3 shadeBlinnPhong(vec3 baseCol, vec3 normal, vec3 viewDir) {
  vec3 upHint = abs(viewDir.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 right = normalize(cross(upHint, viewDir));
  vec3 up = cross(viewDir, right);
  vec3 keyLight = normalize(viewDir * 0.65 + right * 0.55 + up * 0.65);
  vec3 fillLight = normalize(-right * 0.6 + up * 0.3 + viewDir * 0.2);

  float diff1 = abs(dot(normal, keyLight));
  float diff2 = abs(dot(normal, fillLight)) * 0.38;
  vec3 halfVec = normalize(keyLight + viewDir);
  float spec = pow(max(abs(dot(normal, halfVec)), 0.0), 32.0) * 0.45;
  float rim = pow(1.0 - max(abs(dot(normal, viewDir)), 0.0), 2.4) * 0.18;

  vec3 lit = baseCol * (0.26 + 0.80 * diff1 + diff2) + vec3(spec) + baseCol * rim;
  return mix(baseCol, lit, uShading);
}

void main() {
  vec3 ro = uCamPos;
  vec3 rd = normalize(vPos - ro);

  vec3 span = uBoxMax - uBoxMin;
  vec3 invSpan = 1.0 / span;
  vec3 worldClipMin = vec3(uClipMin.x, uClipMin.z, 1.0 - uClipMax.y);
  vec3 worldClipMax = vec3(uClipMax.x, uClipMax.z, 1.0 - uClipMin.y);
  vec3 cMin = uBoxMin + worldClipMin * span;
  vec3 cMax = uBoxMin + worldClipMax * span;

  vec3 invRd = 1.0 / rd;
  vec3 t0 = (cMin - ro) * invRd;
  vec3 t1 = (cMax - ro) * invRd;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  float tn = max(max(tmin.x, tmin.y), tmin.z);
  float tf = min(min(tmax.x, tmax.y), tmax.z);
  tn = max(tn, 0.0);

  if (tf <= tn) {
    fragColor = vec4(uBgColor, 1.0);
    return;
  }

  float dt = (tf - tn) / uSteps;
  float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  float t = tn + jitter * dt;

  vec4 acc = vec4(0.0);
  float maxVal = 0.0;
  float minVal = 1.0;
  float drrSum = 0.0;
  vec3 viewDir = -rd;

  if (uShowClipBox == 1) {
    vec3 pStart = (ro + rd * tn - cMin) / max(cMax - cMin, vec3(0.0001));
    vec3 edge = min(pStart, 1.0 - pStart);
    int nearCount = (edge.x < 0.012 ? 1 : 0) + (edge.y < 0.012 ? 1 : 0) + (edge.z < 0.012 ? 1 : 0);
    if (nearCount >= 2) {
      acc.rgb += vec3(0.96, 0.62, 0.04) * 0.45;
      acc.a += 0.25;
    }
  }

  for (float stepIdx = 0.0; stepIdx < 420.0; stepIdx += 1.0) {
    if (stepIdx >= uSteps || t >= tf) break;
    vec3 wNorm = (ro + rd * t - uBoxMin) * invSpan;
    vec3 p = vec3(wNorm.x, 1.0 - wNorm.z, wNorm.y);
    float v = texture(uVol, p).r;

    if (uMode == 1) {
      maxVal = max(maxVal, v);
    } else if (uMode == 2) {
      if (v > 0.005) minVal = min(minVal, v);
    } else if (uMode == 3) {
      float density = max(0.0, v - 0.05);
      drrSum += density * dt * 2.1;
    } else if (uMode == 4) {
      if (v >= uThreshold) {
        vec3 n = estimateGradient(p).xyz;
        vec4 tfCol = texture(uLUT, vec2(v, 0.5));
        vec3 baseCol = length(tfCol.rgb) > 0.05 ? tfCol.rgb : vec3(0.92, 0.89, 0.82);
        vec3 shaded = shadeBlinnPhong(baseCol, n, viewDir) * uBrightness;
        acc.rgb = mix(acc.rgb, shaded, 1.0 - acc.a);
        acc.a = 1.0;
        break;
      }
    } else {
      vec4 tfCol = texture(uLUT, vec2(v, 0.5));
      float a = tfCol.a;

      if (uShowCrosshairs == 1 && a > 0.015) {
        vec3 pd = abs(p - uCursor);
        float dp = min(pd.x, min(pd.y, pd.z));
        if (dp < 0.004) {
          vec3 pc = (pd.z <= pd.x && pd.z <= pd.y)
            ? vec3(0.92, 0.28, 0.60)
            : (pd.y <= pd.x ? vec3(0.02, 0.71, 0.83) : vec3(0.52, 0.80, 0.09));
          tfCol.rgb = mix(tfCol.rgb, pc, 0.55);
          a = max(a, 0.30);
        }
      }

      if (a > 0.005) {
        vec3 col = tfCol.rgb;
        float boundaryWeight = 1.0;
        if (uShading > 0.01 || uEdgeBoost > 0.01) {
          vec4 gn = estimateGradient(p);
          if (uEdgeBoost > 0.01) {
            float edgeFactor = smoothstep(0.004, 0.075, gn.w) * 1.85 + 0.18;
            boundaryWeight = mix(1.0, edgeFactor, uEdgeBoost);
          }
          if (uShading > 0.01) {
            col = shadeBlinnPhong(col, gn.xyz, viewDir);
          }
        }
        float depthAtten = mix(1.0, 1.0 - acc.a * 0.25, uShading);
        col *= uBrightness * depthAtten;
        float alpha = clamp(a * boundaryWeight * uOpacity * dt * 4.2, 0.0, 1.0);
        acc.rgb += (1.0 - acc.a) * alpha * col;
        acc.a += (1.0 - acc.a) * alpha;
        if (acc.a > 0.985) break;
      } else {
        t += dt * 0.55;
      }
    }

    t += dt;
  }

  if (uMode == 1) {
    float g = clamp((maxVal - uLow) / max(uHigh - uLow, 0.001), 0.0, 1.0);
    fragColor = vec4(mix(uBgColor, vec3(g), g), 1.0);
  } else if (uMode == 2) {
    float g = clamp((minVal - uLow) / max(uHigh - uLow, 0.001), 0.0, 1.0);
    fragColor = vec4(vec3(g), 1.0);
  } else if (uMode == 3) {
    float xray = clamp(1.0 - exp(-drrSum * uBrightness * 1.15), 0.0, 1.0);
    fragColor = vec4(mix(uBgColor, vec3(xray * 0.95, xray * 0.97, xray), xray), 1.0);
  } else {
    fragColor = vec4(acc.rgb + (1.0 - acc.a) * uBgColor, 1.0);
  }
}
`;

// Pre-allocated scratch matrices (zero heap allocations per WebGL frame)
const _rotX = new Float32Array(16);
const _rotY = new Float32Array(16);
const _model = new Float32Array(16);
const _proj = new Float32Array(16);
const _view = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const _vm = new Float32Array(16);
const _mvp = new Float32Array(16);

function matMulInto(a: Float32Array, b: Float32Array, out: Float32Array): void {
  for (let c = 0; c < 4; c++) {
    const c4 = c * 4;
    const b0 = b[c4];
    const b1 = b[c4 + 1];
    const b2 = b[c4 + 2];
    const b3 = b[c4 + 3];
    for (let r = 0; r < 4; r++) {
      out[c4 + r] = a[r] * b0 + a[4 + r] * b1 + a[8 + r] * b2 + a[12 + r] * b3;
    }
  }
}

function setPerspective(out: Float32Array, fovy: number, aspect: number, near: number, far: number): void {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) * nf;
  out[11] = -1;
  out[14] = 2 * far * near * nf;
}

function setRotX(out: Float32Array, a: number): void {
  const c = Math.cos(a);
  const s = Math.sin(a);
  out.fill(0);
  out[0] = 1;
  out[5] = c;
  out[6] = s;
  out[9] = -s;
  out[10] = c;
  out[15] = 1;
}

function setRotY(out: Float32Array, a: number): void {
  const c = Math.cos(a);
  const s = Math.sin(a);
  out.fill(0);
  out[0] = c;
  out[2] = -s;
  out[5] = 1;
  out[8] = s;
  out[10] = c;
  out[15] = 1;
}

const _hfFloatView = new Float32Array(1);
const _hfIntView = new Int32Array(_hfFloatView.buffer);

function toHalfFloat(val: number): number {
  _hfFloatView[0] = val;
  const x = _hfIntView[0];
  let bits = (x >> 16) & 0x8000;
  let m = (x >> 12) & 0x07ff;
  const e = (x >> 23) & 0xff;
  if (e < 103) return bits;
  if (e > 142) {
    bits |= 0x7c00;
    bits |= (e === 255 ? 0 : 1) && x & 0x007fffff;
    return bits;
  }
  if (e < 113) {
    m |= 0x0800;
    bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1);
    return bits;
  }
  bits |= ((e - 112) << 10) | (m >> 1);
  bits += m & 1;
  return bits;
}

function resampleVolumeForGPU(
  volume: VolumeData,
  maxTexDim: number
): { nx: number; ny: number; nz: number; data: Float32Array } {
  const maxVoxels = 24_000_000;
  let scale = 1;
  const maxSide = Math.max(volume.nx, volume.ny, volume.nz);
  if (maxSide > maxTexDim) {
    scale = Math.min(scale, maxTexDim / maxSide);
  }
  const total = volume.nx * volume.ny * volume.nz;
  if (total * scale * scale * scale > maxVoxels) {
    scale = Math.min(scale, Math.cbrt(maxVoxels / total));
  }
  if (scale >= 0.99) {
    return { nx: volume.nx, ny: volume.ny, nz: volume.nz, data: volume.data };
  }

  const nx = Math.max(2, Math.round(volume.nx * scale));
  const ny = Math.max(2, Math.round(volume.ny * scale));
  const nz = Math.max(2, Math.round(volume.nz * scale));
  const out = new Float32Array(nx * ny * nz);
  const src = volume.data;
  const sx = volume.nx / nx;
  const sy = volume.ny / ny;
  const sz = volume.nz / nz;
  const srcNxy = volume.nx * volume.ny;

  for (let z = 0; z < nz; z++) {
    const oz = Math.min(volume.nz - 1, Math.floor(z * sz));
    const zBase = oz * srcNxy;
    const dstZ = z * nx * ny;
    for (let y = 0; y < ny; y++) {
      const oy = Math.min(volume.ny - 1, Math.floor(y * sy));
      const yBase = zBase + oy * volume.nx;
      const dstY = dstZ + y * nx;
      for (let x = 0; x < nx; x++) {
        const ox = Math.min(volume.nx - 1, Math.floor(x * sx));
        out[dstY + x] = src[yBase + ox];
      }
    }
  }
  return { nx, ny, nz, data: out };
}

function projectGizmoAxis(cam: Camera3DState, ax: number, ay: number, az: number) {
  const cy = Math.cos(cam.yaw);
  const sy = Math.sin(cam.yaw);
  const cp = Math.cos(cam.pitch);
  const sp = Math.sin(cam.pitch);
  const y1 = ay * cp - az * sp;
  const z1 = ay * sp + az * cp;
  const x2 = ax * cy + z1 * sy;
  return { x: x2 * 18, y: -y1 * 18 };
}

const MODE_MAP: Record<string, number> = { vr: 0, mip: 1, minip: 2, drr: 3, surface: 4 };

const Viewport3DInner: React.FC<Viewport3DProps> = ({
  volume,
  pos,
  ww,
  wl,
  clipBox,
  camera,
  settings,
  isActive,
  isExpanded,
  onActivate,
  onToggleExpand,
  onCameraChange,
  onResetCamera,
  registerCapture
}) => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [glError, setGlError] = useState<string | null>(null);
  const [contextLost, setContextLost] = useState(false);

  // SVG gizmo refs for zero-React-rerender orientation updates during orbit/autoSpin
  const axisRLineRef = useRef<SVGLineElement>(null);
  const axisALineRef = useRef<SVGLineElement>(null);
  const axisHLineRef = useRef<SVGLineElement>(null);
  const axisRTextRef = useRef<SVGTextElement>(null);
  const axisATextRef = useRef<SVGTextElement>(null);
  const axisHTextRef = useRef<SVGTextElement>(null);

  const glStateRef = useRef<{
    gl: WebGL2RenderingContext;
    prog: WebGLProgram;
    volTex: WebGLTexture;
    lutTex: WebGLTexture;
    vbo: WebGLBuffer;
    supportsFloatLinear: boolean;
    uniforms: Record<string, WebGLUniformLocation | null>;
    draw: (isInteractive?: boolean) => void;
  } | null>(null);

  const draggingRef = useRef<{ x: number; y: number } | null>(null);
  const interactingRef = useRef(false);
  const dragRafRef = useRef<number>(0);
  const refineTimerRef = useRef<number>(0);
  const wheelCommitTimerRef = useRef<number>(0);

  // Local mutable camera state decouples 60 FPS orbit/zoom/autoSpin from React state tree
  const localCameraRef = useRef<Camera3DState>({ ...camera });
  const gpuDimsRef = useRef<{ nx: number; ny: number; nz: number }>({
    nx: volume.nx,
    ny: volume.ny,
    nz: volume.nz
  });

  const propsRef = useRef({ volume, pos, ww, wl, clipBox, settings });
  propsRef.current = { volume, pos, ww, wl, clipBox, settings };

  const updateGizmoDOM = useCallback((cam: Camera3DState) => {
    const r = projectGizmoAxis(cam, -1, 0, 0);
    const a = projectGizmoAxis(cam, 0, 0, 1);
    const h = projectGizmoAxis(cam, 0, 1, 0);

    if (axisRLineRef.current && axisRTextRef.current) {
      axisRLineRef.current.setAttribute('x2', r.x.toFixed(2));
      axisRLineRef.current.setAttribute('y2', r.y.toFixed(2));
      axisRTextRef.current.setAttribute('x', (r.x * 1.18).toFixed(2));
      axisRTextRef.current.setAttribute('y', (r.y * 1.18 + 3).toFixed(2));
    }
    if (axisALineRef.current && axisATextRef.current) {
      axisALineRef.current.setAttribute('x2', a.x.toFixed(2));
      axisALineRef.current.setAttribute('y2', a.y.toFixed(2));
      axisATextRef.current.setAttribute('x', (a.x * 1.18).toFixed(2));
      axisATextRef.current.setAttribute('y', (a.y * 1.18 + 3).toFixed(2));
    }
    if (axisHLineRef.current && axisHTextRef.current) {
      axisHLineRef.current.setAttribute('x2', h.x.toFixed(2));
      axisHLineRef.current.setAttribute('y2', h.y.toFixed(2));
      axisHTextRef.current.setAttribute('x', (h.x * 1.18).toFixed(2));
      axisHTextRef.current.setAttribute('y', (h.y * 1.18 + 3).toFixed(2));
    }
  }, []);

  const scheduleRefine = useCallback(() => {
    if (refineTimerRef.current) window.clearTimeout(refineTimerRef.current);
    refineTimerRef.current = window.setTimeout(() => {
      refineTimerRef.current = 0;
      if (!interactingRef.current && !propsRef.current.settings.autoSpin) {
        glStateRef.current?.draw(false);
      }
    }, 120);
  }, []);

  // Initialize WebGL2 pipeline
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: true
    });
    if (!gl) {
      setGlError('WebGL2 no disponible en este navegador.');
      return;
    }

    const compileShader = (type: number, src: string) => {
      const sh = gl.createShader(type);
      if (!sh) return null;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.warn('WebGL2 Shader Error:', gl.getShaderInfoLog(sh));
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    };

    const vs = compileShader(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vs || !fs) {
      setGlError('No se pudieron compilar los shaders 3D.');
      return;
    }

    const prog = gl.createProgram();
    if (!prog) return;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('WebGL2 Link Error:', gl.getProgramInfoLog(prog));
      setGlError('Error al enlazar programa WebGL2.');
      return;
    }
    gl.useProgram(prog);

    const vbo = gl.createBuffer();
    if (!vbo) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    const volTex = gl.createTexture();
    const lutTex = gl.createTexture();
    if (!volTex || !lutTex) return;

    const supportsFloatLinear = Boolean(gl.getExtension('OES_texture_float_linear'));

    const uniformNames = [
      'uMVP', 'uCamPos', 'uBoxMin', 'uBoxMax', 'uClipMin', 'uClipMax',
      'uInvVolDims', 'uInvVoxelSpacing', 'uCursor', 'uBgColor',
      'uThreshold', 'uOpacity', 'uShading', 'uBrightness', 'uEdgeBoost',
      'uLow', 'uHigh', 'uSteps', 'uMode', 'uShowCrosshairs', 'uShowClipBox',
      'uVol', 'uLUT'
    ];
    const uniforms: Record<string, WebGLUniformLocation | null> = {};
    for (const name of uniformNames) {
      uniforms[name] = gl.getUniformLocation(prog, name);
    }

    const draw = (isInteractive = false) => {
      const body = bodyRef.current;
      if (!body || gl.isContextLost()) return;
      const rect = body.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return;

      const { volume: vol, pos: p, ww: curWW, wl: curWL, clipBox: cb, settings: st } =
        propsRef.current;
      const cam = localCameraRef.current;

      // Progressive resolution scaling: fast pass during interaction, crisp pass when idle
      const maxDim = isInteractive ? 440 : st.highQuality ? 760 : 520;
      const dpr = Math.min(1.5, window.devicePixelRatio || 1);
      const fit = Math.min(1, maxDim / Math.max(rect.width, rect.height));
      const w = Math.max(2, Math.round(rect.width * dpr * fit));
      const h = Math.max(2, Math.round(rect.height * dpr * fit));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      gl.viewport(0, 0, w, h);
      const bgR = st.bgMode === 'white' ? 0.95 : st.bgMode === 'navy' ? 0.03 : 0.0;
      const bgG = st.bgMode === 'white' ? 0.96 : st.bgMode === 'navy' ? 0.06 : 0.0;
      const bgB = st.bgMode === 'white' ? 0.98 : st.bgMode === 'navy' ? 0.12 : 0.0;
      gl.clearColor(bgR, bgG, bgB, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(prog);
      setRotY(_rotY, cam.yaw);
      setRotX(_rotX, cam.pitch);
      matMulInto(_rotY, _rotX, _model);
      setPerspective(_proj, 0.68, w / h, 0.1, 15);
      _view[14] = -cam.dist;
      matMulInto(_view, _model, _vm);
      matMulInto(_proj, _vm, _mvp);
      gl.uniformMatrix4fv(uniforms.uMVP, false, _mvp);

      gl.uniform3f(uniforms.uCamPos, _model[2] * cam.dist, _model[6] * cam.dist, _model[10] * cam.dist);
      gl.uniform3f(uniforms.uBgColor, bgR, bgG, bgB);

      gl.uniform3f(uniforms.uClipMin, cb.xMin, cb.yMin, cb.zMin);
      gl.uniform3f(uniforms.uClipMax, cb.xMax, cb.yMax, cb.zMax);
      gl.uniform3f(
        uniforms.uInvVolDims,
        1 / Math.max(1, gpuDimsRef.current.nx),
        1 / Math.max(1, gpuDimsRef.current.ny),
        1 / Math.max(1, gpuDimsRef.current.nz)
      );
      gl.uniform3f(
        uniforms.uInvVoxelSpacing,
        1 / Math.max(0.01, vol.spx),
        1 / Math.max(0.01, vol.spy),
        1 / Math.max(0.01, vol.spz)
      );
      gl.uniform3f(uniforms.uCursor, (p.x + 0.5) / vol.nx, (p.y + 0.5) / vol.ny, (p.z + 0.5) / vol.nz);

      gl.uniform1f(uniforms.uThreshold, (st.thresholdHU - VOLUME_HU_MIN) / VOLUME_HU_RANGE);
      gl.uniform1f(uniforms.uOpacity, st.opacity);
      gl.uniform1f(uniforms.uShading, st.shading);
      gl.uniform1f(uniforms.uBrightness, st.brightness);
      gl.uniform1f(uniforms.uEdgeBoost, st.edgeBoost);
      gl.uniform1f(uniforms.uLow, (curWL - curWW / 2 - VOLUME_HU_MIN) / VOLUME_HU_RANGE);
      gl.uniform1f(uniforms.uHigh, (curWL + curWW / 2 - VOLUME_HU_MIN) / VOLUME_HU_RANGE);

      const steps = isInteractive ? 128 : st.highQuality ? 340 : 210;
      gl.uniform1f(uniforms.uSteps, steps);

      gl.uniform1i(uniforms.uMode, MODE_MAP[st.renderMode] ?? 0);
      gl.uniform1i(uniforms.uShowCrosshairs, st.showCrosshairs ? 1 : 0);
      gl.uniform1i(uniforms.uShowClipBox, st.showClipBox ? 1 : 0);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_3D, volTex);
      gl.uniform1i(uniforms.uVol, 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, lutTex);
      gl.uniform1i(uniforms.uLUT, 1);

      gl.drawArrays(gl.TRIANGLES, 0, 36);
    };

    glStateRef.current = {
      gl,
      prog,
      volTex,
      lutTex,
      vbo,
      supportsFloatLinear,
      uniforms,
      draw
    };

    const onLost = (e: Event) => {
      e.preventDefault();
      setContextLost(true);
    };
    const onRestored = () => {
      setContextLost(false);
    };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);

    return () => {
      if (dragRafRef.current) cancelAnimationFrame(dragRafRef.current);
      if (refineTimerRef.current) window.clearTimeout(refineTimerRef.current);
      if (wheelCommitTimerRef.current) window.clearTimeout(wheelCommitTimerRef.current);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      gl.deleteTexture(volTex);
      gl.deleteTexture(lutTex);
      gl.deleteBuffer(vbo);
      gl.deleteProgram(prog);
      glStateRef.current = null;
    };
  }, []);

  // Sync external camera prop changes (e.g., reset camera button)
  useEffect(() => {
    const cur = localCameraRef.current;
    if (cur.yaw !== camera.yaw || cur.pitch !== camera.pitch || cur.dist !== camera.dist) {
      localCameraRef.current = { ...camera };
      updateGizmoDOM(camera);
      glStateRef.current?.draw(false);
    }
  }, [camera, updateGizmoDOM]);

  // Upload 3D Volume Geometry + Texture when volume changes
  useEffect(() => {
    const st = glStateRef.current;
    if (!st) return;
    const { gl, vbo, volTex, uniforms, supportsFloatLinear, draw } = st;

    const physX = volume.nx * volume.spx;
    const physY = volume.nz * volume.spz;
    const physZ = volume.ny * volume.spy;
    const maxPhys = Math.max(physX, physY, physZ, 1);
    const hx = 0.5 * (physX / maxPhys);
    const hy = 0.5 * (physY / maxPhys);
    const hz = 0.5 * (physZ / maxPhys);

    const verts = new Float32Array([
      -hx, -hy, -hz,  hx, -hy, -hz,  hx,  hy, -hz, -hx, -hy, -hz,  hx,  hy, -hz, -hx,  hy, -hz,
      -hx, -hy,  hz,  hx,  hy,  hz,  hx, -hy,  hz, -hx, -hy,  hz, -hx,  hy,  hz,  hx,  hy,  hz,
      -hx, -hy, -hz, -hx,  hy, -hz, -hx,  hy,  hz, -hx, -hy, -hz, -hx,  hy,  hz, -hx, -hy,  hz,
       hx, -hy, -hz,  hx,  hy,  hz,  hx,  hy, -hz,  hx, -hy, -hz,  hx, -hy,  hz,  hx,  hy,  hz,
      -hx, -hy, -hz, -hx, -hy,  hz,  hx, -hy,  hz, -hx, -hy, -hz,  hx, -hy,  hz,  hx, -hy, -hz,
      -hx,  hy, -hz,  hx,  hy, -hz,  hx,  hy,  hz, -hx,  hy, -hz,  hx,  hy,  hz, -hx,  hy,  hz
    ]);

    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.useProgram(st.prog);
    gl.uniform3f(uniforms.uBoxMin, -hx, -hy, -hz);
    gl.uniform3f(uniforms.uBoxMax, hx, hy, hz);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, volTex);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    const max3dDim = (gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number) || 512;
    const gpuVol = resampleVolumeForGPU(volume, max3dDim);
    gpuDimsRef.current = { nx: gpuVol.nx, ny: gpuVol.ny, nz: gpuVol.nz };
    const len = gpuVol.data.length;
    if (supportsFloatLinear) {
      const halfData = new Uint16Array(len);
      for (let i = 0; i < len; i++) {
        const n = Math.max(0, Math.min(1, (gpuVol.data[i] - VOLUME_HU_MIN) / VOLUME_HU_RANGE));
        halfData[i] = toHalfFloat(n);
      }
      gl.texImage3D(
        gl.TEXTURE_3D,
        0,
        gl.R16F,
        gpuVol.nx,
        gpuVol.ny,
        gpuVol.nz,
        0,
        gl.RED,
        gl.HALF_FLOAT,
        halfData
      );
    } else {
      const byteData = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        const n = Math.max(0, Math.min(1, (gpuVol.data[i] - VOLUME_HU_MIN) / VOLUME_HU_RANGE));
        byteData[i] = (n * 255) | 0;
      }
      gl.texImage3D(
        gl.TEXTURE_3D,
        0,
        gl.R8,
        gpuVol.nx,
        gpuVol.ny,
        gpuVol.nz,
        0,
        gl.RED,
        gl.UNSIGNED_BYTE,
        byteData
      );
    }

    draw(false);
  }, [volume]);

  // Upload 1D Transfer Function LUT when preset, threshold, or contrast changes
  useEffect(() => {
    const st = glStateRef.current;
    if (!st) return;
    const { gl, lutTex, draw } = st;
    const lutBytes = buildTransferTextureData(
      settings.preset,
      settings.thresholdHU,
      settings.contrastScale
    );

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, lutTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      TRANSFER_LUT_SIZE,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      lutBytes
    );

    draw(true);
    scheduleRefine();
  }, [settings.preset, settings.thresholdHU, settings.contrastScale, scheduleRefine]);

  // Redraw when clipBox or shading/opacity/mode/quality settings change (interactive + HD pass)
  useEffect(() => {
    const st = glStateRef.current;
    if (!st) return;
    st.draw(true);
    scheduleRefine();
  }, [clipBox, settings, scheduleRefine]);

  // Only redraw on 2D crosshair movement if 3D crosshairs are visible
  useEffect(() => {
    if (!settings.showCrosshairs) return;
    const st = glStateRef.current;
    if (!st) return;
    st.draw(true);
    scheduleRefine();
  }, [pos, settings.showCrosshairs, scheduleRefine]);

  // Only redraw on 2D WW/WL changes if 3D mode actually uses uLow/uHigh (MIP / MinIP)
  useEffect(() => {
    if (settings.renderMode !== 'mip' && settings.renderMode !== 'minip') return;
    const st = glStateRef.current;
    if (!st) return;
    st.draw(true);
    scheduleRefine();
  }, [ww, wl, settings.renderMode, scheduleRefine]);

  // Auto-spin turntable animation loop: zero React state churn!
  useEffect(() => {
    if (!settings.autoSpin) return;
    let raf = 0;
    const tick = () => {
      const nextCam = {
        ...localCameraRef.current,
        yaw: localCameraRef.current.yaw + 0.012
      };
      localCameraRef.current = nextCam;
      updateGizmoDOM(nextCam);
      glStateRef.current?.draw(true);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      onCameraChange({ ...localCameraRef.current });
      scheduleRefine();
    };
  }, [settings.autoSpin, onCameraChange, scheduleRefine, updateGizmoDOM]);

  // ResizeObserver for layout transitions
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const ro = new ResizeObserver(() => {
      glStateRef.current?.draw(false);
    });
    ro.observe(body);
    return () => ro.disconnect();
  }, []);

  // PNG capture registration
  useEffect(() => {
    if (!registerCapture) return;
    registerCapture(() => {
      const canvas = canvasRef.current;
      const st = glStateRef.current;
      if (!canvas || !st) return null;
      st.draw(false);
      return canvas.toDataURL('image/png');
    });
    return () => registerCapture(null);
  }, [registerCapture]);

  const handlePointerDown = (ev: React.PointerEvent<HTMLDivElement>) => {
    onActivate();
    const body = bodyRef.current;
    if (!body) return;
    body.setPointerCapture(ev.pointerId);
    draggingRef.current = { x: ev.clientX, y: ev.clientY };
    interactingRef.current = true;
    if (refineTimerRef.current) {
      window.clearTimeout(refineTimerRef.current);
      refineTimerRef.current = 0;
    }
  };

  const handlePointerMove = (ev: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const dx = ev.clientX - draggingRef.current.x;
    const dy = ev.clientY - draggingRef.current.y;
    draggingRef.current = { x: ev.clientX, y: ev.clientY };

    const cur = localCameraRef.current;
    localCameraRef.current = {
      yaw: cur.yaw + dx * 0.009,
      pitch: Math.max(-1.48, Math.min(1.48, cur.pitch + dy * 0.009)),
      dist: cur.dist
    };

    if (!dragRafRef.current) {
      dragRafRef.current = requestAnimationFrame(() => {
        dragRafRef.current = 0;
        updateGizmoDOM(localCameraRef.current);
        glStateRef.current?.draw(true);
      });
    }
  };

  const endDrag = () => {
    if (draggingRef.current) {
      draggingRef.current = null;
      interactingRef.current = false;
      if (dragRafRef.current) {
        cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = 0;
      }
      const committed = { ...localCameraRef.current };
      updateGizmoDOM(committed);
      onCameraChange(committed);
      scheduleRefine();
    }
  };

  const handleWheel = (ev: React.WheelEvent<HTMLDivElement>) => {
    ev.preventDefault();
    onActivate();
    const cur = localCameraRef.current;
    const nextDist = Math.max(1.15, Math.min(4.2, cur.dist * (ev.deltaY > 0 ? 1.08 : 0.92)));
    localCameraRef.current = { ...cur, dist: nextDist };

    if (!dragRafRef.current) {
      dragRafRef.current = requestAnimationFrame(() => {
        dragRafRef.current = 0;
        glStateRef.current?.draw(true);
      });
    }

    if (wheelCommitTimerRef.current) window.clearTimeout(wheelCommitTimerRef.current);
    wheelCommitTimerRef.current = window.setTimeout(() => {
      wheelCommitTimerRef.current = 0;
      onCameraChange({ ...localCameraRef.current });
      glStateRef.current?.draw(false);
    }, 160);
  };

  // Initial SVG gizmo coordinates
  const initR = projectGizmoAxis(camera, -1, 0, 0);
  const initA = projectGizmoAxis(camera, 0, 0, 1);
  const initH = projectGizmoAxis(camera, 0, 1, 0);

  const modeLabels: Record<string, string> = {
    vr: 'VR Sombreado',
    mip: 'MIP 3D',
    minip: 'MinIP 3D',
    drr: 'DRR Rayos X',
    surface: 'Iso-Superficie'
  };

  return (
    <section
      className={`flex flex-col bg-black rounded-lg overflow-hidden min-h-0 min-w-0 border transition-colors ${
        isActive ? 'border-amber-400' : 'border-slate-800'
      }`}
      onClick={onActivate}
    >
      <div className="flex items-center gap-2 px-2.5 py-1.5 bg-[#0E1118] border-b border-slate-800/80 shrink-0">
        <span className="text-[11px] font-bold tracking-wider uppercase text-amber-400 whitespace-nowrap">
          Reconstrucción 3D
        </span>
        <span className="font-mono text-[11px] text-slate-400 ml-auto truncate">
          {modeLabels[settings.renderMode]} · {settings.preset.toUpperCase()}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onResetCamera();
          }}
          title="Restablecer cámara 3D"
          className="p-1 rounded border border-slate-800 bg-slate-900/60 text-slate-400 hover:text-amber-400 transition-colors"
        >
          <RotateCcw className="w-3 h-3" />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand();
          }}
          title={isExpanded ? 'Volver a rejilla' : 'Ampliar vista 3D'}
          className="p-1 rounded border border-slate-800 bg-slate-900/60 text-slate-400 hover:text-amber-400 transition-colors"
        >
          {isExpanded ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
        </button>
      </div>

      <div
        ref={bodyRef}
        className="relative flex-1 min-h-0 overflow-hidden touch-none cursor-grab active:cursor-grabbing select-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={handleWheel}
        onDoubleClick={onToggleExpand}
      >
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full block" />

        {(glError || contextLost) && (
          <div className="absolute inset-0 grid place-items-center bg-slate-950/90 p-6 text-center text-xs text-slate-300 z-10">
            {contextLost ? 'Contexto WebGL2 suspendido. Restaurando…' : glError}
          </div>
        )}

        {/* 3D Anatomical Orientation Gizmo (updated directly via DOM refs) */}
        <svg
          viewBox="-26 -26 52 52"
          className="pointer-events-none absolute top-2 right-2 w-12 h-12 drop-shadow"
          aria-hidden="true"
        >
          <circle cx="0" cy="0" r="23" fill="rgba(7,9,13,0.55)" stroke="rgba(148,163,184,0.22)" strokeWidth="1" />
          <line ref={axisRLineRef} x1="0" y1="0" x2={initR.x} y2={initR.y} stroke="#EC4899" strokeWidth="1.6" />
          <line ref={axisALineRef} x1="0" y1="0" x2={initA.x} y2={initA.y} stroke="#06B6D4" strokeWidth="1.6" />
          <line ref={axisHLineRef} x1="0" y1="0" x2={initH.x} y2={initH.y} stroke="#84CC16" strokeWidth="1.6" />
          <text ref={axisRTextRef} x={initR.x * 1.18} y={initR.y * 1.18 + 3} fontSize="7" fontFamily="monospace" fontWeight="700" fill="#EC4899" textAnchor="middle">R</text>
          <text ref={axisATextRef} x={initA.x * 1.18} y={initA.y * 1.18 + 3} fontSize="7" fontFamily="monospace" fontWeight="700" fill="#06B6D4" textAnchor="middle">A</text>
          <text ref={axisHTextRef} x={initH.x * 1.18} y={initH.y * 1.18 + 3} fontSize="7" fontFamily="monospace" fontWeight="700" fill="#84CC16" textAnchor="middle">H</text>
        </svg>

        <div className="pointer-events-none absolute left-2 bottom-1.5 font-mono text-[10px] text-white/70 bg-black/45 px-1.5 py-0.5 rounded">
          Arrastra para orbitar · Rueda para zoom
        </div>
      </div>
    </section>
  );
};

export const Viewport3D = memo(Viewport3DInner);
