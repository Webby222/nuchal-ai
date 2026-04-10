// The Math behind Nuchal AI
export const calculateCVA = (ear: any, shoulder: any) => {
  const dy = shoulder.y - ear.y;
  const dx = shoulder.x - ear.x;
  
  // Calculate angle in radians then convert to degrees
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);
  
  return Math.round(angle);
};