import type { ColorMapId, TransferPreset3DId } from '../types/dicom';

export interface WindowPreset {
  id: string;
  label: string;
  ww: number;
  wl: number;
}

export const WINDOW_PRESETS: WindowPreset[] = [
  { id: 'brain', label: 'Cerebro', ww: 80, wl: 40 },
  { id: 'stroke', label: 'ACV', ww: 40, wl: 40 },
  { id: 'subdural', label: 'Subdural', ww: 200, wl: 75 },
  { id: 'soft', label: 'Tejido blando', ww: 350, wl: 50 },
  { id: 'abdomen', label: 'Abdomen', ww: 400, wl: 60 },
  { id: 'liver', label: 'Hígado', ww: 150, wl: 60 },
  { id: 'angio', label: 'Angio', ww: 600, wl: 180 },
  { id: 'bone', label: 'Hueso', ww: 1800, wl: 400 },
  { id: 'lung', label: 'Pulmón', ww: 1500, wl: -600 }
];

export const COLORMAP_OPTIONS: Array<{ id: ColorMapId; label: string }> = [
  { id: 'gray', label: 'Grises' },
  { id: 'hot', label: 'PET / Hot' },
  { id: 'viridis', label: 'Viridis' },
  { id: 'cardiac', label: 'Cardio' },
  { id: 'pet', label: 'Espectro' }
];

function lerpColor(
  stops: Array<[number, number, number, number]>,
  t: number
): [number, number, number] {
  if (t <= stops[0][0]) return [stops[0][1], stops[0][2], stops[0][3]];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, r0, g0, b0] = stops[i - 1];
      const [t1, r1, g1, b1] = stops[i];
      const f = (t - t0) / Math.max(1e-6, t1 - t0);
      return [
        Math.round(r0 + (r1 - r0) * f),
        Math.round(g0 + (g1 - g0) * f),
        Math.round(b0 + (b1 - b0) * f)
      ];
    }
  }
  const last = stops[stops.length - 1];
  return [last[1], last[2], last[3]];
}

const LUT_CACHE = new Map<string, Uint8Array>();

export function get2DColorLut(id: ColorMapId, invert: boolean): Uint8Array {
  const key = `${id}-${invert ? 1 : 0}`;
  const cached = LUT_CACHE.get(key);
  if (cached) return cached;

  const lut = new Uint8Array(256 * 4);
  const stopsMap: Record<ColorMapId, Array<[number, number, number, number]>> = {
    gray: [
      [0, 0, 0, 0],
      [1, 255, 255, 255]
    ],
    hot: [
      [0, 0, 0, 0],
      [0.35, 165, 18, 12],
      [0.7, 245, 158, 11],
      [1, 255, 252, 224]
    ],
    viridis: [
      [0, 12, 8, 28],
      [0.25, 59, 82, 139],
      [0.5, 33, 145, 140],
      [0.75, 94, 201, 98],
      [1, 253, 231, 37]
    ],
    cardiac: [
      [0, 0, 0, 0],
      [0.25, 14, 48, 96],
      [0.55, 6, 182, 212],
      [0.82, 245, 158, 11],
      [1, 255, 255, 255]
    ],
    pet: [
      [0, 0, 0, 0],
      [0.2, 30, 58, 138],
      [0.45, 16, 185, 129],
      [0.7, 245, 158, 11],
      [0.9, 239, 68, 68],
      [1, 255, 255, 255]
    ]
  };

  const stops = stopsMap[id];
  for (let i = 0; i < 256; i++) {
    const t = invert ? 1 - i / 255 : i / 255;
    const [r, g, b] = lerpColor(stops, t);
    lut[i * 4] = r;
    lut[i * 4 + 1] = g;
    lut[i * 4 + 2] = b;
    lut[i * 4 + 3] = 255;
  }

  LUT_CACHE.set(key, lut);
  return lut;
}

export interface TransferPreset3DMeta {
  id: TransferPreset3DId;
  label: string;
  defaultThreshold: number;
  stops: Array<[number, number, number, number, number]>; // [hu, r, g, b, alpha(0..1)]
}

export const TRANSFER_PRESETS_3D: TransferPreset3DMeta[] = [
  {
    id: 'bone',
    label: 'Hueso',
    defaultThreshold: 140,
    stops: [
      [-1024, 0, 0, 0, 0],
      [-50, 140, 82, 72, 0],
      [35, 168, 96, 82, 0.03],
      [140, 205, 168, 128, 0.14],
      [320, 238, 224, 198, 0.65],
      [750, 252, 246, 232, 0.94],
      [1600, 255, 255, 250, 1.0]
    ]
  },
  {
    id: 'angio',
    label: 'Angio / Vasos',
    defaultThreshold: 140,
    stops: [
      [-1024, 0, 0, 0, 0],
      [110, 140, 28, 32, 0],
      [175, 220, 38, 48, 0.52],
      [320, 248, 96, 72, 0.85],
      [520, 240, 212, 180, 0.45],
      [900, 248, 244, 234, 0.72],
      [1600, 255, 255, 255, 0.92]
    ]
  },
  {
    id: 'soft',
    label: 'Músculo y piel',
    defaultThreshold: -180,
    stops: [
      [-1024, 0, 0, 0, 0],
      [-260, 185, 132, 112, 0],
      [-80, 196, 138, 116, 0.14],
      [40, 178, 72, 68, 0.34],
      [180, 224, 198, 165, 0.62],
      [600, 250, 242, 224, 0.92],
      [1600, 255, 255, 255, 1.0]
    ]
  },
  {
    id: 'airways',
    label: 'Vías aéreas',
    defaultThreshold: -920,
    stops: [
      [-1024, 0, 0, 0, 0],
      [-985, 22, 180, 212, 0],
      [-930, 56, 210, 232, 0.55],
      [-760, 20, 130, 165, 0.08],
      [40, 120, 80, 75, 0.015],
      [550, 225, 215, 195, 0.25],
      [1600, 255, 255, 245, 0.6]
    ]
  },
  {
    id: 'lung',
    label: 'Pulmón',
    defaultThreshold: -850,
    stops: [
      [-1024, 0, 0, 0, 0],
      [-860, 48, 145, 185, 0],
      [-720, 72, 175, 212, 0.18],
      [-320, 215, 120, 110, 0.42],
      [80, 190, 82, 76, 0.22],
      [450, 238, 228, 208, 0.72],
      [1600, 255, 255, 250, 0.95]
    ]
  },
  {
    id: 'manual',
    label: 'Manual',
    defaultThreshold: -150,
    stops: [
      [-1024, 0, 0, 0, 0],
      [-150, 168, 112, 98, 0.08],
      [45, 198, 118, 96, 0.36],
      [280, 240, 214, 178, 0.76],
      [900, 255, 248, 235, 0.96],
      [1600, 255, 255, 255, 1.0]
    ]
  }
];

export const VOLUME_HU_MIN = -1024;
export const VOLUME_HU_MAX = 1800;
export const VOLUME_HU_RANGE = VOLUME_HU_MAX - VOLUME_HU_MIN;

export function buildTransferTextureData(
  presetId: TransferPreset3DId,
  thresholdHU: number
): Uint8Array {
  const out = new Uint8Array(256 * 4);
  const preset = TRANSFER_PRESETS_3D.find((p) => p.id === presetId) ?? TRANSFER_PRESETS_3D[0];

  if (presetId === 'manual') {
    const thrNorm = (thresholdHU - VOLUME_HU_MIN) / VOLUME_HU_RANGE;
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      const hu = VOLUME_HU_MIN + t * VOLUME_HU_RANGE;
      const a = Math.max(0, Math.min(1, (t - thrNorm) / 0.12));
      let r = 175, g = 105, b = 92;
      if (hu > 160) {
        const f = Math.min(1, (hu - 160) / 420);
        r = Math.round(195 + f * 58);
        g = Math.round(135 + f * 108);
        b = Math.round(115 + f * 118);
      }
      out[i * 4] = r;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = b;
      out[i * 4 + 3] = Math.round(a * a * 255);
    }
    return out;
  }

  const stops = preset.stops;
  // Allow user threshold slider to smoothly offset/gate lower intensities on non-manual presets too
  const shift = thresholdHU - preset.defaultThreshold;

  for (let i = 0; i < 256; i++) {
    const hu = VOLUME_HU_MIN + (i / 255) * VOLUME_HU_RANGE - shift * 0.65;
    let r = 0, g = 0, b = 0, a = 0;
    if (hu <= stops[0][0]) {
      [, r, g, b, a] = stops[0];
    } else if (hu >= stops[stops.length - 1][0]) {
      [, r, g, b, a] = stops[stops.length - 1];
    } else {
      for (let s = 1; s < stops.length; s++) {
        if (hu <= stops[s][0]) {
          const [h0, r0, g0, b0, a0] = stops[s - 1];
          const [h1, r1, g1, b1, a1] = stops[s];
          const f = (hu - h0) / Math.max(1e-5, h1 - h0);
          r = r0 + (r1 - r0) * f;
          g = g0 + (g1 - g0) * f;
          b = b0 + (b1 - b0) * f;
          a = a0 + (a1 - a0) * f;
          break;
        }
      }
    }
    out[i * 4] = Math.max(0, Math.min(255, Math.round(r)));
    out[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(g)));
    out[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(b)));
    out[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
  }
  return out;
}

export function tissueNameFromHU(hu: number): string {
  if (hu < -900) return 'Aire / Cavidad';
  if (hu < -350) return 'Parénquima pulmonar';
  if (hu < -30) return 'Tejido adiposo (grasa)';
  if (hu < 16) return 'Líquido / LCR';
  if (hu < 55) return 'Parénquima / Tejido blando';
  if (hu < 140) return 'Sangre / Órgano vascularizado';
  if (hu < 380) return 'Contraste vascular / Calcificación';
  if (hu < 700) return 'Hueso trabecular';
  return 'Hueso cortical denso';
}
