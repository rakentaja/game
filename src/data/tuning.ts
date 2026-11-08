/**
 * Every gameplay / feel number lives here. The debug panel (?debug=1) edits this object live,
 * so always read values at use time (TUNING.player.speed), never cache them in module scope.
 */
export const TUNING = {
  sim: { hz: 60, maxStepsPerFrame: 5 },
  boil: { hz: 12, animHz: 12 },
  player: {
    walkSpeed: 2.2,
    runSpeed: 4.6,
    accel: 18,
    turnRate: 12,
    radius: 0.35,
    height: 1.85,
    maxPages: 5,
    iFramesOnHit: 1.0,
  },
  crystal: {
    radiusIdle: 3,
    radiusHeld: 7,
    radiusDim: 1.5,
    growTime: 0.6,
    shrinkTime: 1.4,
    drainPerSec: 12,
    edgeWidth: 0.9,
    fbmScale: 3,
    fbmAmp: 0.6,
  },
  energy: { max: 100, start: 100, regenPerSec: 0, magnetRadius: 3.5, magnetSpeed: 9 },
  bolt: { cost: 5, speed: 16, damage: 1, maxRange: 12, cooldown: 0.18 },
  dash: { distance: 4, duration: 0.25, iFrames: 0.25, cooldown: 2, trailLife: 2.5 },
  gesture: { tapMaxMs: 180, tapMaxPx: 12, holdMinMs: 180, swipeMinPx: 40, swipeMaxMs: 200, deadZone: 0.12 },
  sketch: { holdToPrint: 2, requiredRadius: 7 },
  enemies: {
    maxActive: 8,
    smudge: { hp: 2, speed: 2.6, damage: 1, inkDrop: 6 },
    scribbler: { hp: 3, speed: 1.6, range: 8, telegraph: 0.8, fireCooldown: 2.4, damage: 1, inkDrop: 9 },
    blot: { hp: 3, speed: 1.3, drainRadius: 3, radiusSuppress: 0.5, damage: 1, inkDrop: 12 },
  },
  boss: {
    scale: 4,
    phase1: { duration: 45, weakPoints: 3, sweepInterval: 4.5 },
    phase2: { duration: 45, weakPoints: 3, printHold: 2 },
    phase3: { duration: 40, hitsToKill: 3, sweepInterval: 2.6 },
  },
  camera: {
    distance: 9,
    height: 7.5,
    pitchDeg: 48,
    spring: 6,
    fovPortrait: 42,
    fovLandscape: 34,
    lookAhead: 1.2,
  },
  panelCut: { duration: 0.6, panels: 3 },
  pageTurn: { duration: 0.9 },
  difficulty: {
    story: { damageTaken: 0.5, energyCost: 0.6 },
    normal: { damageTaken: 1, energyCost: 1 },
  },
  quality: {
    targetFrameMs: 16.7,
    minPixelRatio: 1,
    maxPixelRatio: 2,
    revealHistorySize: 256,
    /** Adaptive pixel ratio: drop after this long over budget, raise after this long under it. */
    downAfterS: 0.6,
    upAfterS: 4,
    prStep: 0.125,
    /** Over budget = EMA frame time above target × this. Under = below target × upRatio. */
    downRatio: 1.18,
    upRatio: 1.06,
  },
  /** Reveal mask (render/reveal). Shader and CPU mirror read the same numbers. */
  reveal: {
    historyWorldSize: 96,
    historyFadePerSec: 0.045,
    historyStampHz: 20,
    maxSources: 16,
    /** Edge crawl speed of the fbm domain (paper wicking), lattice units / s. */
    seepSpeed: 0.18,
    /** Extra edge raggedness while the radius is growing (ink fingers). */
    growthFingers: 0.9,
    sourceGrowS: 0.22,
    sourceFadeFrac: 0.35,
  },
  /** Ink look (render/post + materials). */
  render: {
    shadow: 0.3,
    fogNear: 9,
    fogFar: 26,
    lineScreenPeriod: 3.4,
    lineScreenAngle: 62,
    lineScreenStrength: 0.55,
    edgeWidthPx: 1.4,
    /** Sobel crease threshold: 1 - cos(bend angle). 0.09 ≈ 25°. */
    creaseAngle: 0.09,
    hullWidthPx: 2.0,
    grain: 0.5,
    misregPx: 0.6,
    vignette: 0.9,
    rimPx: 1.6,
    wetFrontPx: 2.5,
    sketch: 1,
  },
  fx: {
    shakeMax: 0.28,
    shakeFreq: 22,
    shakeDecayPerSec: 1.8,
    splashPool: 48,
    tearPool: 96,
    splashLife: 0.55,
    tearLife: 1.6,
  },
};

export type Tuning = typeof TUNING;
