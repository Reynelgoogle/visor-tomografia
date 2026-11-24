import React, { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { DicomTagEntry, StudyMeta } from '../types/dicom';

interface DicomTagsModalProps {
  open: boolean;
  meta: StudyMeta;
  tags: DicomTagEntry[];
  onClose: () => void;
}

export const DicomTagsModal: React.FC<DicomTagsModalProps> = ({
  open,
  meta,
  tags,
  onClose
}) => {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tags;
    return tags.filter(
      (t) =>
        t.tag.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        t.value.toLowerCase().includes(q)
    );
  }, [tags, query]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Inspector de metadatos DICOM"
    >
      <div
        className="w-full max-w-3xl max-h-[82vh] flex flex-col bg-[#0E1118] border border-slate-700/80 rounded-lg overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 px-5 py-3.5 border-b border-slate-800">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              Metadatos DICOM · {meta.patient}
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {meta.study} · {meta.series} · {tags.length} etiquetas leídas
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
            aria-label="Cerrar inspector DICOM"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-3 border-b border-slate-800/80 bg-[#0A0D13]">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filtrar por etiqueta, nombre o valor (ej. 0028, PixelSpacing, KVP)…"
              className="w-full pl-9 pr-3 py-2 text-xs bg-[#141923] border border-slate-700/80 rounded-md text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-cyan-500"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto thin-scroll">
          <table className="w-full text-left border-collapse text-xs">
            <thead className="sticky top-0 bg-[#121620] border-b border-slate-800 text-[11px] text-slate-400">
              <tr>
                <th className="py-2.5 px-4 font-medium w-28">Tag</th>
                <th className="py-2.5 px-2 font-medium w-14">VR</th>
                <th className="py-2.5 px-3 font-medium w-52">Atributo</th>
                <th className="py-2.5 px-4 font-medium">Valor</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filtered.map((t) => (
                <tr key={t.tag} className="hover:bg-slate-800/35">
                  <td className="py-2 px-4 font-mono text-cyan-400 whitespace-nowrap">{t.tag}</td>
                  <td className="py-2 px-2 font-mono text-slate-400">{t.vr}</td>
                  <td className="py-2 px-3 text-slate-200 font-medium">{t.name}</td>
                  <td className="py-2 px-4 font-mono text-slate-300 break-all">{t.value}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-8 text-center text-slate-500">
                    Sin coincidencias para «{query}».
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
