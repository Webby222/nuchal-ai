// PostureMath.ts — Nuchal AI

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
  baseline: PostureBaseline | null
): PostureMetrics => {

  // PRIORITY CHECK — visibility
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
      severity: "healthy"
    };
  }

  // Core measurements
  const shoulderMid = {
    x: (leftShoulder.x + rightShoulder.x) / 2,
    y: (leftShoulder.y + rightShoulder.y) / 2,
  };

  const shoulderWidth = Math.abs(leftShoulder.x - rightShoulder.x) || 0.001;

  // SIGNED yield ratio — positive = nose above shoulder (good)
  const yieldRatio = (shoulderMid.y - nose.y) / shoulderWidth;

  // Horizontal offset — nose drift from center
  const horizontalOffset = (nose.x - shoulderMid.x) / shoulderWidth;

  // SIGNED tilt — forward head = positive degrees
  const neckVec = {
    x: shoulderMid.x - nose.x,
    y: shoulderMid.y - nose.y
  };
  const tiltAngle = Math.atan2(neckVec.x, neckVec.y) * (180 / Math.PI);

  // SIGNED pitch — face up = positive, face down = negative
  const pitchVec = {
    x: forehead.x - chin.x,
    y: forehead.y - chin.y
  };
  const pitchAngle = Math.atan2(-pitchVec.y, pitchVec.x) * (180 / Math.PI) - 90;

  // PRIORITY CHECK — lateral tilt (clinical red flag)
  const shoulderDrop = Math.abs(leftShoulder.y - rightShoulder.y) / shoulderWidth;
  const lateralNoseDrift = Math.abs(nose.x - shoulderMid.x) / shoulderWidth;

  if (shoulderDrop > 0.20 || lateralNoseDrift > 0.30) {
    return {
      yieldRatio,
      horizontalOffset,
      tiltAngle,
      pitchAngle,
      status: "Critical: Lateral Head Tilt",
      severity: "critical"
    };
  }

  // Status classification
  let status = "Healthy";
  let severity: "healthy" | "mild" | "critical" = "healthy";

  if (baseline) {
    const yieldDeviation = ((yieldRatio - baseline.yieldRatio) / Math.abs(baseline.yieldRatio)) * 100;
    const tiltDeviation = tiltAngle - baseline.tiltAngle;

    if (yieldDeviation < -35 || tiltDeviation > 25) {
      status = "Critical: Forward Head Posture";
      severity = "critical";
    } else if (yieldDeviation < -22 || tiltDeviation > 18) {
      status = "Mild: Forward Head Posture";
      severity = "mild";
    } else if (pitchAngle > 28) {
      status = "Warning: Excessive Extension";
      severity = "mild";
    } else if (pitchAngle < -40) {
      status = "Warning: Head Down";
      severity = "mild";
    } else {
      status = "Healthy";
      severity = "healthy";
    }
  } else {
    // No baseline — absolute fallback
    if (tiltAngle > 25) {
      status = "Critical: Forward Head Posture";
      severity = "critical";
    } else if (tiltAngle > 18) {
      status = "Mild: Forward Head Posture";
      severity = "mild";
    }
  }

  return { yieldRatio, horizontalOffset, tiltAngle, pitchAngle, status, severity };
};