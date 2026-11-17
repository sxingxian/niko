import type { CoreHandle, CoreMode } from './core';
/** The designs designs.js can draw (every design but Nebula). */
export declare const DESIGN_STYLES: string[];
/** Starts a design other than Nebula on a canvas, reading the shared hue each frame. */
export declare function runDesign(canvas: HTMLCanvasElement, design: string, getHue: () => number, opts?: { mode?: CoreMode }): CoreHandle;
/** One dot or line of a design, in units of the core's radius. */
export interface DesignDot { x: number; y: number; s: number; c: string }
export interface DesignLine { x1: number; y1: number; x2: number; y2: number; c: string }
/** Records what a design (not Nebula) would draw, for the screen-to-screen flow. */
export declare function sampleDesign(design: string, small?: boolean): { take(t: number, dt: number, hue: number): { pts: DesignDot[]; segs: DesignLine[] } };
