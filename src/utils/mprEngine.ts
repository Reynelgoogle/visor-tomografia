import type {
  MprProjectionMode,
  Plane2D,
  RoiMeasurement,
  VolumeData
} from '../types/dicom';

export interface PlaneDims {
  w: number;
  h: number;
  axis: 'x' | 'y' | 'z';
  maxSlice: number;
  su: number;
  sv: number;
  sliceSpacing: number;
}

export function getPlaneDims(vol: VolumeData, plane: Plane2D): PlaneDims {
  if (plane === 'axial') {
    return {
      w: vol.nx,
      h: vol.ny,
      axis: 'z',
      maxSlice: vol.nz - 1,
      su: vol.spx,
      sv: vol.spy,
      sliceSpacing: vol.spz
    };
  }
  if (plane === 'coronal') {
    return {
      w: vol.nx,
      h: vol.nz,
      axis: 'y',
      maxSlice: vol.ny - 1,
      su: vol.spx,
      sv: vol.spz,
      sliceSpacing: vol.spy
    };
  }
  return {
    w: vol.ny,
    h: vol.nz,
    axis: 'x',
    maxSlice: vol.nx - 1,
    su: vol.spy,
    sv: vol.spz,
    sliceSpacing: vol.spx
  };
}

export function sampleVoxel(vol: VolumeData, x: number, y: number, z: number): number {
  const cx = x < 0 ? 0 : x >= vol.nx ? vol.nx - 1 : x | 0;
  const cy = y < 0 ? 0 : y >= vol.ny ? vol.ny - 1 : y | 0;
  const cz = z < 0 ? 0 : z >= vol.nz ? vol.nz - 1 : z | 0;
  return vol.data[(cz * vol.ny + cy) * vol.nx + cx];
}

export function sampleTrilinear(vol: VolumeData, x: number, y: number, z: number): number {
  if (x < 0 || x > vol.nx - 1 || y < 0 || y > vol.ny - 1 || z < 0 || z > vol.nz - 1) {
    return -1000;
  }
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const x1 = Math.min(vol.nx - 1, x0 + 1);
  const y1 = Math.min(vol.ny - 1, y0 + 1);
  const z1 = Math.min(vol.nz - 1, z0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const fz = z - z0;
  const nx = vol.nx;
  const nxy = nx * vol.ny;
  const d = vol.data;

  const c000 = d[z0 * nxy + y0 * nx + x0];
  const c100 = d[z0 * nxy + y0 * nx + x1];
  const c010 = d[z0 * nxy + y1 * nx + x0];
  const c110 = d[z0 * nxy + y1 * nx + x1];
  const c001 = d[z1 * nxy + y0 * nx + x0];
  const c101 = d[z1 * nxy + y0 * nx + x1];
  const c011 = d[z1 * nxy + y1 * nx + x0];
  const c111 = d[z1 * nxy + y1 * nx + x1];

  const c00 = c000 + (c100 - c000) * fx;
  const c10 = c010 + (c110 - c010) * fx;
  const c01 = c001 + (c101 - c001) * fx;
  const c11 = c011 + (c111 - c011) * fx;
  const c0 = c00 + (c10 - c00) * fy;
  const c1 = c01 + (c11 - c01) * fy;
  return c0 + (c1 - c0) * fz;
}

export function getPlaneCrossUV(
  vol: VolumeData,
  plane: Plane2D,
  pos: { x: number; y: number; z: number }
): { u: number; v: number } {
  if (plane === 'axial') return { u: pos.x, v: pos.y };
  if (plane === 'coronal') return { u: pos.x, v: vol.nz - 1 - pos.z };
  return { u: pos.y, v: vol.nz - 1 - pos.z };
}

export function uvToVoxel(
  vol: VolumeData,
  plane: Plane2D,
  u: number,
  v: number,
  pos: { x: number; y: number; z: number }
): { x: number; y: number; z: number } {
  if (plane === 'axial') {
    return {
      x: Math.max(0, Math.min(vol.nx - 1, Math.round(u))),
      y: Math.max(0, Math.min(vol.ny - 1, Math.round(v))),
      z: pos.z
    };
  }
  if (plane === 'coronal') {
    return {
      x: Math.max(0, Math.min(vol.nx - 1, Math.round(u))),
      y: pos.y,
      z: Math.max(0, Math.min(vol.nz - 1, Math.round(vol.nz - 1 - v)))
    };
  }
  return {
    x: pos.x,
    y: Math.max(0, Math.min(vol.ny - 1, Math.round(u))),
    z: Math.max(0, Math.min(vol.nz - 1, Math.round(vol.nz - 1 - v)))
  };
}

/**
 * Extracts a 2D HU buffer for the given plane, supporting:
 * - Thin slice (with optional oblique tilt around cursor)
 * - Thick-slab MIP, MinIP, AvgIP across slabThicknessMm
 */
export function extractMprSliceHU(
  vol: VolumeData,
  plane: Plane2D,
  pos: { x: number; y: number; z: number },
  projMode: MprProjectionMode,
  slabMm: number,
  obliqueDeg: number,
  outBuffer?: Float32Array
): Float32Array {
  const dims = getPlaneDims(vol, plane);
  const total = dims.w * dims.h;
  const out = outBuffer && outBuffer.length === total ? outBuffer : new Float32Array(total);
  const { nx, ny, nz, data } = vol;
  const nxy = nx * ny;

  const halfSlices =
    projMode === 'thin' ? 0 : Math.max(0, Math.round(slabMm / dims.sliceSpacing / 2));

  const angleRad = (obliqueDeg * Math.PI) / 180;
  const hasOblique = Math.abs(angleRad) > 0.002;

  if (!hasOblique) {
    if (plane === 'axial') {
      const z0 = Math.max(0, pos.z - halfSlices);
      const z1 = Math.min(nz - 1, pos.z + halfSlices);
      if (z0 === z1 || projMode === 'thin') {
        const off = pos.z * nxy;
        out.set(data.subarray(off, off + nxy));
        return out;
      }
      const count = z1 - z0 + 1;
      for (let i = 0; i < nxy; i++) {
        let acc = projMode === 'mip' ? -Infinity : projMode === 'minip' ? Infinity : 0;
        for (let z = z0; z <= z1; z++) {
          const val = data[z * nxy + i];
          if (projMode === 'mip') {
            if (val > acc) acc = val;
          } else if (projMode === 'minip') {
            if (val < acc) acc = val;
          } else {
            acc += val;
          }
        }
        out[i] = projMode === 'avg' ? acc / count : acc;
      }
      return out;
    }

    if (plane === 'coronal') {
      const y0 = Math.max(0, pos.y - halfSlices);
      const y1 = Math.min(ny - 1, pos.y + halfSlices);
      const count = y1 - y0 + 1;
      for (let v = 0; v < nz; v++) {
        const z = nz - 1 - v;
        const zBase = z * nxy;
        const rowOff = v * nx;
        for (let u = 0; u < nx; u++) {
          if (count === 1 || projMode === 'thin') {
            out[rowOff + u] = data[zBase + pos.y * nx + u];
          } else {
            let acc = projMode === 'mip' ? -Infinity : projMode === 'minip' ? Infinity : 0;
            for (let y = y0; y <= y1; y++) {
              const val = data[zBase + y * nx + u];
              if (projMode === 'mip') {
                if (val > acc) acc = val;
              } else if (projMode === 'minip') {
                if (val < acc) acc = val;
              } else {
                acc += val;
              }
            }
            out[rowOff + u] = projMode === 'avg' ? acc / count : acc;
          }
        }
      }
      return out;
    }

    // Sagittal
    const x0 = Math.max(0, pos.x - halfSlices);
    const x1 = Math.min(nx - 1, pos.x + halfSlices);
    const count = x1 - x0 + 1;
    for (let v = 0; v < nz; v++) {
      const z = nz - 1 - v;
      const zBase = z * nxy;
      const rowOff = v * ny;
      for (let u = 0; u < ny; u++) {
        const yBase = zBase + u * nx;
        if (count === 1 || projMode === 'thin') {
          out[rowOff + u] = data[yBase + pos.x];
        } else {
          let acc = projMode === 'mip' ? -Infinity : projMode === 'minip' ? Infinity : 0;
          for (let x = x0; x <= x1; x++) {
            const val = data[yBase + x];
            if (projMode === 'mip') {
              if (val > acc) acc = val;
            } else if (projMode === 'minip') {
              if (val < acc) acc = val;
            } else {
              acc += val;
            }
          }
          out[rowOff + u] = projMode === 'avg' ? acc / count : acc;
        }
      }
    }
    return out;
  }

  // Oblique MPR resampling rotated around the active cursor in mm space
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);
  const cXmm = pos.x * vol.spx;
  const cYmm = pos.y * vol.spy;
  const cZmm = pos.z * vol.spz;
  const cross = getPlaneCrossUV(vol, plane, pos);
  const slabSteps = projMode === 'thin' ? 0 : halfSlices;
  const stepCount = slabSteps * 2 + 1;

  for (let v = 0; v < dims.h; v++) {
    const dvMm = (v - cross.v) * dims.sv;
    const rowOff = v * dims.w;
    for (let u = 0; u < dims.w; u++) {
      const duMm = (u - cross.u) * dims.su;
      let acc = projMode === 'mip' ? -Infinity : projMode === 'minip' ? Infinity : 0;

      for (let s = -slabSteps; s <= slabSteps; s++) {
        const dnMm = s * dims.sliceSpacing;
        let xMm = cXmm;
        let yMm = cYmm;
        let zMm = cZmm;

        if (plane === 'axial') {
          // Tilt axial plane around Y axis (pitch/roll)
          xMm += duMm * cosA - dnMm * sinA;
          yMm += dvMm;
          zMm += duMm * sinA + dnMm * cosA;
        } else if (plane === 'coronal') {
          // Tilt coronal plane around Z axis
          xMm += duMm * cosA - dnMm * sinA;
          yMm += duMm * sinA + dnMm * cosA;
          zMm -= dvMm;
        } else {
          // Tilt sagittal plane around Z axis
          xMm += dnMm * cosA - duMm * sinA;
          yMm += duMm * cosA + dnMm * sinA;
          zMm -= dvMm;
        }

        const val = sampleTrilinear(vol, xMm / vol.spx, yMm / vol.spy, zMm / vol.spz);
        if (projMode === 'thin') {
          acc = val;
        } else if (projMode === 'mip') {
          if (val > acc) acc = val;
        } else if (projMode === 'minip') {
          if (val < acc) acc = val;
        } else {
          acc += val;
        }
      }
      out[rowOff + u] = projMode === 'avg' ? acc / stepCount : acc;
    }
  }

  return out;
}

export function computeRoiStats(
  sliceHU: Float32Array,
  vol: VolumeData,
  plane: Plane2D,
  sliceIdx: number,
  id: number,
  shape: 'rect' | 'ellipse',
  u1Raw: number,
  v1Raw: number,
  u2Raw: number,
  v2Raw: number
): RoiMeasurement {
  const dims = getPlaneDims(vol, plane);
  const u1 = Math.max(0, Math.floor(Math.min(u1Raw, u2Raw)));
  const u2 = Math.min(dims.w - 1, Math.ceil(Math.max(u1Raw, u2Raw)));
  const v1 = Math.max(0, Math.floor(Math.min(v1Raw, v2Raw)));
  const v2 = Math.min(dims.h - 1, Math.ceil(Math.max(v1Raw, v2Raw)));

  const cu = (u1 + u2) / 2;
  const cv = (v1 + v2) / 2;
  const ru = Math.max(0.5, (u2 - u1) / 2);
  const rv = Math.max(0.5, (v2 - v1) / 2);

  let sum = 0;
  let sumSq = 0;
  let min = Infinity;
  let max = -Infinity;
  let count = 0;

  for (let v = v1; v <= v2; v++) {
    for (let u = u1; u <= u2; u++) {
      if (shape === 'ellipse') {
        const nx = (u - cu) / ru;
        const ny = (v - cv) / rv;
        if (nx * nx + ny * ny > 1) continue;
      }
      const hu = sliceHU[v * dims.w + u];
      sum += hu;
      sumSq += hu * hu;
      if (hu < min) min = hu;
      if (hu > max) max = hu;
      count++;
    }
  }

  const mean = count > 0 ? sum / count : 0;
  const variance = count > 0 ? Math.max(0, sumSq / count - mean * mean) : 0;
  const stdDev = Math.sqrt(variance);

  return {
    id,
    view: plane,
    slice: sliceIdx,
    shape,
    u1,
    v1,
    u2,
    v2,
    mean,
    stdDev,
    min: Number.isFinite(min) ? min : 0,
    max: Number.isFinite(max) ? max : 0,
    count,
    areaMm: count * dims.su * dims.sv
  };
}
