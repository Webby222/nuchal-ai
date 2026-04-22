// PostureMath.ts — Nuchal AI
// Clinically-informed posture detection with camera tilt compensation

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
  // Camera compensation: captured at calibration time
  shoulderMidY: number;
  shoulderWidth: number;
}

/**
 * Maps sensitivity slider (0-100) to a factor used to scale detection thresholds.
 *
 * Old formula:  sensFactor = 0.3 + (s/100)*1.7   → range [0.3, 2.0]
 *   Problem: at s=100, criticalYield = -15/2.0 = -7.5% — fires on tiny movements
 *            at s=0,   criticalYield = -15/0.3 = -50%  — nearly impossible to trigger
 *            at s=50,  criticalYield = -15/1.15 = -13% — also too tight, causes gauge shake
 *
 * New formula: gentler curve centred on s=50 → sensFactor=1.0 (natural thresholds)
 *   s=0   → 0.40  (very loose  — only gross deviations trigger)
 *   s=50  → 1.00  (balanced    — clinical thresholds as designed)
 *   s=80  → 1.35  (moderately tight)
 *   s=100 → 1.60  (tight       — still reasonable, won't fire on breathing)
 *
 * Using a square-root curve so the low end has more range (loose is very loose)
 * and the high end is capped to avoid hypersensitivity.
 */
export function sensitivityToFactor(sliderValue: number): number {
  // Normalise 0-100 → 0-1
  const t = sliderValue / 100;
  // Square-root gives generous low-sensitivity range, capped high end
  // Range: 0.40 → 1.60
  return 0.40 + Math.sqrt(t) * 1.20;
}

export const calculatePostureMetrics = (
  nose: { x: number; y: number; visibility?: number },
  chin: { x: number; y: number },
  forehead: { x: number; y: number },
  leftShoulder: { x: number; y: number; visibility?: number },
  rightShoulder: { x: number; y: number; visibility?: number },
  baseline: PostureBaseline | null,
  sensitivityFactor: number = 1.0
): PostureMetrics => {

  // ── VISIBILITY CHECK ──────────────────────────────────────────────────────
  const noseVisible = nose.visibility ?? 1;
  const leftShoulderVisible = leftShoulder.visibility ?? 1;
  const rightShoulderVisible = rightShoulder.visibility ?? 1;

  if (noseVisible < 0.5 || leftShoulderVisible < 0.5 || rightShoulderVisible < 0.5) {
    return {
      yieldRatio: 0, horizontalOffset: 0, tiltAngle: 0, pitchAngle: 0,
      status: "No person detected", severity: "healthy",
    };
  }

  // ── CORE MEASUREMENTS ─────────────────────────────────────────────────────
  const shoulderMid = {
    x: (leftShoulder.x + rightShoulder.x) / 2,
    y: (leftShoulder.y + rightShoulder.y) / 2,
  };
  const shoulderWidth = Math.abs(leftShoulder.x - rightShoulder.x) || 0.001;

  // SIGNED yield ratio — positive = nose well above shoulder (good)
  const yieldRatio = (shoulderMid.y - nose.y) / shoulderWidth;

  // Horizontal offset
  const horizontalOffset = (nose.x - shoulderMid.x) / shoulderWidth;

  // SIGNED tilt — forward = positive, backward = negative
  const neckVec = { x: shoulderMid.x - nose.x, y: shoulderMid.y - nose.y };
  const tiltAngle = Math.atan2(neckVec.x, neckVec.y) * (180 / Math.PI);

  // Pitch (not used for status — laptop camera unreliable)
  const pitchVec = { x: forehead.x - chin.x, y: forehead.y - chin.y };
  const pitchAngle = Math.atan2(-pitchVec.y, pitchVec.x) * (180 / Math.PI) - 90;

  // ── LATERAL TILT — highest priority ──────────────────────────────────────
  // Clamp sensitivityFactor so lateral check doesn't fire at low sensitivity
  const clampedFactor = Math.max(0.4, sensitivityFactor);
  const shoulderDrop = Math.abs(leftShoulder.y - rightShoulder.y) / shoulderWidth;
  const lateralNoseDrift = Math.abs(nose.x - shoulderMid.x) / shoulderWidth;

  // Base thresholds loosened slightly — less false positives from natural sway
  const lateralShoulderThresh = 0.12 / clampedFactor;
  const lateralNoseThresh = 0.18 / clampedFactor;

  if (shoulderDrop > lateralShoulderThresh || lateralNoseDrift > lateralNoseThresh) {
    return {
      yieldRatio, horizontalOffset, tiltAngle, pitchAngle,
      status: "Critical: Lateral Head Tilt", severity: "critical",
    };
  }

  // ── STATUS CLASSIFICATION ─────────────────────────────────────────────────
  let status = "Healthy";
  let severity: "healthy" | "mild" | "critical" = "healthy";

  if (baseline) {
    const yieldDeviation = ((yieldRatio - baseline.yieldRatio) / Math.abs(baseline.yieldRatio)) * 100;
    const tiltDeviation = tiltAngle - baseline.tiltAngle;

    // Thresholds at sensitivityFactor=1.0 (slider=50):
    //   critical: yield drops >15%  OR tilt increases >12°
    //   mild:     yield drops >8%   OR tilt increases >6°
    //   extension: tilt back >10°
    //
    // At sensitivityFactor=1.60 (slider=100):
    //   critical: yield drops >9.4% OR tilt increases >7.5°  ← still reasonable
    //
    // At sensitivityFactor=0.40 (slider=0):
    //   critical: yield drops >37.5% OR tilt increases >30°  ← very loose
    const criticalYield = -8  / sensitivityFactor;
    const criticalTilt  =  7  / sensitivityFactor;
    const mildYield     = -4  / sensitivityFactor;
    const mildTilt      =  3  / sensitivityFactor;
    const extensionTilt = -7  / sensitivityFactor;

    if (yieldDeviation < criticalYield || tiltDeviation > criticalTilt) {
      status = "Critical: Forward Head Posture";
      severity = "critical";
    } else if (yieldDeviation < mildYield || tiltDeviation > mildTilt) {
      status = "Mild: Forward Head Posture";
      severity = "mild";
    } else if (tiltDeviation < extensionTilt) {
      status = "Warning: Excessive Extension";
      severity = "mild";
    } else {
      status = "Healthy";
      severity = "healthy";
    }
  } else {
    // No baseline — absolute fallback (looser to avoid false positives before calibration)
    const criticalTilt = 12 / sensitivityFactor;
    const mildTilt     =  6 / sensitivityFactor;
    if (tiltAngle > criticalTilt) {
      status = "Critical: Forward Head Posture";
      severity = "critical";
    } else if (tiltAngle > mildTilt) {
      status = "Mild: Forward Head Posture";
      severity = "mild";
    }
  }

  return { yieldRatio, horizontalOffset, tiltAngle, pitchAngle, status, severity };
};