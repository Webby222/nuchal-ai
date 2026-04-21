// PostureMath.ts — Nuchal AI
// Baseline-relative posture detection with signed direction + sensitivity control

export interface PostureMetrics {
  yieldRatio: number;
  horizontalOffset: number;
  tiltAngle: number;
  pitchAngle: number;
  status: string;
  severity: "healthy" | "mild" | "critical";
}

export interface PostureBaseline {
  yieldRatio: number;
  horizontalOffset: number;
  tiltAngle: number;
}

export const calculatePostureMetrics = (
  nose: { x: number; y: number; visibility?: number },
  chin: { x: number; y: number },
  forehead: { x: number; y: number },
  leftShoulder: { x: number; y: number; visibility?: number },
  rightShoulder: { x: number; y: number; visibility?: number },
  baseline: PostureBaseline | null,
  // sensitivity factor: 0.0 = very loose, 1.0 = normal, 2.0 = very tight
  sensitivityFactor: number = 1.0
): PostureMetrics => {

  // ── VISIBILITY CHECK ────────────────────────────────────────────────────────
  const noseVisible = nose.visibility ?? 1;
  const leftShoulderVisible = leftShoulder.visibility ?? 1;
  const rightShoulderVisible = rightShoulder.visibility ?? 1;

  if (noseVisible < 0.5 || leftShoulderVisible < 0.5 || rightShoulderVisible < 0.5) {
    return {
      yieldRatio: 0,
      horizontalOffset: 0,
      tiltAngle: 0,
      pitchAngle: 0,
      status: "No person detected",
      severity: "healthy",
    };
  }

  // ── CORE MEASUREMENTS ───────────────────────────────────────────────────────
  const shoulderMid = {
    x: (leftShoulder.x + rightShoulder.x) / 2,
    y: (leftShoulder.y + rightShoulder.y) / 2,
  };

  const shoulderWidth = Math.abs(leftShoulder.x - rightShoulder.x) || 0.001;

  // SIGNED yield ratio — positive = nose above shoulder (good)
  const yieldRatio = (shoulderMid.y - nose.y) / shoulderWidth;

  // Horizontal offset — nose drift from shoulder center
  const horizontalOffset = (nose.x - shoulderMid.x) / shoulderWidth;

  // SIGNED tilt — forward head = positive degrees
  const neckVec = {
    x: shoulderMid.x - nose.x,
    y: shoulderMid.y - nose.y,
  };
  const tiltAngle = Math.atan2(neckVec.x, neckVec.y) * (180 / Math.PI);

  // Pitch — calculated but NOT used for status (laptop camera makes it unreliable)
  const pitchVec = {
    x: forehead.x - chin.x,
    y: forehead.y - chin.y,
  };
  const pitchAngle = Math.atan2(-pitchVec.y, pitchVec.x) * (180 / Math.PI) - 90;

  // ── LATERAL TILT CHECK — highest priority ───────────────────────────────────
  const shoulderDrop = Math.abs(leftShoulder.y - rightShoulder.y) / shoulderWidth;
  const lateralNoseDrift = Math.abs(nose.x - shoulderMid.x) / shoulderWidth;

  // Sensitivity adjusts lateral thresholds — higher sensitivity = easier to trigger
  const lateralShoulderThresh = 0.20 / sensitivityFactor;
  const lateralNoseThresh = 0.30 / sensitivityFactor;

  if (shoulderDrop > lateralShoulderThresh || lateralNoseDrift > lateralNoseThresh) {
    return {
      yieldRatio,
      horizontalOffset,
      tiltAngle,
      pitchAngle,
      status: "Critical: Lateral Head Tilt",
      severity: "critical",
    };
  }

  // ── STATUS CLASSIFICATION ───────────────────────────────────────────────────
  let status = "Healthy";
  let severity: "healthy" | "mild" | "critical" = "healthy";

  if (baseline) {
    const yieldDeviation = ((yieldRatio - baseline.yieldRatio) / Math.abs(baseline.yieldRatio)) * 100;
    const tiltDeviation = tiltAngle - baseline.tiltAngle;

    // Apply sensitivity: tighter thresholds at high sensitivity
    // At sensitivity=1.0: critical at -35% / 25deg, mild at -22% / 18deg
    // At sensitivity=2.0: critical at -17.5% / 12.5deg (very tight)
    // At sensitivity=0.5: critical at -70% / 50deg (very loose)
    const criticalYield = -35 / sensitivityFactor;
    const criticalTilt = 25 / sensitivityFactor;
    const mildYield = -22 / sensitivityFactor;
    const mildTilt = 18 / sensitivityFactor;

    if (yieldDeviation < criticalYield || tiltDeviation > criticalTilt) {
      status = "Critical: Forward Head Posture";
      severity = "critical";
    } else if (yieldDeviation < mildYield || tiltDeviation > mildTilt) {
      status = "Mild: Forward Head Posture";
      severity = "mild";
    } else if (tiltDeviation < -criticalTilt) {
      // Head tilted too far BACK — excessive extension
      status = "Warning: Excessive Extension";
      severity = "mild";
    } else {
      status = "Healthy";
      severity = "healthy";
    }
  } else {
    // No baseline — absolute fallback
    const criticalTilt = 25 / sensitivityFactor;
    const mildTilt = 18 / sensitivityFactor;

    if (tiltAngle > criticalTilt) {
      status = "Critical: Forward Head Posture";
      severity = "critical";
    } else if (tiltAngle > mildTilt) {
      status = "Mild: Forward Head Posture";
      severity = "mild";
    }
    // NOTE: pitch angle detection for "Head Down" is intentionally disabled
    // because laptop camera angle makes it unreliable — will be re-enabled
    // after physiotherapist review of correct thresholds
  }

  return { yieldRatio, horizontalOffset, tiltAngle, pitchAngle, status, severity };
};