import { useEffect, useRef } from 'react';

function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
const canvasRef = useRef<HTMLCanvasElement>(null); // This is the new "Glass Sheet"

  useEffect(() => {
    async function startCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          video: { width: 1280, height: 720 } 
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      } catch (err) {
        console.error("Camera Error:", err);
      }
    }
    startCamera();
  }, []);

  return (
    <div style={{ backgroundColor: '#111827', minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'white', fontFamily: 'system-ui, sans-serif' }}>
      
      <h1 style={{ fontSize: '2.5rem', fontWeight: '800', marginBottom: '30px', color: '#f3f4f6' }}>
        Nuchal AI: <span style={{ color: '#3b82f6' }}>Clinical Monitor</span>
      </h1>

      <div style={{ position: 'relative', width: '90%', maxWidth: '800px', aspectRatio: '16/9', background: '#000', borderRadius: '12px', border: '4px solid #1f2937', overflow: 'hidden', boxShadow: '0 20px 25px -5px rgb(0 0 0 / 0.5)' }}>
  {/* The Camera Feed */}
  <video ref={videoRef} autoPlay playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
  
  {/* The Drawing Sheet (ADD THIS LINE) */}
  <canvas ref={canvasRef} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }} />
  
  {/* The Status Badge */}
  <div style={{ position: 'absolute', top: '20px', left: '20px', background: 'rgba(0,0,0,0.5)', padding: '8px 15px', borderRadius: '8px', border: '1px solid #22c55e', zIndex: 10 }}>
    <p style={{ color: '#22c55e', fontSize: '0.75rem', fontWeight: 'bold', margin: 0, letterSpacing: '1px' }}>
      ● STATUS: SYSTEM READY
    </p>
  </div>
</div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', width: '90%', maxWidth: '800px', marginTop: '30px' }}>
        <div style={{ background: '#1f2937', padding: '20px', borderRadius: '12px', border: '1px solid #374151' }}>
          <p style={{ fontSize: '0.8rem', color: '#9ca3af', marginBottom: '5px' }}>CVA ANGLE</p>
          <p style={{ fontSize: '2rem', fontWeight: 'bold' }}>--°</p>
        </div>
        <div style={{ background: '#1f2937', padding: '20px', borderRadius: '12px', border: '1px solid #374151' }}>
          <p style={{ fontSize: '0.8rem', color: '#9ca3af', marginBottom: '5px' }}>POSTURE STATUS</p>
          <p style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#3b82f6' }}>CALIBRATING</p>
        </div>
      </div>

    </div>
  );
}

export default App;