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
    // player workstream (feel)
    walkThreshold: 0.55,
    decel: 34,
    holdMoveMul: 0.82,
    castMoveMul: 0.7,
    // measured from the clips' foot travel (Walk 1.03 m/s, Run 1.77 m/s); slightly over-cranked
    walkAnimSpeed: 1.15,
    runAnimSpeed: 2.2,
    stride: 1.1,
    leanMax: 0.2,
    leanSpring: 16,
    squashStiffness: 260,
    squashDamping: 13,
    hitKnockback: 4.5,
    hitStop: 0.07,
    deathDelay: 1.6,
    flickerHz: 16,
    castFaceTime: 0.35,
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
    lowEnergy: 15,
    visualScale: 1.7,
    sputterAmp: 0.35,
  },
  energy: {
    max: 100,
    start: 100,
    regenPerSec: 0,
    magnetRadius: 3.5,
    magnetSpeed: 9,
    pickupRadius: 0.55,
    dropletValue: 3,
    maxPickups: 48,
  },
  bolt: {
    cost: 5,
    speed: 16,
    damage: 1,
    maxRange: 12,
    cooldown: 0.18,
    castDelay: 0.07,
    buffer: 0.14,
    homing: 14,
    hitRadius: 0.35,
    critKillChance: 0.35,
    critMinInterval: 8,
    critDamageMul: 2,
  },
  dash: {
    distance: 4,
    duration: 0.25,
    iFrames: 0.25,
    cooldown: 2,
    trailLife: 2.5,
    trailSpacing: 0.8,
    trailRadius: 1.7,
    buffer: 0.12,
    carry: 0.45,
  },
  gesture: {
    tapMaxMs: 180,
    tapMaxPx: 12,
    holdMinMs: 180,
    swipeMinPx: 40,
    swipeMaxMs: 200,
    deadZone: 0.12,
    joyRadiusPx: 62,
  },
  sketch: {
    holdToPrint: 2,
    requiredRadius: 7,
    /** Progress lost per second when the hold breaks (fraction of full print). */
    decayPerSec: 0.35,
    /** Reveal radius must be at least this fraction of requiredRadius to count. */
    radiusSlack: 0.92,
    stampDuration: 0.35,
    gateOpenTime: 0.9,
    printedRevealRadius: 3.2,
  },
  world: {
    groundCell: 1,
    groundMargin: 26,
    treeSpacing: 2.6,
    treeBand: 16,
    edgeClearance: 0.7,
    cameraOcclusionDepth: 8,
    trunkRadius: 0.5,
    chunkSize: 24,
    wellRadius: 1.3,
    wellRevealRadius: 2.2,
    /** Seconds for a drained ink well to refill (keeps prints solvable, no softlocks). */
    wellRefill: 16,
  },
  checkpoint: { respawnDelay: 1.6, reprintTurn: 0.6, refillPages: true },
  enemies: {
    maxActive: 8,
    smudge: { hp: 2, speed: 2.6, damage: 1, inkDrop: 6 },
    scribbler: { hp: 3, speed: 1.6, range: 8, telegraph: 0.8, fireCooldown: 2.8, damage: 1, inkDrop: 9 },
    blot: { hp: 3, speed: 1.3, drainRadius: 3, radiusSuppress: 0.5, damage: 1, inkDrop: 12 },
    /** Enemy AI / feel (workstream: enemies). */
    ai: {
      aggroRange: 16,
      idleMin: 0.4,
      idleMax: 1.2,
      separationRadius: 1.4,
      separationForce: 6,
      steerAccel: 10,
      revealOn: 0.5,
      revealOff: 0.35,
      revealFadeIn: 6,
      revealFadeOut: 2.5,
      spawnTime: 0.55,
      recoilTime: 0.32,
      recoilImpulse: 5,
      recoilDrag: 7,
      hitFlash: 0.18,
      deathTime: 0.85,
      contactCooldown: 0.9,
      /** Max smudge/scribbler attacks in flight at once (difficulty overrides). */
      maxAttackers: 2,
      /** Grace after a spawn before the first attack may start. */
      firstAttackDelay: 1.2,
      /** Extra tempo stretch while the player can't afford a bolt (out-of-ink mercy). */
      mercyTempo: 1.6,
    },
    smudgeAi: {
      radius: 0.45,
      stalkOffset: 1.1,
      orbitSpeed: 1.9,
      stalkMin: 1.8,
      stalkMax: 3.6,
      windup: 0.55,
      dartSpeed: 8.5,
      /** Max dart duration; actual = time to pass the aim point by `dartOvershoot`. */
      dartTime: 0.95,
      dartOvershoot: 1.4,
      dartRange: 9,
    },
    scribblerAi: {
      radius: 0.4,
      preferRange: 6.5,
      orbitSpeed: 0.9,
      projectileSpeed: 11,
      projectileRadius: 0.22,
      projectileLife: 1.4,
      maxProjectiles: 8,
      aimLead: 0.25,
    },
    blotAi: {
      radius: 0.6,
      drainPulse: 0.9,
      minRadiusFactor: 0.35,
      /** Absolute light floor under drain (m): a latched blot always stays revealed & shootable. */
      minRadius: 2.4,
      /** Rear-up telegraph before the drain starts (s). */
      latchTime: 1.1,
      /** Seconds for the drain to reach full strength once latched. */
      drainRamp: 2.6,
      stopDistance: 1.1,
    },
    fx: { scraps: 18, droplets: 10, maxParticles: 160, scrapSpeed: 4.2, gravity: 11, particleLife: 1.3 },

    // ── Idea Ledger wave 1 (workstream: enemies) ──
    marginMan: { hp: 2, speed: 3, damage: 1, inkDrop: 10 },
    redactor: { hp: 2, speed: 1.6, damage: 1, inkDrop: 12 },
    panelWarden: { hp: 3, speed: 1.5, damage: 1, inkDrop: 12 },
    misprint: { hp: 2, speed: 1.7, damage: 1, inkDrop: 9 },
    /** One swarm entity; hp is unused (one hit per crane), speed is the boid cruise speed. */
    cranes: { hp: 1, speed: 3.4, damage: 1, inkDrop: 12 },
    /** Margin Man: frozen inside the reveal, blinks toward the player outside it. */
    marginAi: {
      radius: 0.4,
      /** Seconds between blink steps while outside the mask. */
      stepEvery: 0.95,
      stepDist: 2.3,
      /** Shutter-click tell before each blink. */
      stepTell: 0.3,
      strikeRange: 1.7,
      /** Seconds between strikes (× tempo). */
      strikeCooldown: 2.4,
      windup: 0.65,
      /** Hittable window after a dash ink trail crosses it. */
      vulnerableS: 2,
      /** Dash segment ↔ body distance that counts as "crossed". */
      dashWidth: 0.9,
    },
    /** Redactor: censorship bar, bolt-immune until the held crystal covers it for `exposeS`. */
    redactorAi: {
      radius: 0.6,
      exposeS: 1,
      /** Exposure lost per second when the crystal looks away. */
      exposeDecay: 0.7,
      laneLen: 6,
      slideSpeed: 1.6,
      /** Reveal suppression while the crystal is inside its lane (multiplier on target radius). */
      suppress: 0.5,
      laneHalfWidth: 1.6,
      /** It also censors the inked history along its slide. */
      eraseHalfWidth: 0.45,
      eraseEvery: 0.3,
    },
    /** Panel Warden: drops a shrinking panel border around the player; the gutter hurts. */
    wardenAi: {
      radius: 0.45,
      /** Inside the held-crystal radius (7) but outside the idle one (3): hold the light to see it. */
      keepRange: 5.2,
      castRange: 11,
      windup: 0.9,
      boxSize: 6,
      boxMin: 2.2,
      shrinkS: 4,
      gutterGrace: 0.5,
      gutterTick: 1,
      cooldown: 4.5,
      /** Dashing within this of the telegraphed corner seam cuts the panel. */
      seamRadius: 1.2,
    },
    /** Misprint: CMYK ghost layers align into one hittable body for `window` every `period`. */
    misprintAi: {
      radius: 0.45,
      period: 2.5,
      window: 0.6,
      /** Layers slide together over this long before the window (telegraph). */
      converge: 0.45,
      spread: 1.1,
      /** Phase-lock the window to `audio:beat` when beats arrive (± half a beat). */
      beatSnap: true,
    },
    /** Origami Crane Swarm: pooled boids counted as one enemy. */
    craneAi: {
      radius: 0.3,
      countMin: 5,
      countMax: 7,
      ringOffset: 0.25,
      orbitSpeed: 2.4,
      flyHeight: 1.3,
      diveEvery: 2.2,
      fold: 0.55,
      diveSpeed: 9,
      diveTime: 0.75,
      returnTime: 0.9,
      scatterRadius: 2.4,
      scatterS: 1.6,
      scatterImpulse: 7,
    },
    /** Elite affixes: chance per rolled spawn (× difficulty.eliteMul). */
    elites: {
      chance: 0.12,
      firstEditionHp: 1,
      inkedInHold: 1.5,
      bleedHp: 1,
      bleedSpeed: 1.25,
      outlineMul: 1.7,
    },
    /** "The Inker's Deadline" encounter director, layered on the authored spawner. */
    director: {
      /** Trigger ids that open a director moment → max seconds it may run. */
      moments: { p2_gate_ambush: 14, p2_mist: 16, p3_arena: 22 } as Record<string, number>,
      budgetPerSec: 0.55,
      budgetMax: 6,
      /** Spawn cap per moment (× difficulty.deadline). */
      maxSpawns: 4,
      cost: { fodder: 1, zoner: 2, flanker: 2, support: 2.5, priority: 4 },
      weight: { fodder: 3, zoner: 2, flanker: 2, support: 1.2, priority: 0.8 },
      /** Leave this many maxActive slots free for authored waves. */
      reserve: 1,
      spawnMin: 8,
      spawnMax: 11,
      spawnEvery: 1.2,
      peakAt: 0.72,
      relaxBelow: 0.3,
      buildMaxS: 12,
      peakS: 5,
      relaxS: 6,
      /** Intensity inputs. */
      damageNorm: 2,
      damageHalfLife: 6,
      lowInk: 0.4,
      enemiesNorm: 5,
      nearRange: 13,
      wDamage: 0.45,
      wInk: 0.25,
      wEnemies: 0.45,
      smooth: 2.5,
      relaxDrops: 2,
      relaxDropAmount: 12,
    },
  },
  boss: {
    scale: 4,
    /** Arena (boss page): Editor stands at `pos`, fight happens in the circle `arena` [x, z, r]. */
    pos: [0, -7] as [number, number],
    arena: [0, 1, 10.5] as [number, number, number],
    introTime: 3.4,
    transitionTime: 3.4,
    deathTime: 7,
    /** Phase targets are pacing goals; weak-point exposure windows produce them (see DECISIONS). */
    phase1: {
      duration: 45,
      weakPoints: 3,
      sweepInterval: 4.5,
      wpHp: 3,
      telegraph: 1.25,
      travel: 0.85,
      recover: 2.2,
      laneHalfWidth: 1.5,
      pressRadius: 2.1,
      ghostsPerSweep: 1,
      extraGhostChance: 0.35,
    },
    phase2: {
      duration: 45,
      weakPoints: 3,
      printHold: 2,
      printRadius: 7,
      printDecay: 0.5,
      drawIn: 2.4,
      printedLife: 9,
      wpHp: 2,
      attackInterval: 3.6,
      stabTelegraph: 1.15,
      stabRadius: 2.2,
      stabRecover: 1.2,
      scribblerChance: 0.5,
    },
    phase3: {
      duration: 40,
      hitsToKill: 3,
      sweepInterval: 2.6,
      telegraph: 0.78,
      travel: 0.55,
      recover: 0.6,
      laneHalfWidth: 2.3,
      doubleEvery: 3,
      bowEvery: 2,
      bowTime: 2.8,
      blankFade: 2.2,
    },
    /** After a phase's target duration, weak points take this damage multiplier (anti-stall). */
    overtimeDamageMul: 2,
    /** Story difficulty multipliers. */
    story: { hpMul: 0.6, telegraphMul: 1.35, intervalMul: 1.25, travelMul: 1.2, windowMul: 1.4 },
    weakPointRadius: 0.75,
    contactDamage: 1,
    /** Ink energy refunded to the player per weak-point hit / destroy (keeps bolts + printing fed). */
    inkPerHit: 4,
    inkPerDestroy: 16,
    /** Editor body blocker radius (levels' boss arena should add the same circle). */
    bodyRadius: 1.7,
    /** Ink economy guard: leak `perImpact` at impacts while energy < leakBelow; emergency drops. */
    ink: { leakBelow: 45, perImpact: 8, emergencyBelow: 18, emergencyEvery: 3.5, emergencyAmount: 14 },
    /** Boss camera (Editor.applyCamera): behind the player on the Editor→player axis. */
    camera: {
      backPortrait: 9.5,
      upPortrait: 7.0,
      backLandscape: 11.5,
      upLandscape: 7.4,
      look: 0.55,
      lookIntro: 0.75,
      southBias: 0.55,
      nearDist: 10,
      nearBack: 3,
      nearUp: 1.6,
    },
  },
  camera: {
    distance: 9,
    height: 7.5,
    pitchDeg: 46,
    spring: 6,
    fovPortrait: 50,
    fovLandscape: 34,
    lookAhead: 1.2,
    // player workstream: portrait keeps at least this much world width visible at the focus
    portraitMinWidth: 7.5,
    // any orientation keeps at least this much ground depth (m, foreshortened by pitch) on screen
    minGroundDepth: 9.5,
    maxDistance: 15,
    lookAheadSpring: 2.2,
    maxLag: 1.3,
    forwardBiasPortrait: 1.6,
    forwardBiasLandscape: 0.5,
    focusHeight: 0.9,
    shakeMax: 0.32,
    shakeFreq: 19,
    shakeDecay: 1.8,
    dashKickDeg: 4,
    railBlendBack: 0.6,
  },
  haptics: { tap: 8, dash: 18, crystal: 6, hurt: 45, crit: 30, fizzle: 4 },
  /** Player workstream, idea-ledger wave 1: juice, close-up crits, snuff/flare, nib, parry, lasso, rhythm, style. */
  combatPlus: {
    /** Hit-stop (s) by blow weight. */
    hitStop: { hit: 0.05, kill: 0.12, crit: 0.2 },
    /** Paper-white impact starburst: min seconds between flashes (keeps it under 3 Hz). */
    flashMinGap: 0.34,
    flashSize: 1.6,
    /** Kill chain: kills within `chainWindow` s of each other raise the hit sfx a semitone each. */
    chainWindow: 1.5,
    chainMaxSemitones: 12,
    /** Bolt trail width multiplier added per chained kill (capped at trailWidthMax). */
    trailWidthPerChain: 0.14,
    trailWidthMax: 2.2,
    /** Knockback: hits are reported as coming from this far behind the target along the bolt. */
    knockbackFrom: 1.2,
    /** "Thock" vibration on kill (ms). */
    thockMs: 22,
    /** Close-Up Crits: min seconds between crit panel cuts; telegraph grace after the windup. */
    critMinGap: 3,
    telegraphGrace: 0.15,
    /** Auto-aim distance multiplier for attacking / marked targets (lower = preferred). */
    attackAimBias: 0.5,
    markedAimBias: 0.7,
    snuff: { flareTime: 0.15, stunTime: 1.5, markTime: 4 },
    nib: { damage: 1, reach: 0.35 },
    parry: { window: 0.15, slowScale: 0.5, slowTime: 1.2, refund: 10, probe: 0.45, cooldown: 3 },
    lasso: {
      life: 4,
      closeDist: 1,
      minArea: 2.5,
      damage: 2,
      maxPoints: 32,
      minSpacing: 0.35,
      cooldown: 1.5,
    },
    /** Ink Rhythm: on-beat bolts are free and this much bigger. */
    beatBoltScale: 1.45,
    style: {
      /** Points per action at full freshness. */
      points: { bolt: 60, crit: 90, nib: 80, lasso: 160, parry: 130, flare: 110, onBeat: 35 },
      /** Freshness multiplier applied to an action each time it is used; recovers per second. */
      staleMul: 0.62,
      freshRegen: 0.18,
      minFresh: 0.15,
      /** Score lost per second (scaled up with the grade, so P is hard to hold). */
      decayPerSec: 22,
      decayPerGrade: 0.35,
      damagePenalty: 220,
      max: 1300,
      /** Score needed for D, C, B, A, S, P. */
      grades: [0, 120, 280, 480, 720, 1000],
    },
  },
  panelCut: {
    duration: 0.6,
    panels: 3,
    closeUpFar: 9,
    /** Drop to 2 panels when 3 would blow these (PLAN §8 budgets, with margin). */
    maxDraws: 115,
    maxTris: 330000,
    /** snapshot() during a cut shoots the composition as it looks this far in (all panels landed). */
    snapshotAt: 0.34,
  },
  pageTurn: { duration: 0.9 },
  difficulty: {
    // enemyTempo stretches enemy windups/cooldowns, enemySpeed scales their movement,
    // drainMul scales blot drain, maxAttackers caps simultaneous smudge/scribbler attacks.
    story: {
      damageTaken: 0.5,
      energyCost: 0.6,
      enemyTempo: 1.35,
      enemySpeed: 0.85,
      drainMul: 0.6,
      maxAttackers: 1,
      // enemies wave 1: gimmick enemies become bolt-killable after this long alive; elite chance
      // multiplier; "Deadline" director scale (0 disables it)
      gimmickFallback: 7,
      eliteMul: 0.4,
      deadline: 0.5,
    },
    normal: {
      damageTaken: 1,
      energyCost: 1,
      enemyTempo: 1,
      enemySpeed: 1,
      drainMul: 1,
      maxAttackers: 2,
      gimmickFallback: 14,
      eliteMul: 1,
      deadline: 1,
    },
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
  /** Audio workstream (Idea Ledger wave 1). Times in seconds unless the name says ms. */
  audio: {
    /** Beat clock calibration: + when speakers lag more than the browser reports (UI may expose). */
    latencyOffsetMs: 0,
    /** Default BeatAPI.onBeat() window (± ms around an 8th). */
    beatWindowMs: 90,
    /** Quantized SFX snap to the next 16th only if it is at most this far away. */
    quantizeMaxMs: 45,
    /** sketch_done waits for the next bar line if it is within this, else the next beat. */
    downbeatMaxS: 0.9,
    unprinted: { hpLo: 320, lpLo: 3000, drive: 0.55, crackle: 0.05, proxyTauS: 45, crystalBurst: 0.3 },
    light: { inside: 18000, outside: 700, feather: 3 },
    freeze: { feedback: 0.97, releaseS: 0.35 },
    riser: { voices: 4, fMin: 110, span: 4, climb: 3, gain: 0.05 },
    drummer: { minHeat: 0.08 },
    noir: { bed: 0.09, idleS: 8 },
    leak: { scratchGain: 0.05, minGapS: 2.2, maxGapS: 4.5 },
    phone: { exciter: 0.35, monoBelowHz: 120 },
    haptics: { beat: 7, kill: [14, 40, 22], heart: [16, 110, 10], minGapMs: 90 },
  },
};

export type Tuning = typeof TUNING;
