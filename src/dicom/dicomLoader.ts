import dicomParser from 'dicom-parser';
import { Decoder as JpegLosslessDecoder } from 'jpeg-lossless-decoder-js';
import JSZip from 'jszip';
import type { DicomTagEntry, LoadedSeries, VolumeData } from '../types/dicom';
import { DICOM_TAG_NAMES, formatDicomTag } from './dicomTags';

interface ParsedFrameSlice {
  data: Float32Array;
  ipp: number[];
  iop: number[];
  instance: number | null;
  sliceLocation: number | null;
  pixelSpacing: number[];
  sliceThickness: number | null;
  spacingBetween: number | null;
  windowCenter: number | null;
  windowWidth: number | null;
  rows: number;
  cols: number;
  seriesUid: string;
  seriesNumber: number;
  seriesDesc: string;
  modality: string;
  patient: string;
  patientId: string;
  studyDesc: string;
  studyDate: string;
  institution: string;
  manufacturer: string;
  kvp: string;
  tubeCurrent: string;
  tags: DicomTagEntry[];
}

export interface DicomLoadProgress {
  phase: 'reading' | 'extracting' | 'parsing' | 'reconstructing';
  current: number;
  total: number;
  message: string;
}

export interface DicomLoadResult {
  series: LoadedSeries[];
  warnings: string[];
  fileCount: number;
}

function parseMultiFloat(str?: string): number[] {
  if (!str) return [];
  return str
    .split('\\')
    .map((s) => parseFloat(s.trim()))
    .filter((n) => Number.isFinite(n));
}

function parseFirstFloat(str?: string): number | null {
  const arr = parseMultiFloat(str);
  return arr.length > 0 ? arr[0] : null;
}

function formatDicomDate(raw?: string): string {
  if (!raw) return '—';
  const clean = raw.trim();
  if (/^\d{8}$/.test(clean)) {
    return `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}`;
  }
  return clean;
}

/**
 * Decode DICOM RLE Lossless (Transfer Syntax 1.2.840.10008.1.2.5)
 * Implements DICOM PS3.5 Annex G PackBits RLE decoding.
 */
function decodeRLEFrame(
  compressed: Uint8Array,
  rows: number,
  cols: number,
  bitsAllocated: number
): Uint8Array {
  if (compressed.byteLength < 64) {
    throw new Error('Cabecera RLE incompleta');
  }
  const dv = new DataView(compressed.buffer, compressed.byteOffset, compressed.byteLength);
  const numSegments = dv.getUint32(0, true);
  const pixelCount = rows * cols;
  const bytesPerSample = bitsAllocated > 8 ? 2 : 1;
  if (numSegments < bytesPerSample || numSegments > 4) {
    throw new Error(`Número de segmentos RLE inválido (${numSegments})`);
  }

  const out = new Uint8Array(pixelCount * bytesPerSample);
  const offsets: number[] = [];
  for (let i = 0; i < numSegments; i++) {
    offsets.push(dv.getUint32(4 + i * 4, true));
  }

  for (let seg = 0; seg < bytesPerSample; seg++) {
    const start = offsets[seg];
    const end = seg + 1 < numSegments ? offsets[seg + 1] : compressed.byteLength;
    let src = start;
    let dst = 0;
    // In DICOM RLE for 16-bit pixels: Segment 0 is MSB, Segment 1 is LSB.
    // Little-endian target expects LSB at byte 0 and MSB at byte 1.
    const byteLane = bytesPerSample === 2 ? (seg === 0 ? 1 : 0) : 0;

    while (src < end && dst < pixelCount) {
      const header = dv.getInt8(src++);
      if (header >= 0) {
        const count = header + 1;
        for (let k = 0; k < count && src < end && dst < pixelCount; k++) {
          out[dst * bytesPerSample + byteLane] = compressed[src++];
          dst++;
        }
      } else if (header > -128) {
        const count = -header + 1;
        const val = src < end ? compressed[src++] : 0;
        for (let k = 0; k < count && dst < pixelCount; k++) {
          out[dst * bytesPerSample + byteLane] = val;
          dst++;
        }
      }
    }
  }
  return out;
}

/**
 * Decode JPEG Baseline / Extended (1.2.840.10008.1.2.4.50 / .51) via browser image decoder.
 */
async function decodeJpegBaselineFrame(
  compressed: Uint8Array,
  rows: number,
  cols: number
): Promise<Uint8Array> {
  const copy = new Uint8Array(compressed.byteLength);
  copy.set(compressed);
  const blob = new Blob([copy.buffer], { type: 'image/jpeg' });
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('No se pudo crear contexto 2D para decodificar JPEG');
  }
  ctx.drawImage(bitmap, 0, 0, cols, rows);
  bitmap.close();
  const img = ctx.getImageData(0, 0, cols, rows).data;
  const out = new Uint8Array(rows * cols);
  for (let i = 0; i < out.length; i++) {
    out[i] = img[i * 4];
  }
  return out;
}

/**
 * Decode JPEG Lossless (1.2.840.10008.1.2.4.57 / .70) via jpeg-lossless-decoder-js.
 */
function decodeJpegLosslessFrame(compressed: Uint8Array): Uint8Array {
  const decoder = new JpegLosslessDecoder();
  // Copy slice into exact ArrayBuffer range so offset=0 works cleanly on SharedArrayBuffer/subarray
  const sliceBuf = new ArrayBuffer(compressed.byteLength);
  new Uint8Array(sliceBuf).set(compressed);
  const decoded = decoder.decode(sliceBuf, 0, sliceBuf.byteLength);
  return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
}

function extractTagEntries(dataSet: dicomParser.DataSet): DicomTagEntry[] {
  const entries: DicomTagEntry[] = [];
  const keys = Object.keys(dataSet.elements).sort();
  for (const key of keys) {
    if (key === 'x7fe00010') continue; // skip pixel data payload
    const el = dataSet.elements[key];
    if (!el || el.length > 512) continue;
    let value = '';
    try {
      const vr = el.vr || '';
      if (vr === 'US' && el.length >= 2) {
        value = String(dataSet.uint16(key) ?? '');
      } else if (vr === 'SS' && el.length >= 2) {
        value = String(dataSet.int16(key) ?? '');
      } else if (vr === 'UL' && el.length >= 4) {
        value = String(dataSet.uint32(key) ?? '');
      } else if (!['OB', 'OW', 'OF', 'SQ', 'UN'].includes(vr)) {
        value = (dataSet.string(key) ?? '').replace(/[\0\s]+$/g, '');
      } else {
        value = `[${el.length} bytes]`;
      }
    } catch {
      value = '';
    }
    if (!value) continue;
    entries.push({
      tag: formatDicomTag(key),
      vr: el.vr || '—',
      name: DICOM_TAG_NAMES[key.toLowerCase()] || 'Private / Other Tag',
      value
    });
  }
  return entries;
}

function samplesToFloat32(
  rawBytes: Uint8Array,
  pixelCount: number,
  bitsAllocated: number,
  bitsStored: number,
  pixelRepresentation: number,
  slope: number,
  intercept: number,
  invertMonochrome1: boolean,
  isBigEndian: boolean
): Float32Array {
  const out = new Float32Array(pixelCount);
  const bpp = bitsAllocated > 8 ? 2 : 1;
  const maxStoredVal = (1 << bitsStored) - 1;

  if (bpp === 2) {
    const len = Math.min(pixelCount, rawBytes.byteLength >> 1);
    if (!isBigEndian && (rawBytes.byteOffset & 1) === 0) {
      const typed =
        pixelRepresentation === 1
          ? new Int16Array(rawBytes.buffer, rawBytes.byteOffset, len)
          : new Uint16Array(rawBytes.buffer, rawBytes.byteOffset, len);
      if (!invertMonochrome1 && slope === 1 && intercept === 0) {
        out.set(typed);
      } else if (!invertMonochrome1) {
        for (let i = 0; i < len; i++) {
          out[i] = typed[i] * slope + intercept;
        }
      } else {
        for (let i = 0; i < len; i++) {
          out[i] = (maxStoredVal - typed[i]) * slope + intercept;
        }
      }
      return out;
    }

    const dv = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
    for (let i = 0; i < len; i++) {
      let val =
        pixelRepresentation === 1
          ? dv.getInt16(i * 2, !isBigEndian)
          : dv.getUint16(i * 2, !isBigEndian);
      if (invertMonochrome1) {
        val = maxStoredVal - val;
      }
      out[i] = val * slope + intercept;
    }
  } else {
    const len = Math.min(pixelCount, rawBytes.byteLength);
    for (let i = 0; i < len; i++) {
      let val = rawBytes[i];
      if (pixelRepresentation === 1 && val >= 128) {
        val -= 256;
      }
      if (invertMonochrome1) {
        val = maxStoredVal - val;
      }
      out[i] = val * slope + intercept;
    }
  }
  return out;
}

async function parseSingleDicomBuffer(
  buffer: ArrayBuffer,
  collectTags: boolean
): Promise<ParsedFrameSlice[]> {
  const byteArray = new Uint8Array(buffer);
  if (byteArray.byteLength < 132) {
    throw new Error('Archivo demasiado pequeño para ser DICOM');
  }

  let dataSet: dicomParser.DataSet;
  try {
    dataSet = dicomParser.parseDicom(byteArray);
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : 'No es un archivo DICOM válido');
  }

  const pixelEl = dataSet.elements.x7fe00010;
  if (!pixelEl) {
    throw new Error('Sin Pixel Data (7FE0,0010)');
  }

  const rows = dataSet.uint16('x00280010') ?? 0;
  const cols = dataSet.uint16('x00280011') ?? 0;
  if (!rows || !cols) {
    throw new Error('Faltan dimensiones Rows/Columns');
  }

  const samplesPerPixel = dataSet.uint16('x00280002') ?? 1;
  if (samplesPerPixel !== 1) {
    throw new Error(`Imágenes RGB/color (SamplesPerPixel=${samplesPerPixel}) no soportadas en reconstrucción HU`);
  }

  const transferSyntax = (dataSet.string('x00020010') || '1.2.840.10008.1.2.1').trim();
  const isBigEndian = transferSyntax === '1.2.840.10008.1.2.2';
  const bitsAllocated = dataSet.uint16('x00280100') ?? 16;
  const bitsStored = dataSet.uint16('x00280101') ?? bitsAllocated;
  const pixelRepresentation = dataSet.uint16('x00280103') ?? 0;
  const photometric = (dataSet.string('x00280004') || 'MONOCHROME2').trim();
  const invertMono1 = photometric === 'MONOCHROME1';

  const slope = parseFirstFloat(dataSet.string('x00281053')) ?? 1;
  const intercept = parseFirstFloat(dataSet.string('x00281052')) ?? 0;
  const numFrames = Math.max(1, dataSet.intString('x00280008') ?? 1);

  const pixelCount = rows * cols;
  const bpp = bitsAllocated > 8 ? 2 : 1;
  const frameBytes = pixelCount * bpp;

  const ipp = parseMultiFloat(dataSet.string('x00200032'));
  const iop = parseMultiFloat(dataSet.string('x00200037'));
  const instanceRaw = dataSet.intString('x00200013');
  const instance = instanceRaw !== undefined && Number.isFinite(instanceRaw) ? instanceRaw : null;
  const sliceLocation = parseFirstFloat(dataSet.string('x00201041'));
  const pixelSpacing = parseMultiFloat(dataSet.string('x00280030'));
  const sliceThickness = parseFirstFloat(dataSet.string('x00180050'));
  const spacingBetween = parseFirstFloat(dataSet.string('x00180088'));
  const windowCenter = parseFirstFloat(dataSet.string('x00281050'));
  const windowWidth = parseFirstFloat(dataSet.string('x00281051'));

  const seriesUid = (dataSet.string('x0020000e') || 'default-series').trim();
  const seriesNumber = dataSet.intString('x00200011') ?? 1;
  const seriesDesc = (dataSet.string('x0008103e') || 'Serie DICOM').trim();
  const modality = (dataSet.string('x00080060') || 'CT').trim();
  const patient = (dataSet.string('x00100010') || 'Paciente anónimo').replace(/\^/g, ' ').trim();
  const patientId = (dataSet.string('x00100020') || '—').trim();
  const studyDesc = (dataSet.string('x00081030') || `${modality} · Estudio DICOM`).trim();
  const studyDate = formatDicomDate(dataSet.string('x00080020'));
  const institution = (dataSet.string('x00080080') || '—').trim();
  const manufacturer = (dataSet.string('x00080070') || '—').trim();
  const kvp = (dataSet.string('x00180060') || '').trim();
  const tubeCurrent = (dataSet.string('x00181151') || '').trim();
  const tags = collectTags ? extractTagEntries(dataSet) : [];

  const slices: ParsedFrameSlice[] = [];

  if (pixelEl.encapsulatedPixelData) {
    // Encapsulated (compressed) pixel data
    let basicOffsetTable = pixelEl.basicOffsetTable;
    if (!basicOffsetTable || basicOffsetTable.length === 0) {
      try {
        basicOffsetTable = dicomParser.createJPEGBasicOffsetTable(dataSet, pixelEl);
      } catch {
        basicOffsetTable = [];
      }
    }

    for (let f = 0; f < numFrames; f++) {
      let encodedFrame: Uint8Array;
      try {
        encodedFrame = dicomParser.readEncapsulatedImageFrame(
          dataSet,
          pixelEl,
          f,
          basicOffsetTable
        );
      } catch {
        if (f === 0 && pixelEl.items && pixelEl.items.length > 0) {
          encodedFrame = dicomParser.readEncapsulatedPixelDataFromFragments(
            dataSet,
            pixelEl,
            0,
            pixelEl.items.length
          );
        } else {
          throw new Error(`No se pudo leer el frame encapsulado #${f + 1}`);
        }
      }

      let rawBytes: Uint8Array;
      let decodedLittleEndian = true;
      let decodedBpp = bpp;

      if (transferSyntax === '1.2.840.10008.1.2.5') {
        rawBytes = decodeRLEFrame(encodedFrame, rows, cols, bitsAllocated);
      } else if (
        transferSyntax === '1.2.840.10008.1.2.4.70' ||
        transferSyntax === '1.2.840.10008.1.2.4.57'
      ) {
        rawBytes = decodeJpegLosslessFrame(encodedFrame);
        // Host endianness from Uint16/Int16 typed array returned by decoder
        decodedLittleEndian = true;
      } else if (
        transferSyntax === '1.2.840.10008.1.2.4.50' ||
        transferSyntax === '1.2.840.10008.1.2.4.51'
      ) {
        rawBytes = await decodeJpegBaselineFrame(encodedFrame, rows, cols);
        decodedBpp = 8;
      } else if (
        transferSyntax === '1.2.840.10008.1.2.4.90' ||
        transferSyntax === '1.2.840.10008.1.2.4.91'
      ) {
        throw new Error('JPEG 2000 (.90/.91) requiere decodificador OpenJPEG externo; exporta en JPEG Lossless, RLE o Uncompressed');
      } else {
        throw new Error(`Transfer Syntax comprimida (${transferSyntax}) no soportada`);
      }

      const data = samplesToFloat32(
        rawBytes,
        pixelCount,
        decodedBpp,
        bitsStored,
        pixelRepresentation,
        slope,
        intercept,
        invertMono1,
        !decodedLittleEndian
      );

      slices.push({
        data,
        ipp,
        iop,
        instance: instance !== null ? instance + f : f + 1,
        sliceLocation,
        pixelSpacing,
        sliceThickness,
        spacingBetween,
        windowCenter,
        windowWidth,
        rows,
        cols,
        seriesUid,
        seriesNumber,
        seriesDesc,
        modality,
        patient,
        patientId,
        studyDesc,
        studyDate,
        institution,
        manufacturer,
        kvp,
        tubeCurrent,
        tags
      });
    }
  } else {
    // Uncompressed Pixel Data
    const totalAvailable = Math.min(numFrames, Math.floor(pixelEl.length / frameBytes));
    if (totalAvailable < 1) {
      throw new Error('Pixel Data incompleto para las dimensiones especificadas');
    }

    for (let f = 0; f < totalAvailable; f++) {
      const start = pixelEl.dataOffset + f * frameBytes;
      const frameView = byteArray.subarray(start, start + frameBytes);
      const data = samplesToFloat32(
        frameView,
        pixelCount,
        bitsAllocated,
        bitsStored,
        pixelRepresentation,
        slope,
        intercept,
        invertMono1,
        isBigEndian
      );

      slices.push({
        data,
        ipp,
        iop,
        instance: instance !== null ? instance + f : f + 1,
        sliceLocation,
        pixelSpacing,
        sliceThickness,
        spacingBetween,
        windowCenter,
        windowWidth,
        rows,
        cols,
        seriesUid,
        seriesNumber,
        seriesDesc,
        modality,
        patient,
        patientId,
        studyDesc,
        studyDate,
        institution,
        manufacturer,
        kvp,
        tubeCurrent,
        tags
      });
    }
  }

  return slices;
}

function buildSeriesVolume(seriesUid: string, rawSlices: ParsedFrameSlice[], warnings: string[]): LoadedSeries | null {
  if (!rawSlices.length) return null;

  // Determine dominant rows x cols in case a scout/localizer slipped into same UID
  const dimCounts = new Map<string, number>();
  for (const s of rawSlices) {
    const key = `${s.cols}x${s.rows}`;
    dimCounts.set(key, (dimCounts.get(key) || 0) + 1);
  }
  let bestDim = '';
  let bestCount = 0;
  for (const [k, c] of dimCounts.entries()) {
    if (c > bestCount) {
      bestDim = k;
      bestCount = c;
    }
  }

  const slices = rawSlices.filter((s) => `${s.cols}x${s.rows}` === bestDim);
  if (slices.length < rawSlices.length) {
    warnings.push(
      `Serie ${rawSlices[0].seriesDesc}: se omitieron ${rawSlices.length - slices.length} corte(s) con matriz diferente.`
    );
  }

  const first = slices[0];
  const nx = first.cols;
  const ny = first.rows;
  const nz = slices.length;

  if (nx * ny * nz > 180_000_000) {
    warnings.push(`Serie ${first.seriesDesc} excede el límite de memoria del navegador (>180M vóxeles).`);
    return null;
  }

  // Sort by 3D ImagePositionPatient projected onto slice normal
  const iop = first.iop.length === 6 ? first.iop : [1, 0, 0, 0, 1, 0];
  const normal = [
    iop[1] * iop[5] - iop[2] * iop[4],
    iop[2] * iop[3] - iop[0] * iop[5],
    iop[0] * iop[4] - iop[1] * iop[3]
  ];

  const project = (s: ParsedFrameSlice): number | null => {
    if (s.ipp.length === 3) {
      return s.ipp[0] * normal[0] + s.ipp[1] * normal[1] + s.ipp[2] * normal[2];
    }
    return s.sliceLocation;
  };

  const allHaveProj = slices.length > 1 && slices.every((s) => project(s) !== null);
  if (allHaveProj) {
    slices.sort((a, b) => (project(a) as number) - (project(b) as number));
  } else if (slices.length > 1 && slices.every((s) => s.instance !== null)) {
    slices.sort((a, b) => (a.instance as number) - (b.instance as number));
  }

  const ps = first.pixelSpacing.length === 2 ? first.pixelSpacing : [1, 1];
  const spx = ps[1] > 0 ? ps[1] : 1;
  const spy = ps[0] > 0 ? ps[0] : 1;

  let spz = first.spacingBetween || first.sliceThickness || spy;
  if (allHaveProj && slices.length > 1) {
    const p0 = project(slices[0]) as number;
    const p1 = project(slices[slices.length - 1]) as number;
    const computed = Math.abs(p1 - p0) / (slices.length - 1);
    if (computed > 0.01) spz = computed;
  }
  if (!(spz > 0)) spz = spy;

  const volumeData = new Float32Array(nx * ny * nz);
  let huMin = Infinity;
  let huMax = -Infinity;

  for (let z = 0; z < nz; z++) {
    const src = slices[z].data;
    volumeData.set(src, z * nx * ny);
    for (let i = 0; i < src.length; i += 4) {
      const v = src[i];
      if (v < huMin) huMin = v;
      if (v > huMax) huMax = v;
    }
  }
  if (!Number.isFinite(huMin)) huMin = -1024;
  if (!Number.isFinite(huMax)) huMax = 1400;

  let defaultWW = first.windowWidth ?? undefined;
  let defaultWL = first.windowCenter ?? undefined;
  if (defaultWW === undefined || defaultWL === undefined) {
    if (first.modality === 'CT') {
      defaultWW = 350;
      defaultWL = 50;
    } else {
      defaultWW = Math.max(1, huMax - huMin);
      defaultWL = (huMax + huMin) / 2;
    }
  }

  const volume: VolumeData = {
    id: `dicom-${seriesUid}-${Date.now()}`,
    nx,
    ny,
    nz,
    spx,
    spy,
    spz,
    data: volumeData,
    huMin,
    huMax,
    meta: {
      patient: first.patient,
      patientId: first.patientId,
      study: first.studyDesc,
      studyDate: first.studyDate,
      series: first.seriesDesc,
      modality: first.modality,
      institution: first.institution,
      manufacturer: first.manufacturer,
      kvp: first.kvp ? `${first.kvp} kVp` : '—',
      tubeCurrent: first.tubeCurrent ? `${first.tubeCurrent} mA` : '—',
      isSynthetic: false,
      defaultWW,
      defaultWL
    },
    tags: first.tags
  };

  return {
    seriesUid,
    seriesNumber: first.seriesNumber,
    seriesDesc: first.seriesDesc,
    modality: first.modality,
    sliceCount: nz,
    rows: ny,
    cols: nx,
    volume
  };
}

export async function ingestDicomFiles(
  fileList: FileList | File[],
  onProgress?: (p: DicomLoadProgress) => void
): Promise<DicomLoadResult> {
  const inputFiles = Array.from(fileList || []);
  const warnings: string[] = [];

  if (!inputFiles.length) {
    return { series: [], warnings: ['No se seleccionaron archivos.'], fileCount: 0 };
  }

  const buffersToParse: Array<{ name: string; buffer: ArrayBuffer }> = [];

  for (let i = 0; i < inputFiles.length; i++) {
    const file = inputFiles[i];
    const lower = file.name.toLowerCase();
    if (lower === 'dicomdir' || lower.startsWith('.') || lower.endsWith('.ds_store')) {
      continue;
    }
    if (lower.endsWith('.zip')) {
      onProgress?.({
        phase: 'extracting',
        current: i + 1,
        total: inputFiles.length,
        message: `Descomprimiendo ${file.name}…`
      });
      try {
        const zip = await JSZip.loadAsync(await file.arrayBuffer());
        const entries = Object.values(zip.files).filter(
          (e) =>
            !e.dir &&
            !e.name.split('/').pop()?.startsWith('.') &&
            e.name.split('/').pop()?.toLowerCase() !== 'dicomdir'
        );
        for (let j = 0; j < entries.length; j++) {
          const entry = entries[j];
          if (j % 12 === 0) {
            onProgress?.({
              phase: 'extracting',
              current: j + 1,
              total: entries.length,
              message: `Extrayendo archivo ${j + 1} / ${entries.length} de ${file.name}…`
            });
          }
          const buf = await entry.async('arraybuffer');
          buffersToParse.push({ name: entry.name, buffer: buf });
        }
      } catch (err) {
        warnings.push(`${file.name}: error al leer ZIP (${err instanceof Error ? err.message : 'desconocido'})`);
      }
    } else {
      onProgress?.({
        phase: 'reading',
        current: i + 1,
        total: inputFiles.length,
        message: `Leyendo ${i + 1} / ${inputFiles.length} archivos…`
      });
      try {
        buffersToParse.push({ name: file.name, buffer: await file.arrayBuffer() });
      } catch {
        warnings.push(`${file.name}: no se pudo leer el archivo`);
      }
    }
  }

  const seriesMap = new Map<string, ParsedFrameSlice[]>();

  for (let i = 0; i < buffersToParse.length; i++) {
    const item = buffersToParse[i];
    if (i % 10 === 0 || i === buffersToParse.length - 1) {
      onProgress?.({
        phase: 'parsing',
        current: i + 1,
        total: buffersToParse.length,
        message: `Procesando cortes DICOM (${i + 1} / ${buffersToParse.length})…`
      });
      // Yield to browser UI every batch
      await new Promise((r) => setTimeout(r, 0));
    }

    try {
      const collectTags = seriesMap.size === 0 || i === 0;
      const frames = await parseSingleDicomBuffer(item.buffer, collectTags);
      for (const frame of frames) {
        const list = seriesMap.get(frame.seriesUid);
        if (list) list.push(frame);
        else seriesMap.set(frame.seriesUid, [frame]);
      }
    } catch (err) {
      warnings.push(`${item.name}: ${err instanceof Error ? err.message : 'error de parseo'}`);
    }
  }

  onProgress?.({
    phase: 'reconstructing',
    current: 1,
    total: 1,
    message: 'Ordenando volumen 3D y calculando espaciado isotrópico…'
  });

  const seriesList: LoadedSeries[] = [];
  for (const [uid, list] of seriesMap.entries()) {
    const built = buildSeriesVolume(uid, list, warnings);
    if (built) seriesList.push(built);
  }

  seriesList.sort((a, b) => b.sliceCount - a.sliceCount || a.seriesNumber - b.seriesNumber);

  return {
    series: seriesList,
    warnings,
    fileCount: buffersToParse.length
  };
}
