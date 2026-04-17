// posturemaths.ts
// Improved math for Nuchal AI (Nasal-Vertical Yield + Tilt/Pitch Angles)

export const calculatePostureMetrics = (
  nose: { x: number; y: number },
  chin: { x: number; y: number },
  forehead: { x: number; y: number },
  leftShoulder: { x: number; y: number },
  rightShoulder: { x: number; y: number }
) => {
  // 1. Shoulder midpoint
  const shoulderMid = {
    x: (leftShoulder.x + rightShoulder.x) / 2,
    y: (leftShoulder.y + rightShoulder.y) / 2,
  };

  // 2. Nasal yield ratio: vertical distance from nose to shoulder line, normalized by shoulder width
  const shoulderBaselineY = shoulderMid.y;
  const dy = shoulderBaselineY - nose.y;
  const shoulderWidth = Math.abs(leftShoulder.x - rightShoulder.x);
  const yieldRatio = dy / shoulderWidth;

  // 3. Tilt angle (nose → shoulders vs vertical)
  const neckVec = { x: shoulderMid.x - nose.x, y: shoulderMid.y - nose.y };
  const verticalRef = { x: 0, y: 1 };
  const tiltAngle =
    (Math.acos(
      (neckVec.x * verticalRef.x + neckVec.y * verticalRef.y) /
        (Math.hypot(neckVec.x, neckVec.y) * Math.hypot(verticalRef.x, verticalRef.y))
    ) *
      180) /
    Math.PI;

  // 4. Pitch angle (chin → forehead vs horizontal)
  const pitchVec = { x: forehead.x - chin.x, y: forehead.y - chin.y };
  const horizontalRef = { x: 1, y: 0 };
  const pitchAngle =
    (Math.acos(
      (pitchVec.x * horizontalRef.x + pitchVec.y * horizontalRef.y) /
        (Math.hypot(pitchVec.x, pitchVec.y) * Math.hypot(horizontalRef.x, horizontalRef.y))
    ) *
      180) /
    Math.PI;

  // 5. Classification
  let status = "Healthy";
  if (tiltAngle >= 10 && tiltAngle < 20) status = "Mild Forward Head Posture";
  else if (tiltAngle >= 20) status = "Critical Forward Head Posture";

  if (pitchAngle > 15) status = "Face-up tilt";
  else if (pitchAngle < -15) status = "Face-down tilt";

  return { yieldRatio, tiltAngle, pitchAngle, status };
};
