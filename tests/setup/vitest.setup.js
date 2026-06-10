import 'fake-indexeddb/auto';
import { vi } from 'vitest';

if (!URL.createObjectURL) {
  URL.createObjectURL = vi.fn(() => 'blob:vitest-object-url');
}

if (!URL.revokeObjectURL) {
  URL.revokeObjectURL = vi.fn();
}

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: () => ({
    arc: vi.fn(),
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    stroke: vi.fn(),
    strokeRect: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) })),
    set fillStyle(_value) {},
    set font(_value) {},
    set lineWidth(_value) {},
    set strokeStyle(_value) {},
    set textAlign(_value) {},
  }),
});

Object.defineProperty(HTMLCanvasElement.prototype, 'getBoundingClientRect', {
  configurable: true,
  value() {
    return {
      left: 10,
      top: 20,
      width: this.width || 500,
      height: this.height || 620,
      right: 10 + (this.width || 500),
      bottom: 20 + (this.height || 620),
    };
  },
});

Object.defineProperty(HTMLMediaElement.prototype, 'load', {
  configurable: true,
  value: vi.fn(),
});
