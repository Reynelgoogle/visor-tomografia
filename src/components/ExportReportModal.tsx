import React, { useState } from 'react';
import { Check, Copy, Download, X } from 'lucide-react';
import type {
  AngleMeasurement,
  HuProbe,
  LengthMeasurement,
  RoiMeasurement,
  VolumeData
} from '../types/dicom';

interface ExportReportModalProps {
  open: boolean;
  volume: VolumeData;
  ww: number;
  wl: number;
  lengths: LengthMeasurement[];
  angles: AngleMeasurement[];
  rois: RoiMeasurement[];
  probes: HuProbe[];
  onClose: () => void;
  onDownloadPng: () => void;
}

export const ExportReportModal: React.FC<ExportReportModalProps> = ({
  open,
  volume,
  ww,
  wl,
  lengths,
  angles,
  rois,
  probes,
  onClose,
  onDownloadPng
}) => {
  const [copied, setCopied] = useState(false);

  if (!open) return null;

  const lines: string[] = [
    `RESUMEN CUANTITATIVO DE ESTUDIO`,
    `Paciente: ${volume.meta.patient} (${volume.meta.patientId})`,
    `Estudio: ${volume.meta.study} · Serie: ${volume.meta.series}`,
    `Modalidad: ${volume.meta.modality} · Matriz: ${volume.nx}×${volume.ny}×${volume.nz}`,
    `Vóxel: ${volume.spx.toFixed(2)} × ${volume.spy.toFixed(2)} × ${volume.spz.toFixed(2)} mm`,
    `Ventana activa: WW ${Math.round(ww)} / WL ${Math.round(wl)} HU`,
    ''
  ];

  if (lengths.length) {
    lines.push(`LONGITUDES (${lengths.length}):`);
    lengths.forEach((m) =>
      lines.push(`  - L${m.id} (${m.view}, corte ${m.slice + 1}): ${m.mm.toFixed(2)} mm`)
    );
    lines.push('');
  }
  if (angles.length) {
    lines.push(`ÁNGULOS (${angles.length}):`);
    angles.forEach((a) =>
      lines.push(`  - A${a.id} (${a.view}, corte ${a.slice + 1}): ${a.deg.toFixed(1)}°`)
    );
    lines.push('');
  }
  if (rois.length) {
    lines.push(`REGIONES DE INTERÉS (${rois.length}):`);
    rois.forEach((r) =>
      lines.push(
        `  - ROI${r.id} (${r.view}, corte ${r.slice + 1}, ${r.shape}): Media ${r.mean.toFixed(
          1
        )} ± ${r.stdDev.toFixed(1)} HU | Mín ${r.min.toFixed(0)} / Máx ${r.max.toFixed(
          0
        )} HU | Área ${r.areaMm.toFixed(1)} mm² (${r.count} px)`
      )
    );
    lines.push('');
  }
  if (probes.length) {
    lines.push(`SONDAS HU (${probes.length}):`);
    probes.forEach((p) =>
      lines.push(
        `  - P${p.id} (${p.view}, corte ${p.slice + 1}): ${Math.round(p.hu)} HU @ (${p.x},${p.y},${p.z})`
      )
    );
  }
  if (!lengths.length && !angles.length && !rois.length && !probes.length) {
    lines.push('Sin mediciones registradas en esta sesión.');
  }

  const reportText = lines.join('\n');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(reportText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore clipboard errors in restricted iframes
    }
  };

  const handleDownloadJson = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      study: volume.meta,
      dimensions: { nx: volume.nx, ny: volume.ny, nz: volume.nz },
      spacingMm: { x: volume.spx, y: volume.spy, z: volume.spz },
      window: { ww, wl },
      measurements: { lengths, angles, rois, probes }
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `informe-mediciones-${volume.meta.patientId || 'estudio'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Exportar resumen e imagen"
    >
      <div
        className="w-full max-w-xl bg-[#0E1118] border border-slate-700/80 rounded-lg overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800">
          <h2 className="text-sm font-semibold text-slate-100">
            Exportar mediciones y captura clínica
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md text-slate-400 hover:text-slate-100 hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <pre className="p-3.5 rounded-md bg-[#07090D] border border-slate-800 font-mono text-xs text-slate-300 whitespace-pre-wrap max-h-64 overflow-y-auto thin-scroll leading-relaxed">
            {reportText}
          </pre>

          <div className="flex flex-wrap gap-2.5">
            <button
              type="button"
              onClick={handleCopy}
              className="flex-1 inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-md border border-slate-700 bg-slate-800/70 hover:bg-slate-800 text-xs font-medium text-slate-100 transition-colors whitespace-nowrap"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Copiado' : 'Copiar resumen'}
            </button>
            <button
              type="button"
              onClick={handleDownloadJson}
              className="flex-1 inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-md border border-slate-700 bg-slate-800/70 hover:bg-slate-800 text-xs font-medium text-slate-100 transition-colors whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              Descargar JSON
            </button>
            <button
              type="button"
              onClick={onDownloadPng}
              className="flex-1 inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-md bg-cyan-500 hover:bg-cyan-400 text-xs font-semibold text-slate-950 transition-colors whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              PNG vista activa
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
