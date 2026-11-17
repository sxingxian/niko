import type { CoreHandle, CoreMode } from './core';
/** The designs designs.js can draw (every design but Nebula). */
export declare const DESIGN_STYLES: string[];
/** Starts a design other than Nebula on a canvas, reading the shared hue each frame. */
export declare function runDesign(canvas: HTMLCanvasElement, design: string, getHue: () => number, opts?: { mode?: CoreMode }): CoreHandle;
