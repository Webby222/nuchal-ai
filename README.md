Nuchal AI: Fix your "Laptop Neck" while you code.

Nuchal AI is a clinical-grade biofeedback tool built for developers who "turtle" when they focus. Unlike most trackers that require a side-view camera, Nuchal AI uses a standard front-facing webcam to monitor the Nasal-Vertical Yield (NVY)—the compression of space between your nose and shoulders that signals a flattening cervical curve.

🩺 Why it matters
When we focus on code, we subconsciously slide our chins toward the screen. This posture flattens the natural curve of the neck (cervical lordosis), putting massive pressure on the C-spine. Nuchal AI catches this shift in real-time, helping you maintain your "Gold Standard" posture.

🚀 Key Features
Front-View Tracking: Specialized Nasal-Sternal coordinate mapping means you don't need to move your camera to the side of your desk.

Local-First Privacy: MediaPipe processing happens entirely on your machine via Tauri 2.0. No video data ever leaves your device.

Baseline Calibration: Set your optimal upright posture as 100% Stability and receive real-time alerts the moment you drop into the "Critical" zone.

Biofeedback Dashboard: A premium workspace to track your session stability and recovery notes.

🛠️ Tech Stack
Rust (Backend): High-performance analysis engine for calculating biometric ratios without CPU lag.

React & TypeScript (Frontend): Modern, responsive dashboard with real-time SVG gauge visualization.

Tauri 2.0: Secure, lightweight cross-platform bridge between the vision engine and the UI.

MediaPipe Pose: Custom coordinate mapping for the Nasal-90 tracking axis.