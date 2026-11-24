declare module 'dicom-parser' {
  export interface Element {
    tag: string;
    vr?: string;
    length: number;
    dataOffset: number;
    items?: Array<{
      dataOffset: number;
      length: number;
      hadUndefinedLength?: boolean;
    }>;
    encapsulatedPixelData?: boolean;
    hadUndefinedLength?: boolean;
    basicOffsetTable?: number[];
  }

  export interface DataSet {
    byteArray: Uint8Array;
    elements: Record<string, Element>;
    string(tag: string, index?: number): string | undefined;
    intString(tag: string, index?: number): number | undefined;
    floatString(tag: string, index?: number): number | undefined;
    uint16(tag: string, index?: number): number | undefined;
    int16(tag: string, index?: number): number | undefined;
    uint32(tag: string, index?: number): number | undefined;
  }

  export function parseDicom(
    byteArray: Uint8Array,
    options?: { TransferSyntaxUID?: string; untilTag?: string }
  ): DataSet;

  export function readEncapsulatedImageFrame(
    dataSet: DataSet,
    pixelDataElement: Element,
    frameIndex: number,
    basicOffsetTable?: number[]
  ): Uint8Array;

  export function readEncapsulatedPixelDataFromFragments(
    dataSet: DataSet,
    pixelDataElement: Element,
    startFragmentIndex: number,
    numFragments?: number,
    fragments?: unknown[]
  ): Uint8Array;

  export function createJPEGBasicOffsetTable(
    dataSet: DataSet,
    pixelDataElement: Element,
    fragments?: unknown[]
  ): number[];
}

declare module 'jpeg-lossless-decoder-js' {
  export class Decoder {
    constructor(buffer?: ArrayBuffer | null, numBytes?: number);
    decompress(buffer: ArrayBuffer, offset?: number, length?: number): ArrayBuffer;
    decode(
      buffer?: ArrayBuffer,
      offset?: number,
      length?: number,
      numBytes?: number
    ): Uint8Array | Uint16Array;
  }
}
