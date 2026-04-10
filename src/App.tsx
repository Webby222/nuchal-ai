'use client';
import { useEffect, useRef } from 'react';

export default function NuchalDashboard() {
  const videoRef = useRef<HTMLVideoElement>(null);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-slate-900 text-white p-4">
      <h1 className="text-3xl font-bold mb-4">Nuchal AI: Clinical Monitor</h1>
      
      <div className="relative border-4 border-blue-500 rounded-lg overflow-hidden w-full max-w-2xl aspect-video bg-black">
        {/* Webcam Feed will go here */}
        <video 
          ref={videoRef}
          autoPlay 
          playsInline 
          className="w-full h-full object-cover"
        />
        <div className="absolute top-4 left-4 bg-black/50 p-2 rounded">
          <p className="text-sm font-mono text-green-400">STATUS: SYSTEM READY</p>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4 w-full max-w-2xl">
        <div className="bg-slate-800 p-4 rounded-lg border border-slate-700">
          <p className="text-gray-400 text-sm">CVA Angle</p>
          <p className="text-2xl font-bold">--°</p>
        </div>
        <div className="bg-slate-800 p-4 rounded-lg border border-slate-700">
          <p className="text-gray-400 text-sm">Posture Status</p>
          <p className="text-2xl font-bold text-blue-400">CALIBRATING</p>
        </div>
      </div>
    </main>
  );
}