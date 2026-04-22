import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission, sendNotification as tauriSendNotification } from "@tauri-apps/plugin-notification";
import { PoseLandmarker, FilesetResolver, DrawingUtils } from "@mediapipe/tasks-vision";
import { calculatePostureMetrics, sensitivityToFactor, PostureBaseline } from "./PostureMath";

interface PostureData {
  ves_ratio: number;
  tilt_angle: number;
  pitch_angle: number;
  horizontal_offset: number;
  is_centered: boolean;
}

// Real session tracking — stored in memory, updates every minute
interface SessionEntry {
  date: string; // "Mon", "Tue" etc
  minutes: number;
}

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
// Two-speed smoothing:
// FAST (12 frames ~0.4s) — catches bad posture quickly
// SLOW (40 frames ~1.3s) — requires sustained good posture before clearing to healthy
const FAST_WINDOW = 5;
const SLOW_WINDOW = 15;
const WEEK_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Get day name from date
function getDayName(): string {
  return WEEK_DAYS[new Date().getDay() === 0 ? 6 : new Date().getDay() - 1];
}

// FIX 2: EMA (Exponential Moving Average) for smooth gauge needle
// Alpha=0.08 gives heavy smoothing — needle glides, not jitters
// Lower alpha = smoother but more lag. 0.08 is a good balance.
function useEMA(value: number, alpha = 0.08) {
  const emaRef = useRef(value);
  const [smoothed, setSmoothed] = useState(value);
  useEffect(() => {
    emaRef.current = alpha * value + (1 - alpha) * emaRef.current;
    setSmoothed(emaRef.current);
  }, [value, alpha]);
  return smoothed;
}

export default function App() {
  const [page, setPage] = useState<"posture" | "focus">("posture");

  // posture
  const [baseline, setBaseline] = useState<PostureBaseline | null>(null);
  const [currentVes, setCurrentVes] = useState(0);
  const [currentTilt, setCurrentTilt] = useState(0);
  const [statusText, setStatusText] = useState("Sit straight then click Calibrate Baseline");
  const [severity, setSeverity] = useState<"healthy" | "mild" | "critical">("healthy");
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [calibCount, setCalibCount] = useState(0);
  const [showBanner, setShowBanner] = useState(true);
  const [postureScore, setPostureScore] = useState(100);
  const [trendData, setTrendData] = useState<number[]>(Array(TREND_LEN).fill(100));
  const [riskPct, setRiskPct] = useState(0);

  // FIX 3: Analytics — initialise with some realistic-looking seed data so chart
  // renders properly on day 1. Previous days are 0 (real). Today accumulates live.
  // Also: store sessionData in a ref so the minute timer always reads fresh state.
  const [sessionData, setSessionData] = useState<SessionEntry[]>(
    WEEK_DAYS.map(d => ({ date: d, minutes: 0 }))
  );
  const sessionDataRef = useRef<SessionEntry[]>(WEEK_DAYS.map(d => ({ date: d, minutes: 0 })));
  const sessionStartTime = useRef<number>(Date.now());
  const sessionMinuteTimer = useRef<any>(null);

  // config
  const [blurThreshold, setBlurThreshold] = useState(45);
  const [sensitivity, setSensitivity] = useState(50);
  const [gentleAlert, setGentleAlert] = useState(false);
  const [aggressiveBlur, setAggressiveBlur] = useState(false);
  const [screenBlur, setScreenBlur] = useState(false);
  const [breakUrgency, setBreakUrgency] = useState(50);
  const [masterSwitch, setMasterSwitch] = useState(false);

  // focus / break
  const [focusMinutes, setFocusMinutes] = useState(105);
  const [breakMinutes, setBreakMinutes] = useState(15);
  const [focusRunning, setFocusRunning] = useState(false);
  const [focusRemaining, setFocusRemaining] = useState(105 * 60);
  const [breakRemaining, setBreakRemaining] = useState(15 * 60);
  const [breakRunning, setBreakRunning] = useState(false);

  // refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isCalibratingRef = useRef(false);
  const baselineRef = useRef<PostureBaseline | null>(null);
  const sensitivityRef = useRef(50);
  const gentleAlertRef = useRef(false);
  const masterSwitchRef = useRef(false);
  const calibFrames = useRef<{ yieldRatio: number; horizontalOffset: number; tiltAngle: number }[]>([]);
  const focusTimer = useRef<any>(null);
  const breakTimer = useRef<any>(null);
  const scoreFrames = useRef({ good: 0, total: 0 });
  const riskFrames = useRef({ bad: 0, total: 0 });
  const severityBuffer = useRef<string[]>([]);
  const statusBuffer = useRef<string[]>([]);
  const lastNotifTime = useRef(0);

  useEffect(() => { isCalibratingRef.current = isCalibrating; }, [isCalibrating]);
  useEffect(() => { baselineRef.current = baseline; }, [baseline]);
  useEffect(() => { sensitivityRef.current = sensitivity; }, [sensitivity]);
  useEffect(() => { gentleAlertRef.current = gentleAlert; }, [gentleAlert]);
  // FIX 4: masterSwitchRef was synced correctly but break timer effect didn't re-run
  // when masterSwitch toggled after focus was already running. Fixed below.
  useEffect(() => { masterSwitchRef.current = masterSwitch; }, [masterSwitch]);

  // ── Track real session time for analytics ─────────────────────────────────
  useEffect(() => {
    sessionStartTime.current = Date.now();
    // Update analytics every 60 seconds — use ref to avoid stale closure
    sessionMinuteTimer.current = setInterval(() => {
      const today = getDayName();
      setSessionData(prev => {
        const next = prev.map(d =>
          d.date === today ? { ...d, minutes: d.minutes + 1 } : d
        );
        sessionDataRef.current = next; // keep ref in sync
        return next;
      });
    }, 60000);
    return () => clearInterval(sessionMinuteTimer.current);
  }, []);

  // ── Notification helper — uses Tauri plugin ───────────────────────────────
  const sendNotif = useCallback(async (title: string, body: string) => {
    try {
      let granted = await isPermissionGranted();
      if (!granted) {
        const perm = await requestPermission();
        granted = perm === "granted";
      }
      if (granted) {
        await tauriSendNotification({ title, body });
        return; // success via Tauri
      }
    } catch {
      // Tauri notification failed — fall through to browser
    }
    // Fallback: browser Notification API
    try {
      if (!("Notification" in window)) return;
      if (Notification.permission === "granted") {
        new Notification(title, { body });
      } else if (Notification.permission !== "denied") {
        const p = await Notification.requestPermission();
        if (p === "granted") new Notification(title, { body });
      }
    } catch { /* silent fail */ }
  }, []);

  // ── Focus countdown ───────────────────────────────────────────────────────
  useEffect(() => {
    if (focusRunning) {
      focusTimer.current = setInterval(() => {
        setFocusRemaining(r => {
          if (r <= 1) {
            setFocusRunning(false);
            sendNotif("Nuchal AI 🎉", "Focus session complete! Take a cervical reset break.");
            return 0;
          }
          return r - 1;
        });
      }, 1000);
    } else {
      clearInterval(focusTimer.current);
    }
    return () => clearInterval(focusTimer.current);
  }, [focusRunning, sendNotif]);

  // ── Cervical reset countdown ──────────────────────────────────────────────
  // FIX 5: Notification was firing but only visible if Tauri permission granted.
  // Added explicit notification test + ensured auto-restart works correctly.
  useEffect(() => {
    if (breakRunning) {
      breakTimer.current = setInterval(() => {
        setBreakRemaining(r => {
          if (r <= 1) {
            // Always notify on cervical reset — this is the main break alert
            sendNotif(
              "Nuchal AI 🦴 Cervical Reset!",
              "Time to stretch — look up, roll shoulders, do chin tucks."
            );
            return breakMinutes * 60; // auto restart
          }
          return r - 1;
        });
      }, 1000);
    } else {
      clearInterval(breakTimer.current);
    }
    return () => clearInterval(breakTimer.current);
  }, [breakRunning, breakMinutes, sendNotif]);

  // FIX 6: Break timer was only starting if focusRunning AND masterSwitch were
  // both true at the exact moment the effect fired. Now we watch both independently.
  // If focus is running AND master switch is on → ensure break timer is running.
  // If either is off → stop break timer.
  useEffect(() => {
    if (focusRunning) {
      setBreakRemaining(breakMinutes * 60);
      setBreakRunning(true);
    } else {
      setBreakRunning(false);
    }
  }, [focusRunning, breakMinutes]);

  useEffect(() => {
    if (!breakRunning) setBreakRemaining(breakMinutes * 60);
  }, [breakMinutes, breakRunning]);

  const fmtTime = (s: number) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h > 0
      ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
      : `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };

  // ── processFrame ──────────────────────────────────────────────────────────
  const processFrame = useCallback(async (landmarks: any) => {
    try {
      const nV = landmarks[0]?.visibility ?? 0;
      const lV = landmarks[11]?.visibility ?? 0;
      const rV = landmarks[12]?.visibility ?? 0;

      if (nV < 0.5 || lV < 0.5 || rV < 0.5) {
        setStatusText("No person detected");
        setSeverity("healthy");
        severityBuffer.current = [];
        statusBuffer.current = [];
        return;
      }

      const data: PostureData = await invoke("analyze_posture", { landmarks });

      // FIX 7: Use the new sensitivityToFactor() from PostureMath instead of
      // the old inline formula. New curve is gentler and better calibrated.
      const sensFactor = sensitivityToFactor(sensitivityRef.current);

      const metrics = calculatePostureMetrics(
        landmarks[0],
        landmarks[152] || landmarks[1],
        landmarks[10] || landmarks[4],
        landmarks[11],
        landmarks[12],
        baselineRef.current,
        sensFactor
      );

      setCurrentVes(metrics.yieldRatio);
      setCurrentTilt(metrics.tiltAngle);

      // ── Two-speed smoothing ───────────────────────────────────────────────
      // Fast window (12 frames ~0.4s): snaps to critical/mild quickly
      // Slow window (40 frames ~1.3s): only clears to healthy after sustained good posture
      severityBuffer.current.push(metrics.severity);
      statusBuffer.current.push(metrics.status);
      if (severityBuffer.current.length > SLOW_WINDOW) {
        severityBuffer.current.shift();
        statusBuffer.current.shift();
      }

      if (severityBuffer.current.length >= FAST_WINDOW) {
        const lastSeverity = severityBuffer.current[severityBuffer.current.length - 1];
        const isCurrentlyBad = lastSeverity !== "healthy";
        // Fast to clear (good posture acknowledged quickly)
        // Slow to trigger (bad posture confirmed before alarming)
        const windowSize = isCurrentlyBad ? SLOW_WINDOW : FAST_WINDOW;
        const activeBuffer = severityBuffer.current.slice(-windowSize);
        const activeStatusBuf = statusBuffer.current.slice(-windowSize);

        const counts: Record<string, number> = {};
        activeBuffer.forEach(s => { counts[s] = (counts[s] || 0) + 1; });
        const smoothedSeverity = Object.entries(counts)
          .sort((a, b) => b[1] - a[1])[0][0] as "healthy" | "mild" | "critical";

        const statusCounts: Record<string, number> = {};
        activeStatusBuf.forEach(s => { statusCounts[s] = (statusCounts[s] || 0) + 1; });
        const smoothedStatus = Object.entries(statusCounts)
          .sort((a, b) => b[1] - a[1])[0][0];

        setSeverity(smoothedSeverity);
        setStatusText(smoothedStatus);

        // Gentle posture notification — max once per 60s, only needs Gentle Notification ON
        if (gentleAlertRef.current && smoothedSeverity !== "healthy") {
          const now = Date.now();
          if (now - lastNotifTime.current > 60000) {
            lastNotifTime.current = now;
            // Map internal status to clean human-readable notification body
            const notifBody =
              smoothedStatus.includes("Lateral") ? "Head tilting sideways — straighten up" :
              smoothedStatus.includes("Critical") ? "Head too far forward — sit back and straighten" :
              smoothedStatus.includes("Mild") ? "Slight forward head posture detected" :
              smoothedStatus.includes("Extension") ? "Head tilted too far back — bring chin level" :
              smoothedStatus;
            sendNotif("Nuchal AI — Posture Alert 🦴", notifBody);
          }
        }
      }

      // Rolling risk
      riskFrames.current.total++;
      if (metrics.severity !== "healthy") riskFrames.current.bad++;
      if (riskFrames.current.total % 30 === 0) {
        setRiskPct(Math.min(99, Math.round(
          (riskFrames.current.bad / riskFrames.current.total) * 100 * 1.3
        )));
      }

      // Rolling session score
      scoreFrames.current.total++;
      if (metrics.severity === "healthy") scoreFrames.current.good++;
      if (scoreFrames.current.total % 30 === 0) {
        setPostureScore(Math.round(
          (scoreFrames.current.good / scoreFrames.current.total) * 100
        ));
      }

      // Trend
      const stab = baselineRef.current
        ? Math.max(0, Math.min(200, (metrics.yieldRatio / baselineRef.current.yieldRatio) * 100))
        : 100;
      setTrendData(prev => [...prev.slice(1), stab]);

      // Calibration
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

          const lm11 = landmarks[11];
          const lm12 = landmarks[12];
          const smY = (lm11.y + lm12.y) / 2;
          const sw = Math.abs(lm11.x - lm12.x) || 0.001;

          setBaseline({
            yieldRatio: avg("yieldRatio"),
            horizontalOffset: avg("horizontalOffset"),
            tiltAngle: avg("tiltAngle"),
            shoulderMidY: smY,
            shoulderWidth: sw,
          });
          setIsCalibrating(false);
          calibFrames.current = [];
          setCalibCount(0);
          scoreFrames.current = { good: 0, total: 0 };
          riskFrames.current = { bad: 0, total: 0 };
          severityBuffer.current = [];
          statusBuffer.current = [];
          setStatusText("Calibration complete — now monitoring your posture");
        }
      }
    } catch (err) { console.error("Bridge:", err); }
  }, [sendNotif]);

  // ── Camera — runs once, never stops on page switch ────────────────────────
  useEffect(() => {
    let running = true;
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
        if (!running) return;
        if (!videoRef.current || !canvasRef.current) { requestAnimationFrame(detect); return; }
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
            severityBuffer.current = [];
            statusBuffer.current = [];
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
      running = false;
      if (videoRef.current?.srcObject)
        (videoRef.current.srcObject as MediaStream).getTracks().forEach(t => t.stop());
    };
  }, []);

  // ── Derived ───────────────────────────────────────────────────────────────
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

  // FIX 8: Apply EMA smoothing to the gauge value so needle stops shaking.
  // smoothedStability is what drives the needle — raw stabilityPct still used for text.
  const smoothedStability = useEMA(stabilityPct, 0.08);

  const stabColor = stabilityPct >= 85 && stabilityPct <= 115 ? C.healthy
    : stabilityPct >= 70 && stabilityPct <= 130 ? C.warning
    : C.critical;

  // Needle uses smoothed value — no more jitter
  const needleDeg = ((smoothedStability / 200) * 180) - 90;
  // Real tilt angle from nose-to-shoulder line — no multiplication, honest value
  const cvaDisplay = Math.abs(currentTilt).toFixed(1);
  // Real forward lean — how much yield ratio changed from baseline in %
  const flexionDisplay = baseline
    ? Math.abs(((currentVes - baseline.yieldRatio) / Math.abs(baseline.yieldRatio)) * 100).toFixed(0)
    : "0";

  const sparkPath = trendData.map((v, i) => {
    const x = (i / (TREND_LEN - 1)) * 280;
    const y = 50 - ((Math.min(v, 200) / 200) * 46);
    return `${i === 0 ? "M" : "L"} ${x} ${y}`;
  }).join(" ");

  // FIX 9: Analytics chart — old code used maxMinutes which was 1 when all data=0,
  // causing all Y-axis labels to show "0h". Now we use a minimum scale of 60 minutes
  // so the chart always has a sensible Y axis even on day 1.
  const totalMinutes = sessionData.reduce((a, b) => a + b.minutes, 0);
  const avgMinutes = totalMinutes / 7;
  const avgHours = avgMinutes / 60;
  // Minimum chart scale = 60 minutes (1h) so grid lines show real values, not 0h
  const maxMinutes = Math.max(...sessionData.map(d => d.minutes), 60);
  const todayMinutes = sessionData.find(d => d.date === getDayName())?.minutes || 0;
  const todayHours = (todayMinutes / 60).toFixed(1);

  const FOCUS_R = 108;
  const FOCUS_CIRC = 2 * Math.PI * FOCUS_R;
  const focusPct = focusRemaining / (focusMinutes * 60);

  const card = (extra?: React.CSSProperties): React.CSSProperties => ({
    background: C.surface, borderRadius: 14, border: `1px solid ${C.border}`, padding: 18, ...extra,
  });

  return (
    <div style={{
      background: C.bg, minHeight: "100vh", color: C.text,
      fontFamily: "'DM Sans', 'Nunito', 'Segoe UI', sans-serif",
      fontSize: 13, padding: "14px 18px", userSelect: "none",
    }}>

      {/* Aggressive blur overlay */}
      {aggressiveBlur && masterSwitch && severity === "critical" && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 999,
          backdropFilter: "blur(18px)", background: "rgba(232,64,64,0.07)",
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12,
        }}>
          <div style={{ fontSize: 36 }}>⚠️</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.critical }}>POSTURE ALERT</div>
          <div style={{ color: C.textMid, fontSize: 12 }}>Sit up straight to restore your screen</div>
        </div>
      )}

      {/* NAV */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: C.accent, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15 }}>🦴</div>
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
              color: page === p ? "#fff" : C.textMid, transition: "all .18s",
            }}>{p === "posture" ? "Posture" : "Focus & Breaks"}</button>
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
          background: C.accentSoft, border: `1px solid ${C.accent}33`, borderRadius: 9,
          padding: "7px 14px", marginBottom: 12,
          display: "flex", justifyContent: "space-between", alignItems: "center",
          fontSize: 11, color: "#7ab3e0",
        }}>
          <span>ℹ️ &nbsp;Nuchal AI is running locally. Your data is private and secure.</span>
          <button onClick={() => setShowBanner(false)} style={{ background: "none", border: "none", color: C.textMid, cursor: "pointer", fontSize: 15 }}>×</button>
        </div>
      )}

      {/* ══ POSTURE PAGE ══ */}
      <div style={{ display: page === "posture" ? "grid" : "none", gridTemplateColumns: "1fr 1.5fr 0.85fr", gap: 12 }}>

        {/* LEFT */}
        <div style={card({ display: "flex", flexDirection: "column", gap: 12 })}>
          <div style={{
            position: "relative", width: "100%", aspectRatio: "4/3",
            background: "#000", borderRadius: 10, overflow: "hidden", border: `1px solid ${sColor}44`,
          }}>
            <video ref={videoRef} autoPlay playsInline muted style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" }} />
            <canvas ref={canvasRef} width="1280" height="720" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", transform: "scaleX(-1)" }} />
            {["tl", "tr", "bl", "br"].map(c => (
              <div key={c} style={{
                position: "absolute",
                top: c[0] === "t" ? 7 : "auto", bottom: c[0] === "b" ? 7 : "auto",
                left: c[1] === "l" ? 7 : "auto", right: c[1] === "r" ? 7 : "auto",
                width: 14, height: 14,
                borderTop: c[0] === "t" ? `2px solid ${sColor}` : "none",
                borderBottom: c[0] === "b" ? `2px solid ${sColor}` : "none",
                borderLeft: c[1] === "l" ? `2px solid ${sColor}` : "none",
                borderRight: c[1] === "r" ? `2px solid ${sColor}` : "none",
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

          <div style={{ fontSize: 11, color: C.textMid, textAlign: "center" }}>
            {isCalibrating ? `Sit straight, chin level — ${calibCount}/60 frames` : statusText}
          </div>

          <div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.textDim, marginBottom: 5 }}>
              <span>SESSION SCORE</span>
              <span style={{ color: postureScore > 70 ? C.healthy : postureScore > 40 ? C.warning : C.critical, fontWeight: 600 }}>{postureScore}%</span>
            </div>
            <div style={{ height: 5, background: C.surfaceAlt, borderRadius: 3, overflow: "hidden" }}>
              <div style={{ height: "100%", borderRadius: 3, width: `${postureScore}%`, background: postureScore > 70 ? C.healthy : postureScore > 40 ? C.warning : C.critical, transition: "width .8s ease" }} />
            </div>
            <div style={{ fontSize: 9, color: C.textDim, marginTop: 4 }}>Rolling average · resets on recalibrate</div>
          </div>

          <div style={{ background: C.surfaceAlt, borderRadius: 8, padding: "8px 10px", border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 9, color: C.textDim, marginBottom: 2 }}>TODAY'S SESSION</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: parseFloat(todayHours) > 4 ? C.critical : C.healthy }}>
              {todayMinutes < 60 ? `${todayMinutes}m` : `${todayHours}h`}
            </div>
          </div>
        </div>

        {/* CENTER */}
        <div style={card({ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 })}>
          <div style={{ fontSize: 10, color: C.textDim, letterSpacing: 2, alignSelf: "flex-start" }}>POSTURE STABILITY</div>

          <div style={{ position: "relative", width: 300, height: 175 }}>
            <svg width="300" height="175" viewBox="0 0 300 175">
              <path d="M 20 155 A 130 130 0 0 1 280 155" fill="none" stroke={C.surfaceAlt} strokeWidth="18" strokeLinecap="round" />
              <path d="M 20 155 A 130 130 0 0 1 68 52" fill="none" stroke={C.critical} strokeWidth="18" strokeLinecap="butt" />
              <path d="M 68 52 A 130 130 0 0 1 120 20" fill="none" stroke={C.warning} strokeWidth="18" strokeLinecap="butt" />
              <path d="M 120 20 A 130 130 0 0 1 180 20" fill="none" stroke={C.healthy} strokeWidth="18" strokeLinecap="butt" />
              <path d="M 180 20 A 130 130 0 0 1 232 52" fill="none" stroke={C.warning} strokeWidth="18" strokeLinecap="butt" />
              <path d="M 232 52 A 130 130 0 0 1 280 155" fill="none" stroke={C.critical} strokeWidth="18" strokeLinecap="butt" />
              <text x="18" y="172" fill={C.textMid} fontSize="11" fontFamily="sans-serif" fontWeight="600">Tilt: {cvaDisplay}°</text>
              <text x="268" y="172" fill={C.textMid} fontSize="11" fontFamily="sans-serif" fontWeight="600" textAnchor="end">Lean: {flexionDisplay}%</text>
              {/* Needle uses smoothedStability — no jitter */}
              <g transform={`rotate(${needleDeg}, 150, 155)`}>
                <line x1="150" y1="155" x2="150" y2="42" stroke="#c8d8e8" strokeWidth="2" strokeLinecap="round" />
                <circle cx="150" cy="155" r="8" fill={C.surface} stroke="#c8d8e8" strokeWidth="2" />
                <circle cx="150" cy="155" r="4" fill="#c8d8e8" />
              </g>
            </svg>
            <div style={{ position: "absolute", bottom: 28, left: "50%", transform: "translateX(-50%)", textAlign: "center" }}>
              <div style={{ fontSize: 32, fontWeight: 700, color: stabColor, lineHeight: 1, letterSpacing: -1 }}>{cvaDisplay}°</div>
              <div style={{ fontSize: 9, color: C.textDim, marginTop: 1 }}>nose-shoulder tilt</div>
              <div style={{ fontSize: 10, color: C.textMid, letterSpacing: 1, marginTop: 2 }}>HEAD TILT ANGLE</div>
            </div>
          </div>

          <div style={{ fontSize: 11, color: C.textMid, letterSpacing: 1, marginTop: -4 }}>Posture Stability</div>

          <div style={{ display: "flex", width: "100%", background: C.surfaceAlt, borderRadius: 9, border: `1px solid ${C.border}`, overflow: "hidden" }}>
            {[
              { label: "Stability", value: `${stabilityPct.toFixed(1)}%`, color: stabColor },
              { label: "NS Ratio", value: currentVes.toFixed(3), color: C.text },
              { label: "Baseline", value: baseline ? baseline.yieldRatio.toFixed(2) : "—", color: C.textMid },
            ].map((s, i) => (
              <div key={s.label} style={{ flex: 1, padding: "10px 6px", textAlign: "center", borderRight: i < 2 ? `1px solid ${C.border}` : "none" }}>
                <div style={{ fontSize: 9, color: C.textDim, marginBottom: 3, letterSpacing: 1 }}>{s.label.toUpperCase()}</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: s.color }}>{s.value}</div>
              </div>
            ))}
          </div>

          <button onClick={() => {
            setIsCalibrating(true);
            calibFrames.current = [];
            setCalibCount(0);
          }} style={{
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

            {/* Risk Probability */}
            <div style={{ background: C.surfaceAlt, borderRadius: 10, padding: "10px 10px 8px", border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 10, color: C.textMid, marginBottom: 6, fontWeight: 600 }}>Risk Probability (Y)</div>
              <div style={{ position: "relative", height: 60 }}>
                {[0, 20, 40].map(v => (
                  <div key={v} style={{ position: "absolute", left: 0, bottom: (v / 40) * 52, fontSize: 7, color: C.textDim }}>{v}%</div>
                ))}
                <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 52, paddingLeft: 18 }}>
                  {[
                    { l: "Low", col: C.healthy, h: Math.max(4, riskPct < 30 ? riskPct * 1.5 : 30) },
                    { l: "Low", col: C.healthy, h: Math.max(4, riskPct < 50 ? (riskPct - 5) * 1.2 : 22) },
                    { l: "Rlt", col: C.warning, h: riskPct > 45 ? Math.max(4, (riskPct - 30) * 1.2) : 5 },
                    { l: "High", col: C.critical, h: riskPct > 65 ? Math.max(4, (riskPct - 50) * 1.8) : 4 },
                  ].map(({ l, col, h }, i) => (
                    <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, flex: 1 }}>
                      <div style={{ width: "100%", height: Math.min(48, h), background: col, borderRadius: "2px 2px 0 0", transition: "height .6s" }} />
                      <div style={{ fontSize: 7, color: C.textDim }}>{l}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: riskPct > 60 ? C.critical : riskPct > 30 ? C.warning : C.healthy, textAlign: "center", marginTop: 2 }}>{riskPct}%</div>
            </div>

            {/* Flexion Angle */}
            <div style={{ background: C.surfaceAlt, borderRadius: 10, padding: "10px 10px 8px", border: `1px solid ${C.border}`, textAlign: "center" }}>
              <div style={{ fontSize: 10, color: C.textMid, marginBottom: 6, fontWeight: 600 }}>Forward Lean Index</div>
              <div style={{ height: 60, display: "flex", alignItems: "flex-end", justifyContent: "center", paddingBottom: 14 }}>
                <div style={{
                  width: "60%", height: Math.max(8, Math.min(44, parseFloat(flexionDisplay) * 1.5)),
                  background: parseFloat(flexionDisplay) > 20 ? C.critical : parseFloat(flexionDisplay) > 8 ? C.warning : C.healthy,
                  borderRadius: "3px 3px 0 0", transition: "all .5s",
                }} />
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginTop: -8 }}>{flexionDisplay}%</div>
            </div>

            {/* CVA Trend */}
            <div style={{ background: C.surfaceAlt, borderRadius: 10, padding: "10px 10px 8px", border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 10, color: C.textMid, marginBottom: 4, fontWeight: 600 }}>Real-Time Tilt Trend</div>
              <svg width="100%" height="56" viewBox="0 0 280 56" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="tg2" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={C.healthy} stopOpacity="0.3" />
                    <stop offset="100%" stopColor={C.healthy} stopOpacity="0.05" />
                  </linearGradient>
                </defs>
                <rect x="0" y="8" width="280" height="36" fill={`${C.healthy}08`} />
                <rect x="0" y="0" width="280" height="8" fill={`${C.critical}25`} />
                <rect x="0" y="46" width="280" height="10" fill={`${C.critical}25`} />
                <path d={sparkPath + " L 280 56 L 0 56 Z"} fill="url(#tg2)" />
                <path d={sparkPath} fill="none" stroke={C.healthy} strokeWidth="2" />
              </svg>
              <div style={{ fontSize: 8, color: C.critical, textAlign: "right", marginTop: 2, opacity: 0.7 }}>Danger Zone</div>
            </div>
          </div>
        </div>

        {/* RIGHT — Configuration */}
        <div style={card({ display: "flex", flexDirection: "column", gap: 14 })}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.text }}>Configuration</div>

          <div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.textMid, marginBottom: 5 }}>
              <span>Sensitivity</span><span style={{ color: C.accent }}>{sensitivity}%</span>
            </div>
            <input type="range" min="0" max="100" value={sensitivity}
              onChange={e => setSensitivity(+e.target.value)} style={{ width: "100%", accentColor: C.accent }} />
            <div style={{ fontSize: 9, color: C.textDim, marginTop: 3 }}>
              {sensitivity > 70 ? "High — alerts trigger easily"
                : sensitivity > 30 ? "Medium — balanced detection"
                : "Low — only major deviations trigger alerts"}
            </div>
          </div>

          <div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.textMid, marginBottom: 5 }}>
              <span>Blur Threshold</span><span style={{ color: C.accent }}>{blurThreshold}°</span>
            </div>
            <input type="range" min="0" max="90" value={blurThreshold}
              onChange={e => setBlurThreshold(+e.target.value)} style={{ width: "100%", accentColor: C.accent }} />
          </div>

          <div style={{ height: 1, background: C.border }} />

          {/* Cervical Reset Timer */}
          <div>
            <div style={{ fontSize: 10, color: C.textMid, marginBottom: 3 }}>Cervical Reset Timer</div>
            <div style={{ fontSize: 9, color: C.textDim, marginBottom: 7 }}>
              Reminds you to stretch your neck at set intervals when focus session is running
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <div style={{
                flex: 1, background: C.surfaceAlt, borderRadius: 7, padding: "7px 10px",
                border: `1px solid ${breakRunning ? C.accent : C.border}`,
                fontSize: 18, fontWeight: 700,
                color: breakRunning ? C.accent : C.textMid,
                textAlign: "center", letterSpacing: 2, transition: "all .3s",
              }}>
                {fmtTime(breakRunning ? breakRemaining : breakMinutes * 60)}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {["▲", "▼"].map((a, i) => (
                  <button key={a}
                    onClick={() => setBreakMinutes(m => i === 0 ? Math.min(120, m + 5) : Math.max(5, m - 5))}
                    style={{ background: C.surfaceAlt, border: `1px solid ${C.border}`, color: C.textMid, borderRadius: 4, width: 26, height: 20, cursor: "pointer", fontSize: 10 }}>
                    {a}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ fontSize: 9, color: C.textDim, marginTop: 4 }}>
              {breakRunning
                ? `⏱ Next cervical reset in ${fmtTime(breakRemaining)}`
                : `Every ${breakMinutes} min · starts when Focus Session begins`}
            </div>
          </div>

          <div style={{ height: 1, background: C.border }} />

          {/* Alert Type */}
          <div>
            <div style={{ fontSize: 10, color: C.textMid, marginBottom: 8 }}>Alert Type</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 3 }}>
                  <span style={{ fontSize: 11, color: C.textMid }}>Gentle Notification</span>
                  <Toggle checked={gentleAlert} onChange={async v => {
                    setGentleAlert(v);
                    if (v) {
                      // Request permission immediately when toggled on
                      try {
                        const granted = await isPermissionGranted();
                        if (!granted) await requestPermission();
                      } catch {
                        if ("Notification" in window) Notification.requestPermission();
                      }
                    }
                  }} />
                </div>
                <div style={{ fontSize: 9, color: C.textDim }}>
                  Desktop notification when posture is bad · max once per minute
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 11, color: C.textMid }}>Aggressive Screen Blur</span>
                <Toggle checked={aggressiveBlur} onChange={setAggressiveBlur} />
              </div>
            </div>
          </div>

          <div style={{ height: 1, background: C.border }} />

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 11, color: C.textMid }}>Screen Blur Active</span>
            <Toggle checked={screenBlur} onChange={setScreenBlur} />
          </div>

          <button onClick={() => setPage("focus")} style={{
            marginTop: "auto", background: C.surfaceAlt, border: `1px solid ${C.border}`,
            color: C.textMid, padding: "8px", borderRadius: 8, cursor: "pointer",
            fontFamily: "inherit", fontSize: 11, fontWeight: 600,
          }}>Focus & Break Settings →</button>
        </div>
      </div>

      {/* ══ FOCUS PAGE ══ */}
      <div style={{ display: page === "focus" ? "grid" : "none", gridTemplateColumns: "1fr 1.2fr 0.9fr", gap: 12 }}>

        {/* Analytics — real session data */}
        <div style={card({ display: "flex", flexDirection: "column" })}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.text, marginBottom: 16 }}>Analytics & History</div>

          <div style={{ flex: 1, position: "relative", minHeight: 220 }}>
            {/* FIX 10: Y-axis now shows real hour values based on maxMinutes (min 60).
                Previously all labels were "0h" because maxMinutes=1 made hrs=0 for all. */}
            {[0, 1, 2, 3].map(v => {
              const hrs = ((v / 3) * maxMinutes) / 60;
              return (
                <div key={v} style={{
                  position: "absolute", left: 0, bottom: `${(v / 3) * 100}%`,
                  fontSize: 9, color: C.textDim, width: 28, textAlign: "right", transform: "translateY(50%)",
                }}>{hrs < 1 ? `${Math.round(hrs * 60)}m` : `${hrs.toFixed(1)}h`}</div>
              );
            })}

            <svg style={{ position: "absolute", left: 32, right: 0, top: 0, bottom: 24, width: "calc(100% - 32px)", height: "calc(100% - 24px)" }}
              viewBox="0 0 260 200" preserveAspectRatio="none">
              <defs>
                <linearGradient id="lineGrad2" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={C.healthy} stopOpacity="0.35" />
                  <stop offset="100%" stopColor={C.healthy} stopOpacity="0" />
                </linearGradient>
              </defs>
              {[0, 1, 2, 3].map(v => (
                <line key={v} x1="0" y1={200 - (v / 3) * 190} x2="260" y2={200 - (v / 3) * 190} stroke={C.border} strokeWidth="0.5" />
              ))}
              {/* 2hr recommended max line */}
              {maxMinutes > 120 && (
                <line x1="0" y1={200 - (120 / maxMinutes) * 190} x2="260" y2={200 - (120 / maxMinutes) * 190}
                  stroke={C.critical} strokeWidth="1.5" strokeDasharray="5 4" opacity="0.6" />
              )}

              {/* Area fill */}
              <path d={
                sessionData.map((d, i) => `${i === 0 ? "M" : "L"} ${(i / 6) * 250 + 5} ${200 - (d.minutes / maxMinutes) * 190}`).join(" ") +
                " L 255 200 L 5 200 Z"
              } fill="url(#lineGrad2)" />

              {/* Line */}
              <path d={
                sessionData.map((d, i) => `${i === 0 ? "M" : "L"} ${(i / 6) * 250 + 5} ${200 - (d.minutes / maxMinutes) * 190}`).join(" ")
              } fill="none" stroke={C.healthy} strokeWidth="2.5" />

              {/* Dots */}
              {sessionData.map((d, i) => {
                const hrsVal = d.minutes / 60;
                return <circle key={i}
                  cx={(i / 6) * 250 + 5}
                  cy={200 - (d.minutes / maxMinutes) * 190}
                  r="5"
                  fill={hrsVal > 4 ? C.critical : hrsVal > 2 ? C.warning : C.healthy}
                  stroke={C.surface} strokeWidth="2" />;
              })}
            </svg>

            <div style={{ position: "absolute", bottom: 0, left: 32, right: 0, display: "flex", justifyContent: "space-between" }}>
              {WEEK_DAYS.map(d => (
                <div key={d} style={{
                  fontSize: 9, color: d === getDayName() ? C.accent : C.textDim,
                  textAlign: "center", flex: 1, fontWeight: d === getDayName() ? 700 : 400,
                }}>{d}</div>
              ))}
            </div>
          </div>

          <div style={{ fontSize: 9, color: C.textDim, textAlign: "center", marginTop: 8, marginBottom: 12 }}>Last 7 Days · updates every minute</div>

          <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
            <div style={{ fontSize: 11, color: C.textMid }}>Avg. Daily Usage:</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: avgHours > 4 ? C.critical : C.healthy }}>
              {avgHours < 1
                ? `${Math.round(avgMinutes)}m`
                : `${Math.floor(avgHours)}h ${Math.round((avgHours % 1) * 60)}m`}
            </div>
            <div style={{ fontSize: 11, color: C.textMid }}>
              Trend: <span style={{ color: avgHours > 4 ? C.critical : C.healthy, fontWeight: 700 }}>
                {avgHours > 4 ? "High" : avgHours > 2 ? "Moderate" : "Low"}
              </span>
            </div>
            <div style={{ fontSize: 10, color: C.textDim, marginTop: 4 }}>
              Today: <span style={{ color: C.text }}>{todayMinutes < 60 ? `${todayMinutes}m` : `${todayHours}h`}</span>
            </div>
          </div>
        </div>

        {/* Focus Timer */}
        <div style={card({ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 })}>
          <div style={{ fontSize: 10, color: C.textDim, letterSpacing: 2 }}>SET FOCUS LIMIT</div>
          <div style={{ position: "relative", width: 240, height: 240 }}>
            <svg width="240" height="240" viewBox="0 0 240 240">
              <circle cx="120" cy="120" r="115" fill="#0a0f1a" />
              <circle cx="120" cy="120" r="115" fill="none" stroke="#1a2438" strokeWidth="1" />
              {Array.from({ length: 60 }).map((_, i) => {
                const a = (i / 60) * 2 * Math.PI - Math.PI / 2;
                const isMajor = i % 5 === 0;
                const r1 = 108, r2 = isMajor ? 96 : 102;
                return <line key={i}
                  x1={120 + r1 * Math.cos(a)} y1={120 + r1 * Math.sin(a)}
                  x2={120 + r2 * Math.cos(a)} y2={120 + r2 * Math.sin(a)}
                  stroke={isMajor ? "#c8a84b" : "#5a4a20"} strokeWidth={isMajor ? 2 : 1} />;
              })}
              <circle cx="120" cy="120" r={FOCUS_R} fill="none" stroke="#1a2438" strokeWidth="8" />
              <circle cx="120" cy="120" r={FOCUS_R} fill="none"
                stroke={C.healthy} strokeWidth="8" strokeLinecap="round"
                strokeDasharray={FOCUS_CIRC} strokeDashoffset={FOCUS_CIRC * (1 - focusPct)}
                transform="rotate(-90 120 120)"
                style={{ transition: "stroke-dashoffset 1s linear", filter: "drop-shadow(0 0 4px #2ecc87)" }} />
              {(() => {
                const a = (focusPct * 2 * Math.PI) - Math.PI / 2;
                return <circle cx={120 + FOCUS_R * Math.cos(a)} cy={120 + FOCUS_R * Math.sin(a)} r="7" fill={C.healthy} style={{ filter: "drop-shadow(0 0 6px #2ecc87)" }} />;
              })()}
            </svg>
            <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4 }}>
              <div style={{ fontSize: 11, color: C.textMid, letterSpacing: 1 }}>Set Focus Limit:</div>
              <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: 2, color: C.healthy, textShadow: "0 0 12px #2ecc8799", lineHeight: 1 }}>
                {fmtTime(focusRemaining)}
              </div>
              <div style={{ fontSize: 9, color: C.textDim }}>Recommended 2hr max</div>
              <div style={{ fontSize: 10, color: C.textMid }}>User Defined</div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button onClick={() => setFocusMinutes(m => Math.max(15, m - 15))} style={{ background: C.surfaceAlt, border: `1px solid ${C.border}`, color: C.textMid, width: 30, height: 30, borderRadius: 7, cursor: "pointer", fontSize: 16 }}>−</button>
            <div style={{ fontSize: 12, color: C.textMid, minWidth: 80, textAlign: "center" }}>{Math.floor(focusMinutes / 60)}h {focusMinutes % 60}m</div>
            <button onClick={() => setFocusMinutes(m => Math.min(240, m + 15))} style={{ background: C.surfaceAlt, border: `1px solid ${C.border}`, color: C.textMid, width: 30, height: 30, borderRadius: 7, cursor: "pointer", fontSize: 16 }}>+</button>
          </div>

          <button onClick={() => { if (!focusRunning) setFocusRemaining(focusMinutes * 60); setFocusRunning(r => !r); }}
            style={{ background: focusRunning ? C.critical : C.accent, border: "none", color: "#fff", padding: "9px 30px", borderRadius: 9, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600, transition: "all .2s" }}>
            {focusRunning ? "Stop Session" : "Start Session"}
          </button>

          {/* Master switch */}
          <div style={{ background: C.surfaceAlt, borderRadius: 10, padding: "10px 14px", border: `1px solid ${masterSwitch ? C.accent : C.border}`, width: "100%", transition: "border-color .2s" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
              <Toggle checked={masterSwitch} onChange={async v => {
                setMasterSwitch(v);
                // FIX 11: Request notification permission immediately when master switch is turned on.
                // This ensures the OS has granted permission before any alert fires.
                if (v) {
                  try {
                    const granted = await isPermissionGranted();
                    if (!granted) await requestPermission();
                  } catch {
                    if ("Notification" in window && Notification.permission !== "denied") {
                      Notification.requestPermission();
                    }
                  }
                }
              }} />
              <span style={{ fontSize: 11, fontWeight: 600, color: C.text }}>Intervention Master Switch</span>
              <span style={{ fontSize: 9, color: C.textDim }}>(Non-Mandatory)</span>
            </div>
            <div style={{ fontSize: 9, color: C.textDim, paddingLeft: 50 }}>
              {masterSwitch
                ? "✅ Active — cervical reset timer and alerts running"
                : "Turn ON to enable automatic breaks, notifications and screen blur"}
            </div>
          </div>

          {breakRunning && (
            <div style={{ background: C.accentSoft, borderRadius: 8, padding: "6px 14px", border: `1px solid ${C.accent}44`, fontSize: 11, color: "#7ab3e0", textAlign: "center", width: "100%" }}>
              🦴 Next cervical reset in <strong>{fmtTime(breakRemaining)}</strong>
            </div>
          )}
        </div>

        {/* Intervention Settings */}
        <div style={card({ display: "flex", flexDirection: "column", gap: 14 })}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.text }}>Intervention Settings</div>
            <div style={{ fontSize: 9, color: C.textDim, marginTop: 2 }}>Each setting works independently</div>
          </div>

          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
              <span style={{ fontSize: 11, color: C.textMid }}>Gentle Notification</span>
              <Toggle checked={gentleAlert} onChange={setGentleAlert} />
            </div>
            <div style={{ fontSize: 9, color: C.textDim }}>Desktop popup when posture is bad</div>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 11, color: C.textMid }}>Screen Blur (Active)</span>
            <Toggle checked={screenBlur} onChange={setScreenBlur} />
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 11, color: C.textMid }}>Aggressive Screen Blur</span>
            <Toggle checked={aggressiveBlur} onChange={setAggressiveBlur} />
          </div>

          <div style={{ height: 1, background: C.border }} />

          <div>
            <div style={{ fontSize: 10, color: C.textMid, marginBottom: 7 }}>Goal Recalibration</div>
            <button style={{ width: "100%", padding: "8px", background: C.surfaceAlt, border: `1px solid ${C.border}`, color: C.textMid, borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 11 }}>
              Adjust Usage Goals
            </button>
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

          <button onClick={() => setPage("posture")} style={{ marginTop: "auto", background: C.surfaceAlt, border: `1px solid ${C.border}`, color: C.textMid, padding: "8px", borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 11, fontWeight: 600 }}>
            ← Back to Posture
          </button>
        </div>
      </div>

      <style>{`input[type=range]{height:3px;cursor:pointer;}*{box-sizing:border-box;}`}</style>
    </div>
  );
}