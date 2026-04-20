import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PoseLandmarker, FilesetResolver, DrawingUtils } from "@mediapipe/tasks-vision";
import { calculatePostureMetrics, PostureBaseline } from "./PostureMath";

interface PostureData {
  ves_ratio: number;
  tilt_angle: number;
  pitch_angle: number;
  horizontal_offset: number;
  is_centered: boolean;
}

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  bg:         "#0f1623",
  surface:    "#151d2e",
  surfaceAlt: "#1a2438",
  border:     "#232f45",
  text:       "#e2e8f0",
  textMid:    "#7a90b0",
  textDim:    "#3d5070",
  healthy:    "#2ecc87",
  warning:    "#f0a500",
  critical:   "#e84040",
  accent:     "#3b8beb",
  accentSoft: "#1e3a5f",
};

// ── Toggle ────────────────────────────────────────────────────────────────────
function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div onClick={() => onChange(!checked)} style={{
      width: 40, height: 22, borderRadius: 11, cursor: "pointer", flexShrink: 0,
      background: checked ? C.accent : C.surfaceAlt,
      border: `1px solid ${checked ? C.accent : C.border}`,
      position: "relative", transition: "all .2s",
    }}>
      <div style={{
        position: "absolute", top: 2, left: checked ? 19 : 2,
        width: 16, height: 16, borderRadius: "50%",
        background: checked ? "#fff" : C.textDim,
        transition: "left .2s",
      }} />
    </div>
  );
}

const TREND_LEN = 120;
const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function App() {
  const [page, setPage] = useState<"posture" | "focus">("posture");

  // posture
  const [baseline, setBaseline] = useState<PostureBaseline | null>(null);
  const [currentVes, setCurrentVes] = useState(0);
  const [currentTilt, setCurrentTilt] = useState(0);
  const [statusText, setStatusText] = useState("Awaiting calibration");
  const [severity, setSeverity] = useState<"healthy" | "mild" | "critical">("healthy");
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [calibCount, setCalibCount] = useState(0);
  const [showBanner, setShowBanner] = useState(true);
  const [postureScore, setPostureScore] = useState(100);
  const scoreFrames = useRef({ good: 0, total: 0 });
  const [trendData, setTrendData] = useState<number[]>(Array(TREND_LEN).fill(100));
  const [riskPct, setRiskPct] = useState(0);
  const riskFrames = useRef({ bad: 0, total: 0 });

  // config
  const [blurThreshold, setBlurThreshold] = useState(45);
  const [sensitivity, setSensitivity] = useState(50);
  const [screenBlur, setScreenBlur] = useState(false);
  const [gentleAlert, setGentleAlert] = useState(true);
  const [aggressiveBlur, setAggressiveBlur] = useState(false);
  const [popupAlert, setPopupAlert] = useState(false);
  const [soundAlert, setSoundAlert] = useState(false);
  const [breakUrgency, setBreakUrgency] = useState(50);
  const [masterSwitch, setMasterSwitch] = useState(false);

  // focus
  const [focusMinutes, setFocusMinutes] = useState(105);
  const [breakMinutes, setBreakMinutes] = useState(30);
  const [focusRunning, setFocusRunning] = useState(false);
  const [focusRemaining, setFocusRemaining] = useState(105 * 60);
  const [sessionHours] = useState([2.1, 2.5, 6.2, 3.8, 5.5, 2.5, 6.1]);

  // refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isCalibratingRef = useRef(false);
  const baselineRef = useRef<PostureBaseline | null>(null);
  const calibFrames = useRef<{ yieldRatio: number; horizontalOffset: number; tiltAngle: number }[]>([]);
  const focusTimer = useRef<any>(null);

  useEffect(() => { isCalibratingRef.current = isCalibrating; }, [isCalibrating]);
  useEffect(() => { baselineRef.current = baseline; }, [baseline]);

  useEffect(() => {
    if (focusRunning) {
      focusTimer.current = setInterval(() => {
        setFocusRemaining(r => { if (r <= 1) { setFocusRunning(false); return 0; } return r - 1; });
      }, 1000);
    } else clearInterval(focusTimer.current);
    return () => clearInterval(focusTimer.current);
  }, [focusRunning]);

  const fmtTime = (s: number) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h > 0
      ? `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`
      : `${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
  };

  const processFrame = useCallback(async (landmarks: any) => {
    try {
      const nV = landmarks[0]?.visibility ?? 0;
      const lV = landmarks[11]?.visibility ?? 0;
      const rV = landmarks[12]?.visibility ?? 0;
      if (nV < 0.5 || lV < 0.5 || rV < 0.5) {
        setStatusText("No person detected");
        setSeverity("healthy");
        return;
      }

      const data: PostureData = await invoke("analyze_posture", { landmarks });
      const metrics = calculatePostureMetrics(
        landmarks[0],
        landmarks[152] || landmarks[1],
        landmarks[10] || landmarks[4],
        landmarks[11],
        landmarks[12],
        baselineRef.current
      );

      setCurrentVes(metrics.yieldRatio);
      setCurrentTilt(metrics.tiltAngle);
      setStatusText(metrics.status);
      setSeverity(metrics.severity);

      // rolling risk — updates every 30 frames
      riskFrames.current.total++;
      if (metrics.severity !== "healthy") riskFrames.current.bad++;
      if (riskFrames.current.total % 30 === 0) {
        setRiskPct(Math.min(99, Math.round(
          (riskFrames.current.bad / riskFrames.current.total) * 100 * 1.3
        )));
      }

      // rolling session score — updates every 30 frames
      scoreFrames.current.total++;
      if (metrics.severity === "healthy") scoreFrames.current.good++;
      if (scoreFrames.current.total % 30 === 0) {
        setPostureScore(Math.round(
          (scoreFrames.current.good / scoreFrames.current.total) * 100
        ));
      }

      // trend
      const stab = baselineRef.current
        ? Math.max(0, Math.min(200, (metrics.yieldRatio / baselineRef.current.yieldRatio) * 100))
        : 100;
      setTrendData(prev => [...prev.slice(1), stab]);

      // calibration
      if (isCalibratingRef.current && data.is_centered) {
        calibFrames.current.push({
          yieldRatio: metrics.yieldRatio,
          horizontalOffset: metrics.horizontalOffset,
          tiltAngle: metrics.tiltAngle,
        });
        setCalibCount(calibFrames.current.length);
        if (calibFrames.current.length >= 60) {
          const f = calibFrames.current;
          const avg = (k: keyof typeof f[0]) => f.reduce((a, b) => a + b[k], 0) / f.length;
          setBaseline({ yieldRatio: avg("yieldRatio"), horizontalOffset: avg("horizontalOffset"), tiltAngle: avg("tiltAngle") });
          setIsCalibrating(false);
          calibFrames.current = [];
          setCalibCount(0);
          scoreFrames.current = { good: 0, total: 0 };
          riskFrames.current = { bad: 0, total: 0 };
        }
      }
    } catch (err) { console.error("Bridge:", err); }
  }, []);

  useEffect(() => {
    const start = async () => {
      if (!videoRef.current || !canvasRef.current) return;
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm"
      );
      const pl = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
          delegate: "GPU",
        },
        runningMode: "VIDEO", numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      const ctx = canvasRef.current.getContext("2d")!;
      const du = new DrawingUtils(ctx);
      let lastTime = -1;
      const detect = () => {
        if (!videoRef.current || !canvasRef.current) return;
        const v = videoRef.current;
        if (v.currentTime !== lastTime) {
          lastTime = v.currentTime;
          const res = pl.detectForVideo(v, performance.now());
          ctx.save();
          ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
          if (res.landmarks?.length > 0) {
            du.drawConnectors(res.landmarks[0], PoseLandmarker.POSE_CONNECTIONS, { color: "#3b8beb55", lineWidth: 1 });
            du.drawLandmarks(res.landmarks[0], { color: "#3b8beb", radius: 2 });
            processFrame(res.landmarks[0]);
          } else {
            setStatusText("No person detected");
            setSeverity("healthy");
          }
          ctx.restore();
        }
        requestAnimationFrame(detect);
      };
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
      videoRef.current.srcObject = stream;
      videoRef.current.onloadeddata = () => detect();
    };
    start();
    return () => {
      if (videoRef.current?.srcObject)
        (videoRef.current.srcObject as MediaStream).getTracks().forEach(t => t.stop());
    };
  }, [processFrame]);

  // derived
  const displayStatus = isCalibrating ? "CALIBRATING"
    : !baseline ? "READY"
    : severity === "critical" ? "CRITICAL"
    : severity === "mild" ? "WARNING"
    : "HEALTHY";

  const sColor = displayStatus === "CRITICAL" ? C.critical
    : displayStatus === "WARNING" ? C.warning
    : displayStatus === "HEALTHY" ? C.healthy
    : C.textMid;

  const stabilityPct = baseline
    ? Math.max(0, Math.min(200, (currentVes / baseline.yieldRatio) * 100))
    : 100;

  // stability color — sweet spot 85-115 green, outside = warn/critical
  const stabColor = stabilityPct >= 85 && stabilityPct <= 115 ? C.healthy
    : stabilityPct >= 70 && stabilityPct <= 130 ? C.warning
    : C.critical;

  const needleDeg = ((stabilityPct / 200) * 180) - 90;

  // CVA scaled to clinical range (multiply raw tilt for meaningful display)
  const cvaDisplay = Math.min(90, Math.abs(currentTilt) * 3).toFixed(1);
  const flexionDisplay = Math.min(90, Math.abs(currentTilt) * 4).toFixed(0);

  // sparkline
  const sparkPath = trendData.map((v, i) => {
    const x = (i / (TREND_LEN - 1)) * 280;
    const y = 50 - ((Math.min(v, 200) / 200) * 46);
    return `${i === 0 ? "M" : "L"} ${x} ${y}`;
  }).join(" ");


  const avgUsage = (sessionHours.reduce((a, b) => a + b) / 7).toFixed(1);
  const FOCUS_R = 108;
  const FOCUS_CIRC = 2 * Math.PI * FOCUS_R;
  const focusPct = focusRemaining / (focusMinutes * 60);

  const card = (extra?: React.CSSProperties): React.CSSProperties => ({
    background: C.surface,
    borderRadius: 14,
    border: `1px solid ${C.border}`,
    padding: 18,
    ...extra,
  });

  return (
    <div style={{
      background: C.bg,
      minHeight: "100vh",
      color: C.text,
      fontFamily: "'DM Sans', 'Nunito', 'Segoe UI', sans-serif",
      fontSize: 13,
      padding: "14px 18px",
      userSelect: "none",
    }}>

      {/* Aggressive blur overlay */}
      {aggressiveBlur && masterSwitch && severity === "critical" && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 999,
          backdropFilter: "blur(18px)",
          background: "rgba(232,64,64,0.07)",
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", gap: 12,
        }}>
          <div style={{ fontSize: 36 }}>⚠️</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.critical }}>POSTURE ALERT</div>
          <div style={{ color: C.textMid, fontSize: 12 }}>Sit up straight to restore your screen</div>
        </div>
      )}

      {/* NAV */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 30, height: 30, borderRadius: 8,
            background: C.accent, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15,
          }}>🦴</div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Nuchal <span style={{ color: C.accent }}>AI</span></div>
            <div style={{ fontSize: 10, color: C.textDim }}>Posture Guardian</div>
          </div>
        </div>

        <div style={{ display: "flex", background: C.surfaceAlt, borderRadius: 10, padding: 3, gap: 2 }}>
          {(["posture", "focus"] as const).map(p => (
            <button key={p} onClick={() => setPage(p)} style={{
              padding: "5px 20px", borderRadius: 8, border: "none", cursor: "pointer",
              fontFamily: "inherit", fontSize: 12, fontWeight: 600,
              background: page === p ? C.accent : "transparent",
              color: page === p ? "#fff" : C.textMid,
              transition: "all .18s",
            }}>
              {p === "posture" ? "Posture" : "Focus & Breaks"}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: C.textDim }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: C.healthy }} />
          Local · Private
        </div>
      </div>

      {/* Banner */}
      {showBanner && (
        <div style={{
          background: C.accentSoft, border: `1px solid ${C.accent}33`,
          borderRadius: 9, padding: "7px 14px", marginBottom: 12,
          display: "flex", justifyContent: "space-between", alignItems: "center",
          fontSize: 11, color: "#7ab3e0",
        }}>
          <span>ℹ️ &nbsp;Nuchal AI is running locally. Your data is private and secure.</span>
          <button onClick={() => setShowBanner(false)} style={{
            background: "none", border: "none", color: C.textMid, cursor: "pointer", fontSize: 15,
          }}>×</button>
        </div>
      )}

      {/* ── PAGE 1: POSTURE ──────────────────────────────────────────────────── */}
      {page === "posture" && (
        <div style={{ display: page === "posture" ? "grid" : "none", gridTemplateColumns: "1fr 1.5fr 0.85fr", gap: 12 }}>

          {/* LEFT */}
          <div style={card({ display: "flex", flexDirection: "column", gap: 12 })}>
            <div style={{
              position: "relative", width: "100%", aspectRatio: "4/3",
              background: "#000", borderRadius: 10, overflow: "hidden",
              border: `1px solid ${sColor}44`,
            }}>
              <video ref={videoRef} autoPlay playsInline muted
                style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" }} />
              <canvas ref={canvasRef} width="1280" height="720" style={{
                position: "absolute", inset: 0, width: "100%", height: "100%", transform: "scaleX(-1)",
              }} />
              {["tl","tr","bl","br"].map(c => (
                <div key={c} style={{
                  position: "absolute",
                  top: c[0]==="t" ? 7 : "auto", bottom: c[0]==="b" ? 7 : "auto",
                  left: c[1]==="l" ? 7 : "auto", right: c[1]==="r" ? 7 : "auto",
                  width: 14, height: 14,
                  borderTop: c[0]==="t" ? `2px solid ${sColor}` : "none",
                  borderBottom: c[0]==="b" ? `2px solid ${sColor}` : "none",
                  borderLeft: c[1]==="l" ? `2px solid ${sColor}` : "none",
                  borderRight: c[1]==="r" ? `2px solid ${sColor}` : "none",
                  opacity: 0.7,
                }} />
              ))}
            </div>

            <div style={{
              background: `${sColor}14`, border: `1px solid ${sColor}33`,
              borderRadius: 8, padding: "9px 13px",
              display: "flex", justifyContent: "space-between", alignItems: "center",
            }}>
              <div>
                <div style={{ fontSize: 9, color: C.textDim, letterSpacing: 1, marginBottom: 2 }}>CURRENT STATUS</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: sColor }}>{displayStatus}</div>
              </div>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: sColor }} />
            </div>

            <div style={{ fontSize: 11, color: C.textMid, textAlign: "center" }}>{statusText}</div>

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.textDim, marginBottom: 5 }}>
                <span>SESSION SCORE</span>
                <span style={{ color: postureScore > 70 ? C.healthy : postureScore > 40 ? C.warning : C.critical, fontWeight: 600 }}>
                  {postureScore}%
                </span>
              </div>
              <div style={{ height: 5, background: C.surfaceAlt, borderRadius: 3, overflow: "hidden" }}>
                <div style={{
                  height: "100%", borderRadius: 3, width: `${postureScore}%`,
                  background: postureScore > 70 ? C.healthy : postureScore > 40 ? C.warning : C.critical,
                  transition: "width .8s ease",
                }} />
              </div>
              <div style={{ fontSize: 9, color: C.textDim, marginTop: 4 }}>Rolling average · resets on recalibrate</div>
            </div>
          </div>

          {/* CENTER */}
          <div style={card({ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 })}>
            <div style={{ fontSize: 10, color: C.textDim, letterSpacing: 2, alignSelf: "flex-start" }}>HEALTH METER</div>

            <div style={{ position: "relative", width: 300, height: 175 }}>
              <svg width="300" height="175" viewBox="0 0 300 175">
                {/* Full background arc */}
                <path d="M 20 155 A 130 130 0 0 1 280 155"
                  fill="none" stroke={C.surfaceAlt} strokeWidth="18" strokeLinecap="round" />
                {/* RED left zone */}
                <path d="M 20 155 A 130 130 0 0 1 68 52"
                  fill="none" stroke={C.critical} strokeWidth="18" strokeLinecap="butt" />
                {/* YELLOW left zone */}
                <path d="M 68 52 A 130 130 0 0 1 120 20"
                  fill="none" stroke={C.warning} strokeWidth="18" strokeLinecap="butt" />
                {/* GREEN center zone */}
                <path d="M 120 20 A 130 130 0 0 1 180 20"
                  fill="none" stroke={C.healthy} strokeWidth="18" strokeLinecap="butt" />
                {/* YELLOW right zone */}
                <path d="M 180 20 A 130 130 0 0 1 232 52"
                  fill="none" stroke={C.warning} strokeWidth="18" strokeLinecap="butt" />
                {/* RED right zone */}
                <path d="M 232 52 A 130 130 0 0 1 280 155"
                  fill="none" stroke={C.critical} strokeWidth="18" strokeLinecap="butt" />

                {/* CVA values on left and right of gauge */}
                <text x="18" y="172" fill={C.textMid} fontSize="11" fontFamily="sans-serif" fontWeight="600">{cvaDisplay}°</text>
                <text x="268" y="172" fill={C.textMid} fontSize="11" fontFamily="sans-serif" fontWeight="600" textAnchor="end">
                  {(parseFloat(cvaDisplay) * 0.92).toFixed(1)}°
                </text>

                {/* Needle — from bottom center */}
                <g transform={`rotate(${needleDeg}, 150, 155)`}>
                  <line x1="150" y1="155" x2="150" y2="42"
                    stroke="#c8d8e8" strokeWidth="2" strokeLinecap="round" />
                  <circle cx="150" cy="155" r="8" fill={C.surface} stroke="#c8d8e8" strokeWidth="2" />
                  <circle cx="150" cy="155" r="4" fill="#c8d8e8" />
                </g>
              </svg>

              {/* Center CVA readout */}
              <div style={{ position: "absolute", bottom: 28, left: "50%", transform: "translateX(-50%)", textAlign: "center" }}>
                <div style={{ fontSize: 32, fontWeight: 700, color: stabColor, lineHeight: 1, letterSpacing: -1 }}>
                  {cvaDisplay}°
                </div>
                <div style={{ fontSize: 10, color: C.textMid, letterSpacing: 1, marginTop: 2 }}>CURRENT CVA</div>
              </div>
            </div>

            {/* Health Meter label */}
            <div style={{ fontSize: 11, color: C.textMid, letterSpacing: 1, marginTop: -4 }}>Health Meter</div>

            {/* Stat row */}
            <div style={{
              display: "flex", width: "100%",
              background: C.surfaceAlt, borderRadius: 9,
              border: `1px solid ${C.border}`, overflow: "hidden",
            }}>
              {[
                { label: "Stability", value: `${stabilityPct.toFixed(1)}%`, color: stabColor },
                { label: "NVY Ratio", value: currentVes.toFixed(3), color: C.text },
                { label: "Baseline", value: baseline ? baseline.yieldRatio.toFixed(2) : "—", color: C.textMid },
              ].map((s, i) => (
                <div key={s.label} style={{
                  flex: 1, padding: "10px 6px", textAlign: "center",
                  borderRight: i < 2 ? `1px solid ${C.border}` : "none",
                }}>
                  <div style={{ fontSize: 9, color: C.textDim, marginBottom: 3, letterSpacing: 1 }}>{s.label.toUpperCase()}</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: s.color }}>{s.value}</div>
                </div>
              ))}
            </div>

            <button
              onClick={() => { setIsCalibrating(true); calibFrames.current = []; setCalibCount(0); }}
              style={{
                background: isCalibrating ? C.surfaceAlt : C.accent,
                color: isCalibrating ? C.accent : "#fff",
                border: `1px solid ${isCalibrating ? C.accent : "transparent"}`,
                padding: "9px 28px", borderRadius: 8, cursor: "pointer",
                fontFamily: "inherit", fontSize: 12, fontWeight: 600, transition: "all .2s",
              }}>
              {isCalibrating ? `Calibrating… ${calibCount}/60` : baseline ? "Recalibrate" : "Calibrate Baseline"}
            </button>

            {/* Bottom 3 panels */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, width: "100%" }}>

              {/* Risk Probability — bar chart matching reference */}
              <div style={{ background: C.surfaceAlt, borderRadius: 10, padding: "10px 10px 8px", border: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 10, color: C.textMid, marginBottom: 6, fontWeight: 600 }}>Risk Probability (Y)</div>
                <div style={{ position: "relative", height: 60 }}>
                  {/* Y axis labels */}
                  {[0, 20, 40].map(v => (
                    <div key={v} style={{
                      position: "absolute", left: 0, bottom: (v / 40) * 52,
                      fontSize: 7, color: C.textDim, lineHeight: 1,
                    }}>{v}%</div>
                  ))}
                  {/* Bars */}
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 52, paddingLeft: 18 }}>
                    {[
                      { l: "Low", col: C.healthy, h: riskPct < 25 ? Math.max(4, riskPct * 2) : 30 },
                      { l: "Low", col: C.healthy, h: riskPct < 50 ? Math.max(4, (riskPct - 10) * 1.5) : 22 },
                      { l: "Rlt", col: C.warning, h: riskPct > 50 ? Math.max(4, (riskPct - 30) * 1.2) : 8 },
                      { l: "High", col: C.critical, h: riskPct > 70 ? Math.max(4, (riskPct - 50) * 1.8) : 5 },
                    ].map(({ l, col, h }, i) => (
                      <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, flex: 1 }}>
                        <div style={{ width: "100%", height: Math.min(48, h), background: col, borderRadius: "2px 2px 0 0", transition: "height .6s" }} />
                        <div style={{ fontSize: 7, color: C.textDim }}>{l}</div>
                      </div>
                    ))}
                  </div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, color: riskPct > 60 ? C.critical : riskPct > 30 ? C.warning : C.healthy, textAlign: "center", marginTop: 2 }}>
                  {riskPct}%
                </div>
              </div>

              {/* Flexion Angle — solid block matching reference */}
              <div style={{ background: C.surfaceAlt, borderRadius: 10, padding: "10px 10px 8px", border: `1px solid ${C.border}`, textAlign: "center" }}>
                <div style={{ fontSize: 10, color: C.textMid, marginBottom: 6, fontWeight: 600 }}>Flexion Angle</div>
                <div style={{ height: 60, display: "flex", alignItems: "flex-end", justifyContent: "center", paddingBottom: 14 }}>
                  <div style={{
                    width: "60%",
                    height: Math.max(8, Math.min(44, parseFloat(flexionDisplay) * 1.5)),
                    background: parseFloat(flexionDisplay) > 25 ? C.critical : parseFloat(flexionDisplay) > 12 ? C.warning : C.healthy,
                    borderRadius: "3px 3px 0 0",
                    transition: "all .5s",
                  }} />
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginTop: -8 }}>{flexionDisplay}°</div>
              </div>

              {/* Real-Time CVA Trend — wave line with Danger Zone label */}
              <div style={{ background: C.surfaceAlt, borderRadius: 10, padding: "10px 10px 8px", border: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 10, color: C.textMid, marginBottom: 4, fontWeight: 600 }}>Real-Time CVA Trend</div>
                <div style={{ position: "relative" }}>
                  <svg width="100%" height="56" viewBox="0 0 280 56" preserveAspectRatio="none">
                    <defs>
                      <linearGradient id="tg2" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={C.healthy} stopOpacity="0.3" />
                        <stop offset="100%" stopColor={C.healthy} stopOpacity="0.05" />
                      </linearGradient>
                    </defs>
                    {/* Sweet zone background */}
                    <rect x="0" y="8" width="280" height="36" fill={`${C.healthy}08`} />
                    {/* Top danger — extension */}
                    <rect x="0" y="0" width="280" height="8" fill={`${C.critical}25`} />
                    {/* Bottom danger — slump */}
                    <rect x="0" y="46" width="280" height="10" fill={`${C.critical}25`} />
                    {/* Area fill */}
                    <path d={sparkPath + " L 280 56 L 0 56 Z"} fill="url(#tg2)" />
                    {/* Line */}
                    <path d={sparkPath} fill="none" stroke={C.healthy} strokeWidth="2" />
                  </svg>
                  {/* Danger Zone label at bottom */}
                  <div style={{ fontSize: 8, color: C.critical, textAlign: "right", marginTop: 2, opacity: 0.7 }}>
                    Danger Zone
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* RIGHT */}
          <div style={card({ display: "flex", flexDirection: "column", gap: 14 })}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.text }}>Configuration</div>

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.textMid, marginBottom: 5 }}>
                <span>Sensitivity</span><span style={{ color: C.accent }}>{sensitivity}%</span>
              </div>
              <input type="range" min="0" max="100" value={sensitivity}
                onChange={e => setSensitivity(+e.target.value)} style={{ width: "100%", accentColor: C.accent }} />
            </div>

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.textMid, marginBottom: 5 }}>
                <span>Blur Threshold</span><span style={{ color: C.accent }}>{blurThreshold}°</span>
              </div>
              <input type="range" min="0" max="90" value={blurThreshold}
                onChange={e => setBlurThreshold(+e.target.value)} style={{ width: "100%", accentColor: C.accent }} />
            </div>

            <div style={{ height: 1, background: C.border }} />

            <div>
              <div style={{ fontSize: 10, color: C.textMid, marginBottom: 7 }}>Cervical Reset Timer</div>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <div style={{
                  flex: 1, background: C.surfaceAlt, borderRadius: 7, padding: "7px 10px",
                  border: `1px solid ${C.border}`, fontSize: 18, fontWeight: 700,
                  color: C.accent, textAlign: "center", letterSpacing: 2,
                }}>
                  {String(Math.floor(breakMinutes / 60)).padStart(2,"0")}:{String(breakMinutes % 60).padStart(2,"0")}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {["▲","▼"].map((a, i) => (
                    <button key={a} onClick={() => setBreakMinutes(m => i === 0 ? Math.min(120, m+5) : Math.max(5, m-5))}
                      style={{ background: C.surfaceAlt, border: `1px solid ${C.border}`, color: C.textMid, borderRadius: 4, width: 26, height: 20, cursor: "pointer", fontSize: 10 }}>
                      {a}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ fontSize: 9, color: C.textDim, marginTop: 4 }}>Break every {breakMinutes} min</div>
            </div>

            <div style={{ height: 1, background: C.border }} />

            <div>
              <div style={{ fontSize: 10, color: C.textMid, marginBottom: 8 }}>Alert Type</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                {[
                  { l: "Gentle Notification", v: gentleAlert, s: setGentleAlert },
                  { l: "Aggressive Screen Blur", v: aggressiveBlur, s: setAggressiveBlur },
                ].map(({ l, v, s }) => (
                  <div key={l} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 11, color: C.textMid }}>{l}</span>
                    <Toggle checked={v} onChange={s} />
                  </div>
                ))}
              </div>
            </div>

            <div style={{ height: 1, background: C.border }} />

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 11, color: C.textMid }}>Screen Blur Active</span>
              <Toggle checked={screenBlur} onChange={setScreenBlur} />
            </div>

            <button onClick={() => setPage("focus")} style={{
              marginTop: "auto", background: C.surfaceAlt,
              border: `1px solid ${C.border}`, color: C.textMid,
              padding: "8px", borderRadius: 8, cursor: "pointer",
              fontFamily: "inherit", fontSize: 11, fontWeight: 600,
            }}>
              Focus & Break Settings →
            </button>
          </div>
        </div>
      )}

      {/* ── PAGE 2: FOCUS ──────────────────────────────────────────────────────── */}
      {page === "focus" && (
        <div style={{ display: page === "focus" ? "grid" : "none", gridTemplateColumns: "1fr 1.2fr 0.9fr", gap: 12 }}>

          {/* Analytics */}
          <div style={card()}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.text, marginBottom: 14 }}>Analytics & History</div>

            {/* Line chart */}
            <div style={{ position: "relative", height: 120, marginBottom: 8 }}>
              {/* Y axis labels */}
              {[0, 2.5, 5, 7].map(v => (
                <div key={v} style={{
                  position: "absolute", left: 0, bottom: (v / 7) * 100 - 6,
                  fontSize: 8, color: C.textDim, width: 24, textAlign: "right",
                }}>{v}h</div>
              ))}
              <svg width="100%" height="110" viewBox="0 0 260 110" preserveAspectRatio="none"
                style={{ marginLeft: 28, width: "calc(100% - 28px)" }}>
                <defs>
                  <linearGradient id="lineGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={C.healthy} stopOpacity="0.3" />
                    <stop offset="100%" stopColor={C.healthy} stopOpacity="0" />
                  </linearGradient>
                </defs>
                {/* 2.5h danger line */}
                <line x1="0" y1={110 - (2.5/7)*100} x2="260" y2={110 - (2.5/7)*100}
                  stroke={C.critical} strokeWidth="1" strokeDasharray="4 3" opacity="0.5" />

                {/* Area fill under line */}
                <path d={
                  sessionHours.map((h, i) => {
                    const x = (i / 6) * 250 + 5;
                    const y = 110 - (h / 7) * 100;
                    return `${i === 0 ? "M" : "L"} ${x} ${y}`;
                  }).join(" ") + ` L ${5 + (6/6)*250} 110 L 5 110 Z`
                } fill="url(#lineGrad)" />

                {/* Line */}
                <path d={
                  sessionHours.map((h, i) => {
                    const x = (i / 6) * 250 + 5;
                    const y = 110 - (h / 7) * 100;
                    return `${i === 0 ? "M" : "L"} ${x} ${y}`;
                  }).join(" ")
                } fill="none" stroke={C.healthy} strokeWidth="2" />

                {/* Dots */}
                {sessionHours.map((h, i) => {
                  const x = (i / 6) * 250 + 5;
                  const y = 110 - (h / 7) * 100;
                  return <circle key={i} cx={x} cy={y} r="4"
                    fill={h > 5 ? C.critical : h > 3.5 ? C.warning : C.healthy}
                    stroke={C.surface} strokeWidth="1.5" />;
                })}

                {/* X axis labels */}
                {days.map((d, i) => (
                  <text key={d} x={(i/6)*250+5} y="110" fill={C.textDim} fontSize="8"
                    fontFamily="sans-serif" textAnchor="middle" dy="0">{d}</text>
                ))}
              </svg>
            </div>

            <div style={{ fontSize: 9, color: C.textDim, textAlign: "center", marginBottom: 10 }}>Last 7 Days</div>

            <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
              <div style={{ fontSize: 11, color: C.textMid }}>Avg. Daily Usage:</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: parseFloat(avgUsage) > 4 ? C.critical : C.healthy }}>
                {Math.floor(parseFloat(avgUsage))}h {Math.round((parseFloat(avgUsage) % 1) * 60)}m
              </div>
              <div style={{ fontSize: 11, color: C.textMid }}>
                (Trend: <span style={{ color: parseFloat(avgUsage) > 4 ? C.critical : C.healthy, fontWeight: 700 }}>
                  {parseFloat(avgUsage) > 4 ? "High" : "Normal"}
                </span>)
              </div>
            </div>
          </div>

          {/* Focus timer */}
          <div style={card({ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 })}>
            <div style={{ fontSize: 10, color: C.textDim, letterSpacing: 2 }}>SET FOCUS LIMIT</div>

            <div style={{ position: "relative", width: 240, height: 240 }}>
              <svg width="240" height="240" viewBox="0 0 240 240">
                {/* Dark circle background */}
                <circle cx="120" cy="120" r="115" fill="#0a0f1a" />
                <circle cx="120" cy="120" r="115" fill="none" stroke="#1a2438" strokeWidth="1" />

                {/* Gold/amber tick marks around edge */}
                {Array.from({ length: 60 }).map((_, i) => {
                  const a = (i / 60) * 2 * Math.PI - Math.PI / 2;
                  const isMajor = i % 5 === 0;
                  const r1 = 108, r2 = isMajor ? 96 : 102;
                  return <line key={i}
                    x1={120 + r1 * Math.cos(a)} y1={120 + r1 * Math.sin(a)}
                    x2={120 + r2 * Math.cos(a)} y2={120 + r2 * Math.sin(a)}
                    stroke={isMajor ? "#c8a84b" : "#5a4a20"}
                    strokeWidth={isMajor ? 2 : 1} />;
                })}

                {/* Track ring */}
                <circle cx="120" cy="120" r={FOCUS_R} fill="none" stroke="#1a2438" strokeWidth="8" />

                {/* Progress arc — green glow */}
                <circle cx="120" cy="120" r={FOCUS_R} fill="none"
                  stroke={C.healthy} strokeWidth="8" strokeLinecap="round"
                  strokeDasharray={FOCUS_CIRC}
                  strokeDashoffset={FOCUS_CIRC * (1 - focusPct)}
                  transform="rotate(-90 120 120)"
                  style={{ transition: "stroke-dashoffset 1s linear", filter: "drop-shadow(0 0 4px #2ecc87)" }} />

                {/* Progress dot */}
                {(() => {
                  const a = (focusPct * 2 * Math.PI) - Math.PI / 2;
                  return <circle
                    cx={120 + FOCUS_R * Math.cos(a)}
                    cy={120 + FOCUS_R * Math.sin(a)}
                    r="7" fill={C.healthy}
                    style={{ filter: "drop-shadow(0 0 6px #2ecc87)" }} />;
                })()}
              </svg>

              {/* Center text */}
              <div style={{
                position: "absolute", inset: 0,
                display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center", gap: 4,
              }}>
                <div style={{ fontSize: 11, color: C.textMid, letterSpacing: 1 }}>Set Focus Limit:</div>
                <div style={{
                  fontSize: 34, fontWeight: 700, letterSpacing: 2,
                  color: C.healthy,
                  textShadow: "0 0 12px #2ecc8799",
                  lineHeight: 1,
                }}>
                  {fmtTime(focusRemaining)}
                </div>
                <div style={{ fontSize: 9, color: C.textDim }}>Recommended 2hr max</div>
                <div style={{ fontSize: 10, color: C.textMid }}>User Defined</div>
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button onClick={() => setFocusMinutes(m => Math.max(15,m-15))} style={{
                background: C.surfaceAlt, border: `1px solid ${C.border}`,
                color: C.textMid, width: 30, height: 30, borderRadius: 7, cursor: "pointer", fontSize: 16,
              }}>−</button>
              <div style={{ fontSize: 12, color: C.textMid, minWidth: 80, textAlign: "center" }}>
                {Math.floor(focusMinutes/60)}h {focusMinutes%60}m
              </div>
              <button onClick={() => setFocusMinutes(m => Math.min(240,m+15))} style={{
                background: C.surfaceAlt, border: `1px solid ${C.border}`,
                color: C.textMid, width: 30, height: 30, borderRadius: 7, cursor: "pointer", fontSize: 16,
              }}>+</button>
            </div>

            <button onClick={() => { if (!focusRunning) setFocusRemaining(focusMinutes*60); setFocusRunning(r=>!r); }}
              style={{
                background: focusRunning ? C.critical : C.accent,
                border: "none", color: "#fff",
                padding: "9px 30px", borderRadius: 9, cursor: "pointer",
                fontFamily: "inherit", fontSize: 12, fontWeight: 600, transition: "all .2s",
              }}>
              {focusRunning ? "Stop Session" : "Start Session"}
            </button>

            <div style={{
              background: C.surfaceAlt, borderRadius: 10, padding: "10px 14px",
              border: `1px solid ${C.border}`, width: "100%",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                <Toggle checked={masterSwitch} onChange={setMasterSwitch} />
                <span style={{ fontSize: 11, fontWeight: 600, color: C.text }}>Intervention Master Switch</span>
                <span style={{ fontSize: 9, color: C.textDim }}>(Non-Mandatory)</span>
              </div>
              <div style={{ fontSize: 9, color: C.textDim, paddingLeft: 50 }}>
                Enable automatic breaks and screen blur. Default is OFF.
              </div>
            </div>
          </div>

          {/* Intervention settings */}
          <div style={card({ display: "flex", flexDirection: "column", gap: 14 })}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.text }}>Intervention Settings</div>
              <div style={{ fontSize: 9, color: C.textDim, marginTop: 2 }}>Apply if master is ON</div>
            </div>

            {[
              { l: "Screen Blur (Active)", v: screenBlur, s: setScreenBlur },
              { l: "Pop-up Notification", v: popupAlert, s: setPopupAlert },
              { l: "Sound Alert", v: soundAlert, s: setSoundAlert },
            ].map(({ l, v, s }) => (
              <div key={l} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 11, color: C.textMid }}>{l}</span>
                <Toggle checked={v} onChange={s} />
              </div>
            ))}

            <div style={{ height: 1, background: C.border }} />

            <div>
              <div style={{ fontSize: 10, color: C.textMid, marginBottom: 7 }}>Goal Recalibration</div>
              <button style={{
                width: "100%", padding: "8px", background: C.surfaceAlt,
                border: `1px solid ${C.border}`, color: C.textMid,
                borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 11,
              }}>Adjust Usage Goals</button>
            </div>

            <div style={{ height: 1, background: C.border }} />

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.textMid, marginBottom: 5 }}>
                <span>Break Urgency</span>
                <span style={{ color: breakUrgency > 70 ? C.critical : C.accent }}>{breakUrgency}%</span>
              </div>
              <input type="range" min="0" max="100" value={breakUrgency}
                onChange={e => setBreakUrgency(+e.target.value)}
                style={{ width: "100%", accentColor: breakUrgency > 70 ? C.critical : C.accent }} />
              <div style={{ fontSize: 9, color: C.textDim, marginTop: 4 }}>
                {breakUrgency > 70 ? "Aggressive — forces breaks"
                  : breakUrgency > 40 ? "Moderate — gentle reminders"
                  : "Passive — notifications only"}
              </div>
            </div>

            <button onClick={() => setPage("posture")} style={{
              marginTop: "auto", background: C.surfaceAlt,
              border: `1px solid ${C.border}`, color: C.textMid,
              padding: "8px", borderRadius: 8, cursor: "pointer",
              fontFamily: "inherit", fontSize: 11, fontWeight: 600,
            }}>← Back to Posture</button>
          </div>
        </div>
      )}

      <style>{`
        input[type=range] { height: 3px; cursor: pointer; }
        * { box-sizing: border-box; }
      `}</style>
    </div>
  );
}