export interface HoverVoxelInfo {
  x: number;
  y: number;
  z: number;
  hu: number;
}

type Listener = () => void;

let currentHover: HoverVoxelInfo | null = null;
const listeners = new Set<Listener>();

export function setHoverVoxelInfo(next: HoverVoxelInfo | null): void {
  if (
    currentHover === next ||
    (currentHover &&
      next &&
      currentHover.x === next.x &&
      currentHover.y === next.y &&
      currentHover.z === next.z &&
      currentHover.hu === next.hu)
  ) {
    return;
  }
  currentHover = next;
  listeners.forEach((l) => l());
}

export function getHoverVoxelInfo(): HoverVoxelInfo | null {
  return currentHover;
}

export function subscribeHoverVoxel(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
