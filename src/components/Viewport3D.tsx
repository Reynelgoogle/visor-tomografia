import React, { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, RotateCcw } from 'lucide-react';
import type {
  Camera3DState,
  ClipBox,
  Settings3D,
  VolumeData
} from '../types/dicom';
import {
  buildTransferTextureData,
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
uniform vec3 uVolDims;
uniform vec3 uVoxelSpacing;
uniform vec3 uCursor;
uniform vec3 uBgColor;

uniform float uThreshold;
uniform float uOpacity;
uniform float uShading;
uniform float uBrightness;
uniform float uLow;
uniform float uHigh;
uniform float uSteps;
uniform int uMode;
uniform int uShowCrosshairs;
uniform int uShowClipBox;

in vec3 vPos;
out vec4 fragColor;

vec3 estimateGradient(vec3 p) {
  vec3 e = 1.0 / uVolDims;
  float gx = texture(uVol, p + vec3(e.x, 0.0, 0.0)).r - texture(uVol, p - vec3(e.x, 0.0, 0.0)).r;
  float gy = texture(uVol, p + vec3(0.0, e.y, 0.0)).r - texture(uVol, p - vec3(0.0, e.y, 0.0)).r;
  float gz = texture(uVol, p + vec3(0.0, 0.0, e.z)).r - texture(uVol, p - vec3(0.0, 0.0, e.z)).r;
  vec3 g = vec3(gx, gy, gz) / max(uVoxelSpacing, vec3(0.01));
  vec3 worldG = vec3(g.x, g.z, -g.y);
  float len = length(worldG);
  return len > 0.0001 ? worldG / len : vec3(0.0, 0.0, 1.0);
}

vec3 shadeBlinnPhong(vec3 baseCol, vec3 normal, vec3 viewDir) {
  vec3 upHint = abs(viewDir.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 right = normalize(cross(upHint, viewDir));
  vec3 up = cross(viewDir, right);
  vec3 keyLight = normalize(viewDir * 0.65 + right * 0.55 + up * 0.65);
  vec3 fillLight = normalize(-right * 0.6 + up * 0.3 + viewDir * 0.2);

  // Two-sided normal so clipped interior cuts also shade crisply
  float diff1 = abs(dot(normal, keyLight));
  float diff2 = abs(dot(normal, fillLight)) * 0.35;
  vec3 halfVec = normalize(keyLight + viewDir);
  float spec = pow(max(abs(dot(normal, halfVec)), 0.0), 28.0) * 0.42;
  float rim = pow(1.0 - max(abs(dot(normal, viewDir)), 0.0), 2.5) * 0.16;

  vec3 lit = baseCol * (0.28 + 0.78 * diff1 + diff2) + vec3(spec) + baseCol * rim;
  return mix(baseCol, lit, uShading);
}

void main() {
  vec3 ro = uCamPos;
  vec3 rd = normalize(vPos - ro);

  vec3 span = uBoxMax - uBoxMin;
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

  // Optional subtle clipping box wireframe outline on entry/exit
  if (uShowClipBox == 1) {
    vec3 pStart = (ro + rd * tn - cMin) / max(cMax - cMin, vec3(0.0001));
    vec3 edge = min(pStart, 1.0 - pStart);
    int nearCount = (edge.x < 0.012 ? 1 : 0) + (edge.y < 0.012 ? 1 : 0) + (edge.z < 0.012 ? 1 : 0);
    if (nearCount >= 2) {
      acc.rgb += vec3(0.96, 0.62, 0.04) * 0.45;
      acc.a += 0.25;
    }
  }

  for (float stepIdx = 0.0; stepIdx < 320.0; stepIdx += 1.0) {
    if (stepIdx >= uSteps || t >= tf) break;
    vec3 wNorm = (ro + rd * t - uBoxMin) / span;
    vec3 p = vec3(wNorm.x, 1.0 - wNorm.z, wNorm.y);
    float v = texture(uVol, p).r;

    if (uMode == 1) {
      // MIP
      maxVal = max(maxVal, v);
    } else if (uMode == 2) {
      // MinIP (ignore extreme empty exterior < 0.005)
      if (v > 0.005) minVal = min(minVal, v);
    } else if (uMode == 3) {
      // DRR X-Ray Beer-Lambert attenuation
      float density = max(0.0, v - 0.05);
      drrSum += density * dt * 2.1;
    } else if (uMode == 4) {
      // Iso-surface (SSD)
      if (v >= uThreshold) {
        vec3 n = estimateGradient(p);
        vec4 tfCol = texture(uLUT, vec2(v, 0.5));
        vec3 baseCol = length(tfCol.rgb) > 0.05 ? tfCol.rgb : vec3(0.92, 0.89, 0.82);
        vec3 shaded = shadeBlinnPhong(baseCol, n, viewDir) * uBrightness;
        acc.rgb = mix(acc.rgb, shaded, 1.0 - acc.a);
        acc.a = 1.0;
        break;
      }
    } else {
      // Mode 0: Full Gradient-Shaded Volume Rendering (VR) with 1D Transfer LUT
      vec4 tfCol = texture(uLUT, vec2(v, 0.5));
      float a = tfCol.a;

      // Linked 3D MPR crosshair plane highlight
      if (uShowCrosshairs == 1 && a > 0.02) {
        vec3 pd = abs(p - uCursor);
        float dp = min(pd.x, min(pd.y, pd.z));
        if (dp < 0.0045) {
          vec3 pc = (pd.z <= pd.x && pd.z <= pd.y)
            ? vec3(0.92, 0.28, 0.60)
            : (pd.y <= pd.x ? vec3(0.02, 0.71, 0.83) : vec3(0.52, 0.80, 0.09));
          tfCol.rgb = mix(tfCol.rgb, pc, 0.6);
          a = max(a, 0.35);
        }
      }

      if (a > 0.01) {
        vec3 col = tfCol.rgb;
        if (uShading > 0.01) {
          vec3 n = estimateGradient(p);
          col = shadeBlinnPhong(col, n, viewDir);
        }
        col *= uBrightness;
        float alpha = clamp(a * uOpacity * dt * 3.4, 0.0, 1.0);
        acc.rgb += (1.0 - acc.a) * alpha * col;
        acc.a += (1.0 - acc.a) * alpha;
        if (acc.a > 0.985) break;
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

function matMul(a: Float32Array, b: Float32Array): Float32Array {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

function matPerspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0
  ]);
}

function rotX(a: number): Float32Array {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
}

function rotY(a: number): Float32Array {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
}

function toHalfFloat(val: number): number {
  const fView = new Float32Array(1);
  const iView = new Int32Array(fView.buffer);
  fView[0] = val;
  const x = iView[0];
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

export const Viewport3D: React.FC<Viewport3DProps> = ({
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
  const cameraRef = useRef(camera);
  cameraRef.current = camera;

  const propsRef = useRef({ volume, pos, ww, wl, clipBox, camera, settings });
  propsRef.current = { volume, pos, ww, wl, clipBox, camera, settings };

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
      'uVolDims', 'uVoxelSpacing', 'uCursor', 'uBgColor',
      'uThreshold', 'uOpacity', 'uShading', 'uBrightness',
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

      const { volume: vol, pos: p, ww: curWW, wl: curWL, clipBox: cb, camera: cam, settings: st } =
        propsRef.current;

      const maxDim = st.highQuality && !isInteractive ? 760 : 520;
      const dpr = Math.min(1.5, window.devicePixelRatio || 1);
      const fit = Math.min(1, maxDim / Math.max(rect.width, rect.height));
      const w = Math.max(2, Math.round(rect.width * dpr * fit));
      const h = Math.max(2, Math.round(rect.height * dpr * fit));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      gl.viewport(0, 0, w, h);
      const bg =
        st.bgMode === 'white'
          ? [0.95, 0.96, 0.98]
          : st.bgMode === 'navy'
          ? [0.03, 0.06, 0.12]
          : [0.0, 0.0, 0.0];
      gl.clearColor(bg[0], bg[1], bg[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(prog);
      const model = matMul(rotY(cam.yaw), rotX(cam.pitch));
      const proj = matPerspective(0.68, w / h, 0.1, 15);
      const view = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -cam.dist, 1]);
      const mvp = matMul(proj, matMul(view, model));
      gl.uniformMatrix4fv(uniforms.uMVP, false, mvp);

      const camObj = [model[2] * cam.dist, model[6] * cam.dist, model[10] * cam.dist];
      gl.uniform3f(uniforms.uCamPos, camObj[0], camObj[1], camObj[2]);
      gl.uniform3f(uniforms.uBgColor, bg[0], bg[1], bg[2]);

      gl.uniform3f(uniforms.uClipMin, cb.xMin, cb.yMin, cb.zMin);
      gl.uniform3f(uniforms.uClipMax, cb.xMax, cb.yMax, cb.zMax);
      gl.uniform3f(uniforms.uVolDims, vol.nx, vol.ny, vol.nz);
      gl.uniform3f(uniforms.uVoxelSpacing, vol.spx, vol.spy, vol.spz);
      gl.uniform3f(uniforms.uCursor, (p.x + 0.5) / vol.nx, (p.y + 0.5) / vol.ny, (p.z + 0.5) / vol.nz);

      gl.uniform1f(uniforms.uThreshold, (st.thresholdHU - VOLUME_HU_MIN) / VOLUME_HU_RANGE);
      gl.uniform1f(uniforms.uOpacity, st.opacity);
      gl.uniform1f(uniforms.uShading, st.shading);
      gl.uniform1f(uniforms.uBrightness, st.brightness);
      gl.uniform1f(uniforms.uLow, (curWL - curWW / 2 - VOLUME_HU_MIN) / VOLUME_HU_RANGE);
      gl.uniform1f(uniforms.uHigh, (curWL + curWW / 2 - VOLUME_HU_MIN) / VOLUME_HU_RANGE);

      const steps = isInteractive ? 110 : st.highQuality ? 230 : 150;
      gl.uniform1f(uniforms.uSteps, steps);

      const modeMap: Record<string, number> = { vr: 0, mip: 1, minip: 2, drr: 3, surface: 4 };
      gl.uniform1i(uniforms.uMode, modeMap[st.renderMode] ?? 0);
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
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      gl.deleteTexture(volTex);
      gl.deleteTexture(lutTex);
      gl.deleteBuffer(vbo);
      gl.deleteProgram(prog);
      glStateRef.current = null;
    };
  }, []);

  // Upload 3D Volume Geometry + Texture when volume changes
  useEffect(() => {
    const st = glStateRef.current;
    if (!st) return;
    const { gl, vbo, volTex, uniforms, supportsFloatLinear, draw } = st;

    const physX = volume.nx * volume.spx;
    const physY = volume.nz * volume.spz; // vertical Head-Feet
    const physZ = volume.ny * volume.spy; // depth Posterior-Anterior
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

    const len = volume.data.length;
    if (supportsFloatLinear) {
      const halfData = new Uint16Array(len);
      for (let i = 0; i < len; i++) {
        const n = Math.max(0, Math.min(1, (volume.data[i] - VOLUME_HU_MIN) / VOLUME_HU_RANGE));
        halfData[i] = toHalfFloat(n);
      }
      gl.texImage3D(
        gl.TEXTURE_3D,
        0,
        gl.R16F,
        volume.nx,
        volume.ny,
        volume.nz,
        0,
        gl.RED,
        gl.HALF_FLOAT,
        halfData
      );
    } else {
      const byteData = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        const n = Math.max(0, Math.min(1, (volume.data[i] - VOLUME_HU_MIN) / VOLUME_HU_RANGE));
        byteData[i] = (n * 255) | 0;
      }
      gl.texImage3D(
        gl.TEXTURE_3D,
        0,
        gl.R8,
        volume.nx,
        volume.ny,
        volume.nz,
        0,
        gl.RED,
        gl.UNSIGNED_BYTE,
        byteData
      );
    }

    draw(false);
  }, [volume]);

  // Upload 1D Transfer Function LUT when preset or threshold changes
  useEffect(() => {
    const st = glStateRef.current;
    if (!st) return;
    const { gl, lutTex, draw } = st;
    const lutBytes = buildTransferTextureData(settings.preset, settings.thresholdHU);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, lutTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lutBytes);

    draw(interactingRef.current);
  }, [settings.preset, settings.thresholdHU]);

  // Redraw whenever render parameters / cursor / camera / clipBox change
  useEffect(() => {
    const st = glStateRef.current;
    if (!st) return;
    st.draw(interactingRef.current);
  }, [pos, ww, wl, clipBox, camera, settings]);

  // Auto-spin turntable animation loop
  useEffect(() => {
    if (!settings.autoSpin) return;
    let raf = 0;
    const tick = () => {
      onCameraChange({
        ...cameraRef.current,
        yaw: cameraRef.current.yaw + 0.012
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [settings.autoSpin, onCameraChange]);

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
  };

  const handlePointerMove = (ev: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const dx = ev.clientX - draggingRef.current.x;
    const dy = ev.clientY - draggingRef.current.y;
    draggingRef.current = { x: ev.clientX, y: ev.clientY };
    onCameraChange({
      ...camera,
      yaw: camera.yaw + dx * 0.009,
      pitch: Math.max(-1.48, Math.min(1.48, camera.pitch + dy * 0.009))
    });
  };

  const endDrag = () => {
    if (draggingRef.current) {
      draggingRef.current = null;
      interactingRef.current = false;
      glStateRef.current?.draw(false);
    }
  };

  const handleWheel = (ev: React.WheelEvent<HTMLDivElement>) => {
    ev.preventDefault();
    onActivate();
    const nextDist = Math.max(1.15, Math.min(4.2, camera.dist * (ev.deltaY > 0 ? 1.08 : 0.92)));
    onCameraChange({ ...camera, dist: nextDist });
  };

  // Compute projected 3D axis gizmo vectors matching rotY(yaw) * rotX(pitch)
  const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw);
  const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
  const projectAxis = (ax: number, ay: number, az: number) => {
    // rotX(pitch) first
    const y1 = ay * cp - az * sp;
    const z1 = ay * sp + az * cp;
    // rotY(yaw) second
    const x2 = ax * cy + z1 * sy;
    return { x: x2 * 18, y: -y1 * 18 };
  };
  const axisR = projectAxis(-1, 0, 0);
  const axisA = projectAxis(0, 0, 1);
  const axisH = projectAxis(0, 1, 0);

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

        {/* 3D Anatomical Orientation Gizmo */}
        <svg
          viewBox="-26 -26 52 52"
          className="pointer-events-none absolute top-2 right-2 w-12 h-12 drop-shadow"
          aria-hidden="true"
        >
          <circle cx="0" cy="0" r="23" fill="rgba(7,9,13,0.55)" stroke="rgba(148,163,184,0.22)" strokeWidth="1" />
          <line x1="0" y1="0" x2={axisR.x} y2={axisR.y} stroke="#EC4899" strokeWidth="1.6" />
          <line x1="0" y1="0" x2={axisA.x} y2={axisA.y} stroke="#06B6D4" strokeWidth="1.6" />
          <line x1="0" y1="0" x2={axisH.x} y2={axisH.y} stroke="#84CC16" strokeWidth="1.6" />
          <text x={axisR.x * 1.18} y={axisR.y * 1.18 + 3} fontSize="7" fontFamily="monospace" fontWeight="700" fill="#EC4899" textAnchor="middle">R</text>
          <text x={axisA.x * 1.18} y={axisA.y * 1.18 + 3} fontSize="7" fontFamily="monospace" fontWeight="700" fill="#06B6D4" textAnchor="middle">A</text>
          <text x={axisH.x * 1.18} y={axisH.y * 1.18 + 3} fontSize="7" fontFamily="monospace" fontWeight="700" fill="#84CC16" textAnchor="middle">H</text>
        </svg>

        <div className="pointer-events-none absolute left-2 bottom-1.5 font-mono text-[10px] text-white/70 bg-black/45 px-1.5 py-0.5 rounded">
          Arrastra para orbitar · Rueda para zoom
        </div>
      </div>
    </section>
  );
};
