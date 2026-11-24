import type { DicomTagEntry, VolumeData } from '../types/dicom';

export type PhantomId = 'craneo' | 'torax' | 'abdomen';

function hashNoise(x: number, y: number, z: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

function ellipsoid(
  fx: number,
  fy: number,
  fz: number,
  cx: number,
  cy: number,
  cz: number,
  rx: number,
  ry: number,
  rz: number
): number {
  const dx = (fx - cx) / rx;
  const dy = (fy - cy) / ry;
  const dz = (fz - cz) / rz;
  return dx * dx + dy * dy + dz * dz;
}

function distToSegment2D(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const lenSq = vx * vx + vy * vy;
  const t = lenSq > 0 ? Math.max(0, Math.min(1, (wx * vx + wy * wy) / lenSq)) : 0;
  const dx = px - (ax + t * vx);
  const dy = py - (ay + t * vy);
  return Math.sqrt(dx * dx + dy * dy);
}

function buildPhantomTags(
  patient: string,
  study: string,
  series: string,
  nx: number,
  ny: number,
  spx: number,
  spy: number,
  spz: number,
  ww: number,
  wl: number
): DicomTagEntry[] {
  return [
    { tag: '(0008,0060)', vr: 'CS', name: 'Modality', value: 'CT' },
    { tag: '(0008,1030)', vr: 'LO', name: 'StudyDescription', value: study },
    { tag: '(0008,103E)', vr: 'LO', name: 'SeriesDescription', value: series },
    { tag: '(0010,0010)', vr: 'PN', name: 'PatientName', value: patient },
    { tag: '(0018,0050)', vr: 'DS', name: 'SliceThickness', value: spz.toFixed(2) },
    { tag: '(0018,0060)', vr: 'DS', name: 'KVP', value: '120' },
    { tag: '(0018,1151)', vr: 'IS', name: 'XRayTubeCurrent', value: '240' },
    { tag: '(0028,0010)', vr: 'US', name: 'Rows', value: String(ny) },
    { tag: '(0028,0011)', vr: 'US', name: 'Columns', value: String(nx) },
    { tag: '(0028,0030)', vr: 'DS', name: 'PixelSpacing', value: `${spy.toFixed(2)}\\${spx.toFixed(2)}` },
    { tag: '(0028,1050)', vr: 'DS', name: 'WindowCenter', value: String(wl) },
    { tag: '(0028,1051)', vr: 'DS', name: 'WindowWidth', value: String(ww) },
    { tag: '(0028,1052)', vr: 'DS', name: 'RescaleIntercept', value: '-1024' },
    { tag: '(0028,1053)', vr: 'DS', name: 'RescaleSlope', value: '1' }
  ];
}

export function generatePhantomVolume(id: PhantomId): VolumeData {
  if (id === 'torax') return generateThoraxPhantom();
  if (id === 'abdomen') return generateAbdomenPhantom();
  return generateCraniumPhantom();
}

function generateCraniumPhantom(): VolumeData {
  const nx = 144, ny = 144, nz = 104;
  const spx = 1.6, spy = 1.6, spz = 1.85;
  const data = new Float32Array(nx * ny * nz);
  const cx = (nx - 1) / 2, cy = (ny - 1) / 2;
  let huMin = Infinity, huMax = -Infinity;

  for (let z = 0; z < nz; z++) {
    const fz = z / (nz - 1);
    let prof = Math.sqrt(Math.max(0.03, 1 - Math.pow((fz - 0.42) / 0.78, 2)));
    if (fz > 0.78) prof *= 1 - 0.28 * (fz - 0.78) / 0.22;
    if (fz < 0.12) prof *= 0.85 + 1.25 * fz;
    const radX = 0.79 * prof;
    const radY = 0.94 * prof;

    for (let y = 0; y < ny; y++) {
      const fy = (y - cy) / (ny / 2);
      for (let x = 0; x < nx; x++) {
        const fx = (x - cx) / (nx / 2);
        const d = Math.sqrt((fx / radX) ** 2 + (fy / radY) ** 2);
        const n = hashNoise(x, y, z);
        let hu: number;

        if (d > 1.085) {
          hu = -1000 + n * 10;
        } else if (d > 1.0) {
          hu = 40 + n * 6; // scalp
        } else if (d > 0.955) {
          hu = 1080 + 120 * Math.sin(fx * 24 + fz * 32) + n * 45; // outer cortical table
        } else if (d > 0.915) {
          hu = 520 + 80 * Math.cos(fy * 18) + n * 35; // diploe
        } else if (d > 0.88) {
          hu = 1050 + n * 40; // inner cortical table
        } else {
          hu = (d > 0.71 ? 39 : 29) +
            3.5 * Math.sin(fx * 9.5 + fz * 14) +
            3.0 * Math.sin(fy * 11.3 - fz * 9) +
            n * 3.5;
          if (d > 0.79 && Math.sin(Math.atan2(fy, fx) * 16 + fz * 42) > 0.84) {
            hu = 9; // cortical sulci
          }
        }

        // Lateral & 3rd ventricles
        if (
          ellipsoid(fx, fy, fz, 0.165, 0.03, 0.55, 0.082, 0.29, 0.095) < 1 ||
          ellipsoid(fx, fy, fz, -0.165, 0.03, 0.55, 0.082, 0.29, 0.095) < 1 ||
          ellipsoid(fx, fy, fz, 0, 0.06, 0.47, 0.022, 0.15, 0.07) < 1
        ) {
          hu = 6 + n * 2;
        }

        // Basal ganglia & thalami
        if (
          ellipsoid(fx, fy, fz, 0.29, 0.09, 0.46, 0.10, 0.14, 0.08) < 1 ||
          ellipsoid(fx, fy, fz, -0.29, 0.09, 0.46, 0.10, 0.14, 0.08) < 1
        ) {
          hu = 41 + n * 2.5;
        }
        if (
          ellipsoid(fx, fy, fz, 0.13, 0.16, 0.44, 0.075, 0.105, 0.07) < 1 ||
          ellipsoid(fx, fy, fz, -0.13, 0.16, 0.44, 0.075, 0.105, 0.07) < 1
        ) {
          hu = 36 + n * 2.5;
        }

        // Brainstem & cerebellum
        if (fz < 0.28 && ellipsoid(fx, fy, fz, 0, 0.10, 0.14, 0.13, 0.13, 0.14) < 1) {
          hu = 33 + n * 2.5;
        }
        if (fz < 0.25 && fy > 0.28 && d < 0.87) {
          hu = 34 + 5 * Math.sin(fz * 340 + fy * 22) + n * 2.5;
        }

        // Falx cerebri & pineal / choroid calcifications
        if (Math.abs(fx) < 0.009 && fy < 0.26 && fz > 0.56 && d < 0.88) hu = 58;
        if (ellipsoid(fx, fy, fz, 0, 0.30, 0.52, 0.026, 0.026, 0.02) < 1) hu = 340;
        if (
          ellipsoid(fx, fy, fz, 0.17, 0.26, 0.52, 0.028, 0.048, 0.024) < 1 ||
          ellipsoid(fx, fy, fz, -0.17, 0.26, 0.52, 0.028, 0.048, 0.024) < 1
        ) {
          hu = 225;
        }

        // Circle of Willis + MCA branches (CTA visibility)
        if (fz > 0.26 && fz < 0.36) {
          const dBasilar = distToSegment2D(fx, fy, 0, 0.14, 0, -0.04);
          const dMcaR = distToSegment2D(fx, fy, -0.04, -0.04, -0.34, -0.10);
          const dMcaL = distToSegment2D(fx, fy, 0.04, -0.04, 0.34, -0.10);
          const dAcaR = distToSegment2D(fx, fy, -0.03, -0.04, -0.02, -0.26);
          const dAcaL = distToSegment2D(fx, fy, 0.03, -0.04, 0.02, -0.26);
          const minV = Math.min(dBasilar, dMcaR, dMcaL, dAcaR, dAcaL);
          if (minV < 0.024 && Math.abs(fz - 0.305) < 0.022) {
            hu = 260 + n * 12;
          }
        }

        // Orbits, globes, lenses
        const orbL = ellipsoid(fx, fy, fz, 0.35, -0.60, 0.17, 0.155, 0.165, 0.10);
        const orbR = ellipsoid(fx, fy, fz, -0.35, -0.60, 0.17, 0.155, 0.165, 0.10);
        if (orbL < 1 || orbR < 1) {
          const sx = fx > 0 ? 0.35 : -0.35;
          const eye = ellipsoid(fx, fy, fz, sx, -0.66, 0.17, 0.088, 0.088, 0.062);
          const lens = ellipsoid(fx, fy, fz, sx, -0.73, 0.17, 0.035, 0.02, 0.025);
          hu = lens < 1 ? 68 : eye < 1 ? 22 + n * 2 : -68 + n * 7;
        }

        // Paranasal sinuses & nasal cavity
        if (
          ellipsoid(fx, fy, fz, 0.26, -0.58, 0.075, 0.11, 0.13, 0.055) < 1 ||
          ellipsoid(fx, fy, fz, -0.26, -0.58, 0.075, 0.11, 0.13, 0.055) < 1 ||
          ellipsoid(fx, fy, fz, 0, -0.80, 0.35, 0.16, 0.06, 0.055) < 1 ||
          ellipsoid(fx, fy, fz, 0, -0.28, 0.16, 0.10, 0.10, 0.06) < 1
        ) {
          hu = -950 + n * 15;
        }
        if (Math.abs(fx) < 0.10 && fy < -0.62 && fy > -0.86 && fz > 0.04 && fz < 0.30) {
          hu = Math.abs(fx) < 0.02 ? 48 : -880 + n * 40;
        }
        if (fz < 0.075 && d > 0.50 && d <= 1.0 && Math.abs(Math.sin(fx * 16 + fy * 9)) > 0.32) {
          hu = 760 + n * 55;
        }

        data[(z * ny + y) * nx + x] = hu;
        if (hu < huMin) huMin = hu;
        if (hu > huMax) huMax = hu;
      }
    }
  }

  return {
    id: 'phantom-craneo',
    nx, ny, nz, spx, spy, spz, data, huMin, huMax,
    meta: {
      patient: 'Fantoma Clínico · Neuro',
      patientId: 'PHM-NEURO-01',
      study: 'TC Cráneo + Polígono Willis',
      studyDate: '2026-11-24',
      series: 'Axial helicoidal 1.85 mm',
      modality: 'CT',
      institution: 'Laboratorio de Simulación',
      manufacturer: 'Sintético Matemático',
      kvp: '120 kVp',
      tubeCurrent: '240 mA',
      isSynthetic: true,
      phantomId: 'craneo',
      defaultWW: 80,
      defaultWL: 40
    },
    tags: buildPhantomTags('Fantoma Clínico · Neuro', 'TC Cráneo + Polígono Willis', 'Axial 1.85 mm', nx, ny, spx, spy, spz, 80, 40)
  };
}

function generateThoraxPhantom(): VolumeData {
  const nx = 144, ny = 144, nz = 112;
  const spx = 2.1, spy = 2.1, spz = 2.2;
  const data = new Float32Array(nx * ny * nz);
  const cx = (nx - 1) / 2, cy = (ny - 1) / 2;
  let huMin = Infinity, huMax = -Infinity;

  for (let z = 0; z < nz; z++) {
    const fz = z / (nz - 1);
    const taper = 0.86 + 0.16 * Math.sin(fz * Math.PI);
    const rx = 0.88 * taper;
    const ry = 0.68 * taper;

    for (let y = 0; y < ny; y++) {
      const fy = (y - cy) / (ny / 2);
      for (let x = 0; x < nx; x++) {
        const fx = (x - cx) / (nx / 2);
        const d = Math.sqrt((fx / rx) ** 2 + (fy / ry) ** 2);
        const n = hashNoise(x, y, z);
        let hu: number;

        if (d > 1.08) {
          hu = -1000 + n * 10;
        } else if (d > 0.99) {
          hu = -95 + n * 10; // subcutaneous fat
        } else if (d > 0.84) {
          hu = 46 + n * 5; // thoracic wall muscle
        } else {
          hu = 32 + n * 4; // mediastinum baseline
        }

        // Rib cage (10 helical rib pairs)
        if (d > 0.81 && d < 0.895 && Math.abs(fx) > 0.14) {
          const ribWave = Math.sin((fz * 10.5 + fy * 0.65) * Math.PI * 2);
          if (ribWave > 0.42) {
            hu = 780 + 180 * ribWave + n * 40;
          }
        }

        // Sternum (anterior midline)
        if (Math.abs(fx) < 0.08 && fy < -0.58 && fy > -0.68 && fz > 0.18 && fz < 0.88) {
          hu = 690 + n * 35;
        }

        // Thoracic spine (vertebral body + canal + spinous process)
        const dVert = Math.hypot(fx, fy - 0.50);
        if (dVert < 0.13) {
          const seg = Math.abs(Math.sin(fz * 12 * Math.PI));
          hu = seg > 0.18 ? 620 + n * 40 : 75; // bone vs intervertebral disc
        }
        if (Math.hypot(fx, fy - 0.62) < 0.055) hu = 25; // spinal canal
        if (Math.abs(fx) < 0.035 && fy >= 0.65 && fy < 0.80 && Math.abs(Math.sin(fz * 12 * Math.PI)) > 0.25) {
          hu = 740 + n * 35; // spinous process
        }

        // Bilateral lungs (aerated parenchyma -780 HU + vascular branching)
        const lungR = ellipsoid(fx, fy, fz, -0.40, 0.02, 0.50, 0.34, 0.48, 0.42);
        const lungL = ellipsoid(fx, fy, fz, 0.42, 0.02, 0.50, 0.32, 0.48, 0.42);
        if ((lungR < 1 || lungL < 1) && d < 0.82) {
          // Heart indentation on left lung
          const heartDist = ellipsoid(fx, fy, fz, 0.12, -0.18, 0.36, 0.28, 0.25, 0.22);
          if (heartDist >= 1) {
            hu = -785 + n * 28;
            // Pulmonary arborization
            const hilumX = fx < 0 ? -0.16 : 0.18;
            const dHilum = Math.sqrt((fx - hilumX) ** 2 + (fy + 0.02) ** 2 + (fz - 0.54) ** 2);
            const branch = Math.sin(Math.atan2(fy, fx - hilumX) * 8 + dHilum * 22) *
              Math.cos(fz * 28 + fx * 18);
            if (branch > 0.72 && dHilum < 0.42) {
              hu = -120 + 260 * (1 - dHilum * 1.8) + n * 20;
            }
          }
        }

        // Heart chambers & contrast-enhanced Aorta
        const heart = ellipsoid(fx, fy, fz, 0.11, -0.18, 0.36, 0.26, 0.23, 0.20);
        if (heart < 1) {
          hu = heart < 0.65 ? 165 + n * 10 : 48 + n * 4;
        }

        // Descending aorta + aortic arch
        if (Math.hypot(fx - 0.12, fy - 0.26) < 0.068 && fz < 0.76) {
          hu = 310 + n * 12;
        }
        if (fz >= 0.68 && fz < 0.80 && ellipsoid(fx, fy, fz, 0.06, -0.02, 0.74, 0.10, 0.28, 0.06) < 1) {
          hu = 320 + n * 12;
        }

        // Trachea & mainstem bronchi (airway -960 HU)
        if (fz > 0.60 && Math.hypot(fx, fy + 0.02) < 0.052) {
          hu = -965 + n * 10;
        }
        if (fz > 0.44 && fz <= 0.62) {
          const t = (0.62 - fz) / 0.18;
          if (Math.hypot(fx - t * 0.20, fy + 0.02) < 0.038 || Math.hypot(fx + t * 0.20, fy + 0.02) < 0.038) {
            hu = -960 + n * 10;
          }
        }

        data[(z * ny + y) * nx + x] = hu;
        if (hu < huMin) huMin = hu;
        if (hu > huMax) huMax = hu;
      }
    }
  }

  return {
    id: 'phantom-torax',
    nx, ny, nz, spx, spy, spz, data, huMin, huMax,
    meta: {
      patient: 'Fantoma Clínico · Tórax',
      patientId: 'PHM-THORAX-02',
      study: 'AngioTC Tórax + Vías Aéreas',
      studyDate: '2026-11-24',
      series: 'Pulmón / Mediastino 2.2 mm',
      modality: 'CT',
      institution: 'Laboratorio de Simulación',
      manufacturer: 'Sintético Matemático',
      kvp: '120 kVp',
      tubeCurrent: '280 mA',
      isSynthetic: true,
      phantomId: 'torax',
      defaultWW: 1500,
      defaultWL: -600
    },
    tags: buildPhantomTags('Fantoma Clínico · Tórax', 'AngioTC Tórax + Vías Aéreas', 'Pulmón 2.2 mm', nx, ny, spx, spy, spz, 1500, -600)
  };
}

function generateAbdomenPhantom(): VolumeData {
  const nx = 144, ny = 144, nz = 104;
  const spx = 2.1, spy = 2.1, spz = 2.4;
  const data = new Float32Array(nx * ny * nz);
  const cx = (nx - 1) / 2, cy = (ny - 1) / 2;
  let huMin = Infinity, huMax = -Infinity;

  for (let z = 0; z < nz; z++) {
    const fz = z / (nz - 1);
    const rx = 0.88;
    const ry = 0.72;

    for (let y = 0; y < ny; y++) {
      const fy = (y - cy) / (ny / 2);
      for (let x = 0; x < nx; x++) {
        const fx = (x - cx) / (nx / 2);
        const d = Math.sqrt((fx / rx) ** 2 + (fy / ry) ** 2);
        const n = hashNoise(x, y, z);
        let hu: number;

        if (d > 1.07) {
          hu = -1000 + n * 10;
        } else if (d > 0.96) {
          hu = -95 + n * 10; // subcutaneous fat
        } else if (d > 0.87) {
          hu = 48 + n * 5; // abdominal wall muscle
        } else {
          hu = -72 + n * 12; // visceral fat
        }

        // Lumbar spine L1-L5
        if (Math.hypot(fx, fy - 0.40) < 0.14) {
          const seg = Math.abs(Math.sin(fz * 8 * Math.PI));
          hu = seg > 0.2 ? 610 + n * 40 : 70;
        }
        if (Math.hypot(fx, fy - 0.54) < 0.05) hu = 25;
        if (Math.abs(fx) < 0.035 && fy >= 0.57 && fy < 0.72 && Math.abs(Math.sin(fz * 8 * Math.PI)) > 0.25) {
          hu = 720 + n * 35;
        }

        // Lower ribs (upper abdomen)
        if (fz > 0.65 && d > 0.83 && d < 0.89 && Math.abs(fx) > 0.25) {
          if (Math.sin((fz * 9 + fy * 0.5) * Math.PI * 2) > 0.45) {
            hu = 820 + n * 35;
          }
        }

        // Liver (right upper quadrant = fx < 0 in radiological view)
        const liver = ellipsoid(fx, fy, fz, -0.34, -0.10, 0.70, 0.42, 0.36, 0.25);
        if (liver < 1 && d < 0.86) {
          hu = 105 + n * 6;
          if (Math.hypot(fx + 0.26, fy + 0.08) < 0.045 && Math.abs(fz - 0.68) < 0.06) {
            hu = 210 + n * 10; // portal vein
          }
        }

        // Spleen (left upper quadrant = fx > 0)
        if (ellipsoid(fx, fy, fz, 0.50, 0.12, 0.70, 0.20, 0.24, 0.17) < 1 && d < 0.86) {
          hu = 115 + n * 6;
        }

        // Bilateral Kidneys (cortex + medulla + contrast collecting system)
        const kidR = ellipsoid(fx, fy, fz, -0.35, 0.26, 0.46, 0.16, 0.13, 0.18);
        const kidL = ellipsoid(fx, fy, fz, 0.36, 0.25, 0.50, 0.16, 0.13, 0.18);
        if (kidR < 1 || kidL < 1) {
          const core = Math.min(kidR, kidL);
          hu = core > 0.45 ? 185 + n * 10 : core > 0.18 ? 90 + n * 6 : 360 + n * 20;
        }

        // Abdominal Aorta + Iliac bifurcation (CTA contrast)
        if (fz > 0.28) {
          if (Math.hypot(fx - 0.04, fy - 0.18) < 0.056) {
            hu = 340 + n * 12;
          }
          // Renal arteries
          if (Math.abs(fz - 0.48) < 0.025 && fy > 0.14 && fy < 0.25 && Math.abs(fx) < 0.28) {
            hu = 310 + n * 12;
          }
        } else {
          const t = (0.28 - fz) / 0.28;
          if (
            Math.hypot(fx - (0.04 + t * 0.20), fy - 0.18) < 0.042 ||
            Math.hypot(fx - (0.04 - t * 0.20), fy - 0.18) < 0.042
          ) {
            hu = 330 + n * 12;
          }
        }

        // IVC
        if (Math.hypot(fx + 0.10, fy - 0.16) < 0.055) {
          hu = 145 + n * 8;
        }

        // Bowel loops with air-fluid contrast
        if (
          ellipsoid(fx, fy, fz, 0.15, -0.28, 0.35, 0.22, 0.18, 0.16) < 1 ||
          ellipsoid(fx, fy, fz, -0.18, -0.32, 0.25, 0.20, 0.16, 0.15) < 1
        ) {
          hu = Math.sin(fx * 20 + fy * 20 + fz * 16) > 0.35 ? -680 + n * 40 : 25 + n * 6;
        }

        data[(z * ny + y) * nx + x] = hu;
        if (hu < huMin) huMin = hu;
        if (hu > huMax) huMax = hu;
      }
    }
  }

  return {
    id: 'phantom-abdomen',
    nx, ny, nz, spx, spy, spz, data, huMin, huMax,
    meta: {
      patient: 'Fantoma Clínico · Abdomen',
      patientId: 'PHM-ABDO-03',
      study: 'AngioTC Abdomen Multifásico',
      studyDate: '2026-11-24',
      series: 'Fase Arterial-Portal 2.4 mm',
      modality: 'CT',
      institution: 'Laboratorio de Simulación',
      manufacturer: 'Sintético Matemático',
      kvp: '120 kVp',
      tubeCurrent: '310 mA',
      isSynthetic: true,
      phantomId: 'abdomen',
      defaultWW: 400,
      defaultWL: 60
    },
    tags: buildPhantomTags('Fantoma Clínico · Abdomen', 'AngioTC Abdomen Multifásico', 'Portal 2.4 mm', nx, ny, spx, spy, spz, 400, 60)
  };
}
