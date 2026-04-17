import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Pose, POSE_CONNECTIONS } from "@mediapipe/pose";
import { Camera } from "@mediapipe/camera_utils";
import { drawConnectors, drawLandmarks } from '@mediapipe/drawing_utils';
import { calculatePostureMetrics } from "./PostureMath";

interface PostureData {
  ves_ratio: number;
  tilt_angle: number;
  pitch_angle: number;
  is_centered: boolean;
}

function App() {
  const [baseline, setBaseline] = useState<number | null>(null);
  const [currentVes, setCurrentVes] = useState<number>(0);
  const [statusText, setStatusText] = useState("READY");
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [calibCount, setCalibCount] = useState(0);
  const [notes, setNotes] = useState("");

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isCalibratingRef = useRef(false);
  const calibrationFrames = useRef<number[]>([]);

  useEffect(() => { isCalibratingRef.current = isCalibrating; }, [isCalibrating]);

  const processFrame = async (landmarks: any) => {
    try {
      // 1. Get Data from Rust (Backend)
      const data: PostureData = await invoke("analyze_posture", { landmarks });
      
      // 2. Supplement with TS Math (Frontend Helper)
      const metrics = calculatePostureMetrics(
        landmarks[0],   // nose
        landmarks[152] || landmarks[1], // chin (fallback if 152 isn't in Pose)
        landmarks[10] || landmarks[4],  // forehead (fallback if 10 isn't in Pose)
        landmarks[11],  // left shoulder
        landmarks[12]   // right shoulder
      );

      setCurrentVes(metrics.yieldRatio);
      setStatusText(metrics.status);

      // 3. Calibration logic
      if (isCalibratingRef.current && data.is_centered) {
        calibrationFrames.current.push(metrics.yieldRatio);
        setCalibCount(calibrationFrames.current.length);
        
        if (calibrationFrames.current.length >= 60) {
          const avg = calibrationFrames.current.reduce((a, b) => a + b) / 60;
          setBaseline(avg);
          setIsCalibrating(false);
          calibrationFrames.current = [];
        }
      }
    } catch (err) {
      console.error("Bridge Error:", err);
    }
  };

  useEffect(() => {
    let camera: any = null;
    const startSystem = async () => {
      if (!videoRef.current || !canvasRef.current) return;
      const pose = new Pose({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
      });
      pose.setOptions({ modelComplexity: 1, smoothLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
      
      pose.onResults((results) => {
        if (!results.poseLandmarks) return;
        const canvasCtx = canvasRef.current?.getContext("2d");
        if (canvasCtx) {
          canvasCtx.save();
          canvasCtx.clearRect(0, 0, canvasRef.current!.width, canvasRef.current!.height);
          drawConnectors(canvasCtx, results.poseLandmarks, POSE_CONNECTIONS, { color: '#3b82f6', lineWidth: 2 });
          drawLandmarks(canvasCtx, results.poseLandmarks, { color: '#22c55e', radius: 1 });
          canvasCtx.restore();
        }
        processFrame(results.poseLandmarks);
      });

      camera = new Camera(videoRef.current, {
        onFrame: async () => { if (videoRef.current) await pose.send({ image: videoRef.current }); },
        width: 1280, height: 720,
      });
      await camera.start();
    };
    startSystem();
    return () => { if (camera) camera.stop(); };
  }, []);

  const stabilityScore = baseline ? (currentVes / baseline) * 100 : 100;
  const gaugeRotation = Math.min(180, Math.max(0, (stabilityScore / 100) * 180));
  const status = isCalibrating ? "ANALYZING" : baseline ? (stabilityScore > 85 ? "HEALTHY" : "CRITICAL") : "READY";

  return (
    <div style={{ backgroundColor: '#0b0e14', minHeight: '100vh', color: 'white', fontFamily: 'Inter, sans-serif', padding: '24px' }}>
      
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '30px', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 700, margin: 0 }}>NUCHAL <span style={{ color: '#3b82f6' }}>AI</span></h1>
          <p style={{ fontSize: '12px', color: '#64748b', margin: 0 }}>Clinical Workspace — Active</p>
        </div>
        <button 
          onClick={() => setIsCalibrating(true)}
          style={{ background: '#3b82f6', color: 'white', border: 'none', padding: '8px 16px', borderRadius: '8px', cursor: 'pointer' }}>
          {isCalibrating ? `Calibrating... ${calibCount}/60` : "Calibrate Baseline"}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1.5fr 1fr', gap: '24px' }}>
        <div style={{ background: '#161b22', borderRadius: '24px', padding: '20px', border: '1px solid #30363d' }}>
          <div style={{ position: 'relative', width: '100%', aspectRatio: '1', background: '#000', borderRadius: '18px', overflow: 'hidden' }}>
            <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />
            <canvas ref={canvasRef} width="1280" height="720" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', transform: 'scaleX(-1)' }} />
          </div>
          <div style={{ marginTop: '20px' }}>
            <h3 style={{ color: status === "CRITICAL" ? "#ef4444" : "#22c55e" }}>STATUS: {status}</h3>
            <p style={{ color: '#94a3b8', fontSize: '13px' }}>{statusText}</p>
          </div>
        </div>

        <div style={{ background: '#161b22', borderRadius: '24px', padding: '30px', border: '1px solid #30363d', textAlign: 'center' }}>
          <p style={{ color: '#94a3b8', fontSize: '12px' }}>Stability Metric</p>
          <div style={{ position: 'relative', width: '280px', height: '140px', margin: '30px auto 0', overflow: 'hidden' }}>
            <svg width="280" height="280" style={{ transform: 'rotate(-180deg)' }}>
              <circle cx="140" cy="140" r="120" fill="none" stroke="#1e293b" strokeWidth="18" />
              <circle cx="140" cy="140" r="120" fill="none" stroke="url(#g1)" strokeWidth="18" 
                strokeDasharray={`${(gaugeRotation / 180) * 377} 377`} 
                style={{ transition: 'stroke-dasharray 0.8s ease-out' }} 
              />
              <defs><linearGradient id="g1"><stop offset="0%" stopColor="#ef4444"/><stop offset="100%" stopColor="#22c55e"/></linearGradient></defs>
            </svg>
            <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, fontSize: '56px', fontWeight: 800 }}>
              {baseline ? stabilityScore.toFixed(0) : "--"}%
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginTop: '40px' }}>
            <div style={{ background: '#0b0e14', padding: '15px', borderRadius: '12px' }}>
              <p style={{ fontSize: '10px', color: '#64748b' }}>VES YIELD</p>
              <span style={{ fontSize: '20px', fontWeight: 700 }}>{currentVes.toFixed(3)}</span>
            </div>
            <div style={{ background: '#0b0e14', padding: '15px', borderRadius: '12px' }}>
              <p style={{ fontSize: '10px', color: '#64748b' }}>BASELINE</p>
              <span style={{ fontSize: '20px', fontWeight: 700 }}>{baseline?.toFixed(3) || "N/A"}</span>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div style={{ background: '#161b22', borderRadius: '24px', padding: '24px', border: '1px solid #30363d', flex: 1 }}>
             <h4 style={{ margin: "0 0 10px 0" }}>Clinical Notes</h4>
             <textarea 
               style={{ width: '100%', height: '80%', background: '#0b0e14', color: 'white', border: '1px solid #30363d', borderRadius: '8px', padding: '10px' }}
               value={notes}
               onChange={(e) => setNotes(e.target.value)}
               placeholder="Enter observations..."
             />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
