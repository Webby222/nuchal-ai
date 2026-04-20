# Nuchal AI: Desktop Posture Biofeedback

## Overview
Nuchal AI is a desktop application designed to help developers reduce cervical strain during long coding sessions. Using your webcam, it detects posture deviations in real time and provides instant feedback — all processed locally for privacy.  

This project started as a personal tool to address my own reduction in cervical lordosis, but it also demonstrates applied computer science skills in computer vision, systems programming, and UI/UX design.

---

## Motivation
Extended focus often leads to "forward head posture," which increases strain on the cervical spine and thoracic vertebrae. Nuchal AI interrupts this cycle before chronic strain occurs.  

By building this app, I combined my interest in health with my transition into computer science, showing how technology can solve real human problems.

---

## Features
- **Front-View Mapping**: Tracks posture using a standard webcam (no side camera needed).
- **Local-First Privacy**: All biometric processing happens on your device via MediaPipe.
- **Dynamic Calibration**: Personalized baseline for accurate feedback.
- **Biofeedback Dashboard**: Track stability and recovery metrics over time.

---

## Technical Architecture
- **Core Engine (Rust)**: High-concurrency biometric analysis with memory safety.
- **Bridge (Tauri 2.0)**: Secure, lightweight IPC layer between vision engine and UI.
- **Frontend (React/TypeScript)**: Modern interface with hardware-accelerated SVG gauges.
- **Vision Logic (MediaPipe Pose)**: Custom coordinate mapping for nasal-sternal tracking.

---

## Installation
Clone the repository and run the desktop app locally:

```bash
git clone https://github.com/yourusername/nuchal-ai.git
cd nuchal-ai
npm install
npm run tauri dev
