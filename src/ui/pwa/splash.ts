/** iOS launch images (portrait only — the app is portrait-first). Shared by build-icons.ts and pwa.ts. */
export interface SplashSpec {
  /** CSS points */
  w: number;
  h: number;
  dpr: number;
}

export const SPLASHES: SplashSpec[] = [
  { w: 440, h: 956, dpr: 3 }, // iPhone 16 Pro Max
  { w: 402, h: 874, dpr: 3 }, // iPhone 16 Pro
  { w: 430, h: 932, dpr: 3 }, // iPhone 14/15 Pro Max, 15/16 Plus
  { w: 393, h: 852, dpr: 3 }, // iPhone 14/15 Pro, 15/16
  { w: 428, h: 926, dpr: 3 }, // iPhone 12/13 Pro Max, 14 Plus
  { w: 390, h: 844, dpr: 3 }, // iPhone 12/13/14
  { w: 375, h: 812, dpr: 3 }, // iPhone X/XS/11 Pro/12 mini/13 mini
  { w: 414, h: 896, dpr: 2 }, // iPhone XR/11
  { w: 414, h: 896, dpr: 3 }, // iPhone XS Max/11 Pro Max
  { w: 375, h: 667, dpr: 2 }, // iPhone 8/SE
  { w: 744, h: 1133, dpr: 2 }, // iPad mini 6
  { w: 810, h: 1080, dpr: 2 }, // iPad 10.2
  { w: 820, h: 1180, dpr: 2 }, // iPad Air / iPad 10th
  { w: 834, h: 1194, dpr: 2 }, // iPad Pro 11
  { w: 1024, h: 1366, dpr: 2 }, // iPad Pro 12.9
];

export const splashFile = (s: SplashSpec) => `icons/splash/splash-${s.w * s.dpr}x${s.h * s.dpr}.png`;

export const splashMedia = (s: SplashSpec) =>
  `(device-width: ${s.w}px) and (device-height: ${s.h}px) and (-webkit-device-pixel-ratio: ${s.dpr}) and (orientation: portrait)`;
