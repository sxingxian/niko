import type { CoreMode } from './core';
/** Every background backgrounds.js can draw, Glow included. */
export declare const BACKGROUND_STYLES: string[];
export interface BackgroundHandle {
  stop(): void;
  setStyle(style: string): void;
  setMode(m: CoreMode): void;
  /** Loudness 0–1 of the voice, when known; null uses a natural rhythm. */
  setLevel(v: number | null): void;
  /** Paused: one settled frame, then nothing (picker tiles that aren't selected). */
  setPaused(p: boolean): void;
  /** Whether the background answers Niko's state ("Move with Niko"). */
  setReact(on: boolean): void;
}
/** Starts a background on a canvas, reading the shared hue each frame. */
export declare function runBackground(canvas: HTMLCanvasElement, style: string, getHue: () => number, opts?: { mode?: CoreMode; paused?: boolean; react?: boolean }): BackgroundHandle;
