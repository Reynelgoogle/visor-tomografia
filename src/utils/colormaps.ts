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

export const TRANSFER_LUT_SIZE = 2048;

export const TRANSFER_PRESETS_3D: TransferPreset3DMeta[] = [
  {
    id: 'viscera',
    label: 'Vísceras / Abdo',
    defaultThreshold: 35,
    stops: [
      [-1024, 0, 0, 0, 0],
      [-20, 125, 62, 52, 0],
      [25, 168, 84, 68, 0.02],
      [55, 195, 96, 78, 0.22],
      [105, 224, 122, 86, 0.42],
      [175, 238, 68, 62, 0.72],
      [320, 248, 175, 118, 0.84],
      [550, 232, 224, 206, 0.28],
      [1200, 248, 246, 240, 0.45]
    ]
  },
  {
    id: 'angio',
    label: 'Angio / Vasos',
    defaultThreshold: 115,
    stops: [
      [-1024, 0, 0, 0, 0],
      [90, 145, 26, 30, 0],
      [125, 212, 42, 46, 0.42],
      [210, 245, 76, 56, 0.85],
      [340, 255, 138, 82, 0.92],
      [480, 225, 212, 188, 0.22],
      [900, 246, 242, 232, 0.45],
      [1600, 255, 255, 255, 0.75]
    ]
  },
  {
    id: 'kidney',
    label: 'Riñón / Corteza',
    defaultThreshold: 65,
    stops: [
      [-1024, 0, 0, 0, 0],
      [30, 135, 62, 58, 0],
      [75, 182, 78, 66, 0.16],
      [135, 222, 98, 72, 0.48],
      [220, 245, 148, 92, 0.78],
      [360, 255, 214, 142, 0.90],
      [600, 230, 224, 210, 0.18],
      [1400, 245, 242, 235, 0.35]
    ]
  },
  {
    id: 'gi',
    label: 'Estómago / Asas',
    defaultThreshold: -220,
    stops: [
      [-1024, 0, 0, 0, 0],
      [-860, 42, 178, 208, 0],
      [-650, 62, 204, 228, 0.24],
      [-280, 214, 152, 96, 0.34],
      [-120, 188, 126, 86, 0],
      [-15, 155, 78, 68, 0],
      [25, 198, 108, 86, 0.26],
      [95, 232, 148, 112, 0.38],
      [220, 245, 92, 72, 0.65],
      [500, 225, 218, 204, 0.14],
      [1400, 245, 242, 236, 0.28]
    ]
  },
  {
    id: 'bone',
    label: 'Hueso',
    defaultThreshold: 180,
    stops: [
      [-1024, 0, 0, 0, 0],
      [120, 162, 122, 98, 0],
      [200, 212, 182, 146, 0.12],
      [280, 240, 224, 196, 0.55],
      [400, 250, 240, 218, 0.92],
      [700, 254, 248, 235, 1.0],
      [1600, 255, 255, 250, 1.0]
    ]
  },
  {
    id: 'soft',
    label: 'Músculo y piel',
    defaultThreshold: -140,
    stops: [
      [-1024, 0, 0, 0, 0],
      [-220, 185, 132, 112, 0],
      [-80, 196, 138, 116, 0.12],
      [40, 182, 76, 68, 0.32],
      [180, 226, 198, 165, 0.65],
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
      [-930, 56, 210, 232, 0.58],
      [-760, 20, 130, 165, 0.08],
      [40, 120, 80, 75, 0.012],
      [550, 225, 215, 195, 0.24],
      [1600, 255, 255, 245, 0.55]
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
      [-320, 215, 120, 110, 0.45],
      [80, 190, 82, 76, 0.20],
      [450, 238, 228, 208, 0.72],
      [1600, 255, 255, 250, 0.95]
    ]
  },
  {
    id: 'manual',
    label: 'Manual',
    defaultThreshold: 40,
    stops: [
      [-1024, 0, 0, 0, 0],
      [40, 198, 118, 96, 0.36],
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
  thresholdHU: number,
  contrastScale = 1
): Uint8Array {
  const size = TRANSFER_LUT_SIZE;
  const out = new Uint8Array(size * 4);
  const preset = TRANSFER_PRESETS_3D.find((p) => p.id === presetId) ?? TRANSFER_PRESETS_3D[0];
  const scale = Math.max(0.25, Math.min(3, contrastScale));

  if (presetId === 'manual') {
    const center = thresholdHU;
    const width = 260 / scale;
    for (let i = 0; i < size; i++) {
      const hu = VOLUME_HU_MIN + (i / (size - 1)) * VOLUME_HU_RANGE;
      const a = Math.max(0, Math.min(1, (hu - center) / width));
      let r = 182, g = 96, b = 82;
      if (hu > center + width * 0.45) {
        const f = Math.min(1, (hu - (center + width * 0.45)) / (width * 1.4));
        r = Math.round(198 + f * 55);
        g = Math.round(135 + f * 108);
        b = Math.round(110 + f * 124);
      }
      out[i * 4] = r;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = b;
      out[i * 4 + 3] = Math.round(Math.pow(a, 1.35) * 255);
    }
    return out;
  }

  const stops = preset.stops;
  const shift = thresholdHU - preset.defaultThreshold;

  for (let i = 0; i < size; i++) {
    const rawHu = VOLUME_HU_MIN + (i / (size - 1)) * VOLUME_HU_RANGE;
    // Apply threshold shift & contrast expansion around the preset anchor
    const hu = preset.defaultThreshold + (rawHu - thresholdHU) * scale;
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
    void shift;
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
