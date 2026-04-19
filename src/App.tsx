import { useState, useRef, useEffect } from "react";
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

function App() {
  const [baseline, setBaseline] = useState<PostureBaseline | null>(null);
  const [currentVes, setCurrentVes] = useState<number>(0);
  const [statusText, setStatusText] = useState("Waiting for calibration...");
  const [severity, setSeverity] = useState<"healthy" | "mild" | "critical">("healthy");
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [calibCount, setCalibCount] = useState(0);
  const [blurThreshold, setBlurThreshold] = useState(45);
  const [sensitivity, setSensitivity] = useState(50);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isCalibratingRef = useRef(false);
  const baselineRef = useRef<PostureBaseline | null>(null);
  const calibrationFrames = useRef<{
    yieldRatio: number;
    horizontalOffset: number;
    tiltAngle: number;
  }[]>([]);

  useEffect(() => { isCalibratingRef.current = isCalibrating; }, [isCalibrating]);
  useEffect(() => { baselineRef.current = baseline; }, [baseline]);

  const processFrame = async (landmarks: any) => {
    try {
      // Visibility check — ignore empty camera
      const noseVisible = landmarks[0]?.visibility ?? 0;
      const leftShoulderVisible = landmarks[11]?.visibility ?? 0;
      const rightShoulderVisible = landmarks[12]?.visibility ?? 0;

      if (noseVisible < 0.5 || leftShoulderVisible < 0.5 || rightShoulderVisible < 0.5) {
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
      setStatusText(metrics.status);
      setSeverity(metrics.severity);

      // Calibration
      if (isCalibratingRef.current && data.is_centered) {
        calibrationFrames.current.push({
          yieldRatio: metrics.yieldRatio,
          horizontalOffset: metrics.horizontalOffset,
          tiltAngle: metrics.tiltAngle,
        });
        setCalibCount(calibrationFrames.current.length);

        if (calibrationFrames.current.length >= 60) {
          const frames = calibrationFrames.current;
          const avg = (key: keyof typeof frames[0]) =>
            frames.reduce((a, b) => a + b[key], 0) / frames.length;

          const newBaseline: PostureBaseline = {
            yieldRatio: avg("yieldRatio"),
            horizontalOffset: avg("horizontalOffset"),
            tiltAngle: avg("tiltAngle"),
          };

          setBaseline(newBaseline);
          setIsCalibrating(false);
          calibrationFrames.current = [];
          setCalibCount(0);
        }
      }
    } catch (err) {
      console.error("Bridge Error:", err);
    }
  };

  useEffect(() => {
    const startSystem = async () => {
      if (!videoRef.current || !canvasRef.current) return;

      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm"
      );

      const poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
          delegate: "GPU"
        },
        runningMode: "VIDEO",
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });

      const canvasCtx = canvasRef.current.getContext("2d")!;
      const drawingUtils = new DrawingUtils(canvasCtx);
      let lastVideoTime = -1;

      const detect = () => {
        if (!videoRef.current || !canvasRef.current) return;
        const video = videoRef.current;

        if (video.currentTime !== lastVideoTime) {
          lastVideoTime = video.currentTime;
          const results = poseLandmarker.detectForVideo(video, performance.now());

          canvasCtx.save();
          canvasCtx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);

          if (results.landmarks && results.landmarks.length > 0) {
            const landmarks = results.landmarks[0];
            drawingUtils.drawConnectors(landmarks, PoseLandmarker.POSE_CONNECTIONS, { color: "#3b82f6", lineWidth: 2 });
            drawingUtils.drawLandmarks(landmarks, { color: "#22c55e", radius: 1 });
            processFrame(landmarks);
          } else {
            // No landmarks detected — clear status
            setStatusText("No person detected");
            setSeverity("healthy");
          }

          canvasCtx.restore();
        }

        requestAnimationFrame(detect);
      };

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720 }
      });

      videoRef.current.srcObject = stream;
      videoRef.current.onloadeddata = () => {
        detect();
      };
    };

    startSystem();

    return () => {
      if (videoRef.current?.srcObject) {
        const tracks = (videoRef.current.srcObject as MediaStream).getTracks();
        tracks.forEach(track => track.stop());
      }
    };
  }, []);

  const displayStatus = isCalibrating
    ? "CALIBRATING"
    : !baseline
    ? "READY"
    : severity === "critical"
    ? "CRITICAL"
    : severity === "mild"
    ? "WARNING"
    : "HEALTHY";

  const statusColor =
    displayStatus === "CRITICAL" ? "#ef4444" :
    displayStatus === "WARNING" ? "#f59e0b" :
    displayStatus === "HEALTHY" ? "#22c55e" : "#94a3b8";

  const stabilityScore = baseline
    ? Math.max(0, Math.min(200, (currentVes / baseline.yieldRatio) * 100))
    : 100;
  const gaugeRotation = Math.min(180, Math.max(0, (stabilityScore / 200) * 180));

  return (
    <div style={{ backgroundColor: "#0b0e14", minHeight: "100vh", color: "white", fontFamily: "Inter, sans-serif", padding: "24px" }}>
      {/* HEADER */}
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "30px", alignItems: "center" }}>
        <div>
          <h1 style={{ fontSize: "22px", fontWeight: 700, margin: 0 }}>
            NUCHAL <span style={{ color: "#3b82f6" }}>AI</span>
          </h1>
          <p style={{ fontSize: "12px", color: "#64748b", margin: 0 }}>Clinical Workspace — Active</p>
        </div>
        <button
          onClick={() => { setIsCalibrating(true); calibrationFrames.current = []; setCalibCount(0); }}
          style={{ background: "#3b82f6", color: "white", border: "none", padding: "8px 16px", borderRadius: "8px", cursor: "pointer" }}
        >
          {isCalibrating ? `Calibrating... ${calibCount}/60` : baseline ? "Recalibrate" : "Calibrate Baseline"}
        </button>
      </div>

      {/* GRID */}
      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1.5fr 1fr", gap: "24px" }}>
        {/* LEFT: Video */}
        <div style={{ background: "#161b22", borderRadius: "24px", padding: "20px", border: "1px solid #30363d" }}>
          <div style={{ position: "relative", width: "100%", aspectRatio: "1", background: "#000", borderRadius: "18px", overflow: "hidden" }}>
            <video ref={videoRef} autoPlay playsInline muted style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" }} />
            <canvas ref={canvasRef} width="1280" height="720" style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", transform: "scaleX(-1)" }} />
          </div>
          <div style={{ marginTop: "20px" }}>
            <h3 style={{ color: statusColor, margin: "0 0 4px" }}>STATUS: {displayStatus}</h3>
            <p style={{ color: "#94a3b8", fontSize: "13px", margin: 0 }}>{statusText}</p>
          </div>
        </div>

        {/* CENTER: Gauge */}
        <div style={{ background: "#161b22", borderRadius: "24px", padding: "30px", border: "1px solid #30363d", textAlign: "center" }}>
          <p style={{ color: "#94a3b8", fontSize: "12px" }}>Stability Metric</p>
          <div style={{ position: "relative", width: "280px", height: "140px", margin: "30px auto 0", overflow: "hidden" }}>
            <svg width="280" height="280" style={{ transform: "rotate(-180deg)" }}>
              <circle cx="140" cy="140" r="120" fill="none" stroke="#1e293b" strokeWidth="18" />
              <circle cx="140" cy="140" r="120" fill="none" stroke="url(#g1)" strokeWidth="18"
                strokeDasharray={`${gaugeRotation / 180 * 377} 377`}
                style={{ transition: "stroke-dasharray 0.8s ease-out" }} />
              <defs>
                <linearGradient id="g1">
                  <stop offset="0%" stopColor="#ef4444" />
                  <stop offset="100%" stopColor="#22c55e" />
                </linearGradient>
              </defs>
            </svg>
            <div style={{ position: "absolute", bottom: 0, left: "50%", transform: "translateX(-50%)", color: "white", fontWeight: "700", fontSize: "20px" }}>
              {stabilityScore.toFixed(1)}%
            </div>
          </div>
          <p style={{ color: "#94a3b8", fontSize: "12px", marginTop: "10px" }}>
            {baseline ? `Baseline: ${baseline.yieldRatio.toFixed(2)}` : "No baseline — please calibrate"}
          </p>
        </div>

        {/* RIGHT: Configuration */}
        <div style={{ background: "#161b22", borderRadius: "24px", padding: "20px", border: "1px solid #30363d" }}>
          <h3 style={{ marginTop: 0, color: "#94a3b8" }}>Configuration</h3>
          <label style={{ display: "block", marginBottom: "8px", color: "#94a3b8" }}>
            Blur Threshold (currently {blurThreshold}°)
          </label>
          <input type="range" min="0" max="90" value={blurThreshold}
            onChange={(e) => setBlurThreshold(Number(e.target.value))}
            style={{ width: "100%" }} />
          <label style={{ display: "block", marginTop: "20px", marginBottom: "8px", color: "#94a3b8" }}>
            Sensitivity ({sensitivity}%)
          </label>
          <input type="range" min="0" max="100" value={sensitivity}
            onChange={(e) => setSensitivity(Number(e.target.value))}
            style={{ width: "100%" }} />
          <button
            onClick={() => { setIsCalibrating(true); calibrationFrames.current = []; setCalibCount(0); }}
            style={{ marginTop: "20px", width: "100%", padding: "10px", background: "#3b82f6", color: "white", border: "none", borderRadius: "8px", cursor: "pointer" }}>
            Recalibrate
          </button>
          <h4 style={{ marginTop: "30px", color: "#94a3b8" }}>Intervention Settings</h4>
          <label style={{ display: "flex", alignItems: "center", gap: "10px", color: "#94a3b8" }}>
            <input type="checkbox" defaultChecked /> Screen Blur (Active)
          </label>
        </div>
      </div>
    </div>
  );
}

export default App;