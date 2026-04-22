# 🦴 Nuchal AI — Desktop Posture Biofeedback

> A real-time posture monitoring desktop app built with Rust, Tauri, and React. Designed to protect your cervical spine during long coding and work sessions — all processed locally, no data leaves your device.

---

## 🧠 Why I Built This

Extended focus at a laptop leads to **forward head posture** — the head drifts forward, increasing load on the cervical spine and compressing the thoracic vertebrae. Over time this causes real structural damage.

I built Nuchal AI after being diagnosed with **reduced cervical lordosis** from years of programming. This app is both a personal health tool and a demonstration of applied computer science — combining computer vision, systems programming, and UX design to solve a real human problem.

The detection approach was designed in collaboration with a physiotherapist who specified using the **nasal-sternal vertical axis** — measuring the nose position relative to the shoulder midpoint — since a standard laptop camera cannot see the ear required for traditional CVA measurement.

---

## ✨ Features

- **Real-Time Posture Detection** — detects forward head posture, lateral head tilt, and excessive extension using a standard front-facing webcam
- **Calibrated to You** — baseline calibration captures your personal neutral posture so detection is relative to you, not a generic standard
- **Local-First Privacy** — all biometric processing happens on your device via MediaPipe. No data is sent anywhere
- **Posture Alerts** — desktop notifications when bad posture is detected (max once per minute to avoid annoyance)
- **Focus Session Timer** — set a work session limit up to 8 hours with a visual countdown ring
- **Cervical Reset Timer** — repeating break reminder that fires at set intervals during your focus session
- **Screen Blur** — gentle or aggressive screen blur when bad posture is detected
- **Session Analytics** — tracks daily usage time across the week with a visual chart
- **Session Score** — rolling percentage of how much of your session was spent in good posture

---

## 🔬 How Detection Works

Nuchal AI uses **MediaPipe Pose** to track facial and shoulder landmarks from your webcam in real time.

### What It Measures

The core metric is the **Nose-Shoulder Vertical Ratio (NS Ratio)**:

```
NS Ratio = (shoulder_midpoint_Y - nose_Y) / shoulder_width
```

When you sit upright, your nose is high above your shoulders — ratio is large. When you slouch or drop your head forward, your nose descends toward shoulder level — ratio drops. This change from your personal calibrated baseline triggers alerts.

### Detection States

| State | What It Means |
|---|---|
| ✅ HEALTHY | Posture within acceptable range of your baseline |
| ⚠️ WARNING | Mild forward head posture or slight lateral tilt detected |
| 🔴 CRITICAL | Significant forward head posture or lateral head tilt detected |

### Sensitivity Slider

The sensitivity slider adjusts how strictly deviations from baseline are judged:

- **Low (0%)** — only major deviations trigger alerts, good for casual use
- **Medium (50%)** — balanced detection, recommended default
- **High (100%)** — even small deviations trigger warnings, good for rehabilitation

### What It Does NOT Measure

- True Craniovertebral Angle (CVA) — this requires a side-on camera to see the ear
- Lumbar or thoracic posture — only head and neck are tracked
- Exact clinical degrees of flexion — measurements are relative to your personal baseline

---

## 🏗️ Technical Architecture

| Layer | Technology | Purpose |
|---|---|---|
| Core Engine | Rust | High-performance biometric analysis, memory safety |
| Bridge | Tauri 2.0 | Secure IPC between Rust backend and React frontend |
| Frontend | React + TypeScript | Dashboard UI with real-time gauges and charts |
| Vision | MediaPipe Pose | Landmark detection, runs entirely on-device |
| Notifications | Tauri Plugin Notification | Desktop alerts for posture and break reminders |

---

## 🚀 Installation

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Rust](https://rustup.rs/) (latest stable)
- [Tauri CLI](https://tauri.app/v1/guides/getting-started/prerequisites)

### Setup

```bash
# Clone the repository
git clone https://github.com/yourusername/nuchal-ai.git
cd nuchal-ai

# Install dependencies
npm install

# Run in development mode
npm run tauri dev

# Build for production
npm run tauri build
```

### Webcam Permission

On first launch, your OS will request webcam access. This is required for posture detection. All video processing happens locally — no frames are stored or transmitted.

---

## 📖 How To Use

### 1. Calibrate Your Baseline
Sit in your best natural posture — back straight, chin level, shoulders relaxed. Click **Calibrate Baseline** and hold still for about 2 seconds while 60 frames are captured. This sets your personal neutral position.

### 2. Monitor Your Posture
The app runs continuously in the background. The status badge shows HEALTHY, WARNING, or CRITICAL in real time. The **Posture Stability gauge** shows how far you've drifted from your baseline.

### 3. Enable Alerts (Optional)
Turn on **Gentle Notification** in the Configuration panel to receive desktop popup alerts when bad posture is detected. Maximum one notification per minute.

### 4. Start a Focus Session
Go to **Focus & Breaks**, set your session duration (up to 8 hours), and click **Start Session**. The cervical reset timer will fire at your set interval reminding you to stretch.

### 5. Screen Blur (Optional)
Enable **Screen Blur** for a gentle blur when posture degrades, or **Aggressive Screen Blur** for a strong blur overlay that forces you to sit up before you can see your screen.

---

## ⚙️ Configuration Reference

| Setting | What It Does |
|---|---|
| Sensitivity | How strictly deviations from baseline are judged (0-100%) |
| Blur Threshold | Angle at which screen blur activates |
| Cervical Reset Timer | How often the stretch reminder fires during a focus session |
| Gentle Notification | Desktop popup when bad posture detected |
| Screen Blur | Mild blur overlay when posture is warning/critical |
| Aggressive Screen Blur | Strong blur overlay — only clears when you sit up straight |
| Master Switch | Quick kill switch to silence all interventions at once |

---

## 🩺 Clinical Notes

This app was developed with input from a physiotherapist. Key design decisions:

- **Front-camera nasal tracking** was chosen over traditional CVA measurement because laptop cameras cannot see the ear required for side-on CVA
- **Detection is baseline-relative** — alerts fire based on deviation from your personal calibrated neutral, not a generic population standard
- **Pitch angle detection** (chin-to-chest) is currently disabled pending physiotherapist review of correct threshold angles for front-camera measurement
- **Smoothing** is applied to prevent false alerts from momentary movements — a posture must be sustained briefly before an alert fires

> ⚠️ Nuchal AI is a wellness tool, not a medical device. It is not a substitute for professional physiotherapy assessment or treatment.

---

## 🗺️ Roadmap

- [ ] Pitch angle detection (head drop forward) — pending physio threshold review
- [ ] Historical session data persistence across app restarts
- [ ] Posture score export / weekly report
- [ ] Configurable notification messages
- [ ] Multi-language support
- [ ] Mobile companion app

---

## 🤝 Contributing

Pull requests welcome. For major changes please open an issue first to discuss what you'd like to change.

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

---

## 👤 Author

Gift Esohe Eigbefo > B.Sc. Human Physiology | Full-Stack Developer & Technology Instructor > Bridging the gap between Biomechanics and Systems Engineering.