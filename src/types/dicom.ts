export type Plane2D = 'axial' | 'coronal' | 'sagital';
export type ViewName = Plane2D | 'volume';

export type ToolMode =
  | 'explore'
  | 'window'
  | 'measure'
  | 'angle'
  | 'roi'
  | 'probe'
  | 'pan'
  | 'zoom';

export type MprProjectionMode = 'thin' | 'mip' | 'minip' | 'avg';
export type ColorMapId = 'gray' | 'hot' | 'viridis' | 'cardiac' | 'pet';

export type RenderMode3D = 'vr' | 'mip' | 'minip' | 'drr' | 'surface';
export type TransferPreset3DId =
  | 'bone'
  | 'angio'
  | 'viscera'
  | 'kidney'
  | 'gi'
  | 'soft'
  | 'airways'
  | 'lung'
  | 'manual';

export type LayoutMode =
  | 'quad'
  | 'threePlusOne'
  | 'mprStrip'
  | 'axial'
  | 'coronal'
  | 'sagital'
  | 'volume';

export interface DicomTagEntry {
  tag: string;
  vr: string;
  name: string;
  value: string;
}

export interface StudyMeta {
  patient: string;
  patientId: string;
  study: string;
  studyDate: string;
  series: string;
  modality: string;
  institution: string;
  manufacturer: string;
  kvp: string;
  tubeCurrent: string;
  isSynthetic: boolean;
  phantomId?: 'craneo' | 'torax' | 'abdomen';
  defaultWW?: number;
  defaultWL?: number;
}

export interface VolumeData {
  id: string;
  nx: number;
  ny: number;
  nz: number;
  spx: number;
  spy: number;
  spz: number;
  data: Float32Array;
  huMin: number;
  huMax: number;
  meta: StudyMeta;
  tags: DicomTagEntry[];
}

export interface LoadedSeries {
  seriesUid: string;
  seriesNumber: number;
  seriesDesc: string;
  modality: string;
  sliceCount: number;
  rows: number;
  cols: number;
  volume: VolumeData;
}

export interface Viewport2DTransformState {
  zoom: number;
  panX: number;
  panY: number;
  flipH: boolean;
  flipV: boolean;
  rot90: number; // 0, 1, 2, 3 (multiples of 90 deg)
}

export interface LengthMeasurement {
  id: number;
  view: Plane2D;
  slice: number;
  u1: number;
  v1: number;
  u2: number;
  v2: number;
  mm: number;
}

export interface AngleMeasurement {
  id: number;
  view: Plane2D;
  slice: number;
  u1: number;
  v1: number;
  u2: number; // vertex
  v2: number;
  u3: number;
  v3: number;
  deg: number;
}

export interface RoiMeasurement {
  id: number;
  view: Plane2D;
  slice: number;
  shape: 'rect' | 'ellipse';
  u1: number;
  v1: number;
  u2: number;
  v2: number;
  mean: number;
  stdDev: number;
  min: number;
  max: number;
  count: number;
  areaMm: number;
}

export interface HuProbe {
  id: number;
  view: Plane2D;
  slice: number;
  u: number;
  v: number;
  x: number;
  y: number;
  z: number;
  hu: number;
}

export interface ClipBox {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  zMin: number;
  zMax: number;
}

export interface Camera3DState {
  yaw: number;
  pitch: number;
  dist: number;
}

export interface Settings3D {
  renderMode: RenderMode3D;
  preset: TransferPreset3DId;
  thresholdHU: number;
  opacity: number;
  shading: number;
  brightness: number;
  edgeBoost: number;
  contrastScale: number;
  showCrosshairs: boolean;
  showClipBox: boolean;
  autoSpin: boolean;
  highQuality: boolean;
  bgMode: 'black' | 'navy' | 'white';
}
